import type { DbClient } from '../db/client.js';

/** Paid events that could not simply become a booking. Each is kept with a
 * reason, logged once, and shown to the coach on the Money screen, so a
 * payment is never dropped without anyone seeing it. */

export type AttentionReason =
  | 'booking_missing'
  | 'booking_cancelled'
  | 'already_booked'
  | 'item_missing'
  | 'amount_mismatch'
  | 'session_cancelled'
  | 'session_started'
  | 'session_full';

export interface AttentionInput {
  eventId: string;
  reason: AttentionReason;
  coachId: number | null;
  bookingId: number | null;
  amountCents: number | null;
  expectedCents?: number | null;
  paymentRef: string | null;
  athleteName?: string | null;
  contactPhone?: string | null;
  /** What was done about it, e.g. "credit:1:told". */
  outcome?: string | null;
}

/** The fixed prefix of the one log line each item writes. */
export const PAYMENT_ATTENTION_LOG_PREFIX = 'payment-attention:';

export async function recordPaymentAttention(db: DbClient, item: AttentionInput): Promise<void> {
  await db.query(
    `insert into payment_attention
       (event_id, coach_id, booking_id, reason, amount_cents, expected_cents, payment_ref, athlete_name, contact_phone, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (event_id) do nothing`,
    [
      item.eventId,
      item.coachId,
      item.bookingId,
      item.reason,
      item.amountCents,
      item.expectedCents ?? null,
      item.paymentRef,
      item.athleteName ?? null,
      item.contactPhone ?? null,
      item.outcome ?? null,
    ],
  );
  console.error(
    `${PAYMENT_ATTENTION_LOG_PREFIX} ${JSON.stringify({
      reason: item.reason,
      eventId: item.eventId,
      coachId: item.coachId,
      bookingId: item.bookingId,
      amountCents: item.amountCents,
      expectedCents: item.expectedCents ?? null,
      outcome: item.outcome ?? null,
    })}`,
  );
}

/** Whether a payment for this booking arrived but was kept for the coach
 * instead of booking it, so the parent is told that and not asked to pay. */
export async function hasPaymentHeldForCoach(db: DbClient, bookingId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>('select id from payment_attention where booking_id = $1 limit 1', [bookingId]);
  return result.rows.length > 0;
}

export interface AttentionItem {
  id: number;
  reason: AttentionReason;
  amount_cents: number | null;
  expected_cents: number | null;
  athlete_name: string | null;
  contact_phone: string | null;
  outcome: string | null;
  /** The relay's ref for the payment, which a refund names. */
  payment_ref: string | null;
  created_at: string;
  session_name: string | null;
  starts_at_utc: string | null;
  tz: string | null;
}

/** The coach's open items, newest first. An item leaves the list once its
 * payment is refunded. */
export async function listPaymentAttention(db: DbClient, coachId: number): Promise<AttentionItem[]> {
  const result = await db.query<AttentionItem>(
    `select pa.id, pa.reason, pa.amount_cents, pa.expected_cents, pa.athlete_name, pa.contact_phone, pa.outcome, pa.payment_ref, pa.created_at,
            st.name as session_name, s.starts_at_utc, s.tz
     from payment_attention pa
     left join booking b on b.id = pa.booking_id
     left join session s on s.id = b.session_id
     left join session_type st on st.id = s.session_type_id
     where pa.coach_id = $1 and pa.resolved_at is null
     order by pa.created_at desc, pa.id desc
     limit 50`,
    [coachId],
  );
  return result.rows;
}

function dollars(cents: number | null): string {
  return cents === null ? 'an unknown amount' : `$${(cents / 100).toFixed(2)}`;
}

/** One plain sentence for the coach. */
export function describeAttention(item: Pick<AttentionItem, 'reason' | 'amount_cents' | 'expected_cents' | 'outcome'>): string {
  switch (item.reason) {
    case 'booking_missing':
      return 'A payment arrived for a booking we could not find.';
    case 'booking_cancelled':
      return 'A payment arrived for a booking that was already cancelled.';
    case 'already_booked':
      return 'This booking was already paid for, so this is a second payment.';
    case 'item_missing':
      return 'The package or pack this paid for no longer exists.';
    case 'amount_mismatch':
      return `Paid ${dollars(item.amount_cents)}, but the price was ${dollars(item.expected_cents)}. Not booked.`;
    case 'session_cancelled': {
      const [, count, told] = /^credit:(\d+):(told|not-told)$/.exec(item.outcome ?? '') ?? [];
      const credits = Number(count ?? '0');
      const given = `The session was cancelled before this payment arrived. The parent now has ${credits} session ${credits === 1 ? 'credit' : 'credits'} with you`;
      return told === 'told' ? `${given} and was told.` : `${given}. They could not be told: please let them know.`;
    }
    case 'session_started':
      return 'The session had already started when this payment arrived. Not booked.';
    case 'session_full':
      return 'The session filled up before this payment arrived. Not booked.';
    default:
      return 'This payment needs a look.';
  }
}
