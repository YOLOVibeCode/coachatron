import crypto from 'node:crypto';
import type { DbClient } from '../db/client.js';
import {
  charge as connectHubCharge,
  subscribe as connectHubSubscribe,
  type ChargeResult,
  type SubscribeResult,
} from '../relay/connectHub.js';

export type { ChargeResult, SubscribeResult };

export interface PackageRow {
  id: number;
  coach_id: number;
  name: string;
  credits: number;
  price_cents: number;
  expires_days: number | null;
}

export interface PlanRow {
  id: number;
  coach_id: number;
  name: string;
  price_cents: number;
  credits_per_month: number;
}

export interface CreditRow {
  id: number;
  coach_id: number;
  contact_phone: string;
  package_id: number | null;
  remaining: number;
  source: string;
  expires_at: string | null;
}

export interface BookingRow {
  id: number;
  session_id: number;
  athlete_name: string;
  contact_phone: string;
  contact_email: string | null;
  payment_source: string | null;
  credit_id: number | null;
  charge_id: string | null;
  gross_cents: number | null;
  manage_token: string;
  status: string;
}

export async function getPackagesForCoach(db: DbClient, coachId: number): Promise<PackageRow[]> {
  const result = await db.query<PackageRow>(
    'select id, coach_id, name, credits, price_cents, expires_days from package where coach_id = $1 and active = true order by id',
    [coachId],
  );
  return result.rows;
}

export async function getPackageById(db: DbClient, coachId: number, packageId: number): Promise<PackageRow | null> {
  const result = await db.query<PackageRow>(
    'select id, coach_id, name, credits, price_cents, expires_days from package where id = $1 and coach_id = $2 and active = true',
    [packageId, coachId],
  );
  return result.rows[0] ?? null;
}

export async function getPlansForCoach(db: DbClient, coachId: number): Promise<PlanRow[]> {
  const result = await db.query<PlanRow>(
    'select id, coach_id, name, price_cents, credits_per_month from plan where coach_id = $1 and active = true order by id',
    [coachId],
  );
  return result.rows;
}

export async function getPlanById(db: DbClient, coachId: number, planId: number): Promise<PlanRow | null> {
  const result = await db.query<PlanRow>(
    'select id, coach_id, name, price_cents, credits_per_month from plan where id = $1 and coach_id = $2 and active = true',
    [planId, coachId],
  );
  return result.rows[0] ?? null;
}

/** The oldest-expiring usable credit for this coach+phone, if any. Credits
 * are tracked per phone number, not per account (SPEC.md §9.2), so a parent
 * booking two children with one phone draws from one pool. */
export async function getCreditBalance(db: DbClient, coachId: number, contactPhone: string): Promise<CreditRow | null> {
  const result = await db.query<CreditRow>(
    `select id, coach_id, contact_phone, package_id, remaining, source, expires_at
     from credit
     where coach_id = $1 and contact_phone = $2 and remaining > 0 and (expires_at is null or expires_at > now())
     order by expires_at asc nulls last, id asc
     limit 1`,
    [coachId, contactPhone],
  );
  return result.rows[0] ?? null;
}

/** Decrements one unit off a specific credit row. Returns false if the
 * credit is already exhausted (race with another booking on the same
 * phone). Caller re-fetches the credit immediately before calling this. */
export async function decrementCredit(db: DbClient, creditId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    'update credit set remaining = remaining - 1 where id = $1 and remaining > 0 returning id',
    [creditId],
  );
  return result.rows.length === 1;
}

export async function createPackage(
  db: DbClient,
  coachId: number,
  name: string,
  credits: number,
  priceCents: number,
  expiresDays?: number,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into package (coach_id, name, credits, price_cents, expires_days, active) values ($1, $2, $3, $4, $5, true) returning id',
    [coachId, name, credits, priceCents, expiresDays ?? null],
  );
  return result.rows[0].id;
}

export async function createPlan(
  db: DbClient,
  coachId: number,
  name: string,
  priceCents: number,
  creditsPerMonth: number,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into plan (coach_id, name, price_cents, credits_per_month, active) values ($1, $2, $3, $4, true) returning id',
    [coachId, name, priceCents, creditsPerMonth],
  );
  return result.rows[0].id;
}

export async function createCredit(
  db: DbClient,
  coachId: number,
  contactPhone: string,
  packageId: number | null,
  source: string,
  remaining: number,
  expiresAt: Date | null,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into credit (coach_id, contact_phone, package_id, remaining, source, expires_at) values ($1, $2, $3, $4, $5, $6) returning id',
    [coachId, contactPhone, packageId, remaining, source, expiresAt ? expiresAt.toISOString() : null],
  );
  return result.rows[0].id;
}

export async function createSubscriptionRecord(db: DbClient, planId: number, contactPhone: string, squareSubscriptionId: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    "insert into subscription (plan_id, contact_phone, square_subscription_id, status) values ($1, $2, $3, 'active') returning id",
    [planId, contactPhone, squareSubscriptionId],
  );
  return result.rows[0].id;
}

/** Idempotency key for a payment attempt on a specific booking. Stable
 * across retries of the *same* checkout submission (same booking, same
 * mode) so a network retry cannot double-charge; a different mode or a
 * different booking gets its own key. */
export function paymentIdempotencyKey(bookingId: number, mode: string): string {
  return `booking:${bookingId}:${mode}`;
}

export async function chargeForBooking(
  bookingId: number,
  mode: 'dropin' | 'package',
  amountCents: number,
  sourceId: string,
  note: string,
): Promise<ChargeResult> {
  return connectHubCharge({
    idempotencyKey: paymentIdempotencyKey(bookingId, mode),
    amountCents,
    sourceId,
    note,
  });
}

export async function subscribeForBooking(
  bookingId: number,
  priceCents: number,
  contactPhone: string,
  planName: string,
): Promise<SubscribeResult> {
  return connectHubSubscribe({
    idempotencyKey: paymentIdempotencyKey(bookingId, 'plan'),
    priceCents,
    contactPhone,
    planName,
  });
}

/** Creates the booking in `pending` status with no payment mode chosen yet
 * — the checkout step (screen 10) decides drop-in/package/plan/credit and
 * fills in payment_source, charge_id, gross_cents, and flips status. */
export async function createPendingBooking(
  db: DbClient,
  sessionId: number,
  athleteName: string,
  contactPhone: string,
  contactEmail: string | null,
): Promise<number> {
  const manageToken = crypto.randomBytes(32).toString('hex');
  const result = await db.query<{ id: number }>(
    `insert into booking (session_id, athlete_name, contact_phone, contact_email, manage_token, status)
     values ($1, $2, $3, $4, $5, 'pending')
     returning id`,
    [sessionId, athleteName, contactPhone, contactEmail, manageToken],
  );
  return result.rows[0].id;
}

export async function getBooking(db: DbClient, bookingId: number): Promise<BookingRow | null> {
  const result = await db.query<BookingRow>(
    `select id, session_id, athlete_name, contact_phone, contact_email, payment_source, credit_id, charge_id, gross_cents, manage_token, status
     from booking where id = $1`,
    [bookingId],
  );
  return result.rows[0] ?? null;
}

export async function markBookingBooked(
  db: DbClient,
  bookingId: number,
  fields: { paymentSource: string; creditId: number | null; chargeId: string | null; grossCents: number | null },
): Promise<void> {
  await db.query(
    `update booking
     set status = 'booked', payment_source = $2, credit_id = $3, charge_id = $4, gross_cents = $5
     where id = $1`,
    [bookingId, fields.paymentSource, fields.creditId, fields.chargeId, fields.grossCents],
  );
}

export async function countBookedForSession(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status = 'booked'",
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}
