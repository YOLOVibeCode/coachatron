import express from 'express';
import { PORT } from './config.js';
import { coachRouter } from './routes/coach.js';
import { publicRouter } from './routes/public.js';

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.status(200).type('html').send('<!doctype html><html><body><h1>Coachatron</h1></body></html>');
  });

  app.use(coachRouter);
  app.use(publicRouter);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT}`);
  });
}
