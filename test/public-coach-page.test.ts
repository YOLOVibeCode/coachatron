import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { createCoachSession, updateCoachPublicPage } from '../src/domain/auth.js';

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

test('public coach page shows the closed banner, coach copy, filters and week paging together', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false, priceCents: 3500, capacity: 1 });
    await updateCoachPublicPage(db, seed.coach.id, {
      publicBio: 'Elementary reading coach.',
      sessionsPlace: 'Online',
    });
    await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const path = `/c/${seed.coach.handle}`;
      const html = await (await fetch(`${base}${path}`)).text();
      assert.match(html, /Booking is not open yet/);
      assert.match(html, /has not turned on payments/);
      assert.match(html, new RegExp(`<a href="${path}/message">Message `));
      assert.doesNotMatch(html, /Ask a question/);
      assert.match(html, />Not open<\/button>/);
      assert.doesNotMatch(html, /Booking opens soon/);
      assert.match(html, /<a class="my-bookings" href="\/my">My bookings<\/a>/);
      assert.match(html, /Elementary reading coach/);
      assert.match(html, /Sessions: Online/);
      assert.match(html, /Times are in /);
      assert.match(html, /<h2>Session packs<\/h2>/);
      assert.match(html, /Save \$5 per session/);
      assert.match(html, /Cancel free up to 24 hours before/);
      assert.match(html, /<h2 class="day-heading">/);
      assert.match(html, /Available/);
      assert.match(html, /60 min/);
      assert.match(html, new RegExp(`href="${path}\\?week=1">Show next week<`));

      const nextWeek = await (await fetch(`${base}${path}?week=1`)).text();
      assert.match(nextWeek, /No open sessions in this week/, "tomorrow's session is not in next week");
      assert.match(nextWeek, new RegExp(`href="${path}">Show this week<`));

      const groups = await (await fetch(`${base}${path}?type=group`)).text();
      assert.match(groups, /No open sessions in this week/, 'a one-on-one session is not a group');
      assert.match(groups, /Booking is not open yet/, 'the banner does not depend on the sessions shown');
      const oneOnOne = await (await fetch(`${base}${path}?type=one_on_one`)).text();
      assert.match(oneOnOne, />Not open<\/button>/);
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