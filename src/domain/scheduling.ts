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

export interface WeeklySlot {
  /** 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay via the coach's tz */
  weekday: number;
  /** "HH:MM" 24-hour, local to the coach's tz */
  timeLocal: string;
}

export interface SessionTypeRow {
  id: number;
  coach_id: number;
  name: string;
  duration_min: number;
  capacity: number;
  price_cents: number;
}

/** Generates session rows for the next 7 days starting today (coach's tz),
 * for each requested weekly slot whose weekday falls in that window. */
export async function generateWeekSessions(
  db: DbClient,
  sessionType: SessionTypeRow,
  tz: string,
  slots: WeeklySlot[],
  now: Date,
): Promise<number[]> {
  const created: number[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const dayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(day);
    const get = (type: string) => dayParts.find((p) => p.type === type)?.value ?? '';
    const weekdayName = get('weekday');
    const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
    const year = Number(get('year'));
    const month = Number(get('month'));
    const dayOfMonth = Number(get('day'));

    for (const slot of slots) {
      if (slot.weekday !== weekdayIndex) continue;
      const [hourStr, minuteStr] = slot.timeLocal.split(':');
      const startsAtUtc = zonedTimeToUtc(year, month, dayOfMonth, Number(hourStr), Number(minuteStr), tz);
      const result = await db.query<{ id: number }>(
        `insert into session (session_type_id, starts_at_utc, tz, status)
         values ($1, $2, $3, 'scheduled') returning id`,
        [sessionType.id, startsAtUtc.toISOString(), tz],
      );
      created.push(result.rows[0].id);
    }
  }
  return created;
}
