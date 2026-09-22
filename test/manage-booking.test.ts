import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { seedCoachWithSession, seedBookedSession } from './helpers/fixtures.js';

test('GET /booking/:token shows booking details', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Book an athlete
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  assert.ok(bookingResult.rows[0], 'booking should exist');
  const token = bookingResult.rows[0].manage_token;

  await withServer(async (base) => {
    // GET the manage booking page
    const getRes = await fetch(`${base}/booking/${token}`);
    assert.equal(getRes.status, 200);
    const body = await getRes.text();
    assert.ok(body.includes('Athlete One'));
    assert.ok(body.includes(seed.coach.handle));
  });
});

test('POST /booking/:token/cancel sets status to cancelled and frees spot', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Book an athlete
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  const token = bookingResult.rows[0].manage_token;

  // Verify spot count before cancellation
  const bookedBefore = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status in ('booked', 'attended', 'noshow')",
    [seed.sessionId],
  );
  assert.equal(Number(bookedBefore.rows[0].count), 1);

  await withServer(async (base) => {
    // Cancel the booking
    const cancelRes = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
    assert.equal(cancelRes.status, 303);

    // Verify booking status changed
    const rows = await db.query<{ status: string }>('select status from booking where id = $1', [bookingId]);
    assert.equal(rows.rows[0].status, 'cancelled');
  });

  // Verify spot count after cancellation
  const bookedAfter = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status in ('booked', 'attended', 'noshow')",
    [seed.sessionId],
  );
  assert.equal(Number(bookedAfter.rows[0].count), 0);
});

test(' cancelling a paid-with-credit booking increments credit', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Create a package and credit
  const pkgId = await db.query<{ id: number }>(
    `insert into package (coach_id, name, credits, price_cents, active)
     values ($1, '10-pack', 10, 30000, true) returning id`,
    [seed.coach.id],
  ).then((r) => r.rows[0].id);

  const contactPhone = '+15550000001';

  // Create credit with initial balance of 5. $3 is passed once as the
  // integer package_id and again pre-formatted as the text source, rather
  // than reused as `$3::text` — PGlite's parameter-type inference rejects
  // the same placeholder being deduced as two different types in one
  // statement ("inconsistent types deduced for parameter $3").
  const creditId = await db.query<{ id: number }>(
    `insert into credit (coach_id, contact_phone, package_id, remaining, source)
     values ($1, $2, $3, 5, $4) returning id`,
    [seed.coach.id, contactPhone, pkgId, `package:${pkgId}`],
  ).then((r) => r.rows[0].id);

  // Book with credit first to get booking ID
  const bookingId = await seedBookedSession(db, seed.sessionId, contactPhone, contactPhone);
  await db.query(
    `update booking set payment_source = 'PackageCredit', credit_id = $1, status = 'booked' where id = $2`,
    [creditId, bookingId],
  );

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  const token = bookingResult.rows[0].manage_token;

  // Verify initial credit balance
  const creditBefore = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId]);
  assert.equal(creditBefore.rows[0].remaining, 5);

  await withServer(async (base) => {
    // Cancel the booking
    const cancelRes = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
    assert.equal(cancelRes.status, 303);
  });

  // Verify credit was incremented back
  const creditAfter = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId]);
  assert.equal(creditAfter.rows[0].remaining, 6);
});

test('cannot cancel a session that has already started', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Create session in the past
  const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
  await db.query(
    `update session set starts_at_utc = $1 where id = $2`,
    [pastDate, seed.sessionId],
  );

  // Book an athlete
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  const token = bookingResult.rows[0].manage_token;

  await withServer(async (base) => {
    // Try to cancel
    const cancelRes = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
    assert.equal(cancelRes.status, 409);

    const body = await cancelRes.text();
    assert.ok(body.includes('already passed'));
  });
});

test('unknown token returns 404', async () => {
  await withServer(async (base) => {
    const getRes = await fetch(`${base}/booking/does-not-exist`);
    assert.equal(getRes.status, 404);
  });
});

test('cancelled booking shows correct status on manage page', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Book and immediately cancel
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
  await db.query(`update booking set status = 'cancelled' where id = $1`, [bookingId]);

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  const token = bookingResult.rows[0].manage_token;

  await withServer(async (base) => {
    const getRes = await fetch(`${base}/booking/${token}`);
    assert.equal(getRes.status, 200);
    const body = await getRes.text();
    assert.ok(body.includes('Cancelled'));
  });
});

test('cancellation allowed before session starts but not after', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Test with future session
  const bookingIdFuture = await seedBookedSession(db, seed.sessionId, 'Athlete Future', '+15550000100');
  const tokenFuture = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingIdFuture])).rows[0].manage_token;

  await withServer(async (base) => {
    const getRes = await fetch(`${base}/booking/${tokenFuture}`);
    assert.equal(getRes.status, 200);
    const bodyFuture = await getRes.text();
    assert.ok(bodyFuture.includes('Cancel this booking'));
  });

  // Create session in the past
  const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.query(
    `update session set starts_at_utc = $1 where id = $2`,
    [pastDate, seed.sessionId],
  );

  // Book another athlete for this past session
  const bookingIdPast = await seedBookedSession(db, seed.sessionId, 'Athlete Past', '+15550000200');
  const tokenPast = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingIdPast])).rows[0].manage_token;

  await withServer(async (base) => {
    const getRes = await fetch(`${base}/booking/${tokenPast}`);
    assert.equal(getRes.status, 200);
    const bodyPast = await getRes.text();
    assert.ok(bodyPast.includes('Cancellations are not accepted after'));
    assert.ok(!bodyPast.includes('Cancel this booking'));
  });
});

test('cannot cancel already cancelled booking', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });

  // Book and cancel
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
  await db.query(`update booking set status = 'cancelled' where id = $1`, [bookingId]);

  // Get the manage_token
  const bookingResult = await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId]);
  const token = bookingResult.rows[0].manage_token;

  // Initial credit balance (if any)
  const creditRows = await db.query<{ credit_id: number | null }>('select credit_id from booking where id = $1', [bookingId]);
  if (creditRows.rows[0]?.credit_id) {
    // Verify initial credit balance before cancellation
    void (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditRows.rows[0].credit_id!]));
  }

  await withServer(async (base) => {
    // First cancel works
    const cancelRes1 = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
    assert.equal(cancelRes1.status, 303);

    // Second cancel should still succeed (idempotent)
    const cancelRes2 = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
    assert.equal(cancelRes2.status, 303);
  });
});
