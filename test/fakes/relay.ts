import express from 'express';
import type { Server } from 'node:http';

/** In-process fake for the Noctusoft relay (Connect Hub + SMS + email).
 * Tests point RELAY_BASE_URL at this instead of a live Square/Twilio/
 * SendGrid account, per SPEC.md: "Tests use a fake HTTP relay, not Square." */

export interface FakeCharge {
  recipientKey: string;
  idempotencyKey: string;
  amountCents: number;
  sourceId: string;
  appFeeBps: number;
}

export interface FakeSubscription {
  recipientKey: string;
  idempotencyKey: string;
  priceCents: number;
  appFeeBps: number;
  contactPhone: string;
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
  const sms: FakeSms[] = [];
  const connectedRecipients = new Set<string>();
  const lastPlanPriceByRecipient = new Map<string, number>();
  const lastCustomerPhoneByRecipient = new Map<string, string>();

  const product = 'coachatron';

  app.use(`/connect/${product}/recipients/:recipientKey`, (req, _res, next) => {
    connectedRecipients.add(req.params.recipientKey);
    next();
  });

  app.get(`/connect/${product}/recipients/:recipientKey/frontend-config`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json({
      application_id: 'sandbox-sq0idb-test',
      location_id: 'LTESTLOCATION',
      script_url: 'https://sandbox.web.squarecdn.com/v1/square.js',
    });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/agreement`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    connectedRecipients.add(req.params.recipientKey);
    res.json({ ok: true });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/charge`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    if (!connectedRecipients.has(recipientKey)) {
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
    const sourceId = String(req.body.source_id ?? '');
    const body = {
      id: `ch_${charges.length + 1}`,
      status: 'COMPLETED',
      amount_cents: amountCents,
      app_fee_cents: Math.round((amountCents * appFeeBps) / 10000),
    };
    charges.push({
      recipientKey,
      idempotencyKey,
      amountCents,
      sourceId,
      appFeeBps,
    });
    if (idempotencyKey) chargeByKey.set(idempotencyKey, body);
    res.json(body);
  });

  app.post(`/connect/${product}/recipients/:recipientKey/plans`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    if (!connectedRecipients.has(req.params.recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const priceCents = Number(req.body.price_cents);
    lastPlanPriceByRecipient.set(req.params.recipientKey, priceCents);
    res.json({
      plan_variation_id: `pv_${priceCents}`,
    });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/customers`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    if (!connectedRecipients.has(req.params.recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const phone = String(req.body.phone ?? '');
    lastCustomerPhoneByRecipient.set(req.params.recipientKey, phone);
    res.json({ customer_id: `cust_${phone.replace(/\W/g, '')}` });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/customers/:customerId/cards`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    res.json({ card_id: `card_${req.params.customerId}` });
  });

  app.post(`/connect/${product}/recipients/:recipientKey/subscriptions`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const recipientKey = req.params.recipientKey;
    if (!connectedRecipients.has(recipientKey)) {
      res.status(428).json({ error: 'recipient not connected' });
      return;
    }
    const idempotencyKey = String(req.body.idempotency_key ?? '');
    const appFeeBps = Number(req.body.app_fee_bps);
    subscriptions.push({
      recipientKey,
      idempotencyKey,
      priceCents: lastPlanPriceByRecipient.get(recipientKey) ?? 0,
      appFeeBps,
      contactPhone: lastCustomerPhoneByRecipient.get(recipientKey) ?? '',
    });
    res.json({ id: `sub_${subscriptions.length}`, status: 'ACTIVE' });
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

  return {
    url: `http://127.0.0.1:${port}`,
    charges,
    subscriptions,
    sms,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
