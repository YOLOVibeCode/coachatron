import type { DbClient } from '../db/client.js';
import { formatLocal } from '../lib/time.js';
import { canText, sendText } from './outbound.js';
import { hasActiveConsent } from './sms-consent.js';

/** A coach's cancel of one session (web and text assistant). Each step can
 * be run again safely, so a cancel that stopped part way finishes on the
 * next try: the session closes first, then each booking is cancelled and
 * its credit returned in one statement, then each parent is texted, and a
 * text that fails for one parent never stops the others. How each parent
 * was reached is kept on the booking, so the coach can see who still needs
 * to be told. */

export type CancelNotice = 'texted' | 'no-texts' | 'not-sent' | 'failed';

export interface UnreachedParent {
  bookingId: number;
  athleteName: string;
  contactPhone: string;
  reason: Exclude<CancelNotice, 'texted'>;
}

export interface CancelReach {
  /** Parents whose booking this cancel closed. */
  athletesTotal: number;
  /** Of those, how many were texted. */
  athletesNotified: number;
  creditsReturned: number;
  unreached: UnreachedParent[];
}

export type CancelSessionResult =
  | { kind: 'not_found' }
  | { kind: 'already_started' }
  | { kind: 'already_cancelled' }
  | ({ kind: 'cancelled' } & CancelReach);

const LIVE = "('booked', 'attended', 'noshow')";

async function hasUnfinishedWork(db: DbClient, sessionId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    `select id from booking where session_id = $1 and (status in ${LIVE} or cancel_notice = 'pending') limit 1`,
    [sessionId],
  );
  return result.rows.length > 0;
}

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
  if (row.status === 'cancelled') {
    // Finish a cancel that stopped part way; otherwise there is nothing to do.
    if (!(await hasUnfinishedWork(db, sessionId))) return { kind: 'already_cancelled' };
  } else if (row.status !== 'scheduled') {
    return { kind: 'not_found' };
  } else if (new Date(row.starts_at_utc) < new Date()) {
    return { kind: 'already_started' };
  }

  // 1. Close the session, so nothing new is booked into it from here on.
  await db.query("update session set status = 'cancelled' where id = $1 and status = 'scheduled'", [sessionId]);

  // 2. Cancel each live booking and return its credit together, one booking
  // at a time. The status check makes a second run a no-op for it.
  const live = await db.query<{ id: number }>(`select id from booking where session_id = $1 and status in ${LIVE} order by id`, [
    sessionId,
  ]);
  for (const booking of live.rows) {
    await db.query(
      `with b as (
         update booking set status = 'cancelled', cancel_notice = 'pending'
         where id = $1 and status in ${LIVE}
         returning credit_id
       )
       update credit set remaining = remaining + 1 where id = (select credit_id from b)`,
      [booking.id],
    );
  }

  // 3. Tell each parent. Claiming the booking first keeps a second run from
  // texting anyone twice; a failed send is recorded and the loop goes on.
  const toTell = await db.query<{ id: number; athlete_name: string; contact_phone: string }>(
    "select id, athlete_name, contact_phone from booking where session_id = $1 and cancel_notice = 'pending' order by id",
    [sessionId],
  );
  for (const booking of toTell.rows) {
    const claimed = await db.query<{ id: number }>(
      "update booking set cancel_notice = 'sending' where id = $1 and cancel_notice = 'pending' returning id",
      [booking.id],
    );
    if (claimed.rows.length === 0) continue;
    let notice: CancelNotice;
    try {
      const outcome = await sendText(db, {
        to: booking.contact_phone,
        body: `${booking.athlete_name}'s ${row.name} on ${formatLocal(row.starts_at_utc, row.tz)} has been cancelled.`,
        coachId,
        template: 'session-cancelled',
      });
      notice = outcome === 'sent' ? 'texted' : outcome === 'capped' ? 'not-sent' : 'no-texts';
    } catch (err) {
      notice = 'failed';
      console.error(`cancel: text for booking ${booking.id} failed:`, err instanceof Error ? err.message : err);
    }
    await db.query('update booking set cancel_notice = $2 where id = $1', [booking.id, notice]);
  }

  return { kind: 'cancelled', ...(await cancelReach(db, sessionId)) };
}

/** Who a session's cancel reached, read back from the bookings, so it is
 * the same on the confirmation and on the session screen later. */
export async function cancelReach(db: DbClient, sessionId: number): Promise<CancelReach> {
  const rows = await db.query<{ id: number; athlete_name: string; contact_phone: string; cancel_notice: string; credit_id: number | null }>(
    `select id, athlete_name, contact_phone, cancel_notice, credit_id from booking
     where session_id = $1 and cancel_notice is not null
     order by id`,
    [sessionId],
  );
  const unreached: UnreachedParent[] = [];
  let notified = 0;
  let credits = 0;
  for (const r of rows.rows) {
    if (r.credit_id !== null) credits += 1;
    if (r.cancel_notice === 'texted') {
      notified += 1;
      continue;
    }
    const reason: UnreachedParent['reason'] =
      r.cancel_notice === 'no-texts' || r.cancel_notice === 'not-sent' ? r.cancel_notice : 'failed';
    unreached.push({ bookingId: r.id, athleteName: r.athlete_name, contactPhone: r.contact_phone, reason });
  }
  return { athletesTotal: rows.rows.length, athletesNotified: notified, creditsReturned: credits, unreached };
}

/** Bookings that would be cancelled if the coach confirms now, and how many
 * of those parents can be texted. */
export async function previewSessionCancel(db: DbClient, sessionId: number): Promise<{ total: number; textable: number }> {
  const result = await db.query<{ contact_phone: string }>(`select contact_phone from booking where session_id = $1 and status in ${LIVE}`, [
    sessionId,
  ]);
  let textable = 0;
  for (const r of result.rows) {
    if (canText(r.contact_phone) && (await hasActiveConsent(db, r.contact_phone))) textable += 1;
  }
  return { total: result.rows.length, textable };
}

/** Bookings that would be cancelled and texted if the coach confirms now. */
export async function countSessionCancelNotifyAthletes(db: DbClient, sessionId: number): Promise<number> {
  return (await previewSessionCancel(db, sessionId)).total;
}
