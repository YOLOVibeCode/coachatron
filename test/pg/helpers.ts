import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, setDb, wrapPool, type DbClient } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Real Postgres for the race tests. PGlite runs one transaction at a time,
 * so two transactions waiting on each other's row locks only happen here.
 * The suite runs when TEST_DATABASE_URL names a Postgres it may create
 * databases on (CI's "Postgres" job: a postgres:16 service container), and
 * is skipped otherwise, so `npm test` needs no database server. */

export const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL ?? '').trim();

/** For `test(name, { skip }, fn)`: false when the suite can run. */
export const skipWithoutPostgres: string | false = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

export interface RaceDb {
  db: DbClient;
  /** Ends the pool and drops the database. */
  close: () => Promise<void>;
}

/** A database of its own on TEST_DATABASE_URL's server, migrated and wired
 * in with setDb, so routes and the send path see it too. */
export async function raceDb(): Promise<RaceDb> {
  const name = `coachatron_race_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  const db = wrapPool(pool);
  await runMigrations(db);
  setDb(db);
  return {
    db,
    close: async () => {
      await pool.end();
      const drop = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await drop.connect();
      try {
        await drop.query(`drop database if exists ${name} with (force)`);
      } finally {
        await drop.end();
      }
    },
  };
}

export interface Paused {
  /** The client to hand the first transaction. */
  db: DbClient;
  /** Settles once that transaction has run the statement and stopped. */
  reached: Promise<void>;
  /** Lets it go on. */
  release: () => void;
}

/** Wraps `db` so the first statement inside a transaction that `match`
 * picks runs and then waits, holding whatever locks it took, until
 * release() is called. Statements outside transactions are not paused. */
export function pauseAfter(db: DbClient, match: (sql: string) => boolean): Paused {
  let reach: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let done = false;
  return {
    reached,
    release,
    db: {
      query: (sql, params) => db.query(sql, params),
      transaction: (fn) =>
        db.transaction!((tx) =>
          fn({
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await tx.query<T>(sql, params);
              if (!done && match(sql)) {
                done = true;
                reach();
                await released;
              }
              return result;
            },
          }),
        ),
    },
  };
}

/** Waits until a statement on this database is waiting for a lock another
 * transaction holds, or until `other` settles (it did not have to wait).
 * Throws after `ms` if neither happens. */
export async function untilWaitingOrDone(db: DbClient, other: Promise<unknown>, ms = 10_000): Promise<'waiting' | 'done'> {
  let settled = false;
  other.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (settled) return 'done';
    const r = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if ((r.rows[0]?.n ?? 0) > 0) return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`nothing waited on a lock or finished within ${ms} ms`);
}

/** A promise's outcome as data, so a test can await two racers together. */
export function settle<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
