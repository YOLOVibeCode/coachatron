import express from 'express';
import { PORT } from './config.js';

export function createApp() {
  const app = express();
  app.get('/', (_req, res) => {
    res.status(200).type('html').send('<!doctype html><html><body><h1>Coachatron</h1></body></html>');
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT}`);
  });
}
