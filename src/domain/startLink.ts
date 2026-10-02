import { createHash, randomBytes } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { clipStartText } from '../lib/startCookie.js';

const START_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export interface StartLinkRow {
  phone: string;
  text: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createStartLink(
  db: DbClient,
  phone: string,
  text: string,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + START_LINK_TTL_MS);
  await db.query('insert into start_link (token_hash, phone, text, expires_at) values ($1, $2, $3, $4)', [
    tokenHash(token),
    phone,
    clipStartText(text),
    expiresAt.toISOString(),
  ]);
  return token;
}

export async function getOpenStartLink(
  db: DbClient,
  token: string,
  now: Date = new Date(),
): Promise<StartLinkRow | null> {
  const result = await db.query<{ phone: string; text: string; used_at: string | null; expires_at: string }>(
    'select phone, text, used_at, expires_at from start_link where token_hash = $1',
    [tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) <= now) return null;
  return { phone: row.phone, text: row.text };
}

export async function consumeStartLink(
  db: DbClient,
  token: string,
  now: Date = new Date(),
): Promise<StartLinkRow | null> {
  const result = await db.query<StartLinkRow>(
    `update start_link set used_at = $2
     where token_hash = $1 and used_at is null and expires_at > $2
     returning phone, text`,
    [tokenHash(token), now.toISOString()],
  );
  return result.rows[0] ?? null;
}

export async function phoneHasBooking(db: DbClient, phone: string): Promise<boolean> {
  const result = await db.query('select 1 from booking where contact_phone = $1 limit 1', [phone]);
  return result.rows.length > 0;
}
