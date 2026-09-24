import type { DbClient } from '../db/client.js';
import type { CoachRow, ConnectStatus } from './auth.js';

const COACH_CONNECT_COLUMNS =
  'id, handle, name, email, phone, tz, connect_recipient_key, connect_status, stripe_account_id';

export interface CoachConnectRow extends CoachRow {
  connect_status: ConnectStatus;
  stripe_account_id: string | null;
}

export function isChargesReady(coach: Pick<CoachConnectRow, 'connect_status'>): boolean {
  return coach.connect_status === 'ready';
}

export async function findCoachByRecipientKey(db: DbClient, recipientKey: string): Promise<CoachConnectRow | null> {
  const result = await db.query<CoachConnectRow>(
    `select ${COACH_CONNECT_COLUMNS} from coach where connect_recipient_key = $1 or handle = $1 limit 1`,
    [recipientKey],
  );
  return result.rows[0] ?? null;
}

export async function setConnectPending(
  db: DbClient,
  coachId: number,
  stripeAccountId: string | null,
): Promise<void> {
  await db.query(
    `update coach set connect_status = 'pending', stripe_account_id = coalesce($2, stripe_account_id) where id = $1`,
    [coachId, stripeAccountId],
  );
}

export async function setConnectReady(db: DbClient, coachId: number, stripeAccountId?: string | null): Promise<void> {
  await db.query(
    `update coach set connect_status = 'ready', stripe_account_id = coalesce($2, stripe_account_id) where id = $1`,
    [coachId, stripeAccountId ?? null],
  );
}

export async function loadCoachConnect(db: DbClient, coachId: number): Promise<CoachConnectRow | null> {
  const result = await db.query<CoachConnectRow>(
    `select ${COACH_CONNECT_COLUMNS} from coach where id = $1`,
    [coachId],
  );
  return result.rows[0] ?? null;
}
