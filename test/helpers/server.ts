import { createServer, type Server } from 'node:http';
import { createApp } from '../../src/server.js';
import { listenLoopback } from './listen.js';
import { configureSmsWebhooks, clearSmsWebhookEnv } from './sms-webhook.js';

/** Starts the app on an ephemeral port for the duration of `fn`, then closes
 * it. Every HTTP-level test uses this instead of guessing a port. */
export async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp();
  // Connection: close keeps fetch from pooling sockets across tests.
  const server: Server = createServer((req, res) => {
    res.setHeader('connection', 'close');
    app(req, res);
  });
  const port = await listenLoopback(server);
  const base = `http://127.0.0.1:${port}`;
  const prev = process.env.STORE_WEBHOOK_URL;
  process.env.STORE_WEBHOOK_URL = `${base}/webhooks/store`;
  configureSmsWebhooks(base);
  try {
    await fn(base);
  } finally {
    if (prev === undefined) delete process.env.STORE_WEBHOOK_URL;
    else process.env.STORE_WEBHOOK_URL = prev;
    clearSmsWebhookEnv();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
