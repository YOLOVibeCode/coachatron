import type { Server } from 'node:http';
import { createApp } from '../../src/server.js';

/** Starts the app on an ephemeral port for the duration of `fn`, then closes
 * it. Every HTTP-level test uses this instead of guessing a port. */
export async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp();
  const server: Server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}
