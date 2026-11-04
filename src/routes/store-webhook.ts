import { Router } from 'express';
import type { StoreEvent } from '@noctusoft/store-client';
import { getDb } from '../db/client.js';
import { createWebhookHandler } from '../lib/store-client.js';
import { parseBuyerRef } from '../relay/buy-link.js';
import {
  createCredit,
  createSubscriptionRecord,
  getBooking,
  getPackageById,
  getPlanById,
  bookPendingBooking,
} from '../domain/pricing.js';
import { checkOverflow } from '../domain/cascade.js';
import { findCoachBySellerKey } from '../domain/auth.js';
import { recordChargesEnabled, refreshPaymentsStatus } from '../domain/payments.js';
import { connectProduct } from '../relay/seller.js';
import { sendBookingConfirmation } from '../domain/bookingMessages.js';

export const storeWebhookRouter = Router();

const seen = new Set<string>();

async function onPaid(event: StoreEvent): Promise<void> {
  const parsed = parseBuyerRef(event.buyer?.userId);
  if (!parsed) return;
  const db = getDb();
  const booking = await getBooking(db, parsed.bookingId);
  if (!booking) return;
  if (booking.status !== 'pending') return;

  const paymentRef = (event.refs?.paymentId || event.refs?.orderId || event.id) ?? null;
  const amount = event.money?.amountCents ?? booking.gross_cents;
  const capacity = await capacityForSession(booking.session_id);
  let booked = false;
  const markBookingBooked = (
    _db: typeof db,
    _id: number,
    fields: { paymentSource: string; creditId: number | null; chargeId: string | null; grossCents: number | null },
  ) => bookPendingBooking(db, booking, capacity, fields);

  if (parsed.mode === 'dropin') {
    booked = await markBookingBooked(db, booking.id, {
      paymentSource: 'DropIn',
      creditId: null,
      chargeId: paymentRef,
      grossCents: amount,
    });
  } else if (parsed.mode === 'package' && parsed.itemId != null) {
    const coachId = await coachIdForBooking(booking.session_id);
    if (!coachId) return;
    const pkg = await getPackageById(db, coachId, parsed.itemId);
    if (!pkg) return;
    const expiresAt = pkg.expires_days ? new Date(Date.now() + pkg.expires_days * 24 * 60 * 60 * 1000) : null;
    const creditId = await createCredit(
      db,
      coachId,
      booking.contact_phone,
      pkg.id,
      `package:${pkg.id}`,
      pkg.credits - 1,
      expiresAt,
    );
    booked = await markBookingBooked(db, booking.id, {
      paymentSource: 'PackageCredit',
      creditId,
      chargeId: paymentRef,
      grossCents: amount,
    });
  } else if (parsed.mode === 'plan' && parsed.itemId != null) {
    const coachId = await coachIdForBooking(booking.session_id);
    if (!coachId) return;
    const plan = await getPlanById(db, coachId, parsed.itemId);
    if (!plan) return;
    await createSubscriptionRecord(db, plan.id, booking.contact_phone, paymentRef ?? event.id);
    const creditId = await createCredit(
      db,
      coachId,
      booking.contact_phone,
      null,
      `plan:${plan.id}`,
      plan.credits_per_month - 1,
      null,
    );
    booked = await markBookingBooked(db, booking.id, {
      paymentSource: 'Subscription',
      creditId,
      chargeId: paymentRef,
      grossCents: plan.price_cents,
    });
  } else {
    return;
  }

  if (!booked) return;
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

async function capacityForSession(sessionId: number): Promise<number> {
  const row = await getDb().query<{ capacity: number }>(
    'select st.capacity from session s join session_type st on st.id = s.session_type_id where s.id = $1',
    [sessionId],
  );
  return row.rows[0]?.capacity ?? 0;
}

async function coachIdForBooking(sessionId: number): Promise<number | null> {
  const db = getDb();
  const row = await db.query<{ coach_id: number }>(
    `select st.coach_id
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1`,
    [sessionId],
  );
  return row.rows[0]?.coach_id ?? null;
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
    idempotency: {
      seen: (id) => seen.has(id),
      remember: (id) => {
        seen.add(id);
      },
    },
    on: {
      'marketplace.purchase.paid': onPaid,
      'purchase.paid': onPaid,
      'seller.updated': onSellerEvent,
      'seller.disconnected': onSellerEvent,
    },
  });
  void handler.node(req, res);
});
