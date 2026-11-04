import crypto from 'node:crypto';
import { inTransaction, type DbClient } from '../db/client.js';
import { BOOKING_HOLD_MINUTES } from '../config.js';

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
  checkout_token: string | null;
  hold_expires_at: string | null;
  phone_verified_at: string | null;
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

/** Whether any family holds an unused, unexpired credit with this coach. */
export async function coachHasOpenCredits(db: DbClient, coachId: number): Promise<boolean> {
  const result = await db.query(
    'select 1 from credit where coach_id = $1 and remaining > 0 and (expires_at is null or expires_at > now()) limit 1',
    [coachId],
  );
  return result.rows.length > 0;
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

/** A token for a booking's manage link or checkout page: 128 random bits,
 * URL-safe, and short enough to leave room in a one-segment text. */
export function newBookingToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** SQL for "this booking takes a spot": it was sold and not cancelled, or
 * it is pending and its hold has not run out. `b` is the booking alias. */
export function takesSpotSql(b: string): string {
  return `(${b}.status in ('booked', 'attended', 'noshow') or (${b}.status = 'pending' and ${b}.hold_expires_at > now()))`;
}

/** Spots taken in a session: live bookings plus unexpired holds. */
export async function countTakenSpots(db: DbClient, sessionId: number, exceptBookingId: number | null = null): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from booking b
     where b.session_id = $1 and b.id <> coalesce($2::int, -1) and ${takesSpotSql('b')}`,
    [sessionId, exceptBookingId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export interface PendingBooking {
  id: number;
  checkoutToken: string;
  manageToken: string;
}

/** Locks a session's row until the transaction ends and returns its status.
 * Every write that counts a session's spots takes this lock first, so two
 * of them for one session run one after the other and each counts what the
 * other wrote. A coach's cancel, which closes the session row first, waits
 * for them too, so it sees any booking they made. */
async function lockSession(tx: DbClient, sessionId: number): Promise<string | null> {
  const result = await tx.query<{ status: string }>('select status from session where id = $1 for update', [sessionId]);
  return result.rows[0]?.status ?? null;
}

/** Creates the booking in `pending` status, holding one spot for
 * BOOKING_HOLD_MINUTES while the parent chooses how to pay. The checkout
 * step (screen 10) fills in payment_source, charge_id, gross_cents, and
 * flips status.
 *
 * A phone holds one spot per session while paying: when the same phone
 * sends the form again (the back button, a fixed typo, a second tap), its
 * earlier hold on the session ends and the new booking takes its place.
 *
 * Returns null, and keeps nothing, when the session has no spot left or is
 * no longer scheduled. Counting and writing happen under the session's
 * lock, so two parents going for the last spot cannot both hold it. */
export async function createPendingBooking(
  db: DbClient,
  args: {
    sessionId: number;
    capacity: number;
    athleteName: string;
    contactPhone: string;
    contactEmail: string | null;
    phoneVerified?: boolean;
  },
): Promise<PendingBooking | null> {
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, args.sessionId)) !== 'scheduled') return null;
    const others = await tx.query<{ count: string }>(
      `select count(*)::text as count from booking b
       where b.session_id = $1 and ${takesSpotSql('b')} and not (b.status = 'pending' and b.contact_phone = $2)`,
      [args.sessionId, args.contactPhone],
    );
    if (Number(others.rows[0]?.count ?? '0') >= args.capacity) return null;
    await tx.query(
      `update booking set hold_expires_at = now()
       where session_id = $1 and contact_phone = $2 and status = 'pending' and hold_expires_at > now()`,
      [args.sessionId, args.contactPhone],
    );
    const manageToken = newBookingToken();
    const checkoutToken = newBookingToken();
    const result = await tx.query<{ id: number }>(
      `insert into booking (session_id, athlete_name, contact_phone, contact_email, manage_token, checkout_token,
                            hold_expires_at, phone_verified_at, status)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int), case when $8::boolean then now() end, 'pending')
       returning id`,
      [
        args.sessionId,
        args.athleteName,
        args.contactPhone,
        args.contactEmail,
        manageToken,
        checkoutToken,
        BOOKING_HOLD_MINUTES,
        args.phoneVerified === true,
      ],
    );
    return { id: result.rows[0].id, checkoutToken, manageToken };
  });
}

const BOOKING_COLUMNS = `id, session_id, athlete_name, contact_phone, contact_email, payment_source, credit_id, charge_id, gross_cents,
  manage_token, checkout_token, hold_expires_at, phone_verified_at, status`;

export async function getBooking(db: DbClient, bookingId: number): Promise<BookingRow | null> {
  const result = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from booking where id = $1`, [bookingId]);
  return result.rows[0] ?? null;
}

/** The booking behind a checkout page. Only the checkout token finds it,
 * never the serial id. */
export async function getBookingByCheckoutToken(db: DbClient, token: string): Promise<BookingRow | null> {
  if (!token) return null;
  const result = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from booking where checkout_token = $1`, [token]);
  return result.rows[0] ?? null;
}

export type HoldResult = 'held' | 'full' | 'closed' | 'not_pending';

/** Keeps a pending booking's spot for the parent who is about to pay: the
 * hold runs BOOKING_HOLD_MINUTES from now, so a parent who picks a way to
 * pay near the end of their hold still has time to pay. A lapsed hold is
 * renewed only while the session still has room. */
export async function renewHold(db: DbClient, booking: Pick<BookingRow, 'id' | 'session_id'>, capacity: number): Promise<HoldResult> {
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, booking.session_id)) !== 'scheduled') {
      return (await isPending(tx, booking.id)) ? 'closed' : 'not_pending';
    }
    const result = await tx.query<{ id: number }>(
      `update booking set hold_expires_at = now() + make_interval(mins => $3::int)
       where id = $1 and status = 'pending'
         and (hold_expires_at > now()
              or (select count(*) from booking o where o.session_id = $2 and o.id <> $1 and ${takesSpotSql('o')}) < $4)
       returning id`,
      [booking.id, booking.session_id, BOOKING_HOLD_MINUTES, capacity],
    );
    if (result.rows.length === 1) return 'held';
    return (await isPending(tx, booking.id)) ? 'full' : 'not_pending';
  });
}

async function isPending(db: DbClient, bookingId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>("select id from booking where id = $1 and status = 'pending'", [bookingId]);
  return result.rows.length === 1;
}

export type BookResult = 'booked' | 'full' | 'closed' | 'not_pending';

/** Flips a pending booking to booked, under the session's lock. It books
 * while the session is still scheduled and the booking still holds its
 * spot, or, once the hold has lapsed, while the session still has room.
 * A phone holds one spot per session, so a newer unpaid hold by the same
 * phone does not stand in the way: this booking takes that spot and the
 * unpaid hold ends. 'closed' when the session was cancelled, 'full' when
 * there is no room, 'not_pending' when the booking was already settled. */
export async function bookPendingBooking(
  db: DbClient,
  booking: Pick<BookingRow, 'id' | 'session_id'>,
  capacity: number,
  fields: { paymentSource: string; creditId: number | null; chargeId: string | null; grossCents: number | null },
): Promise<BookResult> {
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, booking.session_id)) !== 'scheduled') {
      return (await isPending(tx, booking.id)) ? 'closed' : 'not_pending';
    }
    const result = await tx.query<{ contact_phone: string }>(
      `update booking b
       set status = 'booked', payment_source = $3, credit_id = $4, charge_id = $5, gross_cents = $6
       where b.id = $1 and b.status = 'pending'
         and (b.hold_expires_at > now()
              or (select count(*) from booking o
                  where o.session_id = $2 and o.id <> $1 and ${takesSpotSql('o')}
                    and not (o.status = 'pending' and o.contact_phone = b.contact_phone)) < $7)
       returning b.contact_phone`,
      [booking.id, booking.session_id, fields.paymentSource, fields.creditId, fields.chargeId, fields.grossCents, capacity],
    );
    const phone = result.rows[0]?.contact_phone;
    if (phone === undefined) return (await isPending(tx, booking.id)) ? 'full' : 'not_pending';
    await tx.query(
      `update booking set hold_expires_at = now()
       where session_id = $2 and contact_phone = $3 and status = 'pending' and id <> $1 and hold_expires_at > now()
         and (select count(*) from booking o where o.session_id = $2 and ${takesSpotSql('o')}) > $4`,
      [booking.id, booking.session_id, phone, capacity],
    );
    return 'booked';
  });
}

export interface CreditGrant {
  coachId: number;
  contactPhone: string;
  packageId: number | null;
  source: string;
  remaining: number;
  expiresAt: Date | null;
}

/** Adds the credit a paid package or pack leaves after its first session,
 * and ties it to the booking. The booking's row is locked first and the
 * credit added only while it has none, so handling the same payment again,
 * even at the same moment, never adds a second. */
export async function grantBookingCredit(db: DbClient, bookingId: number, grant: CreditGrant): Promise<number | null> {
  return inTransaction(db, async (tx) => {
    const claim = await tx.query<{ id: number }>('select id from booking where id = $1 and credit_id is null for update', [bookingId]);
    if (claim.rows.length === 0) return null;
    const creditId = await createCredit(tx, grant.coachId, grant.contactPhone, grant.packageId, grant.source, grant.remaining, grant.expiresAt);
    await tx.query('update booking set credit_id = $2 where id = $1', [bookingId, creditId]);
    return creditId;
  });
}

/** A payment for a pending booking whose session was cancelled: the booking
 * is closed as cancelled with the payment on it, and the whole payment
 * becomes credit with the coach. The booking's row is locked first, and
 * this happens only while it is still pending, so it happens once. Null
 * when it was not pending. */
export async function creditCancelledBooking(
  db: DbClient,
  bookingId: number,
  grant: CreditGrant,
  payment: { paymentSource: string; chargeId: string | null; grossCents: number | null },
): Promise<number | null> {
  return inTransaction(db, async (tx) => {
    const claim = await tx.query<{ id: number }>("select id from booking where id = $1 and status = 'pending' for update", [bookingId]);
    if (claim.rows.length === 0) return null;
    const creditId = await createCredit(tx, grant.coachId, grant.contactPhone, grant.packageId, grant.source, grant.remaining, grant.expiresAt);
    await tx.query(
      `update booking set status = 'cancelled', payment_source = $2, charge_id = $3, gross_cents = $4, credit_id = $5
       where id = $1`,
      [bookingId, payment.paymentSource, payment.chargeId, payment.grossCents, creditId],
    );
    return creditId;
  });
}

/** Records a pack purchase once per payment. */
export async function ensureSubscriptionRecord(db: DbClient, planId: number, contactPhone: string, paymentRef: string): Promise<void> {
  await db.query(
    `insert into subscription (plan_id, contact_phone, square_subscription_id, status)
     select $1::int, $2::text, $3::text, 'active'
     where not exists (select 1 from subscription where plan_id = $1 and contact_phone = $2 and square_subscription_id = $3)`,
    [planId, contactPhone, paymentRef],
  );
}

/** A package by id for a paid event: a payment made before the coach
 * retired the package still counts. */
export async function getPackageForPayment(db: DbClient, coachId: number, packageId: number): Promise<PackageRow | null> {
  const result = await db.query<PackageRow>(
    'select id, coach_id, name, credits, price_cents, expires_days from package where id = $1 and coach_id = $2',
    [packageId, coachId],
  );
  return result.rows[0] ?? null;
}

export async function getPlanForPayment(db: DbClient, coachId: number, planId: number): Promise<PlanRow | null> {
  const result = await db.query<PlanRow>(
    'select id, coach_id, name, price_cents, credits_per_month from plan where id = $1 and coach_id = $2',
    [planId, coachId],
  );
  return result.rows[0] ?? null;
}

/** The parent proved they hold this booking's phone. */
export async function markPhoneVerified(db: DbClient, bookingId: number): Promise<void> {
  await db.query('update booking set phone_verified_at = now() where id = $1 and phone_verified_at is null', [bookingId]);
}

export async function restoreCredit(db: DbClient, creditId: number): Promise<void> {
  await db.query('update credit set remaining = remaining + 1 where id = $1', [creditId]);
}
