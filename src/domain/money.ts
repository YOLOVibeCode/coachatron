import type { DbClient } from '../db/client.js';

export interface MoneySummary {
  bookedThisWeekCount: number;
  bookedThisWeekCents: number;
  collectedThisWeekCents: number;
  outstandingCreditCount: number;
  nextWeekCount: number;
  nextWeekCents: number;
}

/** Get the Monday of the week containing `date` in the given timezone. */
function getMondayOfWeek(date: Date, tz: string): Date {
  const d = new Date(date);
  const day = d.getDay();
  // Adjust for Sunday (0) to make Monday the start of week
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Get the Sunday of the week containing `date` in the given timezone. */
function getSundayOfWeek(date: Date, tz: string): Date {
  const monday = getMondayOfWeek(date, tz);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

/** Get the Monday of next week in the given timezone. */
function getNextWeekMonday(date: Date, tz: string): Date {
  const monday = getMondayOfWeek(date, tz);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  return nextMonday;
}

export async function summarizeMoney(db: DbClient, coachId: number, now: Date): Promise<MoneySummary> {
  // Get coach timezone
  const coachResult = await db.query<{ tz: string }>('select tz from coach where id = $1', [coachId]);
  const tz = coachResult.rows[0]?.tz ?? 'America/Chicago';

  const monday = getMondayOfWeek(now, tz);
  const sunday = getSundayOfWeek(now, tz);
  const nextWeekMonday = getNextWeekMonday(now, tz);

  // Booked this week: sessions starting between Monday and Sunday
  const bookedThisWeekResult = await db.query<{ count: number; total_cents: number }>(
    `select 
      coalesce(count(*), 0) as count,
      coalesce(sum(st.price_cents), 0) as total_cents
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and s.status = 'scheduled'
       and s.starts_at_utc >= $2
       and s.starts_at_utc <= $3`,
    [coachId, monday.toISOString(), sunday.toISOString()],
  );

  // Collected this week: bookings with gross_cents recorded during the week
  const collectedThisWeekResult = await db.query<{ total_gross_cents: number }>(
    `select coalesce(sum(b.gross_cents), 0) as total_gross_cents
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and b.status = 'booked'
       and b.gross_cents is not null
       and s.starts_at_utc >= $2
       and s.starts_at_utc <= $3`,
    [coachId, monday.toISOString(), sunday.toISOString()],
  );

  // Outstanding package credits: sum of remaining credits for this coach
  const outstandingCreditsResult = await db.query<{ total_remaining: number }>(
    `select coalesce(sum(remaining), 0) as total_remaining
     from credit
     where coach_id = $1`,
    [coachId],
  );

  // Next week's projected sessions
  const nextWeekResult = await db.query<{ count: number; total_cents: number }>(
    `select 
      coalesce(count(*), 0) as count,
      coalesce(sum(st.price_cents), 0) as total_cents
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and s.status = 'scheduled'
       and s.starts_at_utc >= $2`,
    [coachId, nextWeekMonday.toISOString()],
  );

  return {
    bookedThisWeekCount: Number(bookedThisWeekResult.rows[0]?.count ?? 0),
    bookedThisWeekCents: Number(bookedThisWeekResult.rows[0]?.total_cents ?? 0),
    collectedThisWeekCents: Number(collectedThisWeekResult.rows[0]?.total_gross_cents ?? 0),
    outstandingCreditCount: Number(outstandingCreditsResult.rows[0]?.total_remaining ?? 0),
    nextWeekCount: Number(nextWeekResult.rows[0]?.count ?? 0),
    nextWeekCents: Number(nextWeekResult.rows[0]?.total_cents ?? 0),
  };
}
