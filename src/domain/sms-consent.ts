import type { DbClient } from '../db/client.js';
import { SMS_CONSENT_TEXT_VERSION, SMS_PURPOSE } from '../config.js';
import { upsertOptOut, isOptedOut } from './cascade.js';

export { isOptedOut };

export async function hasActiveConsent(db: DbClient, phone: string, purpose: string = SMS_PURPOSE): Promise<boolean> {
  if (await isOptedOut(db, phone)) return false;
  const result = await db.query<{ id: number }>(
    `select id from sms_consent
     where phone = $1 and purpose = $2 and revoked_at is null`,
    [phone, purpose],
  );
  return result.rows.length > 0;
}

export async function recordConsent(
  db: DbClient,
  phone: string,
  source: string,
  meta: { ip?: string | null; userAgent?: string | null; purpose?: string },
): Promise<void> {
  const purpose = meta.purpose ?? SMS_PURPOSE;
  await db.query(
    `insert into sms_consent (phone, purpose, consent_text_version, source, ip, user_agent, consented_at, revoked_at)
     values ($1, $2, $3, $4, $5, $6, now(), null)
     on conflict (phone, purpose) do update set
       consent_text_version = excluded.consent_text_version,
       source = excluded.source,
       ip = excluded.ip,
       user_agent = excluded.user_agent,
       consented_at = now(),
       revoked_at = null`,
    [phone, purpose, SMS_CONSENT_TEXT_VERSION, source, meta.ip ?? null, meta.userAgent ?? null],
  );
  await db.query('delete from opt_out where phone = $1', [phone]);
}

export async function revokeConsent(db: DbClient, phone: string, purpose: string = SMS_PURPOSE): Promise<void> {
  await upsertOptOut(db, phone);
  await db.query(
    `update sms_consent set revoked_at = now() where phone = $1 and purpose = $2 and revoked_at is null`,
    [phone, purpose],
  );
}

export async function clearRevocation(db: DbClient, phone: string, purpose: string = SMS_PURPOSE): Promise<void> {
  await db.query('delete from opt_out where phone = $1', [phone]);
  await db.query(
    `update sms_consent set revoked_at = null where phone = $1 and purpose = $2`,
    [phone, purpose],
  );
}

export async function queuePendingConsent(
  db: DbClient,
  phone: string,
  coachId: number,
  addedForLabel: string,
  purpose: string = SMS_PURPOSE,
): Promise<void> {
  await db.query(
    `insert into sms_consent_pending (phone, added_by_coach_id, added_for_label, purpose, sent_at)
     values ($1, $2, $3, $4, now())
     on conflict (phone) do update set
       added_by_coach_id = excluded.added_by_coach_id,
       added_for_label = excluded.added_for_label,
       purpose = excluded.purpose,
       sent_at = now()`,
    [phone, coachId, addedForLabel, purpose],
  );
}

export async function hasPendingConsent(db: DbClient, phone: string): Promise<boolean> {
  const result = await db.query<{ phone: string }>('select phone from sms_consent_pending where phone = $1', [phone]);
  return result.rows.length > 0;
}

export async function confirmConsentFromReply(db: DbClient, phone: string): Promise<boolean> {
  const pending = await db.query<{ purpose: string }>('select purpose from sms_consent_pending where phone = $1', [phone]);
  if (pending.rows.length === 0) return false;
  const purpose = pending.rows[0].purpose;
  await recordConsent(db, phone, 'reply-yes', { purpose });
  await db.query('delete from sms_consent_pending where phone = $1', [phone]);
  return true;
}

/** Test helper and seeds: grant consent without a form POST. */
export async function grantSmsConsent(db: DbClient, phone: string, source = 'test'): Promise<void> {
  await recordConsent(db, phone, source, {});
}
