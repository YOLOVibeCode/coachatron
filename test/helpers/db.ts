import { PGlite } from '@electric-sql/pglite';
import { setDb, type DbClient } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Gives a test a fresh, migrated, in-memory database and wires it in via
 * setDb() so route handlers (which call getDb()) see it. Call once per test
 * file/test — never share a database across tests, so they can run in any
 * order without polluting each other. */
export async function freshDb(): Promise<DbClient> {
  const pglite = new PGlite();
  const db: DbClient = { query: (sql, params) => pglite.query(sql, params as unknown[]) };
  await runMigrations(db);
  setDb(db);
  return db;
}
