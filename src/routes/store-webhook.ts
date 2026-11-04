import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { StoreEvent } from '@noctusoft/store-client';
import { getDb, type DbClient } from '../db/client.js';
import { createWebhookHandler } from '../lib/store-client.js';
import { parseBuyerRef, type PayMode } from '../relay/buy-link.js';
import {
  bookPendingBooking,
  creditCancelledBooking,
  ensureSubscriptionRecord,
  getBooking,
  getPackageForPayment,
  getPlanForPayment,
  grantBookingCredit,
  type BookingRow,
  type CreditGrant,
} from '../domain/pricing.js';
import { checkOverflow } from '../domain/cascade.js';
import { findCoachBySellerKey } from '../domain/auth.js';
import { recordChargesEnabled, refreshPaymentsStatus } from '../domain/payments.js';
import { connectProduct } from '../relay/seller.js';
import { sendBookingConfirmation, sendPaymentCredited } from '../domain/bookingMessages.js';
import { recordPaymentAttention, type AttentionReason } from '../domain/paymentAttention.js';

export const storeWebhookRouter = Router();

/** A claim that never finished (the process stopped part way) is taken
 * again after this long. */
const STALE_CLAIM_MINUTES = 5;

/** Records the event id before handling it: 'claimed' to handle it now,
 * 'done' when it was handled already, 'busy' while another delivery is
 * handling it. */
async function claimEvent(db: DbClient, eventId: string, type: string): Promise<'claimed' | 'done' | 'busy'> {
  const result = await db.query<{ event_id: string }>(
    `insert into store_event (event_id, type) values ($1, $2)
     on conflict (event_id) do update set claimed_at = now()
       where store_event.processed_at is null
         and store_event.claimed_at < now() - make_interval(mins => $3::int)
     returning event_id`,
    [eventId, type, STALE_CLAIM_MINUTES],
  );
  if (result.rows.length === 1) return 'claimed';
  const existing = await db.query<{ processed_at: string | null }>('select processed_at from store_event where event_id = $1', [eventId]);
  return existing.rows[0]?.processed_at ? 'done' : 'busy';
}

async function finishEvent(db: DbClient, eventId: string): Promise<void> {
  await db.query('update store_event set processed_at = now() where event_id = $1', [eventId]);
}

/** Handling failed: let the relay's retry handle it again. */
async function releaseEvent(db: DbClient, eventId: string): Promise<void> {
  await db.query('delete from store_event where event_id = $1 and processed_at is null', [eventId]);
}

function headerValue(headers: unknown, name: string): string {
  const value = (headers as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
}

interface PaidSession {
  coach_id: number;
  status: string;
  starts_at_utc: string;
  capacity: number;
  price_cents: number;
}

async function loadPaidSession(db: DbClient, sessionId: number): Promise<PaidSession | null> {
  const result = await db.query<PaidSession>(
    `select st.coach_id, s.status, s.starts_at_utc, st.capacity, st.price_cents
     from session s join session_type st on st.id = s.session_type_id
     where s.id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** The coach a payment's seller key names, the same way a seller event is
 * matched to its coach. */
async function coachIdForSeller(db: DbClient, sellerKey: string | null | undefined): Promise<number | null> {
  if (!sellerKey) return null;
  return (await findCoachBySellerKey(db, sellerKey))?.id ?? null;
}

/** What the buyer ref says was bought, priced and credited as it stands. */
interface PaidItem {
  mode: PayMode;
  paymentSource: 'DropIn' | 'PackageCredit' | 'Subscription';
  priceCents: number;
  /** Sessions the purchase is worth, the first of which is this booking. */
  sessions: number;
  packageId: number | null;
  planId: number | null;
  source: string;
  expiresAt: Date | null;
}

async function paidItem(db: DbClient, coachId: number, session: PaidSession, sessionId: number, mode: PayMode, itemId: number | null): Promise<PaidItem | null> {
  if (mode === 'dropin') {
    return {
      mode,
      paymentSource: 'DropIn',
      priceCents: session.price_cents,
      sessions: 1,
      packageId: null,
      planId: null,
      source: `cancelled-session:${sessionId}`,
      expiresAt: null,
    };
  }
  if (itemId === null) return null;
  if (mode === 'package') {
    const pkg = await getPackageForPayment(db, coachId, itemId);
    if (!pkg) return null;
    return {
      mode,
      paymentSource: 'PackageCredit',
      priceCents: pkg.price_cents,
      sessions: pkg.credits,
      packageId: pkg.id,
      planId: null,
      source: `package:${pkg.id}`,
      expiresAt: pkg.expires_days ? new Date(Date.now() + pkg.expires_days * 24 * 60 * 60 * 1000) : null,
    };
  }
  const plan = await getPlanForPayment(db, coachId, itemId);
  if (!plan) return null;
  return {
    mode,
    paymentSource: 'Subscription',
    priceCents: plan.price_cents,
    sessions: plan.credits_per_month,
    packageId: null,
    planId: plan.id,
    source: `plan:${plan.id}`,
    expiresAt: null,
  };
}

/** The credit left after this booking's own session (package or pack). */
async function grantRemainder(db: DbClient, booking: BookingRow, coachId: number, item: PaidItem, paymentRef: string): Promise<void> {
  if (item.mode === 'dropin') return;
  if (item.planId !== null) await ensureSubscriptionRecord(db, item.planId, booking.contact_phone, paymentRef);
  const grant: CreditGrant = {
    coachId,
    contactPhone: booking.contact_phone,
    packageId: item.packageId,
    source: item.source,
    remaining: item.sessions - 1,
    expiresAt: item.expiresAt,
  };
  await grantBookingCredit(db, booking.id, grant);
}

async function handlePaid(db: DbClient, event: StoreEvent, eventId: string): Promise<void> {
  const parsed = parseBuyerRef(event.buyer?.userId);
  const paymentRef = event.refs?.paymentId || event.refs?.orderId || event.id || eventId;
  const amount = typeof event.money?.amountCents === 'number' ? event.money.amountCents : null;
  const attention = async (
    reason: AttentionReason,
    who: { coachId: number | null; booking?: BookingRow | null },
    extra: { expectedCents?: number | null; outcome?: string | null } = {},
  ) =>
    recordPaymentAttention(db, {
      eventId,
      reason,
      coachId: who.coachId,
      bookingId: who.booking?.id ?? null,
      amountCents: amount,
      paymentRef,
      athleteName: who.booking?.athlete_name ?? null,
      contactPhone: who.booking?.contact_phone ?? null,
      ...extra,
    });

  const booking = parsed ? await getBooking(db, parsed.bookingId) : null;
  const session = booking ? await loadPaidSession(db, booking.session_id) : null;
  if (!parsed || !booking || !session) {
    await attention('booking_missing', { coachId: await coachIdForSeller(db, event.seller?.key) });
    return;
  }
  const who = { coachId: session.coach_id, booking };
  const item = await paidItem(db, session.coach_id, session, booking.session_id, parsed.mode, parsed.itemId);

  if (booking.status !== 'pending') {
    // The same payment again (another event for it): finish what it began.
    if (booking.charge_id === paymentRef) {
      if (booking.status === 'booked' && item && booking.credit_id === null) await grantRemainder(db, booking, session.coach_id, item, paymentRef);
      return;
    }
    await attention(booking.status === 'cancelled' ? 'booking_cancelled' : 'already_booked', who);
    return;
  }
  if (!item) {
    await attention('item_missing', who);
    return;
  }
  if (amount === null || amount !== item.priceCents) {
    await attention('amount_mismatch', who, { expectedCents: item.priceCents });
    return;
  }

  // The coach cancelled the session while this parent was paying: the whole
  // payment becomes credit with the coach, the same as a coach's cancel
  // gives back, and the parent is told.
  if (session.status === 'cancelled') {
    const grant: CreditGrant = {
      coachId: session.coach_id,
      contactPhone: booking.contact_phone,
      packageId: item.packageId,
      source: item.source,
      remaining: item.sessions,
      expiresAt: item.expiresAt,
    };
    const creditId = await creditCancelledBooking(db, booking.id, grant, {
      paymentSource: item.paymentSource,
      chargeId: paymentRef,
      grossCents: amount,
    });
    if (creditId === null) {
      await attention('already_booked', who);
      return;
    }
    if (item.planId !== null) await ensureSubscriptionRecord(db, item.planId, booking.contact_phone, paymentRef);
    const told = await sendPaymentCredited(db, booking.id, item.sessions);
    const reached = told.text === 'sent' || told.email === 'sent';
    await attention('session_cancelled', who, { outcome: `credit:${item.sessions}:${reached ? 'told' : 'not-told'}` });
    return;
  }
  if (session.status !== 'scheduled' || new Date(session.starts_at_utc) <= new Date()) {
    await attention('session_started', who);
    return;
  }

  // Books while the hold stands, or after it lapsed while there is still room.
  const booked = await bookPendingBooking(db, booking, session.capacity, {
    paymentSource: item.paymentSource,
    creditId: null,
    chargeId: paymentRef,
    grossCents: amount,
  });
  if (!booked) {
    const now = await getBooking(db, booking.id);
    await attention(now && now.status !== 'pending' ? 'already_booked' : 'session_full', who);
    return;
  }
  await grantRemainder(db, booking, session.coach_id, item, paymentRef);
  await sendBookingConfirmation(db, booking.id);
  void checkOverflow(db, booking.session_id);
}

/** The relay forwards the payment provider's account updates as
 * seller.updated (and seller.disconnected), keyed by the coach's seller key. */
async function onSellerEvent(event: StoreEvent): Promise<void> {
  const key = event.seller?.key;
  if (!key) return;
  // Each environment sells through its own Connect app; another one's seller
  // with the same key is a different coach.
  if (event.product && event.product !== connectProduct()) return;
  const db = getDb();
  const coach = await findCoachBySellerKey(db, key);
  if (!coach) return;
  if (event.type === 'seller.disconnected') {
    await recordChargesEnabled(db, coach, false);
    return;
  }
  const charges = event.seller?.chargesEnabled;
  if (typeof charges === 'boolean') await recordChargesEnabled(db, coach, charges);
  else await refreshPaymentsStatus(db, coach);
}

/** Every paid event is claimed in the database first, so a redelivery or a
 * restart never handles it twice, and is either booked or kept for the
 * coach with a reason. */
async function onPaid(event: StoreEvent, context: { headers: unknown }): Promise<void> {
  const db = getDb();
  const paymentRef = event.refs?.paymentId || event.refs?.orderId || null;
  const eventId =
    event.id || headerValue(context.headers, 'x-relay-event-id') || (paymentRef ? `payment:${paymentRef}` : `unidentified:${randomUUID()}`);
  const claim = await claimEvent(db, eventId, String(event.type ?? ''));
  if (claim === 'done') return;
  // Not a 2xx, so the relay delivers it again later: by then it is either
  // handled, or its unfinished claim can be taken over.
  if (claim === 'busy') throw new Error(`store event ${eventId} is being handled by another delivery`);
  try {
    await handlePaid(db, event, eventId);
    await finishEvent(db, eventId);
  } catch (err) {
    await releaseEvent(db, eventId);
    throw err;
  }
}

storeWebhookRouter.post('/', (req, res) => {
  const secret = process.env.RELAY_WEBHOOK_SECRET ?? '';
  if (!secret) {
    res.status(503).json({ error: 'Webhook secret not configured' });
    return;
  }
  const callbackUrl =
    process.env.STORE_WEBHOOK_URL ?? `${process.env.APP_BASE_URL ?? 'https://coachatron.com'}/webhooks/store`;
  const handler = createWebhookHandler({
    secret,
    callbackUrl,
    on: {
      'marketplace.purchase.paid': onPaid,
      'purchase.paid': onPaid,
      'seller.updated': onSellerEvent,
      'seller.disconnected': onSellerEvent,
    },
  });
  void handler.node(req, res);
});
