import { relayInboundSignature } from '../../src/lib/relay-inbound.js';

export const TEST_INBOUND_SECRET = 'test-inbound-secret';

export function configureSmsWebhooks(base: string): void {
  process.env.RELAY_INBOUND_SECRET = TEST_INBOUND_SECRET;
  process.env.INBOUND_SMS_URL = `${base}/webhooks/sms`;
  process.env.SMS_STATUS_WEBHOOK_PUBLIC_URL = `${base}/webhooks/sms-status`;
}

export function clearSmsWebhookEnv(): void {
  delete process.env.RELAY_INBOUND_SECRET;
  delete process.env.INBOUND_SMS_URL;
  delete process.env.SMS_STATUS_WEBHOOK_PUBLIC_URL;
}

function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export async function postSignedSms(
  base: string,
  fields: Record<string, string>,
  opts: { secret?: string; publicUrl?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = encodeForm(fields);
  const publicUrl = opts.publicUrl ?? `${base}/webhooks/sms`;
  const secret = opts.secret ?? TEST_INBOUND_SECRET;
  let signature = opts.signature;
  if (signature === undefined) {
    signature = secret ? relayInboundSignature(secret, publicUrl, Buffer.from(body)) : undefined;
  }
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature) headers['x-relay-signature'] = signature;
  return fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body });
}

export async function postSignedSmsStatus(
  base: string,
  fields: Record<string, string>,
  opts: { secret?: string; publicUrl?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = encodeForm(fields);
  const publicUrl = opts.publicUrl ?? `${base}/webhooks/sms-status`;
  const secret = opts.secret ?? TEST_INBOUND_SECRET;
  let signature = opts.signature;
  if (signature === undefined) {
    signature = secret ? relayInboundSignature(secret, publicUrl, Buffer.from(body)) : undefined;
  }
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature) headers['x-relay-signature'] = signature;
  return fetch(`${base}/webhooks/sms-status`, { method: 'POST', headers, body });
}
