import type { DbClient } from '../db/client.js';
import { formatLocal } from '../lib/time.js';
import { sendText } from './outbound.js';

export type CancelSessionResult =
  | { kind: 'not_found' }
  | { kind: 'already_started' }
  | { kind: 'already_cancelled' }
  | { kind: 'cancelled'; athletesNotified: number; creditsReturned: number };

export async function cancelScheduledSession(
  db: DbClient,
  coachId: number,
  sessionId: number,
): Promise<CancelSessionResult> {
  const session = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
    status: string;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, s.status
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2`,
    [sessionId, coachId],
  );
  const row = session.rows[0];
  if (!row) return { kind: 'not_found' };
  if (row.status === 'cancelled') return { kind: 'already_cancelled' };
  if (row.status !== 'scheduled') return { kind: 'not_found' };
  if (new Date(row.starts_at_utc) < new Date()) return { kind: 'already_started' };

  const cancelled = await db.query<{
    contact_phone: string;
    athlete_name: string;
    credit_id: number | null;
  }>(
    `update booking set status = 'cancelled'
     where session_id = $1 and status in ('booked', 'attended', 'noshow')
     returning contact_phone, athlete_name, credit_id`,
    [sessionId],
  );

  let creditsReturned = 0;
  for (const athlete of cancelled.rows) {
    if (athlete.credit_id) {
      await db.query('update credit set remaining = remaining + 1 where id = $1', [athlete.credit_id]);
      creditsReturned += 1;
    }
    await sendText(db, {
      to: athlete.contact_phone,
      body: `${athlete.athlete_name}'s ${row.name} on ${formatLocal(row.starts_at_utc, row.tz)} has been cancelled.`,
      coachId,
      template: 'session-cancelled',
    });
  }

  await db.query("update session set status = 'cancelled' where id = $1 and status = 'scheduled'", [sessionId]);

  return { kind: 'cancelled', athletesNotified: cancelled.rows.length, creditsReturned };
}

/** Bookings that would be cancelled and texted if the coach confirms now. */
export async function countSessionCancelNotifyAthletes(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from booking
     where session_id = $1 and status in ('booked', 'attended', 'noshow')`,
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
