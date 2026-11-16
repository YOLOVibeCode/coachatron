import { inTransaction, type DbClient } from '../db/client.js';
import { formatConfirmWhen } from '../lib/time.js';
import { plain } from './bookingMessages.js';
import { LOCATION_COLUMNS, lockType, type SavedLocation } from './locations.js';
import { canText, fitsOneSegment, segmentRoom, sendText, shortenTo } from './outbound.js';
import { hasActiveConsent } from './sms-consent.js';

/** One session moved to another of its type's saved locations (Session
 * detail, SPEC.md §8.2), and the session update that tells the parents
 * booked in it. Kept apart from locations.ts, which the schedule's own code
 * reads and which sends nothing. */

export interface SessionPlaceContext {
  id: number;
  session_type_id: number;
  type_name: string;
  starts_at_utc: string;
  tz: string;
  status: string;
  location_id: number | null;
  location_text: string | null;
  location_address: string | null;
}

const SESSION_PLACE_SQL = `select s.id, s.session_type_id, st.name as type_name, s.starts_at_utc, s.tz, s.status,
         s.location_id, s.location_text, s.location_address
  from session s
  join session_type st on st.id = s.session_type_id
  where s.id = $1 and st.coach_id = $2`;

/** The coach's session with where it is, or null when it is not theirs. */
export async function loadSessionPlace(db: DbClient, coachId: number, sessionId: number): Promise<SessionPlaceContext | null> {
  const result = await db.query<SessionPlaceContext>(SESSION_PLACE_SQL, [sessionId, coachId]);
  const row = result.rows[0];
  return row ? { ...row, starts_at_utc: new Date(row.starts_at_utc).toISOString() } : null;
}

/** True while the session can still change: scheduled and not started. */
export function isUpcoming(session: Pick<SessionPlaceContext, 'status' | 'starts_at_utc'>, now: Date = new Date()): boolean {
  return session.status === 'scheduled' && new Date(session.starts_at_utc).getTime() > now.getTime();
}

export interface PlaceChangeReach {
  /** Parents with a booking in the session, one per phone number. */
  parents: number;
  /** Of those, how many get texts: a number we can text, with consent. */
  textable: number;
}

async function bookedPhones(db: DbClient, sessionId: number): Promise<string[]> {
  const result = await db.query<{ contact_phone: string }>(
    "select distinct contact_phone from booking where session_id = $1 and status = 'booked' order by contact_phone",
    [sessionId],
  );
  return result.rows.map((r) => r.contact_phone);
}

async function textablePhones(db: DbClient, phones: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const phone of phones) {
    if (canText(phone) && (await hasActiveConsent(db, phone))) out.push(phone);
  }
  return out;
}

/** Who a change of place would be told to, for the question the coach
 * answers before it is made. */
export async function previewPlaceChange(db: DbClient, sessionId: number): Promise<PlaceChangeReach> {
  const phones = await bookedPhones(db, sessionId);
  return { parents: phones.length, textable: (await textablePhones(db, phones)).length };
}

/** The template of the coach's update to a session's booked parents (the
 * text assistant's broadcast): the same kind of text, logged the same way. */
export const SESSION_UPDATE_TEMPLATE = 'broadcast';

/** The session update that tells booked parents the new place, in the
 * words of the coach's broadcast ("<session> <when>. <what changed>"). It
 * goes out whole as one segment: the session's name is what gets shortened,
 * never the place. */
export function placeChangeText(session: Pick<SessionPlaceContext, 'type_name' | 'starts_at_utc' | 'tz'>, place: string): string {
  const when = formatConfirmWhen(session.starts_at_utc, session.tz);
  const text = (name: string) => `Coachatron: ${name} ${when}. Now at ${plain(place)}.`;
  const name = plain(session.type_name);
  const whole = text(name);
  if (fitsOneSegment(whole, SESSION_UPDATE_TEMPLATE)) return whole;
  const room = segmentRoom(text(''), SESSION_UPDATE_TEMPLATE);
  return room >= 4 ? text(shortenTo(name, room)) : whole;
}

export type ChangeSessionPlaceResult =
  | { kind: 'changed'; session: SessionPlaceContext; from: string | null; location: SavedLocation; parents: number; texted: number }
  /** The session is at that location already (a second tap): nothing was sent. */
  | { kind: 'same'; location: SavedLocation }
  | { kind: 'not-found' }
  /** Cancelled, or already started. */
  | { kind: 'not-upcoming' }
  /** Not one of the saved locations of this session's type. */
  | { kind: 'no-location' };

/** Moves one upcoming session to another of its type's saved locations.
 * The session keeps the new words like any other (location_text), so the
 * parent's booking page and the reminder say the new place. Parents booked
 * in it who get texts are sent the session update, once per phone number,
 * through the one send path (consent, opt-outs, the coach's ceilings and
 * the log all apply); a text that fails for one parent does not stop the
 * others or undo the change. */
export async function changeSessionLocation(
  db: DbClient,
  coachId: number,
  sessionId: number,
  locationId: number,
  now: Date = new Date(),
): Promise<ChangeSessionPlaceResult> {
  const outcome = await inTransaction(db, async (tx): Promise<ChangeSessionPlaceResult> => {
    const before = (await tx.query<SessionPlaceContext>(SESSION_PLACE_SQL, [sessionId, coachId])).rows[0];
    if (!before) return { kind: 'not-found' };
    // Changes to one type's locations run one at a time (lockType), then the
    // session's own row is read again under its lock.
    await lockType(tx, before.session_type_id);
    const locked = (await tx.query<SessionPlaceContext>(`${SESSION_PLACE_SQL} for update of s`, [sessionId, coachId])).rows[0];
    if (!locked) return { kind: 'not-found' };
    const session = { ...locked, starts_at_utc: new Date(locked.starts_at_utc).toISOString() };
    if (!isUpcoming(session, now)) return { kind: 'not-upcoming' };
    const found = await tx.query<SavedLocation>(
      `select ${LOCATION_COLUMNS} from session_type_location where id = $1 and session_type_id = $2 and removed_at is null`,
      [locationId, session.session_type_id],
    );
    const location = found.rows[0];
    if (!location) return { kind: 'no-location' };
    if (session.location_id === location.id && session.location_text === location.name) return { kind: 'same', location };
    await tx.query('update session set location_id = $2, location_text = $3, location_address = $4 where id = $1', [
      sessionId,
      location.id,
      location.name,
      location.address,
    ]);
    return { kind: 'changed', session, from: session.location_text, location, parents: 0, texted: 0 };
  });
  if (outcome.kind !== 'changed') return outcome;

  const phones = await bookedPhones(db, sessionId);
  const body = placeChangeText(outcome.session, outcome.location.name);
  let texted = 0;
  for (const phone of await textablePhones(db, phones)) {
    try {
      const sent = await sendText(db, { to: phone, body, coachId, template: SESSION_UPDATE_TEMPLATE }, now);
      if (sent === 'sent') texted += 1;
    } catch (err) {
      console.error(`locations: session update for session ${sessionId} not sent to one parent:`, err instanceof Error ? err.message : err);
    }
  }
  return { ...outcome, parents: phones.length, texted };
}
