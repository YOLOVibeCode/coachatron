import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { fakeComplete } from './fakes/llm.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { runMigrations } from '../src/db/migrate.js';
import { handleCoachMessage } from '../src/domain/assistant.js';
import { addLocation, listLocations, renameLocation, type SavedLocation } from '../src/domain/locations.js';
import { addCalendarDays, topUpAllSlots, zonedParts, zonedTimeToUtc } from '../src/domain/scheduling.js';
import type { DbClient } from '../src/db/client.js';

/** Saved locations and the data that was there first: what migration 0034
 * makes of weekly times that already had a typed place, and what the text
 * assistant writes when it adds or moves one session with a place. */

const MIGRATION = '0034_session_locations.sql';
const TZ = 'America/Chicago';
// Tuesday Oct 20 2026, 7am in Chicago.
const NOW = new Date('2026-10-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;

async function newType(db: DbClient, coachId: number, name: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active) values ($1, $2, 60, 4, 3500, true) returning id`,
    [coachId, name],
  );
  return result.rows[0].id;
}

/** A weekly time as it was written before locations were saved: its place
 * in words, and no link. */
async function legacySlot(db: DbClient, typeId: number, weekday: number, place: string | null, active = true): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into weekly_slot (session_type_id, weekday, time_local, location_text, active) values ($1, $2, '18:00', $3, $4) returning id`,
    [typeId, weekday, place, active],
  );
  return result.rows[0].id;
}

async function legacySession(
  db: DbClient,
  typeId: number,
  hoursFromNow: number,
  place: string | null,
  from: { slotId?: number; overflowOf?: number } = {},
): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status, location_text, weekly_slot_id, overflow_of)
     values ($1, $2, $3, 'scheduled', $4, $5, $6) returning id`,
    [typeId, new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString(), TZ, place, from.slotId ?? null, from.overflowOf ?? null],
  );
  return result.rows[0].id;
}

async function runAgain(db: DbClient): Promise<void> {
  await db.query('delete from schema_migrations where name = $1', [MIGRATION]);
  await runMigrations(db);
}

async function slotPlace(db: DbClient, id: number): Promise<[string | null, number | null]> {
  const row = (await db.query<{ location_text: string | null; location_id: number | null }>('select location_text, location_id from weekly_slot where id = $1', [id])).rows[0];
  return [row.location_text, row.location_id];
}

async function sessionPlace(db: DbClient, id: number): Promise<[string | null, number | null, string | null]> {
  const row = (
    await db.query<{ location_text: string | null; location_id: number | null; location_address: string | null }>(
      'select location_text, location_id, location_address from session where id = $1',
      [id],
    )
  ).rows[0];
  return [row.location_text, row.location_id, row.location_address];
}

test('the migration turns each distinct place on a type\'s weekly times into a saved location and links the weekly times and their sessions to it', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const group = seed.sessionTypeId;
  const privates = await newType(db, seed.coach.id, 'Privates');
  const camps = await newType(db, seed.coach.id, 'Camps');
  const bare = await newType(db, seed.coach.id, 'Open play');

  // The group: one place spelled three ways, a second place, and times with none.
  const tue = await legacySlot(db, group, 2, 'Field 3');
  const wed = await legacySlot(db, group, 3, 'field  3 ');
  const thu = await legacySlot(db, group, 4, 'FIELD 3');
  const fri = await legacySlot(db, group, 5, 'Riverside Park');
  const sat = await legacySlot(db, group, 6, null);
  const sun = await legacySlot(db, group, 0, '   ');
  // A weekly time the coach removed long ago, with a place nothing else uses.
  const removed = await legacySlot(db, group, 1, 'Old Gym', false);
  // Privates happen at a place of the same name, and camps at six places.
  const privateTue = await legacySlot(db, privates, 2, 'Field 3');
  const campPlaces = ['Lot A', 'Lot B', 'Lot C', 'Lot D', 'Lot E', 'Lot F'];
  const campSlots: number[] = [];
  for (const [i, place] of campPlaces.entries()) campSlots.push(await legacySlot(db, camps, i, place));
  await legacySlot(db, bare, 2, null);

  // Sessions already on the calendar: past and upcoming, one whose words the
  // coach changed by text, one written the other way, and a second group.
  const tuePast = await legacySession(db, group, -7 * 24, 'Field 3', { slotId: tue });
  const tueNext = await legacySession(db, group, 11, 'Field 3', { slotId: tue });
  const tueElsewhere = await legacySession(db, group, 7 * 24 + 11, 'High school gym', { slotId: tue });
  const wedNext = await legacySession(db, group, 35, 'field  3 ', { slotId: wed });
  const secondGroup = await legacySession(db, group, 11, 'Field 3', { overflowOf: tueNext });
  const satNext = await legacySession(db, group, 4 * 24, null, { slotId: sat });
  const oneOff = await legacySession(db, group, 30, 'Field 3');
  const removedNext = await legacySession(db, group, 6 * 24, 'Old Gym', { slotId: removed });
  const privateNext = await legacySession(db, privates, 11, 'Field 3', { slotId: privateTue });

  await runAgain(db);

  // One saved location per distinct place, spelled as the oldest weekly time wrote it.
  const groupPlaces = await listLocations(db, group);
  assert.deepEqual(groupPlaces.map((l) => [l.name, l.address]), [
    ['Field 3', null],
    ['Riverside Park', null],
  ]);
  const [field3, park] = groupPlaces;
  const privatePlaces = await listLocations(db, privates);
  assert.deepEqual(privatePlaces.map((l) => l.name), ['Field 3']);
  assert.notEqual(privatePlaces[0].id, field3.id, 'each type has its own');
  // More than five are all kept.
  assert.deepEqual((await listLocations(db, camps)).map((l) => l.name), campPlaces);
  assert.deepEqual(await listLocations(db, bare), []);

  // Weekly times are linked, and take the one spelling.
  for (const id of [tue, wed, thu]) assert.deepEqual(await slotPlace(db, id), ['Field 3', field3.id]);
  assert.deepEqual(await slotPlace(db, fri), ['Riverside Park', park.id]);
  assert.deepEqual(await slotPlace(db, sat), [null, null]);
  assert.deepEqual(await slotPlace(db, sun), ['   ', null], 'a blank place is no place');
  assert.deepEqual(await slotPlace(db, removed), ['Old Gym', null], 'a removed weekly time is left alone');
  assert.deepEqual(await slotPlace(db, privateTue), ['Field 3', privatePlaces[0].id]);
  for (const [i, id] of campSlots.entries()) assert.equal((await slotPlace(db, id))[0], campPlaces[i]);

  // Sessions keep their own words; the ones that say their weekly time's place are linked.
  assert.deepEqual(await sessionPlace(db, tuePast), ['Field 3', field3.id, null]);
  assert.deepEqual(await sessionPlace(db, tueNext), ['Field 3', field3.id, null]);
  assert.deepEqual(await sessionPlace(db, wedNext), ['field  3 ', field3.id, null]);
  assert.deepEqual(await sessionPlace(db, secondGroup), ['Field 3', field3.id, null], 'a second group, like the session it was opened for');
  assert.deepEqual(await sessionPlace(db, tueElsewhere), ['High school gym', null, null], 'moved by text: its own words');
  assert.deepEqual(await sessionPlace(db, satNext), [null, null, null]);
  assert.deepEqual(await sessionPlace(db, oneOff), ['Field 3', null, null], 'a session from no weekly time is not linked');
  assert.deepEqual(await sessionPlace(db, removedNext), ['Old Gym', null, null]);
  assert.deepEqual(await sessionPlace(db, privateNext), ['Field 3', privatePlaces[0].id, null]);

  // The limit is for adding: the type with six takes no more, the others do.
  assert.equal((await addLocation(db, seed.coach.id, camps, 'Lot G', null)).kind, 'full');
  assert.equal((await addLocation(db, seed.coach.id, group, 'Gym', null)).kind, 'added');

  // Running it again adds nothing and changes nothing.
  await runAgain(db);
  assert.deepEqual((await listLocations(db, group)).map((l) => l.name), ['Field 3', 'Riverside Park', 'Gym']);
  assert.equal((await listLocations(db, camps)).length, 6);
  assert.equal((await listLocations(db, privates)).length, 1);
  assert.deepEqual(await slotPlace(db, removed), ['Old Gym', null]);

  // From here the old weekly times behave like new ones: a rename reaches
  // them and their upcoming sessions, whatever the spelling was, and new
  // sessions carry the place.
  const renamed = await renameLocation(db, seed.coach.id, group, field3.id, 'North Field', '9 Park Rd', NOW);
  assert.deepEqual(renamed.kind === 'renamed' && [renamed.weeklyTimes, renamed.sessions], [3, 3]);
  assert.deepEqual(await sessionPlace(db, tuePast), ['Field 3', field3.id, null], 'last week keeps what it said');
  assert.deepEqual(await sessionPlace(db, tueNext), ['North Field', field3.id, '9 Park Rd']);
  assert.deepEqual(await sessionPlace(db, wedNext), ['North Field', field3.id, '9 Park Rd']);
  assert.deepEqual(await sessionPlace(db, secondGroup), ['North Field', field3.id, '9 Park Rd']);
  assert.deepEqual(await sessionPlace(db, tueElsewhere), ['High school gym', null, null]);
  assert.deepEqual(await sessionPlace(db, privateNext), ['Field 3', privatePlaces[0].id, null], 'the other type is untouched');
  await topUpAllSlots(db, NOW);
  const made = await db.query<{ location_text: string; location_address: string | null }>(
    'select distinct location_text, location_address from session where weekly_slot_id = $1 and starts_at_utc > $2',
    [thu, NOW.toISOString()],
  );
  assert.deepEqual(made.rows, [{ location_text: 'North Field', location_address: '9 Park Rd' }]);
});

test('a database with no weekly times, or none with a place, migrates to no saved locations', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await legacySlot(db, seed.sessionTypeId, 2, null);
  await runAgain(db);
  assert.equal((await db.query('select 1 from session_type_location')).rows.length, 0);
});

// ---- The text assistant, one session at a time ----

function tomorrowAt(tz: string, hour: number): Date {
  const p = zonedParts(new Date(), tz);
  const d = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedTimeToUtc(d.year, d.month, d.day, hour, 0, tz);
}

function intent(over: Record<string, unknown>) {
  return {
    confidence: 0.95,
    session_id: null,
    session_type_id: null,
    session_type: null,
    when: null,
    new_when: null,
    location: null,
    reason: null,
    source: 'model',
    ...over,
  };
}

test("a session the coach adds or moves by text takes a saved location when the words match one, and keeps its own words when they do not", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
    const added = await addLocation(db, seed.coach.id, seed.sessionTypeId, 'Riverside Park', '120 River Rd');
    const park = (added as { location: SavedLocation }).location;
    const say = async (model: Record<string, unknown>, text: string) => {
      setComplete(fakeComplete(model));
      try {
        assert.equal((await handleCoachMessage(db, seed.coach, text, 'sms')).kind, 'confirm');
        assert.equal((await handleCoachMessage(db, seed.coach, 'Y', 'sms')).kind, 'done');
      } finally {
        resetComplete();
      }
    };
    const newest = async () => (await db.query<{ id: number }>('select id from session order by id desc limit 1')).rows[0].id;

    // Added at a saved location, said loosely.
    await say(
      intent({ intent: 'session.add', session_type_id: seed.sessionTypeId, when: tomorrowAt(seed.coach.tz, 9).toISOString(), location: ' riverside  PARK ' }),
      'add a group tomorrow at 9 at riverside park',
    );
    assert.deepEqual(await sessionPlace(db, await newest()), ['Riverside Park', park.id, '120 River Rd']);

    // Added somewhere that is not saved: its own words, and nothing joins the list.
    await say(
      intent({ intent: 'session.add', session_type_id: seed.sessionTypeId, when: tomorrowAt(seed.coach.tz, 11).toISOString(), location: 'South field' }),
      'add a group tomorrow at 11 on the south field',
    );
    assert.deepEqual(await sessionPlace(db, await newest()), ['South field', null, null]);
    assert.deepEqual((await listLocations(db, seed.sessionTypeId)).map((l) => l.name), ['Riverside Park']);

    // Moved with no place said: it keeps the one it has.
    await db.query("update session set location_text = 'Riverside Park', location_id = $2, location_address = '120 River Rd' where id = $1", [
      seed.sessionId,
      park.id,
    ]);
    await say(intent({ intent: 'session.move', session_id: seed.sessionId, new_when: tomorrowAt(seed.coach.tz, 19).toISOString() }), 'move the 6pm to 7pm');
    assert.deepEqual(await sessionPlace(db, seed.sessionId), ['Riverside Park', park.id, '120 River Rd']);

    // Moved to a place that is not saved: the words change, and the link and the address line go with them.
    await say(
      intent({ intent: 'session.move', session_id: seed.sessionId, new_when: tomorrowAt(seed.coach.tz, 20).toISOString(), location: 'High school gym' }),
      'move the 7pm to 8pm at the high school gym',
    );
    assert.deepEqual(await sessionPlace(db, seed.sessionId), ['High school gym', null, null]);
    // So a later rename of the saved location does not write over it.
    const renamed = await renameLocation(db, seed.coach.id, seed.sessionTypeId, park.id, 'River Park', null);
    assert.equal(renamed.kind, 'renamed');
    assert.deepEqual(await sessionPlace(db, seed.sessionId), ['High school gym', null, null]);

    // Moved back to the saved one by name.
    await say(
      intent({ intent: 'session.move', session_id: seed.sessionId, new_when: tomorrowAt(seed.coach.tz, 21).toISOString(), location: 'river park' }),
      'move the 8pm to 9pm at river park',
    );
    assert.deepEqual(await sessionPlace(db, seed.sessionId), ['River Park', park.id, null]);
  });
});
