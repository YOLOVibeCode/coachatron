import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DbClient } from './client.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** PGlite's query() uses the extended/prepared-statement protocol, which
 * rejects multiple statements in one call ("cannot insert multiple
 * commands into a prepared statement") — so migrations must be split into
 * individual statements before being run. A naive split on every `;` is
 * not safe: a `--` line comment containing a semicolon (e.g. "joined the
 * waitlist; configurable" in 0004_overflow.sql) would otherwise cut a
 * statement in half. Strip `--` line comments first, then split on `;`.
 * This does not handle a semicolon or `--` inside a string literal — none
 * of this project's migrations need one; keep it that way rather than
 * writing a full SQL tokenizer for a one-time migration runner. */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function splitStatements(sql: string): string[] {
  return stripLineComments(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runMigrations(db: DbClient): Promise<void> {
  await db.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );

  const appliedRows = await db.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of splitStatements(sql)) {
      await db.query(stmt);
    }
    await db.query('insert into schema_migrations (name) values ($1)', [file]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import('./client.js');
  await runMigrations(getDb());
  console.log('migrations applied');
}
