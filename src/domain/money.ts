import type { DbClient } from '../db/client.js';
import { zonedTimeToUtc } from './scheduling.js';

export interface MoneySummary {
  bookedThisWeekCount: number;
  bookedThisWeekCents: number;
  collectedThisWeekCents: number;
  outstandingCreditCount: number;
  nextWeekCount: number;
  nextWeekCents: number;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0 = Sunday .. 6 = Saturday
}

/** Reads the calendar date (and weekday) that `date` falls on in `tz`,
 * using the same Intl.DateTimeFormat technique as scheduling.ts, so "this
 * week" and "next week" are computed in the coach's own timezone rather
 * than the server process's local time. */
function localDateParts(date: Date, tz: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_NAMES.indexOf(get('weekday')),
  };
}

/** Adds `deltaDays` calendar days to a Y/M/D, using a fixed noon-UTC
 * anchor purely for the rollover arithmetic (month/year boundaries) — this
 * is calendar-date math, not wall-clock math, so it is not affected by any
 * timezone's DST transitions. */
function addCalendarDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

/** Midnight on the Monday of the week containing `date`, in `tz`, as a UTC
 * instant. Re-derives the correct UTC offset for that specific calendar
 * day (via zonedTimeToUtc) rather than assuming a fixed 24h/day, so it is
 * correct across a DST transition inside the week. */
function startOfWeekUtc(date: Date, tz: string): Date {
  const { year, month, day, weekday } = localDateParts(date, tz);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addCalendarDays(year, month, day, -daysSinceMonday);
  return zonedTimeToUtc(monday.year, monday.month, monday.day, 0, 0, tz);
}

function addWeeksUtc(weekStartUtc: Date, tz: string, weeks: number): Date {
  const { year, month, day } = localDateParts(weekStartUtc, tz);
  const shifted = addCalendarDays(year, month, day, weeks * 7);
  return zonedTimeToUtc(shifted.year, shifted.month, shifted.day, 0, 0, tz);
}

interface SessionAggregate {
  count: number;
  totalCents: number;
}

/** Counts session *slots* the coach has scheduled in a window, regardless
 * of whether anyone has booked them yet - used for "next week's
 * projected," which is about capacity the coach has put up, not demand. */
async function aggregateSessionSlots(db: DbClient, coachId: number, from: Date, to: Date): Promise<SessionAggregate> {
  const result = await db.query<{ count: string; total_cents: string }>(
    `select count(*)::text as count, coalesce(sum(st.price_cents), 0)::text as total_cents
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and s.status = 'scheduled'
       and s.starts_at_utc >= $2
       and s.starts_at_utc < $3`,
    [coachId, from.toISOString(), to.toISOString()],
  );
  return { count: Number(result.rows[0]?.count ?? '0'), totalCents: Number(result.rows[0]?.total_cents ?? '0') };
}

/** Counts live bookings (not session slots) on sessions in a window - used
 * for "booked this week," which is about demand actually realized: three
 * athletes booked into one session slot is 3 booked, not 1. Cents is the
 * booked session type's nominal price per booking (what was booked),
 * distinct from `collected`, which is what was actually charged. */
async function aggregateBookings(db: DbClient, coachId: number, from: Date, to: Date): Promise<SessionAggregate> {
  const result = await db.query<{ count: string; total_cents: string }>(
    `select count(*)::text as count, coalesce(sum(st.price_cents), 0)::text as total_cents
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and b.status = 'booked'
       and s.starts_at_utc >= $2
       and s.starts_at_utc < $3`,
    [coachId, from.toISOString(), to.toISOString()],
  );
  return { count: Number(result.rows[0]?.count ?? '0'), totalCents: Number(result.rows[0]?.total_cents ?? '0') };
}

/** Read-only summary for the Money screen (SPEC.md §7.4): booked this
 * week, collected this week, outstanding package credits, next week's
 * projection. No balance, no payout figure - Coachatron never holds
 * funds and never will (SPEC.md §5, P5). */
export async function summarizeMoney(db: DbClient, coachId: number, now: Date): Promise<MoneySummary> {
  const coachRows = await db.query<{ tz: string }>('select tz from coach where id = $1', [coachId]);
  const tz = coachRows.rows[0]?.tz ?? 'America/Chicago';

  const thisWeekStart = startOfWeekUtc(now, tz);
  const nextWeekStart = addWeeksUtc(thisWeekStart, tz, 1);
  const weekAfterNextStart = addWeeksUtc(thisWeekStart, tz, 2);

  const [booked, nextWeek, collected, outstanding] = await Promise.all([
    aggregateBookings(db, coachId, thisWeekStart, nextWeekStart),
    aggregateSessionSlots(db, coachId, nextWeekStart, weekAfterNextStart),
    // "Collected" is the actual gross amount charged (booking.gross_cents,
    // null/0 for a credit redemption that charged nothing new this time)
    // for the same live bookings counted above.
    db.query<{ total_gross_cents: string }>(
      `select coalesce(sum(b.gross_cents), 0)::text as total_gross_cents
       from booking b
       join session s on s.id = b.session_id
       join session_type st on st.id = s.session_type_id
       where st.coach_id = $1
         and b.status = 'booked'
         and s.starts_at_utc >= $2
         and s.starts_at_utc < $3`,
      [coachId, thisWeekStart.toISOString(), nextWeekStart.toISOString()],
    ),
    // Outstanding credits are a liability regardless of expiry - an
    // expired-but-unused credit is still money the coach was paid and
    // owes a session for until it's formally written off (Slice 1 has no
    // write-off flow), so the Money screen counts all of it.
    db.query<{ total_remaining: string }>('select coalesce(sum(remaining), 0)::text as total_remaining from credit where coach_id = $1', [
      coachId,
    ]),
  ]);

  return {
    bookedThisWeekCount: booked.count,
    bookedThisWeekCents: booked.totalCents,
    collectedThisWeekCents: Number(collected.rows[0]?.total_gross_cents ?? '0'),
    outstandingCreditCount: Number(outstanding.rows[0]?.total_remaining ?? '0'),
    nextWeekCount: nextWeek.count,
    nextWeekCents: nextWeek.totalCents,
  };
}
