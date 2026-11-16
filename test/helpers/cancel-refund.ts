import assert from 'node:assert/strict';
import type { DbClient } from '../../src/db/client.js';
import { formatLocal } from '../../src/lib/time.js';
import type { FakeRelay } from '../fakes/relay.js';
import { readable } from './refunds.js';

/** The parent's side of a cancel under the coach-set refund policy
 * (SPEC.md §9.5), for its tests. Nothing here reads the clock's day or
 * hour: sessions are placed a number of hours from now. */

/** The coach's choice for a parent's cancel in time, as the Pricing form saves it. */
export async function coachChooses(db: DbClient, coachId: number, gives: 'credit' | 'refund'): Promise<void> {
  await db.query('update coach set cancel_gives = $2 where id = $1', [coachId, gives]);
}

/** Moves a session so it starts this many hours from now. */
export async function startsInHours(db: DbClient, sessionId: number, hours: number): Promise<void> {
  await db.query('update session set starts_at_utc = now() + make_interval(hours => $2::int) where id = $1', [sessionId, hours]);
}

/** Another session of the same type, this many hours from now. */
export async function sessionInHours(db: DbClient, sessionTypeId: number, hours: number): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, now() + make_interval(hours => $2::int), 'America/Chicago', 'scheduled') returning id`,
    [sessionTypeId, hours],
  );
  return r.rows[0].id;
}

export async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

/** The parent taps "Cancel this booking" on the manage page. */
export async function cancelBooking(base: string, token: string): Promise<number> {
  return (await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' })).status;
}

export async function managePage(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/booking/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'the manage page is never cached');
  return readable(await res.text());
}

/** The choice a booking was made under. */
export async function madeUnder(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ cancel_gives: string }>('select cancel_gives from booking where id = $1', [bookingId])).rows[0].cancel_gives;
}

export interface CreditOf {
  remaining: number;
  held: boolean;
  withdrawn: boolean;
}

/** The credit a booking holds (the one its cancel became), or null. */
export async function creditOf(db: DbClient, bookingId: number): Promise<CreditOf | null> {
  const r = await db.query<CreditOf>(
    `select c.remaining, c.refund_id is not null as held, c.withdrawn_at is not null as withdrawn
     from credit c join booking b on b.credit_id = c.id where b.id = $1`,
    [bookingId],
  );
  return r.rows[0] ?? null;
}

/** The refund row of a payment, with who started it. */
export async function refundOf(db: DbClient, paymentRef: string) {
  const r = await db.query<{
    status: string;
    attempt: number;
    error_code: string | null;
    amount_cents: number | null;
    athlete_name: string | null;
    credits_withdrawn: number;
    spot_released: boolean;
    parent_told: string | null;
    cancel_booking_id: number | null;
  }>(
    `select status, attempt, error_code, amount_cents, athlete_name, credits_withdrawn, spot_released, parent_told, cancel_booking_id
     from refund where payment_ref = $1`,
    [paymentRef],
  );
  return r.rows[0] ?? null;
}

/** "Tue, Nov 17, 6:00 PM": the cut-off the pages state for a session, by the coach's window. */
export async function cancelBy(db: DbClient, sessionId: number, windowHours = 24): Promise<string> {
  const r = await db.query<{ starts_at_utc: string; tz: string }>('select starts_at_utc, tz from session where id = $1', [sessionId]);
  const start = new Date(r.rows[0].starts_at_utc).getTime();
  return formatLocal(new Date(start - windowHours * 60 * 60 * 1000).toISOString(), r.rows[0].tz);
}

/** Refund emails the fake relay took for an address. */
export function refundEmails(relay: FakeRelay, to: string) {
  return relay.emails.filter((e) => e.to === to && /^Refund from/.test(e.subject));
}
