import type { DbClient } from '../db/client.js';
import type { CoachRow } from './auth.js';
import { zonedParts, zonedTimeToUtc } from './scheduling.js';
import { ASSISTANT_MODEL_DAILY_CAP, ASSISTANT_MODEL_MONTHLY_CAP } from '../config.js';

async function modelCallCount(db: DbClient, coachId: number, sinceIso: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    'select count(*)::text as n from assistant_model_call where coach_id = $1 and called_at >= $2',
    [coachId, sinceIso],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Claims one model call against the coach's day and month caps (SPEC.md
 * §10). Every caller of the model shares this budget. Returns false, and
 * records nothing, once a cap is reached. */
export async function reserveModelCall(db: DbClient, coach: CoachRow, now: Date): Promise<boolean> {
  const local = zonedParts(now, coach.tz);
  const dayStart = zonedTimeToUtc(local.year, local.month, local.day, 0, 0, coach.tz);
  const monthStart = zonedTimeToUtc(local.year, local.month, 1, 0, 0, coach.tz);
  const [dayCount, monthCount] = await Promise.all([
    modelCallCount(db, coach.id, dayStart.toISOString()),
    modelCallCount(db, coach.id, monthStart.toISOString()),
  ]);
  if (dayCount >= ASSISTANT_MODEL_DAILY_CAP || monthCount >= ASSISTANT_MODEL_MONTHLY_CAP) return false;
  await db.query('insert into assistant_model_call (coach_id, called_at) values ($1, $2)', [coach.id, now.toISOString()]);
  return true;
}
