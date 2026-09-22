import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { startFakeRelay, type FakeRelay } from './fakes/relay.js';
import { seedCoachWithSession, seedBookedSession } from './helpers/fixtures.js';

async function withRelay(fn: (relay: FakeRelay) => Promise<void>): Promise<void> {
  const relay = await startFakeRelay();
  process.env.RELAY_BASE_URL = relay.url;
  try {
    await fn(relay);
  } finally {
    await relay.close();
    delete process.env.RELAY_BASE_URL;
  }
}

async function coachPost(base: string, path: string, form: URLSearchParams, cookie?: string): Promise<Response> {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' } as Record<string, string>;
  if (cookie) {
    headers.cookie = cookie;
  }
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: form,
    redirect: 'manual', // Don't follow redirects so we can check the status
  });
}

function makeAuthCookie(token: string): string {
  return `cx_session=${token}`;
}

test('coach can view session detail and mark attendance', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });

    // Book two athletes
    const bookingId1 = await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    const bookingId2 = await seedBookedSession(db, seed.sessionId, 'Athlete Two', '+15550000002');

    // Sign in coach to get session token
    await db.query(
      `insert into coach_session (token, coach_id, expires_at) values ($1, $2, now() + interval '30 days') returning token`,
      ['test-token', seed.coach.id],
    );

    await withServer(async (base) => {
      // GET session detail
      const getRes = await fetch(`${base}/app/sessions/${seed.sessionId}`, {
        headers: { cookie: makeAuthCookie('test-token') },
      });
      assert.equal(getRes.status, 200);
      const body = await getRes.text();
      assert.ok(body.includes('Athlete One'));
      assert.ok(body.includes('Athlete Two'));

      // Mark first athlete as attended
      const form1 = new URLSearchParams();
      form1.append('status', 'attended');
      const postRes1 = await coachPost(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId1}/attendance`, form1, makeAuthCookie('test-token'));
      assert.equal(postRes1.status, 303);

      // Verify status updated
      const rows1 = await db.query<{ status: string }>('select status from booking where id = $1', [bookingId1]);
      assert.equal(rows1.rows[0].status, 'attended');

      // Mark second athlete as no-show
      const form2 = new URLSearchParams();
      form2.append('status', 'noshow');
      const postRes2 = await coachPost(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId2}/attendance`, form2, makeAuthCookie('test-token'));
      assert.equal(postRes2.status, 303);

      const rows2 = await db.query<{ status: string }>('select status from booking where id = $1', [bookingId2]);
      assert.equal(rows2.rows[0].status, 'noshow');
    });
  });
});

test('coach can cancel a session and SMS all athletes', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });

    // Book three athletes
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedBookedSession(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await seedBookedSession(db, seed.sessionId, 'Athlete Three', '+15550000003');

    // Sign in coach
    await db.query(
      `insert into coach_session (token, coach_id, expires_at) values ($1, $2, now() + interval '30 days') returning token`,
      ['test-token', seed.coach.id],
    );

    await withServer(async (base) => {
      // Get session detail first to verify initial state
      const getRes = await fetch(`${base}/app/sessions/${seed.sessionId}`, {
        headers: { cookie: makeAuthCookie('test-token') },
      });
      assert.equal(getRes.status, 200);
      const body = await getRes.text();
      assert.ok(body.includes('3 attendees'));

      // Cancel the session
      const cancelForm = new URLSearchParams();
      const cancelRes = await coachPost(base, `/app/sessions/${seed.sessionId}/cancel`, cancelForm, makeAuthCookie('test-token'));
      assert.equal(cancelRes.status, 303);

      // Verify all bookings are cancelled
      const rows = await db.query<{ status: string }>('select status from booking where session_id = $1', [seed.sessionId]);
      for (const row of rows.rows) {
        assert.equal(row.status, 'cancelled');
      }

      // Verify SMS sent to each athlete
      const athletePhones = ['+15550000001', '+15550000002', '+15550000003'];
      for (const phone of athletePhones) {
        assert.ok(relay.sms.some((m) => m.to === phone), `expected SMS to ${phone}`);
      }
    });
  });
});

test('cannot cancel a session that has already started', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });

    // Create session in the past
    const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    await db.query(
      `update session set starts_at_utc = $1 where id = $2`,
      [pastDate, seed.sessionId],
    );

    // Book an athlete
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');

    // Sign in coach
    await db.query(
      `insert into coach_session (token, coach_id, expires_at) values ($1, $2, now() + interval '30 days') returning token`,
      ['test-token', seed.coach.id],
    );

    await withServer(async (base) => {
      // Try to cancel the session
      const cancelForm = new URLSearchParams();
      const cancelRes = await coachPost(base, `/app/sessions/${seed.sessionId}/cancel`, cancelForm, makeAuthCookie('test-token'));
      assert.equal(cancelRes.status, 409);

      const body = await cancelRes.text();
      assert.ok(body.includes('already passed'));
    });
  });
});

test('coach can delete a session', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });

    // Sign in coach
    await db.query(
      `insert into coach_session (token, coach_id, expires_at) values ($1, $2, now() + interval '30 days') returning token`,
      ['test-token', seed.coach.id],
    );

    await withServer(async (base) => {
      // Get session detail first
      const getRes = await fetch(`${base}/app/sessions/${seed.sessionId}`, {
        headers: { cookie: makeAuthCookie('test-token') },
      });
      assert.equal(getRes.status, 200);

      // Cancel the session
      const cancelForm = new URLSearchParams();
      const cancelRes = await coachPost(base, `/app/sessions/${seed.sessionId}/cancel`, cancelForm, makeAuthCookie('test-token'));
      assert.equal(cancelRes.status, 303);

      // Verify session status changed
      const sessionRows = await db.query<{ status: string }>('select status from session where id = $1', [seed.sessionId]);
      assert.equal(sessionRows.rows[0].status, 'cancelled');
    });
  });
});
