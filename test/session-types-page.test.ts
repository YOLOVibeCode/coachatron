import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createCoach } from '../src/domain/auth.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createWeeklySlots } from '../src/domain/scheduling.js';

function form(body: Record<string, string>, cookie?: string) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual' as const,
  };
}

test('session types list: collapsed create, spots wording, weekly summary, inline edit', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 1000 });
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await createWeeklySlots(db, seed.sessionTypeId, 'America/Chicago', [{ weekday: 2, timeLocal: '16:00' }], new Date());
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/app/session-types`, { headers: { cookie } })).text();
      assert.match(page, /\+ New session type/);
      assert.doesNotMatch(page, /<details[^>]*open[^>]*>\s*<summary>\+ New session type/);
      assert.doesNotMatch(page, /athletes/);
      assert.match(page, /one-on-one/);
      assert.match(page, /Tue · 4:00pm/);
      assert.match(page, /Weekly times ›/);
      assert.match(page, /<summary class="action ghost">Edit<\/summary>/);
      assert.match(page, /Saved locations/);
    });
  });
});

test('create shows confirmation and blocks duplicate names', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const coach = await createCoach(db, { phone: '+15553334444', name: 'Tutor', email: 't@example.com', tz: 'America/Chicago' });
    await grantSmsConsent(db, coach.phone);
    const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
    const body = { name: 'Algebra group', duration_min: '60', capacity: '5', price_dollars: '10' };
    await withServer(async (base) => {
      const created = await fetch(`${base}/app/session-types`, form(body, cookie));
      assert.equal(created.status, 303);
      assert.match(created.headers.get('location') ?? '', /\?added=\d+/);
      const after = await (await fetch(`${base}${created.headers.get('location')}`, { headers: { cookie } })).text();
      assert.match(after, /Algebra group added/);
      assert.match(after, /Add weekly times/);

      const dup = await fetch(`${base}/app/session-types`, form({ ...body, name: 'algebra group' }, cookie));
      assert.equal(dup.status, 422);
      const dupPage = await dup.text();
      assert.match(dupPage, /already have a session type with that name/);
      const count = await db.query<{ n: string }>('select count(*)::text as n from session_type where coach_id = $1', [coach.id]);
      assert.equal(count.rows[0].n, '1');
    });
  });
});

test('delete hides the type but keeps a booked session on the schedule', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550001111');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const deleted = await fetch(`${base}/app/session-types/${seed.sessionTypeId}/delete`, form({}, cookie));
      assert.equal(deleted.status, 303);
      const list = await (await fetch(`${base}/app/session-types`, { headers: { cookie } })).text();
      assert.doesNotMatch(list, /Goalkeeper Group/);
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, new RegExp(`href="/app/sessions/${seed.sessionId}"`));
    });
  });
});

test('weekly times form uses compact day rows', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/app/session-types/${seed.sessionTypeId}/generate-week`, { headers: { cookie } })).text();
      assert.match(page, /weekly-day-row/);
      assert.match(page, /up to 2 spots|one-on-one/);
      assert.doesNotMatch(page, / athletes/);
    });
  });
});