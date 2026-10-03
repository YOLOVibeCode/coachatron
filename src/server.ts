import express from 'express';
import { PORT } from './config.js';
import { landingRouter } from './routes/landing.js';
import { coachRouter } from './routes/coach.js';
import { publicRouter } from './routes/public.js';
import { smsInboundRouter, smsStatusRouter } from './routes/webhooks.js';
import { storeWebhookRouter } from './routes/store-webhook.js';
import { getDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { runTick } from './jobs/tick.js';

const TICK_MS = 60_000;

export function createApp() {
  const app = express();
  app.use('/webhooks/store', express.raw({ type: '*/*' }), storeWebhookRouter);
  // Inbound texts are signed over the raw body, so keep it raw here.
  app.use('/webhooks/sms', express.raw({ type: '*/*' }), smsInboundRouter);
  app.use('/webhooks/sms-status', express.raw({ type: '*/*' }), smsStatusRouter);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // GET / is also the Railway healthcheck, so it never touches the database.
  app.use(landingRouter);
  app.use(coachRouter);
  app.use(publicRouter);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Every route beyond GET / touches the database. In tests, freshDb()
  // migrates a fresh PGlite instance explicitly before each test; a real
  // running process (npm run dev, or production with DATABASE_URL unset,
  // which is a supported no-database-to-install mode per the README) never
  // went through that step and would 500 - or worse, since Express 4 does
  // not forward a rejected promise from an async route handler to error
  // middleware, an uncaught DB error becomes an *unhandled promise
  // rejection*, which crashes the entire process by Node's default policy,
  // taking down every other in-flight request too. Migrating on boot fixes
  // the root cause (found by live-curling a fresh clone, not by the test
  // suite, which never exercises the real startup path); every migration
  // uses `if not exists` guards, so this is safe to run every boot,
  // including against a real Postgres DATABASE_URL that's already current.
  await runMigrations(getDb());

  // Defense in depth for the same class of bug elsewhere: log rather than
  // let an unrelated future unhandled rejection kill the whole server.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (request may hang, but the process stays up):', reason);
  });

  // One replica on Railway. Running more would need pg_try_advisory_lock
  // around runTick so two processes never tick at once.
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runTick(getDb(), new Date());
    } finally {
      ticking = false;
    }
  };
  void tick();
  setInterval(() => void tick(), TICK_MS);

  if ((process.env.APP_BASE_URL ?? '').startsWith('https://') && !(process.env.RELAY_INBOUND_SECRET ?? '').trim()) {
    console.warn('RELAY_INBOUND_SECRET is not set: inbound texts get 503 in production and are accepted unsigned elsewhere.');
  }

  createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT} (Node ${process.version})`);
  });
}
