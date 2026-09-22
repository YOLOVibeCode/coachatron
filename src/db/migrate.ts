import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DbClient } from './client.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(db: DbClient): Promise<void> {
  // Split SQL by semicolon, filter empty statements
  const createSchemaTableSql =
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())";
  await db.query(createSchemaTableSql);
  
  const getAppliedSql = 'select name from schema_migrations';
  const appliedRows = await db.query<{ name: string }>(getAppliedSql);
  const applied = new Set(appliedRows.rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Split SQL by semicolon and run each statement
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    
    for (const stmt of statements) {
      await db.query(stmt);
    }
    
    await db.query("insert into schema_migrations (name) values ($1)", [file]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import('./client.js');
  await runMigrations(getDb());
  console.log('migrations applied');
}
