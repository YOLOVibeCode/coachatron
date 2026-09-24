import crypto from 'node:crypto';
import type { DbClient } from '../db/client.js';
import {
  createChargeCheckout,
  createSubscriptionCheckout,
  type ChargeCheckoutResult,
  type SubscriptionCheckoutResult,
} from '../relay/connectHub.js';
import { checkOverflow } from './cascade.js';

export type { ChargeCheckoutResult, SubscriptionCheckoutResult };

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
  stripe_price_id: string | null;
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
  connect_checkout_session_id: string | null;
  checkout_mode: string | null;
  checkout_package_id: number | null;
  checkout_plan_id: number | null;
}

const BOOKING_COLUMNS = `id, session_id, athlete_name, contact_phone, contact_email, payment_source, credit_id, charge_id, gross_cents, manage_token, status,
  connect_checkout_session_id, checkout_mode, checkout_package_id, checkout_plan_id`;

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
    'select id, coach_id, name, price_cents, credits_per_month, stripe_price_id from plan where coach_id = $1 and active = true order by id',
    [coachId],
  );
  return result.rows;
}

export async function getPlanById(db: DbClient, coachId: number, planId: number): Promise<PlanRow | null> {
  const result = await db.query<PlanRow>(
    'select id, coach_id, name, price_cents, credits_per_month, stripe_price_id from plan where id = $1 and coach_id = $2 and active = true',
    [planId, coachId],
  );
  return result.rows[0] ?? null;
}

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
  stripePriceId: string | null,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    'insert into plan (coach_id, name, price_cents, credits_per_month, stripe_price_id, active) values ($1, $2, $3, $4, $5, true) returning id',
    [coachId, name, priceCents, creditsPerMonth, stripePriceId],
  );
  return result.rows[0].id;
}

export async function setPlanStripePriceId(db: DbClient, planId: number, stripePriceId: string): Promise<void> {
  await db.query('update plan set stripe_price_id = $2 where id = $1', [planId, stripePriceId]);
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

export async function createSubscriptionRecord(
  db: DbClient,
  planId: number,
  contactPhone: string,
  stripeSubscriptionId: string,
): Promise<number> {
  const result = await db.query<{ id: number }>(
    "insert into subscription (plan_id, contact_phone, square_subscription_id, status) values ($1, $2, $3, 'active') returning id",
    [planId, contactPhone, stripeSubscriptionId],
  );
  return result.rows[0].id;
}

export async function updateSubscriptionStatus(
  db: DbClient,
  stripeSubscriptionId: string,
  status: string,
): Promise<void> {
  await db.query('update subscription set status = $2 where square_subscription_id = $1', [
    stripeSubscriptionId,
    status,
  ]);
}

export function paymentIdempotencyKey(bookingId: number, mode: string): string {
  return `booking:${bookingId}:${mode}`;
}

export async function startChargeCheckoutForBooking(
  recipientKey: string,
  bookingId: number,
  mode: 'dropin' | 'package',
  amountCents: number,
  successUrl: string,
  cancelUrl: string,
  note: string,
  buyerEmail?: string | null,
): Promise<ChargeCheckoutResult> {
  return createChargeCheckout({
    recipientKey,
    idempotencyKey: paymentIdempotencyKey(bookingId, mode),
    amountCents,
    successUrl,
    cancelUrl,
    note,
    buyerEmailAddress: buyerEmail ?? undefined,
  });
}

export async function startSubscriptionCheckoutForBooking(
  recipientKey: string,
  bookingId: number,
  priceId: string,
  successUrl: string,
  email?: string | null,
): Promise<SubscriptionCheckoutResult> {
  return createSubscriptionCheckout({
    recipientKey,
    idempotencyKey: paymentIdempotencyKey(bookingId, 'plan'),
    priceId,
    successUrl,
    email: email ?? undefined,
  });
}

export async function saveCheckoutSession(
  db: DbClient,
  bookingId: number,
  sessionId: string,
  mode: 'dropin' | 'package' | 'plan',
  packageId: number | null,
  planId: number | null,
): Promise<void> {
  await db.query(
    `update booking
     set connect_checkout_session_id = $2, checkout_mode = $3, checkout_package_id = $4, checkout_plan_id = $5
     where id = $1`,
    [bookingId, sessionId, mode, packageId, planId],
  );
}

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
  const result = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from booking where id = $1`, [bookingId]);
  return result.rows[0] ?? null;
}

export async function getBookingByCheckoutSession(
  db: DbClient,
  sessionId: string,
): Promise<BookingRow | null> {
  const result = await db.query<BookingRow>(
    `select ${BOOKING_COLUMNS} from booking where connect_checkout_session_id = $1`,
    [sessionId],
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

export interface FulfillCheckoutContext {
  coachId: number;
  sessionId: number;
  sessionPriceCents: number;
  contactPhone: string;
}

export async function fulfillPaidCheckout(
  db: DbClient,
  booking: BookingRow,
  ctx: FulfillCheckoutContext,
  paymentRef: string,
  grossCents: number,
): Promise<boolean> {
  if (booking.status !== 'pending') return false;
  const mode = booking.checkout_mode;
  if (!mode || mode === 'credit') return false;

  if (mode === 'dropin') {
    await markBookingBooked(db, booking.id, {
      paymentSource: 'DropIn',
      creditId: null,
      chargeId: paymentRef,
      grossCents,
    });
    void checkOverflow(db, ctx.sessionId);
    return true;
  }

  if (mode === 'package') {
    const packageId = booking.checkout_package_id;
    if (!packageId) return false;
    const pkg = await getPackageById(db, ctx.coachId, packageId);
    if (!pkg) return false;
    const expiresAt = pkg.expires_days ? new Date(Date.now() + pkg.expires_days * 24 * 60 * 60 * 1000) : null;
    const creditId = await createCredit(
      db,
      ctx.coachId,
      ctx.contactPhone,
      pkg.id,
      `package:${pkg.id}`,
      pkg.credits - 1,
      expiresAt,
    );
    await markBookingBooked(db, booking.id, {
      paymentSource: 'PackageCredit',
      creditId,
      chargeId: paymentRef,
      grossCents,
    });
    void checkOverflow(db, ctx.sessionId);
    return true;
  }

  if (mode === 'plan') {
    const planId = booking.checkout_plan_id;
    if (!planId) return false;
    const plan = await getPlanById(db, ctx.coachId, planId);
    if (!plan) return false;
    await createSubscriptionRecord(db, plan.id, ctx.contactPhone, paymentRef);
    const creditId = await createCredit(
      db,
      ctx.coachId,
      ctx.contactPhone,
      null,
      `plan:${plan.id}`,
      plan.credits_per_month - 1,
      null,
    );
    await markBookingBooked(db, booking.id, {
      paymentSource: 'Subscription',
      creditId,
      chargeId: paymentRef,
      grossCents: plan.price_cents,
    });
    void checkOverflow(db, ctx.sessionId);
    return true;
  }

  return false;
}

export async function grantPlanRenewalCredits(
  db: DbClient,
  planId: number,
  contactPhone: string,
): Promise<void> {
  const plan = await db.query<PlanRow>(
    'select id, coach_id, name, price_cents, credits_per_month, stripe_price_id from plan where id = $1',
    [planId],
  );
  const row = plan.rows[0];
  if (!row) return;
  await createCredit(db, row.coach_id, contactPhone, null, `plan:${planId}:renewal`, row.credits_per_month, null);
}

export async function countBookedForSession(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status = 'booked'",
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}
