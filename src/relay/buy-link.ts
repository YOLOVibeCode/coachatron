import { createHash } from 'node:crypto';
import { APP_BASE_URL } from '../config.js';
import { signConnectBuyLink } from '../lib/store-client.js';
import { connectProduct } from './seller.js';

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
  /** The booking's checkout token: the parent comes back to its page. */
  checkoutToken: string;
  mode: PayMode;
  itemId?: number;
  email: string;
  handle: string;
  description: string;
}): string {
  const secret = signingSecret();
  if (!secret) throw new Error('RELAY_WEBHOOK_SECRET is not configured');
  const { url } = signConnectBuyLink({
    secret,
    product: connectProduct(),
    seller: args.seller,
    amountCents: args.amountCents,
    currency: 'USD',
    user: buyerRef(args.bookingId, args.mode, args.itemId),
    email: args.email,
    description: args.description,
    returnUrl: `${process.env.APP_BASE_URL ?? APP_BASE_URL}/c/${args.handle}/checkout/${args.checkoutToken}?paid=1`,
    baseUrl: storeBaseUrl(),
  });
  return url;
}

/** Whether a checkout URL is the parent's way back from the hosted payment
 * page: its return link ends in ?paid=1. The relay hands that link to the
 * payment provider as it is, and the provider sends the parent back to it
 * exactly (Stripe), or adds its own query after it. A provider that adds
 * "?" without looking for one already there gives "?paid=1?orderId=...",
 * so a later "?" is read as "&". */
export function cameBackFromPaying(url: string): boolean {
  const at = url.indexOf('?');
  if (at === -1) return false;
  const query = new URLSearchParams(url.slice(at + 1).split('#')[0].replace(/\?/g, '&'));
  return query.getAll('paid').includes('1');
}

/** The stand-in address domain for a parent who gave no email. Nothing is
 * ever sent to it. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'book.coachatron.test';

/** The email a buy link carries: the one the parent typed, or for a parent
 * who gave none a stand-in made from the checkout token by a one-way hash.
 * It is the same for every try at one checkout and says nothing about the
 * parent: no phone digits, and not the token, which opens the checkout
 * page, since the payment provider shows this address to the coach. */
export function buyerEmail(email: string | null, checkoutToken: string): string {
  if (email && email.includes('@')) return email;
  const id = createHash('sha256').update(`buyer:${checkoutToken}`).digest('hex').slice(0, 20);
  return `b-${id}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}
