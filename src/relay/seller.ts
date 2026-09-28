import { relayFetch } from './http.js';

/** The relay Connect app this deployment sells through; each environment has its own. */
export function connectProduct(): string {
  return process.env.RELAY_CONNECT_PRODUCT || 'coachatron';
}

function sellerPath(sellerKey: string, suffix = ''): string {
  return `/connect/${encodeURIComponent(connectProduct())}/recipients/${encodeURIComponent(sellerKey)}${suffix}`;
}

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
  /** The agreement version the coach accepted, or null. */
  agreementVersion: string | null;
}

/** null when the coach has never started (the relay has no seller for them). */
export async function getSellerStatus(sellerKey: string): Promise<SellerStatus | null> {
  const res = await relayFetch(sellerPath(sellerKey));
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: String(body.status ?? 'not_connected'),
    chargesEnabled: body.chargesEnabled === true,
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

/** A relay onboarding link. The relay sends the coach back to `returnUrl?seller=connected|pending|failed`. */
export async function startSellerOnboarding(sellerKey: string, args: { returnUrl: string; email: string | null }): Promise<string> {
  const res = await relayFetch(sellerPath(sellerKey, '/onboard'), {
    method: 'POST',
    body: JSON.stringify({ returnUrl: args.returnUrl, ...(args.email ? { email: args.email } : {}) }),
  });
  if (!res.ok) return fail(res);
  const body = (await res.json()) as Record<string, unknown>;
  const url = String(body.url ?? '');
  if (!url) throw new SellerError(502, 'NO_URL');
  return url;
}
