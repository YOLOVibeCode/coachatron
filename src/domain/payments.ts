import { createHash, randomBytes } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { APP_BASE_URL } from '../config.js';
import { getSellerStatus, type SellerStatus } from '../relay/seller.js';
import { findCoachById, getConnectRecipientKey, type CoachRow } from './auth.js';
import { fitsOneSegment, sendText } from './outbound.js';
import { inQuietHours } from './scheduling.js';
import { hasActiveConsent } from './sms-consent.js';

/** Whether parents can pay a coach yet, and the few texts that get a coach
 * who only texts from "published" to "paid". The relay owns the payment
 * account; this keeps the last answer so the public page needs no relay call. */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A coach who started payment setup is asked about at most this often. */
export const PAYMENTS_POLL_MS = 15 * MINUTE_MS;
/** Polling stops this long after the coach started; events still arrive. */
const PAYMENTS_POLL_WINDOW_MS = 30 * DAY_MS;
const PAYMENTS_POLL_BATCH = 25;
/** A payments link signs the coach in once, within a week. */
export const PAYMENTS_LINK_TTL_MS = 7 * DAY_MS;
/** A page view does not ask the relay again this soon after it last went unanswered. */
export const PAYMENTS_RETRY_MS = MINUTE_MS;
/** Reminders go about a day and about three days after the first publish.
 * Migration 0013 marks coaches from before it as sent both (reminders_sent = 2). */
const REMINDER_AFTER_MS = [24 * HOUR_MS, 72 * HOUR_MS];
const REMINDER_GAP_MS = DAY_MS;

export interface PaymentsRow {
  coach_id: number;
  charges_enabled: boolean | null;
  checked_at: string | null;
  attempted_at: string | null;
  started_at: string | null;
  published_at: string | null;
  live_texted_at: string | null;
  reminders_sent: number;
  last_reminder_at: string | null;
  ready_due_at: string | null;
  ready_texted_at: string | null;
}

// ---- Links ----

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? APP_BASE_URL).replace(/\/$/, '');
}

/** The coach's public page, e.g. https://coachatron.com/c/dana. */
export function coachPageUrl(handle: string): string {
  return `${appBaseUrl()}/c/${handle}`;
}

/** The same page without the scheme, the way a text shows it. */
function coachPageForText(handle: string): string {
  return coachPageUrl(handle).replace(/^https?:\/\//, '');
}

export function paymentsLinkUrl(token: string): string {
  return `${appBaseUrl()}/p/${token}`;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 128 random bits, 22 characters, so the link fits in a text with the page link. */
export async function createPaymentsLink(db: DbClient, coachId: number, now: Date = new Date()): Promise<string> {
  const token = randomBytes(16).toString('base64url');
  await db.query('insert into payments_link (token_hash, coach_id, expires_at) values ($1, $2, $3)', [
    tokenHash(token),
    coachId,
    new Date(now.getTime() + PAYMENTS_LINK_TTL_MS).toISOString(),
  ]);
  return token;
}

/** The coach an unused, unexpired link belongs to. Looking does not use it. */
export async function openPaymentsLink(db: DbClient, token: string, now: Date = new Date()): Promise<number | null> {
  const result = await db.query<{ coach_id: number }>(
    'select coach_id from payments_link where token_hash = $1 and used_at is null and expires_at > $2',
    [tokenHash(token), now.toISOString()],
  );
  return result.rows[0]?.coach_id ?? null;
}

/** Uses the link once; null when it is unknown, used, or expired. */
export async function consumePaymentsLink(db: DbClient, token: string, now: Date = new Date()): Promise<number | null> {
  const result = await db.query<{ coach_id: number }>(
    `update payments_link set used_at = $2
     where token_hash = $1 and used_at is null and expires_at > $2
     returning coach_id`,
    [tokenHash(token), now.toISOString()],
  );
  return result.rows[0]?.coach_id ?? null;
}

// ---- Texts (one segment each; a link is never cut) ----

const LIVE_TEMPLATE = 'coach-live';
const READY_TEMPLATE = 'payments-ready';
const REMINDER_TEMPLATE = 'payments-reminder';

function firstThatFits(template: string, bodies: string[]): string {
  return bodies.find((body) => fitsOneSegment(body, template)) ?? bodies[bodies.length - 1];
}

export function liveText(handle: string, paymentsUrl: string | null): string {
  const page = coachPageForText(handle);
  if (!paymentsUrl) {
    return firstThatFits(LIVE_TEMPLATE, [
      `Coachatron: You're live at ${page}. Parents can book and pay now.`,
      `Coachatron: You're live at ${page}.`,
    ]);
  }
  return firstThatFits(LIVE_TEMPLATE, [
    `Coachatron: You're live at ${page}. To take payments, tap: ${paymentsUrl}`,
    `Coachatron: You're live. To take payments, tap: ${paymentsUrl}`,
    `Coachatron: Set up payments: ${paymentsUrl}`,
  ]);
}

export function readyText(handle: string): string {
  return `Coachatron: You can take payments now. Your page: ${coachPageForText(handle)}`;
}

export function reminderText(paymentsUrl: string): string {
  return firstThatFits(REMINDER_TEMPLATE, [
    `Coachatron: Parents can't book until payments are set up. Tap to finish: ${paymentsUrl}`,
    `Coachatron: Set up payments: ${paymentsUrl}`,
  ]);
}

/** Texts to a coach need their mobile and the consent box (SPEC.md §10).
 * Callers check first, so a coach who cannot be texted leaves no log rows. */
async function canTextCoach(db: DbClient, coach: CoachRow): Promise<boolean> {
  return Boolean(coach.phone) && (await hasActiveConsent(db, coach.phone as string));
}

/** One text through the single send path. A relay failure is logged, never
 * thrown, so it cannot break the page or event that led here. */
async function textCoach(db: DbClient, coach: CoachRow, body: string, template: string, now: Date): Promise<boolean> {
  if (!coach.phone) return false;
  try {
    return (await sendText(db, { to: coach.phone, body, coachId: coach.id, template }, now)) === 'sent';
  } catch (err) {
    console.error(`payments: ${template} text to coach ${coach.id} failed:`, err);
    return false;
  }
}

// ---- Readiness ----

export async function getPaymentsRow(db: DbClient, coachId: number): Promise<PaymentsRow | null> {
  const result = await db.query<PaymentsRow>('select * from coach_payments where coach_id = $1', [coachId]);
  return result.rows[0] ?? null;
}

/** Saves whether the coach can take charges. Going from a known "no" to
 * "yes" owes the coach one text, sent now or after quiet hours. */
export async function recordChargesEnabled(db: DbClient, coach: CoachRow, enabled: boolean, now: Date = new Date()): Promise<void> {
  // Claimed before the new value is saved, so two reports of the same
  // change owe one text between them.
  const turnedOn =
    enabled &&
    (
      await db.query(
        `update coach_payments set ready_due_at = $2
         where coach_id = $1 and charges_enabled = false and ready_due_at is null and ready_texted_at is null
         returning coach_id`,
        [coach.id, now.toISOString()],
      )
    ).rows.length > 0;
  await db.query(
    `insert into coach_payments (coach_id, charges_enabled, checked_at) values ($1, $2, $3)
     on conflict (coach_id) do update set charges_enabled = excluded.charges_enabled, checked_at = excluded.checked_at`,
    [coach.id, enabled, now.toISOString()],
  );
  if (turnedOn) await sendReadyTextIfDue(db, coach, now);
}

/** Saves what the relay said about the coach's seller (null: never started). */
export async function recordSellerStatus(
  db: DbClient,
  coach: CoachRow,
  status: SellerStatus | null,
  now: Date = new Date(),
): Promise<void> {
  // Accepting the terms is the first step of setup, wherever it happened.
  if (status?.agreementVersion) await markPaymentsStarted(db, coach.id, now);
  await recordChargesEnabled(db, coach, status?.chargesEnabled === true, now);
}

/** Asks the relay and saves the answer. null when the relay did not answer.
 * The ask itself is saved either way, so a relay that is down is not asked
 * again on every page view and every tick. */
export async function refreshPaymentsStatus(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<boolean | null> {
  await db.query(
    `insert into coach_payments (coach_id, attempted_at) values ($1, $2)
     on conflict (coach_id) do update set attempted_at = excluded.attempted_at`,
    [coach.id, now.toISOString()],
  );
  let status: SellerStatus | null;
  try {
    status = await getSellerStatus(getConnectRecipientKey(coach));
  } catch {
    return null;
  }
  await recordSellerStatus(db, coach, status, now);
  return status?.chargesEnabled === true;
}

/** Whether a parent can pay this coach now. The saved answer when there is
 * one; otherwise the relay is asked, at most once a minute. Until it answers,
 * paying stays closed (session credits still work), since the payment page
 * is on the same relay; the tick keeps asking and opens it when it can. */
export async function paymentsOpen(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<boolean> {
  const row = await getPaymentsRow(db, coach.id);
  if (row?.charges_enabled != null) return row.charges_enabled;
  if (row?.attempted_at && now.getTime() - new Date(row.attempted_at).getTime() < PAYMENTS_RETRY_MS) return false;
  return (await refreshPaymentsStatus(db, coach, now)) ?? false;
}

export async function markPaymentsStarted(db: DbClient, coachId: number, now: Date = new Date()): Promise<void> {
  await db.query(
    `insert into coach_payments (coach_id, started_at) values ($1, $2)
     on conflict (coach_id) do update set started_at = coalesce(coach_payments.started_at, excluded.started_at)`,
    [coachId, now.toISOString()],
  );
}

/** The "you can take payments" text, once, outside quiet hours. A coach who
 * cannot be texted is not owed it any more. */
export async function sendReadyTextIfDue(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<boolean> {
  if (!(await canTextCoach(db, coach))) {
    await db.query('update coach_payments set ready_due_at = null where coach_id = $1 and ready_texted_at is null', [coach.id]);
    return false;
  }
  if (inQuietHours(now, coach.tz)) return false;
  const claimed = await db.query(
    `update coach_payments set ready_texted_at = $2
     where coach_id = $1 and charges_enabled = true and ready_due_at is not null and ready_texted_at is null
     returning coach_id`,
    [coach.id, now.toISOString()],
  );
  if (claimed.rows.length === 0) return false;
  return textCoach(db, coach, readyText(coach.handle), READY_TEMPLATE, now);
}

// ---- Publishing ----

/** Right after a publish: remember when the coach first went live and text
 * them, once, their page link and (until payments work) a payments link.
 * This answers the coach's own tap, so it goes at once, like a reply. */
export async function notePublished(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<void> {
  await db.query(
    `insert into coach_payments (coach_id, published_at) values ($1, $2)
     on conflict (coach_id) do update set published_at = coalesce(coach_payments.published_at, excluded.published_at)`,
    [coach.id, now.toISOString()],
  );
  // The public page now has sessions on it; learn whether they can be paid for.
  const enabled = await refreshPaymentsStatus(db, coach, now);
  if (!(await canTextCoach(db, coach))) return;
  const claimed = await db.query(
    'update coach_payments set live_texted_at = $2 where coach_id = $1 and live_texted_at is null returning coach_id',
    [coach.id, now.toISOString()],
  );
  if (claimed.rows.length === 0) return;
  const url = enabled ? null : paymentsLinkUrl(await createPaymentsLink(db, coach.id, now));
  const sent = await textCoach(db, coach, liveText(coach.handle, url), LIVE_TEMPLATE, now);
  // Not sent (a ceiling, or the relay): the next publish tries again.
  if (!sent) await db.query('update coach_payments set live_texted_at = null where coach_id = $1', [coach.id]);
}

// ---- The tick job ----

async function eachCoach(db: DbClient, coachIds: number[], fn: (coach: CoachRow) => Promise<unknown>): Promise<void> {
  for (const id of coachIds) {
    const coach = await findCoachById(db, id);
    if (!coach) continue;
    try {
      await fn(coach);
    } catch (err) {
      console.error(`payments: coach ${id} skipped:`, err);
    }
  }
}

/** Asks the relay about coaches who started payment setup and cannot take
 * charges yet, at most every 15 minutes each, in case an event was missed.
 * A coach never checked is asked until the relay answers, which also learns
 * whether they started. An ask that went unanswered counts, so coaches the
 * relay cannot answer for take their turn and do not hold up the rest. */
export async function pollPaymentAccounts(db: DbClient, now: Date): Promise<number> {
  const due = await db.query<{ coach_id: number }>(
    `select coach_id from coach_payments
     where charges_enabled is distinct from true
       and (charges_enabled is null or started_at > $1)
       and (greatest(checked_at, attempted_at) is null or greatest(checked_at, attempted_at) <= $2)
     order by greatest(checked_at, attempted_at) nulls first, coach_id
     limit ${PAYMENTS_POLL_BATCH}`,
    [new Date(now.getTime() - PAYMENTS_POLL_WINDOW_MS).toISOString(), new Date(now.getTime() - PAYMENTS_POLL_MS).toISOString()],
  );
  let checked = 0;
  await eachCoach(
    db,
    due.rows.map((r) => r.coach_id),
    async (coach) => {
      if ((await refreshPaymentsStatus(db, coach, now)) !== null) checked += 1;
    },
  );
  return checked;
}

/** Ready texts that waited for the morning. */
export async function sendDueReadyTexts(db: DbClient, now: Date): Promise<number> {
  const due = await db.query<{ coach_id: number }>(
    `select coach_id from coach_payments
     where charges_enabled = true and ready_due_at is not null and ready_texted_at is null
     order by coach_id`,
  );
  let sent = 0;
  await eachCoach(
    db,
    due.rows.map((r) => r.coach_id),
    async (coach) => {
      if (await sendReadyTextIfDue(db, coach, now)) sent += 1;
    },
  );
  return sent;
}

/** A published coach who has not finished payments gets the payments link
 * again about a day and about three days after publishing: two at most,
 * never in quiet hours, a day apart, and none once charges work. */
export async function sendPaymentReminders(db: DbClient, now: Date): Promise<number> {
  const due = await db.query<{ coach_id: number; reminders_sent: number }>(
    `select coach_id, reminders_sent from coach_payments
     where published_at is not null and charges_enabled = false and reminders_sent < $1
       and published_at <= case when reminders_sent = 0 then $2::timestamptz else $3::timestamptz end
       and (last_reminder_at is null or last_reminder_at <= $4)
     order by coach_id`,
    [
      REMINDER_AFTER_MS.length,
      new Date(now.getTime() - REMINDER_AFTER_MS[0]).toISOString(),
      new Date(now.getTime() - REMINDER_AFTER_MS[1]).toISOString(),
      new Date(now.getTime() - REMINDER_GAP_MS).toISOString(),
    ],
  );
  const sentBefore = new Map(due.rows.map((r) => [r.coach_id, r.reminders_sent]));
  let sent = 0;
  await eachCoach(db, [...sentBefore.keys()], async (coach) => {
    if (inQuietHours(now, coach.tz) || !(await canTextCoach(db, coach))) return;
    // Ask once more right before: a coach who just finished gets no reminder.
    if ((await refreshPaymentsStatus(db, coach, now)) !== false) return;
    const claimed = await db.query(
      `update coach_payments set reminders_sent = reminders_sent + 1, last_reminder_at = $3
       where coach_id = $1 and reminders_sent = $2 returning coach_id`,
      [coach.id, sentBefore.get(coach.id), now.toISOString()],
    );
    if (claimed.rows.length === 0) return;
    const url = paymentsLinkUrl(await createPaymentsLink(db, coach.id, now));
    if (await textCoach(db, coach, reminderText(url), REMINDER_TEMPLATE, now)) sent += 1;
  });
  return sent;
}
