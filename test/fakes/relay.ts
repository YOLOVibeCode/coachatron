import express from 'express';
import type { Server } from 'node:http';

export interface FakeCharge {
  recipientKey: string;
  idempotencyKey: string;
  amountCents: number;
  appFeeBps: number;
  sessionId: string;
}

export interface FakeSubscription {
  recipientKey: string;
  idempotencyKey: string;
  priceId: string;
  appFeeBps: number;
}

export interface FakeSms {
  to: string;
  body: string;
}

export interface FakeRelay {
  url: string;
  charges: FakeCharge[];
  subscriptions: FakeSubscription[];
  sms: FakeSms[];
  enableCharges(recipientKey: string): void;
  close(): Promise<void>;
}

function requireApiKey(req: express.Request, res: express.Response): boolean {
  const key = req.header('x-api-key');
  if (!key) {
    res.status(401).json({ errors: [{ message: 'missing X-Api-Key' }] });
    return false;
  }
  return true;
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const app = express();
  app.use(express.json());

  const charges: FakeCharge[] = [];
  const chargeByKey = new Map<string, Record<string, unknown>>();
  const subscriptions: FakeSubscription[] = [];
  const subByKey = new Map<string, Record<string, unknown>>();
  const sms: FakeSms[] = [];
  const agreedRecipients = new Set<string>();
  const chargesEnabled = new Set<string>();

  const product = 'coachatron';

  app.post(`/connect/${product}/recipients/:recipientKey/agreement`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    agreedRecipients.add(req.params.recipientKey);
    res.json({ ok: true });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/onboard`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    agreedRecipients.add(recipientKey);
    const accountId = `acct_${recipientKey}`;
    res.json({
      url: `https://stripe.test/onboard/${recipientKey}`,
      stripe_account_id: accountId,
    });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/charge`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    if (!agreedRecipients.has(recipientKey)) {
      res.status(428).json({ error: 'AGREEMENT_REQUIRED' });
      return;
    }
    if (!chargesEnabled.has(recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const idempotencyKey = String(req.body.idempotency_key ?? '');
    if (idempotencyKey && chargeByKey.has(idempotencyKey)) {
      res.json(chargeByKey.get(idempotencyKey));
      return;
    }
    const amountCents = Number(req.body.amount_cents);
    const appFeeBps = Number(req.body.app_fee_bps);
    const sessionId = `cs_test_${charges.length + 1}`;
    const body = {
      url: `https://stripe.test/checkout/${sessionId}`,
      sessionId,
      payment: { application_fee_amount: Math.round((amountCents * appFeeBps) / 10000) },
    };
    charges.push({
      recipientKey,
      idempotencyKey,
      amountCents,
      appFeeBps,
      sessionId,
    });
    if (idempotencyKey) chargeByKey.set(idempotencyKey, body);
    res.json(body);
  });

  app.post(`/connect/${product}/recipients/:recipientKey/prices`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    if (!chargesEnabled.has(recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const priceCents = Number(req.body.price_cents);
    res.json({ price_id: `price_${recipientKey}_${priceCents}` });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/subscriptions`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    if (!agreedRecipients.has(recipientKey) || !chargesEnabled.has(recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const idempotencyKey = String(req.body.idempotency_key ?? '');
    if (idempotencyKey && subByKey.has(idempotencyKey)) {
      res.json(subByKey.get(idempotencyKey));
      return;
    }
    const appFeeBps = Number(req.body.app_fee_bps);
    const priceId = String(req.body.price_id ?? '');
    const sessionId = `cs_sub_${subscriptions.length + 1}`;
    const body = {
      url: `https://stripe.test/checkout/${sessionId}`,
      sessionId,
      application_fee_percent: appFeeBps / 100,
    };
    subscriptions.push({ recipientKey, idempotencyKey, priceId, appFeeBps });
    if (idempotencyKey) subByKey.set(idempotencyKey, body);
    res.json(body);
  });

  app.post('/sms/send', (req, res) => {
    if (!requireApiKey(req, res)) return;
    sms.push({ to: String(req.body.to), body: String(req.body.body) });
    res.json({ id: `sms_${sms.length}` });
  });

  app.post('/email/send', (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json({ id: 'email_1' });
  });

  const server: Server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const relay: FakeRelay = {
    url: `http://127.0.0.1:${port}`,
    charges,
    subscriptions,
    sms,
    enableCharges(recipientKey: string) {
      agreedRecipients.add(recipientKey);
      chargesEnabled.add(recipientKey);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  return relay;
}
