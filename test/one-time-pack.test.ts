import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createPlan } from '../src/domain/pricing.js';
import { createCoachSession } from '../src/domain/auth.js';
import { renderSetupPreview, validateSetupPlan } from '../src/domain/setup.js';

/** A plan is charged once and its sessions do not expire, so parents and
 * coaches see it as a one-time pack: nothing reads as monthly or recurring. */

const RECURRING = /monthly|\/mo\b|per month|subscri/i;

test('the pricing screen lists a plan as a one-time pack', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await createPlan(db, seed.coach.id, 'Four pack', 12000, 4);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const res = await fetch(`${base}/app/pricing`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /One-time packs/);
      assert.match(body, /4 sessions, one-time/);
      assert.match(body, /Sessions in the pack/);
      assert.doesNotMatch(body, RECURRING);
    });
  });
});

test('checkout offers a plan as a one-time pack', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createPlan(db, seed.coach.id, 'Four pack', 12000, 4);
    await withServer(async (base) => {
      const book = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Rae', contact_phone: '5551112222' }),
        redirect: 'manual',
      });
      assert.equal(book.status, 303);
      const checkout = await fetch(new URL(book.headers.get('location') ?? '', base));
      assert.equal(checkout.status, 200);
      const body = await checkout.text();
      assert.match(body, /Buy Four pack — 4 sessions for \$120\.00, one-time/);
      assert.doesNotMatch(body, RECURRING);
    });
  });
});

test('the setup preview shows a plan as a one-time pack', () => {
  const { plan } = validateSetupPlan(
    {
      coach_timezone: null,
      session_types: [{ key: 'g', name: 'Group', duration_min: 60, capacity: 6, price_cents: 3500, backup_pay_cents: null }],
      weekly: [{ type_key: 'g', weekday: 2, time_local: '18:00', location: null }],
      packages: [],
      plans: [{ name: 'Four pack', price_cents: 12000, credits_per_month: 4 }],
    },
    [],
  );
  const coach = { id: 1, handle: 'dana', name: 'Dana', email: '', phone: '+1', tz: 'America/Chicago', connect_recipient_key: null };
  const preview = renderSetupPreview(plan, coach, new Date('2026-10-20T12:00:00Z')).value;
  assert.match(preview, /Four pack: 4 sessions for \$120, one-time/);
  assert.doesNotMatch(preview, RECURRING);
});
