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

/** Lowercased and trimmed, or null when it does not look like an address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/** Where a sign-in code goes. Text codes reach only +1 numbers, so email is
 * how a coach anywhere else gets in (SPEC.md §7.1). */
export type Contact = { kind: 'email'; email: string } | { kind: 'phone'; phone: string };

/** One box takes an email or a mobile number. */
export function parseContact(raw: string): Contact | null {
  const value = raw.trim();
  if (value.includes('@')) {
    const email = normalizeEmail(value);
    return email ? { kind: 'email', email } : null;
  }
  const phone = normalizePhone(value);
  return phone ? { kind: 'phone', phone } : null;
}

/** The value a Contact is stored and shown as. */
export function contactValue(contact: Contact): string {
  return contact.kind === 'email' ? contact.email : contact.phone;
}

function asContact(target: string | Contact): Contact {
  return typeof target === 'string' ? { kind: 'phone', phone: target } : target;
}

export async function createOtp(db: DbClient, target: string | Contact): Promise<string> {
  const contact = asContact(target);
  const code = crypto.randomInt(100000, 1000000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await db.query('insert into otp_code (phone, email, code_hash, expires_at) values ($1, $2, $3, $4)', [
    contact.kind === 'phone' ? contact.phone : null,
    contact.kind === 'email' ? contact.email : null,
    codeHash,
    expiresAt.toISOString(),
  ]);

  return code;
}

/** Read-only check: does not consume the code. Callers must call consumeOtp
 * once the whole submission (including any first-time profile fields) is
 * known to be valid, so a profile validation failure does not burn a code. */
export async function checkOtp(db: DbClient, target: string | Contact, code: string): Promise<number | null> {
  const contact = asContact(target);
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const column = contact.kind === 'email' ? 'email' : 'phone';
  const result = await db.query<{ id: number }>(
    `select id from otp_code
     where ${column} = $1 and code_hash = $2 and expires_at > now() and consumed_at is null
     order by id desc limit 1`,
    [contactValue(contact), codeHash],
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
  /** Null for a coach who joined by email and has not added a mobile. */
  phone: string | null;
  tz: string;
  connect_recipient_key: string | null;
}

export function getConnectRecipientKey(coach: Pick<CoachRow, 'handle' | 'connect_recipient_key'>): string {
  return coach.connect_recipient_key ?? coach.handle;
}

export async function findCoachByPhone(db: DbClient, phone: string): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    'select id, handle, name, email, phone, tz, connect_recipient_key from coach where phone = $1',
    [phone],
  );
  return result.rows[0] ?? null;
}

export async function findCoachByEmail(db: DbClient, email: string): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    `select id, handle, name, email, phone, tz, connect_recipient_key from coach
     where email <> '' and lower(email) = lower($1)`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findCoachByContact(db: DbClient, contact: Contact): Promise<CoachRow | null> {
  return contact.kind === 'email' ? findCoachByEmail(db, contact.email) : findCoachByPhone(db, contact.phone);
}

/** Adds a verified mobile to a coach. 'taken' when another coach has it. */
export async function setCoachPhone(db: DbClient, coachId: number, phone: string): Promise<'ok' | 'taken'> {
  const other = await findCoachByPhone(db, phone);
  if (other && other.id !== coachId) return 'taken';
  await db.query('update coach set phone = $1 where id = $2', [phone, coachId]);
  return 'ok';
}

export async function findCoachByHandle(db: DbClient, handle: string): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    'select id, handle, name, email, phone, tz, connect_recipient_key from coach where handle = $1',
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
  /** At least one of phone and email identifies the coach. */
  phone: string | null;
  name: string;
  email: string;
  tz: string;
}

export async function createCoach(db: DbClient, input: NewCoachInput): Promise<CoachRow> {
  const email = normalizeEmail(input.email) ?? '';
  if (!input.phone && !email) throw new Error('a coach needs a phone or an email');
  const handle = await reserveHandle(db, input.name);
  const result = await db.query<{ id: number }>(
    `insert into coach (handle, name, email, phone, tz, fee_bps, connect_recipient_key)
     values ($1, $2, $3, $4, $5, 500, $1)
     returning id`,
    [handle, input.name, email, input.phone, input.tz],
  );
  return {
    id: result.rows[0].id,
    handle,
    name: input.name,
    email,
    phone: input.phone,
    tz: input.tz,
    connect_recipient_key: handle,
  };
}

export async function findCoachById(db: DbClient, id: number): Promise<CoachRow | null> {
  const result = await db.query<CoachRow>(
    'select id, handle, name, email, phone, tz, connect_recipient_key from coach where id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}
