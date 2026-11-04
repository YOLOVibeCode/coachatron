import express from 'express';
import type { Server } from 'node:http';
import { PORT } from './config.js';
import { healthRouter } from './routes/health.js';
import { landingRouter } from './routes/landing.js';
import { coachRouter } from './routes/coach.js';
import { publicRouter } from './routes/public.js';
import { smsInboundRouter, smsStatusRouter } from './routes/webhooks.js';
import { storeWebhookRouter } from './routes/store-webhook.js';
import { closeDb, getDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { runTick } from './jobs/tick.js';
import { pageHeaders, trustProxyHops } from './lib/headers.js';
import { refuseNulCharacters } from './lib/input.js';

const TICK_MS = 60_000;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Limits and consent records need the visitor's address, not the proxy's.
  app.set('trust proxy', trustProxyHops());
  app.use(pageHeaders);
  app.use('/webhooks/store', express.raw({ type: '*/*' }), storeWebhookRouter);
  // Inbound texts are signed over the raw body, so keep it raw here.
  app.use('/webhooks/sms', express.raw({ type: '*/*' }), smsInboundRouter);
  app.use('/webhooks/sms-status', express.raw({ type: '*/*' }), smsStatusRouter);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(refuseNulCharacters);

  app.use(healthRouter);
  // GET / is also the Railway healthcheck, so it never touches the database.
  app.use(landingRouter);
  app.use(coachRouter);
  app.use(publicRouter);

  return app;
}

/** How long a shutdown waits for requests and the tick to finish. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  /** Stops the tick timer and waits for a tick that is running. */
  stopTick: () => Promise<void>;
  /** Closes the database once nothing is using it. */
  closeDb: () => Promise<void>;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/** What the process does on SIGTERM (a deploy or a restart) and SIGINT:
 * stop taking connections, let requests already in flight and a running
 * tick finish, close the database, and exit 0. Whatever is still running
 * after the timeout is cut off and the process exits 1. A second signal
 * while shutting down changes nothing. */
export function gracefulShutdown(server: Server, opts: ShutdownOptions): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let started = false;
  return async (signal: string) => {
    if (started) return;
    started = true;
    console.log(`${signal}: finishing requests in flight, then stopping (at most ${timeoutMs} ms).`);
    let timedOut = false;
    const deadline = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs).unref();
    });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Keep-alive sockets with no request on them would hold close() open.
    server.closeIdleConnections();
    await Promise.race([Promise.all([closed, opts.stopTick()]), deadline]);
    if (timedOut) {
      console.error(`${signal}: requests still running after ${timeoutMs} ms were cut off.`);
      server.closeAllConnections();
    }
    try {
      await opts.closeDb();
    } catch (err) {
      console.error(`${signal}: the database did not close cleanly: ${err instanceof Error ? err.message : String(err)}`);
    }
    exit(timedOut ? 1 : 0);
  };
}

async function main(): Promise<void> {
  // Every route beyond GET / touches the database. In tests, freshDb()
  // migrates a fresh PGlite instance explicitly before each test; a real
  // running process (npm run dev, or a deployed one) migrates here, on
  // boot. Every migration is guarded (`if not exists`, or dropped and added
  // again), so this is safe on every boot, including against a Postgres
  // DATABASE_URL that is already current. Production with no DATABASE_URL
  // stops here: getDb() refuses an in-memory database there.
  try {
    await runMigrations(getDb());
  } catch (err) {
    console.error(`Coachatron did not start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Defense in depth: log rather than let an unrelated unhandled rejection
  // kill the whole server.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (request may hang, but the process stays up):', reason);
  });

  // One replica on Railway. Running more would need pg_try_advisory_lock
  // around runTick so two processes never tick at once.
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runTick(getDb(), new Date())
      .then(() => undefined)
      .catch((err) => console.error('tick failed:', err))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, TICK_MS);

  if ((process.env.APP_BASE_URL ?? '').startsWith('https://') && !(process.env.RELAY_INBOUND_SECRET ?? '').trim()) {
    console.warn('RELAY_INBOUND_SECRET is not set: inbound texts get 503 in production and are accepted unsigned elsewhere.');
  }

  const server = createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT} (Node ${process.version})`);
  });
  const shutdown = gracefulShutdown(server, {
    stopTick: async () => {
      clearInterval(timer);
      await running;
    },
    closeDb,
  });
  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
