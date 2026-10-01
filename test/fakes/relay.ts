import express from 'express';
import { createServer, type Server } from 'node:http';
import { listenLoopback } from '../helpers/listen.js';

/** In-process fake for the Noctusoft relay (Connect sellers + SMS + email).
 * Tests point RELAY_BASE_URL at this instead of a live relay, per SPEC.md:
 * "Tests use a fake HTTP relay, not Square." */

export interface FakeSms {
  to: string;
  body: string;
}

export interface FakeBuyLink {
  product: string;
  seller: string;
  amountCents: number;
  user: string;
}

export interface FakeSeller {
  product: string;
  sellerKey: string;
  agreementVersion: string | null;
  chargesEnabled: boolean;
  /** Defaults to chargesEnabled. */
  payoutsEnabled?: boolean;
}

export interface FakeOnboard {
  product: string;
  sellerKey: string;
  returnUrl: string;
  email: string | null;
}

export interface FakeRelay {
  url: string;
  sms: FakeSms[];
  buyLinks: FakeBuyLink[];
  onboards: FakeOnboard[];
  /** The relay's current agreement_version for every product. */
  agreementVersion: string;
  seller(product: string, sellerKey: string): FakeSeller | undefined;
  /** What the provider's onboarding does once the coach finishes it. */
  enableCharges(product: string, sellerKey: string): void;
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
  // Never let fetch pool a socket to this fake; see test/helpers/server.ts.
  app.use((_req, res, next) => {
    res.set('connection', 'close');
    next();
  });
  app.use(express.json());

  const sms: FakeSms[] = [];
  const buyLinks: FakeBuyLink[] = [];
  const onboards: FakeOnboard[] = [];
  const sellers = new Map<string, FakeSeller>();
  const id = (product: string, sellerKey: string) => `${product}/${sellerKey}`;

  const relay = {
    agreementVersion: 'v1',
  };

  const seller = '/connect/:product/recipients/:sellerKey';

  app.get(seller, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const s = sellers.get(id(req.params.product, req.params.sellerKey));
    if (!s) {
      res.status(404).json({ code: 'RECIPIENT_NOT_FOUND' });
      return;
    }
    res.json({
      sellerKey: s.sellerKey,
      status: s.chargesEnabled ? 'active' : 'not_connected',
      chargesEnabled: s.chargesEnabled,
      payoutsEnabled: s.payoutsEnabled ?? s.chargesEnabled,
      agreementVersion: s.agreementVersion,
    });
  });

  app.post(`${seller}/agreement`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const { product, sellerKey } = req.params;
    const version = String(req.body.agreement_version ?? '');
    if (version !== relay.agreementVersion) {
      res.status(428).json({ code: 'AGREEMENT_STALE' });
      return;
    }
    const s = sellers.get(id(product, sellerKey)) ?? { product, sellerKey, agreementVersion: null, chargesEnabled: false };
    s.agreementVersion = version;
    sellers.set(id(product, sellerKey), s);
    res.json({ recipient_key: sellerKey, agreement_version_accepted: version });
  });

  app.post(`${seller}/onboard`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    const { product, sellerKey } = req.params;
    const s = sellers.get(id(product, sellerKey));
    if (!s?.agreementVersion) {
      res.status(428).json({ code: 'AGREEMENT_REQUIRED' });
      return;
    }
    onboards.push({ product, sellerKey, returnUrl: String(req.body.returnUrl ?? ''), email: req.body.email ?? null });
    res.json({ url: `${base}/connect/${product}/onboard?state=fake-${sellerKey}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  });

  app.get('/buy/connect/:product/:seller', (req, res) => {
    buyLinks.push({
      product: String(req.params.product),
      seller: String(req.params.seller),
      amountCents: Number(req.query.amount ?? 0),
      user: String(req.query.user ?? ''),
    });
    const ret = String(req.query.return ?? '/');
    res.redirect(303, ret);
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

  const server: Server = createServer(app);
  const port = await listenLoopback(server);
  const base = `http://127.0.0.1:${port}`;

  return Object.assign(relay, {
    url: base,
    sms,
    buyLinks,
    onboards,
    seller: (product: string, sellerKey: string) => sellers.get(id(product, sellerKey)),
    enableCharges: (product: string, sellerKey: string) => {
      const s = sellers.get(id(product, sellerKey));
      if (s) s.chargesEnabled = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
