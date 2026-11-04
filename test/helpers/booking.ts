import type { DbClient } from '../../src/db/client.js';

/** The parent's side of booking, over HTTP, for tests that follow a booking
 * from the form through checkout. */

const json = { 'content-type': 'application/json' };

export interface BookResult {
  status: number;
  /** The checkout key from the redirect, or null when the booking was refused. */
  key: string | null;
  location: string | null;
}

export async function bookOnline(
  base: string,
  handle: string,
  sessionId: number,
  athlete: string,
  phone: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<BookResult> {
  const res = await fetch(`${base}/c/${handle}/sessions/${sessionId}/book`, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify({ athlete_name: athlete, contact_phone: phone, sms_consent: '1', ...extra }),
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  const match = location ? /\/checkout\/([^/?#]+)/.exec(location) : null;
  return { status: res.status, key: match ? match[1] : null, location };
}

export async function postCheckout(
  base: string,
  handle: string,
  key: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/c/${handle}/checkout/${key}`, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(fields),
    redirect: 'manual',
  });
}

export async function countSold(db: DbClient, sessionId: number): Promise<number> {
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from booking where session_id = $1 and status in ('booked', 'attended', 'noshow')",
    [sessionId],
  );
  return Number(r.rows[0].n);
}

export async function latestBooking(db: DbClient): Promise<{ id: number; status: string; manage_token: string; contact_phone: string }> {
  const r = await db.query<{ id: number; status: string; manage_token: string; contact_phone: string }>(
    'select id, status, manage_token, contact_phone from booking order by id desc limit 1',
  );
  return r.rows[0];
}

/** Lets a pending booking's hold run out without waiting for it. */
export async function expireHolds(db: DbClient, sessionId: number): Promise<void> {
  await db.query("update booking set hold_expires_at = now() - interval '1 minute' where session_id = $1 and status = 'pending'", [
    sessionId,
  ]);
}
