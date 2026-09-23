import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { productionComplete, resetComplete, setComplete } from '../src/llm/complete.js';
import { fakeComplete } from './fakes/llm.js';

test('injected fake complete returns a fixed intent and records the prompt', async () => {
  const fn = fakeComplete({ intent: 'schedule.query', confidence: 1 });
  setComplete(fn);
  try {
    const { complete } = await import('../src/llm/complete.js');
    const out = await complete({
      messages: [{ role: 'user', content: "what's tomorrow" }],
      schema: { type: 'object' },
    });
    assert.deepEqual(out, { intent: 'schedule.query', confidence: 1 });
    assert.equal(fn.calls.length, 1);
  } finally {
    resetComplete();
  }
});

test('production complete posts to LITELLM_BASE /chat/completions and retries once', async () => {
  let hits = 0;
  const app = express();
  app.use(express.json());
  app.post('/chat/completions', (req, res) => {
    hits += 1;
    assert.equal(req.body.temperature, 0);
    assert.equal(req.header('authorization'), 'Bearer test-key');
    if (hits === 1) {
      res.status(500).json({ error: 'boom' });
      return;
    }
    res.json({
      choices: [{ message: { content: JSON.stringify({ intent: 'unknown', confidence: 0 }) } }],
    });
  });
  const server: Server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const prevBase = process.env.LITELLM_BASE;
  const prevKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_BASE = `http://127.0.0.1:${port}`;
  process.env.LITELLM_API_KEY = 'test-key';
  try {
    const out = await productionComplete({
      messages: [{ role: 'user', content: 'hello' }],
      schema: { type: 'object' },
    });
    assert.deepEqual(out, { intent: 'unknown', confidence: 0 });
    assert.equal(hits, 2);
  } finally {
    process.env.LITELLM_BASE = prevBase;
    process.env.LITELLM_API_KEY = prevKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
