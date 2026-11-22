import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createPackage, createPlan } from '../src/domain/pricing.js';

test('the public coach page lists packages, cancellation rule, duration, and payments copy', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await createPackage(db, seed.coach.id, '10-pack', 10, 8500);
    await createPlan(db, seed.coach.id, 'Four pack', 12000, 4);
    await db.query("update coach set cancel_window_hours = 24 where id = $1", [seed.coach.id]);
    await db.query(
      `update session set starts_at_utc = '2027-06-15 18:00:00+00', tz = 'America/Chicago' where id = $1`,
      [seed.sessionId],
    );
    await withServer(async (base) => {
      const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(html, /Cancel free up to 24 hours before a session/);
      assert.match(html, /10-pack/);
      assert.match(html, /Four pack/);
      assert.match(html, /per session/);
      assert.match(html, /\bmin\b/);
      assert.match(html, /2027/);
      assert.match(html, /Booking opens soon/);
      assert.match(html, /still setting up payments/);
    });
  });
});