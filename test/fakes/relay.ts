import express from 'express';
import type { Server } from 'node:http';

/** In-process fake for the Noctusoft relay (Connect Hub + SMS + email).
 * Tests point RELAY_BASE_URL at this instead of a live Square/Twilio/
 * SendGrid account, per SPEC.md: "Tests use a fake HTTP relay, not Square." */

export interface FakeCharge {
  idempotencyKey: string;
  amountCents: number;
  appFeeBps: number;
}

export interface FakeSubscription {
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

export async function startFakeRelay(): Promise<FakeRelay> {
  const app = express();
  app.use(express.json());

  const charges: FakeCharge[] = [];
  const seenCharge = new Map<string, unknown>();
  const subscriptions: FakeSubscription[] = [];
  const sms: FakeSms[] = [];

  app.post('/connect/coachatron/charges', (req, res) => {
    const key = req.header('idempotency-key') ?? '';
    if (key && seenCharge.has(key)) {
      res.json(seenCharge.get(key));
      return;
    }
    const amountCents = Number(req.body.amountCents);
    const appFeeBps = Number(req.body.appFeeBps);
    const body = {
      id: `ch_${charges.length + 1}`,
      status: 'COMPLETED',
      amountCents,
      appFeeCents: Math.round((amountCents * appFeeBps) / 10000),
    };
    charges.push({ idempotencyKey: key, amountCents, appFeeBps });
    if (key) seenCharge.set(key, body);
    res.json(body);
  });

  app.post('/connect/coachatron/subscriptions', (req, res) => {
    subscriptions.push({
      idempotencyKey: req.header('idempotency-key') ?? '',
      priceCents: Number(req.body.priceCents),
      appFeeBps: Number(req.body.appFeeBps),
      contactPhone: String(req.body.contactPhone ?? ''),
    });
    res.json({ id: `sub_${subscriptions.length}`, status: 'ACTIVE' });
  });

  app.post('/sms/send', (req, res) => {
    sms.push({ to: String(req.body.to), body: String(req.body.body) });
    res.json({ id: `sms_${sms.length}` });
  });

  app.post('/email/send', (_req, res) => {
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
