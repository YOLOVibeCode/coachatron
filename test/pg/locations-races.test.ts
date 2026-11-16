import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry, type SeededSession } from '../helpers/fixtures.js';
import {
  addLocation,
  listLocations,
  removeLocation,
  renameLocation,
  resolveTypedPlace,
  type SavedLocation,
} from '../../src/domain/locations.js';
import { changeSessionLocation } from '../../src/domain/sessionLocation.js';
import { createWeeklySlots, topUpAllSlots } from '../../src/domain/scheduling.js';
import { acceptOffer, checkOverflow, startCascade } from '../../src/domain/cascade.js';
import type { DbClient } from '../../src/db/client.js';

/** Saved locations with two things happening at the same moment, on real
 * Postgres (TEST_DATABASE_URL; skipped without it). As in races.test.ts,
 * the first is held still right after a chosen statement with its locks
 * held, the second is started, and the first goes on only once the second
 * is waiting on a lock (or has finished without one). */

const RACE = { skip: skipWithoutPostgres, timeout: 60_000 };
const TZ = 'America/Chicago';
// Tuesday Oct 20 2026, 7am in Chicago.
const NOW = new Date('2026-10-20T12:00:00Z');

let race: RaceDb | null = null;
const db = (): DbClient => {
  assert.ok(race, 'the race database is set up');
  return race.db;
};

before(async () => {
  if (!skipWithoutPostgres) race = await raceDb();
});
after(async () => {
  await race?.close();
});

async function saved(seed: SeededSession, name: string, client: DbClient = db()): Promise<SavedLocation> {
  const result = await addLocation(client, seed.coach.id, seed.sessionTypeId, name, null);
  assert.equal(result.kind, 'added', `${name} was added`);
  return (result as { location: SavedLocation }).location;
}

test('a fifth location from the edit form and a new place typed for a weekly time at once: five are saved, never six', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  for (const name of ['A', 'B', 'C', 'D']) await saved(seed, name);

  // The form's add holds the session type and has not counted yet.
  const first = pauseAfter(db(), (sql) => sql.includes('for no key update'));
  const a = settle(addLocation(first.db, seed.coach.id, seed.sessionTypeId, 'Fifth', null));
  await first.reached;
  const b = settle(resolveTypedPlace(db(), seed.sessionTypeId, 'Also Fifth'));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting', 'the typed place waited for the add to finish');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.equal(ra.value.kind, 'added');
  assert.deepEqual(rb.value, { locationId: null, text: 'Also Fifth', overLimit: true }, 'the place that came second stays its own words');
  assert.deepEqual((await listLocations(db(), seed.sessionTypeId)).map((l) => l.name), ['A', 'B', 'C', 'D', 'Fifth']);
});

test('the same new place typed for two weekly times at once is saved once, and both use it', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  const first = pauseAfter(db(), (sql) => sql.includes('for no key update'));
  const a = settle(resolveTypedPlace(first.db, seed.sessionTypeId, 'Field 3'));
  await first.reached;
  const b = settle(resolveTypedPlace(db(), seed.sessionTypeId, 'field  3'));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.deepEqual(rb.value, ra.value);
  assert.deepEqual((await listLocations(db(), seed.sessionTypeId)).map((l) => l.name), ['Field 3']);
});

test('a rename while the tick adds the next session of a weekly time: the new session says the new name', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  const field3 = await saved(seed, 'Field 3');
  const [slot] = await createWeeklySlots(db(), seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00', locationId: field3.id }], NOW);
  const before = (await db().query('select id from session where weekly_slot_id = $1', [slot.id])).rows.length;

  // The rename has rewritten the weekly time and not yet its sessions.
  const first = pauseAfter(db(), (sql) => sql.includes('update weekly_slot set location_text'));
  const a = settle(renameLocation(first.db, seed.coach.id, seed.sessionTypeId, field3.id, 'Riverside Park', '120 River Rd', NOW));
  await first.reached;
  // A week on, the tick adds one more session from that weekly time.
  const weekLater = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  const b = settle(topUpAllSlots(db(), weekLater));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting', 'the new session waited for the rename');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.equal(ra.value.kind, 'renamed');

  const sessions = await db().query<{ location_text: string; location_address: string | null }>(
    'select location_text, location_address from session where weekly_slot_id = $1 order by starts_at_utc',
    [slot.id],
  );
  assert.equal(sessions.rows.length, before + 1, 'the tick added its session');
  for (const s of sessions.rows) {
    assert.deepEqual(s, { location_text: 'Riverside Park', location_address: '120 River Rd' }, 'no session is left saying the old name');
  }
});

test('removing a location while a weekly time is added with it: the removal stands and the weekly time is saved with no place', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  const field3 = await saved(seed, 'Field 3');

  // The removal has looked for weekly times that use it, and found none.
  const first = pauseAfter(db(), (sql) => sql.includes('from weekly_slot where location_id'));
  const a = settle(removeLocation(first.db, seed.coach.id, seed.sessionTypeId, field3.id));
  await first.reached;
  const b = settle(createWeeklySlots(db(), seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00', locationId: field3.id }], NOW));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting', 'the weekly time waited for the removal');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.equal(ra.value.kind, 'removed');
  assert.deepEqual(await listLocations(db(), seed.sessionTypeId), []);
  const slots = await db().query<{ location_text: string | null; location_id: number | null }>(
    'select location_text, location_id from weekly_slot where session_type_id = $1',
    [seed.sessionTypeId],
  );
  assert.deepEqual(slots.rows, [{ location_text: null, location_id: null }], 'no weekly time points at a removed location');
  const placed = await db().query('select 1 from session where session_type_id = $1 and location_id is not null', [seed.sessionTypeId]);
  assert.equal(placed.rows.length, 0);
});

test('one session moved to a location while that location is renamed: the session says the new name', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  await saved(seed, 'Field 3');
  const gym = await saved(seed, 'Gym');

  // The rename has written everything and not yet committed.
  const first = pauseAfter(db(), (sql) => sql.includes('update session set location_text = $2, location_address = $3'));
  const a = settle(renameLocation(first.db, seed.coach.id, seed.sessionTypeId, gym.id, 'Main Gym', '1 School Rd'));
  await first.reached;
  const b = settle(changeSessionLocation(db(), seed.coach.id, seed.sessionId, gym.id));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting', 'the move waited for the rename');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.equal(rb.value.kind, 'changed');
  const session = await db().query<{ location_text: string; location_address: string | null; location_id: number }>(
    'select location_text, location_address, location_id from session where id = $1',
    [seed.sessionId],
  );
  assert.deepEqual(session.rows[0], { location_text: 'Main Gym', location_address: '1 School Rd', location_id: gym.id });
});

test('a second group opened while its location is renamed: neither waits on the other for good, and both sessions say the new name', RACE, async () => {
  await withRelay(async () => {
    // A full session at the gym with someone waiting, and a second group offered.
    const seed = await seedCoachWithSession(db(), { capacity: 1 });
    const gym = await saved(seed, 'Gym');
    assert.equal((await changeSessionLocation(db(), seed.coach.id, seed.sessionId, gym.id)).kind, 'changed');
    const member = await seedRosterMember(db(), seed.coach.id, 'Sam Backup', 0);
    await seedBookedSession(db(), seed.sessionId, 'Ada Lane', '+15550009301');
    await seedWaitlistEntry(db(), seed.sessionId, 'Bo Lane', '+15550009302');
    await checkOverflow(db(), seed.sessionId);
    await startCascade(db(), seed.sessionId, 'second_group');
    const offer = await db().query<{ id: number }>('select id from offer where session_id = $1 and roster_member_id = $2', [seed.sessionId, member.id]);

    // The accept has written the second group, copied from the full session
    // as it read it, and has not committed.
    const accepting = pauseAfter(db(), (sql) => sql.includes('from session full_one'));
    const accepted = settle(acceptOffer(accepting.db, offer.rows[0].id));
    await accepting.reached;
    const rename = settle(renameLocation(db(), seed.coach.id, seed.sessionTypeId, gym.id, 'Main Gym', '1 School Rd'));
    const renaming = await untilWaitingOrDone(db(), rename).finally(accepting.release);
    const [ra, rr] = await Promise.all([accepted, rename]);
    assert.equal(renaming, 'waiting', 'the rename waited for the full session the accept held');
    assert.ok(ra.ok && rr.ok, 'neither failed');
    assert.equal(ra.value, true, 'the member took the job');
    assert.equal(rr.value.kind, 'renamed');

    const sessions = await db().query<{ location_text: string; location_address: string | null }>(
      'select location_text, location_address from session where id = $1 or overflow_of = $1 order by id',
      [seed.sessionId],
    );
    assert.deepEqual(sessions.rows, [
      { location_text: 'Main Gym', location_address: '1 School Rd' },
      { location_text: 'Main Gym', location_address: '1 School Rd' },
    ]);
  });
});
