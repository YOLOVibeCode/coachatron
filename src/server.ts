import express from 'express';
import { PORT } from './config.js';
import { coachRouter } from './routes/coach.js';
import { publicRouter } from './routes/public.js';
import { webhooksRouter } from './routes/webhooks.js';
import { handleConnectWebhookRequest } from './routes/connectWebhook.js';
import { getDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

export function createApp() {
  const app = express();
  app.post('/webhooks/connect', express.raw({ type: 'application/json' }), handleConnectWebhookRequest);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.status(200).type('html').send('<!doctype html><html><body><h1>Coachatron</h1></body></html>');
  });

  app.use(coachRouter);
  app.use(publicRouter);
  app.use(webhooksRouter);

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

  createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT}`);
  });
}
