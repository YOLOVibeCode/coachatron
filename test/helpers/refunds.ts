import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createCoachSession } from '../../src/domain/auth.js';
import type { DbClient } from '../../src/db/client.js';
import type { FakeRelay } from '../fakes/relay.js';
import { buyerFromLocation, postStorePaid } from './store-event.js';
import { bookOnline, postCheckout } from './booking.js';

/** The coach's and the parent's side of a refund, over HTTP, for the refund
 * tests. */

export const PHONE = '+15551112222';

/** The page's text with the few entities the html helper writes undone. */
export function readable(page: string): string {
  return page.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export async function coachCookie(db: DbClient, coachId: number): Promise<string> {
  return `cx_session=${await createCoachSession(db, coachId)}`;
}

export async function getPage(base: string, path: string, cookie: string): Promise<string> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  assert.equal(res.status, 200, `${path} answers 200`);
  return readable(await res.text());
}

export async function postForm(base: string, path: string, cookie: string, fields: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(fields),
    redirect: 'manual',
  });
}

/** A parent books and pays; returns the booking's id. */
export async function payFor(
  base: string,
  db: DbClient,
  args: { handle: string; sessionId: number; paymentId: string; amountCents: number; fields?: Record<string, string>; extra?: Record<string, string>; phone?: string },
): Promise<number> {
  const b = await bookOnline(base, args.handle, args.sessionId, 'Alex', args.phone ?? '5551112222', args.extra ?? {});
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, args.handle, b.key, args.fields ?? { mode: 'dropin' });
  assert.equal(pay.status, 303);
  const userId = buyerFromLocation(pay.headers.get('location'));
  assert.equal((await postStorePaid(base, { userId, amountCents: args.amountCents, paymentId: args.paymentId })).status, 200);
  const row = await db.query<{ id: number }>('select id from booking where charge_id = $1', [args.paymentId]);
  assert.equal(row.rows.length, 1, 'the payment booked');
  return row.rows[0].id;
}

export async function bookingStatus(db: DbClient, id: number): Promise<string> {
  return (await db.query<{ status: string }>('select status from booking where id = $1', [id])).rows[0].status;
}

export async function creditLeft(db: DbClient, bookingId: number): Promise<number> {
  const r = await db.query<{ remaining: number }>('select c.remaining from credit c join booking b on b.credit_id = c.id where b.id = $1', [bookingId]);
  return r.rows[0].remaining;
}

export async function refundRow(db: DbClient, paymentRef: string) {
  const r = await db.query<{
    status: string;
    attempt: number;
    error_code: string | null;
    credits_withdrawn: number;
    credits_used: number;
    spot_released: boolean;
    parent_told: string | null;
    from_app: boolean;
  }>('select status, attempt, error_code, credits_withdrawn, credits_used, spot_released, parent_told, from_app from refund where payment_ref = $1', [
    paymentRef,
  ]);
  return r.rows[0] ?? null;
}

export function refundTexts(relay: FakeRelay) {
  return relay.sms.filter((m) => m.to === PHONE && /refunded/.test(m.body));
}

export function quiet(t: TestContext): void {
  t.mock.method(console, 'error', () => {});
}

