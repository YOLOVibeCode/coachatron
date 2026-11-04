import { relayFetch } from './http.js';

/** The relay Connect app this deployment sells through; each environment has its own. */
export function connectProduct(): string {
  return process.env.RELAY_CONNECT_PRODUCT || 'coachatron';
}

function sellerPath(sellerKey: string, suffix = ''): string {
  return `/connect/${encodeURIComponent(connectProduct())}/recipients/${encodeURIComponent(sellerKey)}${suffix}`;
}

const STATUS_TIMEOUT_MS = 5000;

export class SellerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`relay seller call failed: ${status} ${code}`);
  }
}

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  throw new SellerError(res.status, String(body.code ?? ''));
}

export interface SellerStatus {
  status: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** The agreement version the coach accepted, or null. */
  agreementVersion: string | null;
  /** Whether the seller's payment account takes test or live money; null
   * when the relay did not say. */
  mode: 'test' | 'live' | null;
}

/** 'test' or 'live' as the relay writes a mode, or null for anything else. */
export function relayMode(value: unknown): 'test' | 'live' | null {
  return value === 'test' || value === 'live' ? value : null;
}

/** null when the coach has never started (the relay has no seller for them). */
export async function getSellerStatus(sellerKey: string): Promise<SellerStatus | null> {
  // The public page and the tick job ask too; a stuck relay must not hold them.
  const res = await relayFetch(sellerPath(sellerKey), { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: String(body.status ?? 'not_connected'),
    chargesEnabled: body.chargesEnabled === true,
    payoutsEnabled: body.payoutsEnabled === true,
    agreementVersion: typeof body.agreementVersion === 'string' ? body.agreementVersion : null,
    mode: relayMode(body.mode),
  };
}

export async function acceptSellerAgreement(sellerKey: string, version: string): Promise<void> {
  const res = await relayFetch(sellerPath(sellerKey, '/agreement'), {
    method: 'POST',
    body: JSON.stringify({ agreement_version: version }),
  });
  if (!res.ok) return fail(res);
}

/** What the app already knows about the coach, offered to prefill the
 * provider's onboarding form. Every field is optional. */
export interface SellerProfile {
  /** E.164. */
  phone?: string | null;
  entityType?: 'individual' | 'company';
  /** The coach's public page. */
  businessUrl?: string;
  productDescription?: string;
}

function profileFields(profile: SellerProfile | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!profile) return out;
  for (const key of ['phone', 'entityType', 'businessUrl', 'productDescription'] as const) {
    const value = profile[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

/**
 * A relay onboarding link. The relay sends the coach back to `returnUrl?seller=connected|pending|failed`.
 * For a connected coach the same link opens the form for changing bank and identity details.
 */
export async function startSellerOnboarding(
  sellerKey: string,
  args: { returnUrl: string; email: string | null; profile?: SellerProfile },
): Promise<string> {
  const base = { returnUrl: args.returnUrl, ...(args.email ? { email: args.email } : {}) };
  const extra = profileFields(args.profile);
  const post = (body: Record<string, string>) =>
    relayFetch(sellerPath(sellerKey, '/onboard'), { method: 'POST', body: JSON.stringify(body) });
  let res = await post({ ...base, ...extra });
  // A relay that does not take the profile fields still gets the coach onboard.
  if ((res.status === 400 || res.status === 422) && Object.keys(extra).length > 0) res = await post(base);
  if (!res.ok) return fail(res);
  const body = (await res.json()) as Record<string, unknown>;
  const url = String(body.url ?? '');
  if (!url) throw new SellerError(502, 'NO_URL');
  return url;
}

/** How long a refund call may take before the app stops waiting. The same
 * idempotency key is sent again on the next try, so a refund the relay made
 * while the app was not listening is never made twice. */
const REFUND_TIMEOUT_MS = 15000;

export interface SellerRefund {
  /** The relay's ref for the refund (opaque). */
  refundRef: string | null;
  paymentRef: string;
  /** 'succeeded', 'pending' or 'failed', as the relay reports it. */
  status: string;
  amountCents: number | null;
}

/**
 * Refunds a payment made to this seller, through the relay's seller refund
 * route (`POST /connect/:product/recipients/:seller/refunds`). With no
 * `amountCents` the relay refunds what is left of the payment; the platform
 * fee is returned with it. The same `idempotencyKey` always names the same
 * refund. A refusal throws SellerError with the relay's status and code.
 */
export async function refundSellerPayment(
  sellerKey: string,
  args: { paymentRef: string; idempotencyKey: string; amountCents?: number },
): Promise<SellerRefund> {
  const body: Record<string, unknown> = { paymentRef: args.paymentRef, idempotencyKey: args.idempotencyKey };
  if (args.amountCents !== undefined) body.amountCents = args.amountCents;
  const res = await relayFetch(sellerPath(sellerKey, '/refunds'), {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
  });
  if (!res.ok) return fail(res);
  const out = (await res.json()) as Record<string, unknown>;
  return {
    refundRef: typeof out.refundRef === 'string' && out.refundRef ? out.refundRef : null,
    paymentRef: typeof out.paymentRef === 'string' && out.paymentRef ? out.paymentRef : args.paymentRef,
    status: typeof out.status === 'string' ? out.status : 'pending',
    amountCents: typeof out.amountCents === 'number' ? out.amountCents : null,
  };
}
