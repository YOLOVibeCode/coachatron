import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/server.js';
import { closeDb, setDb, type DbClient } from '../src/db/client.js';
import { HEALTH_DB_TIMEOUT_MS } from '../src/routes/health.js';
import { listenLoopback } from './helpers/listen.js';

const COMMIT_KEYS = ['RAILWAY_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'GIT_COMMIT'] as const;

function saveCommitEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of COMMIT_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreCommitEnv(saved: Record<string, string | undefined>): void {
  for (const key of COMMIT_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearCommitEnv(): void {
  for (const key of COMMIT_KEYS) {
    delete process.env[key];
  }
}

async function fetchHealth(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

test('GET / returns 200', async () => {
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('GET /health returns build metadata JSON', async () => {
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    const { res, body } = await fetchHealth(port);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'coachatron');
    assert.equal(typeof body.commit, 'string');
    assert.equal(typeof body.env, 'string');
    assert.equal(typeof body.utc, 'string');
    assert.ok(!Number.isNaN(Date.parse(String(body.utc))));
  } finally {
    server.close();
  }
});

test('GET /health commit uses RAILWAY_GIT_COMMIT_SHA when set', async () => {
  const saved = saveCommitEnv();
  clearCommitEnv();
  process.env.RAILWAY_GIT_COMMIT_SHA = 'a'.repeat(40);
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    const { body } = await fetchHealth(port);
    assert.equal(body.commit, 'a'.repeat(40));
  } finally {
    server.close();
    restoreCommitEnv(saved);
  }
});

test('GET /health commit is unknown when commit env vars are unset', async () => {
  const saved = saveCommitEnv();
  clearCommitEnv();
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    const { body } = await fetchHealth(port);
    assert.equal(body.commit, 'unknown');
  } finally {
    server.close();
    restoreCommitEnv(saved);
  }
});

test('GET /health says the database answers, and keeps its version fields', async () => {
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    const { res, body } = await fetchHealth(port);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['commit', 'db', 'env', 'ok', 'service', 'utc']);
    assert.equal(body.db, 'ok');
  } finally {
    server.close();
  }
});

test('GET /health answers 503 with no detail when the database fails or does not answer in time', async () => {
  const failing: DbClient = {
    query: async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password authentication failed for user "app"');
    },
  };
  const stuck: DbClient = { query: () => new Promise(() => undefined) };
  const server = createServer(createApp());
  const port = await listenLoopback(server);
  try {
    for (const [what, db] of [
      ['an error', failing],
      ['no answer', stuck],
    ] as const) {
      setDb(db);
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const text = await res.text();
      assert.equal(res.status, 503, what);
      assert.ok(Date.now() - started < HEALTH_DB_TIMEOUT_MS + 1000, `${what}: answered within the timeout`);
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.ok, false);
      assert.equal(body.db, 'down');
      assert.equal(body.service, 'coachatron');
      assert.equal(typeof body.commit, 'string', 'the version fields stay');
      assert.doesNotMatch(text, /ECONNREFUSED|10\.1\.2\.3|password|timeout/i, `${what}: no detail`);
    }
  } finally {
    server.close();
    await closeDb();
  }
});

test('Railway checks /health in every environment', async () => {
  const iac = (await import(pathToFileURL(fileURLToPath(new URL('../.railway/railway.ts', import.meta.url))).href)) as {
    default: (ctx: unknown) => { resources: Array<{ name: string; deploy?: { healthcheckPath?: string } }> };
  };
  const { createRailwayContext } = await import('railway/iac');
  for (const environment of ['development', 'uat', 'production']) {
    const web = iac.default(createRailwayContext({ environment })).resources.find((r) => r.name === 'web');
    assert.equal(web?.deploy?.healthcheckPath, '/health', environment);
  }
});

test('every variable in the README table is kept when Railway config is applied, in every environment', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const names = [...readme.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]);
  for (const name of ['ALLOW_TEST_PAYMENTS', 'SMS_VISITOR_HOURLY_CAP', 'SMS_VISITOR_DAILY_CAP', 'SMS_DAILY_RESERVE']) {
    assert.ok(names.includes(name), `${name} is in the README table`);
  }
  const iac = (await import(pathToFileURL(fileURLToPath(new URL('../.railway/railway.ts', import.meta.url))).href)) as {
    default: (ctx: unknown) => { resources: Array<{ name: string; variables?: Record<string, { type: string }> }> };
  };
  const { createRailwayContext } = await import('railway/iac');
  for (const environment of ['development', 'uat', 'production']) {
    const web = iac.default(createRailwayContext({ environment })).resources.find((r) => r.name === 'web');
    const missing = names.filter((name) => web?.variables?.[name]?.type !== 'preserve');
    assert.deepEqual(missing, [], `${environment}: apply would delete these if they were set`);
  }
});
