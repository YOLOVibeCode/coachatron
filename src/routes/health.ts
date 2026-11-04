import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { appEnv } from '../config.js';

export const healthRouter = Router();

/** How long /health waits for the database before it answers 503. Short,
 * so a stuck database fails the check instead of holding it open. */
export const HEALTH_DB_TIMEOUT_MS = 2000;

export function healthCommit(): string {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT ??
    'unknown'
  );
}

export function healthEnv(): string {
  return appEnv();
}

/** True when the database answers a trivial query within the timeout. Any
 * error, or no answer in time, is false; the reason is logged, never sent. */
export async function databaseAnswers(db: () => DbClient, timeoutMs: number = HEALTH_DB_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  const asked = (async () => {
    await db().query('select 1');
    return true as const;
  })().catch((err: unknown) => {
    console.error(`health: the database check failed: ${err instanceof Error ? err.message : String(err)}`);
    return false as const;
  });
  try {
    return await Promise.race([asked, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The version fields the ops jobs read, and whether the database answers.
 * 503 when it does not, with no detail beyond that. */
healthRouter.get('/health', async (_req, res) => {
  const db = await databaseAnswers(getDb);
  res.status(db ? 200 : 503).json({
    ok: db,
    service: 'coachatron',
    commit: healthCommit(),
    env: healthEnv(),
    utc: new Date().toISOString(),
    db: db ? 'ok' : 'down',
  });
});
