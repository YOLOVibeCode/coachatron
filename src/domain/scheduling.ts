import type { DbClient } from '../db/client.js';
import { resolveTypedPlace } from './locations.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset at an instant, in ms (Chicago in summer: -5h). */
function offsetAt(instantMs: number, tz: string): number {
  let dtf = offsetFormats.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormats.set(tz, dtf);
  }
  const parts = Object.fromEntries(dtf.formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Converts a wall-clock date/time in an IANA timezone to a UTC Date, using
 * only Intl (no date library dependency). The offsets in force a day before
 * and a day after are each tried, and the one that gives back the same wall
 * clock wins, so a time on the day the clocks change keeps its clock time.
 * As Postgres reads them: a time that happens twice (the hour repeated in
 * the fall) is the second of the two, and a time the spring change skips
 * (2:30am) moves forward by the gap. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const before = offsetAt(wall - DAY_MS, tz);
  const after = offsetAt(wall + DAY_MS, tz);
  const candidates = [wall - before, wall - after].filter((t, i) => offsetAt(t, tz) === (i === 0 ? before : after));
  return new Date(candidates.length > 0 ? Math.max(...candidates) : wall - before);
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
}

/** Calendar + clock parts of an instant in an IANA zone. hour is 0–23. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_NAMES.indexOf(parts.weekday ?? ''),
  };
}

/** No non-urgent SMS between 9pm and 8am local (SPEC.md §10). */
const QUIET_END_HOUR = 8;
const QUIET_START_HOUR = 21;

export function inQuietHours(now: Date, tz: string): boolean {
  const hour = zonedParts(now, tz).hour;
  return hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR;
}

/** The next 8am in `tz` after `now`: today's before 8am, otherwise
 * tomorrow's. In quiet hours, that is when they end. */
export function nextQuietHoursEnd(now: Date, tz: string): Date {
  const local = zonedParts(now, tz);
  const day = local.hour < QUIET_END_HOUR ? local : addCalendarDays(local.year, local.month, local.day, 1);
  return zonedTimeToUtc(day.year, day.month, day.day, QUIET_END_HOUR, 0, tz);
}

export function addCalendarDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

export interface WeeklySlot {
  /** 0 = Sunday .. 6 = Saturday, in the coach's tz */
  weekday: number;
  /** "HH:MM" 24-hour, local to the coach's tz */
  timeLocal: string;
  /** A place as the coach typed it. Words that match one of the type's
   * saved locations use it, a new place is saved while the type is under
   * its limit, and past the limit the words stay on this weekly time only
   * (resolveTypedPlace). */
  locationText?: string | null;
  /** One of the session type's saved locations, picked from its list. When
   * set, locationText is not read. */
  locationId?: number | null;
}

export interface SlotRow {
  id: number;
  session_type_id: number;
  weekday: number;
  time_local: string;
  /** The saved location's name, or the weekly time's own words. */
  location_text: string | null;
  /** The saved location those words came from, when there is one. */
  location_id?: number | null;
  /** That location's address line. */
  location_address?: string | null;
}

const SLOT_COLUMNS = 'id, session_type_id, weekday, time_local, location_text, location_id, location_address';

/** Writes a new weekly time with its place. A saved location (picked, or
 * the one typed words belong to) is read under a lock as the row is
 * written, so the weekly time takes its name and address line as they
 * stand: a rename at that moment is either in them or reaches the new
 * weekly time itself, and a removal either sees it or goes first. When the
 * location is gone by then, a picked one leaves the weekly time with no
 * place and typed words stay as the weekly time's own. */
async function insertSlot(db: DbClient, sessionTypeId: number, slot: WeeklySlot): Promise<SlotRow> {
  const typed = slot.locationId != null ? null : await resolveTypedPlace(db, sessionTypeId, slot.locationText);
  const locationId = slot.locationId ?? typed?.locationId ?? null;
  if (locationId !== null) {
    const saved = await db.query<SlotRow>(
      `insert into weekly_slot (session_type_id, weekday, time_local, location_text, location_id, location_address)
       select $1, $2, $3, l.name, l.id, l.address
       from session_type_location l
       where l.id = $4 and l.session_type_id = $1 and l.removed_at is null
       for share of l
       returning ${SLOT_COLUMNS}`,
      [sessionTypeId, slot.weekday, slot.timeLocal, locationId],
    );
    if (saved.rows[0]) return saved.rows[0];
  }
  const inserted = await db.query<SlotRow>(
    `insert into weekly_slot (session_type_id, weekday, time_local, location_text)
     values ($1, $2, $3, $4)
     returning ${SLOT_COLUMNS}`,
    [sessionTypeId, slot.weekday, slot.timeLocal, typed?.text ?? null],
  );
  return inserted.rows[0];
}

/** How far ahead a weekly slot keeps sessions on the calendar (SPEC.md §7.1). */
export const SLOT_HORIZON_DAYS = 56;

/** Saves weekly slots for a session type and fills their first 8 weeks. A
 * weekday and time the type already has is not added again: the slot that
 * is there is kept, and returned in its place (once, however often it was
 * asked for). */
export async function createWeeklySlots(
  db: DbClient,
  sessionTypeId: number,
  tz: string,
  slots: WeeklySlot[],
  now: Date,
): Promise<SlotRow[]> {
  const created: SlotRow[] = [];
  for (const slot of slots) {
    const existing = await db.query<SlotRow>(
      `select ${SLOT_COLUMNS}
       from weekly_slot
       where session_type_id = $1 and weekday = $2 and time_local = $3 and active = true
       order by id
       limit 1`,
      [sessionTypeId, slot.weekday, slot.timeLocal],
    );
    const row = existing.rows[0] ?? (await insertSlot(db, sessionTypeId, slot));
    await ensureSlotSessions(db, row, tz, now);
    if (!created.some((c) => c.id === row.id)) created.push(row);
  }
  return created;
}

/** Creates the slot's sessions from today through the horizon. Walks
 * calendar days in the coach's tz (DST-safe via addCalendarDays). A day that
 * already has a session from this slot, at any time and in any state, is
 * left alone, so running it again never duplicates a session, and a session
 * the coach cancelled is not put back. Returns how many sessions it added.
 *
 * Each session takes the weekly time's place as it stands when the session
 * is written (its words, its saved location and the address line), all read
 * from the weekly time's own row under a lock. A rename of the location at
 * that moment waits for the new session and then renames it too, or goes
 * first and the session is written with the new words. */
export async function ensureSlotSessions(
  db: DbClient,
  slot: SlotRow,
  tz: string,
  now: Date,
  horizonDays = SLOT_HORIZON_DAYS,
): Promise<number> {
  const today = zonedParts(now, tz);
  const [hour, minute] = slot.time_local.split(':').map(Number);
  let added = 0;
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const d = addCalendarDays(today.year, today.month, today.day, offset);
    if (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() !== slot.weekday) continue;
    const startsAtUtc = zonedTimeToUtc(d.year, d.month, d.day, hour, minute, tz);
    if (startsAtUtc <= now) continue;
    const next = addCalendarDays(d.year, d.month, d.day, 1);
    const dayStart = zonedTimeToUtc(d.year, d.month, d.day, 0, 0, tz);
    const dayEnd = zonedTimeToUtc(next.year, next.month, next.day, 0, 0, tz);
    const result = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, location_text, location_id, location_address, weekly_slot_id, status)
       select ws.session_type_id, $1, $2, ws.location_text, ws.location_id, ws.location_address, ws.id, 'scheduled'
       from weekly_slot ws
       where ws.id = $3 and not exists (
         select 1 from session where weekly_slot_id = $3 and starts_at_utc >= $4 and starts_at_utc < $5
       )
       for share of ws
       on conflict (weekly_slot_id, starts_at_utc) do nothing
       returning id`,
      [startsAtUtc.toISOString(), tz, slot.id, dayStart.toISOString(), dayEnd.toISOString()],
    );
    added += result.rows.length;
  }
  return added;
}

/** Tick step: keeps every active slot of an active session type 8 weeks ahead. */
export async function topUpAllSlots(db: DbClient, now: Date): Promise<number> {
  const slots = await db.query<SlotRow & { tz: string }>(
    `select ws.id, ws.session_type_id, ws.weekday, ws.time_local, ws.location_text, ws.location_id, ws.location_address, c.tz
     from weekly_slot ws
     join session_type st on st.id = ws.session_type_id
     join coach c on c.id = st.coach_id
     where ws.active = true and st.active = true`,
  );
  let added = 0;
  for (const slot of slots.rows) {
    added += await ensureSlotSessions(db, slot, slot.tz, now);
  }
  return added;
}

export async function listWeeklySlots(db: DbClient, sessionTypeId: number): Promise<SlotRow[]> {
  const result = await db.query<SlotRow>(
    `select ${SLOT_COLUMNS}
     from weekly_slot
     where session_type_id = $1 and active = true
     order by weekday, time_local`,
    [sessionTypeId],
  );
  return result.rows;
}

/** Stops a weekly slot. Its future sessions with nobody booked are
 * cancelled quietly; sessions with bookings stay so the coach can cancel
 * them one at a time (which texts the athletes). Returns how many stayed,
 * or null if the slot is not this coach's. */
export async function deactivateSlot(db: DbClient, coachId: number, slotId: number, now: Date): Promise<number | null> {
  const owned = await db.query<{ id: number }>(
    `update weekly_slot ws set active = false
     from session_type st
     where ws.id = $1 and st.id = ws.session_type_id and st.coach_id = $2
     returning ws.id`,
    [slotId, coachId],
  );
  if (owned.rows.length === 0) return null;
  await db.query(
    `update session s set status = 'cancelled'
     where s.weekly_slot_id = $1 and s.status = 'scheduled' and s.starts_at_utc > $2
       and not exists (
         select 1 from booking b where b.session_id = s.id and b.status in ('booked', 'pending')
       )`,
    [slotId, now.toISOString()],
  );
  const kept = await db.query<{ n: string }>(
    `select count(*)::text as n from session
     where weekly_slot_id = $1 and status = 'scheduled' and starts_at_utc > $2`,
    [slotId, now.toISOString()],
  );
  return Number(kept.rows[0]?.n ?? '0');
}
