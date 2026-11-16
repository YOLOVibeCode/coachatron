import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postPaymentEvent, postStorePaid } from './helpers/store-event.js';
import { coachCookie, getPage, postForm, quiet } from './helpers/refunds.js';
import { bookAndPay, csvRecords, daysAroundNow, download, downloadRecords, fileText, readCsv, sessionTypeName } from './helpers/csv.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { getConnectRecipientKey } from '../src/domain/auth.js';
import { BOOKINGS_HEADER, PAYMENTS_HEADER, paymentStatusWords, presetRange } from '../src/domain/moneyExport.js';
import { isoInZone } from '../src/lib/csv.js';
import type { DbClient } from '../src/db/client.js';

/** Money's Download block: the coach's payments and bookings as CSV files,
 * for a range of days in the coach's timezone. A payment is one row,
 * listed on the day it was paid, whether it booked or was kept for the
 * coach; a booking is one row, listed on the day of its session. The files
 * are the signed-in coach's own, and only theirs. */

const TZ = 'America/Chicago';
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

async function sessionStart(db: DbClient, sessionId: number): Promise<string> {
  const row = await db.query<{ starts_at_utc: string | Date }>('select starts_at_utc from session where id = $1', [sessionId]);
  return isoInZone(row.rows[0].starts_at_utc, TZ);
}

/** A whole second a little while ago: a time of payment the store reports. */
function secondsAgo(seconds: number): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000 - seconds * 1000);
}

test('the payments file is a download named for its range: quoted fields, CRLF, a byte-order mark, and nothing cached', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    await withServer(async (base) => {
      const paidAt = secondsAgo(90);
      await bookAndPay(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        athlete: 'Zoë "Zed" Núñez, Jr.',
        phone: '5551112222',
        paymentId: 'ns_pay_zoe',
        amountCents: 3500,
        form: { contact_email: 'parent+zoe@example.com' },
        paidAt,
      });
      const cookie = await coachCookie(db, seed.coach.id);
      const range = daysAroundNow();
      const session = await sessionTypeName(db, seed.sessionTypeId);

      const res = await download(base, cookie, 'payments', range);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(res.headers.get('content-disposition'), `attachment; filename="coachatron-payments-${range.from}-to-${range.to}.csv"`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with a byte-order mark');
      const text = bytes.toString('utf8');
      assert.ok(text.includes('"Zoë ""Zed"" Núñez, Jr."'), 'the accents arrive whole and the quotes are doubled');
      assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'every line ends with CRLF');
      assert.ok(text.endsWith('\r\n'));
      assert.deepEqual(readCsv(text), [
        [...PAYMENTS_HEADER],
        [
          isoInZone(paidAt, TZ),
          "'+15551112222",
          'parent+zoe@example.com',
          'Zoë "Zed" Núñez, Jr.',
          'drop-in',
          session,
          await sessionStart(db, seed.sessionId),
          '35.00',
          '',
          '',
          'paid',
          'ns_pay_zoe',
        ],
      ]);

      const bookings = await download(base, cookie, 'bookings', range);
      assert.equal(bookings.status, 200);
      assert.equal(bookings.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.equal(bookings.headers.get('content-disposition'), `attachment; filename="coachatron-bookings-${range.from}-to-${range.to}.csv"`);
      assert.equal(bookings.headers.get('cache-control'), 'no-store');
      assert.deepEqual(readCsv(await fileText(bookings)), [
        [...BOOKINGS_HEADER],
        [await sessionStart(db, seed.sessionId), session, '', 'Zoë "Zed" Núñez, Jr.', "'+15551112222", 'parent+zoe@example.com', 'booked', 'card', '35.00'],
      ]);

      // A month's file and a year's file are named for the month and the year.
      const before = new Date();
      const month = await download(base, cookie, 'payments', { range: 'this-month' });
      const year = await download(base, cookie, 'bookings', { range: 'last-year' });
      const names = (preset: 'this-month' | 'last-year', kind: string) =>
        [before, new Date()].map((now) => `attachment; filename="coachatron-${kind}-${presetRange(preset, TZ, now).label}.csv"`);
      assert.ok(names('this-month', 'payments').includes(month.headers.get('content-disposition') ?? ''));
      assert.match(month.headers.get('content-disposition') ?? '', /filename="coachatron-payments-\d{4}-\d{2}\.csv"$/);
      assert.ok(names('last-year', 'bookings').includes(year.headers.get('content-disposition') ?? ''));
      assert.match(year.headers.get('content-disposition') ?? '', /filename="coachatron-bookings-\d{4}\.csv"$/);
      assert.deepEqual(readCsv(await fileText(year)), [[...BOOKINGS_HEADER]], 'a range with nothing in it is the header alone');
    });
  });
});

test('a name a spreadsheet would run as a formula is written as text, in both files', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8, priceCents: 3500 });
    await withServer(async (base) => {
      const handle = seed.coach.handle;
      const formula = `=cmd|'/C calc'!A0`;
      await bookAndPay(base, db, {
        handle,
        sessionId: seed.sessionId,
        athlete: formula,
        phone: '5551110001',
        paymentId: 'ns_pay_1',
        amountCents: 7000,
        form: { athlete_name_2: '+1 555 010 0199' },
        paidAt: secondsAgo(40),
      });
      await bookAndPay(base, db, { handle, sessionId: seed.sessionId, athlete: '+1 555 010 0199', phone: '5551110002', paymentId: 'ns_pay_2', amountCents: 3500, paidAt: secondsAgo(30) });
      await bookAndPay(base, db, { handle, sessionId: seed.sessionId, athlete: '@SUM(1+1)', phone: '5551110003', paymentId: 'ns_pay_3', amountCents: 3500, paidAt: secondsAgo(20) });
      await bookAndPay(base, db, {
        handle,
        sessionId: seed.sessionId,
        athlete: '-2+3',
        phone: '5551110004',
        paymentId: 'ns_pay_4',
        amountCents: 3500,
        form: { contact_email: '=HYPERLINK("http://example.com")' },
        paidAt: secondsAgo(10),
      });
      const cookie = await coachCookie(db, seed.coach.id);

      const paymentsFile = await fileText(await download(base, cookie, 'payments', daysAroundNow()));
      assert.deepEqual(
        csvRecords(paymentsFile).map((r) => [r.Athletes, r['Parent phone'], r['Parent email']]),
        [
          // The apostrophe goes at the start of the field; a name after it is inside the cell's text.
          [`'${formula} and +1 555 010 0199`, "'+15551110001", ''],
          ["'+1 555 010 0199", "'+15551110002", ''],
          ["'@SUM(1+1)", "'+15551110003", ''],
          ["'-2+3", "'+15551110004", `'=HYPERLINK("http://example.com")`],
        ],
      );
      const bookingsFile = await fileText(await download(base, cookie, 'bookings', daysAroundNow()));
      assert.deepEqual(
        csvRecords(bookingsFile).map((r) => r.Athlete),
        [`'${formula}`, "'+1 555 010 0199", "'+1 555 010 0199", "'@SUM(1+1)", "'-2+3"],
      );
      for (const text of [paymentsFile, bookingsFile]) {
        assert.equal(/(^|,|\n)"[=+\-@\t\r]/.test(text), false, 'no field starts with a character that starts a formula');
      }
    });
  });
});

test('each state of a payment reads in plain words, with what was refunded and when', async (t) => {
  quiet(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 12, priceCents: 3500 });
    await withServer(async (base) => {
      const refs = ['paid', 'onway', 'refunded', 'failed', 'noanswer', 'disputed', 'won', 'lost', 'part', 'both'];
      const ids: Record<string, number> = {};
      for (const [i, ref] of refs.entries()) {
        ids[ref] = await bookAndPay(base, db, {
          handle: seed.coach.handle,
          sessionId: seed.sessionId,
          athlete: `Kid ${ref}`,
          phone: `55511200${String(i).padStart(2, '0')}`,
          paymentId: `ns_pay_${ref}`,
          amountCents: 3500,
          paidAt: secondsAgo(200 - i * 10),
        });
      }
      const cookie = await coachCookie(db, seed.coach.id);
      const refund = (ref: string) => postForm(base, '/app/money/refund', cookie, { target: `b${ids[ref]}` });
      const event = (type: Parameters<typeof postPaymentEvent>[1]['type'], ref: string, extra: { refundId?: string; disputeId?: string; amountCents?: number }) =>
        postPaymentEvent(base, { type, paymentId: `ns_pay_${ref}`, amountCents: 3500, ...extra });

      relay.refundStatus = 'pending';
      assert.equal((await refund('onway')).headers.get('location'), '/app/money?notice=refund-pending');
      relay.refundStatus = 'succeeded';
      assert.equal((await refund('refunded')).headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal((await refund('both')).headers.get('location'), '/app/money?notice=refund-refunded');
      relay.refundError = { status: 404, code: 'NOT_FOUND' };
      assert.equal((await refund('failed')).headers.get('location'), '/app/money?notice=refund-failed');
      relay.refundError = { status: 503, code: 'DOWN' };
      assert.equal((await refund('noanswer')).headers.get('location'), '/app/money?notice=refund-unavailable');
      relay.refundError = null;

      assert.equal((await event('marketplace.purchase.disputed', 'disputed', { disputeId: 'ns_dsp_1' })).status, 200);
      assert.equal((await event('marketplace.purchase.disputed', 'won', { disputeId: 'ns_dsp_2' })).status, 200);
      assert.equal((await event('marketplace.purchase.dispute_won', 'won', { disputeId: 'ns_dsp_2' })).status, 200);
      assert.equal((await event('marketplace.purchase.dispute_lost', 'lost', { disputeId: 'ns_dsp_3' })).status, 200);
      assert.equal((await event('marketplace.purchase.dispute_lost', 'both', { disputeId: 'ns_dsp_4' })).status, 200);
      // Ten dollars of a payment refunded outside Coachatron.
      assert.equal((await event('marketplace.purchase.refunded', 'part', { refundId: 'ns_rfd_part', amountCents: 1000 })).status, 200);

      const rows = await downloadRecords(base, cookie, 'payments', daysAroundNow());
      assert.deepEqual(
        rows.map((r) => [r['Payment reference'], r.Status, r.Amount, r['Refunded amount']]),
        [
          ['ns_pay_paid', 'paid', '35.00', ''],
          ['ns_pay_onway', 'refund on its way', '35.00', ''],
          ['ns_pay_refunded', 'refunded', '35.00', '35.00'],
          ['ns_pay_failed', 'refund failed', '35.00', ''],
          ['ns_pay_noanswer', 'refund failed', '35.00', ''],
          ['ns_pay_disputed', 'disputed', '35.00', ''],
          ['ns_pay_won', 'dispute won', '35.00', ''],
          ['ns_pay_lost', 'dispute lost', '35.00', ''],
          ['ns_pay_part', 'partly refunded', '35.00', '10.00'],
          ['ns_pay_both', 'refunded; dispute lost', '35.00', '35.00'],
        ],
      );
      for (const r of rows) {
        const refunded = r['Refunded amount'] !== '';
        assert.equal(ISO_LOCAL.test(r['Refunded at']), refunded, `${r['Payment reference']}: a time only with an amount`);
        if (!refunded) assert.equal(r['Refunded at'], '');
      }
      const at = await db.query<{ refunded_at: string | Date }>("select refunded_at from refund where payment_ref = 'ns_pay_refunded'");
      assert.equal(rows[2]['Refunded at'], isoInZone(at.rows[0].refunded_at, TZ), 'when the refund went through, in the coach\'s time');

      // The bookings those refunds ended read as refunded in the bookings file.
      const bookings = await downloadRecords(base, cookie, 'bookings', daysAroundNow());
      assert.deepEqual(
        bookings.filter((b) => b.Status === 'refunded').map((b) => b.Athlete),
        ['Kid refunded', 'Kid both'],
      );
    });
  });
});

test('a refund and a dispute on one payment are both named; a state the app does not know leaves the payment paid', () => {
  const words = (refund_status: string | null, refund_error: string | null, dispute_state: string | null) =>
    paymentStatusWords({ refund_status, refund_error, dispute_state });
  assert.equal(words(null, null, null), 'paid');
  assert.equal(words('requested', null, null), 'refund on its way');
  assert.equal(words('requested', 'unavailable', null), 'refund failed');
  assert.equal(words('pending', null, 'open'), 'refund on its way; disputed');
  assert.equal(words('failed', 'refund_failed', 'won'), 'refund failed; dispute won');
  assert.equal(words('something-new', null, 'something-new'), 'paid');
});

test('one payment for several children is one payments row and a bookings row for each child', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const handle = seed.coach.handle;
      await bookAndPay(base, db, {
        handle,
        sessionId: seed.sessionId,
        athlete: 'Mia',
        phone: '5551114444',
        paymentId: 'ns_pay_two',
        amountCents: 7000,
        form: { athlete_name_2: 'Leo', contact_email: 'two@example.com' },
        paidAt: secondsAgo(60),
      });
      await bookAndPay(base, db, {
        handle,
        sessionId: seed.sessionId,
        athlete: 'Ana',
        phone: '5551115555',
        paymentId: 'ns_pay_pkg_two',
        amountCents: 30000,
        form: { athlete_name_2: 'Ben' },
        checkout: { mode: 'package', package_id: String(packageId) },
        paidAt: secondsAgo(30),
      });
      const cookie = await coachCookie(db, seed.coach.id);
      const start = await sessionStart(db, seed.sessionId);
      const session = await sessionTypeName(db, seed.sessionTypeId);

      const payments = await downloadRecords(base, cookie, 'payments', daysAroundNow());
      assert.deepEqual(
        payments.map((r) => [r['Payment reference'], r.Athletes, r['Parent phone'], r['Parent email'], r.Bought, r.Session, r['Session start'], r.Amount, r.Status]),
        [
          ['ns_pay_two', 'Mia and Leo', "'+15551114444", 'two@example.com', 'drop-in', session, start, '70.00', 'paid'],
          ['ns_pay_pkg_two', 'Ana and Ben', "'+15551115555", '', 'package: 10-pack', session, start, '300.00', 'paid'],
        ],
      );

      const bookings = await downloadRecords(base, cookie, 'bookings', daysAroundNow());
      assert.deepEqual(
        bookings.map((r) => [r.Athlete, r['Parent phone'], r.Status, r['Paid with'], r.Price]),
        [
          ['Mia', "'+15551114444", 'booked', 'card', '35.00'],
          ['Leo', "'+15551114444", 'booked', 'card', '35.00'],
          ['Ana', "'+15551115555", 'booked', 'package credit', '35.00'],
          ['Ben', "'+15551115555", 'booked', 'package credit', '35.00'],
        ],
      );
    });
  });
});

/** A parent books and reaches the payment page, without paying yet. */
async function startPay(base: string, handle: string, sessionId: number, athlete: string, phone: string, checkout: Record<string, string> = { mode: 'dropin' }) {
  const b = await bookOnline(base, handle, sessionId, athlete, phone);
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, handle, b.key, checkout);
  assert.equal(pay.status, 303);
  return buyerFromLocation(pay.headers.get('location'));
}

test('a payment that booked no session is still listed: a package whose session was cancelled meanwhile, and payments kept for the coach', async (t) => {
  quiet(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);
    // A second session, which the coach cancels while a parent is paying.
    const gone = await db.query<{ id: number }>(
      "insert into session (session_type_id, starts_at_utc, tz, status) values ($1, now() + interval '3 days', $2, 'scheduled') returning id",
      [seed.sessionTypeId, TZ],
    );
    await withServer(async (base) => {
      const handle = seed.coach.handle;
      // A pack bought with its first session.
      await bookAndPay(base, db, {
        handle,
        sessionId: seed.sessionId,
        athlete: 'Pat',
        phone: '5551116001',
        paymentId: 'ns_pay_pack',
        amountCents: 12000,
        checkout: { mode: 'plan', plan_id: String(planId) },
        paidAt: secondsAgo(100),
      });
      // A package paid for after the coach cancelled its session: all of it becomes credit.
      const pkgBuyer = await startPay(base, handle, gone.rows[0].id, 'Cam', '5551116002', { mode: 'package', package_id: String(packageId) });
      const dropBuyer = await startPay(base, handle, gone.rows[0].id, 'Dee', '5551116003');
      assert.equal((await cancelScheduledSession(db, seed.coach.id, gone.rows[0].id)).kind, 'cancelled');
      await postStorePaid(base, { userId: pkgBuyer, amountCents: 30000, paymentId: 'ns_pay_pkg_late', occurredAt: secondsAgo(80) });
      await postStorePaid(base, { userId: dropBuyer, amountCents: 3500, paymentId: 'ns_pay_drop_late', occurredAt: secondsAgo(70) });
      // A payment for the wrong amount is kept for the coach, not booked. Two
      // events report it; it is one payment.
      const wrong = await startPay(base, handle, seed.sessionId, 'Eli', '5551116004');
      const wrongPaidAt = secondsAgo(60);
      await postStorePaid(base, { userId: wrong, amountCents: 2000, paymentId: 'ns_pay_wrong', occurredAt: wrongPaidAt, eventId: 'rel_evt_wrong_1' });
      await postStorePaid(base, { userId: wrong, amountCents: 2000, paymentId: 'ns_pay_wrong', occurredAt: secondsAgo(5), eventId: 'rel_evt_wrong_2' });
      // A payment for a booking nobody can find, kept for the coach its seller names.
      await postStorePaid(base, {
        userId: 'booking:999999:dropin',
        amountCents: 4100,
        paymentId: 'ns_pay_lost_booking',
        sellerKey: getConnectRecipientKey(seed.coach),
        occurredAt: secondsAgo(50),
      });
      const cookie = await coachCookie(db, seed.coach.id);

      const payments = await downloadRecords(base, cookie, 'payments', daysAroundNow());
      assert.deepEqual(
        payments.map((r) => [r['Payment reference'], r.Athletes, r['Parent phone'], r.Bought, r.Session, r['Session start'], r.Amount, r.Status]),
        [
          ['ns_pay_pack', 'Pat', "'+15551116001", 'pack: Monthly', await sessionTypeName(db, seed.sessionTypeId), await sessionStart(db, seed.sessionId), '120.00', 'paid'],
          ['ns_pay_pkg_late', 'Cam', "'+15551116002", 'package: 10-pack', '', '', '300.00', 'paid'],
          ['ns_pay_drop_late', 'Dee', "'+15551116003", 'drop-in', '', '', '35.00', 'paid'],
          ['ns_pay_wrong', 'Eli', "'+15551116004", 'not booked', '', '', '20.00', 'paid'],
          ['ns_pay_lost_booking', '', '', 'not booked', '', '', '41.00', 'paid'],
        ],
      );
      assert.equal(payments[3]['Paid at'], isoInZone(wrongPaidAt, TZ), "the time on the first event is the payment's");

      // The cancelled session's bookings are in the bookings file as cancelled.
      const bookings = await downloadRecords(base, cookie, 'bookings', daysAroundNow(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)));
      assert.deepEqual(
        bookings.filter((b) => ['Cam', 'Dee'].includes(b.Athlete)).map((b) => [b.Athlete, b.Status, b['Paid with']]),
        [
          ['Cam', 'cancelled', 'package credit'],
          ['Dee', 'cancelled', 'card'],
        ],
      );
    });
  });
});

test("a coach's files hold only that coach's rows, and signed out goes to sign-in", async (t) => {
  quiet(t);
  await withRelay(async () => {
    const db = await freshDb();
    const A = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    const B = await seedCoachWithSession(db, { capacity: 4, priceCents: 5000 });
    await withServer(async (base) => {
      await bookAndPay(base, db, { handle: A.coach.handle, sessionId: A.sessionId, athlete: 'Ana of A', phone: '5551117001', paymentId: 'ns_a_paid', amountCents: 3500, paidAt: secondsAgo(40) });
      await postStorePaid(base, {
        userId: await startPay(base, A.coach.handle, A.sessionId, 'Art of A', '5551117002'),
        amountCents: 100,
        paymentId: 'ns_a_wrong',
        occurredAt: secondsAgo(30),
      });
      const bea = await bookAndPay(base, db, { handle: B.coach.handle, sessionId: B.sessionId, athlete: 'Bea of B', phone: '5551118001', paymentId: 'ns_b_paid', amountCents: 5000, paidAt: secondsAgo(20) });
      await postStorePaid(base, {
        userId: await startPay(base, B.coach.handle, B.sessionId, 'Bob of B', '5551118002'),
        amountCents: 200,
        paymentId: 'ns_b_wrong',
        occurredAt: secondsAgo(10),
      });
      const cookieA = await coachCookie(db, A.coach.id);
      const cookieB = await coachCookie(db, B.coach.id);
      assert.equal((await postForm(base, '/app/money/refund', cookieB, { target: `b${bea}` })).status, 303);
      await postPaymentEvent(base, { type: 'marketplace.purchase.disputed', paymentId: 'ns_b_wrong', disputeId: 'ns_dsp_b', amountCents: 200 });

      // Naming another coach in the address changes nothing: the files follow the sign-in.
      const range = { ...daysAroundNow(), coach: String(B.coach.id), coach_id: String(B.coach.id), handle: B.coach.handle };
      const paymentsA = await fileText(await download(base, cookieA, 'payments', range));
      const bookingsA = await fileText(await download(base, cookieA, 'bookings', range));
      assert.deepEqual(csvRecords(paymentsA).map((r) => [r['Payment reference'], r.Athletes, r.Status]), [
        ['ns_a_paid', 'Ana of A', 'paid'],
        ['ns_a_wrong', 'Art of A', 'paid'],
      ]);
      // Art's payment did not book, so Art is still at checkout, holding the spot.
      assert.deepEqual(csvRecords(bookingsA).map((r) => [r.Athlete, r.Status]), [
        ['Ana of A', 'booked'],
        ['Art of A', 'holding'],
      ]);
      for (const text of [paymentsA, bookingsA]) {
        assert.equal(/of B|ns_b_|5551118|50\.00|refunded|disputed/.test(text), false, "nothing of the other coach's");
      }

      const paymentsB = csvRecords(await fileText(await download(base, cookieB, 'payments', daysAroundNow())));
      assert.deepEqual(paymentsB.map((r) => [r['Payment reference'], r.Athletes, r.Status]), [
        ['ns_b_paid', 'Bea of B', 'refunded'],
        ['ns_b_wrong', 'Bob of B', 'disputed'],
      ]);
      const bookingsB = csvRecords(await fileText(await download(base, cookieB, 'bookings', daysAroundNow())));
      assert.deepEqual(bookingsB.map((r) => [r.Athlete, r.Status]), [
        ['Bea of B', 'refunded'],
        ['Bob of B', 'holding'],
      ]);

      for (const kind of ['payments', 'bookings'] as const) {
        for (const cookie of [null, 'cx_session=not-a-session']) {
          const res = await download(base, cookie, kind, daysAroundNow());
          assert.equal(res.status, 303, `${kind}, ${cookie ? 'a session nobody has' : 'no session'}`);
          assert.equal(res.headers.get('location'), '/signin');
          assert.equal(res.headers.get('content-disposition'), null);
          assert.equal((await res.text()).includes('Ana of A'), false);
        }
      }
    });
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const toCents = (dollars: string) => (dollars === '' ? 0 : Math.round(Number(dollars) * 100));
const total = (rows: Array<Record<string, string>>, column: string) => rows.reduce((n, r) => n + toCents(r[column]), 0);

/** Monday 00:00 UTC of the week `now` is in: a coach whose timezone is UTC
 * starts their week then. */
function mondayUtc(now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - ((now.getUTCDay() + 6) % 7) * DAY_MS);
}

test('for the same days, the payments file adds up to what Money shows as collected and refunded', async (t) => {
  quiet(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 14, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    // The coach's days are UTC days, so this week runs from Monday 00:00 UTC.
    // A parent's cancel is in time up to the start, until the window is widened below.
    await db.query("update coach set tz = 'Etc/UTC', cancel_window_hours = 0 where id = $1", [seed.coach.id]);
    const now = new Date();
    const monday = mondayUtc(now);
    const week = { range: 'custom', from: dayOf(monday), to: dayOf(new Date(monday.getTime() + 6 * DAY_MS)) };
    const { summarizeMoney } = await import('../src/domain/money.js');
    await withServer(async (base) => {
      let n = 0;
      // Each payment is made this week: a few seconds after the week began.
      const pay = (athlete: string, ref: string, amountCents: number, more: { form?: Record<string, string>; checkout?: Record<string, string> } = {}) => {
        n += 1;
        return bookAndPay(base, db, {
          handle: seed.coach.handle,
          sessionId: seed.sessionId,
          athlete,
          phone: `55511190${String(n).padStart(2, '0')}`,
          paymentId: ref,
          amountCents,
          paidAt: new Date(monday.getTime() + n * 1000),
          ...more,
        });
      };
      await pay('Ava', 'ns_w_booked', 3500);
      const attended = await pay('Bo', 'ns_w_attended', 3500);
      const inTime = await pay('Cy', 'ns_w_credit', 3500);
      const late = await pay('Di', 'ns_w_late', 3500);
      const refunded = await pay('Ed', 'ns_w_refunded', 3500);
      const pkg = await pay('Fay', 'ns_w_package', 15000, { checkout: { mode: 'package', package_id: String(packageId) } });
      const two = await pay('Gus', 'ns_w_two', 7000, { form: { athlete_name_2: 'Hal' } });
      // A payment for the wrong amount reached the coach and did not book.
      n += 1;
      await postStorePaid(base, {
        userId: await startPay(base, seed.coach.handle, seed.sessionId, 'Ian', '5551119099'),
        amountCents: 2000,
        paymentId: 'ns_w_wrong',
        occurredAt: new Date(monday.getTime() + n * 1000),
      });

      const cookie = await coachCookie(db, seed.coach.id);
      const manage = async (bookingId: number) =>
        (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
      const cancel = async (bookingId: number) => fetch(`${base}/booking/${await manage(bookingId)}/cancel`, { method: 'POST', redirect: 'manual' });
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${attended}/attendance`, cookie, { status: 'attended' });
      // Cancelled in time: the payment stays with the coach as a session credit.
      assert.equal((await cancel(inTime)).status, 303);
      // Cancelled inside the window: the payment stays with the coach, used.
      await db.query('update coach set cancel_window_hours = 168 where id = $1', [seed.coach.id]);
      assert.equal((await cancel(late)).status, 303);
      assert.equal((await postForm(base, '/app/money/refund', cookie, { target: `b${refunded}` })).headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal((await postForm(base, '/app/money/refund', cookie, { target: `b${two}` })).headers.get('location'), '/app/money?notice=refund-refunded');
      // A booking paid with one of the package's credits: no new payment.
      await db.query(
        `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, credit_id, price_cents)
         select b.session_id, 'Fay again', b.contact_phone, 'booked', 'PackageCredit', b.credit_id, 3500 from booking b where b.id = $1`,
        [pkg],
      );
      assert.deepEqual(
        (await db.query<{ status: string; late_cancel: boolean }>('select status, late_cancel from booking where id = any($1::int[]) order by id', [[attended, inTime, late, refunded, two]])).rows.map(
          (b) => (b.late_cancel ? 'late' : b.status),
        ),
        ['attended', 'cancelled', 'late', 'refunded', 'refunded'],
      );
      // Money counts a payment in the week of the session it paid for, and a
      // refund in the week it went through: both are this week.
      await db.query('update session set starts_at_utc = $1 where id = $2', [new Date(monday.getTime() + 2.5 * DAY_MS).toISOString(), seed.sessionId]);
      await db.query('update refund set refunded_at = $1 where refunded_at is not null', [new Date(monday.getTime() + 60_000).toISOString()]);

      const summary = await summarizeMoney(db, seed.coach.id, now);
      const rows = await downloadRecords(base, cookie, 'payments', week);
      assert.deepEqual(
        rows.map((r) => [r['Payment reference'], r.Bought, r.Amount, r['Refunded amount'], r.Status]),
        [
          ['ns_w_booked', 'drop-in', '35.00', '', 'paid'],
          ['ns_w_attended', 'drop-in', '35.00', '', 'paid'],
          ['ns_w_credit', 'drop-in', '35.00', '', 'paid'],
          ['ns_w_late', 'drop-in', '35.00', '', 'paid'],
          ['ns_w_refunded', 'drop-in', '35.00', '35.00', 'refunded'],
          ['ns_w_package', 'package: 10-pack', '150.00', '', 'paid'],
          ['ns_w_two', 'drop-in', '70.00', '70.00', 'refunded'],
          ['ns_w_wrong', 'not booked', '20.00', '', 'paid'],
        ],
      );

      // Collected: what was paid for bookings, less what went back.
      const forBookings = rows.filter((r) => r.Bought !== 'not booked');
      assert.equal(summary.collectedThisWeekCents, 29000);
      assert.equal(total(forBookings, 'Amount') - total(forBookings, 'Refunded amount'), summary.collectedThisWeekCents);
      // Refunded: every row that reads refunded, and as many payments.
      const refundedRows = rows.filter((r) => r.Status === 'refunded');
      assert.equal(summary.refundedThisWeekCents, 10500);
      assert.equal(total(refundedRows, 'Refunded amount'), summary.refundedThisWeekCents);
      assert.equal(refundedRows.length, summary.refundedThisWeekCount);
      // The payment that did not book is under "Payments to resolve" on Money, not in collected.
      assert.deepEqual(rows.filter((r) => r.Bought === 'not booked').map((r) => r.Amount), ['20.00']);

      // The screen itself, unless the week turned over while this ran.
      const money = await getPage(base, '/app/money', cookie);
      if (mondayUtc(new Date()).getTime() === monday.getTime()) {
        const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
        assert.ok(money.includes(`Collected (gross): ${dollars(total(forBookings, 'Amount') - total(forBookings, 'Refunded amount'))}`), 'collected on the screen');
        assert.ok(money.includes(`Refunded: ${dollars(total(refundedRows, 'Refunded amount'))} (${refundedRows.length} payments)`), 'refunded on the screen');
      }

      // The week before holds none of it.
      const before = { range: 'custom', from: dayOf(new Date(monday.getTime() - 7 * DAY_MS)), to: dayOf(new Date(monday.getTime() - DAY_MS)) };
      assert.deepEqual(await downloadRecords(base, cookie, 'payments', before), []);
    });
  });
});

test('a range the product does not take gets the branded 400 page, and is not counted as a download', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await withServer(async (base) => {
    const cookie = await coachCookie(db, seed.coach.id);
    const bad: string[] = [
      '',
      'range=',
      'range=this-week',
      'range=THIS-MONTH',
      'range[]=this-month',
      'range=this-month&range=last-month',
      // Custom dates need both, real, in order, and no more than 366 days.
      'range=custom',
      'range=custom&from=2026-11-01',
      'range=custom&to=2026-11-30',
      'range=custom&from=2026-11-30&to=2026-11-01',
      'range=custom&from=2026-02-30&to=2026-03-01',
      'range=custom&from=2026-13-01&to=2026-13-02',
      'range=custom&from=2026-1-1&to=2026-1-2',
      'range=custom&from=11/01/2026&to=11/30/2026',
      'range=custom&from=2026-11-01T00:00&to=2026-11-30',
      'range=custom&from=2025-01-01&to=2026-01-02',
      'range=custom&from=1999-12-31&to=2000-01-01',
      'range=custom&from=2100-12-31&to=2101-01-01',
      'range=custom&from[]=2026-11-01&to=2026-11-30',
      'range=custom&from=2026-11-01&to[a]=2026-11-30',
      "range=custom&from=2026-11-01'--&to=2026-11-30",
      `range=custom&from=${'9'.repeat(4000)}&to=2026-11-30`,
    ];
    for (const kind of ['payments', 'bookings'] as const) {
      for (const query of bad) {
        const res = await fetch(`${base}/app/money/download/${kind}.csv?${query}`, { headers: { cookie }, redirect: 'manual' });
        assert.equal(res.status, 400, `${kind}?${query.slice(0, 60)}`);
        assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
        assert.equal(res.headers.get('content-disposition'), null);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const page = await res.text();
        assert.match(page, /<title>That range did not work — Coachatron<\/title>/);
        assert.match(page, /no more than 366 days apart/);
        assert.ok(page.includes('href="/app/money#download"'), 'a way back to Money');
      }
    }
    const counted = await db.query<{ n: string }>('select count(*)::text as n from request_limit');
    assert.equal(counted.rows[0].n, '0', 'a range that was refused costs nothing');

    // The longest custom range is 366 days, both ends included.
    for (const query of ['range=custom&from=2024-01-01&to=2024-12-31', 'range=custom&from=2025-01-01&to=2026-01-01', 'range=custom&from=2026-11-15&to=2026-11-15']) {
      const res = await fetch(`${base}/app/money/download/payments.csv?${query}`, { headers: { cookie } });
      assert.equal(res.status, 200, query);
    }
  });
});

test('a coach has twenty downloads an hour, of either file', async () => {
  const db = await freshDb();
  const A = await seedCoachWithSession(db);
  const B = await seedCoachWithSession(db);
  await withServer(async (base) => {
    const cookieA = await coachCookie(db, A.coach.id);
    const cookieB = await coachCookie(db, B.coach.id);
    for (let i = 0; i < 20; i += 1) {
      const res = await download(base, cookieA, i % 2 === 0 ? 'payments' : 'bookings', { range: 'this-month' });
      assert.equal(res.status, 200, `download ${i + 1}`);
    }
    for (const kind of ['payments', 'bookings'] as const) {
      const res = await download(base, cookieA, kind, { range: 'this-month' });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('content-disposition'), null);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const page = await res.text();
      assert.match(page, /<title>Too many downloads — Coachatron<\/title>/);
      assert.match(page, /Try again in an hour\./);
    }
    // The limit is each coach's own.
    assert.equal((await download(base, cookieB, 'payments', { range: 'this-month' })).status, 200);
    const counters = await db.query<{ bucket: string; key: string; hits: number }>('select bucket, key, hits from request_limit order by key');
    assert.deepEqual(
      counters.rows.map((r) => [r.bucket, r.key, Number(r.hits)]),
      [
        ['money-download-coach-hour', `coach:${A.coach.id}`, 22],
        ['money-download-coach-hour', `coach:${B.coach.id}`, 1],
      ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
    );
    // An hour later the coach can download again.
    await db.query("update request_limit set window_start = window_start - interval '1 hour'");
    assert.equal((await download(base, cookieA, 'bookings', { range: 'this-month' })).status, 200);
  });
});

test('a range with more rows than a file takes is refused whole, never cut short', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { priceCents: 3500 });
  const { MAX_EXPORT_ROWS } = await import('../src/domain/moneyExport.js');
  assert.equal(MAX_EXPORT_ROWS, 50_000);
  const addBookings = (first: number, last: number) =>
    db.query(
      `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, charge_id, price_cents)
       select $1, 'Kid ' || n, '+15550001111', 'booked', 'DropIn', 3500, 'ns_many_' || n, 3500 from generate_series($2::int, $3::int) n`,
      [seed.sessionId, first, last],
    );
  await addBookings(1, MAX_EXPORT_ROWS);
  await withServer(async (base) => {
    const cookie = await coachCookie(db, seed.coach.id);
    // Exactly as many as a file takes: every one of them is there.
    for (const kind of ['payments', 'bookings'] as const) {
      const res = await download(base, cookie, kind, daysAroundNow());
      assert.equal(res.status, 200, kind);
      const text = await fileText(res);
      assert.equal(text.split('\r\n').length - 2, MAX_EXPORT_ROWS, `${kind}: every row after the header`);
    }
    await addBookings(MAX_EXPORT_ROWS + 1, MAX_EXPORT_ROWS + 1);
    for (const kind of ['payments', 'bookings'] as const) {
      const res = await download(base, cookie, kind, daysAroundNow());
      assert.equal(res.status, 422, kind);
      assert.equal(res.headers.get('content-disposition'), null, 'no file, not a shortened one');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const page = await res.text();
      assert.match(page, /<title>That range is too long — Coachatron<\/title>/);
      assert.ok(page.includes(`more than 50,000 ${kind}`), 'says how many a file takes');
      assert.match(page, /Choose a shorter range/);
      assert.ok(page.includes('href="/app/money#download"'));
    }
  });
});

test('Money has a Download block: one range, custom dates, and a button for each file', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await withServer(async (base) => {
    const cookie = await coachCookie(db, seed.coach.id);
    const before = new Date();
    const res = await fetch(`${base}/app/money`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const money = await res.text();
    const block = money.slice(money.indexOf('<h2 id="download">Download</h2>'));
    assert.ok(block.startsWith('<h2 id="download">Download</h2>'), 'the block is on Money');
    assert.match(block, /<form method="get" action="\/app\/money\/download\/payments\.csv">/);
    assert.match(block, /<label for="download_range">Range<\/label>\s*<select id="download_range" name="range">/);
    assert.deepEqual(
      [...block.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]),
      ['this-month', 'last-month', 'this-year', 'last-year', 'custom'],
    );
    // Each range is named with the days it covers, in the coach's timezone.
    const words = [before, new Date()].map((now) => `<option value="last-month">Last month (${presetRange('last-month', TZ, now).words})</option>`);
    assert.ok(words.some((w) => block.includes(w)), 'last month is named');
    assert.match(block, /<label for="download_from">[^<]+<\/label>\s*<input id="download_from" name="from" type="date" \/>/);
    assert.match(block, /<label for="download_to">[^<]+<\/label>\s*<input id="download_to" name="to" type="date" \/>/);
    assert.match(block, /<button type="submit">Download payments<\/button>/);
    assert.match(block, /<button type="submit" class="ghost" formaction="\/app\/money\/download\/bookings\.csv">Download bookings<\/button>/);
    assert.equal(/<script/i.test(block.slice(0, block.indexOf('</form>'))), false, 'the form needs no script');
  });
});
