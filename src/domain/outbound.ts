import type { DbClient } from '../db/client.js';
import { sendSms, type SendSmsResult } from '../relay/sms.js';
import { sendEmail } from '../relay/email.js';
import { RelayHttpError } from '../relay/http.js';
import { zonedParts, zonedTimeToUtc } from './scheduling.js';
import {
  SMS_BRAND,
  SMS_COACH_DAILY_CAP,
  SMS_COACH_MONTHLY_CAP,
  SMS_PRODUCT_DAILY_FLOOR,
  SMS_PRODUCT_DAILY_PER_COACH,
  visitorTextLimits,
} from '../config.js';
import { hasActiveConsent } from './sms-consent.js';
import { isOptedOut } from './cascade.js';
import { revokeConsent } from './sms-consent.js';
import { isUsOrCanada } from '../lib/phone.js';

/** The only way Coachatron sends a text. SPEC.md §10: "The stop is there
 * for a loop." Every send is one segment, domestic, logged, and counted
 * against the coach's day and month and the product's day before it goes. */

const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('^{}\\[~]|€');
const GSM_SEGMENT = 160;
const UCS2_SEGMENT = 70;

// Typographic characters that would force the whole text into UCS-2 (70
// characters a segment) for no reason.
const TRANSLITERATE: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/…/g, '...'],
  [/[–—−]/g, '-'],
  [/[·•]/g, '-'],
  [/[   ]/g, ' '],
];

/** Letters with no accent-free form in Unicode that still have a plain
 * spelling. */
const PLAIN_LETTERS: Record<string, string> = { œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ı: 'i' };

/** "García" → "Garcia": a letter outside GSM-7 whose accent-free form is
 * inside it is written that way, so one name does not turn the whole text
 * into UCS-2 (70 characters a segment instead of 160). GSM-7 letters such
 * as é, ñ and ü stay as they are. */
export function toGsmLetters(text: string): string {
  let out = '';
  for (const ch of text) {
    if (GSM_BASIC.has(ch) || GSM_EXTENDED.has(ch)) {
      out += ch;
      continue;
    }
    const plain = PLAIN_LETTERS[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, '');
    out += plain && [...plain].every((c) => GSM_BASIC.has(c)) ? plain : ch;
  }
  return out;
}

/** Typographic characters and accented letters written in GSM-7 where
 * they can be. */
function plainText(text: string): string {
  let out = text;
  for (const [re, to] of TRANSLITERATE) out = out.replace(re, to);
  return toGsmLetters(out);
}

function gsmLength(text: string): number | null {
  let n = 0;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) n += 1;
    else if (GSM_EXTENDED.has(ch)) n += 2;
    else return null;
  }
  return n;
}

/** Fits a text into one SMS segment: GSM-7 up to 160, otherwise UCS-2 up
 * to 70. PLATFORM.md §4.5: "a second segment is never sent." `reserve`
 * leaves that many characters free for a GSM-7 line added after. */
export function toOneSegment(body: string, reserve = 0): string {
  const text = plainText(body.trim());
  const gsm = gsmLength(text);
  if (gsm !== null) {
    const max = GSM_SEGMENT - reserve;
    if (gsm <= max) return text;
    let out = '';
    let used = 0;
    for (const ch of text) {
      const w = GSM_EXTENDED.has(ch) ? 2 : 1;
      if (used + w > max - 3) break;
      out += ch;
      used += w;
    }
    return `${out.trimEnd()}...`;
  }
  // UCS-2 counts UTF-16 code units; never split a surrogate pair.
  const max = UCS2_SEGMENT - reserve;
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 3) break;
    out += ch;
  }
  return `${out.trimEnd()}...`;
}

export function segmentCount(body: string): number {
  const gsm = gsmLength(body);
  return gsm !== null ? Math.max(1, Math.ceil(gsm / GSM_SEGMENT)) : Math.max(1, Math.ceil(body.length / UCS2_SEGMENT));
}

/** US and Canada only: that is what Twilio prices near $0.0083 a
 * segment. Anything else, the other +1 countries included, can cost many
 * times that, so it is refused (PLATFORM.md §4.5: "above $0.02/segment is
 * refused"). */
export function isDomesticDestination(phone: string): boolean {
  return isUsOrCanada(phone);
}

/** RELAY_APP_ENV=dev: the relay captures every text in the dev mail catcher
 * (smtp4dev at mail.dev.noctusoft.com) instead of sending it, and skips its
 * own caps there. Nothing reaches a phone, so any number can be tried. */
export function textsAreCaptured(): boolean {
  return ['dev', 'development', 'local'].includes((process.env.RELAY_APP_ENV ?? '').trim().toLowerCase());
}

/** Whether a text to this number can go out: +1 numbers, or any number
 * while texts are captured in dev. */
export function canText(phone: string): boolean {
  return isDomesticDestination(phone) || (textsAreCaptured() && /^\+\d{8,15}$/.test(phone));
}

/** busy: try again later. The relay's own limits (HTTP 429) refused it, or
 * it is a visitor's text and the app-wide visitor ceiling is reached. */
export type SendOutcome = 'sent' | 'capped' | 'refused' | 'busy';

export interface OutboundText {
  to: string;
  body: string;
  /** The coach this text is sent for; null for sign-in codes and replies to unknown numbers. */
  coachId: number | null;
  /** A short name for the kind of text, e.g. "reminder", "offer", "otp". */
  template: string;
  /** Optional ceiling on this template to this number in 24 hours. */
  perRecipientDailyMax?: number;
  /** Set off by someone who is not signed in, so it counts against the
   * app-wide visitor ceiling (visitorTextLimits): 'always' (a sign-in code,
   * a start link, an opt-in confirmation), or 'new-number' only when no
   * text has been sent to this number before (a booking or waitlist text). */
  visitor?: 'always' | 'new-number';
}

/** Texts that answer the person this moment and need no standing consent:
 * a sign-in code they asked for, and replies to a text they sent us. An
 * opt-out still stops them. Everything else needs the consent box. */
const ONE_TIME_TEMPLATES = new Set(['otp', 'auto-reply', 'assistant']);

/** Conversation replies to a coach skip the opt-out line; every other text
 * carries it. */
const NO_OPT_OUT_LINE_TEMPLATES = new Set(['assistant']);

export const OPT_OUT_LINE = 'Reply STOP to opt out.';

function withBrand(body: string): string {
  const prefix = `${SMS_BRAND}:`;
  if (body.startsWith(prefix)) return body;
  return `${prefix} ${body}`;
}

/** The final one-segment text: brand first, opt-out line last unless the
 * text already says STOP. The body is shortened, never the opt-out line. */
export function composeText(body: string, template: string): string {
  const branded = withBrand(body.trim());
  if (NO_OPT_OUT_LINE_TEMPLATES.has(template) || /\bSTOP\b/.test(branded)) return toOneSegment(branded);
  return `${toOneSegment(branded, OPT_OUT_LINE.length + 1)} ${OPT_OUT_LINE}`;
}

/** True when this body goes out whole as one segment, with nothing cut to
 * make room for the brand or the opt-out line. Texts that carry a link use
 * it to pick a shorter wording instead of losing the end of the link, and
 * the assistant's questions to keep their "Reply Y." */
export function fitsOneSegment(body: string, template: string): boolean {
  const branded = withBrand(body.trim());
  const reserve = NO_OPT_OUT_LINE_TEMPLATES.has(template) || /\bSTOP\b/.test(branded) ? 0 : OPT_OUT_LINE.length + 1;
  const text = plainText(branded);
  const length = gsmLength(text);
  if (length !== null) return length + reserve <= GSM_SEGMENT;
  return text.length + reserve <= UCS2_SEGMENT;
}

type Channel = 'sms' | 'email';

/** A text is logged 'sent'; Twilio's delivery reports (matched on the sid)
 * then move it to queued, delivered, undelivered and so on. Every one of
 * those left for the carrier, so every one still counts against a ceiling. */
const SENT_STATUSES = "('sent', 'accepted', 'queued', 'sending', 'delivered', 'undelivered', 'read')";

/** Counts sent rows on one channel; SMS ceilings never count emails. */
async function countSent(db: DbClient, where: string, params: unknown[], channel: Channel = 'sms'): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from message_log where status in ${SENT_STATUSES} and channel = '${channel}' and ${where}`,
    params,
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Whether a text has ever gone out to this number. */
async function textedBefore(db: DbClient, phone: string): Promise<boolean> {
  return (await countSent(db, 'to_phone = $1', [phone])) > 0;
}

/** Whether this text counts against the visitor ceiling. */
async function countsAsVisitor(db: DbClient, msg: OutboundText): Promise<boolean> {
  if (msg.visitor === 'always') return true;
  return msg.visitor === 'new-number' && !(await textedBefore(db, msg.to));
}

/** Which visitor ceiling, if any, this visitor's text would cross: the
 * hour's or the day's, or the reserve kept from the product's day for
 * everyone else's texts. */
async function visitorCeilingHit(db: DbClient, now: Date): Promise<string | null> {
  const limits = visitorTextLimits();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if ((await countSent(db, 'visitor and sent_at > $1', [hourAgo])) >= limits.hourly) return 'visitor-hourly';
  const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  if ((await countSent(db, 'visitor and sent_at >= $1', [utcDay])) >= limits.daily) return 'visitor-daily';
  if ((await countSent(db, 'sent_at >= $1', [utcDay])) + limits.reserve >= (await productDailyCeiling(db, now))) return 'visitor-reserve';
  return null;
}

async function productDailyCeiling(db: DbClient, now: Date): Promise<number> {
  const active = await db.query<{ n: string }>(
    `select count(distinct st.coach_id)::text as n
     from session s join session_type st on st.id = s.session_type_id
     where s.status = 'scheduled' and s.starts_at_utc > $1`,
    [now.toISOString()],
  );
  return Math.max(SMS_PRODUCT_DAILY_FLOOR, SMS_PRODUCT_DAILY_PER_COACH * Number(active.rows[0]?.n ?? '0'));
}

/** Which ceiling, if any, this text would cross. */
async function ceilingHit(db: DbClient, msg: OutboundText, now: Date): Promise<string | null> {
  if (msg.perRecipientDailyMax !== undefined) {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const n = await countSent(db, 'to_phone = $1 and template = $2 and sent_at > $3', [msg.to, msg.template, since]);
    if (n >= msg.perRecipientDailyMax) return 'recipient-daily';
  }
  if (msg.coachId !== null) {
    const coach = await db.query<{ tz: string }>('select tz from coach where id = $1', [msg.coachId]);
    const tz = coach.rows[0]?.tz ?? 'America/Chicago';
    const local = zonedParts(now, tz);
    const dayStart = zonedTimeToUtc(local.year, local.month, local.day, 0, 0, tz).toISOString();
    const monthStart = zonedTimeToUtc(local.year, local.month, 1, 0, 0, tz).toISOString();
    if ((await countSent(db, 'coach_id = $1 and sent_at >= $2', [msg.coachId, dayStart])) >= SMS_COACH_DAILY_CAP) {
      return 'coach-daily';
    }
    if ((await countSent(db, 'coach_id = $1 and sent_at >= $2', [msg.coachId, monthStart])) >= SMS_COACH_MONTHLY_CAP) {
      return 'coach-monthly';
    }
  }
  const utcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  if ((await countSent(db, 'sent_at >= $1', [utcDay])) >= (await productDailyCeiling(db, now))) return 'product-daily';
  return null;
}

async function log(
  db: DbClient,
  msg: Pick<OutboundText, 'to' | 'template' | 'coachId'>,
  body: string,
  status: string,
  providerId: string | null,
  now: Date,
  channel: Channel = 'sms',
  visitor = false,
) {
  await db.query(
    `insert into message_log (to_phone, template, body, provider_id, sent_at, status, coach_id, channel, visitor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [msg.to, msg.template, body, providerId, now.toISOString(), status, msg.coachId, channel, visitor],
  );
}

export async function sendText(db: DbClient, msg: OutboundText, now: Date = new Date()): Promise<SendOutcome> {
  const body = composeText(msg.body, msg.template);
  if (!canText(msg.to)) {
    await log(db, msg, body, 'refused-destination', null, now);
    return 'refused';
  }
  if (await isOptedOut(db, msg.to)) {
    await log(db, msg, body, 'refused-opt-out', null, now);
    return 'refused';
  }
  if (!ONE_TIME_TEMPLATES.has(msg.template) && !(await hasActiveConsent(db, msg.to))) {
    await log(db, msg, body, 'refused-no-consent', null, now);
    return 'refused';
  }
  const hit = await ceilingHit(db, msg, now);
  if (hit) {
    await log(db, msg, body, `capped-${hit}`, null, now);
    console.warn(`sms: ${hit} ceiling reached, not sending ${msg.template} (coach ${msg.coachId ?? '-'})`);
    return 'capped';
  }
  // A visitor's text past the app-wide visitor ceiling waits: 'busy', so
  // the form says to try again later (or use email where there is one).
  const visitor = await countsAsVisitor(db, msg);
  const visitorHit = visitor ? await visitorCeilingHit(db, now) : null;
  if (visitorHit) {
    await log(db, msg, body, `capped-${visitorHit}`, null, now, 'sms', true);
    console.warn(`sms: ${visitorHit} ceiling reached, not sending ${msg.template} (coach ${msg.coachId ?? '-'})`);
    return 'busy';
  }
  let sent: SendSmsResult;
  try {
    sent = await sendSms({ to: msg.to, body });
  } catch (err) {
    // The relay was not reached. Logged like any failed send, so a limit
    // on failures (reminders) counts it.
    await log(db, msg, body, 'failed', null, now, 'sms', visitor);
    throw err;
  }
  if (sent.ok) {
    await log(db, msg, body, 'sent', sent.id, now, 'sms', visitor);
    return 'sent';
  }
  if (sent.status === 429) {
    await log(db, msg, body, 'capped-relay', null, now);
    console.warn(`sms: the relay's limits refused ${msg.template} (coach ${msg.coachId ?? '-'}); try later`);
    return 'busy';
  }
  if (sent.code === 21610) {
    await revokeConsent(db, msg.to);
    await log(db, msg, body, 'failed-opt-out', null, now);
    console.warn(`sms: recipient opted out (21610), not sending ${msg.template} to ${msg.to}`);
    return 'refused';
  }
  await log(db, msg, body, 'failed', null, now);
  throw new RelayHttpError(`relay sms send failed: ${sent.code} ${sent.message}`, sent.status);
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  coachId: number | null;
  template: string;
  /** Optional ceiling on this template to this address in 24 hours. */
  perRecipientDailyMax?: number;
}

/** The only way Coachatron sends an email: logged beside texts in
 * message_log (channel 'email') and capped per address when asked. */
export async function sendEmailMessage(db: DbClient, msg: OutboundEmail, now: Date = new Date()): Promise<SendOutcome> {
  if (msg.perRecipientDailyMax !== undefined) {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const n = await countSent(db, 'to_phone = $1 and template = $2 and sent_at > $3', [msg.to, msg.template, since], 'email');
    if (n >= msg.perRecipientDailyMax) {
      await log(db, msg, msg.subject, 'capped-recipient-daily', null, now, 'email');
      return 'capped';
    }
  }
  try {
    const sent = await sendEmail({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    await log(db, msg, msg.subject, 'sent', sent.id || null, now, 'email');
    return 'sent';
  } catch (err) {
    if (err instanceof RelayHttpError && err.status === 429) {
      await log(db, msg, msg.subject, 'capped-relay', null, now, 'email');
      console.warn(`email: the relay's limits refused ${msg.template} (coach ${msg.coachId ?? '-'}); try later`);
      return 'busy';
    }
    await log(db, msg, msg.subject, 'failed', null, now, 'email');
    throw err;
  }
}

/** A sign-in code by email. The code is in the subject so it shows in the
 * inbox preview, and the body has no link for click tracking to rewrite. */
export function signInCodeEmail(code: string): { subject: string; text: string; html: string } {
  return {
    subject: `Your Coachatron code: ${code}`,
    text: `Your Coachatron sign-in code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    html: `<p style="font-family:system-ui,sans-serif;font-size:16px">Your Coachatron sign-in code is</p>
<p style="font-family:system-ui,sans-serif;font-size:32px;font-weight:700;letter-spacing:4px">${code}</p>
<p style="font-family:system-ui,sans-serif;font-size:14px;color:#6d5348">It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
  };
}

