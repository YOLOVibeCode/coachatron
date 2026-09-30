import { createServer, type Server } from 'node:http';
import { createApp } from '../../src/server.js';

/** Starts the app on an ephemeral port for the duration of `fn`, then closes
 * it. Every HTTP-level test uses this instead of guessing a port. */
export async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp();
  // Connection: close on every response, so fetch never pools a socket.
  // A pooled socket outlives its server; when a later test's server gets
  // the same ephemeral port, fetch reuses the dead socket and fails with
  // "fetch failed" (seen intermittently across the full suite).
  const server: Server = createServer((req, res) => {
    res.setHeader('connection', 'close');
    app(req, res);
  }).listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const prev = process.env.STORE_WEBHOOK_URL;
  process.env.STORE_WEBHOOK_URL = `${base}/webhooks/store`;
  try {
    await fn(base);
  } finally {
    if (prev === undefined) delete process.env.STORE_WEBHOOK_URL;
    else process.env.STORE_WEBHOOK_URL = prev;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
