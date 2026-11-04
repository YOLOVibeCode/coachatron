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

/** Posts an inbound text the way the relay forwards one. By default the
 * relay also says Twilio's signature checked out (x-relay-twilio-verified:
 * 1); pass twilioVerified '0' for a text it could not verify, or null to
 * leave the header out. */
export async function postSignedSms(
  base: string,
  fields: Record<string, string>,
  opts: { secret?: string; publicUrl?: string; signature?: string | null; twilioVerified?: string | null } = {},
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
  const verified = opts.twilioVerified === undefined ? '1' : opts.twilioVerified;
  if (verified !== null) headers['x-relay-twilio-verified'] = verified;
  return fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body });
}

/** Posts a delivery status callback the way the relay forwards one, with
 * x-relay-twilio-verified as for postSignedSms. */
export async function postSignedSmsStatus(
  base: string,
  fields: Record<string, string>,
  opts: { secret?: string; publicUrl?: string; signature?: string | null; twilioVerified?: string | null } = {},
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
  const verified = opts.twilioVerified === undefined ? '1' : opts.twilioVerified;
  if (verified !== null) headers['x-relay-twilio-verified'] = verified;
  return fetch(`${base}/webhooks/sms-status`, { method: 'POST', headers, body });
}
