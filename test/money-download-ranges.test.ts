import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { bookOnline, expireHolds } from './helpers/booking.js';
import { coachCookie, postForm, quiet } from './helpers/refunds.js';
import { bookAndPay, daysAroundNow, downloadRecords, sessionTypeName } from './helpers/csv.js';
import { customRange, MAX_CUSTOM_DAYS, presetRange, resolveRange, type ExportRange } from '../src/domain/moneyExport.js';
import { recordPaidAt } from '../src/domain/paymentReceipt.js';
import type { DbClient } from '../src/db/client.js';

/** A download's range is whole days in the coach's timezone: this month,
 * last month, this year, last year, or custom dates up to 366 days. Each
 * edge is that zone's own midnight, so a day the clocks change and the last
 * day of a year are whole. Payments fall in a range by when they were paid,
 * bookings by when their session starts. */

const CHICAGO = 'America/Chicago';

function edges(range: ExportRange | null): [string, string, string, string] | null {
  return range ? [range.from.toISOString(), range.until.toISOString(), range.label, range.words] : null;
}

test('this month, last month, this year and last year are read on the calendar of the coach\'s timezone', () => {
  // 15 November 2026 in Chicago. November starts on daylight time (the
  // clocks go back on the 1st) and ends on standard time.
  const now = new Date('2026-11-15T18:00:00Z');
  assert.deepEqual(edges(presetRange('this-month', CHICAGO, now)), ['2026-11-01T05:00:00.000Z', '2026-12-01T06:00:00.000Z', '2026-11', 'November 2026']);
  assert.deepEqual(edges(presetRange('last-month', CHICAGO, now)), ['2026-10-01T05:00:00.000Z', '2026-11-01T05:00:00.000Z', '2026-10', 'October 2026']);
  assert.deepEqual(edges(presetRange('this-year', CHICAGO, now)), ['2026-01-01T06:00:00.000Z', '2027-01-01T06:00:00.000Z', '2026', '2026']);
  assert.deepEqual(edges(presetRange('last-year', CHICAGO, now)), ['2025-01-01T06:00:00.000Z', '2026-01-01T06:00:00.000Z', '2025', '2025']);

  // 03:00 UTC on 1 January 2026 is still 9pm on 31 December 2025 in Chicago.
  const newYearsEve = new Date('2026-01-01T03:00:00Z');
  assert.deepEqual(edges(presetRange('this-month', CHICAGO, newYearsEve)), ['2025-12-01T06:00:00.000Z', '2026-01-01T06:00:00.000Z', '2025-12', 'December 2025']);
  assert.deepEqual(edges(presetRange('last-month', CHICAGO, newYearsEve)), ['2025-11-01T05:00:00.000Z', '2025-12-01T06:00:00.000Z', '2025-11', 'November 2025']);
  assert.deepEqual(edges(presetRange('this-year', CHICAGO, newYearsEve))?.slice(2), ['2025', '2025']);
  assert.deepEqual(edges(presetRange('last-year', CHICAGO, newYearsEve))?.slice(2), ['2024', '2024']);

  // In January, last month is December of the year before.
  assert.deepEqual(edges(presetRange('last-month', CHICAGO, new Date('2026-01-15T18:00:00Z'))), [
    '2025-12-01T06:00:00.000Z',
    '2026-01-01T06:00:00.000Z',
    '2025-12',
    'December 2025',
  ]);

  // The same moment is already 16 November, and another year's first day, east of UTC.
  assert.deepEqual(edges(presetRange('this-month', 'Asia/Tokyo', now)), ['2026-10-31T15:00:00.000Z', '2026-11-30T15:00:00.000Z', '2026-11', 'November 2026']);
  assert.deepEqual(edges(presetRange('this-year', 'Pacific/Auckland', new Date('2026-12-31T12:00:00Z')))?.slice(2), ['2027', '2027']);
});

test('custom dates run from the first day\'s midnight to the midnight after the last, whatever the clocks do that day', () => {
  // 8 March 2026 is 23 hours long in Chicago, 1 November 2026 is 25.
  assert.deepEqual(edges(customRange('2026-03-08', '2026-03-08', CHICAGO)), [
    '2026-03-08T06:00:00.000Z',
    '2026-03-09T05:00:00.000Z',
    '2026-03-08-to-2026-03-08',
    '2026-03-08 to 2026-03-08',
  ]);
  assert.deepEqual(edges(customRange('2026-11-01', '2026-11-01', CHICAGO))?.slice(0, 2), ['2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z']);
  assert.deepEqual(edges(customRange('2025-12-31', '2026-01-01', CHICAGO)), [
    '2025-12-31T06:00:00.000Z',
    '2026-01-02T06:00:00.000Z',
    '2025-12-31-to-2026-01-01',
    '2025-12-31 to 2026-01-01',
  ]);
  assert.deepEqual(edges(customRange('2026-06-01', '2026-06-30', 'Etc/UTC'))?.slice(0, 2), ['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
});

test('where the clocks go back at midnight, the day begins at the first midnight (Havana, 1 November 2026)', () => {
  // Cuba's clocks go back from 01:00 to 00:00, so 00:00 happens at 04:00Z and again at 05:00Z.
  assert.deepEqual(edges(customRange('2026-11-01', '2026-11-01', 'America/Havana'))?.slice(0, 2), ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
  assert.deepEqual(edges(presetRange('this-month', 'America/Havana', new Date('2026-11-15T18:00:00Z')))?.slice(0, 2), ['2026-11-01T04:00:00.000Z', '2026-12-01T05:00:00.000Z']);
  assert.deepEqual(edges(customRange('2026-10-31', '2026-10-31', 'America/Havana'))?.slice(0, 2), ['2026-10-31T04:00:00.000Z', '2026-11-01T04:00:00.000Z'], 'the day before ends at the first midnight');
});

test('custom dates are real days in order, no more than 366 of them', () => {
  assert.equal(MAX_CUSTOM_DAYS, 366);
  const ok = (from: unknown, to: unknown) => customRange(from, to, CHICAGO) !== null;
  assert.equal(ok('2024-01-01', '2024-12-31'), true, 'a whole leap year, 366 days');
  assert.equal(ok('2025-01-01', '2026-01-01'), true, '366 days');
  assert.equal(ok('2025-01-01', '2026-01-02'), false, '367 days');
  assert.equal(ok('2024-02-29', '2024-02-29'), true, 'one day');
  assert.equal(ok('2026-11-02', '2026-11-01'), false, 'the last day before the first');
  assert.equal(ok('2025-02-29', '2025-03-01'), false, 'not a day');
  assert.equal(ok('2026-04-31', '2026-05-01'), false);
  assert.equal(ok('2026-00-10', '2026-01-10'), false);
  assert.equal(ok('1999-12-31', '2000-01-01'), false, 'before any record');
  assert.equal(ok('2100-12-31', '2101-01-01'), false);
  for (const junk of ['', ' ', '2026-1-1', '20261101', '2026/11/01', '2026-11-01T00:00:00Z', 'today', null, undefined, 20261101, ['2026-11-01'], { a: '2026-11-01' }]) {
    assert.equal(ok(junk, '2026-11-30'), false, `from ${JSON.stringify(junk)}`);
    assert.equal(ok('2026-11-01', junk), false, `to ${JSON.stringify(junk)}`);
  }
});

test('the query names one of the five ranges; dates beside a named range are refused', () => {
  const now = new Date('2026-11-15T18:00:00Z');
  assert.deepEqual(edges(resolveRange({ range: 'this-month' }, CHICAGO, now)), edges(presetRange('this-month', CHICAGO, now)));
  assert.deepEqual(edges(resolveRange({ range: 'custom', from: '2026-03-01', to: '2026-03-02' }, CHICAGO, now)), edges(customRange('2026-03-01', '2026-03-02', CHICAGO)));
  assert.equal(resolveRange({ range: 'custom' }, CHICAGO, now), null);
  assert.equal(resolveRange({ range: 'last-year', from: '2026-03-01', to: '2026-03-02' }, CHICAGO, now), null, 'dates beside a named range are refused, not ignored');
  assert.deepEqual(edges(resolveRange({ range: 'last-year', from: '', to: '' }, CHICAGO, now)), edges(presetRange('last-year', CHICAGO, now)), 'empty dates, as the form sends them, are fine');
  for (const range of [undefined, null, '', 'week', 'This-Month', 'this-month ', ['this-month'], { 0: 'this-month' }, 7]) {
    assert.equal(resolveRange({ range, from: '2026-03-01', to: '2026-03-02' }, CHICAGO, now), null, JSON.stringify(range));
  }
});

/** A session at `instant` with one attended booking, paid for at that same
 * instant. */
async function seedAt(db: DbClient, sessionTypeId: number, label: string, instant: string): Promise<void> {
  const session = await db.query<{ id: number }>(
    "insert into session (session_type_id, starts_at_utc, tz, status) values ($1, $2, 'America/Chicago', 'scheduled') returning id",
    [sessionTypeId, instant],
  );
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, charge_id, price_cents)
     values ($1, $2, '+15550002222', 'attended', 'DropIn', 3500, $3, 3500)`,
    [session.rows[0].id, label, `ns_${label}`],
  );
  await db.query('insert into payment_receipt (payment_ref, paid_at) values ($1, $2)', [`ns_${label}`, instant]);
}

test('a payment and a booking fall in a range by the coach\'s own midnight: at the year end and on both days the clocks change', async () => {
  const db = await freshDb();
  const chicago = await seedCoachWithSession(db, { priceCents: 3500 });
  const tokyo = await seedCoachWithSession(db, { priceCents: 3500 });
  await db.query("update coach set tz = 'Asia/Tokyo' where id = $1", [tokyo.coach.id]);
  const moments: Array<[label: string, instant: string, local: string]> = [
    ['last-second-of-2025', '2026-01-01T05:59:59Z', '2025-12-31T23:59:59-06:00'],
    ['first-second-of-2026', '2026-01-01T06:00:00Z', '2026-01-01T00:00:00-06:00'],
    ['before-spring-day', '2026-03-08T05:59:59Z', '2026-03-07T23:59:59-06:00'],
    ['spring-day-starts', '2026-03-08T06:00:00Z', '2026-03-08T00:00:00-06:00'],
    ['spring-day-late', '2026-03-09T04:30:00Z', '2026-03-08T23:30:00-05:00'],
    ['after-spring-day', '2026-03-09T05:00:00Z', '2026-03-09T00:00:00-05:00'],
    ['before-fall-day', '2026-11-01T04:59:59Z', '2026-10-31T23:59:59-05:00'],
    ['fall-day-starts', '2026-11-01T05:00:00Z', '2026-11-01T00:00:00-05:00'],
    ['fall-day-first-0130', '2026-11-01T06:30:00Z', '2026-11-01T01:30:00-05:00'],
    ['fall-day-second-0130', '2026-11-01T07:30:00Z', '2026-11-01T01:30:00-06:00'],
    ['fall-day-late', '2026-11-02T05:30:00Z', '2026-11-01T23:30:00-06:00'],
    ['after-fall-day', '2026-11-02T06:00:00Z', '2026-11-02T00:00:00-06:00'],
  ];
  for (const [label, instant] of moments) await seedAt(db, chicago.sessionTypeId, label, instant);
  // Tokyo's year turns nine hours before UTC's, fifteen before Chicago's.
  await seedAt(db, tokyo.sessionTypeId, 'tokyo-2025', '2025-12-31T14:59:59Z');
  await seedAt(db, tokyo.sessionTypeId, 'tokyo-2026', '2025-12-31T15:00:00Z');
  const local = new Map(moments.map(([label, , text]) => [label, text]));

  await withServer(async (base) => {
    const cookie = await coachCookie(db, chicago.coach.id);
    const expectIn = async (from: string, to: string, labels: string[]) => {
      const query = { range: 'custom', from, to };
      const payments = await downloadRecords(base, cookie, 'payments', query);
      assert.deepEqual(payments.map((r) => [r.Athletes, r['Paid at']]), labels.map((l) => [l, local.get(l)]), `payments ${from} to ${to}`);
      const bookings = await downloadRecords(base, cookie, 'bookings', query);
      assert.deepEqual(bookings.map((r) => [r.Athlete, r['Session start']]), labels.map((l) => [l, local.get(l)]), `bookings ${from} to ${to}`);
    };
    // The year ends at Chicago's midnight, six hours after UTC's.
    await expectIn('2025-01-01', '2025-12-31', ['last-second-of-2025']);
    await expectIn('2026-01-01', '2026-01-31', ['first-second-of-2026']);
    // The day the clocks go forward is 23 hours: it ends at its own midnight, not 24 hours after it began.
    await expectIn('2026-03-08', '2026-03-08', ['spring-day-starts', 'spring-day-late']);
    await expectIn('2026-03-09', '2026-03-09', ['after-spring-day']);
    // The day the clocks go back is 25 hours, and 1:30 happens twice in it.
    await expectIn('2026-10-01', '2026-10-31', ['before-fall-day']);
    await expectIn('2026-11-01', '2026-11-01', ['fall-day-starts', 'fall-day-first-0130', 'fall-day-second-0130', 'fall-day-late']);
    await expectIn('2026-11-02', '2026-11-02', ['after-fall-day']);
    await expectIn(
      '2026-01-01',
      '2026-12-31',
      moments.map(([label]) => label).filter((label) => label !== 'last-second-of-2025'),
    );

    // The same range for a coach in Tokyo is Tokyo's days.
    const tokyoCookie = await coachCookie(db, tokyo.coach.id);
    const tokyo2025 = await downloadRecords(base, tokyoCookie, 'payments', { range: 'custom', from: '2025-01-01', to: '2025-12-31' });
    assert.deepEqual(tokyo2025.map((r) => [r.Athletes, r['Paid at']]), [['tokyo-2025', '2025-12-31T23:59:59+09:00']]);
    const tokyo2026 = await downloadRecords(base, tokyoCookie, 'bookings', { range: 'custom', from: '2026-01-01', to: '2026-12-31' });
    assert.deepEqual(tokyo2026.map((r) => [r.Athlete, r['Session start']]), [['tokyo-2026', '2026-01-01T00:00:00+09:00']]);
  });
});

test('a payment with no time kept is listed at the time its booking was made, or the time it was kept for the coach', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { priceCents: 3500 });
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, charge_id, price_cents, created_at)
     values ($1, 'Early', '+15550003333', 'booked', 'DropIn', 3500, 'ns_early', 3500, '2026-06-01T15:00:00Z')`,
    [seed.sessionId],
  );
  await db.query(
    `insert into payment_attention (event_id, coach_id, reason, amount_cents, payment_ref, athlete_name, contact_phone, created_at)
     values ('rel_evt_early_kept', $1, 'session_full', 3500, 'ns_early_kept', 'Kept', '+15550004444', '2026-06-02T15:00:00Z')`,
    [seed.coach.id],
  );
  await withServer(async (base) => {
    const cookie = await coachCookie(db, seed.coach.id);
    const june = await downloadRecords(base, cookie, 'payments', { range: 'custom', from: '2026-06-01', to: '2026-06-30' });
    assert.deepEqual(
      june.map((r) => [r['Payment reference'], r['Paid at'], r.Athletes, r.Bought]),
      [
        ['ns_early', '2026-06-01T10:00:00-05:00', 'Early', 'drop-in'],
        ['ns_early_kept', '2026-06-02T10:00:00-05:00', 'Kept', 'not booked'],
      ],
    );
    // Once the store's time for a payment is kept, that is its time.
    await recordPaidAt(db, 'ns_early', new Date('2026-05-31T23:00:00Z'));
    await recordPaidAt(db, 'ns_early', new Date('2026-06-15T12:00:00Z'));
    const may = await downloadRecords(base, cookie, 'payments', { range: 'custom', from: '2026-05-01', to: '2026-05-31' });
    assert.deepEqual(may.map((r) => [r['Payment reference'], r['Paid at']]), [['ns_early', '2026-05-31T18:00:00-05:00']], 'the first time kept stays');
  });
});

test('keeping a payment\'s time never stops the payment: a failure is logged and nothing is thrown', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const broken: DbClient = {
    query: async () => {
      throw new Error('the database is away');
    },
  };
  await assert.doesNotReject(recordPaidAt(broken, 'ns_any', new Date()));
  assert.equal(errors.mock.calls.length, 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /^payment-receipt:/);
});

test('each state of a booking reads in plain words, with what paid for it, where it is, and its price when it was booked', async (t) => {
  quiet(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 20, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);
    await db.query("update session set location_text = 'Field 3, north gate' where id = $1", [seed.sessionId]);
    // A parent's cancel is in time up to the start, until the window is widened below.
    await db.query('update coach set cancel_window_hours = 0 where id = $1', [seed.coach.id]);
    await withServer(async (base) => {
      let n = 0;
      const pay = (athlete: string, amountCents = 3500, checkout?: Record<string, string>) => {
        n += 1;
        return bookAndPay(base, db, {
          handle: seed.coach.handle,
          sessionId: seed.sessionId,
          athlete,
          phone: `55511300${String(n).padStart(2, '0')}`,
          paymentId: `ns_b_${n}`,
          amountCents,
          form: { contact_email: `${athlete.toLowerCase()}@example.com` },
          checkout,
        });
      };
      const cookie = await coachCookie(db, seed.coach.id);
      const mark = (bookingId: number, status: string) => postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/attendance`, cookie, { status });
      const cancel = async (bookingId: number) => {
        const token = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
        assert.equal((await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
      };
      const creditOf = async (bookingId: number) =>
        (await db.query<{ credit_id: number }>('select credit_id from booking where id = $1', [bookingId])).rows[0].credit_id;
      /** A booking paid with a session credit, as checkout records one. */
      const bookWithCredit = (athlete: string, creditId: number) =>
        db.query(
          `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, credit_id, price_cents)
           values ($1, $2, '+15551130099', 'booked', 'PackageCredit', $3, 3500)`,
          [seed.sessionId, athlete, creditId],
        );

      await pay('Ava');
      await mark(await pay('Bo'), 'attended');
      await mark(await pay('Cy'), 'noshow');
      const di = await pay('Di');
      await cancel(di);
      await db.query('update coach set cancel_window_hours = 168 where id = $1', [seed.coach.id]);
      await cancel(await pay('Ed'));
      const fay = await pay('Fay');
      assert.equal((await postForm(base, '/app/money/refund', cookie, { target: `b${fay}` })).headers.get('location'), '/app/payments?notice=refund-refunded');
      const gia = await pay('Gia', 30000, { mode: 'package', package_id: String(packageId) });
      const hal = await pay('Hal', 12000, { mode: 'plan', plan_id: String(planId) });
      await seedBookedSession(db, seed.sessionId, 'Ivy', '+15551130098');
      await bookWithCredit('Jo', await creditOf(gia));
      await bookWithCredit('Kai', await creditOf(hal));
      await bookWithCredit('Lee', await creditOf(di));
      // Ned left checkout and the hold ran out; Max is at checkout now.
      assert.ok((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Ned', '5551130097')).key);
      await expireHolds(db, seed.sessionId);
      // The coach raises the price: bookings already made keep theirs.
      await db.query('update session_type set price_cents = 4000 where id = $1', [seed.sessionTypeId]);
      assert.ok((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Max', '5551130096', { contact_email: 'max@example.com' })).key);

      const session = await sessionTypeName(db, seed.sessionTypeId);
      const rows = await downloadRecords(base, cookie, 'bookings', daysAroundNow());
      assert.deepEqual(
        rows.map((r) => [r.Athlete, r.Status, r['Paid with'], r.Price]),
        [
          ['Ava', 'booked', 'card', '35.00'],
          ['Bo', 'attended', 'card', '35.00'],
          ['Cy', 'no-show', 'card', '35.00'],
          ['Di', 'cancelled', 'card', '35.00'],
          ['Ed', 'late cancel', 'card', '35.00'],
          ['Fay', 'refunded', 'card', '35.00'],
          ['Gia', 'booked', 'package credit', '35.00'],
          ['Hal', 'booked', 'pack credit', '35.00'],
          ['Ivy', 'booked', 'free', '35.00'],
          ['Jo', 'booked', 'package credit', '35.00'],
          ['Kai', 'booked', 'pack credit', '35.00'],
          ['Lee', 'booked', 'session credit', '35.00'],
          ['Max', 'holding', '', '40.00'],
        ],
      );
      for (const r of rows) {
        assert.equal(r.Session, session);
        assert.equal(r.Location, 'Field 3, north gate');
        assert.match(r['Session start'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/);
      }
      assert.deepEqual(
        rows.filter((r) => ['Ava', 'Max', 'Ivy'].includes(r.Athlete)).map((r) => [r['Parent phone'], r['Parent email']]),
        [
          ['+15551130001', 'ava@example.com'],
          ['+15551130098', ''],
          ['+15551130096', 'max@example.com'],
        ],
      );
    });
  });
});
