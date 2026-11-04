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
  pass_id: string | null;
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

/** A credit can be used only while no refund of the payment that bought it
 * is on its way or done (SPEC.md §9.4). */
const NOT_HELD_FOR_REFUND = 'refund_id is null';

/** A credit made from a booking whose payment is being refunded (its
 * session was cancelled while the refund is on its way) is held with that
 * refund from the start, like the credit the payment bought: it cannot be
 * used until the refund goes through (and withdraws it) or fails (and gives
 * it back). Run in the same transaction that creates the credit. Returns
 * whether it was held. */
export async function holdCreditForRefund(db: DbClient, creditId: number, paymentRef: string | null): Promise<boolean> {
  if (paymentRef === null) return false;
  const result = await db.query<{ id: number }>(
    `update credit set refund_id = r.id
     from refund r
     where credit.id = $1 and r.payment_ref = $2 and r.status in ('requested', 'pending') and r.refunded_at is null
     returning credit.id`,
    [creditId, paymentRef],
  );
  return result.rows.length === 1;
}

/** The oldest-expiring usable credit for this coach+phone, if any. Credits
 * are tracked per phone number, not per account (SPEC.md §9.2), so a parent
 * booking two children with one phone draws from one pool. */
export async function getCreditBalance(db: DbClient, coachId: number, contactPhone: string): Promise<CreditRow | null> {
  const result = await db.query<CreditRow>(
    `select id, coach_id, contact_phone, package_id, remaining, source, expires_at
     from credit
     where coach_id = $1 and contact_phone = $2 and remaining > 0 and (expires_at is null or expires_at > now())
       and ${NOT_HELD_FOR_REFUND}
     order by expires_at asc nulls last, id asc
     limit 1`,
    [coachId, contactPhone],
  );
  return result.rows[0] ?? null;
}

/** Whether any family holds an unused, unexpired credit with this coach. */
export async function coachHasOpenCredits(db: DbClient, coachId: number): Promise<boolean> {
  const result = await db.query(
    `select 1 from credit where coach_id = $1 and remaining > 0 and (expires_at is null or expires_at > now()) and ${NOT_HELD_FOR_REFUND} limit 1`,
    [coachId],
  );
  return result.rows.length > 0;
}

/** Decrements one unit off a specific credit row. Returns false if the
 * credit is already exhausted (race with another booking on the same
 * phone), or a refund of its purchase was asked for since it was fetched.
 * Caller re-fetches the credit immediately before calling this. */
export async function decrementCredit(db: DbClient, creditId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    `update credit set remaining = remaining - 1 where id = $1 and remaining > 0 and ${NOT_HELD_FOR_REFUND} returning id`,
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

/** A token for a booking's manage link or checkout page: 128 random bits,
 * URL-safe, and short enough to leave room in a one-segment text. */
export function newBookingToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** SQL for "this booking is in the same pass as booking `param`" (that
 * booking itself included). `b` is the booking alias. */
export function inPassSql(b: string, param: string): string {
  return `(${b}.id = ${param} or (${b}.pass_id is not null and ${b}.pass_id = (select p.pass_id from booking p where p.id = ${param})))`;
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

/** People waiting for a spot in this session (or, for a second group, in
 * the full session it was opened for) who have not been offered one yet,
 * other than `exceptPhone`'s own children. They have first claim on a spot
 * that opens, so a new or lapsed hold takes only what is left after them. */
async function countKeptForWaitlist(db: DbClient, sessionId: number, exceptPhone: string): Promise<number> {
  const kept = await db.query<{ count: string }>(
    `select count(*)::text as count from waitlist w
     where w.state = 'waiting' and w.contact_phone <> $2
       and w.session_id = (select coalesce(s.overflow_of, s.id) from session s where s.id = $1)`,
    [sessionId, exceptPhone],
  );
  return Number(kept.rows[0]?.count ?? '0');
}

export interface PendingBooking {
  id: number;
  checkoutToken: string;
  manageToken: string;
  /** Every booking in the pass, the first one (`id`) included. */
  bookingIds: number[];
}

/** Locks a session's row until the transaction ends and returns its status.
 * Every write that counts a session's spots takes this lock first, so two
 * of them for one session run one after the other and each counts what the
 * other wrote. A coach's cancel, which closes the session row first, waits
 * for them too, so it sees any booking they made. */
export async function lockSession(tx: DbClient, sessionId: number): Promise<string | null> {
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
    /** More children in the same booking pass (SPEC.md §9.5). */
    moreAthleteNames?: string[];
  },
): Promise<PendingBooking | null> {
  const names = [args.athleteName, ...(args.moreAthleteNames ?? [])];
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, args.sessionId)) !== 'scheduled') return null;
    const others = await tx.query<{ count: string }>(
      `select count(*)::text as count from booking b
       where b.session_id = $1 and ${takesSpotSql('b')} and not (b.status = 'pending' and b.contact_phone = $2)`,
      [args.sessionId, args.contactPhone],
    );
    // People on the waitlist have first claim on a spot that opens; a new
    // booking takes only what is left after them.
    const kept = await countKeptForWaitlist(tx, args.sessionId, args.contactPhone);
    if (Number(others.rows[0]?.count ?? '0') + kept + names.length > args.capacity) return null;
    await tx.query(
      `update booking set hold_expires_at = now()
       where session_id = $1 and contact_phone = $2 and status = 'pending' and hold_expires_at > now()`,
      [args.sessionId, args.contactPhone],
    );
    // One checkout for the pass, through its first booking; each child
    // gets their own manage link.
    const passId = newBookingToken();
    const checkoutToken = newBookingToken();
    const bookings: Array<{ id: number; manageToken: string }> = [];
    for (const [i, name] of names.entries()) {
      const manageToken = newBookingToken();
      const result = await tx.query<{ id: number }>(
        `insert into booking (session_id, athlete_name, contact_phone, contact_email, manage_token, checkout_token,
                              hold_expires_at, phone_verified_at, status, pass_id)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int), case when $8::boolean then now() end, 'pending', $9)
         returning id`,
        [
          args.sessionId,
          name,
          args.contactPhone,
          args.contactEmail,
          manageToken,
          i === 0 ? checkoutToken : null,
          BOOKING_HOLD_MINUTES,
          args.phoneVerified === true,
          passId,
        ],
      );
      bookings.push({ id: result.rows[0].id, manageToken });
    }
    return { id: bookings[0].id, checkoutToken, manageToken: bookings[0].manageToken, bookingIds: bookings.map((b) => b.id) };
  });
}

const BOOKING_COLUMNS = `id, session_id, athlete_name, contact_phone, contact_email, payment_source, credit_id, charge_id, gross_cents,
  manage_token, checkout_token, hold_expires_at, phone_verified_at, status, pass_id`;

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

/** Keeps a pending booking's spots (one per child in its pass) for the
 * parent who is about to pay: the holds run BOOKING_HOLD_MINUTES from now,
 * so a parent who picks a way to pay near the end of their hold still has
 * time to pay. Lapsed holds are renewed only while the session still has
 * room for every child after the people waiting for a spot, who have first
 * claim on it. */
export async function renewHold(db: DbClient, booking: Pick<BookingRow, 'id' | 'session_id'>, capacity: number): Promise<HoldResult> {
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, booking.session_id)) !== 'scheduled') {
      return (await isPending(tx, booking.id)) ? 'closed' : 'not_pending';
    }
    const pass = await tx.query<{ id: number; live: boolean; contact_phone: string }>(
      `select b.id, coalesce(b.hold_expires_at > now(), false) as live, b.contact_phone from booking b
       where ${inPassSql('b', '$1')} and b.status = 'pending'`,
      [booking.id],
    );
    if (pass.rows.length === 0) return 'not_pending';
    if (!pass.rows.every((r) => r.live)) {
      const others = await tx.query<{ n: string }>(
        `select count(*)::text as n from booking o
         where o.session_id = $2 and ${takesSpotSql('o')} and not ${inPassSql('o', '$1')}`,
        [booking.id, booking.session_id],
      );
      const kept = await countKeptForWaitlist(tx, booking.session_id, pass.rows[0].contact_phone);
      if (Number(others.rows[0]?.n ?? '0') + kept + pass.rows.length > capacity) return 'full';
    }
    await tx.query(
      `update booking b set hold_expires_at = now() + make_interval(mins => $2::int)
       where ${inPassSql('b', '$1')} and b.status = 'pending'`,
      [booking.id, BOOKING_HOLD_MINUTES],
    );
    return 'held';
  });
}

async function isPending(db: DbClient, bookingId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>("select id from booking where id = $1 and status = 'pending'", [bookingId]);
  return result.rows.length === 1;
}

export type BookResult = 'booked' | 'full' | 'closed' | 'not_pending';

/** How one child's booking was paid, when the children of a pass differ:
 * each its own credit, or each its own share of a drop-in payment. */
export interface PassRowPayment {
  creditId: number | null;
  grossCents: number | null;
}

/** Flips a pending booking, with every child in its pass, to booked, under
 * the session's lock. It books while the session is still scheduled and the
 * pass still holds its spots, or, once a hold has lapsed, while the session
 * still has room for every child. A phone holds one pass per session, so a
 * newer unpaid hold by the same phone does not stand in the way: this pass
 * takes those spots and the unpaid hold ends. 'closed' when the session was
 * cancelled, 'full' when there is no room, 'not_pending' when the booking
 * was already settled. Without `rows`, the first booking gets the credit and
 * the payment, and the others the same credit and no payment.
 *
 * Before anything is paid (a credit, a free session), a lapsed hold also
 * leaves room for the people waiting for a spot, who have first claim on
 * it. A payment that has already been taken (`paid`) books whenever there
 * is room, so a parent who paid is not turned away for a spot nobody has
 * been offered yet.
 *
 * Booking a child also takes that child, under the same phone, off the
 * session's waitlist, so the next spot that opens is not offered to them.
 *
 * Each booking keeps the session's price as it is at this moment
 * (price_cents), which is what Money counts it as, whatever the price is
 * changed to later. */
export async function bookPendingBooking(
  db: DbClient,
  booking: Pick<BookingRow, 'id' | 'session_id'>,
  capacity: number,
  fields: { paymentSource: string; creditId: number | null; chargeId: string | null; grossCents: number | null },
  rows?: PassRowPayment[],
  opts: { paid?: boolean } = {},
): Promise<BookResult> {
  return inTransaction(db, async (tx) => {
    if ((await lockSession(tx, booking.session_id)) !== 'scheduled') {
      return (await isPending(tx, booking.id)) ? 'closed' : 'not_pending';
    }
    const pass = await tx.query<{ id: number; live: boolean; contact_phone: string }>(
      `select b.id, coalesce(b.hold_expires_at > now(), false) as live, b.contact_phone from booking b
       where ${inPassSql('b', '$1')} and b.status = 'pending'
       order by b.id`,
      [booking.id],
    );
    if (pass.rows.length === 0) return 'not_pending';
    const phone = pass.rows[0].contact_phone;
    if (!pass.rows.every((r) => r.live)) {
      const others = await tx.query<{ n: string }>(
        `select count(*)::text as n from booking o
         where o.session_id = $2 and ${takesSpotSql('o')} and not ${inPassSql('o', '$1')}
           and not (o.status = 'pending' and o.contact_phone = $3)`,
        [booking.id, booking.session_id, phone],
      );
      const kept = opts.paid ? 0 : await countKeptForWaitlist(tx, booking.session_id, phone);
      if (Number(others.rows[0]?.n ?? '0') + kept + pass.rows.length > capacity) return 'full';
    }
    for (const [i, row] of pass.rows.entries()) {
      const pay = rows?.[i] ?? { creditId: fields.creditId, grossCents: i === 0 ? fields.grossCents : null };
      await tx.query(
        `update booking b set status = 'booked', payment_source = $2, credit_id = $3, charge_id = $4, gross_cents = $5,
                price_cents = (select st.price_cents from session s join session_type st on st.id = s.session_type_id where s.id = b.session_id)
         where b.id = $1 and b.status = 'pending'`,
        [row.id, fields.paymentSource, pay.creditId, fields.chargeId, pay.grossCents],
      );
    }
    await tx.query(
      `update booking b set hold_expires_at = now()
       where b.session_id = $2 and b.contact_phone = $3 and b.status = 'pending' and not ${inPassSql('b', '$1')}
         and b.hold_expires_at > now()
         and (select count(*) from booking o where o.session_id = $2 and ${takesSpotSql('o')}) > $4`,
      [booking.id, booking.session_id, phone, capacity],
    );
    await tx.query(
      `update waitlist w set state = 'booked'
       where w.state = 'waiting' and w.contact_phone = $2
         and w.session_id = (select coalesce(s.overflow_of, s.id) from session s where s.id = $1)
         and lower(btrim(w.athlete_name)) in (select lower(btrim(b.athlete_name)) from booking b where ${inPassSql('b', '$3')})`,
      [booking.session_id, phone, booking.id],
    );
    return 'booked';
  });
}

/** The source of the credit a drop-in payment becomes when its session is
 * cancelled: one session with the same coach. A drop-in has no package,
 * so no expiry applies. */
export function cancelledSessionCreditSource(sessionId: number): string {
  return `cancelled-session:${sessionId}`;
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
    // Every child the purchase booked draws from it, so a cancel gives back to it.
    await tx.query(`update booking b set credit_id = $2 where ${inPassSql('b', '$1')} and b.credit_id is null`, [bookingId, creditId]);
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
    // The other children in the pass are closed the same way; the payment
    // is recorded once, on the first booking.
    await tx.query(
      `update booking b set status = 'cancelled', payment_source = $2, charge_id = $3, credit_id = $4
       where ${inPassSql('b', '$1')} and b.id <> $1 and b.status = 'pending'`,
      [bookingId, payment.paymentSource, payment.chargeId, creditId],
    );
    return creditId;
  });
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

/** Gives one session back to a credit when a booking that drew on it is
 * cancelled. A credit whose purchase was refunded gets nothing back: the
 * refund withdrew it. Returns whether the session went back. */
export async function restoreCredit(db: DbClient, creditId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    'update credit set remaining = remaining + 1 where id = $1 and withdrawn_at is null returning id',
    [creditId],
  );
  return result.rows.length === 1;
}

/** Every usable credit this phone holds with the coach, across packages
 * and packs. A credit held for a refund is not usable. */
export async function getCreditTotal(db: DbClient, coachId: number, contactPhone: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    `select coalesce(sum(remaining), 0)::text as n from credit
     where coach_id = $1 and contact_phone = $2 and remaining > 0 and (expires_at is null or expires_at > now())
       and ${NOT_HELD_FOR_REFUND}`,
    [coachId, contactPhone],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Takes one credit per child, oldest-expiring first, possibly from several
 * credits. All or none: when there are too few, any taken are put back and
 * null is returned. Each id is the credit one child's booking used. */
export async function takeCredits(db: DbClient, coachId: number, contactPhone: string, count: number): Promise<number[] | null> {
  const taken: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const credit = await getCreditBalance(db, coachId, contactPhone);
    if (!credit || !(await decrementCredit(db, credit.id))) {
      for (const id of taken) await restoreCredit(db, id);
      return null;
    }
    taken.push(credit.id);
  }
  return taken;
}

/** The bookings in one booking pass, in the order they were added; a
 * booking from before passes is a pass of one. */
export async function passBookings(db: DbClient, booking: Pick<BookingRow, 'id'>): Promise<BookingRow[]> {
  const result = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from booking where ${inPassSql('booking', '$1')} order by id`, [
    booking.id,
  ]);
  return result.rows;
}
