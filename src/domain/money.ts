import type { DbClient } from '../db/client.js';
import { addWeeksUtc, startOfWeekUtc } from '../lib/week.js';

export interface MoneySummary {
  bookedThisWeekCount: number;
  bookedThisWeekCents: number;
  collectedThisWeekCents: number;
  outstandingCreditCount: number;
  nextWeekCount: number;
  nextWeekCents: number;
  /** Payments refunded this week. A refunded booking is out of booked and
   * collected, whichever week its session is in. */
  refundedThisWeekCount: number;
  refundedThisWeekCents: number;
}

interface SessionAggregate {
  count: number;
  totalCents: number;
}

/** Counts session *slots* the coach has scheduled in a window, regardless
 * of whether anyone has booked them yet - used for "next week's
 * projected," which is about capacity the coach has put up, not demand.
 * Nothing in it is sold yet, so it is priced at each type's price now. */
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

/** A booking that was sold and not cancelled: still booked, or already
 * marked attended or no-show. Marking attendance must not take a booking
 * out of the coach's totals; a refund ('refunded') does. */
export const EARNED_BOOKING_STATUSES = "('booked', 'attended', 'noshow')";

/** A cancelled booking whose payment stayed with the coach: as session
 * credit (the coach cancelled the session, before or after the payment
 * came in, or the parent cancelled before the window), or used, because
 * the parent cancelled inside the window (SPEC.md §9.5). The money reached
 * the coach's account, so it counts as collected. `b` is the booking alias. */
export function keptAsCreditSql(b: string): string {
  return `(${b}.status = 'cancelled' and ${b}.gross_cents is not null and (${b}.credit_id is not null or ${b}.late_cancel))`;
}

/** Counts live bookings (not session slots) on sessions in a window - used
 * for "booked this week," which is about demand actually realized: three
 * athletes booked into one session slot is 3 booked, not 1. Cents is the
 * session's price recorded on each booking when it was booked (what was
 * booked), never the session type's price now, and distinct from
 * `collected`, which is what was actually charged. A booking with no
 * recorded price (the previous release can still book one while a deploy is
 * under way) is valued the way migration 0027 values older ones: a
 * drop-in's own charge, or else the type's price. */
async function aggregateBookings(db: DbClient, coachId: number, from: Date, to: Date): Promise<SessionAggregate> {
  const result = await db.query<{ count: string; total_cents: string }>(
    `select count(*)::text as count,
            coalesce(sum(coalesce(b.price_cents, case when b.payment_source = 'DropIn' then b.gross_cents end, st.price_cents)), 0)::text
              as total_cents
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and b.status in ${EARNED_BOOKING_STATUSES}
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

  const [booked, nextWeek, collected, outstanding, refunded] = await Promise.all([
    aggregateBookings(db, coachId, thisWeekStart, nextWeekStart),
    aggregateSessionSlots(db, coachId, nextWeekStart, weekAfterNextStart),
    // "Collected" is the actual gross amount charged (booking.gross_cents,
    // null/0 for a credit redemption that charged nothing new this time)
    // for the same live bookings counted above, plus payments the coach's
    // cancel turned into credit.
    db.query<{ total_gross_cents: string }>(
      `select coalesce(sum(b.gross_cents), 0)::text as total_gross_cents
       from booking b
       join session s on s.id = b.session_id
       join session_type st on st.id = s.session_type_id
       where st.coach_id = $1
         and (b.status in ${EARNED_BOOKING_STATUSES} or ${keptAsCreditSql('b')})
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
    db.query<{ count: string; total_cents: string }>(
      `select count(*)::text as count, coalesce(sum(amount_cents), 0)::text as total_cents
       from refund
       where coach_id = $1 and status = 'refunded' and refunded_at >= $2 and refunded_at < $3`,
      [coachId, thisWeekStart.toISOString(), nextWeekStart.toISOString()],
    ),
  ]);

  return {
    bookedThisWeekCount: booked.count,
    bookedThisWeekCents: booked.totalCents,
    collectedThisWeekCents: Number(collected.rows[0]?.total_gross_cents ?? '0'),
    outstandingCreditCount: Number(outstanding.rows[0]?.total_remaining ?? '0'),
    nextWeekCount: nextWeek.count,
    nextWeekCents: nextWeek.totalCents,
    refundedThisWeekCount: Number(refunded.rows[0]?.count ?? '0'),
    refundedThisWeekCents: Number(refunded.rows[0]?.total_cents ?? '0'),
  };
}
