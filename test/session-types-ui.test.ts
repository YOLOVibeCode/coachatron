import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createWeeklySlots } from '../src/domain/scheduling.js';
import { postNewSessionType } from './helpers/sessionTypes.js';

function form(body: Record<string, string>, cookie?: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual' as const,
  };
}

test('session types list: collapsed create, spots wording, weekly summary, create banner', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await createWeeklySlots(db, seed.sessionTypeId, seed.coach.tz, [{ weekday: 2, timeLocal: '16:00' }], new Date());
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const list = await (await fetch(`${base}/app/session-types`, { headers: { cookie } })).text();
      assert.match(list, /<details class="session-type-create">/);
      assert.doesNotMatch(list, /<details class="session-type-create" open/);
      assert.match(list, /\+ New session type/);
      assert.match(list, /one-on-one|up to \d+ spots/);
      assert.match(list, /Tue · 4:00pm|No weekly times yet/);

      const create = await postNewSessionType(base, cookie, {
        name: 'Math tutoring',
        duration_min: '45',
        capacity: '5',
        price_dollars: '25',
      });
      assert.equal(create.status, 303);
      const loc = create.headers.get('location') ?? '';
      assert.match(loc, /created=\d+/);
      const createdId = Number(new URL(loc, base).searchParams.get('created'));
      assert.ok(createdId > 0);

      const after = await (await fetch(`${base}/app/session-types?created=${createdId}`, { headers: { cookie } })).text();
      assert.match(after, /Math tutoring.*added/);
      assert.match(after, new RegExp(`href="/app/session-types/${createdId}/generate-week"`));
    });
  });
});

test('session types: duplicate name refused; delete blocked when bookings exist', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    await seedBookedSession(db, seed.sessionId, 'Sam', '+15550000001');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const dup = await postNewSessionType(base, cookie, {
        name: 'goalkeeper group',
        duration_min: '60',
        capacity: '4',
        price_dollars: '35',
      });
      assert.equal(dup.status, 422);
      assert.match(await dup.text(), /already have a session type called goalkeeper group/i);

      const delPage = await (
        await fetch(`${base}/app/session-types/${seed.sessionTypeId}/delete`, { headers: { cookie } })
      ).text();
      assert.match(delPage, /bookings/);
      assert.doesNotMatch(delPage, /Delete session type<\/button>/);

      await createWeeklySlots(db, seed.sessionTypeId, seed.coach.tz, [{ weekday: 4, timeLocal: '17:00' }], new Date());
      const emptyType = await postNewSessionType(base, cookie, {
        name: 'Empty type',
        duration_min: '30',
        capacity: '1',
        price_dollars: '20',
      });
      const emptyId = Number(new URL(emptyType.headers.get('location') ?? '', base).searchParams.get('created'));
      const delEmpty = await (
        await fetch(`${base}/app/session-types/${emptyId}/delete`, { headers: { cookie } })
      ).text();
      assert.match(delEmpty, /Delete session type/);
      const removed = await fetch(`${base}/app/session-types/${emptyId}/delete`, form({}, cookie));
      assert.equal(removed.status, 303);
      const active = await db.query<{ n: string }>(
        'select count(*)::text as n from session_type where id = $1 and active',
        [emptyId],
      );
      assert.equal(active.rows[0].n, '0');
    });
  });
});