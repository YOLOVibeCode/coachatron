import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';

test('GET /c/:handle shows packs, policy, My bookings, and hides coach contact details', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { priceCents: 1000, paymentsReady: true });
  await seedPackage(db, seed.coach.id, 10, 8500);
  await db.query('update coach set children_per_booking = 3 where id = $1', [seed.coach.id]);
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
    assert.match(html, /<h2>Session packs<\/h2>/);
    assert.match(html, /Pay once, book them one at a time/);
    assert.match(html, /Save \$1\.50 per session/);
    assert.match(html, /Cancel free up to 24 hours before/);
    assert.match(html, /Up to 3 people per booking/);
    assert.match(html, /<a class="my-bookings" href="\/my">My bookings<\/a>/);
    assert.match(html, /<a href="\/my">See all your sessions<\/a>/);
    assert.match(html, new RegExp(`Message ${seed.coach.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(html, new RegExp(seed.coach.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /\+\d{10,}/);
  });
});

test('Save $X is omitted when the pack does not beat drop-in price', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { priceCents: 1000, paymentsReady: true });
  await seedPackage(db, seed.coach.id, 10, 10000);
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
    assert.match(html, /<h2>Session packs<\/h2>/);
    assert.doesNotMatch(html, /Save \$/);
  });
});

test('payments closed shows banner, Not open buttons, and message link', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { paymentsReady: false });
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
    assert.match(html, /Booking is not open yet/);
    assert.match(html, /has not turned on payments/);
    assert.match(html, />Not open<\/button>/);
    assert.doesNotMatch(html, /href="[^"]+\/book/);
    assert.match(html, /\/c\/[^/]+\/message/);
  });
});

test('coach sets client contact channel on Pricing policy form', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await withServer(async (base) => {
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    const saved = await fetch(`${base}/app/pricing/policy`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        cancel_window_hours: '24',
        children_per_booking: '2',
        client_contact_channel: 'email',
      }),
      redirect: 'manual',
    });
    assert.equal(saved.status, 303);
    const row = await db.query<{ client_contact_channel: string }>('select client_contact_channel from coach where id = $1', [
      seed.coach.id,
    ]);
    assert.equal(row.rows[0].client_contact_channel, 'email');
  });
});

test('POST /c/:handle/message delivers to the coach without exposing their address on the page', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await db.query('update coach set client_contact_channel = $2 where id = $1', [seed.coach.id, 'phone']);
    await withServer(async (base) => {
      const form = await (await fetch(`${base}/c/${seed.coach.handle}/message`)).text();
      assert.doesNotMatch(form, new RegExp(seed.coach.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (seed.coach.phone) {
        assert.doesNotMatch(form, new RegExp(seed.coach.phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }

      const sent = await fetch(`${base}/c/${seed.coach.handle}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          contact: 'pat@example.com',
          message: 'What age group is this for?',
        }),
      });
      assert.equal(sent.status, 200);
      assert.match(await sent.text(), /Message sent/);
      const toCoach = relay.sms.filter((m) => m.to === seed.coach.phone);
      assert.equal(toCoach.length, 1);
      assert.match(toCoach[0].body, /What age group/);
      assert.match(toCoach[0].body, /pat@example.com/);
    });
  });
});

test('one-time packs appear in the Session packs section', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { paymentsReady: true });
  await seedPlan(db, seed.coach.id, 4, 3600);
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
    assert.match(html, /Credits do not expire/);
    assert.match(html, /4 sessions/);
  });
});