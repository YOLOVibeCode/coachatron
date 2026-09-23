import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../src/db/migrate.js';

test('migrations create the coach table', async () => {
  const pglite = new PGlite();
  const db = { query: (sql: string, params?: unknown[]) => pglite.query(sql, params as unknown[]) };
  await runMigrations(db);
  const result = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_name = 'coach'",
  );
  assert.equal(result.rows.length, 1);
});
