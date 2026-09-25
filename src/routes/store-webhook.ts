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
  markBookingBooked,
} from '../domain/pricing.js';
import { checkOverflow } from '../domain/cascade.js';

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

  if (parsed.mode === 'dropin') {
    await markBookingBooked(db, booking.id, {
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
    await markBookingBooked(db, booking.id, {
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
    await markBookingBooked(db, booking.id, {
      paymentSource: 'Subscription',
      creditId,
      chargeId: paymentRef,
      grossCents: plan.price_cents,
    });
  } else {
    return;
  }

  void checkOverflow(db, booking.session_id);
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
    },
  });
  void handler.node(req, res);
});
