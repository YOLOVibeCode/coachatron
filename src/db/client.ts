import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DATABASE_URL } from '../config.js';

type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs fn on one connection inside BEGIN/COMMIT, rolling back if it
   * throws. Inside fn, use only the client it is given. */
  transaction?<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}

let current: DbClient | undefined;

export function getDb(): DbClient {
  if (current) return current;
  current = DATABASE_URL
    ? wrapPool(new Pool({ connectionString: DATABASE_URL }))
    : wrapPglite(new PGlite());
  return current;
}

// Tests call this with a fresh PGlite-backed client per test file so tests
// never share state.
export function setDb(client: DbClient): void {
  current = client;
}

/** Runs fn in a transaction when the client has them. A bare client that
 * only has query (a one-off test client) runs fn on itself. */
export async function inTransaction<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return db.transaction ? db.transaction(fn) : fn(db);
}

function wrapPool(pool: Pool): DbClient {
  // pg's query returns QueryResult which has rows property we need
  return {
    query: pool.query.bind(pool) as Query,
    async transaction(fn) {
      const conn = await pool.connect();
      let broken = false;
      try {
        await conn.query('begin');
        const result = await fn({ query: conn.query.bind(conn) as Query });
        await conn.query('commit');
        return result;
      } catch (err) {
        try {
          await conn.query('rollback');
        } catch {
          broken = true;
        }
        throw err;
      } finally {
        // A connection that could not roll back is closed, not reused.
        conn.release(broken);
      }
    },
  };
}

/** PGlite runs one thing at a time, and a query from outside waits for an
 * open transaction to end. */
export function wrapPglite(pglite: PGlite): DbClient {
  return {
    query: (sql, params) => pglite.query(sql, params as unknown[]),
    transaction: (fn) => pglite.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params as unknown[]) })),
  };
}
