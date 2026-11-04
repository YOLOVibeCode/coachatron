import { inTransaction, type DbClient } from '../db/client.js';
import { refundSellerPayment, SellerError } from '../relay/seller.js';
import { formatCoachDollars } from '../lib/time.js';
import { findCoachBySellerKey, getConnectRecipientKey, type CoachRow } from './auth.js';
import { namesList, sendRefundNotice } from './bookingMessages.js';
import { offerOpenSpots } from './waitlist.js';

/**
 * Refunds (SPEC.md §9.4). A coach refunds a whole payment from Session
 * detail or Money; the relay refunds it on the coach's Stripe account and
 * returns Coachatron's fee with it. Coachatron never holds the money: it
 * asks the relay, then records what the relay and its store events report.
 *
 * One `refund` row per payment makes a second tap, a redelivered event, or
 * a refund the relay confirms both at once and by event, one refund with
 * one set of effects: the booking the payment bought is marked refunded
 * (its spot is free again), the session credits the payment bought are
 * withdrawn, a payment kept for the coach leaves "Payments to resolve", and
 * the parent is told once. A booking pass (SPEC.md §9.5) is one payment for
 * several children, each with a booking carrying it: its refund is of the
 * whole payment, so it ends every one of those bookings.
 *
 * The credit a payment bought is held from the moment its refund is asked
 * for: nothing more is booked with it while the refund is on its way. A
 * refund that does not go through gives it back; one that goes through
 * withdraws it for good, so a booking that drew on it and is cancelled
 * later gives nothing back to it.
 */

export type RefundStatus = 'requested' | 'pending' | 'refunded' | 'failed' | 'partial';

/** Bookings that were sold and still count: they hold a spot. */
const LIVE = new Set(['booked', 'attended', 'noshow']);

/** An unanswered relay call is tried again with the same key after this long. */
const STALE_REQUEST_MINUTES = 2;

export function refundIdempotencyKey(paymentRef: string, attempt: number): string {
  return `coachatron-refund:${paymentRef}:${attempt}`;
}

// ---- What a payment bought ----

interface PurchaseBooking {
  id: number;
  coach_id: number;
  session_id: number;
  status: string;
  payment_source: string | null;
  credit_id: number | null;
  charge_id: string | null;
  gross_cents: number | null;
  athlete_name: string;
  contact_phone: string;
  starts_at_utc: string;
  tz: string;
  session_name: string;
  late_cancel: boolean;
  waived_at: string | null;
}

const PURCHASE_COLUMNS = `b.id, st.coach_id, b.session_id, b.status, b.payment_source, b.credit_id, b.charge_id, b.gross_cents,
  b.athlete_name, b.contact_phone, s.starts_at_utc, s.tz, st.name as session_name, b.late_cancel, b.waived_at`;
const PURCHASE_FROM = `booking b join session s on s.id = b.session_id join session_type st on st.id = s.session_type_id`;

/** A booking by id, its row locked until the transaction ends. */
async function lockedBooking(db: DbClient, bookingId: number): Promise<PurchaseBooking | null> {
  const result = await db.query<PurchaseBooking>(`select ${PURCHASE_COLUMNS} from ${PURCHASE_FROM} where b.id = $1 for update of b`, [bookingId]);
  return result.rows[0] ?? null;
}

async function bookingForCoach(db: DbClient, coachId: number, bookingId: number): Promise<PurchaseBooking | null> {
  const result = await db.query<PurchaseBooking>(`select ${PURCHASE_COLUMNS} from ${PURCHASE_FROM} where b.id = $1 and st.coach_id = $2`, [
    bookingId,
    coachId,
  ]);
  return result.rows[0] ?? null;
}

/** The booking a payment paid for: the one carrying it as its charge. */
async function bookingForPayment(db: DbClient, paymentRef: string): Promise<PurchaseBooking | null> {
  const result = await db.query<PurchaseBooking>(
    `select ${PURCHASE_COLUMNS} from ${PURCHASE_FROM} where b.charge_id = $1 and b.gross_cents > 0 order by b.id limit 1`,
    [paymentRef],
  );
  return result.rows[0] ?? null;
}

function isPurchase(b: PurchaseBooking): boolean {
  return b.charge_id !== null && (b.gross_cents ?? 0) > 0;
}

/** A booking a payment bought. */
interface BoughtBooking {
  id: number;
  status: string;
  credit_id: number | null;
  gross_cents: number | null;
  athlete_name: string;
  late_cancel: boolean;
  waived_at: string | null;
}

/** The booking still uses the session it was bought with: it stands, or the
 * parent cancelled it inside the window (treated as a no-show, §9.5), and
 * the coach did not give that session back. A booking that does not has
 * its session on a credit instead: a cancel in time, the coach's cancel, or
 * the coach giving it back. */
function usesOwnSession(x: BoughtBooking): boolean {
  return (LIVE.has(x.status) || (x.status === 'cancelled' && x.late_cancel)) && x.waived_at === null;
}

/** The credits the payment's bookings hold. */
function creditIdsOf(bought: BoughtBooking[]): number[] {
  return [...new Set(bought.flatMap((x) => (x.credit_id === null ? [] : [x.credit_id])))];
}

/** Every booking this booking's payment bought: the booking alone, or each
 * child's booking in its booking pass, all carrying the one payment. */
async function bookingsBought(db: DbClient, b: PurchaseBooking, lock = false): Promise<BoughtBooking[]> {
  if (b.charge_id === null) return [b];
  const result = await db.query<BoughtBooking>(
    `select id, status, credit_id, gross_cents, athlete_name, late_cancel, waived_at from booking
     where charge_id = $1 and session_id = $2 order by id${lock ? ' for update' : ''}`,
    [b.charge_id, b.session_id],
  );
  return result.rows.length > 0 ? result.rows : [b];
}

/** The booking whose payment bought this credit, when one did. */
async function purchaseOfCredit(db: DbClient, coachId: number, creditId: number): Promise<number | null> {
  const result = await db.query<{ id: number }>(
    `select b.id from ${PURCHASE_FROM}
     where b.credit_id = $1 and st.coach_id = $2 and b.charge_id is not null and b.gross_cents > 0
     order by b.id limit 1`,
    [creditId, coachId],
  );
  return result.rows[0]?.id ?? null;
}

function hasStarted(startsAtUtc: string): boolean {
  return new Date(startsAtUtc).getTime() <= Date.now();
}

export type PurchaseKind = 'drop-in' | 'package' | 'pack';

interface PurchaseCredits {
  kind: PurchaseKind;
  /** The credits the payment's bookings hold: a package's or pack's one
   * credit, or the credit a drop-in became when its booking was cancelled. */
  creditIds: number[];
  /** Sessions the payment bought. */
  sessions: number;
  /** Unused sessions left on its credits. */
  unused: number;
  /** Sessions used by later bookings (or otherwise gone from its credits). */
  usedElsewhere: number;
  /** The bookings it bought, and those of them that stand now. */
  bought: BoughtBooking[];
  live: BoughtBooking[];
}

/** The sessions a payment bought and how many are still unused. Each
 * booking it bought uses one while it uses its own session (it stands, or
 * was cancelled late, and was not given back); the rest sit on the credit
 * the payment added (a cancel in time, the coach's cancel, or the coach
 * giving a session back puts the booking's own session back on it, or
 * makes a paid drop-in one credit). A drop-in the parent cancelled inside
 * the window, and not given back, has neither, and nothing it bought was
 * used elsewhere. */
async function purchaseCredits(db: DbClient, b: PurchaseBooking): Promise<PurchaseCredits> {
  const bought = await bookingsBought(db, b);
  const live = bought.filter((x) => LIVE.has(x.status));
  const creditIds = creditIdsOf(bought);
  const credits =
    creditIds.length === 0
      ? []
      : (
          await db.query<{ id: number; remaining: number; source: string }>(
            'select id, remaining, source from credit where id = any($1::int[]) order by id',
            [creditIds],
          )
        ).rows;
  const kind: PurchaseKind = b.payment_source === 'Pack' ? 'pack' : b.payment_source === 'PackageCredit' ? 'package' : 'drop-in';
  const own = bought.filter(usesOwnSession).length;
  const unused = credits.reduce((n, c) => n + Math.max(0, c.remaining), 0);
  if (kind === 'drop-in') {
    // A child's session was used elsewhere only when it became a credit (a
    // cancel, or the coach giving it back) and that credit is spent.
    let used = 0;
    for (const c of credits) {
      const becameCredit = bought.filter((x) => x.credit_id === c.id && !usesOwnSession(x)).length;
      used += Math.max(0, becameCredit - Math.max(0, c.remaining));
    }
    return { kind, creditIds, sessions: bought.length, unused, usedElsewhere: used, bought, live };
  }
  let sessions: number;
  const [, from, id] = /^(package|plan):(\d+)$/.exec(credits[0]?.source ?? '') ?? [];
  if (from === 'package') {
    const row = await db.query<{ credits: number }>('select credits from package where id = $1', [Number(id)]);
    sessions = row.rows[0]?.credits ?? own + unused;
  } else if (from === 'plan') {
    const row = await db.query<{ credits_per_month: number }>('select credits_per_month from plan where id = $1', [Number(id)]);
    sessions = row.rows[0]?.credits_per_month ?? own + unused;
  } else {
    sessions = own + unused;
  }
  const usedElsewhere = Math.max(0, sessions - own - unused);
  return { kind, creditIds, sessions, unused, usedElsewhere, bought, live };
}

// ---- Refund rows ----

export interface RefundRow {
  id: number;
  coach_id: number | null;
  payment_ref: string;
  booking_id: number | null;
  attention_id: number | null;
  athlete_name: string | null;
  contact_phone: string | null;
  amount_cents: number | null;
  status: RefundStatus;
  attempt: number;
  refund_ref: string | null;
  error_code: string | null;
  from_app: boolean;
  credits_withdrawn: number;
  credits_used: number;
  spot_released: boolean;
  parent_told: string | null;
  requested_at: string;
  refunded_at: string | null;
  failed_at: string | null;
}

async function refundForPayment(db: DbClient, paymentRef: string): Promise<RefundRow | null> {
  const result = await db.query<RefundRow>('select * from refund where payment_ref = $1', [paymentRef]);
  return result.rows[0] ?? null;
}

// ---- Can this payment be refunded? ----

export type RefundBlock =
  | { kind: 'not_found' }
  /** A free booking, or one paid with a session credit. */
  | { kind: 'not_paid' }
  /** The booking whose payment bought the credit, when one did. */
  | { kind: 'paid_with_credit'; purchaseBookingId: number | null }
  /** Sessions the payment bought were used. */
  | { kind: 'credits_used'; used: number; sessions: number }
  | { kind: 'in_progress' }
  | { kind: 'refunded' }
  /** Part of it was refunded outside Coachatron. */
  | { kind: 'partly_refunded' }
  | { kind: 'no_payment_ref' };

export interface RefundPlan {
  coachId: number;
  paymentRef: string;
  amountCents: number | null;
  /** The booking this payment bought, when there is one. */
  bookingId: number | null;
  /** The payment kept for the coach, when it is one. */
  attentionId: number | null;
  /** Who the payment was for: every child, when it was for several. */
  athleteName: string | null;
  contactPhone: string | null;
  sessionName: string | null;
  startsAtUtc: string | null;
  tz: string | null;
  kind: PurchaseKind | 'kept-payment';
  /** The booking stands now, and the refund ends it. */
  releasesBooking: boolean;
  /** The children whose bookings stand now and the refund ends. */
  endsFor: string[];
  /** The status of the booking the payment bought, when it bought one. */
  bookingStatus: string | null;
  /** The session has started, so a booking the refund ends is marked
   * refunded rather than cancelled with its spot freed. */
  sessionStarted: boolean;
  /** The credits the payment bought, held while the refund is on its way. */
  creditIds: number[];
  /** Unused session credits the refund withdraws. */
  creditsWithdrawn: number;
  /** A booking holds the parent's number or email, so they can be told. */
  reachable: boolean;
}

export type Refundability = { ok: true; plan: RefundPlan } | { ok: false; block: RefundBlock };

export type RefundTarget = { bookingId: number } | { attentionId: number };

/** Whether an earlier refund row stops a new request. A failed refund, or a
 * request whose answer never came, can be sent again. */
function blockFromExisting(row: RefundRow | null): RefundBlock | null {
  if (!row) return null;
  switch (row.status) {
    case 'refunded':
      return { kind: 'refunded' };
    case 'pending':
      return { kind: 'in_progress' };
    case 'partial':
      return { kind: 'partly_refunded' };
    case 'requested':
      return row.error_code !== null || Date.now() - new Date(row.requested_at).getTime() > STALE_REQUEST_MINUTES * 60_000
        ? null
        : { kind: 'in_progress' };
    default:
      return null;
  }
}

async function planForBooking(db: DbClient, b: PurchaseBooking, attentionId: number | null): Promise<Refundability> {
  if (!isPurchase(b) || b.charge_id === null) {
    if (b.credit_id !== null && b.charge_id === null) {
      return { ok: false, block: { kind: 'paid_with_credit', purchaseBookingId: await purchaseOfCredit(db, b.coach_id, b.credit_id) } };
    }
    return { ok: false, block: { kind: 'not_paid' } };
  }
  const existing = await refundForPayment(db, b.charge_id);
  const block = blockFromExisting(existing);
  if (block) return { ok: false, block };
  const credits = await purchaseCredits(db, b);
  // A refund tried again after it failed already withdrew these credits.
  if (credits.usedElsewhere > 0 && !existing?.refunded_at) {
    return { ok: false, block: { kind: 'credits_used', used: credits.usedElsewhere, sessions: credits.sessions } };
  }
  return {
    ok: true,
    plan: {
      coachId: b.coach_id,
      paymentRef: b.charge_id,
      amountCents: paidFor(credits.bought),
      bookingId: b.id,
      attentionId,
      athleteName: namesList(credits.bought.map((x) => x.athlete_name)),
      contactPhone: b.contact_phone,
      sessionName: b.session_name,
      startsAtUtc: b.starts_at_utc,
      tz: b.tz,
      kind: credits.kind,
      releasesBooking: credits.live.length > 0,
      endsFor: credits.live.map((x) => x.athlete_name),
      bookingStatus: b.status,
      sessionStarted: hasStarted(b.starts_at_utc),
      creditIds: credits.creditIds,
      creditsWithdrawn: existing?.refunded_at ? 0 : credits.unused,
      reachable: true,
    },
  };
}

/** The whole payment: each child's share of a drop-in for several, or the
 * one amount on the booking that bought a package or pack. */
function paidFor(bought: BoughtBooking[]): number | null {
  const amounts = bought.flatMap((x) => (x.gross_cents === null ? [] : [x.gross_cents]));
  return amounts.length === 0 ? null : amounts.reduce((n, c) => n + c, 0);
}

interface AttentionRow {
  id: number;
  coach_id: number | null;
  booking_id: number | null;
  amount_cents: number | null;
  payment_ref: string | null;
  athlete_name: string | null;
  contact_phone: string | null;
}

async function attentionForCoach(db: DbClient, coachId: number, attentionId: number): Promise<AttentionRow | null> {
  const result = await db.query<AttentionRow>(
    'select id, coach_id, booking_id, amount_cents, payment_ref, athlete_name, contact_phone from payment_attention where id = $1 and coach_id = $2',
    [attentionId, coachId],
  );
  return result.rows[0] ?? null;
}

/** What a refund of this booking's payment, or of this kept payment, would
 * do, or why it cannot be done here. Only the coach's own are found. */
export async function checkRefund(db: DbClient, coachId: number, target: RefundTarget): Promise<Refundability> {
  if ('bookingId' in target) {
    const b = await bookingForCoach(db, coachId, target.bookingId);
    if (!b) return { ok: false, block: { kind: 'not_found' } };
    // Another child's booking in a booking pass: the payment is the pass's,
    // and its first booking stands for it.
    const first = b.charge_id === null ? null : await bookingForPayment(db, b.charge_id);
    const purchase = first && first.coach_id === coachId && first.session_id === b.session_id ? first : b;
    return planForBooking(db, purchase, null);
  }
  const item = await attentionForCoach(db, coachId, target.attentionId);
  if (!item) return { ok: false, block: { kind: 'not_found' } };
  if (!item.payment_ref) return { ok: false, block: { kind: 'no_payment_ref' } };
  // A payment that became credit (the session was cancelled) is on its booking.
  const bought = await bookingForPayment(db, item.payment_ref);
  if (bought && bought.coach_id === coachId) return planForBooking(db, bought, item.id);
  const block = blockFromExisting(await refundForPayment(db, item.payment_ref));
  if (block) return { ok: false, block };
  const session = item.booking_id ? await bookingForCoach(db, coachId, item.booking_id) : null;
  return {
    ok: true,
    plan: {
      coachId,
      paymentRef: item.payment_ref,
      amountCents: item.amount_cents,
      bookingId: null,
      attentionId: item.id,
      athleteName: item.athlete_name,
      contactPhone: item.contact_phone,
      sessionName: session?.session_name ?? null,
      startsAtUtc: session?.starts_at_utc ?? null,
      tz: session?.tz ?? null,
      kind: 'kept-payment',
      releasesBooking: false,
      endsFor: [],
      bookingStatus: null,
      sessionStarted: session ? hasStarted(session.starts_at_utc) : false,
      creditIds: [],
      creditsWithdrawn: 0,
      reachable: session !== null,
    },
  };
}

/** One plain sentence for the coach on why a payment cannot be refunded here. */
export function describeRefundBlock(block: RefundBlock): string {
  switch (block.kind) {
    case 'not_found':
      return 'We could not find that payment.';
    case 'not_paid':
      return 'Nothing was paid for this booking, so there is nothing to refund.';
    case 'paid_with_credit':
      return 'This booking used a session credit. To refund it, refund the payment the credit came from.';
    case 'credits_used':
      return `${block.used} of the ${block.sessions} sessions this payment bought ${block.used === 1 ? 'was' : 'were'} used, so it cannot be refunded in full here. Talk with the parent, and contact Coachatron support if you want to refund part of it.`;
    case 'in_progress':
      return 'A refund of this payment is already on its way.';
    case 'refunded':
      return 'This payment was already refunded.';
    case 'partly_refunded':
      return 'Part of this payment was already refunded outside Coachatron. Contact Coachatron support to refund more.';
    case 'no_payment_ref':
      return 'This payment cannot be refunded from Coachatron. Contact Coachatron support.';
    default:
      return 'This payment cannot be refunded here.';
  }
}

// ---- Asking the relay ----

export type RefundRequestOutcome =
  | { kind: 'refunded' }
  | { kind: 'pending' }
  | { kind: 'blocked'; block: RefundBlock }
  | { kind: 'failed'; code: string }
  | { kind: 'unavailable' };

/** Stops a claim inside its transaction, so nothing of it is kept. */
class ClaimStopped extends Error {
  constructor(readonly block: RefundBlock) {
    super(block.kind);
  }
}

/** Claims the payment's refund row for one call to the relay. A new row, a
 * failed refund (tried again under a new key), or a call whose answer never
 * came (tried again under the same key) can be claimed; anything else is
 * already on its way or done. The claim holds the credit the payment
 * bought, so nothing more is booked with it while the refund is on its way;
 * a booking that drew on it since the check stops the claim. Returns the
 * attempt to send, or why not. */
async function claimRefund(db: DbClient, plan: RefundPlan): Promise<{ attempt: number } | { block: RefundBlock }> {
  try {
    return await inTransaction(db, async (tx) => {
      const claimed = await upsertClaim(tx, plan);
      if (!claimed) {
        return { block: blockFromExisting(await refundForPayment(tx, plan.paymentRef)) ?? { kind: 'in_progress' } };
      }
      // A refund applied before it failed already withdrew the credit.
      if (plan.bookingId !== null && claimed.refunded_at === null) {
        // Every booking the payment bought is locked, so a cancel that
        // turns one into a credit either finished first (and that credit is
        // held here) or runs after and finds this refund on its way.
        const b = await lockedBooking(tx, plan.bookingId);
        const held = b ? creditIdsOf(await bookingsBought(tx, b, true)) : [];
        if (held.length > 0) await tx.query('update credit set refund_id = $2 where id = any($1::int[])', [held, claimed.id]);
        const credits = b ? await purchaseCredits(tx, b) : null;
        if (credits && credits.usedElsewhere > 0) {
          throw new ClaimStopped({ kind: 'credits_used', used: credits.usedElsewhere, sessions: credits.sessions });
        }
      }
      return { attempt: claimed.attempt };
    });
  } catch (err) {
    if (err instanceof ClaimStopped) return { block: err.block };
    throw err;
  }
}

async function upsertClaim(db: DbClient, plan: RefundPlan): Promise<{ id: number; attempt: number; refunded_at: string | null } | null> {
  const result = await db.query<{ id: number; attempt: number; refunded_at: string | null }>(
    `insert into refund (coach_id, payment_ref, booking_id, attention_id, athlete_name, contact_phone, amount_cents, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'requested')
     on conflict (payment_ref) do update set
       status = 'requested',
       attempt = case when refund.status = 'failed' then refund.attempt + 1 else refund.attempt end,
       error_code = null,
       from_app = true,
       booking_id = coalesce(refund.booking_id, excluded.booking_id),
       attention_id = coalesce(refund.attention_id, excluded.attention_id),
       requested_at = now(),
       updated_at = now()
     where refund.status = 'failed'
        or (refund.status = 'requested'
            and (refund.error_code is not null or refund.requested_at < now() - make_interval(mins => $8::int)))
     returning id, attempt, refunded_at`,
    [
      plan.coachId,
      plan.paymentRef,
      plan.bookingId,
      plan.attentionId,
      plan.athleteName,
      plan.contactPhone,
      plan.amountCents,
      STALE_REQUEST_MINUTES,
    ],
  );
  return result.rows[0] ?? null;
}

/** The money did not go back. Unless the refund's effects were already
 * applied, the credit it held can be used again. */
async function markFailed(db: DbClient, paymentRef: string, code: string, from: RefundStatus[]): Promise<void> {
  const failed = await db.query<{ id: number; refunded_at: string | null }>(
    `update refund set status = 'failed', error_code = $2, failed_at = now(), updated_at = now()
     where payment_ref = $1 and status = any($3::text[])
     returning id, refunded_at`,
    [paymentRef, code, from],
  );
  const row = failed.rows[0];
  if (row && row.refunded_at === null) {
    await db.query('update credit set refund_id = null where refund_id = $1 and withdrawn_at is null', [row.id]);
  }
}

/** The coach confirmed: refund the whole payment through the relay. Safe to
 * tap twice: the second tap finds the first one's row and sends nothing. */
export async function requestRefund(db: DbClient, coach: CoachRow, target: RefundTarget): Promise<RefundRequestOutcome> {
  const check = await checkRefund(db, coach.id, target);
  if (!check.ok) return { kind: 'blocked', block: check.block };
  const plan = check.plan;
  const claim = await claimRefund(db, plan);
  if ('block' in claim) return { kind: 'blocked', block: claim.block };
  const attempt = claim.attempt;
  let answer;
  try {
    answer = await refundSellerPayment(getConnectRecipientKey(coach), {
      paymentRef: plan.paymentRef,
      idempotencyKey: refundIdempotencyKey(plan.paymentRef, attempt),
    });
  } catch (err) {
    if (err instanceof SellerError && err.status !== 429 && err.status < 500) {
      const code = err.code || `HTTP_${err.status}`;
      await markFailed(db, plan.paymentRef, code, ['requested']);
      return { kind: 'failed', code };
    }
    // No answer, or the relay is busy: the same key goes again on the next tap.
    console.error('refund: the relay did not answer:', err instanceof Error ? err.message : err);
    await db.query(
      "update refund set error_code = 'unavailable', updated_at = now() where payment_ref = $1 and status = 'requested'",
      [plan.paymentRef],
    );
    return { kind: 'unavailable' };
  }
  if (answer.status === 'succeeded') {
    await applyRefunded(db, { paymentRef: plan.paymentRef, refundRef: answer.refundRef, amountCents: answer.amountCents, sellerKey: null });
    return { kind: 'refunded' };
  }
  if (answer.status === 'failed') {
    await db.query('update refund set refund_ref = coalesce($2, refund_ref) where payment_ref = $1', [plan.paymentRef, answer.refundRef]);
    await markFailed(db, plan.paymentRef, 'failed', ['requested']);
    return { kind: 'failed', code: 'failed' };
  }
  // Stripe confirms it later; the store event finishes it.
  await db.query(
    "update refund set status = 'pending', refund_ref = coalesce($2, refund_ref), updated_at = now() where payment_ref = $1 and status = 'requested'",
    [plan.paymentRef, answer.refundRef],
  );
  return { kind: 'pending' };
}

// ---- What the store reports ----

interface LocatedPayment {
  coachId: number | null;
  booking: PurchaseBooking | null;
  attention: AttentionRow | null;
  /** What the payment was, when Coachatron knows. */
  amountCents: number | null;
}

async function locatePayment(db: DbClient, paymentRef: string, sellerKey: string | null): Promise<LocatedPayment> {
  const booking = await bookingForPayment(db, paymentRef);
  const attention =
    (
      await db.query<AttentionRow>(
        `select id, coach_id, booking_id, amount_cents, payment_ref, athlete_name, contact_phone
         from payment_attention where payment_ref = $1 order by id limit 1`,
        [paymentRef],
      )
    ).rows[0] ?? null;
  let coachId = booking?.coach_id ?? attention?.coach_id ?? null;
  if (coachId === null && sellerKey) coachId = (await findCoachBySellerKey(db, sellerKey))?.id ?? null;
  // A payment for several children is on each child's booking.
  const bought = booking ? await bookingsBought(db, booking) : [];
  return {
    coachId,
    booking: booking ? { ...booking, athlete_name: namesList(bought.map((x) => x.athlete_name)) } : null,
    attention: booking ? null : attention,
    amountCents: booking ? paidFor(bought) : (attention?.amount_cents ?? null),
  };
}

export interface RefundReport {
  paymentRef: string;
  refundRef: string | null;
  /** What the store says was refunded. */
  amountCents: number | null;
  sellerKey: string | null;
}

/** Applies a refund once: from the relay's answer when it refunded at once,
 * or from `marketplace.purchase.refunded`. A refund made outside Coachatron
 * is recorded too; when it covers only part of the payment (or its amount
 * is unknown), nothing else changes and the coach sees it on Money. */
export async function applyRefunded(db: DbClient, report: RefundReport): Promise<'refunded' | 'already' | 'partial' | 'unknown'> {
  let row = await refundForPayment(db, report.paymentRef);
  if (!row) {
    const found = await locatePayment(db, report.paymentRef, report.sellerKey);
    if (found.coachId === null) return 'unknown';
    const whole = report.amountCents !== null && found.amountCents !== null && report.amountCents >= found.amountCents;
    const athlete = found.booking ?? found.attention;
    await db.query(
      `insert into refund (coach_id, payment_ref, booking_id, attention_id, athlete_name, contact_phone, amount_cents, status, from_app, refund_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
       on conflict (payment_ref) do nothing`,
      [
        found.coachId,
        report.paymentRef,
        found.booking?.id ?? null,
        found.attention?.id ?? null,
        athlete?.athlete_name ?? null,
        athlete?.contact_phone ?? null,
        whole ? found.amountCents : report.amountCents,
        whole ? 'requested' : 'partial',
        report.refundRef,
      ],
    );
    row = await refundForPayment(db, report.paymentRef);
    if (!row) return 'unknown';
  }
  if (row.status === 'partial') return 'partial';

  const applied = await inTransaction(db, async (tx) => {
    const locked = await tx.query<RefundRow>('select * from refund where id = $1 for update', [row.id]);
    const current = locked.rows[0];
    if (!current) return null;
    if (current.refunded_at !== null) {
      await tx.query(
        "update refund set status = 'refunded', refund_ref = coalesce($2, refund_ref), error_code = null, updated_at = now() where id = $1",
        [current.id, report.refundRef],
      );
      return null;
    }
    let creditsWithdrawn = 0;
    let creditsUsed = 0;
    let ended: BoughtBooking[] = [];
    let names: string[] = [];
    let released = false;
    let sessionId: number | null = null;
    if (current.booking_id !== null) {
      const b = await lockedBooking(tx, current.booking_id);
      if (b) {
        // Lock every booking the payment bought and their credits too, so a
        // booking drawing on one waits, and what is counted here is what is
        // withdrawn. Never below zero.
        const held = creditIdsOf(await bookingsBought(tx, b, true));
        if (held.length > 0) await tx.query('select id from credit where id = any($1::int[]) for update', [held]);
        const credits = await purchaseCredits(tx, b);
        if (credits.creditIds.length > 0) {
          // Withdrawn for good: a booking that drew on it and is cancelled
          // later gives nothing back to it.
          await tx.query(
            'update credit set remaining = 0, refund_id = $2, withdrawn_at = coalesce(withdrawn_at, now()) where id = any($1::int[])',
            [credits.creditIds, current.id],
          );
          creditsWithdrawn = credits.unused;
        }
        creditsUsed = credits.usedElsewhere;
        ended = credits.live;
        names = credits.bought.map((x) => x.athlete_name);
        // A session that already happened has no spot to free.
        released = ended.length > 0 && !hasStarted(b.starts_at_utc);
        sessionId = b.session_id;
        await tx.query(
          "update booking set status = 'refunded' where id = any($1::int[]) and status in ('booked', 'attended', 'noshow', 'cancelled')",
          [credits.bought.map((x) => x.id)],
        );
      }
    }
    await tx.query('update payment_attention set resolved_at = now() where payment_ref = $1 and resolved_at is null', [current.payment_ref]);
    await tx.query(
      `update refund set status = 'refunded', refund_ref = coalesce($2, refund_ref), error_code = null, refunded_at = now(),
         credits_withdrawn = $3, credits_used = $4, spot_released = $5, updated_at = now()
       where id = $1`,
      [current.id, report.refundRef, creditsWithdrawn, creditsUsed, released],
    );
    return { row: current, creditsWithdrawn, ended: ended.length > 0, bookingsEnded: ended.length, names, released, sessionId };
  });
  if (!applied) return 'already';
  await tellParent(db, applied.row, applied);
  // The freed spot goes to the waitlist, in order, as after a parent's
  // cancel. The tick offers it on if this does not.
  if (applied.released && applied.sessionId !== null) {
    try {
      await offerOpenSpots(db, applied.sessionId);
    } catch (err) {
      console.error('refund: offering the freed spot failed:', err instanceof Error ? err.message : err);
    }
  }
  return 'refunded';
}

/** The parent hears once, when the refund's effects are applied: by text
 * only with their consent, by email only to an address they typed. */
async function tellParent(
  db: DbClient,
  row: RefundRow,
  effects: { creditsWithdrawn: number; ended: boolean; bookingsEnded: number; names: string[]; released: boolean },
): Promise<void> {
  let bookingId = row.booking_id;
  if (bookingId === null && row.attention_id !== null) {
    const item = await db.query<{ booking_id: number | null }>('select booking_id from payment_attention where id = $1', [row.attention_id]);
    bookingId = item.rows[0]?.booking_id ?? null;
  }
  let told = 'none';
  if (bookingId !== null) {
    const sent = await sendRefundNotice(db, bookingId, {
      amountCents: row.amount_cents,
      bookingEnded: effects.ended,
      bookingReleased: effects.released,
      creditsRemoved: effects.creditsWithdrawn,
      athleteNames: effects.names,
      bookingsEnded: effects.bookingsEnded,
    });
    const ways = [sent.text === 'sent' ? 'text' : null, sent.email === 'sent' ? 'email' : null].filter(Boolean);
    told = ways.length > 0 ? ways.join('+') : 'none';
  }
  await db.query('update refund set parent_told = $2 where id = $1', [row.id, told]);
}

/** `marketplace.purchase.refund_failed`: the money did not go back. The
 * coach sees it on Money under "Payments to resolve" and can try again. */
export async function applyRefundFailed(db: DbClient, report: RefundReport): Promise<void> {
  const row = await refundForPayment(db, report.paymentRef);
  if (row) {
    // A failure of an earlier try says nothing about a later one.
    if (report.refundRef && row.refund_ref && report.refundRef !== row.refund_ref) return;
    await markFailed(db, report.paymentRef, 'refund_failed', ['requested', 'pending', 'refunded']);
    return;
  }
  const found = await locatePayment(db, report.paymentRef, report.sellerKey);
  if (found.coachId === null) return;
  const athlete = found.booking ?? found.attention;
  await db.query(
    `insert into refund (coach_id, payment_ref, booking_id, attention_id, athlete_name, contact_phone, amount_cents, status, from_app,
                         refund_ref, error_code, failed_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'failed', false, $8, 'refund_failed', now())
     on conflict (payment_ref) do nothing`,
    [
      found.coachId,
      report.paymentRef,
      found.booking?.id ?? null,
      found.attention?.id ?? null,
      athlete?.athlete_name ?? null,
      athlete?.contact_phone ?? null,
      report.amountCents ?? found.amountCents,
      report.refundRef,
    ],
  );
}

// ---- Card disputes ----

export type DisputeState = 'open' | 'won' | 'lost';

export interface DisputeReport {
  disputeRef: string | null;
  paymentRef: string | null;
  state: DisputeState;
  amountCents: number | null;
  sellerKey: string | null;
}

/** Records a dispute and its outcome for the coach to see. Stripe handles
 * the dispute itself; nothing here moves money, bookings, or credits. An
 * outcome is never undone by a late "opened". */
export async function recordDispute(db: DbClient, report: DisputeReport): Promise<void> {
  const ref = report.disputeRef || (report.paymentRef ? `payment:${report.paymentRef}` : null);
  if (!ref) return;
  const found = report.paymentRef ? await locatePayment(db, report.paymentRef, report.sellerKey) : null;
  let coachId = found?.coachId ?? null;
  if (coachId === null && report.sellerKey) coachId = (await findCoachBySellerKey(db, report.sellerKey))?.id ?? null;
  if (coachId === null) return;
  const who = found?.booking ?? found?.attention ?? null;
  await db.query(
    `insert into payment_dispute (dispute_ref, coach_id, payment_ref, booking_id, athlete_name, contact_phone, amount_cents, state, closed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8 = 'open' then null else now() end)
     on conflict (dispute_ref) do update set
       state = case when excluded.state = 'open' then payment_dispute.state else excluded.state end,
       closed_at = case when excluded.state = 'open' then payment_dispute.closed_at else coalesce(payment_dispute.closed_at, now()) end,
       amount_cents = coalesce(excluded.amount_cents, payment_dispute.amount_cents),
       updated_at = now()`,
    [
      ref,
      coachId,
      report.paymentRef,
      found?.booking?.id ?? null,
      who?.athlete_name ?? null,
      who?.contact_phone ?? null,
      report.amountCents ?? found?.amountCents ?? null,
      report.state,
    ],
  );
}

// ---- What the coach sees ----

export interface RefundItem extends RefundRow {
  session_name: string | null;
  starts_at_utc: string | null;
  tz: string | null;
}

const REFUND_ITEM_SQL = `select r.*, st.name as session_name, s.starts_at_utc, s.tz
  from refund r
  left join payment_attention pa on pa.id = r.attention_id
  left join booking b on b.id = coalesce(r.booking_id, pa.booking_id)
  left join session s on s.id = b.session_id
  left join session_type st on st.id = s.session_type_id`;

/** The coach's refunds, newest first. */
export async function listRefunds(db: DbClient, coachId: number, limit = 20): Promise<RefundItem[]> {
  const result = await db.query<RefundItem>(`${REFUND_ITEM_SQL} where r.coach_id = $1 order by r.requested_at desc, r.id desc limit $2`, [
    coachId,
    limit,
  ]);
  return result.rows;
}

/** Refunds that need the coach: one that failed, one whose call got no
 * answer, or part of a payment refunded outside Coachatron. */
export function needsAttention(item: Pick<RefundRow, 'status' | 'error_code'>): boolean {
  return item.status === 'failed' || item.status === 'partial' || (item.status === 'requested' && item.error_code !== null);
}

/** The refund row of each payment, by payment ref. */
export async function refundsByPayment(db: DbClient, paymentRefs: string[]): Promise<Map<string, RefundRow>> {
  if (paymentRefs.length === 0) return new Map();
  const result = await db.query<RefundRow>('select * from refund where payment_ref = any($1::text[])', [paymentRefs]);
  return new Map(result.rows.map((r) => [r.payment_ref, r]));
}

function money(cents: number | null): string {
  return cents === null ? 'the payment' : formatCoachDollars(cents);
}

const TOLD: Record<string, string> = {
  text: 'The parent was told by text.',
  email: 'The parent was told by email.',
  'text+email': 'The parent was told by text and email.',
};

const FAILURE: Record<string, string> = {
  NOT_FOUND: 'Stripe has no record of this payment for your account.',
  REFUND_EXCEEDS_PAYMENT: 'Stripe says this payment was already refunded.',
  CAPABILITY_UNSUPPORTED: 'Refunds are not available for this payment.',
};

/** One or two plain sentences for the coach about a refund. */
export function describeRefund(item: Pick<RefundRow, 'status' | 'amount_cents' | 'credits_withdrawn' | 'credits_used' | 'spot_released' | 'parent_told' | 'error_code' | 'refunded_at' | 'from_app'>): string {
  const amount = money(item.amount_cents);
  switch (item.status) {
    case 'requested':
      return item.error_code === 'unavailable'
        ? `The refund of ${amount} has not gone through yet: payments did not answer. Try again in a minute.`
        : `Refunding ${amount}…`;
    case 'pending':
      return `Refund of ${amount} sent. Stripe confirms it shortly.`;
    case 'partial':
      return `${amount} of this payment was refunded outside Coachatron. The booking and its credits were not changed.`;
    case 'failed': {
      const why = FAILURE[item.error_code ?? ''] ?? '';
      if (item.refunded_at !== null) {
        return `The refund of ${amount} did not reach the parent after all. The booking and its credits were already released, so contact the parent, and try again.`;
      }
      return `The refund of ${amount} did not go through.${why ? ` ${why}` : ''} Nothing else changed.`;
    }
    case 'refunded': {
      const parts = [`Refunded ${amount}${item.from_app ? '' : ' (outside Coachatron)'}.`];
      if (item.spot_released) parts.push('The spot is free again.');
      if (item.credits_withdrawn > 0) parts.push(`${item.credits_withdrawn} unused session ${item.credits_withdrawn === 1 ? 'credit was' : 'credits were'} withdrawn.`);
      if (item.credits_used > 0) {
        parts.push(`${item.credits_used} ${item.credits_used === 1 ? 'session it bought was' : 'sessions it bought were'} already used.`);
      }
      parts.push(TOLD[item.parent_told ?? ''] ?? 'The parent could not be told: please let them know.');
      return parts.join(' ');
    }
    default:
      return `Refund of ${amount}.`;
  }
}

export interface DisputeItem {
  id: number;
  state: DisputeState;
  amount_cents: number | null;
  athlete_name: string | null;
  contact_phone: string | null;
  opened_at: string;
  closed_at: string | null;
  session_name: string | null;
  starts_at_utc: string | null;
  tz: string | null;
}

/** Open disputes first, then decided ones, newest first. */
export async function listDisputes(db: DbClient, coachId: number, limit = 20): Promise<DisputeItem[]> {
  const result = await db.query<DisputeItem>(
    `select d.id, d.state, d.amount_cents, d.athlete_name, d.contact_phone, d.opened_at, d.closed_at,
            st.name as session_name, s.starts_at_utc, s.tz
     from payment_dispute d
     left join booking b on b.id = d.booking_id
     left join session s on s.id = b.session_id
     left join session_type st on st.id = s.session_type_id
     where d.coach_id = $1
     order by (d.state = 'open') desc, d.opened_at desc, d.id desc
     limit $2`,
    [coachId, limit],
  );
  return result.rows;
}

/** What a dispute means for the coach, in plain words. */
export function describeDispute(item: Pick<DisputeItem, 'state' | 'amount_cents'>): string {
  const amount = money(item.amount_cents);
  switch (item.state) {
    case 'open':
      return `The cardholder disputed ${amount} with their bank. Stripe handles card disputes, and Coachatron holds no funds: while it is open, Stripe holds the disputed amount from your payment account. Contact Coachatron support with anything that shows the session was booked or held.`;
    case 'won':
      return `The dispute over ${amount} was decided in your favor. Stripe returns the amount to your payment account.`;
    case 'lost':
      return `The dispute over ${amount} was decided for the cardholder, so the amount stays with them. The booking and its credits were not changed.`;
    default:
      return `A dispute over ${amount}.`;
  }
}

export interface PaymentItem {
  booking_id: number;
  session_id: number;
  athlete_name: string;
  contact_phone: string;
  status: string;
  payment_source: string | null;
  gross_cents: number;
  charge_id: string;
  session_name: string;
  starts_at_utc: string;
  tz: string;
}

/** The coach's latest card payments that bought a booking, newest first.
 * A payment for several children is one item, on its first booking, with
 * the whole amount and every child's name. */
export async function listRecentPayments(db: DbClient, coachId: number, limit = 10): Promise<PaymentItem[]> {
  const result = await db.query<PaymentItem & { names: string[]; total_cents: string }>(
    `select b.id as booking_id, b.session_id, b.athlete_name, b.contact_phone, b.status, b.payment_source, b.gross_cents, b.charge_id,
            st.name as session_name, s.starts_at_utc, s.tz, pass.names, pass.total_cents
     from ${PURCHASE_FROM}
     join lateral (
       select array_agg(o.athlete_name order by o.id) as names, coalesce(sum(o.gross_cents), 0)::text as total_cents,
              min(o.id) filter (where o.gross_cents > 0) as first_id
       from booking o where o.charge_id = b.charge_id and o.session_id = b.session_id
     ) pass on true
     where st.coach_id = $1 and b.charge_id is not null and b.gross_cents > 0 and b.id = pass.first_id
     order by b.id desc
     limit $2`,
    [coachId, limit],
  );
  return result.rows.map(({ names, total_cents, ...p }) => ({
    ...p,
    athlete_name: namesList(names),
    gross_cents: Number(total_cents),
  }));
}

/** What a payment bought, for a label. */
export function purchaseLabel(paymentSource: string | null): string {
  return paymentSource === 'Pack' ? 'One-time pack' : paymentSource === 'PackageCredit' ? 'Package' : 'Drop-in';
}

/** A short state for a refund next to its booking or payment. */
export function refundLabel(item: Pick<RefundRow, 'status' | 'error_code' | 'refunded_at'>): string {
  switch (item.status) {
    case 'requested':
      return item.error_code === 'unavailable' ? 'Refund not sent yet' : 'Refunding…';
    case 'pending':
      return 'Refund sent';
    case 'refunded':
      return 'Refunded';
    case 'failed':
      return 'Refund did not go through';
    case 'partial':
      return 'Partly refunded outside Coachatron';
    default:
      return 'Refund';
  }
}

/** A refund that may be asked for again: it failed, or its answer never came. */
export function canTryAgain(item: Pick<RefundRow, 'status' | 'error_code'>): boolean {
  return item.status === 'failed' || (item.status === 'requested' && item.error_code !== null);
}
