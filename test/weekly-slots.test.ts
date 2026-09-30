import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import {
  createWeeklySlots,
  deactivateSlot,
  ensureSlotSessions,
  topUpAllSlots,
  zonedParts,
} from '../src/domain/scheduling.js';
import type { DbClient } from '../src/db/client.js';

const TZ = 'America/Chicago';
// Tuesday Oct 20 2026, 7am in Chicago. Chicago leaves daylight time on Nov 1.
const NOW = new Date('2026-10-20T12:00:00Z');

async function slotSessions(db: DbClient, slotId: number): Promise<Array<{ starts_at_utc: string; status: string }>> {
  const result = await db.query<{ starts_at_utc: string; status: string }>(
    'select starts_at_utc, status from session where weekly_slot_id = $1 order by starts_at_utc',
    [slotId],
  );
  return result.rows;
}

test('a weekly slot fills 8 weeks ahead at the same local time across the DST change', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00' }], NOW);

  const sessions = await slotSessions(db, slot.id);
  // Oct 20 through Dec 15: nine Tuesdays inside the 56-day horizon.
  assert.equal(sessions.length, 9);
  for (const s of sessions) {
    const local = zonedParts(new Date(s.starts_at_utc), TZ);
    assert.equal(local.weekday, 2);
    assert.equal(local.hour, 18);
    assert.equal(local.minute, 0);
  }
  // Before and after Nov 1 the UTC hour differs by one; the local time does not.
  assert.equal(new Date(sessions[0].starts_at_utc).toISOString(), '2026-10-20T23:00:00.000Z');
  assert.equal(new Date(sessions[2].starts_at_utc).toISOString(), '2026-11-04T00:00:00.000Z');
});

test('top-up is idempotent and adds one more week as time passes', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 4, timeLocal: '17:30' }], NOW);
  const before = (await slotSessions(db, slot.id)).length;

  assert.equal(await ensureSlotSessions(db, slot, TZ, NOW), 0);
  assert.equal(await topUpAllSlots(db, NOW), 0);
  assert.equal((await slotSessions(db, slot.id)).length, before);

  const weekLater = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.equal(await topUpAllSlots(db, weekLater), 1);
});

test('a time already past today is skipped', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  // 6am Tuesday has already passed at 7am Tuesday.
  const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '06:00' }], NOW);
  const first = (await slotSessions(db, slot.id))[0];
  assert.equal(zonedParts(new Date(first.starts_at_utc), TZ).day, 27);
});

test('removing a slot cancels its empty sessions and keeps booked ones', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00' }], NOW);
  const ids = await db.query<{ id: number }>('select id from session where weekly_slot_id = $1 order by starts_at_utc', [slot.id]);
  await seedBookedSession(db, ids.rows[1].id, 'Sam Reyes', '+15550000001');

  assert.equal(await deactivateSlot(db, seed.coach.id + 999, slot.id, NOW), null, 'another coach cannot remove it');
  assert.equal(await deactivateSlot(db, seed.coach.id, slot.id, NOW), 1);

  const sessions = await slotSessions(db, slot.id);
  assert.equal(sessions.filter((s) => s.status === 'scheduled').length, 1);
  assert.equal(sessions.filter((s) => s.status === 'cancelled').length, sessions.length - 1);
  assert.equal(await topUpAllSlots(db, new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000)), 0);
});

test('weekly times screen: add with a location, list, remove; schedule links each session', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const addRes = await fetch(`${base}/app/session-types/${seed.sessionTypeId}/generate-week`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ day_2: '1', time_2: '18:00', day_4: '1', time_4: '18:00', location: 'Field 3' }),
        redirect: 'manual',
      });
      assert.equal(addRes.status, 303);

      const slots = await db.query<{ id: number }>('select id from weekly_slot where session_type_id = $1 and active', [
        seed.sessionTypeId,
      ]);
      assert.equal(slots.rows.length, 2);
      const located = await db.query<{ n: string }>(
        "select count(*)::text as n from session where location_text = 'Field 3'",
      );
      assert.ok(Number(located.rows[0].n) >= 16, 'expected about 8 weeks of Tue and Thu sessions');

      const page = await (await fetch(`${base}/app/session-types/${seed.sessionTypeId}/generate-week`, { headers: { cookie } })).text();
      assert.match(page, /Tue 18:00 · Field 3/);
      assert.match(page, /Thu 18:00 · Field 3/);

      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /href="\/app\/sessions\/\d+"/);
      assert.match(schedule, /class="coach-nav"/);
      assert.match(schedule, /0\/2 ·/);

      const removeRes = await fetch(`${base}/app/session-types/${seed.sessionTypeId}/slots/${slots.rows[0].id}/remove`, {
        method: 'POST',
        headers: { cookie },
        redirect: 'manual',
      });
      assert.equal(removeRes.status, 303);
      const active = await db.query<{ id: number }>('select id from weekly_slot where session_type_id = $1 and active', [
        seed.sessionTypeId,
      ]);
      assert.equal(active.rows.length, 1);

      const empty = await fetch(`${base}/app/session-types/${seed.sessionTypeId}/generate-week`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({}),
      });
      assert.equal(empty.status, 422);
    });
  });
});
