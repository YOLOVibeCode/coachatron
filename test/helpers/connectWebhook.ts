import crypto from 'node:crypto';
import { connectWebhookCallbackUrl } from '../../src/domain/connectWebhook.js';

export const TEST_CONNECT_WEBHOOK_SECRET = 'test-connect-webhook-secret';

export function signConnectWebhookBody(rawBody: string): string {
  const payload = connectWebhookCallbackUrl() + rawBody;
  return crypto.createHmac('sha256', TEST_CONNECT_WEBHOOK_SECRET).update(payload).digest('base64');
}

export async function postConnectWebhook(base: string, event: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(event);
  return fetch(`${base}/webhooks/connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-connect-signature': signConnectWebhookBody(rawBody),
      'x-connect-product': 'coachatron',
      'x-connect-recipient-key': String(
        (event.data as { object?: { metadata?: { recipientKey?: string } } })?.object?.metadata?.recipientKey ?? '',
      ),
    },
    body: rawBody,
  });
}

export function checkoutCompletedEvent(sessionId: string, recipientKey: string, amountCents: number): Record<string, unknown> {
  return {
    id: `evt_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        amount_total: amountCents,
        payment_intent: `pi_${sessionId}`,
        metadata: { recipientKey },
      },
    },
  };
}
