import { inTransaction, type DbClient } from '../db/client.js';
import { createCredit, holdCreditForRefund, restoreCredit } from './pricing.js';

/** The booking policy (SPEC.md §9.5). Every rule has a default, so a coach
 * who changes nothing still has a working policy. The coach changes the
 * defaults on the Pricing screen and gives a credit back on Session detail.
 * These rules move session credits only; card refunds follow §9.4. */

export const DEFAULT_CANCEL_WINDOW_HOURS = 24;
export const DEFAULT_CHILDREN_PER_BOOKING = 2;
export const MAX_CANCEL_WINDOW_HOURS = 168;
export const MAX_CHILDREN_PER_BOOKING = 10;

export interface BookingPolicy {
  /** Hours before a session inside which a parent's cancel uses the credit. */
  cancelWindowHours: number;
  /** Children one booking pass can add. */
  childrenPerBooking: number;
}

export async function getBookingPolicy(db: DbClient, coachId: number): Promise<BookingPolicy> {
  const result = await db.query<{ cancel_window_hours: number; children_per_booking: number }>(
    'select cancel_window_hours, children_per_booking from coach where id = $1',
    [coachId],
  );
  const row = result.rows[0];
  return {
    cancelWindowHours: row?.cancel_window_hours ?? DEFAULT_CANCEL_WINDOW_HOURS,
    childrenPerBooking: row?.children_per_booking ?? DEFAULT_CHILDREN_PER_BOOKING,
  };
}

/** Whole numbers inside the allowed ranges, or null. */
export function parseBookingPolicy(windowRaw: string, childrenRaw: string): BookingPolicy | null {
  if (!/^\d{1,3}$/.test(windowRaw) || !/^\d{1,2}$/.test(childrenRaw)) return null;
  const cancelWindowHours = Number(windowRaw);
  const childrenPerBooking = Number(childrenRaw);
  if (cancelWindowHours > MAX_CANCEL_WINDOW_HOURS) return null;
  if (childrenPerBooking < 1 || childrenPerBooking > MAX_CHILDREN_PER_BOOKING) return null;
  return { cancelWindowHours, childrenPerBooking };
}

export async function setBookingPolicy(db: DbClient, coachId: number, policy: BookingPolicy): Promise<void> {
  await db.query('update coach set cancel_window_hours = $2, children_per_booking = $3 where id = $1', [
    coachId,
    policy.cancelWindowHours,
    policy.childrenPerBooking,
  ]);
}

/** The moment a parent's cancel stops giving the credit back. */
export function cancelCutoff(startsAtUtc: string | Date, windowHours: number): Date {
  return new Date(new Date(startsAtUtc).getTime() - windowHours * 60 * 60 * 1000);
}

interface PaidWith {
  credit_id: number | null;
  payment_source: string | null;
  gross_cents: number | null;
  /** The booking's credit was withdrawn by a refund of the payment that
   * bought it (SPEC.md §9.4), so nothing goes back to it. */
  credit_withdrawn?: boolean | null;
}

/** Reads `booking b`: whether the booking's credit was withdrawn by a refund. */
export const CREDIT_WITHDRAWN_SQL =
  'exists (select 1 from credit cw where cw.id = b.credit_id and cw.withdrawn_at is not null) as credit_withdrawn';

/** Reads `booking b`: whether the booking's credit is held while a refund of
 * the payment that bought it is on its way, so it cannot be used yet. */
export const CREDIT_HELD_SQL =
  'exists (select 1 from credit ch where ch.id = b.credit_id and ch.refund_id is not null and ch.withdrawn_at is null) as credit_held';

/** The booking drew on a credit that can still take a session back. */
function hasCreditBack(b: PaidWith): boolean {
  return b.credit_id !== null && !b.credit_withdrawn;
}

/** A drop-in the parent paid for, as opposed to a free one. */
function paidDropIn(b: PaidWith): boolean {
  return b.payment_source === 'DropIn' && (b.gross_cents ?? 0) > 0;
}

/** What a parent's cancel does now:
 * - returns-credit: before the window, the session credit goes back;
 * - becomes-credit: before the window, a paid drop-in becomes one session credit;
 * - uses-credit: inside the window, as a no-show, the credit (or the drop-in) is used;
 * - nothing: a free booking, nothing to give back;
 * - started: too late to cancel. */
export type CancelTerms = 'returns-credit' | 'becomes-credit' | 'uses-credit' | 'nothing' | 'started';

export function cancelTerms(booking: PaidWith & { starts_at_utc: string | Date }, windowHours: number, now: Date = new Date()): CancelTerms {
  const start = new Date(booking.starts_at_utc);
  if (now >= start) return 'started';
  const hasCredit = hasCreditBack(booking);
  if (!hasCredit && (booking.credit_id !== null || !paidDropIn(booking))) return 'nothing';
  if (now >= cancelCutoff(start, windowHours)) return 'uses-credit';
  return hasCredit ? 'returns-credit' : 'becomes-credit';
}

const LIVE = "('booked', 'attended', 'noshow')";

export type ParentCancel =
  | { kind: 'cancelled'; terms: CancelTerms; sessionId: number }
  | { kind: 'already' }
  | { kind: 'started' }
  | { kind: 'not_found' };

/** A parent cancels their booking from its manage link. What it does is
 * decided now, under the booking's row lock, by the coach's window: before
 * it the credit comes back (a paid drop-in becomes one session credit with
 * the coach, with no expiry); inside it the booking is a late cancel, the
 * credit is used, and the coach can give it back. A second cancel does
 * nothing. */
export async function cancelByParent(db: DbClient, manageToken: string, now: Date = new Date()): Promise<ParentCancel> {
  return inTransaction(db, async (tx): Promise<ParentCancel> => {
    const found = await tx.query<
      PaidWith & {
        id: number;
        session_id: number;
        status: string;
        contact_phone: string;
        charge_id: string | null;
        starts_at_utc: string;
        coach_id: number;
        window: number;
      }
    >(
      `select b.id, b.session_id, b.status, b.contact_phone, b.charge_id, b.credit_id, b.payment_source, b.gross_cents,
              ${CREDIT_WITHDRAWN_SQL}, s.starts_at_utc, st.coach_id, c.cancel_window_hours as window
       from booking b
       join session s on s.id = b.session_id
       join session_type st on st.id = s.session_type_id
       join coach c on c.id = st.coach_id
       where b.manage_token = $1
       for update of b`,
      [manageToken],
    );
    const b = found.rows[0];
    if (!b) return { kind: 'not_found' };
    if (b.status === 'cancelled') return { kind: 'already' };
    if (!['booked', 'attended', 'noshow'].includes(b.status)) return { kind: 'not_found' };
    const terms = cancelTerms(b, b.window, now);
    if (terms === 'started') return { kind: 'started' };

    const closed = await tx.query<{ id: number }>(
      `update booking set status = 'cancelled', late_cancel = $2 where id = $1 and status in ${LIVE} returning id`,
      [b.id, terms === 'uses-credit'],
    );
    if (closed.rows.length === 0) return { kind: 'already' };
    if (terms === 'returns-credit' && b.credit_id !== null) {
      await restoreCredit(tx, b.credit_id);
    } else if (terms === 'becomes-credit') {
      const creditId = await createCredit(tx, b.coach_id, b.contact_phone, null, `cancelled-booking:${b.id}`, 1, null);
      await tx.query('update booking set credit_id = $2 where id = $1', [b.id, creditId]);
      // A refund of this payment on its way holds the credit it became.
      await holdCreditForRefund(tx, creditId, b.charge_id);
    }
    return { kind: 'cancelled', terms, sessionId: b.session_id };
  });
}

/** A booking whose credit the coach can give back: a no-show, or a parent's
 * cancel inside the window, not given back already, with something to give. */
export function canWaive(b: PaidWith & { status: string; late_cancel: boolean; waived_at: string | Date | null }): boolean {
  if (b.waived_at) return false;
  if (!(b.status === 'noshow' || (b.status === 'cancelled' && b.late_cancel))) return false;
  return b.credit_id !== null ? hasCreditBack(b) : paidDropIn(b);
}

/** The coach gives a no-show's or a late cancel's credit back (screen 3),
 * once: a credit goes back to the credit it came from; a paid drop-in
 * becomes one session credit with the coach. */
export async function waiveBooking(db: DbClient, coachId: number, sessionId: number, bookingId: number): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const found = await tx.query<
      PaidWith & { id: number; status: string; late_cancel: boolean; waived_at: string | null; contact_phone: string; charge_id: string | null }
    >(
      `select b.id, b.status, b.late_cancel, b.waived_at, b.credit_id, b.payment_source, b.gross_cents, b.contact_phone, b.charge_id,
              ${CREDIT_WITHDRAWN_SQL}
       from booking b
       join session s on s.id = b.session_id
       join session_type st on st.id = s.session_type_id
       where b.id = $1 and b.session_id = $2 and st.coach_id = $3
       for update of b`,
      [bookingId, sessionId, coachId],
    );
    const b = found.rows[0];
    if (!b || !canWaive(b)) return false;
    if (b.credit_id !== null) {
      // A credit a refund withdrew since takes nothing back.
      if (!(await restoreCredit(tx, b.credit_id))) return false;
    } else {
      const creditId = await createCredit(tx, coachId, b.contact_phone, null, `waived-booking:${b.id}`, 1, null);
      await tx.query('update booking set credit_id = $2 where id = $1', [b.id, creditId]);
      // A refund of this payment on its way holds the credit it became.
      await holdCreditForRefund(tx, creditId, b.charge_id);
    }
    await tx.query('update booking set waived_at = now() where id = $1', [b.id]);
    return true;
  });
}
