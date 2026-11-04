import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DATABASE_URL, NODE_ENV } from '../config.js';

type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs fn on one connection inside BEGIN/COMMIT, rolling back if it
   * throws. Inside fn, use only the client it is given. */
  transaction?<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}

let current: DbClient | undefined;
let closeCurrent: (() => Promise<void>) | undefined;

/** The database for this process: Postgres at DATABASE_URL, or, outside
 * production, an in-memory PGlite so `npm run dev` needs nothing installed.
 * Production with no DATABASE_URL refuses to start rather than keep its
 * data in memory until the next restart. */
export function getDb(): DbClient {
  if (current) return current;
  if (DATABASE_URL) {
    const pool = createPool(DATABASE_URL);
    current = wrapPool(pool);
    closeCurrent = () => pool.end();
  } else if (NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is not set. Production does not start on an in-memory database.');
  } else {
    const pglite = new PGlite();
    current = wrapPglite(pglite);
    closeCurrent = () => pglite.close();
  }
  return current;
}

/** A pg Pool that survives losing an idle connection. Postgres restarting,
 * or the network dropping an idle client, is reported as an "error" event on
 * the pool; with no listener Node treats that as an uncaught exception and
 * the process exits. The pool has already dropped that client and opens a
 * new one for the next query, so it is logged and nothing else. */
export function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    console.error(`db: an idle connection was lost; the pool reconnects on the next query: ${err.message}`);
  });
  return pool;
}

/** Closes the database getDb() opened (on shutdown). A client set with
 * setDb belongs to whoever set it and is only forgotten. */
export async function closeDb(): Promise<void> {
  const close = closeCurrent;
  current = undefined;
  closeCurrent = undefined;
  if (close) await close();
}

// Tests call this with a fresh PGlite-backed client per test file so tests
// never share state.
export function setDb(client: DbClient): void {
  current = client;
  closeCurrent = undefined;
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
      // A connection lost while checked out is reported on the client, not
      // the pool; it is not reused.
      const onError = (err: Error) => {
        broken = true;
        console.error(`db: a connection was lost during a transaction: ${err.message}`);
      };
      conn.on('error', onError);
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
        conn.off('error', onError);
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
