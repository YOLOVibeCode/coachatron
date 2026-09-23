import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DATABASE_URL } from '../config.js';

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

function wrapPool(pool: Pool): DbClient {
  // pg's query returns QueryResult which has rows property we need
  return { query: pool.query.bind(pool) as <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
}

function wrapPglite(pglite: PGlite): DbClient {
  // pglite's query returns QueryResult which we adapt
  return { query: pglite.query.bind(pglite) as <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
}
