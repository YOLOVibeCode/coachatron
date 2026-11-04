import { test } from 'node:test';
import assert from 'node:assert/strict';
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
