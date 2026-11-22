import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { zoneAt } from './helpers/clock.js';
import { seedBookedSession, seedCoachWithSession, type SeededSession } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { bookOnline, latestBooking, postCheckout } from './helpers/booking.js';
import { fakeComplete } from './fakes/llm.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createWeeklySlots, deactivateSlot, topUpAllSlots, zonedParts } from '../src/domain/scheduling.js';
import {
  LOCATION_LIMITS,
  addLocation,
  listLocations,
  removeLocation,
  renameLocation,
  resolveTypedPlace,
  type SavedLocation,
} from '../src/domain/locations.js';
import { changeSessionLocation, placeChangeText } from '../src/domain/sessionLocation.js';
import { handleSetupMessage, publishSetupPlan } from '../src/domain/setup.js';
import { acceptOffer, checkOverflow, startCascade } from '../src/domain/cascade.js';
import { segmentCount } from '../src/domain/outbound.js';
import { sendDueReminders } from '../src/jobs/tick.js';
import type { DbClient } from '../src/db/client.js';

/** A session type's saved locations (SPEC.md §8.2): the list on the edit
 * form, the weekly time that picks one, the session that carries its words,
 * and what a rename, a removal and a one-session move do. Times here are
 * fixed or counted from the session itself, never read off today's date. */

const TZ = 'America/Chicago';
// Tuesday Oct 20 2026, 7am in Chicago.
const NOW = new Date('2026-10-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const json = { 'content-type': 'application/json' };

async function signIn(db: DbClient, coachId: number): Promise<string> {
  return `cx_session=${await createCoachSession(db, coachId)}`;
}

function as(base: string, cookie: string) {
  return {
    post: (path: string, body: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body), redirect: 'manual' }),
    page: async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text(),
  };
}

async function saved(db: DbClient, seed: SeededSession, name: string, address: string | null = null): Promise<SavedLocation> {
  const result = await addLocation(db, seed.coach.id, seed.sessionTypeId, name, address);
  assert.equal(result.kind, 'added', `${name} was added`);
  return (result as { location: SavedLocation }).location;
}

async function secondType(db: DbClient, coachId: number, name: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active) values ($1, $2, 60, 4, 3500, true) returning id`,
    [coachId, name],
  );
  return result.rows[0].id;
}

interface PlacedSession {
  id: number;
  location_text: string | null;
  location_id: number | null;
  location_address: string | null;
}

async function sessionRow(db: DbClient, id: number): Promise<PlacedSession> {
  const result = await db.query<PlacedSession>('select id, location_text, location_id, location_address from session where id = $1', [id]);
  return result.rows[0];
}

async function slotSessions(db: DbClient, slotId: number): Promise<PlacedSession[]> {
  const result = await db.query<PlacedSession>(
    'select id, location_text, location_id, location_address from session where weekly_slot_id = $1 order by starts_at_utc',
    [slotId],
  );
  return result.rows;
}

/** A session of the type at a fixed distance from NOW, placed as given. */
async function sessionAt(
  db: DbClient,
  typeId: number,
  hoursFromNow: number,
  place: { text: string | null; locationId?: number | null; slotId?: number | null } = { text: null },
): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status, location_text, location_id, weekly_slot_id)
     values ($1, $2, $3, 'scheduled', $4, $5, $6) returning id`,
    [typeId, new Date(NOW.getTime() + hoursFromNow * HOUR).toISOString(), TZ, place.text, place.locationId ?? null, place.slotId ?? null],
  );
  return result.rows[0].id;
}

// ---- 1. Saved locations on the Session types edit form ----

test('the edit form adds, renames and removes saved locations, up to five, each with a name and an optional address line', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const other = await seedCoachWithSession(db);
    const cookie = await signIn(db, seed.coach.id);
    const edit = `/app/session-types/${seed.sessionTypeId}/edit`;
    const locations = `/app/session-types/${seed.sessionTypeId}/locations`;
    await withServer(async (base) => {
      const coach = as(base, cookie);

      const first = await fetch(`${base}${edit}`, { headers: { cookie } });
      assert.equal(first.headers.get('cache-control'), 'no-store');
      const empty = await first.text();
      assert.match(empty, /<h2 id="locations">Locations<\/h2>/);
      assert.match(empty, /<label for="location-name-new">New location<\/label>/);
      assert.match(empty, /<input id="location-name-new" name="name" required maxlength="60"/);
      assert.match(empty, /<input id="location-address-new" name="address" maxlength="120"/);
      assert.match(empty, /<button type="submit" class="ghost">Add location<\/button>/);

      // Added, with extra spaces tidied.
      const added = await coach.post(locations, { name: '  Riverside   Park ', address: ' 120 River Rd ' });
      assert.equal(added.status, 303);
      assert.equal(added.headers.get('location'), `${edit}?loc=added#locations`);
      const [park] = await listLocations(db, seed.sessionTypeId);
      assert.deepEqual({ name: park.name, address: park.address }, { name: 'Riverside Park', address: '120 River Rd' });
      const withOne = await coach.page(`${edit}?loc=added`);
      assert.match(withOne, /Location added\./);
      assert.match(withOne, new RegExp(`<input id="location-name-${park.id}" name="name" required maxlength="60" value="Riverside Park" />`));
      assert.match(withOne, new RegExp(`<input id="location-address-${park.id}" name="address" maxlength="120" value="120 River Rd" />`));

      // The same name again, whatever the capitals, adds nothing.
      const again = await coach.post(locations, { name: 'riverside park' });
      assert.equal(again.headers.get('location'), `${edit}?loc=have#locations`);
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, 1);

      // What a name and an address line take.
      for (const [body, message] of [
        [{ name: '   ' }, /Give the location a name\./],
        [{ name: 'x'.repeat(61) }, /A location name is up to 60 characters\./],
        [{ name: 'Gym', address: 'y'.repeat(121) }, /An address line is up to 120 characters\./],
      ] as const) {
        const refused = await coach.post(locations, body);
        assert.equal(refused.status, 422);
        assert.match(await refused.text(), message);
      }
      assert.equal((await coach.post(locations, { name: 'x'.repeat(60), address: 'y'.repeat(120) })).status, 303, 'the longest that fit');

      // Five is the most.
      for (const name of ['Field 3', 'Field 4', 'Gym']) assert.equal((await coach.post(locations, { name })).status, 303);
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, LOCATION_LIMITS.perType);
      const sixth = await coach.post(locations, { name: 'Field 9' });
      assert.equal(sixth.status, 422);
      assert.match(await sixth.text(), /A session type keeps up to 5 saved locations\. Remove one to add Field 9\./);
      const full = await coach.page(edit);
      assert.match(full, /That is as many as a session type keeps\. Remove one to add another\./);
      assert.doesNotMatch(full, /location-name-new/);

      // Renamed: the name, or just the address line.
      const renamed = await coach.post(`${locations}/${park.id}`, { name: 'North Park', address: '' });
      assert.equal(renamed.headers.get('location'), `${edit}?loc=saved.0.0#locations`);
      assert.match(await coach.page(`${edit}?loc=saved.0.0`), /Location saved\./);
      const taken = await coach.post(`${locations}/${park.id}`, { name: 'field 3' });
      assert.equal(taken.status, 422);
      assert.match(await taken.text(), /This session type already has a location called field 3\./);
      assert.equal((await coach.post(`${locations}/${park.id}`, { name: 'x'.repeat(61) })).status, 422);
      assert.deepEqual(
        (await listLocations(db, seed.sessionTypeId)).find((l) => l.id === park.id),
        { id: park.id, session_type_id: seed.sessionTypeId, name: 'North Park', address: null },
      );

      // Removed, which makes room for another.
      const removed = await coach.post(`${locations}/${park.id}/remove`);
      assert.equal(removed.headers.get('location'), `${edit}?loc=removed#locations`);
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, 4);
      assert.doesNotMatch(await coach.page(edit), /North Park/);
      assert.equal((await coach.post(locations, { name: 'Field 9' })).status, 303);

      // Only the coach whose session type it is.
      const stranger = as(base, await signIn(db, other.coach.id));
      const [field3] = await listLocations(db, seed.sessionTypeId);
      assert.equal((await stranger.post(locations, { name: 'Theirs' })).status, 404);
      assert.equal((await stranger.post(`${locations}/${field3.id}`, { name: 'Theirs' })).status, 404);
      assert.equal((await stranger.post(`${locations}/${field3.id}/remove`)).status, 404);
      assert.equal((await coach.post(`${locations}/abc`, { name: 'Gym 2' })).status, 404);
      assert.equal((await coach.post(`${locations}/99999/remove`)).status, 404);
      const signedOut = await fetch(`${base}${locations}`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Gym 2' }), redirect: 'manual' });
      assert.equal(signedOut.headers.get('location'), '/signin');
      assert.ok(!(await listLocations(db, seed.sessionTypeId)).some((l) => l.name === 'Theirs' || l.name === 'Gym 2'));
    });
  });
});

// ---- 2 and 3. A weekly time picks one, and its sessions carry the words ----

test("a weekly time picks one of its type's saved locations, or none, and each session carries that place", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const park = await saved(db, seed, 'Riverside Park', '120 River Rd');
    await saved(db, seed, 'Field 3');
    const elsewhere = await addLocation(db, seed.coach.id, await secondType(db, seed.coach.id, 'Privates'), 'Gym', null);
    assert.equal(elsewhere.kind, 'added');
    const cookie = await signIn(db, seed.coach.id);
    const weekly = `/app/session-types/${seed.sessionTypeId}/generate-week`;
    await withServer(async (base) => {
      const coach = as(base, cookie);
      const form = await coach.page(weekly);
      assert.match(form, /<label for="location_id">Where \(optional\)<\/label>/);
      assert.match(form, /<select id="location_id" name="location_id">\s*<option value="">No location<\/option>/);
      assert.match(form, new RegExp(`<option value="${park.id}">Riverside Park, 120 River Rd</option>`));
      assert.match(form, /<option value="\d+">Field 3<\/option>/);
      assert.doesNotMatch(form, />Gym</, "another type's location is not offered");
      assert.match(form, /<label for="location">Or a new place<\/label>/);

      const picked = await coach.post(weekly, { day_2: '1', time_2: '18:00', location_id: String(park.id) });
      assert.equal(picked.headers.get('location'), '/app/schedule');
      const none = await coach.post(weekly, { day_4: '1', time_4: '18:00' });
      assert.equal(none.headers.get('location'), '/app/schedule');

      const slots = await db.query<{ id: number; weekday: number; location_text: string | null; location_id: number | null }>(
        'select id, weekday, location_text, location_id from weekly_slot where session_type_id = $1 order by weekday',
        [seed.sessionTypeId],
      );
      assert.deepEqual(
        slots.rows.map((s) => [s.weekday, s.location_text, s.location_id]),
        [
          [2, 'Riverside Park', park.id],
          [4, null, null],
        ],
      );
      const tuesdays = await slotSessions(db, slots.rows[0].id);
      assert.ok(tuesdays.length >= 8, 'about 8 weeks of Tuesdays');
      for (const s of tuesdays) {
        assert.deepEqual([s.location_text, s.location_id, s.location_address], ['Riverside Park', park.id, '120 River Rd']);
      }
      for (const s of await slotSessions(db, slots.rows[1].id)) {
        assert.deepEqual([s.location_text, s.location_id, s.location_address], [null, null, null]);
      }

      const listed = await coach.page(weekly);
      assert.match(listed, /Tue 6:00pm · Riverside Park/);
      assert.match(listed, /Thu 6:00pm<\/span>/);

      // Only one of this type's own locations, and one place at a time.
      const gym = (elsewhere as { location: SavedLocation }).location;
      for (const body of [
        { day_6: '1', time_6: '09:00', location_id: String(gym.id) },
        { day_6: '1', time_6: '09:00', location_id: 'abc' },
      ]) {
        const refused = await coach.post(weekly, body);
        assert.equal(refused.status, 422);
        assert.match(await refused.text(), /Pick one of this session type&#39;s saved locations\./);
      }
      const both = await coach.post(weekly, { day_6: '1', time_6: '09:00', location_id: String(park.id), location: 'Field 9' });
      assert.equal(both.status, 422);
      assert.match(await both.text(), /Pick a saved location or type a new place, not both\./);
      const long = await coach.post(weekly, { day_6: '1', time_6: '09:00', location: 'x'.repeat(61) });
      assert.equal(long.status, 422);
      assert.match(await long.text(), /A place name is up to 60 characters\./);
      assert.equal(slots.rows.length, 2);
      assert.equal((await db.query('select 1 from weekly_slot where weekday = 6')).rows.length, 0, 'nothing was added by a refused form');
    });
  });
});

// ---- 5. Renaming ----

test('renaming a location updates the weekly times that use it and the sessions that have not started; started and past sessions keep what they said', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const field3 = await saved(db, seed, 'Field 3');
  const gym = await saved(db, seed, 'Gym');
  const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00', locationId: field3.id }], NOW);
  const upcoming = await slotSessions(db, slot.id);
  assert.ok(upcoming.length >= 8);
  // Two sessions of the same weekly time that already began: last week's,
  // and one that started a minute ago.
  const lastWeek = await sessionAt(db, seed.sessionTypeId, -7 * 24, { text: 'Field 3', locationId: field3.id, slotId: slot.id });
  const justStarted = await sessionAt(db, seed.sessionTypeId, -1 / 60, { text: 'Field 3', locationId: field3.id, slotId: slot.id });
  // One upcoming session the coach moved to the gym by itself.
  const moved = await changeSessionLocation(db, seed.coach.id, upcoming[1].id, gym.id, NOW);
  assert.equal(moved.kind, 'changed');

  const renamed = await renameLocation(db, seed.coach.id, seed.sessionTypeId, field3.id, 'Riverside Park', '120 River Rd', NOW);
  assert.equal(renamed.kind, 'renamed');
  assert.deepEqual(
    renamed.kind === 'renamed' && [renamed.weeklyTimes, renamed.sessions],
    [1, upcoming.length - 1],
    'the weekly time and every upcoming session still at that location',
  );

  const slotNow = await db.query<{ location_text: string; location_id: number }>('select location_text, location_id from weekly_slot where id = $1', [slot.id]);
  assert.deepEqual(slotNow.rows[0], { location_text: 'Riverside Park', location_id: field3.id });
  for (const s of upcoming.filter((u) => u.id !== upcoming[1].id)) {
    const now = await sessionRow(db, s.id);
    assert.deepEqual([now.location_text, now.location_address, now.location_id], ['Riverside Park', '120 River Rd', field3.id]);
  }
  for (const id of [lastWeek, justStarted]) {
    const kept = await sessionRow(db, id);
    assert.deepEqual([kept.location_text, kept.location_address], ['Field 3', null], 'a session that has started keeps its words');
  }
  assert.equal((await sessionRow(db, upcoming[1].id)).location_text, 'Gym', 'the session moved elsewhere is not pulled back');

  // The session at the gym follows the gym's own rename.
  const gymRenamed = await renameLocation(db, seed.coach.id, seed.sessionTypeId, gym.id, 'Main Gym', null, NOW);
  assert.deepEqual(gymRenamed.kind === 'renamed' && [gymRenamed.weeklyTimes, gymRenamed.sessions], [0, 1]);
  assert.equal((await sessionRow(db, upcoming[1].id)).location_text, 'Main Gym');

  // New sessions from the weekly time say the new words.
  await topUpAllSlots(db, new Date(NOW.getTime() + 7 * 24 * HOUR));
  const all = await slotSessions(db, slot.id);
  assert.deepEqual([all[all.length - 1].location_text, all[all.length - 1].location_address], ['Riverside Park', '120 River Rd']);

  // A name another of the type's locations has is refused, and nothing changes.
  assert.equal((await renameLocation(db, seed.coach.id, seed.sessionTypeId, gym.id, 'riverside park', null, NOW)).kind, 'taken');
  assert.equal((await renameLocation(db, seed.coach.id + 999, seed.sessionTypeId, gym.id, 'Theirs', null, NOW)).kind, 'not-found');
  assert.deepEqual((await listLocations(db, seed.sessionTypeId)).map((l) => l.name), ['Riverside Park', 'Main Gym']);
});

test('the edit form says how far a rename reached, and Session detail shows the new words', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const field3 = await saved(db, seed, 'Field 3');
    // A weekday three days off, so none of its sessions starts while this runs.
    const weekday = (zonedParts(new Date(), TZ).weekday + 3) % 7;
    const [slot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday, timeLocal: '18:00', locationId: field3.id }], new Date());
    const sessions = await slotSessions(db, slot.id);
    const cookie = await signIn(db, seed.coach.id);
    await withServer(async (base) => {
      const coach = as(base, cookie);
      const res = await coach.post(`/app/session-types/${seed.sessionTypeId}/locations/${field3.id}`, { name: 'Riverside Park', address: '120 River Rd' });
      const to = res.headers.get('location') ?? '';
      assert.equal(to, `/app/session-types/${seed.sessionTypeId}/edit?loc=saved.1.${sessions.length}#locations`);
      const page = await coach.page(to.replace('#locations', ''));
      assert.ok(page.includes(`Location saved. 1 weekly time and ${sessions.length} upcoming sessions now say it.`), page);
      assert.match(await coach.page(`/app/sessions/${sessions[0].id}`), /<h2 id="where">Where<\/h2>\s*<p>Riverside Park, 120 River Rd<\/p>/);
    });
  });
});

test('two session types with a location of the same name stay independent', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const privates = await secondType(db, seed.coach.id, 'Privates');
  const groupField = await saved(db, seed, 'Field 3', 'North lot');
  const added = await addLocation(db, seed.coach.id, privates, 'Field 3', null);
  assert.equal(added.kind, 'added', 'the same name is free on another type');
  const privateField = (added as { location: SavedLocation }).location;
  assert.notEqual(privateField.id, groupField.id);

  const [groupSlot] = await createWeeklySlots(db, seed.sessionTypeId, TZ, [{ weekday: 2, timeLocal: '18:00', locationId: groupField.id }], NOW);
  const [privateSlot] = await createWeeklySlots(db, privates, TZ, [{ weekday: 2, timeLocal: '18:00', locationId: privateField.id }], NOW);

  await renameLocation(db, seed.coach.id, seed.sessionTypeId, groupField.id, 'Riverside Park', '120 River Rd', NOW);
  for (const s of await slotSessions(db, groupSlot.id)) assert.equal(s.location_text, 'Riverside Park');
  for (const s of await slotSessions(db, privateSlot.id)) {
    assert.deepEqual([s.location_text, s.location_id, s.location_address], ['Field 3', privateField.id, null]);
  }
  assert.deepEqual((await listLocations(db, privates)).map((l) => l.name), ['Field 3']);

  // One type's location cannot be picked, renamed or removed through the other.
  const [crossed] = await createWeeklySlots(db, privates, TZ, [{ weekday: 4, timeLocal: '18:00', locationId: groupField.id }], NOW);
  assert.deepEqual([crossed.location_text, crossed.location_id], [null, null], "another type's location is not taken");
  assert.equal((await renameLocation(db, seed.coach.id, privates, groupField.id, 'Mine', null, NOW)).kind, 'not-found');
  assert.equal((await removeLocation(db, seed.coach.id, privates, groupField.id)).kind, 'not-found');

  // Removing one leaves the other, and each type counts its own five.
  await deactivateSlot(db, seed.coach.id, privateSlot.id, NOW);
  assert.equal((await removeLocation(db, seed.coach.id, privates, privateField.id)).kind, 'removed');
  assert.deepEqual((await listLocations(db, seed.sessionTypeId)).map((l) => l.name), ['Riverside Park']);
  for (const name of ['A', 'B', 'C', 'D', 'E']) assert.equal((await addLocation(db, seed.coach.id, privates, name, null)).kind, 'added');
  assert.equal((await addLocation(db, seed.coach.id, privates, 'F', null)).kind, 'full');
  assert.equal((await addLocation(db, seed.coach.id, seed.sessionTypeId, 'F', null)).kind, 'added');
});

// ---- 6. Removing ----

test('a location weekly times still use is not removed, and the refusal names those times; once free it goes and sessions keep their words', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const field3 = await saved(db, seed, 'Field 3');
    const slots = await createWeeklySlots(
      db,
      seed.sessionTypeId,
      TZ,
      [
        { weekday: 4, timeLocal: '18:00', locationId: field3.id },
        { weekday: 2, timeLocal: '18:00', locationId: field3.id },
      ],
      new Date(),
    );
    // The second Thursday, a week or more off, with someone booked.
    const kept = (await slotSessions(db, slots[0].id))[1];
    await seedBookedSession(db, kept.id, 'Sam Reyes', '+15550000001');
    const cookie = await signIn(db, seed.coach.id);
    const remove = `/app/session-types/${seed.sessionTypeId}/locations/${field3.id}/remove`;
    await withServer(async (base) => {
      const coach = as(base, cookie);
      const refused = await coach.post(remove);
      assert.equal(refused.status, 422);
      const text = await refused.text();
      assert.match(text, /Field 3 is still used by Tue 6:00pm and Thu 6:00pm\. Remove those weekly times first, or rename the location instead\./);
      assert.match(text, new RegExp(`<a class="action" href="/app/session-types/${seed.sessionTypeId}/edit#locations">Back</a>`));
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, 1, 'still saved');

      await deactivateSlot(db, seed.coach.id, slots[1].id, new Date());
      const one = await coach.post(remove);
      assert.equal(one.status, 422);
      assert.match(await one.text(), /Field 3 is still used by Thu 6:00pm\. Remove that weekly time first/);

      await deactivateSlot(db, seed.coach.id, slots[0].id, new Date());
      const gone = await coach.post(remove);
      assert.equal(gone.status, 303);
      assert.deepEqual(await listLocations(db, seed.sessionTypeId), []);
      // The booked session stayed on the calendar, and still says where.
      const after = await db.query<{ status: string; location_text: string }>('select status, location_text from session where id = $1', [kept.id]);
      assert.deepEqual(after.rows[0], { status: 'scheduled', location_text: 'Field 3' });
      assert.match(await coach.page(`/app/sessions/${kept.id}`), /<p>Field 3<\/p>/);
      assert.equal((await coach.post(remove)).status, 404, 'already removed');
    });
  });
});

// ---- 8. A place typed while setting up weekly times ----

test('a typed place uses the saved location it matches, is saved while there is room, and past five stays on that weekly time with the reason shown', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const field3 = await saved(db, seed, 'Field 3', 'North lot');
    const cookie = await signIn(db, seed.coach.id);
    const weekly = `/app/session-types/${seed.sessionTypeId}/generate-week`;
    const slotAt = async (weekday: number) =>
      (
        await db.query<{ id: number; location_text: string | null; location_id: number | null }>(
          'select id, location_text, location_id from weekly_slot where session_type_id = $1 and weekday = $2',
          [seed.sessionTypeId, weekday],
        )
      ).rows[0];
    await withServer(async (base) => {
      const coach = as(base, cookie);

      // Matches a saved one, whatever the capitals and spacing.
      const match = await coach.post(weekly, { day_1: '1', time_1: '17:00', location: '  field   3 ' });
      assert.equal(match.headers.get('location'), '/app/schedule');
      const monday = await slotAt(1);
      assert.deepEqual([monday.location_text, monday.location_id], ['Field 3', field3.id]);
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, 1, 'nothing new was saved');
      for (const s of await slotSessions(db, monday.id)) assert.deepEqual([s.location_text, s.location_address], ['Field 3', 'North lot']);

      // A new place is saved to the type's list.
      assert.equal((await coach.post(weekly, { day_2: '1', time_2: '17:00', location: 'Field 9' })).headers.get('location'), '/app/schedule');
      const tuesday = await slotAt(2);
      const names = (await listLocations(db, seed.sessionTypeId)).map((l) => l.name);
      assert.deepEqual(names, ['Field 3', 'Field 9']);
      assert.equal(tuesday.location_text, 'Field 9');
      assert.ok(tuesday.location_id !== null && tuesday.location_id !== field3.id);

      // With five saved, the form no longer offers a box for a new place...
      for (const name of ['Gym', 'Pool', 'Track']) await saved(db, seed, name);
      const fullForm = await coach.page(weekly);
      assert.doesNotMatch(fullForm, /name="location"/);
      assert.match(fullForm, /This session type has all the saved locations it keeps\./);

      // ...and one sent anyway stays on that weekly time, and the coach is told why.
      const over = await coach.post(weekly, { day_6: '1', time_6: '09:00', location: 'Beach Courts' });
      assert.equal(over.status, 303);
      assert.equal(over.headers.get('location'), weekly, 'back to the weekly times, where the reason is');
      const saturday = await slotAt(6);
      assert.deepEqual([saturday.location_text, saturday.location_id], ['Beach Courts', null]);
      assert.equal((await listLocations(db, seed.sessionTypeId)).length, 5, 'not saved as a sixth');
      for (const s of await slotSessions(db, saturday.id)) assert.deepEqual([s.location_text, s.location_id], ['Beach Courts', null]);
      const told = await coach.page(weekly);
      assert.match(told, /Sat 9:00am · Beach Courts/);
      assert.match(
        told,
        /Beach Courts \(Sat 9:00am\) is on that weekly time only: this session type keeps up to 5 saved locations and already had them\. To save a new place, remove a saved location on the session type's Edit screen first\./,
      );

      // A saved one still matches when the type is full.
      assert.equal((await coach.post(weekly, { day_0: '1', time_0: '09:00', location: 'POOL' })).status, 303);
      assert.equal((await slotAt(0)).location_text, 'Pool');
    });
  });
});

test('typed places are matched, saved and limited the same way whoever asks', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  assert.deepEqual(await resolveTypedPlace(db, seed.sessionTypeId, '   '), { locationId: null, text: null, overLimit: false });
  const first = await resolveTypedPlace(db, seed.sessionTypeId, ' Field  3 ');
  assert.deepEqual([first.text, first.overLimit], ['Field 3', false]);
  assert.deepEqual(await resolveTypedPlace(db, seed.sessionTypeId, 'FIELD 3'), first, 'the same place, once');
  // A name longer than a location takes is cut to fit, and matches itself again.
  const long = `${'Northside Community Park '.repeat(3)}Field 3`;
  const cut = await resolveTypedPlace(db, seed.sessionTypeId, long);
  assert.equal(cut.text, long.slice(0, 60).trimEnd());
  assert.ok(cut.locationId !== null && !cut.overLimit);
  assert.equal((await resolveTypedPlace(db, seed.sessionTypeId, long)).locationId, cut.locationId);
  for (const name of ['C', 'D', 'E']) await resolveTypedPlace(db, seed.sessionTypeId, name);
  assert.equal((await listLocations(db, seed.sessionTypeId)).length, 5);
  assert.deepEqual(await resolveTypedPlace(db, seed.sessionTypeId, ' The  Sixth '), { locationId: null, text: 'The Sixth', overLimit: true });
  assert.equal((await listLocations(db, seed.sessionTypeId)).length, 5);
});

const WEEK_WITH_PLACES = {
  coach_timezone: null,
  session_types: [{ key: 'group', name: 'Group Training', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: null }],
  weekly: [
    { type_key: 'group', weekday: 1, time_local: '18:00', location: 'Field 3' },
    { type_key: 'group', weekday: 2, time_local: '18:00', location: 'field  3' },
    { type_key: 'group', weekday: 3, time_local: '18:00', location: 'Gym' },
    { type_key: 'group', weekday: 4, time_local: '18:00', location: 'Pool' },
    { type_key: 'group', weekday: 5, time_local: '18:00', location: 'Track' },
    { type_key: 'group', weekday: 6, time_local: '09:00', location: 'Beach Courts' },
    { type_key: 'group', weekday: 6, time_local: '10:00', location: 'Rooftop' },
    { type_key: 'group', weekday: 0, time_local: '09:00', location: null },
  ],
  packages: [],
  plans: [],
};

async function weeklyPlaces(db: DbClient): Promise<Array<[number, string, string | null, boolean]>> {
  const slots = await db.query<{ weekday: number; time_local: string; location_text: string | null; location_id: number | null }>(
    'select weekday, time_local, location_text, location_id from weekly_slot order by weekday, time_local',
  );
  return slots.rows.map((s) => [s.weekday, s.time_local, s.location_text, s.location_id !== null]);
}

/** What publishing WEEK_WITH_PLACES leaves: five places saved, the sixth on
 * its own weekly time. */
const PUBLISHED_PLACES: Array<[number, string, string | null, boolean]> = [
  [0, '09:00', null, false],
  [1, '18:00', 'Field 3', true],
  [2, '18:00', 'Field 3', true],
  [3, '18:00', 'Gym', true],
  [4, '18:00', 'Pool', true],
  [5, '18:00', 'Track', true],
  [6, '09:00', 'Beach Courts', true],
  [6, '10:00', 'Rooftop', false],
];

test('setup by voice: typed places become saved locations up to five, the sixth stays on its weekly time, and the coach is told why after Publish', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = await signIn(db, seed.coach.id);
    setComplete(fakeComplete(WEEK_WITH_PLACES));
    try {
      await withServer(async (base) => {
        const coach = as(base, cookie);
        assert.equal((await coach.post('/app/setup', { text: 'Group training Monday to Friday at 6...' })).status, 303);
        const draft = (await db.query<{ id: number }>('select id from setup_draft')).rows[0];
        const published = await coach.post('/app/setup/publish', { id: String(draft.id) });
        assert.equal(published.headers.get('location'), '/app/schedule?published=1');

        assert.deepEqual(await weeklyPlaces(db), PUBLISHED_PLACES);
        const type = (await db.query<{ id: number }>("select id from session_type where name = 'Group Training'")).rows[0];
        assert.deepEqual((await listLocations(db, type.id)).map((l) => l.name), ['Field 3', 'Gym', 'Pool', 'Track', 'Beach Courts']);
        const rooftop = await db.query<{ n: string }>(
          "select count(*)::text as n from session where location_text = 'Rooftop' and location_id is null",
        );
        assert.ok(Number(rooftop.rows[0].n) >= 8, 'its sessions still say Rooftop');

        const live = await coach.page('/app/schedule?published=1');
        assert.match(live, /You're live/);
        assert.match(
          live,
          /Rooftop \(Group Training, Sat 10:00am\) is on that weekly time only: a session type keeps up to 5 saved locations and already had them\./,
        );
        assert.doesNotMatch(await coach.page('/app/schedule'), /is on that weekly time only/, 'said once, after publishing');
        assert.match(await coach.page(`/app/session-types/${type.id}/generate-week`), /Rooftop \(Sat 10:00am\) is on that weekly time only/);
      });
    } finally {
      resetComplete();
    }
  });
});

test('setup by text ends the same way: a week texted in and published keeps five places and leaves the sixth on its weekly time', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    setComplete(fakeComplete(WEEK_WITH_PLACES));
    try {
      const result = await handleSetupMessage(db, seed.coach, 'Group training Monday to Friday at 6...', 'sms');
      assert.equal(result.kind, 'draft');
      const counts = await publishSetupPlan(db, seed.coach, result.kind === 'draft' ? result.draft.id : 0);
      assert.equal(counts?.weekly, 8);
      assert.deepEqual(await weeklyPlaces(db), PUBLISHED_PLACES);
    } finally {
      resetComplete();
    }
  });
});

// ---- 4. One session ----

test('Session detail moves one upcoming session to another saved location; with nobody booked it changes at once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const field3 = await saved(db, seed, 'Field 3');
    const park = await saved(db, seed, 'Riverside Park', '120 River Rd');
    const otherType = await addLocation(db, seed.coach.id, await secondType(db, seed.coach.id, 'Privates'), 'Gym', null);
    const gym = (otherType as { location: SavedLocation }).location;
    await db.query("update session set location_text = 'Field 3', location_id = $2, tz = $3 where id = $1", [seed.sessionId, field3.id, zoneAt(12)]);
    const other = await seedCoachWithSession(db);
    const cookie = await signIn(db, seed.coach.id);
    const detail = `/app/sessions/${seed.sessionId}`;
    await withServer(async (base) => {
      const coach = as(base, cookie);
      const page = await coach.page(detail);
      assert.match(page, /<h2 id="where">Where<\/h2>\s*<p>Field 3<\/p>/);
      assert.match(page, /<label for="location_id">Move this session to<\/label>/);
      assert.match(page, new RegExp(`<select id="location_id" name="location_id">\\s*<option value="${park.id}">Riverside Park, 120 River Rd</option>\\s*</select>`));
      assert.match(page, /<button type="submit" class="ghost">Change location<\/button>/);

      const changed = await coach.post(`${detail}/location`, { location_id: String(park.id) });
      assert.equal(changed.status, 303);
      assert.equal(changed.headers.get('location'), `${detail}?placed=0.0#where`);
      assert.deepEqual(await sessionRow(db, seed.sessionId), {
        id: seed.sessionId,
        location_text: 'Riverside Park',
        location_id: park.id,
        location_address: '120 River Rd',
      });
      assert.equal(relay.sms.length, 0);
      const after = await coach.page(`${detail}?placed=0.0`);
      assert.match(after, /<p>Riverside Park, 120 River Rd<\/p>/);
      assert.match(after, /<p>Location changed\.<\/p>/);
      assert.match(after, new RegExp(`<option value="${field3.id}">Field 3</option>`), 'the one it left is offered again');

      // The same place again changes nothing.
      const same = await coach.post(`${detail}/location`, { location_id: String(park.id) });
      assert.equal(same.headers.get('location'), `${detail}#where`);

      // Only a saved location of this session's own type.
      for (const id of [String(gym.id), '99999', 'abc', '']) {
        const refused = await coach.post(`${detail}/location`, { location_id: id });
        assert.equal(refused.status, 422, id);
        assert.match(await refused.text(), /Pick one of this session type&#39;s saved locations\./);
      }
      // Only the coach whose session it is.
      const stranger = as(base, await signIn(db, other.coach.id));
      assert.equal((await stranger.post(`${detail}/location`, { location_id: String(field3.id) })).status, 404);
      assert.equal((await coach.post('/app/sessions/abc/location', { location_id: String(field3.id) })).status, 404);
      assert.equal((await sessionRow(db, seed.sessionId)).location_text, 'Riverside Park');

      // A session that has started, or was cancelled, stays where it was.
      await db.query("update session set starts_at_utc = now() - interval '5 minutes' where id = $1", [seed.sessionId]);
      const started = await coach.post(`${detail}/location`, { location_id: String(field3.id) });
      assert.equal(started.status, 422);
      assert.match(await started.text(), /Only a session still to come can change its location\./);
      assert.doesNotMatch(await coach.page(detail), /Move this session to/);
      await db.query("update session set starts_at_utc = now() + interval '1 day', status = 'cancelled' where id = $1", [seed.sessionId]);
      assert.equal((await coach.post(`${detail}/location`, { location_id: String(field3.id) })).status, 422);
      assert.equal((await sessionRow(db, seed.sessionId)).location_text, 'Riverside Park');
    });
  });
});

test('with parents booked the coach first sees who is texted and the words; the session update goes once to each parent who gets texts', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const field3 = await saved(db, seed, 'Field 3');
    const park = await saved(db, seed, 'Riverside Park', '120 River Rd');
    // The session's zone is at noon now, so quiet hours never apply here.
    await db.query("update session set location_text = 'Field 3', location_id = $2, tz = $3 where id = $1", [seed.sessionId, field3.id, zoneAt(12)]);
    // One parent with two children who gets texts, and one who does not.
    const texts = '+15550000001';
    const noTexts = '+15550000002';
    const booking = await seedBookedSession(db, seed.sessionId, 'Ada Lane', texts);
    await seedBookedSession(db, seed.sessionId, 'Bo Lane', texts);
    await seedBookedSession(db, seed.sessionId, 'Cy Park', noTexts);
    await db.query('delete from sms_consent where phone = $1', [noTexts]);
    const cookie = await signIn(db, seed.coach.id);
    const detail = `/app/sessions/${seed.sessionId}`;
    await withServer(async (base) => {
      const coach = as(base, cookie);

      // The first tap asks, and changes nothing.
      const asked = await coach.post(`${detail}/location`, { location_id: String(park.id) });
      assert.equal(asked.headers.get('location'), `${detail}?place=${park.id}#where`);
      assert.equal((await sessionRow(db, seed.sessionId)).location_text, 'Field 3');
      assert.equal(relay.sms.length, 0);

      const question = await coach.page(`${detail}?place=${park.id}`);
      assert.match(question, /<strong>Move [^<]+ to Riverside Park\?<\/strong>/);
      const words = /2 clients are booked\. 1 of them gets this text: "(Coachatron: Goalkeeper Group [^"]+\. Now at Riverside Park\.)" The other sees the new place on their booking page\./.exec(question);
      assert.ok(words, question);
      assert.match(question, /<input type="hidden" name="confirm" value="1" \/>/);
      assert.match(question, new RegExp(`<a class="action ghost" href="${detail}">Keep Field 3</a>`));

      const done = await coach.post(`${detail}/location`, { location_id: String(park.id), confirm: '1' });
      assert.equal(done.headers.get('location'), `${detail}?placed=1.2#where`);
      assert.deepEqual(await sessionRow(db, seed.sessionId), {
        id: seed.sessionId,
        location_text: 'Riverside Park',
        location_id: park.id,
        location_address: '120 River Rd',
      });
      // One text to the parent who gets them, in the words the coach saw.
      assert.equal(relay.sms.length, 1);
      assert.equal(relay.sms[0].to, texts);
      assert.equal(relay.sms[0].body, `${words[1]} Reply STOP to opt out.`);
      assert.ok(relay.sms[0].body.length <= 160 && segmentCount(relay.sms[0].body) === 1, relay.sms[0].body);
      const logged = await db.query<{ to_phone: string; template: string; status: string; coach_id: number }>(
        "select to_phone, template, status, coach_id from message_log where channel = 'sms' order by id",
      );
      assert.deepEqual(logged.rows, [{ to_phone: texts, template: 'broadcast', status: 'sent', coach_id: seed.coach.id }]);
      assert.match(
        await coach.page(`${detail}?placed=1.2`),
        /Location changed\. Texted 1 of 2 clients\. The rest see the new place on their booking page\./,
      );

      // A second tap of the same change sends nothing more.
      await coach.post(`${detail}/location`, { location_id: String(park.id), confirm: '1' });
      assert.equal(relay.sms.length, 1);

      // The parent's booking page says the new place, and so does the reminder.
      const token = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [booking])).rows[0].manage_token;
      assert.match(await (await fetch(`${base}/booking/${token}`)).text(), / · Riverside Park, 120 River Rd<\/p>/);
    });
    const starts = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0].starts_at_utc;
    const dayBefore = new Date(new Date(starts).getTime() - 20 * HOUR);
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12, dayBefore)]);
    relay.sms.length = 0;
    await sendDueReminders(db, dayBefore);
    assert.deepEqual([...new Set(relay.sms.map((m) => m.to))], [texts]);
    for (const m of relay.sms) assert.match(m.body, / at Riverside Park\. Reply STOP to opt out\.$/);
  });
});

test('the session update is one segment that keeps the place whole, whatever the names', () => {
  const session = { type_name: 'Advanced Footwork and Distribution for Travel Teams, Ages 12 to 14', starts_at_utc: '2026-11-17T23:00:00.000Z', tz: TZ };
  const place = 'Northside Community Park, Field 3 (behind the library)';
  const text = placeChangeText(session, place);
  assert.ok(text.startsWith('Coachatron: Advanced Footwork'), text);
  assert.ok(text.endsWith(`Tue Nov 17, 5:00pm. Now at ${place}.`), text);
  assert.ok(`${text} Reply STOP to opt out.`.length <= 160, text);
  assert.equal(
    placeChangeText({ type_name: 'Group', starts_at_utc: '2026-11-17T23:00:00.000Z', tz: TZ }, 'Field 3'),
    'Coachatron: Group Tue Nov 17, 5:00pm. Now at Field 3.',
  );
});

// ---- 9. What clients see ----

test("parents see the session's own place on the coach's page, the booking form, checkout, the manage page, the confirmation and the reminder", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    const park = await saved(db, seed, 'Riverside Park', '120 River Rd');
    const moved = await changeSessionLocation(db, seed.coach.id, seed.sessionId, park.id);
    assert.equal(moved.kind, 'changed');
    // A second session of the same type with no place says none.
    const bare = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, status) values ($1, now() + interval '3 days', $2, 'scheduled') returning id`,
      [seed.sessionTypeId, TZ],
    );
    const phone = '+15551112222';
    await withServer(async (base) => {
      const handle = seed.coach.handle;
      const list = await (await fetch(`${base}/c/${handle}`)).text();
      assert.equal(list.match(/<div class="meta"><span>Riverside Park, 120 River Rd<\/span><\/div>/g)?.length, 1, 'on its own session only');

      const form = await (await fetch(`${base}/c/${handle}/sessions/${seed.sessionId}/book`)).text();
      assert.match(form, /<p class="muted">[^<]+ · Riverside Park, 120 River Rd — \$35\.00<\/p>/);
      const bareForm = await (await fetch(`${base}/c/${handle}/sessions/${bare.rows[0].id}/book`)).text();
      assert.match(bareForm, /<p class="muted">[^<·]+ — \$35\.00<\/p>/, 'a session with no place says none');

      const b = await bookOnline(base, handle, seed.sessionId, 'Alex', '5551112222', { contact_email: 'alex.parent@example.com' });
      assert.ok(b.key);
      const checkout = await (await fetch(`${base}/c/${handle}/checkout/${b.key}`)).text();
      assert.match(checkout, /<p class="muted">[^<]+ · Riverside Park, 120 River Rd<\/p>/);

      const pay = await postCheckout(base, handle, b.key, { mode: 'dropin' });
      const paid = await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_place' });
      assert.equal(paid.status, 200);
      const manage = await (await fetch(`${base}/booking/${(await latestBooking(db)).manage_token}`)).text();
      assert.match(manage, /<p class="muted">[^<]+ · Riverside Park, 120 River Rd<\/p>/);
      assert.match(manage, /Confirmed/);
    });
    // The confirmation: the text keeps to the name, the email too.
    const [text] = relay.sms.filter((m) => m.to === phone);
    assert.match(text.body, /^Coachatron: Alex is booked: Goalkeeper Group [^,]+, Riverside Park\. https?:\/\//);
    assert.ok(segmentCount(text.body) === 1 && text.body.length <= 160, text.body);
    assert.match(relay.emails[0].text, /, Riverside Park\.\n/);

    // The reminder, a day ahead at noon in the coach's zone.
    const starts = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0].starts_at_utc;
    const dayBefore = new Date(new Date(starts).getTime() - 20 * HOUR);
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12, dayBefore)]);
    relay.sms.length = 0;
    assert.equal(await sendDueReminders(db, dayBefore), 1);
    assert.match(relay.sms[0].body, /^Coachatron: Alex's Goalkeeper Group is [^.]+ at Riverside Park\. Reply STOP to opt out\.$/);
  });
});

// ---- Sessions made other ways keep the link ----

test('a second group opened for a full session is at the same saved location, and a rename reaches both', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const park = await saved(db, seed, 'Riverside Park', '120 River Rd');
    await changeSessionLocation(db, seed.coach.id, seed.sessionId, park.id);
    const member = await db.query<{ id: number }>(
      `insert into roster_member (coach_id, name, phone, priority, active) values ($1, 'Sam Backup', '+17775550100', 0, true) returning id`,
      [seed.coach.id],
    );
    const { grantSmsConsent } = await import('../src/domain/sms-consent.js');
    await grantSmsConsent(db, '+17775550100');
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550000001');
    await db.query("insert into waitlist (session_id, contact_phone, athlete_name) values ($1, '+15550000002', 'Bo Lane')", [seed.sessionId]);
    await checkOverflow(db, seed.sessionId);
    await startCascade(db, seed.sessionId, 'second_group');
    const offer = await db.query<{ id: number }>('select id from offer where session_id = $1 and roster_member_id = $2', [seed.sessionId, member.rows[0].id]);
    await acceptOffer(db, offer.rows[0].id);

    const second = await db.query<PlacedSession>('select id, location_text, location_id, location_address from session where overflow_of = $1', [seed.sessionId]);
    assert.equal(second.rows.length, 1);
    assert.deepEqual(
      [second.rows[0].location_text, second.rows[0].location_id, second.rows[0].location_address],
      ['Riverside Park', park.id, '120 River Rd'],
    );
    const renamed = await renameLocation(db, seed.coach.id, seed.sessionTypeId, park.id, 'River Park', null);
    assert.equal(renamed.kind === 'renamed' && renamed.sessions, 2);
    assert.deepEqual([(await sessionRow(db, second.rows[0].id)).location_text, (await sessionRow(db, seed.sessionId)).location_text], ['River Park', 'River Park']);
  });
});
