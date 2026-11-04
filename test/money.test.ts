import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { createCoach } from '../src/domain/auth.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { summarizeMoney } from '../src/domain/money.js';

test('money screen shows correct summaries after various bookings', async () => {
  const db = await freshDb();

  // coach.handle is not-null/unique and coach creation has its own
  // slugify/collision logic (src/domain/auth.ts) - go through createCoach()
  // rather than a raw insert that has to duplicate that.
  const coach = await createCoach(db, {
    name: 'Test Coach',
    phone: '+15550001234',
    email: 'test@example.com',
    tz: 'America/Chicago',
  });

  // Create a session type
  const typeResult = await db.query<{ id: number; price_cents: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Drop-in', 60, 5, 3500, true)
     returning id, price_cents`,
    [coach.id],
  );
  const sessionType = typeResult.rows[0];

  // Create a session this week (Monday-Sunday in America/Chicago)
  // Set the session to start at 6pm on Wednesday of this week
  const now = new Date();
  const monday = new Date(now);
  const dayOfWeek = monday.getDay() || 7; // Sunday=0, make it 7 for calc
  monday.setDate(monday.getDate() - (dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);

  const wednesday = new Date(monday);
  wednesday.setDate(wednesday.getDate() + 3);
  wednesday.setHours(18, 0, 0, 0);

  const sessionResult = await db.query<{ id: number; starts_at_utc: string }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, $2, $3, 'scheduled')
     returning id, starts_at_utc`,
    [sessionType.id, wednesday.toISOString(), coach.tz],
  );
  const sessionId = sessionResult.rows[0].id;

  // Book 2 drop-in sessions this week
  for (let i = 1; i <= 2; i++) {
    await db.query(
      `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, price_cents)
       values ($1, 'Athlete ${i}', '+1555000${String(i).padStart(4, '0')}', 'booked', 'DropIn', $2, $2)`,
      [sessionId, sessionType.price_cents],
    );
  }

  // Create a package and book one session using it
  const pkgResult = await db.query<{ id: number }>(
    `insert into package (coach_id, name, credits, price_cents, active)
     values ($1, '10-pack', 10, 30000, true)
     returning id`,
    [coach.id],
  );
  const pkgId = pkgResult.rows[0].id;

  // Buy the package (simulated charge successful)
  await db.query(
    `insert into credit (coach_id, contact_phone, package_id, remaining, source, expires_at)
     values ($1, '+15551112222', $2, 9, '.Package.10-pack', null)`,
    [coach.id, pkgId],
  );

  // Book one session with the credit
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, credit_id, price_cents)
     values ($1, 'Package User', '+15551112222', 'booked', 'PackageCredit', $2, currval('credit_id_seq'), $2)`,
    [sessionId, sessionType.price_cents],
  );

  // Create next week's sessions (projection test)
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  for (let i = 0; i < 3; i++) {
    const dayDate = new Date(nextMonday);
    dayDate.setDate(dayDate.getDate() + i * 2); // Mon, Wed, Fri
    dayDate.setHours(18, 0, 0, 0);

    await db.query(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       values ($1, $2, $3, 'scheduled')`,
      [sessionType.id, dayDate.toISOString(), coach.tz],
    );
  }

  // Test the money summary
  const { summarizeMoney } = await import('../src/domain/money.js');
  const summary = await summarizeMoney(db, coach.id, now);

  assert.equal(summary.bookedThisWeekCount, 3, 'booked this week count should be 3');
  assert.equal(summary.bookedThisWeekCents, sessionType.price_cents * 3, 'booked this week cents should match 3 sessions');
  assert.equal(summary.collectedThisWeekCents, sessionType.price_cents * 2 + sessionType.price_cents, 'collected should include all 3 bookings');
  assert.equal(summary.outstandingCreditCount, 9, 'outstanding credits should be 9 (10 bought - 1 used)');
  assert.equal(summary.nextWeekCount, 3, 'next week count should be 3');
  assert.equal(summary.nextWeekCents, sessionType.price_cents * 3, 'next week cents should match 3 projected sessions');

  // Now test the actual route, authenticated. The OTP round trip itself is
  // already covered by test/coach-onboarding.test.ts (M2) - here we only
  // need a valid session, so create a coach_session row directly, the same
  // way test/session-management.test.ts and test/manage-booking.test.ts do.
  await withServer(async (base) => {
    const loginRes = await fetch(`${base}/signin`);
    assert.equal(loginRes.status, 200);

    const { createCoachSession } = await import('../src/domain/auth.js');
    const token = await createCoachSession(db, coach.id);

    // Call the money endpoint with authentication
    const moneyRes = await fetch(`${base}/app/money`, {
      headers: { cookie: `cx_session=${token}` },
    });
    assert.equal(moneyRes.status, 200);

    const htmlText = await moneyRes.text();
    assert.ok(htmlText.includes('This week'));
    assert.ok(htmlText.includes('3 sessions booked'));
    assert.ok(htmlText.includes('$105.00')); // 3 x $35
    assert.ok(htmlText.includes('Collected (gross): $105.00'));
    assert.ok(htmlText.includes('Credits'));
    assert.ok(htmlText.includes('9 credits outstanding'));
    assert.ok(htmlText.includes('Next week'));
    assert.ok(htmlText.includes('3 sessions projected'));

    // SPEC.md §7.4 / §5 (P5): "There is no payout screen, no balance, no
    // withdrawal." This is the one acceptance item that isn't a number to
    // check - it's an absence to check.
    assert.ok(!/balance/i.test(htmlText), 'Money screen must not show a balance figure');
    assert.ok(!/withdraw/i.test(htmlText), 'Money screen must not offer a withdrawal control');
  });
});

test('money screen shows zero when no bookings exist', async () => {
  const db = await freshDb();

  const coach = await createCoach(db, {
    name: 'New Coach',
    phone: '+15559991234',
    email: 'new@example.com',
    tz: 'America/New_York',
  });

  // No sessions, no bookings, no credits

  const { summarizeMoney } = await import('../src/domain/money.js');
  const summary = await summarizeMoney(db, coach.id, new Date());

  assert.equal(summary.bookedThisWeekCount, 0);
  assert.equal(summary.bookedThisWeekCents, 0);
  assert.equal(summary.collectedThisWeekCents, 0);
  assert.equal(summary.outstandingCreditCount, 0);
  assert.equal(summary.nextWeekCount, 0);
  assert.equal(summary.nextWeekCents, 0);
});

test('money screen correctly excludes cancelled bookings from collected this week', async () => {
  const db = await freshDb();

  const coach = await createCoach(db, {
    name: 'Cancelled Coach',
    phone: '+15558881234',
    email: 'cancel@example.com',
    tz: 'America/Los_Angeles',
  });

  // Create session type
  const typeResult = await db.query<{ id: number; price_cents: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Test', 60, 5, 5000, true)
     returning id, price_cents`,
    [coach.id],
  );
  const sessionType = typeResult.rows[0];

  // Create a session
  const now = new Date();
  const monday = new Date(now);
  const dayOfWeek = monday.getDay() || 7;
  monday.setDate(monday.getDate() - (dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);

  const wednesday = new Date(monday);
  wednesday.setDate(wednesday.getDate() + 3);
  wednesday.setHours(18, 0, 0, 0);

  const sessionResult = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, $2, $3, 'scheduled')
     returning id`,
    [sessionType.id, wednesday.toISOString(), coach.tz],
  );
  const sessionId = sessionResult.rows[0].id;

  //Book a cancelled booking
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents)
     values ($1, 'Cancelled Athlete', '+15557778888', 'cancelled', 'DropIn', $2)`,
    [sessionId, sessionType.price_cents],
  );

  //Book a confirmed booking
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, price_cents)
     values ($1, 'Attended Athlete', '+15557779999', 'booked', 'DropIn', $2, $2)`,
    [sessionId, sessionType.price_cents],
  );

  const { summarizeMoney } = await import('../src/domain/money.js');
  const summary = await summarizeMoney(db, coach.id, now);

  assert.equal(summary.bookedThisWeekCount, 1, 'only 1 confirmed booking should count');
  assert.equal(summary.collectedThisWeekCents, sessionType.price_cents, 'only collected (booked) booking counts');
});

test('money screen shows correct data with credits that have expiry', async () => {
  const db = await freshDb();

  const coach = await createCoach(db, {
    name: 'Expiry Coach',
    phone: '+15556661234',
    email: 'expiry@example.com',
    tz: 'America/Chicago',
  });

  // Create a credit with expiry in the past
  await db.query(
    `insert into credit (coach_id, contact_phone, package_id, remaining, source, expires_at)
     values ($1, '+15554443333', null, 5, 'Expired', now() - interval '7 days')`,
    [coach.id],
  );

  // Create a credit with expiry in the future
  await db.query(
    `insert into credit (coach_id, contact_phone, package_id, remaining, source, expires_at)
     values ($1, '+15554443333', null, 10, 'Future', now() + interval '7 days')`,
    [coach.id],
  );

  const { summarizeMoney } = await import('../src/domain/money.js');
  const summary = await summarizeMoney(db, coach.id, new Date());

  // Both credits should be counted (expiry check is done by getCreditBalance in pricing.ts,
  // but for money screen we sum all remaining, including expired ones per the schema design)
  assert.equal(summary.outstandingCreditCount, 15, 'both credits should be summed');
});

test('marking a booking attended or a no-show keeps it in booked and collected', async () => {
  const { seedCoachWithSession, seedBookedSession } = await import('./helpers/fixtures.js');
  const { summarizeMoney } = await import('../src/domain/money.js');
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
  const first = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
  const second = await seedBookedSession(db, seed.sessionId, 'Athlete Two', '+15550000002');
  await db.query('update booking set gross_cents = 3500 where id in ($1, $2)', [first, second]);
  // "Now" is the session's own start, so it is always inside "this week".
  const start = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0];
  const now = new Date(start.starts_at_utc);

  const before = await summarizeMoney(db, seed.coach.id, now);
  assert.deepEqual([before.bookedThisWeekCount, before.bookedThisWeekCents, before.collectedThisWeekCents], [2, 7000, 7000]);

  await db.query("update booking set status = 'attended' where id = $1", [first]);
  await db.query("update booking set status = 'noshow' where id = $1", [second]);
  const after = await summarizeMoney(db, seed.coach.id, now);
  assert.deepEqual([after.bookedThisWeekCount, after.bookedThisWeekCents, after.collectedThisWeekCents], [2, 7000, 7000]);

  await db.query("update booking set status = 'cancelled' where id = $1", [second]);
  const cancelled = await summarizeMoney(db, seed.coach.id, now);
  assert.deepEqual([cancelled.bookedThisWeekCount, cancelled.collectedThisWeekCents], [1, 3500]);
});

test('a payment that became credit because the coach had cancelled counts as collected, not as booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    // "Now" is the session's own start, so it is always inside "this week".
    const start = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0];
    const now = new Date(start.starts_at_utc);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const userId = buyerFromLocation(pay.headers.get('location'));
      assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_after_cancel' })).status, 200);
    });
    const row = await db.query<{ status: string; gross_cents: number; credit_id: number | null }>(
      'select status, gross_cents, credit_id from booking where session_id = $1',
      [seed.sessionId],
    );
    assert.deepEqual([row.rows[0].status, row.rows[0].gross_cents, row.rows[0].credit_id !== null], ['cancelled', 3500, true]);

    const summary = await summarizeMoney(db, seed.coach.id, now);
    assert.equal(summary.collectedThisWeekCents, 3500, 'the payment reached the coach');
    assert.equal(summary.bookedThisWeekCount, 0, 'nobody is booked into a cancelled session');
    assert.equal(summary.outstandingCreditCount, 1, 'and the parent holds it as one session credit');
  });
});

test('a cancelled booking whose payment was not kept as credit stays out of collected', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
  const start = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0];
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, manage_token)
     values ($1, 'Parent Cancelled', '+15557778888', 'cancelled', 'DropIn', 3500, 'tok_parent_cancelled_1')`,
    [seed.sessionId],
  );
  const summary = await summarizeMoney(db, seed.coach.id, new Date(start.starts_at_utc));
  assert.equal(summary.collectedThisWeekCents, 0);
});

test('a price change on the session type does not reprice bookings already made', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    const start = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0];
    const now = new Date(start.starts_at_utc);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const userId = buyerFromLocation(pay.headers.get('location'));
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_before_price_change' })).status, 200);
    });
    const before = await summarizeMoney(db, seed.coach.id, now);
    assert.deepEqual([before.bookedThisWeekCount, before.bookedThisWeekCents], [1, 3500]);

    await db.query('update session_type set price_cents = 5000 where id = $1', [seed.sessionTypeId]);
    const after = await summarizeMoney(db, seed.coach.id, now);
    assert.deepEqual([after.bookedThisWeekCount, after.bookedThisWeekCents, after.collectedThisWeekCents], [1, 3500, 3500]);
  });
});

test('bookings from before prices were recorded take their own charge, or the price when the change ran', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 5000 });
  const insert = (name: string, source: string, gross: number | null) =>
    db.query(
      `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, manage_token)
       values ($1, $2, '+15550001111', 'booked', $3, $4, $2)`,
      [seed.sessionId, name, source, gross],
    );
  await insert('drop-in at the old price', 'DropIn', 3500);
  await insert('from a package', 'PackageCredit', null);
  await insert('from a pack', 'Subscription', 12000);
  const sql = readFileSync(new URL('../src/db/migrations/0027_booking_price.sql', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  // Twice: the second run changes nothing.
  for (let run = 0; run < 2; run += 1) {
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(statement);
  }
  const rows = await db.query<{ athlete_name: string; price_cents: number; payment_source: string }>(
    'select athlete_name, price_cents, payment_source from booking where session_id = $1 order by id',
    [seed.sessionId],
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.athlete_name, r.price_cents, r.payment_source]),
    [
      ['drop-in at the old price', 3500, 'DropIn'],
      ['from a package', 5000, 'PackageCredit'],
      ['from a pack', 5000, 'Pack'],
    ],
  );
});
