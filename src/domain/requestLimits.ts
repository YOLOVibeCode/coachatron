import type { Request } from 'express';
import type { DbClient } from '../db/client.js';

/** How often one client address, or one phone or email, may do something
 * that costs a text or an email, or try a sign-in code. Fixed windows in
 * the database, so a restart does not reset them. */

export interface LimitRule {
  /** Names the counter, e.g. "code-ip-10m". */
  bucket: string;
  windowMs: number;
  max: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Requests from one address that send a sign-in code, by text or email.
 * The per-number and per-email ceiling is OTP_DAILY_MAX_PER_CONTACT. */
export const SIGNIN_CODE_LIMITS: LimitRule[] = [
  { bucket: 'code-ip-10m', windowMs: 10 * MINUTE, max: 10 },
  { bucket: 'code-ip-day', windowMs: DAY, max: 30 },
];

/** Sign-in code checks from one address. */
export const CODE_CHECK_IP_LIMITS: LimitRule[] = [{ bucket: 'check-ip-10m', windowMs: 10 * MINUTE, max: 30 }];

/** Sign-in code checks for one phone or email. Each code also stops
 * working after OTP_MAX_ATTEMPTS wrong tries. */
export const CODE_CHECK_CONTACT_LIMITS: LimitRule[] = [{ bucket: 'check-contact-hour', windowMs: HOUR, max: 15 }];

/** Opt-ins at /sms from one address. Each number gets one confirmation a day. */
export const SMS_OPT_IN_LIMITS: LimitRule[] = [
  { bucket: 'opt-in-ip-hour', windowMs: HOUR, max: 5 },
  { bucket: 'opt-in-ip-day', windowMs: DAY, max: 20 },
];

/** Waitlist joins from one address. A join can send the coach a text or
 * an email asking whether to open a second group. */
export const WAITLIST_LIMITS: LimitRule[] = [
  { bucket: 'waitlist-ip-hour', windowMs: HOUR, max: 10 },
  { bucket: 'waitlist-ip-day', windowMs: DAY, max: 30 },
];

/** The landing page's week box, from one address. */
export const START_BOX_LIMITS: LimitRule[] = [{ bucket: 'start-ip-10m', windowMs: 10 * MINUTE, max: 30 }];

/** The longest window above; counters older than twice this are purged. */
const LONGEST_WINDOW_MS = DAY;

function windowStart(rule: LimitRule, now: Date): string {
  return new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs).toISOString();
}

/** The visitor's address. Express reads it through the trusted proxy hop
 * (server.ts), so it is the client's, not Railway's edge. */
export function clientKey(req: Request): string {
  return typeof req.ip === 'string' && req.ip ? req.ip : 'unknown';
}

async function addHit(db: DbClient, rule: LimitRule, key: string, now: Date): Promise<number> {
  const result = await db.query<{ hits: number }>(
    `insert into request_limit (bucket, key, window_start, hits) values ($1, $2, $3, 1)
     on conflict (bucket, key, window_start) do update set hits = request_limit.hits + 1
     returning hits`,
    [rule.bucket, key, windowStart(rule, now)],
  );
  return Number(result.rows[0]?.hits ?? 0);
}

/** Counts one request against every rule. False when any rule is over its
 * limit, and then the caller does not do the work. */
export async function takeRequest(db: DbClient, rules: LimitRule[], key: string, now: Date = new Date()): Promise<boolean> {
  let allowed = true;
  for (const rule of rules) {
    if ((await addHit(db, rule, key, now)) > rule.max) allowed = false;
  }
  return allowed;
}

/** Drops counters whose windows ended long ago. Run by the tick. */
export async function purgeRequestLimits(db: DbClient, now: Date): Promise<void> {
  await db.query('delete from request_limit where window_start < $1', [new Date(now.getTime() - 2 * LONGEST_WINDOW_MS).toISOString()]);
}
