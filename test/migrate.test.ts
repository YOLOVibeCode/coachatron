import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../src/db/migrate.js';
import { freshDb } from './helpers/db.js';
import { seedCoachWithSession } from './helpers/fixtures.js';

test('migrations create the coach table', async () => {
  const pglite = new PGlite();
  const db = { query: (sql: string, params?: unknown[]) => pglite.query(sql, params as unknown[]) };
  await runMigrations(db);
  const result = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_name = 'coach'",
  );
  assert.equal(result.rows.length, 1);
});

test('running the overflow-choice migration again closes only asks from before it, not one the coach answered since', async () => {
  const db = await freshDb();
  const now = await seedCoachWithSession(db, { capacity: 2 });
  const old = await seedCoachWithSession(db, { capacity: 2 });
  const answered = await db.query<{ id: number }>(
    "insert into overflow_ask (session_id, kind, resolved_at) values ($1, 'second_group', now()) returning id",
    [now.sessionId],
  );
  // As an ask answered before the change was left: no kind, no offer out.
  const before = await db.query<{ id: number }>('insert into overflow_ask (session_id, resolved_at) values ($1, now()) returning id', [
    old.sessionId,
  ]);
  await db.query("delete from schema_migrations where name = '0021_overflow_choice.sql'");
  await runMigrations(db);
  const read = async (id: number) =>
    (await db.query<{ closed_at: string | null; outcome: string | null }>('select closed_at, outcome from overflow_ask where id = $1', [id]))
      .rows[0];
  assert.deepEqual(await read(answered.rows[0].id), { closed_at: null, outcome: null }, 'the ask answered since stays open');
  const closed = await read(before.rows[0].id);
  assert.notEqual(closed.closed_at, null, 'the ask from before the change is over');
  assert.equal(closed.outcome, 'ended');
});

test('every migration from 0013 on has a number of its own, and SPEC.md §11.1 names a range that covers the last one', () => {
  // 0006 was used twice early on; both files have run everywhere under
  // those names (the runner keys on the whole file name), so they stay.
  const numbers = readdirSync(new URL('../src/db/migrations/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => f.slice(0, 4))
    .filter((n) => n >= '0013');
  assert.deepEqual(
    numbers.filter((n, i) => numbers.indexOf(n) !== i),
    [],
    'a number two migrations share',
  );
  // The range may run ahead of the files: Slice 2's features were built side
  // by side, each with a number reserved for it, and merged one at a time.
  const spec = readFileSync(new URL('../SPEC.md', import.meta.url), 'utf8');
  const range = /\(migrations 0013–(\d{4})\)/.exec(spec);
  assert.ok(range, 'SPEC.md §11.1 names its migration range');
  assert.ok(range[1] >= numbers[numbers.length - 1], `SPEC.md §11.1 stops at ${range[1]}, before migration ${numbers[numbers.length - 1]}`);
});
