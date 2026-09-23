import type { DbClient } from '../db/client.js';
import { ASSISTANT_CONFIRM_TTL_MS } from '../config.js';
import type { ClassifiedIntent } from '../llm/schema.js';

export interface PendingRow {
  id: number;
  coachId: number;
  intent: string;
  payload: ClassifiedIntent;
  confirmText: string;
  expiresAt: Date;
  reaskedAt: Date | null;
}

export interface LastReply {
  body: string;
  pendingId: number | null;
}

function parsePayload(raw: string): ClassifiedIntent {
  return JSON.parse(raw) as ClassifiedIntent;
}

export async function getLivePending(db: DbClient, coachId: number, now: Date): Promise<PendingRow | null> {
  const result = await db.query<{
    id: number;
    coach_id: number;
    intent: string;
    payload: string;
    confirm_text: string;
    expires_at: string;
    reasked_at: string | null;
  }>(
    `select id, coach_id, intent, payload, confirm_text, expires_at, reasked_at
     from assistant_pending
     where coach_id = $1 and consumed_at is null and expires_at > $2
     order by id desc
     limit 1`,
    [coachId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    coachId: row.coach_id,
    intent: row.intent,
    payload: parsePayload(row.payload),
    confirmText: row.confirm_text,
    expiresAt: new Date(row.expires_at),
    reaskedAt: row.reasked_at ? new Date(row.reasked_at) : null,
  };
}

export async function getPendingById(
  db: DbClient,
  coachId: number,
  pendingId: number,
  now: Date,
): Promise<PendingRow | null> {
  const result = await db.query<{
    id: number;
    coach_id: number;
    intent: string;
    payload: string;
    confirm_text: string;
    expires_at: string;
    reasked_at: string | null;
  }>(
    `select id, coach_id, intent, payload, confirm_text, expires_at, reasked_at
     from assistant_pending
     where id = $1 and coach_id = $2 and consumed_at is null and expires_at > $3`,
    [pendingId, coachId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    coachId: row.coach_id,
    intent: row.intent,
    payload: parsePayload(row.payload),
    confirmText: row.confirm_text,
    expiresAt: new Date(row.expires_at),
    reaskedAt: row.reasked_at ? new Date(row.reasked_at) : null,
  };
}

/** One live question per coach: a new confirm retires any older unused one. */
export async function createPending(
  db: DbClient,
  coachId: number,
  classified: ClassifiedIntent,
  confirmText: string,
  now: Date,
): Promise<PendingRow> {
  await expireLivePendingForCoach(db, coachId, now);
  const expiresAt = new Date(now.getTime() + ASSISTANT_CONFIRM_TTL_MS);
  const result = await db.query<{ id: number }>(
    `insert into assistant_pending (coach_id, intent, payload, confirm_text, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [coachId, classified.intent, JSON.stringify(classified), confirmText, expiresAt.toISOString()],
  );
  const id = result.rows[0].id;
  return {
    id,
    coachId,
    intent: classified.intent,
    payload: classified,
    confirmText,
    expiresAt,
    reaskedAt: null,
  };
}

export async function consumePending(db: DbClient, pendingId: number, now: Date): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    `update assistant_pending
     set consumed_at = $2
     where id = $1 and consumed_at is null and expires_at > $2
     returning id`,
    [pendingId, now.toISOString()],
  );
  return result.rows.length > 0;
}

export async function markReasked(db: DbClient, pendingId: number, now: Date): Promise<void> {
  await db.query('update assistant_pending set reasked_at = $2 where id = $1 and reasked_at is null', [
    pendingId,
    now.toISOString(),
  ]);
}

export async function expireLivePendingForCoach(db: DbClient, coachId: number, now: Date = new Date()): Promise<void> {
  await db.query(
    `update assistant_pending
     set consumed_at = $2
     where coach_id = $1 and consumed_at is null and expires_at > $2`,
    [coachId, now.toISOString()],
  );
  await db.query('update assistant_last_reply set pending_id = null where coach_id = $1', [coachId]);
}

export async function setLastReply(
  db: DbClient,
  coachId: number,
  body: string,
  pendingId: number | null,
  now: Date,
): Promise<void> {
  await db.query(
    `insert into assistant_last_reply (coach_id, body, pending_id, updated_at)
     values ($1, $2, $3, $4)
     on conflict (coach_id) do update set body = $2, pending_id = $3, updated_at = $4`,
    [coachId, body, pendingId, now.toISOString()],
  );
}

export async function getLastReply(db: DbClient, coachId: number): Promise<LastReply | null> {
  const result = await db.query<{ body: string; pending_id: number | null }>(
    'select body, pending_id from assistant_last_reply where coach_id = $1',
    [coachId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { body: row.body, pendingId: row.pending_id };
}

export async function logAssistant(
  db: DbClient,
  entry: {
    coachId?: number | null;
    phone?: string | null;
    channel: string;
    rawMessage: string;
    layer: string;
    intent?: string | null;
    payload?: unknown;
    outcome?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into assistant_log (coach_id, phone, channel, raw_message, layer, intent, payload, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.coachId ?? null,
      entry.phone ?? null,
      entry.channel,
      entry.rawMessage,
      entry.layer,
      entry.intent ?? null,
      entry.payload === undefined ? null : JSON.stringify(entry.payload),
      entry.outcome ?? null,
    ],
  );
}

export async function takeDailyReplySlot(db: DbClient, phone: string, now: Date): Promise<boolean> {
  const dayUtc = now.toISOString().slice(0, 10);
  const existing = await db.query<{ phone: string }>(
    'select phone from inbound_auto_reply where phone = $1 and day_utc = $2',
    [phone, dayUtc],
  );
  if (existing.rows.length > 0) return false;
  await db.query('insert into inbound_auto_reply (phone, day_utc) values ($1, $2)', [phone, dayUtc]);
  return true;
}
