import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { checkOverflow } from '../src/domain/cascade.js';
import { seedCoachWithSession, seedRosterMember, seedBookedSession } from './helpers/fixtures.js';

test('booking a full session returns 409', async () => {
  await withRelay(async (_relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);

    // Fill the session
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await checkOverflow(db, seed.sessionId);

    let html: string;
    await withServer(async (base) => {
      const res = await fetch(`${base}/c/${seed.coach.handle}`);
      assert.equal(res.status, 200);
      html = await res.text();
    });

    // Should show Full
    assert.match(html, /Full/);

    // Try to book anyway - should get 409 with waitlist option
    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          athlete_name: 'Athlete Two',
          contact_phone: '+15550000002',
        }),
        redirect: 'manual',
      });
      assert.equal(bookRes.status, 409);

      const bookHtml = await bookRes.text();
      assert.match(bookHtml, /just filled up/);
      assert.match(bookHtml, /waitlist/);
    });
  });
});

test('invalid phone format at sign-in returns 422', async () => {
  await withRelay(async (_relay) => {
    await withServer(async (base) => {
      // Invalid phone format (no country code, wrong length)
      const otpRes = await fetch(`${base}/signin/otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: 'invalid-phone' }),
        redirect: 'manual',
      });
      // Should return 422 for invalid format
      assert.equal(otpRes.status, 422);

      const otpHtml = await otpRes.text();
      assert.match(otpHtml, /valid/);
    });
  });
});

test('booking a session type from a different coach returns 404', async () => {
  await withRelay(async (_relay) => {
    const db = await freshDb();

    // Create first coach
    const seed1 = await seedCoachWithSession(db, { capacity: 1 });

    // Create second coach with different handle
    const seed2 = await seedCoachWithSession(db, { capacity: 1 });
    // Update handle to be different from seed1's handle
    await db.query('update coach set handle = $1 where id = $2', ['coach-two', seed2.coach.id]);

    // Book a session for seed2 so it has open slots
    await withServer(async (base) => {
      await fetch(`${base}/c/${seed2.coach.handle}/sessions/${seed2.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          athlete_name: 'Athlete One',
          contact_phone: '+15550000001',
        }),
        redirect: 'manual',
      });
    });

    // Now try to book seed2's session using seed1's handle - should be 404
    await withServer(async (base) => {
      const badRes = await fetch(`${base}/c/${seed1.coach.handle}/sessions/${seed2.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          athlete_name: 'Athlete Two',
          contact_phone: '+15550000002',
        }),
        redirect: 'manual',
      });
      assert.equal(badRes.status, 404);

      const badHtml = await badRes.text();
      assert.match(badHtml, /Not found/);
    });
  });
});
