import assert from 'node:assert/strict';
import type { FakeRelay } from '../fakes/relay.js';

/** The parent's side of the My sessions page (/my), over HTTP. */

const json = { 'content-type': 'application/json' };

/** Requests as if from this client address (the one proxy hop in front). */
export const from = (address: string) => ({ 'x-forwarded-for': address });

/** The page as a reader sees it: no tags, single spaces. */
export function visible(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Asks to see the sessions booked with this email or mobile. */
export function ask(base: string, contact: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/my`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ contact }), redirect: 'manual' });
}

export function enterCode(base: string, contact: string, code: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/my/code`, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify({ contact, code }),
    redirect: 'manual',
  });
}

export function useLink(base: string, token: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/my/link`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ t: token }), redirect: 'manual' });
}

export function openLink(base: string, token: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/my/link?t=${encodeURIComponent(token)}`, { headers, redirect: 'manual' });
}

/** The page itself, with whatever cookie header is given. */
export function sessionsPage(base: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/my/sessions`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}

/** The newest code texted to this number. */
export function textedCode(relay: FakeRelay, to: string): string {
  const text = [...relay.sms].reverse().find((m) => m.to === to);
  const code = text ? /is (\d{6})\./.exec(text.body)?.[1] : undefined;
  assert.ok(code, `a code was texted to ${to}`);
  return code;
}

/** The token of the newest link emailed to this address. */
export function emailedToken(relay: FakeRelay, to: string): string {
  const email = [...relay.emails].reverse().find((m) => m.to === to);
  const token = email ? /\/my\/link\?t=([A-Za-z0-9_-]+)/.exec(email.text)?.[1] : undefined;
  assert.ok(token, `a link was emailed to ${to}`);
  return token;
}

/** The My sessions cookie a response set, as a Cookie header ("cx_my=..."),
 * or null when it set none or cleared it. */
export function myCookie(res: Response): string | null {
  const set = res.headers.getSetCookie().find((c) => c.startsWith('cx_my='));
  const pair = set?.split(';')[0];
  return pair && pair !== 'cx_my=' ? pair : null;
}

/** Proves a mobile with a texted code and returns the cookie. */
export async function proveMobile(base: string, relay: FakeRelay, phone: string, headers: Record<string, string> = {}): Promise<string> {
  assert.equal((await ask(base, phone, headers)).status, 200);
  const res = await enterCode(base, phone, textedCode(relay, phone), headers);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/my/sessions');
  const cookie = myCookie(res);
  assert.ok(cookie, 'the proof set the cookie');
  return cookie;
}

/** Proves an email with its emailed link and returns the cookie. */
export async function proveEmail(base: string, relay: FakeRelay, email: string, headers: Record<string, string> = {}): Promise<string> {
  assert.equal((await ask(base, email, headers)).status, 200);
  const res = await useLink(base, emailedToken(relay, email.toLowerCase()), headers);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/my/sessions');
  const cookie = myCookie(res);
  assert.ok(cookie, 'the proof set the cookie');
  return cookie;
}
