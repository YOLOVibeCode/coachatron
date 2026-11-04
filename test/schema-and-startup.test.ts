import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers/db.js';
import { seedCoachWithSession, seedRosterMember } from './helpers/fixtures.js';

/** What the database holds itself to, and how the process starts and
 * stops. */

test('the database itself refuses a session type with no room, a negative price, or a negative credit balance', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const member = await seedRosterMember(db, seed.coach.id, 'Backup', 1);
  const refused: Array<[string, string, unknown[]]> = [
    ['capacity 0', "insert into session_type (coach_id, name, duration_min, capacity, price_cents) values ($1, 'Zero', 60, 0, 3500)", [seed.coach.id]],
    ['duration 0', "insert into session_type (coach_id, name, duration_min, capacity, price_cents) values ($1, 'Zero', 0, 4, 3500)", [seed.coach.id]],
    ['price -100', "insert into session_type (coach_id, name, duration_min, capacity, price_cents) values ($1, 'Neg', 60, 4, -100)", [seed.coach.id]],
    ['credits -5', "insert into credit (coach_id, contact_phone, remaining, source) values ($1, '+15550000001', -5, 'package')", [seed.coach.id]],
    ['package expiring after 0 days', "insert into package (coach_id, name, credits, price_cents, expires_days) values ($1, 'P', 10, 100, 0)", [seed.coach.id]],
    ['pack of 0', "insert into plan (coach_id, name, price_cents, credits_per_month) values ($1, 'P', 100, 0)", [seed.coach.id]],
    ['priority -1', 'update roster_member set priority = -1 where id = $1', [member.id]],
    ['a credit taken below zero', "update credit set remaining = remaining - 1 where coach_id = $1", [seed.coach.id]],
  ];
  await db.query("insert into credit (coach_id, contact_phone, remaining, source) values ($1, '+15550000002', 0, 'package')", [seed.coach.id]);
  for (const [what, sql, params] of refused) {
    await assert.rejects(db.query(sql, params), /check constraint|violates/i, what);
  }
  // A free session and a credit used up are fine.
  await db.query("insert into session_type (coach_id, name, duration_min, capacity, price_cents) values ($1, 'Free', 30, 10, 0)", [seed.coach.id]);
});

test('bookings are indexed by session and texts by provider id, and the schema file can run twice', async () => {
  const db = await freshDb();
  const indexes = await db.query<{ tablename: string; indexdef: string }>(
    "select tablename, indexdef from pg_indexes where tablename in ('booking', 'message_log', 'session', 'credit')",
  );
  const has = (table: string, column: RegExp) => indexes.rows.some((r) => r.tablename === table && column.test(r.indexdef));
  assert.ok(has('booking', /\(session_id\b/), 'booking (session_id)');
  assert.ok(has('booking', /\(contact_phone\b/), 'booking (contact_phone)');
  assert.ok(has('message_log', /\(provider_id\b/), 'message_log (provider_id)');
  assert.ok(has('session', /\(session_type_id, starts_at_utc\)/), 'session (session_type_id, starts_at_utc)');
  assert.ok(has('credit', /\(coach_id, contact_phone\)/), 'credit (coach_id, contact_phone)');

  const sql = readFileSync(new URL('../src/db/migrations/0019_checks_and_indexes.sql', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.query(statement);
  }
});
