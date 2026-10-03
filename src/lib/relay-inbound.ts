import crypto from 'node:crypto';
import { relaySignature } from './inboundSms.js';

export const relayInboundSignature = relaySignature;

export function verifyRelaySignature(
  secret: string,
  publicUrl: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = relayInboundSignature(secret, publicUrl, rawBody);
  try {
    const a = Buffer.from(signatureHeader, 'base64');
    const b = Buffer.from(expected, 'base64');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function parseRelayFormBody(rawBody: Buffer): Record<string, string> {
  const params = new URLSearchParams(rawBody.toString('utf8'));
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

export function formField(body: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = body[key]?.trim();
    if (value) return value;
  }
  return '';
}
