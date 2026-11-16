import { inTransaction, type DbClient } from '../db/client.js';

/** A session type's saved locations (SPEC.md §8.2): a short list the coach
 * picks from, so a place is typed once. Each weekly time picks one of its
 * type's locations, or none, and the sessions made from it carry that place.
 * Moving one session to another of them is in sessionLocation.ts.
 *
 * A session's own words stay in session.location_text, as before: every
 * page and text reads that, and nothing that shows a session needs this
 * table. The saved location's name is copied onto the weekly time and from
 * there onto each session, and its address line beside it
 * (location_address, which pages show after the name). The location_id on
 * a weekly time or a session only says which saved location those words
 * came from, so a rename can reach them. A place with no link is that
 * weekly time's or that session's own. */

export const LOCATION_LIMITS = {
  /** Saved locations a session type takes. A type that had more places than
   * this before locations were saved keeps them all: the limit is for adding. */
  perType: 5,
  nameChars: 60,
  addressChars: 120,
} as const;

export interface SavedLocation {
  id: number;
  session_type_id: number;
  name: string;
  address: string | null;
}

export const LOCATION_COLUMNS = 'id, session_type_id, name, address';

/** Single spaces, and none at the ends. */
export function tidyPlace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** What two spellings of one place share: capitals and extra spaces do not
 * count. The database matches the same way (lower(name) on a tidied name). */
export function placeKey(text: string): string {
  return tidyPlace(text).toLowerCase();
}

/** "Riverside Park, 120 River Rd": a place with its address line, where a
 * page has room for both. Texts keep to the name. */
export function placeLine(name: string | null | undefined, address?: string | null): string {
  if (!name) return '';
  return address ? `${name}, ${address}` : name;
}

/** " · Riverside Park, 120 River Rd" after a session's time on a page, or
 * nothing for a session with no place. Reads the session's own columns. */
export function atPlace(session: { location_text: string | null; location_address?: string | null }): string {
  const place = placeLine(session.location_text, session.location_address);
  return place ? ` · ${place}` : '';
}

/** A name and address line as a form sent them, or what is wrong with them. */
export function readLocationFields(
  rawName: string,
  rawAddress: string,
): { ok: true; name: string; address: string | null } | { ok: false; error: string } {
  const name = tidyPlace(rawName);
  const address = tidyPlace(rawAddress);
  if (!name) return { ok: false, error: 'Give the location a name.' };
  if (name.length > LOCATION_LIMITS.nameChars) {
    return { ok: false, error: `A location name is up to ${LOCATION_LIMITS.nameChars} characters.` };
  }
  if (address.length > LOCATION_LIMITS.addressChars) {
    return { ok: false, error: `An address line is up to ${LOCATION_LIMITS.addressChars} characters.` };
  }
  return { ok: true, name, address: address || null };
}

/** The type's saved locations, oldest first. */
export async function listLocations(db: DbClient, sessionTypeId: number): Promise<SavedLocation[]> {
  const result = await db.query<SavedLocation>(
    `select ${LOCATION_COLUMNS} from session_type_location where session_type_id = $1 and removed_at is null order by id`,
    [sessionTypeId],
  );
  return result.rows;
}

/** The type's saved location with this name, whatever the capitals. */
export async function findLocationByName(db: DbClient, sessionTypeId: number, name: string): Promise<SavedLocation | null> {
  const result = await db.query<SavedLocation>(
    `select ${LOCATION_COLUMNS} from session_type_location
     where session_type_id = $1 and removed_at is null and lower(name) = lower($2)
     order by id limit 1`,
    [sessionTypeId, name],
  );
  return result.rows[0] ?? null;
}

/** Holds the session type's row, so two changes to one type's locations run
 * one after the other: the limit is counted and a name is checked with
 * nothing else adding beside it. Every write here takes this first. It does
 * not hold up bookings or new sessions, which only need the row to exist
 * (`for no key update`; a location's own row is held the same way, so a
 * session being written with that location never waits on a rename).
 * With a coach, the type must be that coach's. */
export async function lockType(tx: DbClient, sessionTypeId: number, coachId?: number): Promise<boolean> {
  const result = await tx.query<{ id: number }>(
    `select id from session_type where id = $1 and ($2::int is null or coach_id = $2) for no key update`,
    [sessionTypeId, coachId ?? null],
  );
  return result.rows.length > 0;
}

async function insertLocation(tx: DbClient, sessionTypeId: number, name: string, address: string | null): Promise<SavedLocation> {
  const result = await tx.query<SavedLocation>(
    `insert into session_type_location (session_type_id, name, address) values ($1, $2, $3) returning ${LOCATION_COLUMNS}`,
    [sessionTypeId, name, address],
  );
  return result.rows[0];
}

export type AddLocationResult =
  | { kind: 'added'; location: SavedLocation }
  /** The type already has a location by that name: nothing was added. */
  | { kind: 'exists'; location: SavedLocation }
  | { kind: 'full' }
  | { kind: 'not-found' };

/** Adds a saved location to the coach's session type, up to the limit.
 * `name` and `address` are as readLocationFields returns them. */
export async function addLocation(
  db: DbClient,
  coachId: number,
  sessionTypeId: number,
  name: string,
  address: string | null,
): Promise<AddLocationResult> {
  return inTransaction(db, async (tx) => {
    if (!(await lockType(tx, sessionTypeId, coachId))) return { kind: 'not-found' };
    const same = await findLocationByName(tx, sessionTypeId, name);
    if (same) return { kind: 'exists', location: same };
    if ((await listLocations(tx, sessionTypeId)).length >= LOCATION_LIMITS.perType) return { kind: 'full' };
    return { kind: 'added', location: await insertLocation(tx, sessionTypeId, name, address) };
  });
}

export type RenameLocationResult =
  | { kind: 'renamed'; location: SavedLocation; weeklyTimes: number; sessions: number }
  /** Another saved location of this type already has that name. */
  | { kind: 'taken' }
  | { kind: 'not-found' };

/** Changes a saved location's name or address line. The weekly times that
 * use it, and every session that uses it and has not started, say the new
 * words. A session that has started keeps what it said.
 *
 * A session written at the same moment by something that copies another
 * session's place (a second group opened for a full session) can commit
 * with the old words after this has looked. So once the rename is in, the
 * sessions still to come are checked once more against the location as it
 * now stands, and any left behind is brought up to date. */
export async function renameLocation(
  db: DbClient,
  coachId: number,
  sessionTypeId: number,
  locationId: number,
  name: string,
  address: string | null,
  now: Date = new Date(),
): Promise<RenameLocationResult> {
  const result = await inTransaction(db, async (tx): Promise<RenameLocationResult> => {
    if (!(await lockType(tx, sessionTypeId, coachId))) return { kind: 'not-found' };
    const found = await tx.query<{ id: number }>(
      'select id from session_type_location where id = $1 and session_type_id = $2 and removed_at is null for no key update',
      [locationId, sessionTypeId],
    );
    if (found.rows.length === 0) return { kind: 'not-found' };
    const same = await findLocationByName(tx, sessionTypeId, name);
    if (same && same.id !== locationId) return { kind: 'taken' };
    const updated = await tx.query<SavedLocation>(
      `update session_type_location set name = $2, address = $3 where id = $1 returning ${LOCATION_COLUMNS}`,
      [locationId, name, address],
    );
    const slots = await tx.query<{ id: number }>(
      'update weekly_slot set location_text = $2, location_address = $3 where location_id = $1 returning id',
      [locationId, name, address],
    );
    const sessions = await tx.query<{ id: number }>(
      `update session set location_text = $2, location_address = $3
       where location_id = $1 and starts_at_utc > $4
       returning id`,
      [locationId, name, address, now.toISOString()],
    );
    return { kind: 'renamed', location: updated.rows[0], weeklyTimes: slots.rows.length, sessions: sessions.rows.length };
  });
  if (result.kind !== 'renamed') return result;
  const late = await db.query<{ id: number }>(
    `update session s set location_text = l.name, location_address = l.address
     from session_type_location l
     where l.id = $1 and s.location_id = l.id and s.starts_at_utc > $2
       and (s.location_text is distinct from l.name or s.location_address is distinct from l.address)
     returning s.id`,
    [locationId, now.toISOString()],
  );
  return { ...result, sessions: result.sessions + late.rows.length };
}

export interface WeeklyTimeRef {
  weekday: number;
  time_local: string;
}

export type RemoveLocationResult =
  | { kind: 'removed'; location: SavedLocation }
  /** Weekly times still use it: nothing was removed. */
  | { kind: 'in-use'; location: SavedLocation; weeklyTimes: WeeklyTimeRef[] }
  | { kind: 'not-found' };

/** Removes a saved location no weekly time uses. Sessions already on the
 * calendar keep their words. The location's row is held before the weekly
 * times are read, so a weekly time being added with it at the same moment
 * either is seen here or finds the location gone. */
export async function removeLocation(
  db: DbClient,
  coachId: number,
  sessionTypeId: number,
  locationId: number,
  now: Date = new Date(),
): Promise<RemoveLocationResult> {
  return inTransaction(db, async (tx) => {
    if (!(await lockType(tx, sessionTypeId, coachId))) return { kind: 'not-found' };
    const found = await tx.query<SavedLocation>(
      `select ${LOCATION_COLUMNS} from session_type_location where id = $1 and session_type_id = $2 and removed_at is null for no key update`,
      [locationId, sessionTypeId],
    );
    const location = found.rows[0];
    if (!location) return { kind: 'not-found' };
    const using = await tx.query<WeeklyTimeRef>(
      'select weekday, time_local from weekly_slot where location_id = $1 and active = true order by weekday, time_local',
      [locationId],
    );
    if (using.rows.length > 0) return { kind: 'in-use', location, weeklyTimes: using.rows };
    await tx.query('update session_type_location set removed_at = $2 where id = $1', [locationId, now.toISOString()]);
    return { kind: 'removed', location };
  });
}

export interface TypedPlace {
  /** The saved location the words belong to, or null when they are the
   * weekly time's own. */
  locationId: number | null;
  text: string | null;
  /** True when the place is new and the type already has all the saved
   * locations it takes, so the words stay on that weekly time only. */
  overLimit: boolean;
}

/** A place typed where a weekly time is set up (the weekly-times form, and
 * setup by text or voice). Words that match one of the type's saved
 * locations, whatever the capitals and spacing, use it. A new place becomes
 * a saved location while the type is under the limit, its name cut to the
 * length a name takes. Over the limit the words are kept as typed, for that
 * weekly time only. */
export async function resolveTypedPlace(db: DbClient, sessionTypeId: number, typed: string | null | undefined): Promise<TypedPlace> {
  const text = tidyPlace(typed ?? '');
  if (!text) return { locationId: null, text: null, overLimit: false };
  const name = text.slice(0, LOCATION_LIMITS.nameChars).trimEnd();
  return inTransaction(db, async (tx) => {
    await lockType(tx, sessionTypeId);
    const same = await findLocationByName(tx, sessionTypeId, name);
    if (same) return { locationId: same.id, text: same.name, overLimit: false };
    if ((await listLocations(tx, sessionTypeId)).length >= LOCATION_LIMITS.perType) {
      return { locationId: null, text, overLimit: true };
    }
    const added = await insertLocation(tx, sessionTypeId, name, null);
    return { locationId: added.id, text: added.name, overLimit: false };
  });
}

export interface SessionPlace {
  locationId: number | null;
  text: string | null;
  address: string | null;
}

/** Writes one session with a place typed for it (the text assistant adding
 * or moving it). Words that match one of the type's saved locations are
 * that location, with its address line. Anything else is the session's own
 * words, and nothing is added to the saved list. The place is read and
 * `write` runs in one transaction that holds the session type, so a rename
 * of that location is either in the words written or comes after them. */
export async function writeSessionPlace<T>(
  db: DbClient,
  sessionTypeId: number,
  typed: string | null | undefined,
  write: (tx: DbClient, place: SessionPlace) => Promise<T>,
): Promise<T> {
  const text = tidyPlace(typed ?? '');
  if (!text) return write(db, { locationId: null, text: null, address: null });
  return inTransaction(db, async (tx) => {
    await lockType(tx, sessionTypeId);
    const same = await findLocationByName(tx, sessionTypeId, text);
    return write(tx, same ? { locationId: same.id, text: same.name, address: same.address } : { locationId: null, text, address: null });
  });
}

export interface OwnPlaceTime extends WeeklyTimeRef {
  session_type_id: number;
  type_name: string;
  location_text: string;
}

/** Weekly times whose place is their own words, not a saved location:
 * typed when the type already had all the saved locations it takes. For
 * one session type, or for all of a coach's. */
export async function ownPlaceTimes(db: DbClient, where: { sessionTypeId: number } | { coachId: number }): Promise<OwnPlaceTime[]> {
  const byType = 'sessionTypeId' in where;
  const result = await db.query<OwnPlaceTime>(
    `select ws.weekday, ws.time_local, ws.session_type_id, st.name as type_name, ws.location_text
     from weekly_slot ws
     join session_type st on st.id = ws.session_type_id
     where ws.active = true and ws.location_id is null and btrim(coalesce(ws.location_text, '')) <> ''
       and ${byType ? 'st.id = $1' : 'st.coach_id = $1 and st.active = true'}
     order by st.id, ws.weekday, ws.time_local`,
    [byType ? where.sessionTypeId : where.coachId],
  );
  return result.rows;
}
