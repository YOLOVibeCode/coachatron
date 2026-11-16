import type { DbClient } from '../db/client.js';
import { findCoachById } from './auth.js';
import { cancelByParent, cancelTerms, CREDIT_WITHDRAWN_SQL, type CancelGives, type ParentCancel } from './policy.js';
import { checkRefund, giveUpOnRefund, requestRefund, usesOwnSession, type BoughtBooking, type RefundBlock, type RefundRequestOutcome } from './refunds.js';

/**
 * The coach-set refund policy (SPEC.md §9.5). A coach chooses what a
 * parent's cancel before the cancellation window gives back for a session
 * paid by card: one session credit, as before, or the payment back to the
 * card. The choice in force when a booking is made is kept on the booking
 * (`booking.cancel_gives`), so a parent gets what the page said when they
 * paid, whatever the coach chooses later.
 *
 * A cancel that gives a refund asks for it through the coach's own refund
 * path (`requestRefund` in refunds.ts), never a second one: the cancel
 * becomes a session credit that the refund holds from the start, the relay
 * is asked once under the payment's key, and the refund's effects (the
 * booking reads refunded, the credit is withdrawn, the parent is told once)
 * are applied by the same code as a coach's refund. A refund that does not
 * go through releases the credit to the parent, and the coach sees the
 * payment under "Payments to resolve" with the usual way to try again.
 *
 * A refund is of a whole payment (SPEC.md §9.4). So a cancel gives one only
 * when nothing else the payment bought still stands or was used: with
 * several children on one payment, a child's cancel gives a session credit
 * until the last of them is cancelled in time.
 */

/** Bookings that were sold and still hold a spot. */
const LIVE = new Set(['booked', 'attended', 'noshow']);

/** Why a cancel in time gives a session credit and not a refund. */
export type CreditReason =
  /** The booking was made while the coach's choice was a session credit. */
  | 'policy'
  /** Other children the payment paid for are still booked. */
  | 'others-booked'
  /** A session the payment bought was used: by a late cancel or a no-show
   * of another child, or by a credit one of them became. */
  | 'session-used'
  /** A refund of the payment is already on its way. */
  | 'refund-under-way'
  /** The payment cannot be refunded whole from here. */
  | 'not-refundable';

/** What a parent's cancel of this booking gives back now, while it is
 * before the window and the booking was paid by card. */
export type InTimeCancel =
  | {
      gives: 'refund';
      /** The whole payment. */
      amountCents: number | null;
      /** Every child the payment was for, this one included. */
      athletes: string[];
      /** Unused credits the other children's cancels left, withdrawn with it. */
      creditsWithdrawn: number;
    }
  | {
      gives: 'credit';
      why: CreditReason;
      /** The other children still booked, when that is why. */
      others: string[];
    };

interface CancelBooking {
  id: number;
  session_id: number;
  status: string;
  athlete_name: string;
  cancel_gives: string;
  charge_id: string | null;
  credit_id: number | null;
  payment_source: string | null;
  gross_cents: number | null;
  credit_withdrawn: boolean;
  starts_at_utc: string;
  coach_id: number;
  cancel_window_hours: number;
}

const CANCEL_BOOKING_SQL = `select b.id, b.session_id, b.status, b.athlete_name, b.cancel_gives, b.charge_id, b.credit_id, b.payment_source,
    b.gross_cents, ${CREDIT_WITHDRAWN_SQL}, s.starts_at_utc, st.coach_id, c.cancel_window_hours
  from booking b
  join session s on s.id = b.session_id
  join session_type st on st.id = s.session_type_id
  join coach c on c.id = st.coach_id
  where b.manage_token = $1`;

async function bookingByToken(db: DbClient, manageToken: string): Promise<CancelBooking | null> {
  return (await db.query<CancelBooking>(CANCEL_BOOKING_SQL, [manageToken])).rows[0] ?? null;
}

/** Why the coach's refund path would not refund this payment whole. */
function creditReason(block: RefundBlock): CreditReason {
  if (block.kind === 'credits_used') return 'session-used';
  if (block.kind === 'in_progress') return 'refund-under-way';
  return 'not-refundable';
}

/** Null when a cancel now is not an in-time cancel of a booking paid by
 * card: a booking that drew on a credit gets that credit back, a free one
 * has nothing to give back, and a late cancel uses the payment (§9.5). */
async function whatCancelGives(db: DbClient, b: CancelBooking, now: Date): Promise<InTimeCancel | null> {
  if (!LIVE.has(b.status)) return null;
  if (cancelTerms(b, b.cancel_window_hours, now) !== 'becomes-credit') return null;
  if (b.cancel_gives !== 'refund' || b.charge_id === null) return { gives: 'credit', why: 'policy', others: [] };
  // Every booking the payment bought: this one, and the other children of
  // its booking pass. The same set a refund of the payment covers.
  const bought = await db.query<BoughtBooking>(
    `select id, status, credit_id, gross_cents, athlete_name, late_cancel, waived_at from booking
     where charge_id = $1 and session_id = $2 order by id`,
    [b.charge_id, b.session_id],
  );
  const others = bought.rows.filter((x) => x.id !== b.id);
  const booked = others.filter((x) => LIVE.has(x.status));
  if (booked.length > 0) return { gives: 'credit', why: 'others-booked', others: booked.map((x) => x.athlete_name) };
  if (others.some(usesOwnSession)) return { gives: 'credit', why: 'session-used', others: [] };
  const check = await checkRefund(db, b.coach_id, { bookingId: b.id });
  if (!check.ok) return { gives: 'credit', why: creditReason(check.block), others: [] };
  return {
    gives: 'refund',
    amountCents: check.plan.amountCents,
    athletes: bought.rows.length > 0 ? bought.rows.map((x) => x.athlete_name) : [b.athlete_name],
    creditsWithdrawn: check.plan.creditsWithdrawn,
  };
}

/** What the manage page says before the parent confirms a cancel in time:
 * whether it gives a refund to their card (how much) or a session credit
 * (and why, when the booking was made under "a refund"). Null when a cancel
 * now is not an in-time cancel of a booking paid by card. */
export async function inTimeCancel(db: DbClient, manageToken: string, now: Date = new Date()): Promise<InTimeCancel | null> {
  const b = await bookingByToken(db, manageToken);
  return b ? whatCancelGives(db, b, now) : null;
}

export interface PolicyCancel {
  /** What the cancel did to the booking, as `cancelByParent` reports it. */
  result: ParentCancel;
  /** How the refund this cancel asked for went; null when it asked for none. */
  refund: Exclude<RefundRequestOutcome['kind'], 'blocked'> | null;
}

/** A parent cancels from the manage link, under the coach's booking policy.
 * When the cancel is in time and the booking was promised a refund, the
 * refund is asked for with the cancel: both are made in the refund claim's
 * one transaction, under the locks a coach's refund takes, so a cancel and
 * a coach's Refund tap at the same moment make one refund. Whenever that
 * claim does not go ahead (the coach's refund got there first, another
 * child's booking still stands, a session the payment bought was used, the
 * window closed meanwhile), nothing of it is kept and the cancel is made
 * the plain way: a session credit, exactly as before this policy. */
export async function cancelUnderPolicy(db: DbClient, manageToken: string, now: Date = new Date()): Promise<PolicyCancel> {
  const b = await bookingByToken(db, manageToken);
  const gives = b ? await whatCancelGives(db, b, now) : null;
  const coach = b && gives?.gives === 'refund' ? await findCoachById(db, b.coach_id) : null;
  if (b && coach) {
    const made: { sessionId: number | null } = { sessionId: null };
    const outcome = await requestRefund(db, coach, { bookingId: b.id }, {
      bookingId: b.id,
      cancel: async (tx, bought) => {
        // Decided again under the locks: a refund is of the whole payment,
        // so no other child's booking it paid for may still use its session.
        if (bought.some((x) => x.id !== b.id && usesOwnSession(x))) return false;
        // The one cancel there is, on this transaction. Anything but an
        // in-time cancel of a paid drop-in stops the claim, which undoes it.
        const result = await cancelByParent(tx, manageToken, now);
        if (result.kind !== 'cancelled' || result.terms !== 'becomes-credit') return false;
        made.sessionId = result.sessionId;
        return true;
      },
    });
    if (outcome.kind !== 'blocked' && made.sessionId !== null) {
      return { result: { kind: 'cancelled', terms: 'becomes-credit', sessionId: made.sessionId }, refund: outcome.kind };
    }
  }
  return { result: await cancelByParent(db, manageToken, now), refund: null };
}

/** A cancelled booking's refund, as its parent sees it: on its way (the
 * credit the cancel became is held and not offered), or failed after the
 * parent's cancel asked for it (the credit is theirs now). */
export interface CancelRefundState {
  state: 'on-its-way' | 'failed';
  amountCents: number | null;
  /** The credit the booking became can still be used. */
  creditLeft: boolean;
}

export async function cancelRefundState(db: DbClient, bookingId: number): Promise<CancelRefundState | null> {
  const result = await db.query<{
    status: string;
    amount_cents: number | null;
    refunded_at: string | null;
    cancel_booking_id: number | null;
    credit_refund_id: number | null;
    credit_withdrawn_at: string | null;
    credit_remaining: number | null;
  }>(
    `select r.status, r.amount_cents, r.refunded_at, r.cancel_booking_id,
            c.refund_id as credit_refund_id, c.withdrawn_at as credit_withdrawn_at, c.remaining as credit_remaining
     from booking b
     join refund r on r.payment_ref = b.charge_id
     join credit c on c.id = b.credit_id
     where b.id = $1 and b.status = 'cancelled'`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row || row.refunded_at !== null || row.credit_withdrawn_at !== null) return null;
  const held = row.credit_refund_id !== null;
  if (held && (row.status === 'requested' || row.status === 'pending')) {
    return { state: 'on-its-way', amountCents: row.amount_cents, creditLeft: false };
  }
  if (!held && row.status === 'failed' && row.cancel_booking_id !== null) {
    return { state: 'failed', amountCents: row.amount_cents, creditLeft: (row.credit_remaining ?? 0) > 0 };
  }
  return null;
}

/** What a booking's checkout page says about cancelling: the choice the
 * booking was made under, and the facts the cut-off time is worked from. */
export interface CancelPromise {
  gives: CancelGives;
  starts_at_utc: string;
  tz: string;
  cancel_window_hours: number;
  price_cents: number;
}

export async function cancelPromise(db: DbClient, bookingId: number): Promise<CancelPromise | null> {
  const result = await db.query<Omit<CancelPromise, 'gives'> & { cancel_gives: string }>(
    `select b.cancel_gives, s.starts_at_utc, s.tz, c.cancel_window_hours, st.price_cents
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where b.id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { cancel_gives, ...rest } = row;
  return { ...rest, gives: cancel_gives === 'refund' ? 'refund' : 'credit' };
}

// ---- Refunds nobody is there to send again ----

/** A coach who taps Refund and gets no answer taps again. A parent's cancel
 * has nobody waiting, so the tick sends its request again, under the same
 * key, once it has gone this long without an answer. */
export const CANCEL_REFUND_RETRY_MINUTES = 10;
/** After this long without an answer the refund reads as failed: the parent
 * holds their session credit, and the coach sees it on Money. */
export const CANCEL_REFUND_GIVE_UP_HOURS = 24;
const RETRY_BATCH = 20;

/** The tick's step for refunds a parent's cancel asked for whose request
 * never got an answer (the relay was down or busy, or the app stopped
 * between the cancel and the call). Each is asked for again through
 * `requestRefund`, which sends the same idempotency key, so the relay makes
 * the refund at most once. One that has had no answer for a day is given
 * up on instead: it fails, which releases the credit to the parent. */
export async function retryCancelRefunds(db: DbClient): Promise<{ retried: number; givenUp: number }> {
  const due = await db.query<{ payment_ref: string; booking_id: number; coach_id: number; give_up: boolean }>(
    `select payment_ref, booking_id, coach_id, cancel_asked_at < now() - make_interval(hours => $2::int) as give_up
     from refund
     where cancel_booking_id is not null and status = 'requested' and refunded_at is null
       and booking_id is not null and coach_id is not null
       and requested_at < now() - make_interval(mins => $1::int)
     order by requested_at, id
     limit $3`,
    [CANCEL_REFUND_RETRY_MINUTES, CANCEL_REFUND_GIVE_UP_HOURS, RETRY_BATCH],
  );
  let retried = 0;
  let givenUp = 0;
  for (const row of due.rows) {
    // One refund that cannot be sent never stops the next.
    try {
      if (row.give_up) {
        await giveUpOnRefund(db, row.payment_ref);
        givenUp += 1;
        continue;
      }
      const coach = await findCoachById(db, row.coach_id);
      if (!coach) continue;
      const outcome = await requestRefund(db, coach, { bookingId: row.booking_id });
      retried += 1;
      // Payments still do not answer: the rest wait for the next tick
      // rather than each waiting out the same silence.
      if (outcome.kind === 'unavailable') break;
    } catch (err) {
      console.error('cancel refund: sending it again failed:', err instanceof Error ? err.message : err);
    }
  }
  return { retried, givenUp };
}
