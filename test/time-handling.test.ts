import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createWeeklySlots, ensureSlotSessions, zonedParts, zonedTimeToUtc } from '../src/domain/scheduling.js';
import { formatConfirmWhen, formatLocal, formatTimeRange, NOT_A_TIME } from '../src/lib/time.js';
import type { DbClient } from '../src/db/client.js';

/** Clock times on the days the clocks change, and weekly times that are
 * added more than once. */

async function slotStarts(db: DbClient, typeId: number): Promise<Date[]> {
  const r = await db.query<{ starts_at_utc: string }>(
    'select starts_at_utc from session where session_type_id = $1 and weekly_slot_id is not null order by starts_at_utc',
    [typeId],
  );
  return r.rows.map((row) => new Date(row.starts_at_utc));
}

test('a clock time on the day the clocks change is that clock time', () => {
  const cases: Array<[string, number, number, number, number, string]> = [
    // Spring: Los Angeles moves to daylight time at 2am on Sunday March 14, 2027.
    ['America/Los_Angeles', 2027, 3, 14, 9, '2027-03-14T16:00:00.000Z'],
    ['America/Los_Angeles', 2027, 3, 14, 1, '2027-03-14T09:00:00.000Z'],
    // Fall: Chicago goes back to standard time at 2am on Sunday November 1, 2026.
    ['America/Chicago', 2026, 11, 1, 6, '2026-11-01T12:00:00.000Z'],
    ['America/Chicago', 2026, 11, 1, 0, '2026-11-01T05:00:00.000Z'],
    // Ordinary evenings either side.
    ['America/Chicago', 2026, 10, 27, 18, '2026-10-27T23:00:00.000Z'],
    ['America/Chicago', 2026, 11, 3, 18, '2026-11-04T00:00:00.000Z'],
    ['America/Los_Angeles', 2027, 3, 16, 18, '2027-03-17T01:00:00.000Z'],
    // A zone with no daylight time and a half-hour offset.
    ['Asia/Kolkata', 2026, 5, 5, 18, '2026-05-05T12:30:00.000Z'],
  ];
  for (const [tz, y, m, d, h, want] of cases) {
    const got = zonedTimeToUtc(y, m, d, h, 0, tz);
    assert.equal(got.toISOString(), want, `${tz} ${y}-${m}-${d} ${h}:00`);
    assert.equal(zonedParts(got, tz).hour, h, `${tz} ${y}-${m}-${d} reads back as ${h}:00`);
  }
  // 2:30am does not happen in Chicago on March 14, 2027: it reads as 3:30am.
  assert.equal(zonedParts(zonedTimeToUtc(2027, 3, 14, 2, 30, 'America/Chicago'), 'America/Chicago').hour, 3);
  // 1:30am happens twice on November 1, 2026: it reads as the second, in standard time.
  assert.equal(zonedTimeToUtc(2026, 11, 1, 1, 30, 'America/Chicago').toISOString(), '2026-11-01T07:30:00.000Z');
});

test('a Sunday-morning weekly time keeps its clock time on the day the clocks change', async () => {
  const db = await freshDb();
  const la = await seedCoachWithSession(db);
  await createWeeklySlots(db, la.sessionTypeId, 'America/Los_Angeles', [{ weekday: 0, timeLocal: '09:00' }], new Date('2027-03-08T20:00:00Z'));
  const laStarts = await slotStarts(db, la.sessionTypeId);
  assert.ok(laStarts.length >= 8);
  assert.deepEqual([...new Set(laStarts.map((d) => zonedParts(d, 'America/Los_Angeles').hour))], [9]);
  assert.ok(laStarts.some((d) => d.toISOString() === '2027-03-14T16:00:00.000Z'), 'March 14 is at 9am daylight time');

  const chi = await seedCoachWithSession(db);
  await createWeeklySlots(db, chi.sessionTypeId, 'America/Chicago', [{ weekday: 0, timeLocal: '06:00' }], new Date('2026-10-26T20:00:00Z'));
  const chiStarts = await slotStarts(db, chi.sessionTypeId);
  assert.ok(chiStarts.length >= 8);
  assert.deepEqual([...new Set(chiStarts.map((d) => zonedParts(d, 'America/Chicago').hour))], [6]);
});

test('the same weekly time added twice keeps one weekly time and one session a day', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const now = new Date('2026-10-20T15:00:00Z');
  const tz = 'America/Chicago';
  const [first] = await createWeeklySlots(db, seed.sessionTypeId, tz, [{ weekday: 2, timeLocal: '18:00' }], now);
  const again = await createWeeklySlots(
    db,
    seed.sessionTypeId,
    tz,
    [
      { weekday: 2, timeLocal: '18:00' },
      { weekday: 2, timeLocal: '18:00' },
    ],
    now,
  );
  assert.deepEqual(
    again.map((s) => s.id),
    [first.id],
    'the weekly time already there is the one returned',
  );
  const slots = await db.query<{ n: string }>('select count(*)::text as n from weekly_slot where session_type_id = $1', [seed.sessionTypeId]);
  assert.equal(slots.rows[0].n, '1');
  const starts = await slotStarts(db, seed.sessionTypeId);
  assert.equal(starts.length, new Set(starts.map((d) => d.toISOString())).size, 'no two sessions share a start');

  // A day that already has this weekly time's session, even at another hour
  // (one written before a clock-change fix, say), gets no second session.
  const tuesday = starts[1];
  await db.query('update session set starts_at_utc = $1 where weekly_slot_id = $2 and starts_at_utc = $3', [
    new Date(tuesday.getTime() + 60 * 60 * 1000).toISOString(),
    first.id,
    tuesday.toISOString(),
  ]);
  assert.equal(await ensureSlotSessions(db, first, tz, now), 0);
  assert.equal((await slotStarts(db, seed.sessionTypeId)).length, starts.length);
});

test('a value that is not a date is worded as an unknown time instead of throwing', () => {
  for (const value of ['banana', '', '2026-13-45T99:00:00Z']) {
    assert.equal(formatLocal(value, 'America/Chicago'), NOT_A_TIME, value);
    assert.equal(formatConfirmWhen(value, 'America/Chicago'), NOT_A_TIME, value);
    assert.equal(formatTimeRange(value, 60, 'America/Chicago'), NOT_A_TIME, value);
  }
  assert.equal(formatConfirmWhen('2026-11-03T00:00:00.000Z', 'America/Chicago'), 'Mon Nov 2, 6:00pm');
});
