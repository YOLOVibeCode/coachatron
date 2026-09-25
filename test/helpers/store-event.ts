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
  },
): Promise<Response> {
  const callbackUrl = `${base}/webhooks/store`;
  const event = {
    id: `rel_evt_${args.paymentId ?? args.userId}`,
    type: 'marketplace.purchase.paid',
    version: 1,
    store: 'coachatron',
    product: 'coachatron',
    mode: 'test',
    occurredAt: new Date().toISOString(),
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
