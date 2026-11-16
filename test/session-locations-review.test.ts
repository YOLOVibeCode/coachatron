import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { zoneAt } from './helpers/clock.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { addLocation, listLocations, readLocationFields, resolveTypedPlace, type SavedLocation } from '../src/domain/locations.js';
import { changeSessionLocation, placeChangeText, placeTextAllowed } from '../src/domain/sessionLocation.js';
import { segmentCount } from '../src/domain/outbound.js';
import type { DbClient } from '../src/db/client.js';

/** Follow-ups to saved locations: the update text for a place with no
 * letters a text can carry, quiet hours, and a saved name longer than a
 * name takes now (from before locations were saved). Times are fixed, or
 * the session's zone is chosen so it is night or day whenever this runs. */

const HOUR = 60 * 60 * 1000;
const FALLBACK = 'Location changed, see your booking page.';

async function setup(db: DbClient, names: string[]) {
  const seed = await seedCoachWithSession(db, { capacity: 4 });
  const places: SavedLocation[] = [];
  for (const name of names) {
    const added = await addLocation(db, seed.coach.id, seed.sessionTypeId, name, null);
    assert.equal(added.kind, 'added');
    places.push((added as { location: SavedLocation }).location);
  }
  return { seed, places };
}

async function startAt(db: DbClient, sessionId: number, startsAt: Date, tz = 'America/Chicago'): Promise<void> {
  await db.query('update session set starts_at_utc = $2, tz = $3 where id = $1', [sessionId, startsAt.toISOString(), tz]);
}

test('a place with no letters a text can carry gets the booking-page wording, in the preview and in the text', async () => {
  const session = { type_name: 'Group Training', starts_at_utc: '2026-11-19T00:00:00.000Z', tz: 'America/Chicago' };
  for (const place of ['日本公園', 'Парк', '🌳🌳']) {
    const text = placeChangeText(session, place);
    assert.equal(text, `Coachatron: Group Training Wed Nov 18, 6:00pm. ${FALLBACK}`);
    assert.ok(!/Now at/.test(text));
    assert.ok(`${text} Reply STOP to opt out.`.length <= 160 && segmentCount(`${text} Reply STOP to opt out.`) === 1);
  }
  assert.match(placeChangeText(session, 'Café Park'), /Now at Cafe Park\.$/);

  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, places } = await setup(db, ['Field 3', '日本公園']);
    await startAt(db, seed.sessionId, new Date(Date.now() + 5 * HOUR));
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550000001');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const preview = await (await fetch(`${base}/app/sessions/${seed.sessionId}?place=${places[1].id}`, { headers: { cookie } })).text();
      assert.match(preview, new RegExp(`Coachatron: Goalkeeper Group [^"]+\\. ${FALLBACK.replace(/[.,]/g, '\\$&')}`));
      assert.doesNotMatch(preview, /Now at \./);
    });
    const moved = await changeSessionLocation(db, seed.coach.id, seed.sessionId, places[1].id);
    assert.equal(moved.kind, 'changed');
    assert.equal(relay.sms.length, 1);
    assert.match(relay.sms[0].body, new RegExp(`^Coachatron: Goalkeeper Group .+\\. ${FALLBACK.replace(/[.,]/g, '\\$&')} Reply STOP`));
  });
});

test('quiet hours: no update text from 9pm to 8am in the session\'s zone unless the session is within 12 hours', async () => {
  const session = (hoursAfter: number, now: Date) => ({ starts_at_utc: new Date(now.getTime() + hoursAfter * HOUR).toISOString(), tz: 'America/Chicago' });
  const night = new Date('2026-11-17T04:00:00Z'); // 10pm in Chicago
  const day = new Date('2026-11-17T18:00:00Z'); // noon
  assert.equal(placeTextAllowed(session(40, night), night), false);
  assert.equal(placeTextAllowed(session(12, night), night), true, 'twelve hours is soon');
  assert.equal(placeTextAllowed(session(5, night), night), true);
  assert.equal(placeTextAllowed(session(40, day), day), true);

  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, places } = await setup(db, ['Field 3', 'Gym']);
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550000001');
    const move = async (to: SavedLocation, startsAt: Date, now: Date) => {
      await startAt(db, seed.sessionId, startsAt);
      return changeSessionLocation(db, seed.coach.id, seed.sessionId, to.id, now);
    };
    // Night, the session two days off: changed, nothing sent.
    const late = await move(places[0], new Date(night.getTime() + 40 * HOUR), night);
    assert.equal(late.kind === 'changed' && [late.texted, late.parents, late.late].join(), '0,1,true');
    assert.equal(relay.sms.length, 0);
    const row = await db.query<{ location_text: string }>('select location_text from session where id = $1', [seed.sessionId]);
    assert.equal(row.rows[0].location_text, 'Field 3', 'the place still changed');
    // Night, the session in 5 hours: urgent, sent.
    const soon = await move(places[1], new Date(night.getTime() + 5 * HOUR), night);
    assert.equal(soon.kind === 'changed' && [soon.texted, soon.late].join(), '1,false');
    // Daytime, far off: sent.
    const daytime = await move(places[0], new Date(day.getTime() + 40 * HOUR), day);
    assert.equal(daytime.kind === 'changed' && [daytime.texted, daytime.late].join(), '1,false');
    assert.equal(relay.sms.length, 2);
  });
});

test('the confirm screen and the notice say it is late, and the confirm sends nothing', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, places } = await setup(db, ['Field 3', 'Gym']);
    // A zone where it is 11pm now, and a session three days off.
    await startAt(db, seed.sessionId, new Date(Date.now() + 72 * HOUR), zoneAt(23));
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550000001');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    const note = 'It is late; parents will see the new place on their booking page and in their reminder.';
    await withServer(async (base) => {
      const detail = `${base}/app/sessions/${seed.sessionId}`;
      assert.ok((await (await fetch(`${detail}?place=${places[1].id}`, { headers: { cookie } })).text()).includes(note));
      const done = await fetch(`${detail}/location`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ location_id: String(places[1].id), confirm: '1' }),
        redirect: 'manual',
      });
      assert.equal(done.headers.get('location'), `/app/sessions/${seed.sessionId}?placed=0.1.late#where`);
      assert.ok((await (await fetch(`${detail}?placed=0.1.late`, { headers: { cookie } })).text()).includes(`Location changed. ${note}`));
    });
    assert.equal(relay.sms.length, 0);
  });
});

test('a saved name longer than a name takes now can still have its address edited, and a typed place matches it', async () => {
  const longName = 'Northside Community Recreation Center and Athletic Fields, North Lot';
  assert.ok(longName.length > 60);
  assert.equal(readLocationFields(longName, '', longName).ok, true);
  assert.equal(readLocationFields(longName, '').ok, false, 'a new name is still limited');
  assert.equal(readLocationFields(`${longName} 2`, '', longName).ok, false);

  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    // As the migration leaves one: a place typed before locations were saved.
    await db.query('insert into session_type_location (session_type_id, name) values ($1, $2)', [seed.sessionTypeId, longName]);
    const [saved] = await listLocations(db, seed.sessionTypeId);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    let base = '';
    const post = (path: string, body: Record<string, string>) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body), redirect: 'manual' });
    await withServer(async (b) => {
      base = b;
      const edit = `/app/session-types/${seed.sessionTypeId}/locations/${saved.id}`;
      const ok = await post(edit, { name: longName, address: '9 Park Rd' });
      assert.equal(ok.status, 303);
      assert.equal((await listLocations(db, seed.sessionTypeId))[0].address, '9 Park Rd');
      assert.equal((await post(edit, { name: `${longName} annex`, address: '' })).status, 422);

      // On the weekly times form, the same words use the saved one.
      const weekly = await post(`/app/session-types/${seed.sessionTypeId}/generate-week`, { day_2: '1', time_2: '18:00', location: longName });
      assert.equal(weekly.status, 303);
    });
    const slot = await db.query<{ location_id: number; location_text: string }>('select location_id, location_text from weekly_slot');
    assert.deepEqual(slot.rows, [{ location_id: saved.id, location_text: longName }]);
    // Setup by text or voice finds it too, and adds nothing.
    assert.equal((await resolveTypedPlace(db, seed.sessionTypeId, longName)).locationId, saved.id);
    assert.equal((await listLocations(db, seed.sessionTypeId)).length, 1);
  });
});
