import crypto from 'node:crypto';
import type { DbClient } from '../db/client.js';

const OTP_TTL_MINUTES = 10;
const SESSION_TTL_DAYS = 30;

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export async function createOtp(db: DbClient, phone: string): Promise<string> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await db.query('insert into otp_code (phone, code_hash, expires_at) values ($1, $2, $3)', [
    phone,
    codeHash,
    expiresAt.toISOString(),
  ]);

  return code;
}

/** Read-only check: does not consume the code. Callers must call consumeOtp
 * once the whole submission (including any first-time profile fields) is
 * known to be valid, so a profile validation failure does not burn a code. */
export async function checkOtp(db: DbClient, phone: string, code: string): Promise<number | null> {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const result = await db.query<{ id: number }>(
    `select id from otp_code
     where phone = $1 and code_hash = $2 and expires_at > now() and consumed_at is null
     order by id desc limit 1`,
    [phone, codeHash],
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

export async function consumeOtp(db: DbClient, otpId: number): Promise<void> {
  await db.query('update otp_code set consumed_at = now() where id = $1', [otpId]);
}

export async function createCoachSession(db: DbClient, coachId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.query('insert into coach_session (token, coach_id, expires_at) values ($1, $2, $3)', [
    token,
    coachId,
    expiresAt.toISOString(),
  ]);

  return token;
}

export async function getCoachBySessionToken(db: DbClient, token: string): Promise<number | null> {
  const result = await db.query<{ coach_id: number }>(
    'select coach_id from coach_session where token = $1 and expires_at > now()',
    [token],
  );
  return result.rows.length > 0 ? result.rows[0].coach_id : null;
}

export interface CoachRow {
  id: number;
  handle: string;
  name: string;
  email: string;
  phone: string;
  tz: string;
}

export async function findCoachByPhone(db: DbClient, phone: string): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    'select id, handle, name, email, phone, tz from coach where phone = $1',
    [phone],
  );
  return result.rows[0] ?? null;
}

export async function findCoachByHandle(db: DbClient, handle: string): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    'select id, handle, name, email, phone, tz from coach where handle = $1',
    [handle],
  );
  return result.rows[0] ?? null;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return base.length > 0 ? base : 'coach';
}

/** Finds a free handle by appending -2, -3, ... to the slugified base. */
export async function reserveHandle(db: DbClient, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  // Bounded loop: a coach roster will never have hundreds of name collisions.
  while (await findCoachByHandle(db, candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export interface NewCoachInput {
  phone: string;
  name: string;
  email: string;
  tz: string;
}

export async function createCoach(db: DbClient, input: NewCoachInput): Promise<CoachRow> {
  const handle = await reserveHandle(db, input.name);
  const result = await db.query<{ id: number }>(
    `insert into coach (handle, name, email, phone, tz, fee_bps)
     values ($1, $2, $3, $4, $5, 500)
     returning id`,
    [handle, input.name, input.email, input.phone, input.tz],
  );
  return { id: result.rows[0].id, handle, name: input.name, email: input.email, phone: input.phone, tz: input.tz };
}
