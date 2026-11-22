import crypto from 'node:crypto';
import { appBaseUrlIsHttps } from '../config.js';
import { normalizeEmail, type Contact, contactValue, parseContact } from './auth.js';

/** Mid sign-up state between proving a contact and opening a session. */

export const SIGNIN_FLOW_COOKIE = 'cx_signin';
export const SIGNIN_FLOW_TTL_SECONDS = 15 * 60;
export const SIGNIN_RETURN_COOKIE = 'cx_return';
export const SIGNIN_RETURN_TTL_SECONDS = 30 * 60;

const COOKIE_VERSION = 'v1';
const FLOW_KEY_LABEL = 'coachatron signin-flow cookie v1';
const RETURN_KEY_LABEL = 'coachatron signin-return cookie v1';
const MIN_SECRET_LENGTH = 32;

export type SigninLinkTarget = Contact;

export type SigninPending = {
  primary: Contact;
  smsConsent: boolean;
  mode: 'profile' | 'link';
  name?: string;
  tz?: string;
  /** Extra contact typed on the profile step (email or phone string). */
  extra?: string;
  /** Mobile being proved before create (email-primary signup). */
  confirmPhone?: string;
  /** Existing coach to attach the proved primary contact to (link mode). */
  coachId?: number;
  /** Contact the holder must prove in link mode. */
  linkTarget?: SigninLinkTarget;
};

let processFlowKey: Buffer | null = null;
let processReturnKey: Buffer | null = null;
let warned = false;

function flowKey(): Buffer {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length >= MIN_SECRET_LENGTH) return crypto.createHmac('sha256', secret).update(FLOW_KEY_LABEL).digest();
  if (!warned && appBaseUrlIsHttps()) {
    warned = true;
    console.warn(
      `SESSION_SECRET is not set or is under ${MIN_SECRET_LENGTH} characters: sign-in flow cookies are signed with a key that lasts until this process restarts.`,
    );
  }
  processFlowKey ??= crypto.randomBytes(32);
  return processFlowKey;
}

function returnKey(): Buffer {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length >= MIN_SECRET_LENGTH) return crypto.createHmac('sha256', secret).update(RETURN_KEY_LABEL).digest();
  processReturnKey ??= crypto.randomBytes(32);
  return processReturnKey;
}

function mac(key: Buffer, signed: string): string {
  return crypto.createHmac('sha256', key).update(signed).digest('base64url');
}

function encodeContact(contact: Contact): { k: 'email' | 'phone'; c: string } {
  return { k: contact.kind, c: contactValue(contact) };
}

function decodeContact(k: unknown, c: unknown): Contact | null {
  if (typeof c !== 'string') return null;
  if (k === 'email') return normalizeEmail(c) === c ? { kind: 'email', email: c } : null;
  if (k === 'phone') return /^\+[1-9]\d{7,14}$/.test(c) ? { kind: 'phone', phone: c } : null;
  return null;
}

export function signSigninPending(pending: SigninPending, now: Date = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({
      p: encodeContact(pending.primary),
      s: pending.smsConsent,
      m: pending.mode,
      n: pending.name ?? '',
      z: pending.tz ?? '',
      e: pending.extra ?? '',
      cp: pending.confirmPhone ?? '',
      c: pending.coachId ?? 0,
      l:
        pending.linkTarget === undefined
          ? null
          : encodeContact(pending.linkTarget),
      x: Math.floor(now.getTime() / 1000) + SIGNIN_FLOW_TTL_SECONDS,
    }),
    'utf8',
  ).toString('base64url');
  const signed = `${COOKIE_VERSION}.${payload}`;
  return `${signed}.${mac(flowKey(), signed)}`;
}

export function readSigninPending(value: string | undefined, now: Date = new Date()): SigninPending | null {
  if (!value || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;
  const given = Buffer.from(parts[2], 'utf8');
  const expected = Buffer.from(mac(flowKey(), `${parts[0]}.${parts[1]}`), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload: {
    p?: { k?: unknown; c?: unknown };
    s?: unknown;
    m?: unknown;
    n?: unknown;
    z?: unknown;
    e?: unknown;
    cp?: unknown;
    c?: unknown;
    l?: { k?: unknown; c?: unknown } | null;
    x?: unknown;
  };
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const { x } = payload;
  if (typeof x !== 'number' || !Number.isInteger(x)) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (x <= nowSeconds || x > nowSeconds + SIGNIN_FLOW_TTL_SECONDS + 60) return null;
  const primary = payload.p ? decodeContact(payload.p.k, payload.p.c) : null;
  if (!primary) return null;
  const mode = payload.m === 'link' ? 'link' : 'profile';
  const smsConsent = payload.s === true;
  const name = typeof payload.n === 'string' && payload.n.trim() ? payload.n.trim() : undefined;
  const tz = typeof payload.z === 'string' && payload.z.trim() ? payload.z.trim() : undefined;
  const extra = typeof payload.e === 'string' && payload.e.trim() ? payload.e.trim() : undefined;
  const confirmPhone =
    typeof payload.cp === 'string' && /^\+[1-9]\d{7,14}$/.test(payload.cp) ? payload.cp : undefined;
  const coachId = typeof payload.c === 'number' && Number.isInteger(payload.c) && payload.c > 0 ? payload.c : undefined;
  let linkTarget: Contact | undefined;
  if (payload.l && typeof payload.l === 'object') {
    const lt = decodeContact(payload.l.k, payload.l.c);
    if (lt) linkTarget = lt;
  }
  if (mode === 'link' && (!coachId || !linkTarget)) return null;
  return { primary, smsConsent, mode, name, tz, extra, confirmPhone, coachId, linkTarget };
}

const RETURN_PATH = /^\/app\/[a-z0-9/-]+$/i;

export function safeReturnPath(raw: string): string | null {
  const path = raw.split('?')[0]?.split('#')[0] ?? '';
  if (!RETURN_PATH.test(path) || path.includes('..')) return null;
  return path;
}

export function signReturnPath(path: string, now: Date = new Date()): string | null {
  const safe = safeReturnPath(path);
  if (!safe) return null;
  const payload = Buffer.from(
    JSON.stringify({ p: safe, x: Math.floor(now.getTime() / 1000) + SIGNIN_RETURN_TTL_SECONDS }),
    'utf8',
  ).toString('base64url');
  const signed = `${COOKIE_VERSION}.${payload}`;
  return `${signed}.${mac(returnKey(), signed)}`;
}

export function readReturnPath(value: string | undefined, now: Date = new Date()): string | null {
  if (!value || value.length > 512) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;
  const given = Buffer.from(parts[2], 'utf8');
  const expected = Buffer.from(mac(returnKey(), `${parts[0]}.${parts[1]}`), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload: { p?: unknown; x?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (typeof payload.p !== 'string' || typeof payload.x !== 'number') return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.x <= nowSeconds || payload.x > nowSeconds + SIGNIN_RETURN_TTL_SECONDS + 60) return null;
  return safeReturnPath(payload.p);
}

export function parseExtraContact(raw: string): Contact | null {
  return parseContact(raw);
}