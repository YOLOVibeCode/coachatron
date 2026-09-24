import crypto from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { appBaseUrl, CONNECT_WEBHOOK_PATH, connectWebhookSecret } from '../config.js';
import { findCoachByRecipientKey, setConnectReady } from './connect.js';
import {
  fulfillPaidCheckout,
  getBookingByCheckoutSession,
  grantPlanRenewalCredits,
  updateSubscriptionStatus,
  type FulfillCheckoutContext,
} from './pricing.js';

export function connectWebhookCallbackUrl(): string {
  return `${appBaseUrl()}${CONNECT_WEBHOOK_PATH}`;
}

export function verifyConnectSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = connectWebhookSecret();
  if (!secret) return false;
  if (!signatureHeader) return false;
  const payload = connectWebhookCallbackUrl() + rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  return expected === signatureHeader.trim();
}

export async function recordWebhookEvent(db: DbClient, eventId: string): Promise<boolean> {
  const result = await db.query<{ stripe_event_id: string }>(
    `insert into connect_webhook_event (stripe_event_id) values ($1)
     on conflict (stripe_event_id) do nothing
     returning stripe_event_id`,
    [eventId],
  );
  return result.rows.length === 1;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function loadFulfillContextForBooking(
  db: DbClient,
  bookingId: number,
): Promise<FulfillCheckoutContext | null> {
  const result = await db.query<{
    coach_id: number;
    session_id: number;
    price_cents: number;
    contact_phone: string;
  }>(
    `select st.coach_id, b.session_id, st.price_cents, b.contact_phone
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     where b.id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    coachId: row.coach_id,
    sessionId: row.session_id,
    sessionPriceCents: row.price_cents,
    contactPhone: row.contact_phone,
  };
}

function sessionIdFromObject(obj: Record<string, unknown>): string | null {
  const direct = obj.id;
  if (typeof direct === 'string' && direct.startsWith('cs_')) return direct;
  const session = obj.session;
  if (typeof session === 'string') return session;
  return null;
}

function amountFromObject(obj: Record<string, unknown>): number {
  const amount = obj.amount_total ?? obj.amount_received ?? obj.amount;
  return Number(amount ?? 0);
}

function paymentRefFromObject(obj: Record<string, unknown>): string {
  const pi = obj.payment_intent ?? obj.id;
  return String(pi ?? '');
}

export async function handleConnectWebhookEvent(db: DbClient, event: StripeEvent): Promise<void> {
  const obj = event.data.object;
  const recipientKey =
    typeof obj.metadata === 'object' && obj.metadata !== null
      ? String((obj.metadata as Record<string, unknown>).recipientKey ?? '')
      : '';

  if (event.type === 'account.updated') {
    const chargesEnabled = obj.charges_enabled === true;
    const meta = obj.metadata as Record<string, unknown> | undefined;
    const key = recipientKey || String(meta?.recipientKey ?? '');
    const coach = key ? await findCoachByRecipientKey(db, key) : null;
    if (coach && chargesEnabled) {
      const accountId = String(obj.id ?? coach.stripe_account_id ?? '');
      await setConnectReady(db, coach.id, accountId || null);
    }
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const sessionId = sessionIdFromObject(obj) ?? String(obj.id ?? '');
    if (!sessionId) return;
    const booking = await getBookingByCheckoutSession(db, sessionId);
    if (!booking) return;
    const ctx = await loadFulfillContextForBooking(db, booking.id);
    if (!ctx) return;
    const gross = amountFromObject(obj);
    const ref = paymentRefFromObject(obj);
    await fulfillPaidCheckout(db, booking, ctx, ref, gross || ctx.sessionPriceCents);
    return;
  }

  if (event.type === 'payment_intent.succeeded') {
    const sessionId =
      typeof obj.metadata === 'object' && obj.metadata !== null
        ? String((obj.metadata as Record<string, unknown>).checkout_session_id ?? '')
        : '';
    const lookupId = sessionId || String(obj.id ?? '');
    const booking = await getBookingByCheckoutSession(db, lookupId);
    if (!booking) return;
    const ctx = await loadFulfillContextForBooking(db, booking.id);
    if (!ctx) return;
    const gross = Number(obj.amount_received ?? obj.amount ?? 0);
    await fulfillPaidCheckout(db, booking, ctx, String(obj.id ?? ''), gross || ctx.sessionPriceCents);
    return;
  }

  if (event.type.startsWith('customer.subscription.')) {
    const subId = String(obj.id ?? '');
    const status = String(obj.status ?? 'active');
    if (subId) await updateSubscriptionStatus(db, subId, status);
    return;
  }

  if (event.type === 'invoice.paid') {
    const subDetails = obj.subscription;
    const subId = typeof subDetails === 'string' ? subDetails : String(subDetails ?? '');
    if (!subId) return;
    const subRow = await db.query<{ plan_id: number; contact_phone: string }>(
      'select plan_id, contact_phone from subscription where square_subscription_id = $1',
      [subId],
    );
    const row = subRow.rows[0];
    if (row) await grantPlanRenewalCredits(db, row.plan_id, row.contact_phone);
    return;
  }

  if (event.type === 'charge.refunded') {
    return;
  }
}

export async function processConnectWebhook(db: DbClient, rawBody: Buffer, signatureHeader: string | undefined): Promise<{ status: number; body: string }> {
  if (!verifyConnectSignature(rawBody, signatureHeader)) {
    return { status: 401, body: 'invalid signature' };
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
  } catch {
    return { status: 400, body: 'invalid json' };
  }

  if (!event.id || !event.type) {
    return { status: 400, body: 'invalid event' };
  }

  const isNew = await recordWebhookEvent(db, event.id);
  if (!isNew) {
    return { status: 200, body: 'duplicate' };
  }

  await handleConnectWebhookEvent(db, event);
  return { status: 200, body: 'ok' };
}
