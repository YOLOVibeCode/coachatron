import type { Request, Response } from 'express';
import { getDb } from '../db/client.js';
import { processConnectWebhook } from '../domain/connectWebhook.js';

export async function handleConnectWebhookRequest(req: Request, res: Response): Promise<void> {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).send('expected raw body');
    return;
  }
  const db = getDb();
  const result = await processConnectWebhook(db, rawBody, req.header('x-connect-signature'));
  res.status(result.status).send(result.body);
}
