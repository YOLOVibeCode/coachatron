import { APP_FEE_BPS } from '../config.js';
import { relayFetch } from './http.js';

const PRODUCT = 'coachatron';

function recipientPath(recipientKey: string, suffix: string): string {
  return `/connect/${PRODUCT}/recipients/${encodeURIComponent(recipientKey)}${suffix}`;
}

export class ConnectHubError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parseConnectResponse(res: Response, context: string): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body;
  const code =
    typeof body.error === 'string'
      ? body.error
      : typeof body.code === 'string'
        ? body.code
        : null;
  throw new ConnectHubError(res.status, `${context}: ${res.status}`, code);
}

export async function postAgreement(recipientKey: string): Promise<void> {
  const res = await relayFetch(recipientPath(recipientKey, '/agreement'), {
    method: 'POST',
    body: JSON.stringify({ agreement_version: 'v1' }),
  });
  await parseConnectResponse(res, 'connect hub agreement');
}

export interface OnboardResult {
  url: string;
  stripeAccountId: string;
}

export async function postOnboard(
  recipientKey: string,
  input: { email?: string; refreshUrl: string; returnUrl: string },
): Promise<OnboardResult> {
  const res = await relayFetch(recipientPath(recipientKey, '/onboard'), {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
    }),
  });
  const body = await parseConnectResponse(res, 'connect hub onboard');
  const url = String(body.url ?? '');
  const stripeAccountId = String(body.stripe_account_id ?? body.stripeAccountId ?? '');
  if (!url) throw new Error('connect hub onboard missing url');
  return { url, stripeAccountId };
}

export interface ChargeCheckoutRequest {
  recipientKey: string;
  idempotencyKey: string;
  amountCents: number;
  successUrl: string;
  cancelUrl?: string;
  note?: string;
  buyerEmailAddress?: string;
}

export interface ChargeCheckoutResult {
  url: string;
  sessionId: string;
  applicationFeeAmount: number;
}

export async function createChargeCheckout(req: ChargeCheckoutRequest): Promise<ChargeCheckoutResult> {
  const res = await relayFetch(recipientPath(req.recipientKey, '/charge'), {
    method: 'POST',
    body: JSON.stringify({
      amount_cents: req.amountCents,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      note: req.note,
      buyer_email_address: req.buyerEmailAddress,
      app_fee_bps: APP_FEE_BPS,
      idempotency_key: req.idempotencyKey,
    }),
  });
  const body = await parseConnectResponse(res, 'connect hub charge');
  const payment = (body.payment ?? {}) as Record<string, unknown>;
  const url = String(body.url ?? '');
  const sessionId = String(body.sessionId ?? body.session_id ?? '');
  if (!url || !sessionId) throw new Error('connect hub charge missing url or sessionId');
  return {
    url,
    sessionId,
    applicationFeeAmount: Number(payment.application_fee_amount ?? payment.applicationFeeAmount ?? 0),
  };
}

export interface SubscriptionCheckoutRequest {
  recipientKey: string;
  idempotencyKey: string;
  priceId: string;
  successUrl: string;
  email?: string;
}

export interface SubscriptionCheckoutResult {
  url: string;
  applicationFeePercent: number;
  sessionId: string;
}

export async function createSubscriptionCheckout(
  req: SubscriptionCheckoutRequest,
): Promise<SubscriptionCheckoutResult> {
  const res = await relayFetch(recipientPath(req.recipientKey, '/subscriptions'), {
    method: 'POST',
    body: JSON.stringify({
      price_id: req.priceId,
      success_url: req.successUrl,
      email: req.email,
      app_fee_bps: APP_FEE_BPS,
      idempotency_key: req.idempotencyKey,
    }),
  });
  const body = await parseConnectResponse(res, 'connect hub subscription');
  const url = String(body.url ?? '');
  const sessionId = String(body.sessionId ?? body.session_id ?? '');
  if (!url) throw new Error('connect hub subscription missing url');
  return {
    url,
    sessionId: sessionId || `sub_${req.idempotencyKey}`,
    applicationFeePercent: Number(body.application_fee_percent ?? body.applicationFeePercent ?? 0),
  };
}

export interface CreatePlanPriceRequest {
  recipientKey: string;
  name: string;
  priceCents: number;
  idempotencyKey: string;
}

export async function createPlanPrice(req: CreatePlanPriceRequest): Promise<string> {
  const res = await relayFetch(recipientPath(req.recipientKey, '/prices'), {
    method: 'POST',
    body: JSON.stringify({
      name: req.name,
      price_cents: req.priceCents,
      cadence: 'monthly',
      idempotency_key: req.idempotencyKey,
    }),
  });
  const body = await parseConnectResponse(res, 'connect hub price');
  const priceId = String(body.price_id ?? body.priceId ?? body.id ?? '');
  if (!priceId) throw new Error('connect hub price missing price_id');
  return priceId;
}
