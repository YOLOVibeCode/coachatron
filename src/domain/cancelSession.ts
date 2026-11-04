import { inTransaction, type DbClient } from '../db/client.js';
import { formatConfirmWhen, formatLocal } from '../lib/time.js';
import { OPT_OUT_LINE, canText, sendText, toOneSegment } from './outbound.js';
import { cancelledSessionCreditSource, createCredit } from './pricing.js';
import { plain } from './bookingMessages.js';
import { hasActiveConsent } from './sms-consent.js';

/** A coach's cancel of one session (web and text assistant). Each step can
 * be run again safely, so a cancel that stopped part way finishes on the
 * next try: the session closes first, then each booking is cancelled and
 * its credit returned together (a package or pack credit goes back, and a
 * paid drop-in becomes one session credit with the coach), then each
 * parent is texted, and a text that fails for one parent never stops the
 * others. How each parent was reached is kept on the booking, so the coach
 * can see who still needs to be told. */

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
  /** Of those credits, how many are paid drop-ins that became a credit. */
  dropInCredits: number;
  unreached: UnreachedParent[];
}

export type CancelSessionResult =
  | { kind: 'not_found' }
  | { kind: 'already_started' }
  | { kind: 'already_cancelled' }
  | ({ kind: 'cancelled' } & CancelReach);

const LIVE = "('booked', 'attended', 'noshow')";

/** A drop-in the parent paid for, as opposed to a free one. */
function paidDropIn(b: { payment_source: string | null; gross_cents: number | null }): boolean {
  return b.payment_source === 'DropIn' && (b.gross_cents ?? 0) > 0;
}

/** The parent's text: the cancel, and the credit they now hold with the
 * coach when there is one. With a credit the text uses the compact time and
 * keeps the credit line whole; if it would still not fit one segment, the
 * athlete's name at the end of the first part is what gets shortened. */
function cancelText(
  booking: { athlete_name: string; payment_source: string | null; credit_id: number | null },
  session: { name: string; starts_at_utc: string; tz: string; coach_name: string },
): string {
  if (booking.credit_id === null) {
    return `${booking.athlete_name}'s ${session.name} on ${formatLocal(session.starts_at_utc, session.tz)} has been cancelled.`;
  }
  const dropIn = booking.payment_source === 'DropIn';
  const withCoach = dropIn
    ? `Your payment is now 1 session credit with ${session.coach_name}.`
    : `Your session credit with ${session.coach_name} is back.`;
  const credit = withCoach.length <= 70 ? withCoach : dropIn ? 'Your payment is now 1 session credit.' : 'Your session credit is back.';
  const tail = ` ${plain(credit)}`;
  const when = formatConfirmWhen(new Date(session.starts_at_utc).toISOString(), session.tz);
  const cancelled = plain(`Coachatron: ${session.name} on ${when} is cancelled for ${booking.athlete_name}.`);
  return `${toOneSegment(cancelled, tail.length + OPT_OUT_LINE.length + 1)}${tail}`;
}

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
    coach_name: string;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, s.status, c.name as coach_name
     from session s
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
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
  // at a time. A package or pack booking gets its credit back; a paid
  // drop-in becomes one session credit with the coach, kept on the booking
  // like the others. The status check makes a second run a no-op for it.
  const live = await db.query<{ id: number }>(`select id from booking where session_id = $1 and status in ${LIVE} order by id`, [
    sessionId,
  ]);
  for (const booking of live.rows) {
    await inTransaction(db, async (tx) => {
      const closed = await tx.query<{ credit_id: number | null; payment_source: string | null; gross_cents: number | null; contact_phone: string }>(
        `update booking set status = 'cancelled', cancel_notice = 'pending'
         where id = $1 and status in ${LIVE}
         returning credit_id, payment_source, gross_cents, contact_phone`,
        [booking.id],
      );
      const b = closed.rows[0];
      if (!b) return;
      if (b.credit_id !== null) {
        await tx.query('update credit set remaining = remaining + 1 where id = $1', [b.credit_id]);
      } else if (paidDropIn(b)) {
        const creditId = await createCredit(tx, coachId, b.contact_phone, null, cancelledSessionCreditSource(sessionId), 1, null);
        await tx.query('update booking set credit_id = $2 where id = $1', [booking.id, creditId]);
      }
    });
  }

  // 3. Tell each parent. Claiming the booking first keeps a second run from
  // texting anyone twice; a failed send is recorded and the loop goes on.
  const toTell = await db.query<{ id: number; athlete_name: string; contact_phone: string; payment_source: string | null; credit_id: number | null }>(
    "select id, athlete_name, contact_phone, payment_source, credit_id from booking where session_id = $1 and cancel_notice = 'pending' order by id",
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
        body: cancelText(booking, row),
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

/** Says how many of the returned credits are paid drop-ins, which become a
 * session credit when the coach cancels. Empty when there are none. */
export function dropInCreditNote(reach: Pick<CancelReach, 'dropInCredits'>): string {
  if (reach.dropInCredits === 0) return '';
  return reach.dropInCredits === 1 ? ', 1 of them for a paid drop-in' : `, ${reach.dropInCredits} of them for paid drop-ins`;
}

/** Who a session's cancel reached, read back from the bookings, so it is
 * the same on the confirmation and on the session screen later. */
export async function cancelReach(db: DbClient, sessionId: number): Promise<CancelReach> {
  const rows = await db.query<{
    id: number;
    athlete_name: string;
    contact_phone: string;
    cancel_notice: string;
    credit_id: number | null;
    payment_source: string | null;
  }>(
    `select id, athlete_name, contact_phone, cancel_notice, credit_id, payment_source from booking
     where session_id = $1 and cancel_notice is not null
     order by id`,
    [sessionId],
  );
  const unreached: UnreachedParent[] = [];
  let notified = 0;
  let credits = 0;
  let dropInCredits = 0;
  for (const r of rows.rows) {
    if (r.credit_id !== null) credits += 1;
    if (r.credit_id !== null && r.payment_source === 'DropIn') dropInCredits += 1;
    if (r.cancel_notice === 'texted') {
      notified += 1;
      continue;
    }
    const reason: UnreachedParent['reason'] =
      r.cancel_notice === 'no-texts' || r.cancel_notice === 'not-sent' ? r.cancel_notice : 'failed';
    unreached.push({ bookingId: r.id, athleteName: r.athlete_name, contactPhone: r.contact_phone, reason });
  }
  return { athletesTotal: rows.rows.length, athletesNotified: notified, creditsReturned: credits, dropInCredits, unreached };
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
