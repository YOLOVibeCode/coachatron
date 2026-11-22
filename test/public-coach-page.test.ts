import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { packageSaveCents } from '../src/domain/publicCoachPage.js';
import { updateCoachPublicPage } from '../src/domain/auth.js';

test('packageSaveCents is drop-in credits minus pack price when cheaper', () => {
  assert.equal(packageSaveCents({ id: 1, coach_id: 1, name: '10-pack', credits: 10, price_cents: 8500, expires_days: null }, 1000), 1500);
  assert.equal(packageSaveCents({ id: 1, coach_id: 1, name: '10-pack', credits: 10, price_cents: 10000, expires_days: null }, 1000), null);
});

test('public coach page shows closed banner, filters, packs, and coach copy', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false, priceCents: 3500, capacity: 1 });
    await updateCoachPublicPage(db, seed.coach.id, {
      publicBio: 'Elementary reading coach.',
      sessionsPlace: 'Online',
    });
    await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      let html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      if (!html.includes('Not open')) {
        html = await (await fetch(`${base}/c/${seed.coach.handle}?week=1`)).text();
      }
      assert.match(html, /Booking is not open yet/);
      assert.match(html, /has not turned on payments/);
      assert.match(html, /Ask a question/);
      assert.match(html, /mailto:/);
      assert.match(html, /support/);
      assert.match(html, /Not open/);
      assert.doesNotMatch(html, /Booking opens soon/);
      assert.match(html, /Elementary reading coach/);
      assert.match(html, /Sessions: Online/);
      assert.match(html, /Session packs/);
      assert.match(html, /Pay once, book them one at a time/);
      assert.match(html, /Save \$25/);
      assert.match(html, /Available/);
      assert.match(html, /60 min/);
      assert.match(html, /Show (next|this) week/);
    });
  });
});

test('coach can hide a session from the public page', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: true });
    await db.query('update session set hide_from_public = true where id = $1', [seed.sessionId]);
    await withServer(async (base) => {
      const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(html, /No open sessions in this week/);
    });
  });
});