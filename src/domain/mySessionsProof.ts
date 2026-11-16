import crypto from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { APP_BASE_URL, appBaseUrlIsHttps, OTP_DAILY_MAX_PER_CONTACT } from '../config.js';
import { escapeHtml } from '../lib/html.js';
import { createOtp, newOtpCode, normalizeEmail, type Contact } from './auth.js';
import { sendEmailMessage, sendText, type SendOutcome } from './outbound.js';

/** How a parent proves the email or mobile they booked with, to open the
 * My sessions page (/my). There is no parent account and no password: an
 * email gets a link that works once, a mobile gets a texted code, and the
 * proof is then kept for half an hour in a signed cookie that holds that
 * one contact and opens nothing else. */

// ---- The link an email gets ----

/** How long an emailed link can be used. */
export const MY_SESSIONS_LINK_MINUTES = 20;

/** 128 random bits, URL-safe. */
const LINK_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? APP_BASE_URL).replace(/\/$/, '');
}

/** The address an emailed link opens. The token rides in the query, which
 * no error line logs (src/routes/errors.ts logs the path only). */
export function mySessionsLinkUrl(token: string): string {
  return `${appBaseUrl()}/my/link?t=${token}`;
}

/** How long a link's row is kept after it runs out. */
const LINK_ROW_KEPT_MS = 24 * 60 * 60 * 1000;

/** Stores a new link for this email and ends every earlier one for it, so
 * one link per address is live at a time. Only the token's hash is kept,
 * and rows that ran out more than a day ago are dropped here, so the table
 * holds no address for longer than that. */
export async function createMySessionsLink(db: DbClient, email: string, token: string, now: Date = new Date()): Promise<void> {
  await db.query('delete from my_sessions_link where expires_at < $1', [new Date(now.getTime() - LINK_ROW_KEPT_MS).toISOString()]);
  await db.query('update my_sessions_link set expires_at = $2 where email = $1 and used_at is null and expires_at > $2', [
    email,
    now.toISOString(),
  ]);
  await db.query('insert into my_sessions_link (token_hash, email, expires_at) values ($1, $2, $3)', [
    tokenHash(token),
    email,
    new Date(now.getTime() + MY_SESSIONS_LINK_MINUTES * 60 * 1000).toISOString(),
  ]);
}

export function newMySessionsLinkToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Whether this link can still be used. Looking does not use it, so a mail
 * program that opens links ahead of the reader leaves it working. */
export async function mySessionsLinkIsOpen(db: DbClient, token: string, now: Date = new Date()): Promise<boolean> {
  if (!LINK_TOKEN.test(token)) return false;
  const result = await db.query<{ id: number }>(
    'select id from my_sessions_link where token_hash = $1 and used_at is null and expires_at > $2',
    [tokenHash(token), now.toISOString()],
  );
  return result.rows.length > 0;
}

/** Uses the link once and returns the email it proves; null when it is
 * unknown, used, or expired. One statement, so the same link sent twice at
 * once opens the page only once. */
export async function consumeMySessionsLink(db: DbClient, token: string, now: Date = new Date()): Promise<string | null> {
  if (!LINK_TOKEN.test(token)) return null;
  const result = await db.query<{ email: string }>(
    `update my_sessions_link set used_at = $2
     where token_hash = $1 and used_at is null and expires_at > $2
     returning email`,
    [tokenHash(token), now.toISOString()],
  );
  return result.rows[0]?.email ?? null;
}

// ---- What is sent ----

/** The one text this page adds: a code the person asked for. */
export function mySessionsCodeText(code: string): string {
  return `Coachatron: your code to see your sessions is ${code}. It expires in 10 minutes.`;
}

export function mySessionsLinkEmail(link: string): { subject: string; text: string; html: string } {
  const lasts = `It works once and expires in ${MY_SESSIONS_LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`;
  const p = (inner: string) => `<p style="font-family:system-ui,sans-serif;font-size:16px">${inner}</p>`;
  return {
    subject: 'Your link to see your Coachatron sessions',
    text: `Open this link to see your sessions and session credits:\n${link}\n\n${lasts}\n\nCoachatron`,
    html: `${p('Open this link to see your sessions and session credits:')}
${p(`<a href="${escapeHtml(link)}">See my sessions</a>`)}
${p(escapeHtml(lasts))}`,
  };
}

export type ProofOutcome = SendOutcome | 'failed';

/** Sends the proof this contact takes: a link to an email, a code to a
 * mobile. Both count as one-time codes (template 'otp'), so the daily
 * ceiling on codes to one number or address covers them together with
 * sign-in and checkout codes, and the text counts against the app-wide
 * ceiling on texts set off by people who are not signed in. The code or
 * link is stored only once it has gone out, so a request the limits refuse
 * leaves nothing behind and ends no earlier code or link. */
export async function sendMySessionsProof(db: DbClient, contact: Contact): Promise<ProofOutcome> {
  try {
    if (contact.kind === 'email') {
      const token = newMySessionsLinkToken();
      const outcome = await sendEmailMessage(db, {
        to: contact.email,
        ...mySessionsLinkEmail(mySessionsLinkUrl(token)),
        coachId: null,
        template: 'otp',
        perRecipientDailyMax: OTP_DAILY_MAX_PER_CONTACT,
      });
      if (outcome === 'sent') await createMySessionsLink(db, contact.email, token);
      return outcome;
    }
    const code = newOtpCode();
    const outcome = await sendText(db, {
      to: contact.phone,
      body: mySessionsCodeText(code),
      coachId: null,
      template: 'otp',
      perRecipientDailyMax: OTP_DAILY_MAX_PER_CONTACT,
      visitor: 'always',
    });
    if (outcome === 'sent') await createOtp(db, contact, { code, purpose: 'sessions' });
    return outcome;
  } catch (err) {
    console.error(`my-sessions: ${contact.kind === 'email' ? 'link' : 'code'} not sent:`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

// ---- The cookie that holds the proven contact ----

export const MY_SESSIONS_COOKIE = 'cx_my';
/** The browser sends the cookie to this page's addresses only. */
export const MY_SESSIONS_COOKIE_PATH = '/my';
export const MY_SESSIONS_TTL_SECONDS = 30 * 60;

const COOKIE_VERSION = 'v1';
const KEY_LABEL = 'coachatron my-sessions cookie v1';
/** SESSION_SECRET is used only when it is at least this long. */
const MIN_SECRET_LENGTH = 32;

let processKey: Buffer | null = null;
let warned = false;

/** The key the cookie is signed with: derived from SESSION_SECRET, for this
 * use only. With no SESSION_SECRET, or one too short to resist guessing,
 * the key is random and lasts until the process restarts: parents then
 * prove their contact again after a deploy, and no known or weak key ever
 * signs a cookie. That fallback fits one replica (src/server.ts); more
 * replicas need SESSION_SECRET set. */
function signingKey(): Buffer {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length >= MIN_SECRET_LENGTH) return crypto.createHmac('sha256', secret).update(KEY_LABEL).digest();
  if (!warned && appBaseUrlIsHttps()) {
    warned = true;
    console.warn(
      `SESSION_SECRET is not set or is under ${MIN_SECRET_LENGTH} characters: My sessions cookies are signed with a key that lasts until this process restarts.`,
    );
  }
  processKey ??= crypto.randomBytes(32);
  return processKey;
}

function mac(signed: string): string {
  return crypto.createHmac('sha256', signingKey()).update(signed).digest('base64url');
}

/** The cookie value for a contact just proved: the contact and when the
 * proof runs out, signed. */
export function signMySessions(contact: Contact, now: Date = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({
      k: contact.kind,
      c: contact.kind === 'email' ? contact.email : contact.phone,
      x: Math.floor(now.getTime() / 1000) + MY_SESSIONS_TTL_SECONDS,
    }),
    'utf8',
  ).toString('base64url');
  const signed = `${COOKIE_VERSION}.${payload}`;
  return `${signed}.${mac(signed)}`;
}

/** The contact a cookie value proves, or null: a value that was not signed
 * here, was changed, has run out, or names something that is not an email
 * or a mobile number. */
export function readMySessions(value: string | undefined, now: Date = new Date()): Contact | null {
  if (!value || value.length > 1024) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;
  // Compared as written, so only the exact signature passes.
  const given = Buffer.from(parts[2], 'utf8');
  const expected = Buffer.from(mac(`${parts[0]}.${parts[1]}`), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload: { k?: unknown; c?: unknown; x?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const { k, c, x } = payload;
  if (typeof c !== 'string' || typeof x !== 'number' || !Number.isInteger(x)) return null;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Run out, or dated further ahead than any cookie signed here could be.
  if (x <= nowSeconds || x > nowSeconds + MY_SESSIONS_TTL_SECONDS + 60) return null;
  if (k === 'email') return normalizeEmail(c) === c ? { kind: 'email', email: c } : null;
  if (k === 'phone') return /^\+[1-9]\d{7,14}$/.test(c) ? { kind: 'phone', phone: c } : null;
  return null;
}
