import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import {
  seedCoachWithSession,
  seedPackage,
  createCredit,
} from './helpers/fixtures.js';

test('money screen shows correct summaries after various bookings', async () => {
  const db = await freshDb();

  // Seed a coach with timezone America/Chicago
  const coachResult = await db.query<{
    id: number;
    handle: string;
    tz: string;
  }>(
    `insert into coach (name, phone, email, tz)
     values ('Test Coach', '+15550001234', 'test@example.com', 'America/Chicago')
     returning id, slug as handle, tz`,
  );
  const coach = coachResult.rows[0];

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
      `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents)
       values ($1, 'Athlete ${i}', '+1555000${String(i).padStart(4, '0')}', 'booked', 'DropIn', $2)`,
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
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents, credit_id)
     values ($1, 'Package User', '+15551112222', 'booked', 'PackageCredit', $2, currval('credit_id_seq'))`,
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

  // Now test the actual route
  await withServer(async (base) => {
    const loginRes = await fetch(`${base}/signin`);
    assert.equal(loginRes.status, 200);

    // Simulate a session cookie for this coach by setting it directly
    const { serializeCookie } = await import('../src/lib/cookies.js');
    // We need to actually log in to get a valid token
    // Let's use the helper to set up auth properly

    const { createOtp, checkOtp, consumeOtp, createCoachSession, findCoachByPhone } = await import('../src/domain/auth.js');

    // Get phone from coach row and create a session
    const code = '123456';
    const otpId = await db.query<{ id: number }>(
      `insert into otp_code (phone, code_hash, expires_at)
       values ($1, encode(sha256($2::bytea), 'hex'), now() + interval '10 minutes')
       returning id`,
      [coach.phone, code],
    );

    await db.query(`update otp_code set consumed_at = now() where id = $1`, [otpId]);

    const coachRow = await findCoachByPhone(db, coach.phone);
    assert.ok(coachRow);

    const token = await createCoachSession(db, coachRow.id);

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
  });
});

test('money screen shows zero when no bookings exist', async () => {
  const db = await freshDb();

  const coachResult = await db.query<{
    id: number;
    tz: string;
  }>(
    `insert into coach (name, phone, email, tz)
     values ('New Coach', '+15559991234', 'new@example.com', 'America/New_York')
     returning id, tz`,
  );
  const coach = coachResult.rows[0];

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

  const coachResult = await db.query<{ id: number; tz: string }>(
    `insert into coach (name, phone, email, tz)
     values ('Cancelled Coach', '+15558881234', 'cancel@example.com', 'America/Los_Angeles')
     returning id, tz`,
  );
  const coach = coachResult.rows[0];

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
    `insert into booking (session_id, athlete_name, contact_phone, status, payment_source, gross_cents)
     values ($1, 'Attended Athlete', '+15557779999', 'booked', 'DropIn', $2)`,
    [sessionId, sessionType.price_cents],
  );

  const { summarizeMoney } = await import('../src/domain/money.js');
  const summary = await summarizeMoney(db, coach.id, now);

  assert.equal(summary.bookedThisWeekCount, 1, 'only 1 confirmed booking should count');
  assert.equal(summary.collectedThisWeekCents, sessionType.price_cents, 'only collected (booked) booking counts');
});

test('money screen shows correct data with credits that have expiry', async () => {
  const db = await freshDb();

  const coachResult = await db.query<{ id: number }>(
    `insert into coach (name, phone, email, tz)
     values ('Expiry Coach', '+15556661234', 'expiry@example.com', 'America/Chicago')
     returning id`,
  );
  const coach = coachResult.rows[0];

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
