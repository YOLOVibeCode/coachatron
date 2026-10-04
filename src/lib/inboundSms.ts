import { createHmac } from 'node:crypto';

/** Inbound texts arrive from the Noctusoft relay, which passes Twilio's own
 * form fields through unchanged (From, To, Body, ...) and signs the request:
 * x-relay-signature = base64 HMAC-SHA256(secret, url + raw body), where url
 * is the webhook URL in the relay manifest (relay inbound-secrets.js). */

/** The URL the relay signs with. Must equal the manifest's inbound.sms url. */
export function inboundSmsUrl(): string {
  const configured = (process.env.INBOUND_SMS_URL ?? '').trim();
  if (configured) return configured;
  const base = (process.env.APP_BASE_URL ?? 'https://coachatron.com').replace(/\/$/, '');
  return `${base}/webhooks/sms`;
}

export function relaySignature(secret: string, url: string, raw: Buffer): string {
  return createHmac('sha256', secret).update(url).update(raw).digest('base64');
}

/** The sender and text, from the relay's form fields (From, Body) or the
 * JSON shape ({ from, body }) used by tests and local tools. */
export function parseInboundSms(raw: Buffer, contentType: string | undefined): { from: string; body: string } {
  const text = raw.toString('utf8');
  let fields: Record<string, unknown> = {};
  if (/json/i.test(contentType ?? '')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') fields = parsed as Record<string, unknown>;
    } catch {
      fields = {};
    }
  } else {
    fields = Object.fromEntries(new URLSearchParams(text));
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  return { from: pick('From', 'from'), body: pick('Body', 'body') };
}
