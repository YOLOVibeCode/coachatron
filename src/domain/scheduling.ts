import type { DbClient } from '../db/client.js';

/** Converts a wall-clock date/time in an IANA timezone to a UTC Date, using
 * only Intl (no date library dependency). Standard technique: format a UTC
 * guess in the target zone, measure the offset, and correct once. Good
 * enough for scheduling sessions weeks out; not sub-second precise across a
 * DST-transition instant, which does not occur for a coach's weekly grid. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(guess).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
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
  locationText?: string | null;
}

export interface SlotRow {
  id: number;
  session_type_id: number;
  weekday: number;
  time_local: string;
  location_text: string | null;
}

/** How far ahead a weekly slot keeps sessions on the calendar (SPEC.md §7.1). */
export const SLOT_HORIZON_DAYS = 56;

/** Saves weekly slots for a session type and fills their first 8 weeks. */
export async function createWeeklySlots(
  db: DbClient,
  sessionTypeId: number,
  tz: string,
  slots: WeeklySlot[],
  now: Date,
): Promise<SlotRow[]> {
  const created: SlotRow[] = [];
  for (const slot of slots) {
    const result = await db.query<SlotRow>(
      `insert into weekly_slot (session_type_id, weekday, time_local, location_text)
       values ($1, $2, $3, $4)
       returning id, session_type_id, weekday, time_local, location_text`,
      [sessionTypeId, slot.weekday, slot.timeLocal, slot.locationText ?? null],
    );
    const row = result.rows[0];
    await ensureSlotSessions(db, row, tz, now);
    created.push(row);
  }
  return created;
}

/** Creates the slot's sessions from today through the horizon. Walks
 * calendar days in the coach's tz (DST-safe via addCalendarDays) and relies
 * on the (weekly_slot_id, starts_at_utc) unique index, so running it again
 * never duplicates a session. Returns how many sessions it added. */
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
    const result = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, location_text, weekly_slot_id, status)
       values ($1, $2, $3, $4, $5, 'scheduled')
       on conflict (weekly_slot_id, starts_at_utc) do nothing
       returning id`,
      [slot.session_type_id, startsAtUtc.toISOString(), tz, slot.location_text, slot.id],
    );
    added += result.rows.length;
  }
  return added;
}

/** Tick step: keeps every active slot of an active session type 8 weeks ahead. */
export async function topUpAllSlots(db: DbClient, now: Date): Promise<number> {
  const slots = await db.query<SlotRow & { tz: string }>(
    `select ws.id, ws.session_type_id, ws.weekday, ws.time_local, ws.location_text, c.tz
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
    `select id, session_type_id, weekday, time_local, location_text
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
