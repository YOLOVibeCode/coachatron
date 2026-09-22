import { getDb, type DbClient } from '../db/client.js';
import { charge as connectHubCharge, subscribe as connectHubSubscribe, type ChargeResult, type SubscribeResult } from '../relay/connectHub.js';

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
  payment_source: string;
  credit_id: number | null;
  charge_id: string | null;
  gross_cents: number | null;
  status: string;
}

/**
 * Get a pricing idempotency key for charge/subscription calls.
 * Format: payment:{coach_id}:{session_or_offer_id}:{mode}
 */
export function getPricingIdempotencyKey(coachId: number, targetId: number, mode: 'dropin' | 'package' | 'plan'): string {
  return `payment:${coachId}:${targetId}:${mode}`;
}

/**
 * Get package by ID for a specific coach.
 */
export async function getPackageById(db: DbClient, coachId: number, packageId: number): Promise<PackageRow | null> {
  const result = await db.query<{ id: number; coach_id: number; name: string; credits: number; price_cents: number; expires_days: number | null }>(
    'select id, coach_id, name, credits, price_cents, expires_days from package where id = $1 and coach_id = $2 and active = true',
    [packageId, coachId],
  );
  return result.rows[0] ?? null;
}

/**
 * Get all active packages for a coach.
 */
export async function getPackagesForCoach(db: DbClient, coachId: number): Promise<PackageRow[]> {
  const result = await db.query<{ id: number; name: string; credits: number; price_cents: number; expires_days: number | null }>(
    'select id, name, credits, price_cents, expires_days from package where coach_id = $1 and active = true',
    [coachId],
  );
  return result.rows;
}

/**
 * Get plan by ID for a specific coach.
 */
export async function getPlanById(db: DbClient, coachId: number, planId: number): Promise<PlanRow | null> {
  const result = await db.query<{ id: number; coach_id: number; name: string; price_cents: number; credits_per_month: number }>(
    'select id, coach_id, name, price_cents, credits_per_month from plan where id = $1 and coach_id = $2 and active = true',
    [planId, coachId],
  );
  return result.rows[0] ?? null;
}

/**
 * Get all active plans for a coach.
 */
export async function getPlansForCoach(db: DbClient, coachId: number): Promise<PlanRow[]> {
  const result = await db.query<{ id: number; name: string; price_cents: number; credits_per_month: number }>(
    'select id, name, price_cents, credits_per_month from plan where coach_id = $1 and active = true',
    [coachId],
  );
  return result.rows;
}

/**
 * Get credit balance for a contact phone.
 */
export async function getCreditBalance(db: DbClient, coachId: number, contactPhone: string): Promise<CreditRow | null> {
  const result = await db.query<{ id: number; package_id: number | null; remaining: number; source: string; expires_at: string | null }>(
    'select id, package_id, remaining, source, expires_at from credit where coach_id = $1 and contact_phone = $2 and remaining > 0 and (expires_at is null or expires_at > now()) order by expires_at asc limit 1',
    [coachId, contactPhone],
  );
  return result.rows[0] ?? null;
}

/**
 * Apply a credit to a booking. Returns true if credit was applied.
 */
export async function applyCredit(db: DbClient, coachId: number, contactPhone: string): Promise<boolean> {
  const credit = await getCreditBalance(db, coachId, contactPhone);
  if (!credit) {
    return false;
  }
  // Decrement remaining credits
  await db.query('update credit set remaining = remaining - 1 where id = $1 and remaining > 0', [credit.id]);
  return true;
}

/**
 * Create a new package for the coach.
 */
export async function createPackage(db: DbClient, coachId: number, name: string, credits: number, priceCents: number, expiresDays?: number): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into package (coach_id, name, credits, price_cents, expires_days, active) values ($1, $2, $3, $4, $5, true) returning id',
    [coachId, name, credits, priceCents, expiresDays ?? null],
  );
  return result.rows[0].id;
}

/**
 * Create a new plan for the coach.
 */
export async function createPlan(db: DbClient, coachId: number, name: string, priceCents: number, creditsPerMonth: number): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into plan (coach_id, name, price_cents, credits_per_month, active) values ($1, $2, $3, $4, true) returning id',
    [coachId, name, priceCents, creditsPerMonth],
  );
  return result.rows[0].id;
}

/**
 * Create a credit (for package/plan purchases).
 */
export async function createCredit(
  db: DbClient,
  coachId: number,
  contactPhone: string,
  packageId: number | null,
  source: string,
  remaining: number,
  expiresAt?: Date,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into credit (coach_id, contact_phone, package_id, source, remaining, expires_at) values ($1, $2, $3, $4, $5, $6) returning id',
    [coachId, contactPhone, packageId, source, remaining, expiresAt ?? null],
  );
  return result.rows[0].id;
}

/**
 * Create a subscription record (for plan purchases).
 */
export async function createSubscriptionRecord(db: DbClient, planId: number, contactPhone: string): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into subscription (plan_id, contact_phone, status) values ($1, $2, active) returning id',
    [planId, contactPhone],
  );
  return result.rows[0].id;
}

/**
 * Charge via Connect Hub. Returns the charge result and the gross amount charged.
 */
export async function processCharge(
  db: DbClient,
  coachId: number,
 sessionId: number,
  amountCents: number,
  sourceId: string,
  note: string,
): Promise<{ result: ChargeResult; grossCents: number }> {
  const key = getPricingIdempotencyKey(coachId, sessionId, 'dropin');
  const result = await connectHubCharge({
    idempotencyKey: key,
    amountCents,
    sourceId,
    note,
  });
  return { result, grossCents: amountCents };
}

/**
 * Subscribe via Connect Hub. Returns the subscription result.
 */
export async function processSubscription(
  db: DbClient,
  coachId: number,
  contactPhone: string,
  planName: string,
  priceCents: number,
): Promise<{ result: SubscribeResult }> {
  const key = getPricingIdempotencyKey(coachId, Date.now(), 'plan');
  const result = await connectHubSubscribe({
    idempotencyKey: key,
    priceCents,
    contactPhone,
    planName,
  });
  return { result };
}

/**
 * Create a new booking row.
 */
export async function createBooking(
  db: DbClient,
  sessionId: number,
  athleteName: string,
  contactPhone: string,
  contactEmail?: string,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into booking (session_id, athlete_name, contact_phone, contact_email, payment_source, status) values ($1, $2, $3, $4, $5, pending) returning id',
    [sessionId, athleteName, contactPhone, contactEmail ?? null, 'Pending'],
  );
  return result.rows[0].id;
}
