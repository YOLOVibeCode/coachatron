import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { raceDb, skipWithoutPostgres, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { withServer } from '../helpers/server.js';
import { seedCoachWithSession, seedPackage } from '../helpers/fixtures.js';
import { postPaymentEvent, postStorePaid } from '../helpers/store-event.js';
import { getConnectRecipientKey } from '../../src/domain/auth.js';
import { coachCookie, postForm } from '../helpers/refunds.js';
import { bookAndPay, daysAroundNow, download, fileText, readCsv, sessionTypeName } from '../helpers/csv.js';
import { BOOKINGS_HEADER, PAYMENTS_HEADER } from '../../src/domain/moneyExport.js';
import { isoInZone } from '../../src/lib/csv.js';
import type { DbClient } from '../../src/db/client.js';

/** Money's two downloads on real Postgres (TEST_DATABASE_URL; skipped
 * without it). The other download tests run on PGlite, whose driver hands
 * back times, sums and arrays in its own shapes; production reads them
 * through pg. The files must come out the same. */

const ON_POSTGRES = { skip: skipWithoutPostgres, timeout: 60_000 };
const TZ = 'America/Chicago';

let own: RaceDb | null = null;
const db = (): DbClient => {
  assert.ok(own, 'the database is set up');
  return own.db;
};

before(async () => {
  if (!skipWithoutPostgres) own = await raceDb();
});
after(async () => {
  await own?.close();
});

test('the payments and bookings files read the same on Postgres: times, amounts, names and states', ON_POSTGRES, async (t) => {
  t.mock.method(console, 'error', () => {});
  await withRelay(async () => {
    const seed = await seedCoachWithSession(db(), { capacity: 8, priceCents: 3500 });
    const packageId = await seedPackage(db(), seed.coach.id, 10, 30000);
    await db().query("update session set location_text = 'Field 3' where id = $1", [seed.sessionId]);
    const second = (ago: number) => new Date(Math.floor(Date.now() / 1000) * 1000 - ago * 1000);
    const paid = { two: second(50), pkg: second(40), refunded: second(30), kept: second(20) };
    await withServer(async (base) => {
      const handle = seed.coach.handle;
      const pay = (athlete: string, phone: string, paymentId: string, amountCents: number, paidAt: Date, more: { form?: Record<string, string>; checkout?: Record<string, string> } = {}) =>
        bookAndPay(base, db(), { handle, sessionId: seed.sessionId, athlete, phone, paymentId, amountCents, paidAt, ...more });
      await pay('Mia', '5551114444', 'ns_pg_two', 7000, paid.two, { form: { athlete_name_2: 'Leo', contact_email: 'two@example.com' } });
      await pay('Ana', '5551115555', 'ns_pg_pkg', 30000, paid.pkg, { checkout: { mode: 'package', package_id: String(packageId) } });
      const refunded = await pay('=Zoë', '5551116666', 'ns_pg_refunded', 3500, paid.refunded);
      // A payment nobody can match to a booking is kept for the coach its seller names.
      await postStorePaid(base, { userId: 'booking:999999:dropin', amountCents: 4100, paymentId: 'ns_pg_kept', sellerKey: getConnectRecipientKey(seed.coach), occurredAt: paid.kept });
      const cookie = await coachCookie(db(), seed.coach.id);
      assert.equal((await postForm(base, '/app/money/refund', cookie, { target: `b${refunded}` })).headers.get('location'), '/app/payments?notice=refund-refunded');
      assert.equal((await postPaymentEvent(base, { type: 'marketplace.purchase.disputed', paymentId: 'ns_pg_pkg', disputeId: 'ns_pg_dsp', amountCents: 30000 })).status, 200);

      const session = await sessionTypeName(db(), seed.sessionTypeId);
      const start = isoInZone((await db().query<{ starts_at_utc: Date }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0].starts_at_utc, TZ);
      const refundedAt = isoInZone(
        (await db().query<{ refunded_at: Date }>("select refunded_at from refund where payment_ref = 'ns_pg_refunded'")).rows[0].refunded_at,
        TZ,
      );
      const payments = await download(base, cookie, 'payments', daysAroundNow());
      assert.equal(payments.status, 200);
      assert.deepEqual(readCsv(await fileText(payments)), [
        [...PAYMENTS_HEADER],
        [isoInZone(paid.two, TZ), '+15551114444', 'two@example.com', 'Mia and Leo', 'drop-in', session, start, '70.00', '', '', 'paid', 'ns_pg_two'],
        [isoInZone(paid.pkg, TZ), '+15551115555', '', 'Ana', 'package: 10-pack', session, start, '300.00', '', '', 'disputed', 'ns_pg_pkg'],
        [isoInZone(paid.refunded, TZ), '+15551116666', '', "'=Zoë", 'drop-in', session, start, '35.00', '35.00', refundedAt, 'refunded', 'ns_pg_refunded'],
        [isoInZone(paid.kept, TZ), '', '', '', 'not booked', '', '', '41.00', '', '', 'paid', 'ns_pg_kept'],
      ]);

      const bookings = await download(base, cookie, 'bookings', daysAroundNow());
      assert.equal(bookings.status, 200);
      assert.deepEqual(readCsv(await fileText(bookings)), [
        [...BOOKINGS_HEADER],
        [start, session, 'Field 3', 'Mia', '+15551114444', 'two@example.com', 'booked', 'card', '35.00'],
        [start, session, 'Field 3', 'Leo', '+15551114444', 'two@example.com', 'booked', 'card', '35.00'],
        [start, session, 'Field 3', 'Ana', '+15551115555', '', 'booked', 'package credit', '35.00'],
        [start, session, 'Field 3', "'=Zoë", '+15551116666', '', 'refunded', 'card', '35.00'],
      ]);

      // A range before any of it is the header alone.
      const empty = await download(base, cookie, 'payments', { range: 'custom', from: '2020-01-01', to: '2020-12-31' });
      assert.deepEqual(readCsv(await fileText(empty)), [[...PAYMENTS_HEADER]]);
    });
  });
});
