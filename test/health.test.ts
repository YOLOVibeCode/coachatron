import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { listenLoopback } from './helpers/listen.js';

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
