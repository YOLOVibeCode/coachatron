import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
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
