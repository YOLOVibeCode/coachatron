import type { DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import { sendEmail } from '../relay/email.js';
import { zonedParts, zonedTimeToUtc } from './scheduling.js';
import {
  SMS_COACH_DAILY_CAP,
  SMS_COACH_MONTHLY_CAP,
  SMS_PRODUCT_DAILY_FLOOR,
  SMS_PRODUCT_DAILY_PER_COACH,
} from '../config.js';

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
 * to 70. PLATFORM.md §4.5: "a second segment is never sent." */
export function toOneSegment(body: string): string {
  let text = body.trim();
  for (const [re, to] of TRANSLITERATE) text = text.replace(re, to);
  const gsm = gsmLength(text);
  if (gsm !== null) {
    if (gsm <= GSM_SEGMENT) return text;
    let out = '';
    let used = 0;
    for (const ch of text) {
      const w = GSM_EXTENDED.has(ch) ? 2 : 1;
      if (used + w > GSM_SEGMENT - 3) break;
      out += ch;
      used += w;
    }
    return `${out.trimEnd()}...`;
  }
  // UCS-2 counts UTF-16 code units; never split a surrogate pair.
  if (text.length <= UCS2_SEGMENT) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > UCS2_SEGMENT - 3) break;
    out += ch;
  }
  return `${out.trimEnd()}...`;
}

export function segmentCount(body: string): number {
  const gsm = gsmLength(body);
  return gsm !== null ? Math.max(1, Math.ceil(gsm / GSM_SEGMENT)) : Math.max(1, Math.ceil(body.length / UCS2_SEGMENT));
}

/** US and Canada only: the NANP is what Twilio prices near $0.0083 a
 * segment. Anything else can cost many times that, so it is refused
 * (PLATFORM.md §4.5: "above $0.02/segment is refused"). */
export function isDomesticDestination(phone: string): boolean {
  return /^\+1\d{10}$/.test(phone);
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

export type SendOutcome = 'sent' | 'capped' | 'refused';

export interface OutboundText {
  to: string;
  body: string;
  /** The coach this text is sent for; null for sign-in codes and replies to unknown numbers. */
  coachId: number | null;
  /** A short name for the kind of text, e.g. "reminder", "offer", "otp". */
  template: string;
  /** Optional ceiling on this template to this number in 24 hours. */
  perRecipientDailyMax?: number;
}

type Channel = 'sms' | 'email';

/** Counts sent rows on one channel; SMS ceilings never count emails. */
async function countSent(db: DbClient, where: string, params: unknown[], channel: Channel = 'sms'): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select count(*)::text as n from message_log where status = 'sent' and channel = '${channel}' and ${where}`,
    params,
  );
  return Number(result.rows[0]?.n ?? '0');
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
) {
  await db.query(
    `insert into message_log (to_phone, template, body, provider_id, sent_at, status, coach_id, channel)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [msg.to, msg.template, body, providerId, now.toISOString(), status, msg.coachId, channel],
  );
}

export async function sendText(db: DbClient, msg: OutboundText, now: Date = new Date()): Promise<SendOutcome> {
  const body = toOneSegment(msg.body);
  if (!canText(msg.to)) {
    await log(db, msg, body, 'refused-destination', null, now);
    return 'refused';
  }
  const hit = await ceilingHit(db, msg, now);
  if (hit) {
    await log(db, msg, body, `capped-${hit}`, null, now);
    console.warn(`sms: ${hit} ceiling reached, not sending ${msg.template} (coach ${msg.coachId ?? '-'})`);
    return 'capped';
  }
  try {
    const sent = await sendSms({ to: msg.to, body });
    await log(db, msg, body, 'sent', sent.id ?? null, now);
    return 'sent';
  } catch (err) {
    await log(db, msg, body, 'failed', null, now);
    throw err;
  }
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

