import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';

function form(body: Record<string, string>, cookie?: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual' as const,
  };
}

test('session types list hides the create form until + New session type is opened', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const res = await fetch(`${base}/app/session-types`, { headers: { cookie } });
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /\+ New session type/);
      assert.match(html, /<details class="type-create">/);
      assert.doesNotMatch(html, /<details class="type-create" open/);
      assert.match(html, /one-on-one|up to \d+ spots/);
      assert.doesNotMatch(html, / athletes /);
      assert.match(html, /No weekly times yet/);
    });
  });
});

test('create confirms the next step, defaults duration, and rejects duplicate names', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const omitted = await fetch(
        `${base}/app/session-types`,
        form({ name: 'Evening group', capacity: '6', price_dollars: '40' }, cookie),
      );
      assert.equal(omitted.status, 303);
      const createdLoc = omitted.headers.get('location') ?? '';
      const createdPage = await (await fetch(`${base}${createdLoc}`, { headers: { cookie } })).text();
      assert.match(createdPage, /Evening group added/);
      assert.match(createdPage, /\/app\/session-types\/\d+\/generate-week/);

      const dup = await fetch(
        `${base}/app/session-types`,
        form({ name: 'Evening group', duration_min: '60', capacity: '6', price_dollars: '40' }, cookie),
      );
      assert.equal(dup.status, 422);
      assert.match(await dup.text(), /already have a session type with this name/);
      const n = await db.query<{ c: string }>(
        `select count(*)::text as c from session_type where coach_id = $1 and lower(btrim(name)) = 'evening group' and active`,
        [seed.coach.id],
      );
      assert.equal(n.rows[0].c, '1');
    });
  });
});

test('weekly times page uses compact weekday rows', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const html = await (await fetch(`${base}/app/session-types/${seed.sessionTypeId}/generate-week`, { headers: { cookie } })).text();
      assert.match(html, /class="weekday-row"/);
      assert.match(html, /class="weekday-name"/);
    });
  });
});

test('delete retires an empty type but refuses when upcoming sessions are booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await seedBookedSession(db, seed.sessionId, 'Sam', '+15550001111');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const blocked = await fetch(`${base}/app/session-types/${seed.sessionTypeId}/delete`, form({}, cookie));
      assert.equal(blocked.status, 422);
      assert.match(await blocked.text(), /upcoming sessions with bookings/);

      const extra = await fetch(
        `${base}/app/session-types`,
        form({ name: 'Unused type', duration_min: '45', capacity: '4', price_dollars: '20' }, cookie),
      );
      assert.equal(extra.status, 303);
      const loc = extra.headers.get('location') ?? '';
      const idMatch = /created=(\d+)/.exec(loc);
      assert.ok(idMatch, loc);
      const typeId = Number(idMatch![1]);

      const removed = await fetch(`${base}/app/session-types/${typeId}/delete`, form({}, cookie));
      assert.equal(removed.status, 303);
      const active = await db.query<{ active: boolean }>('select active from session_type where id = $1', [typeId]);
      assert.equal(active.rows[0].active, false);
    });
  });
});