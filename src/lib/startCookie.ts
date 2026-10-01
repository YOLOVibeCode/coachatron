/** The typed week from the landing page, carried through sign-in as an
 * HttpOnly cookie so the model never runs for an anonymous visitor. */

import { parseCookies } from './cookies.js';

export const START_COOKIE = 'cx_start';
export const START_COOKIE_MAX_AGE = 60 * 60;
export const START_TEXT_MAX_BYTES = 2400;

export function clipStartText(text: string): string {
  const trimmed = text.trim();
  const buf = Buffer.from(trimmed, 'utf8');
  if (buf.length <= START_TEXT_MAX_BYTES) return trimmed;
  let end = START_TEXT_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

export function encodeStartCookie(text: string): string {
  return Buffer.from(clipStartText(text), 'utf8').toString('base64url');
}

export function decodeStartCookie(value: string | undefined): string {
  if (!value) return '';
  try {
    return clipStartText(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return '';
  }
}

export function readStartText(cookieHeader: string | undefined): string {
  return decodeStartCookie(parseCookies(cookieHeader)[START_COOKIE]);
}
