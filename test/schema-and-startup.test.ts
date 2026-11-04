import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freshDb } from './helpers/db.js';
import { listenLoopback } from './helpers/listen.js';
import { seedCoachWithSession, seedRosterMember } from './helpers/fixtures.js';
import { createPool } from '../src/db/client.js';
import { gracefulShutdown } from '../src/server.js';

/** What the database holds itself to, and how the process starts and
 * stops. */

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

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

test('production refuses to start without DATABASE_URL, and says why', async () => {
  const client = pathToFileURL(fileURLToPath(new URL('../src/db/client.ts', import.meta.url))).href;
  const script = `
    const { getDb } = await import(${JSON.stringify(client)});
    try { getDb(); console.log(JSON.stringify({ started: true })); }
    catch (err) { console.log(JSON.stringify({ started: false, message: err.message })); }
    process.exit(0);
  `;
  const run = async (env: Record<string, string>) => {
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: '', ...env },
      timeout: 60_000,
    });
    return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { started: boolean; message?: string };
  };
  const production = await run({ NODE_ENV: 'production' });
  assert.equal(production.started, false);
  assert.match(production.message ?? '', /DATABASE_URL is not set/);
  assert.deepEqual(await run({ NODE_ENV: 'development' }), { started: true }, 'local development still uses the in-memory database');
});

test('the Postgres pool logs a lost idle connection and keeps the process running', async () => {
  const pool = createPool('postgres://127.0.0.1:1/none');
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    // With no listener, emitting "error" throws: the process would exit.
    assert.doesNotThrow(() => pool.emit('error', new Error('terminating connection due to administrator command')));
  } finally {
    console.error = original;
    await pool.end();
  }
  assert.match(String(logged[0]?.[0]), /idle connection was lost/);
});

/** Answers after delayMs (and calls answered), or never when delayMs is null. */
function slowServer(delayMs: number | null, answered: () => void = () => undefined): Server {
  return createServer((_req, res) => {
    if (delayMs === null) return;
    setTimeout(() => res.end('done', answered), delayMs);
  });
}

test('on a stop signal, requests in flight finish, the tick and the database close, and new connections are refused', async () => {
  const steps: string[] = [];
  const server = slowServer(300, () => steps.push('request answered'));
  const port = await listenLoopback(server);
  let exitCode: number | null = null;
  const shutdown = gracefulShutdown(server, {
    stopTick: async () => {
      await new Promise((r) => setTimeout(r, 50));
      steps.push('tick stopped');
    },
    closeDb: async () => {
      steps.push('db closed');
    },
    timeoutMs: 5_000,
    exit: (code) => {
      exitCode = code;
    },
  });
  const inFlight = fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } });
  await new Promise((r) => setTimeout(r, 50));
  const stopping = shutdown('SIGTERM');
  void shutdown('SIGTERM'); // a second signal changes nothing
  const res = await inFlight;
  assert.equal(await res.text(), 'done', 'the request in flight was answered');
  await stopping;
  assert.deepEqual(steps, ['tick stopped', 'request answered', 'db closed']);
  assert.equal(exitCode, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), 'no new connections');
});

test('a request still running at the shutdown deadline is cut off and the process exits 1', async () => {
  const server = slowServer(null);
  const port = await listenLoopback(server);
  let dbClosed = false;
  let exitCode: number | null = null;
  const shutdown = gracefulShutdown(server, {
    stopTick: async () => undefined,
    closeDb: async () => {
      dbClosed = true;
    },
    timeoutMs: 200,
    exit: (code) => {
      exitCode = code;
    },
  });
  const stuck = fetch(`http://127.0.0.1:${port}/`).catch(() => 'cut off');
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  await shutdown('SIGTERM');
  assert.ok(Date.now() - started < 2_000, 'stopped at the deadline');
  assert.equal(await stuck, 'cut off');
  assert.equal(dbClosed, true);
  assert.equal(exitCode, 1);
});
