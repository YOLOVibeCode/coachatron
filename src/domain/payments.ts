import type { DbClient } from '../db/client.js';
import { APP_BASE_URL } from '../config.js';
import { getSellerStatus, type SellerStatus } from '../relay/seller.js';
import { findCoachById, getConnectRecipientKey, type CoachRow } from './auth.js';
import { sendText } from './outbound.js';
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

export interface PaymentsRow {
  coach_id: number;
  charges_enabled: boolean | null;
  checked_at: string | null;
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

// ---- Texts ----

const READY_TEMPLATE = 'payments-ready';

export function readyText(handle: string): string {
  return `Coachatron: You can take payments now. Your page: ${coachPageForText(handle)}`;
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

/** Asks the relay and saves the answer. null when the relay did not answer. */
export async function refreshPaymentsStatus(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<boolean | null> {
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
 * one; otherwise the relay is asked once. If it cannot be asked, booking
 * stays open as it was before readiness was tracked. */
export async function paymentsOpen(db: DbClient, coach: CoachRow, now: Date = new Date()): Promise<boolean> {
  const row = await getPaymentsRow(db, coach.id);
  if (row?.charges_enabled != null) return row.charges_enabled;
  return (await refreshPaymentsStatus(db, coach, now)) ?? true;
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
 * A coach never checked is asked once, which also learns whether they started. */
export async function pollPaymentAccounts(db: DbClient, now: Date): Promise<number> {
  const due = await db.query<{ coach_id: number }>(
    `select coach_id from coach_payments
     where charges_enabled is distinct from true
       and (charges_enabled is null or started_at > $1)
       and (checked_at is null or checked_at <= $2)
     order by checked_at nulls first, coach_id
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
