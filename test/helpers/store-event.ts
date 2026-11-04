import { createHmac } from 'node:crypto';

export const TEST_STORE_SECRET = 'test-store-secret';

export function storeEventHeaders(callbackUrl: string, body: string, secret = TEST_STORE_SECRET) {
  return {
    'content-type': 'application/json',
    'x-noctusoft-signature': createHmac('sha256', secret).update(body).digest('hex'),
    'x-relay-signature': createHmac('sha256', secret).update(callbackUrl).update(body).digest('base64'),
  };
}

export async function postStorePaid(
  base: string,
  args: {
    userId: string;
    amountCents: number;
    paymentId?: string;
    sellerKey?: string;
    /** Defaults to one id per payment. */
    eventId?: string;
    /** When the payment was made; defaults to now. */
    occurredAt?: Date;
    /** Test or live money; test by default, as the relay's rows are today. */
    mode?: 'test' | 'live';
  },
): Promise<Response> {
  const callbackUrl = `${base}/webhooks/store`;
  const event = {
    id: args.eventId ?? `rel_evt_${args.paymentId ?? args.userId}`,
    type: 'marketplace.purchase.paid',
    version: 1,
    store: 'coachatron',
    product: 'coachatron',
    mode: args.mode ?? 'test',
    occurredAt: (args.occurredAt ?? new Date()).toISOString(),
    buyer: { userId: args.userId, email: 'parent@example.com' },
    item: { code: 'NOCTU-COACHATRON-CHARGE', key: 'charge', kind: 'sku', name: 'Charge', quantity: 1 },
    money: {
      amountCents: args.amountCents,
      currency: 'USD',
      refundedCents: 0,
      feeCents: Math.round((args.amountCents * 500) / 10000),
    },
    refs: {
      orderId: `ord_${args.userId}`,
      paymentId: args.paymentId ?? `ch_${args.userId}`,
      subscriptionId: null,
      refundId: null,
      disputeId: null,
    },
    subscription: null,
    seller: { ref: 'acct_test', key: args.sellerKey ?? 'seller' },
    entitlements: {},
  };
  const body = JSON.stringify(event);
  return fetch(callbackUrl, {
    method: 'POST',
    headers: storeEventHeaders(callbackUrl, body),
    body,
  });
}

export function buyerFromLocation(location: string | null): string {
  if (!location) throw new Error('missing Location');
  const url = new URL(location, 'http://relay.test');
  const user = url.searchParams.get('user');
  if (!user) throw new Error(`buy link has no user: ${location}`);
  return user;
}

/** A seller event as the relay forwards a payment account update. */
export async function postSellerEvent(
  base: string,
  args: {
    sellerKey: string;
    chargesEnabled?: boolean | null;
    type?: 'seller.updated' | 'seller.disconnected';
    product?: string;
    id?: string;
    secret?: string;
    /** The seller account's mode; test by default. */
    mode?: 'test' | 'live';
  },
): Promise<Response> {
  const callbackUrl = `${base}/webhooks/store`;
  const type = args.type ?? 'seller.updated';
  const charges = args.chargesEnabled === undefined ? true : args.chargesEnabled;
  const event = {
    id: args.id ?? `rel_evt_${type}_${args.sellerKey}_${Math.random().toString(36).slice(2)}`,
    type,
    version: 1,
    store: `${args.product ?? 'coachatron'}@${args.sellerKey}`,
    product: args.product ?? 'coachatron',
    mode: args.mode ?? 'test',
    occurredAt: new Date().toISOString(),
    buyer: null,
    item: null,
    money: null,
    refs: { orderId: null, paymentId: null, subscriptionId: null, refundId: null, disputeId: null },
    subscription: null,
    seller: {
      ref: 'acct_test',
      key: args.sellerKey,
      status: type === 'seller.disconnected' ? 'disconnected' : charges ? 'active' : 'restricted',
      chargesEnabled: charges,
      payoutsEnabled: charges,
      requirementsDue: [],
    },
    entitlements: {},
  };
  const body = JSON.stringify(event);
  return fetch(callbackUrl, {
    method: 'POST',
    headers: storeEventHeaders(callbackUrl, body, args.secret),
    body,
  });
}

export type PaymentEventType =
  | 'marketplace.purchase.refunded'
  | 'marketplace.purchase.refund_failed'
  | 'marketplace.purchase.disputed'
  | 'marketplace.purchase.dispute_won'
  | 'marketplace.purchase.dispute_lost';

/** A refund or dispute event on a seller's payment, shaped as the relay's
 * event v1 (store/event-v1.js): `money.amountCents` is what the refund or
 * dispute is for, and the payment is named by its ref. */
export async function postPaymentEvent(
  base: string,
  args: {
    type: PaymentEventType;
    paymentId: string;
    amountCents: number | null;
    refundId?: string | null;
    disputeId?: string | null;
    eventId?: string;
    sellerKey?: string;
    /** Test or live money; test by default. */
    mode?: 'test' | 'live';
  },
): Promise<Response> {
  const callbackUrl = `${base}/webhooks/store`;
  const refund = args.type === 'marketplace.purchase.refunded' || args.type === 'marketplace.purchase.refund_failed';
  const disputeState =
    args.type === 'marketplace.purchase.disputed' ? 'open' : args.type === 'marketplace.purchase.dispute_won' ? 'won' : args.type === 'marketplace.purchase.dispute_lost' ? 'lost' : null;
  const event = {
    id: args.eventId ?? `rel_evt_${args.type}_${args.refundId ?? args.disputeId ?? args.paymentId}`,
    type: args.type,
    version: 1,
    store: `coachatron@${args.sellerKey ?? 'seller'}`,
    product: 'coachatron',
    mode: args.mode ?? 'test',
    occurredAt: new Date().toISOString(),
    buyer: { userId: null, email: null },
    item: null,
    money: {
      amountCents: args.amountCents,
      currency: 'USD',
      refundedCents: refund && args.amountCents !== null ? args.amountCents : 0,
      feeCents: null,
      discountCents: null,
      taxCents: null,
    },
    discount: null,
    refs: {
      orderId: null,
      paymentId: args.paymentId,
      subscriptionId: null,
      refundId: refund ? (args.refundId ?? null) : null,
      disputeId: disputeState ? (args.disputeId ?? null) : null,
      checkoutId: null,
      paymentMethodRef: null,
    },
    subscription: null,
    refund: refund ? { status: args.type === 'marketplace.purchase.refunded' ? 'succeeded' : 'failed' } : null,
    dispute: disputeState ? { state: disputeState } : null,
    paymentMethod: null,
    seller: { ref: 'acct_test', key: args.sellerKey ?? 'seller' },
    action: null,
    entitlements: {},
  };
  const body = JSON.stringify(event);
  return fetch(callbackUrl, {
    method: 'POST',
    headers: storeEventHeaders(callbackUrl, body),
    body,
  });
}
