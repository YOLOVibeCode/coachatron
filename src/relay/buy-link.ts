import { APP_BASE_URL } from '../config.js';
import { signConnectBuyLink } from '../lib/store-client.js';

export type PayMode = 'dropin' | 'package' | 'plan';

function storeBaseUrl(): string {
  return (process.env.STORE_BASE_URL ?? process.env.RELAY_BASE_URL ?? 'https://store.noctusoft.com').replace(/\/$/, '');
}

function signingSecret(): string {
  return process.env.RELAY_WEBHOOK_SECRET ?? '';
}

export function buyerRef(bookingId: number, mode: PayMode, itemId?: number): string {
  return itemId != null ? `booking:${bookingId}:${mode}:${itemId}` : `booking:${bookingId}:${mode}`;
}

export function parseBuyerRef(
  raw: string | null | undefined,
): { bookingId: number; mode: PayMode; itemId: number | null } | null {
  if (!raw) return null;
  const match = /^booking:(\d+):(dropin|package|plan)(?::(\d+))?$/.exec(raw);
  if (!match) return null;
  return {
    bookingId: Number(match[1]),
    mode: match[2] as PayMode,
    itemId: match[3] ? Number(match[3]) : null,
  };
}

export function connectBuyUrl(args: {
  seller: string;
  amountCents: number;
  bookingId: number;
  mode: PayMode;
  itemId?: number;
  email: string;
  handle: string;
}): string {
  const secret = signingSecret();
  if (!secret) throw new Error('RELAY_WEBHOOK_SECRET is not configured');
  const { url } = signConnectBuyLink({
    secret,
    product: 'coachatron',
    seller: args.seller,
    amountCents: args.amountCents,
    currency: 'USD',
    user: buyerRef(args.bookingId, args.mode, args.itemId),
    email: args.email,
    returnUrl: `${process.env.APP_BASE_URL ?? APP_BASE_URL}/c/${args.handle}/checkout/${args.bookingId}`,
    baseUrl: storeBaseUrl(),
  });
  return url;
}

export function buyerEmail(phone: string, email: string | null, bookingId: number): string {
  if (email && email.includes('@')) return email;
  const digits = phone.replace(/\D/g, '') || String(bookingId);
  return `${digits}@book.coachatron.test`;
}
