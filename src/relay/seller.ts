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
