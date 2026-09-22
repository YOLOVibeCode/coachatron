import crypto from 'node:crypto';
import { DbClient } from '../db/client.js';

export async function createOtp(db: DbClient, phone: string): Promise<string> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await db.query(
    'INSERT INTO otp_code (phone, code_hash, expires_at) VALUES ($1, $2, $3)',
    [phone, codeHash, expiresAt.toISOString()],
  );

  return code;
}

export async function verifyOtp(db: DbClient, phone: string, code: string): Promise<boolean> {
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');

  // Find an unexpired, unused OTP
  const result = await db.query(
    `SELECT id, consumed_at FROM otp_code 
     WHERE phone = $1 AND code_hash = $2 AND expires_at > now() 
     ORDER BY id DESC LIMIT 1`,
    [phone, codeHash],
  );

  if (result.rows.length === 0 || result.rows[0].consumed_at !== null) {
    return false;
  }

  // Mark as consumed
  await db.query(
    'UPDATE otp_code SET consumed_at = now() WHERE id = $1',
    [result.rows[0].id],
  );

  return true;
}

export async function createCoachSession(db: DbClient, coachId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await db.query(
    'INSERT INTO coach_session (token, coach_id, expires_at) VALUES ($1, $2, $3)',
    [token, coachId, expiresAt.toISOString()],
  );

  return token;
}

export async function getCoachBySessionToken(db: DbClient, token: string): Promise<number | null> {
  const result = await db.query(
    `SELECT coach_id FROM coach_session 
     WHERE token = $1 AND expires_at > now()`,
    [token],
  );

  return result.rows.length > 0 ? result.rows[0].coach_id : null;
}

export function generateHmacSignature(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
