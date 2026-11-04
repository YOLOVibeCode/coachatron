import express from 'express';
import { createServer, type Server } from 'node:http';
import { listenLoopback } from '../helpers/listen.js';

/** In-process fake for the Noctusoft relay (Connect sellers + SMS + email).
 * Tests point RELAY_BASE_URL at this instead of a live relay, so no test
 * reaches Stripe, Twilio, or SendGrid. */

export interface FakeSms {
  to: string;
  body: string;
  /** The X-App-Env header the app sent, if any. */
  appEnv?: string | null;
  /** The Twilio message sid the fake answered with. */
  sid?: string;
}

export interface FakeEmail {
  to: string;
  subject: string;
  text: string;
  html: string | null;
  from: string | null;
  fromName: string | null;
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
  /** The account's mode as the relay reports it; defaults to the relay's sellerMode. */
  mode?: 'test' | 'live';
}

export interface FakeOnboard {
  product: string;
  sellerKey: string;
  returnUrl: string;
  email: string | null;
  /** Profile fields the app offered to prefill, when it sent any. */
  profile?: Record<string, string>;
}

export interface FakeRefund {
  product: string;
  sellerKey: string;
  paymentRef: string;
  /** Null when the app asked for the whole payment. */
  amountCents: number | null;
  idempotencyKey: string;
  refundRef: string;
  status: string;
}

export interface FakeRelay {
  url: string;
  sms: FakeSms[];
  emails: FakeEmail[];
  /** When true, the relay's own caps refuse texts / emails with a 429. */
  limited: { sms: boolean; email: boolean };
  /** Numbers whose text the fake refuses with a 502, as if the relay were down. Empty by default. */
  failSmsTo: Set<string>;
  /** Numbers whose text the fake refuses the way Twilio does, with this
   * status, code and message. Empty by default. */
  refuseSmsTo: Map<string, { status: number; code: number; message: string }>;
  buyLinks: FakeBuyLink[];
  onboards: FakeOnboard[];
  /** The relay's current agreement_version for every product. */
  agreementVersion: string;
  /** When true, /onboard answers 400 to any field it does not know. */
  strictOnboard: boolean;
  /** How many times the app asked for a seller's status. */
  statusChecks: number;
  /** When true, a seller's status answers 503, as a relay that is down would. */
  statusDown: boolean;
  /** The mode a seller's status reports when the seller has none of its own: 'test' by default. */
  sellerMode: 'test' | 'live';
  /** Refunds the relay made, one per idempotency key. */
  refunds: FakeRefund[];
  /** How many refund calls arrived, repeats included. */
  refundCalls: number;
  /** The status a new refund answers with. */
  refundStatus: 'succeeded' | 'pending' | 'failed';
  /** When set, the refund route answers with this error instead. */
  refundError: { status: number; code: string } | null;
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
  const emails: FakeEmail[] = [];
  const buyLinks: FakeBuyLink[] = [];
  const failSmsTo = new Set<string>();
  const refuseSmsTo = new Map<string, { status: number; code: number; message: string }>();
  const onboards: FakeOnboard[] = [];
  const sellers = new Map<string, FakeSeller>();
  const id = (product: string, sellerKey: string) => `${product}/${sellerKey}`;

  const relay = {
    agreementVersion: 'v1',
    limited: { sms: false, email: false },
    strictOnboard: false,
    statusChecks: 0,
    statusDown: false,
    sellerMode: 'test' as 'test' | 'live',
    refundCalls: 0,
    refundStatus: 'succeeded' as 'succeeded' | 'pending' | 'failed',
    refundError: null as { status: number; code: string } | null,
  };
  const refunds: FakeRefund[] = [];

  const seller = '/connect/:product/recipients/:sellerKey';

  app.get(seller, (req, res) => {
    if (!requireApiKey(req, res)) return;
    relay.statusChecks += 1;
    if (relay.statusDown) {
      res.status(503).json({ code: 'UNAVAILABLE' });
      return;
    }
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
      mode: s.mode ?? relay.sellerMode,
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
    const { returnUrl, email, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    if (relay.strictOnboard && Object.keys(rest).length > 0) {
      res.status(400).json({ code: 'INVALID_REQUEST', error: `unknown fields: ${Object.keys(rest).join(', ')}` });
      return;
    }
    const profile = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
    onboards.push({
      product,
      sellerKey,
      returnUrl: String(returnUrl ?? ''),
      email: typeof email === 'string' ? email : null,
      ...(Object.keys(profile).length > 0 ? { profile } : {}),
    });
    res.json({ url: `${base}/connect/${product}/onboard?state=fake-${sellerKey}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  });

  // The relay's seller refund (store/routes.js refundPayment): one refund per
  // idempotency key, and never more than the payment, so a second refund of
  // a whole payment is refused.
  app.post(`${seller}/refunds`, (req, res) => {
    if (!requireApiKey(req, res)) return;
    relay.refundCalls += 1;
    const { product, sellerKey } = req.params;
    const { paymentRef, idempotencyKey, amountCents } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof paymentRef !== 'string' || !paymentRef || typeof idempotencyKey !== 'string' || !idempotencyKey) {
      res.status(422).json({ code: 'INVALID_REQUEST', error: 'paymentRef and idempotencyKey are required.' });
      return;
    }
    if (relay.refundError) {
      res.status(relay.refundError.status).json({ code: relay.refundError.code, error: 'refused by the fake relay' });
      return;
    }
    const again = refunds.find((r) => r.idempotencyKey === idempotencyKey);
    if (again) {
      res.json({ refundRef: again.refundRef, paymentRef: again.paymentRef, status: again.status, amountCents: again.amountCents });
      return;
    }
    if (refunds.some((r) => r.paymentRef === paymentRef && r.status !== 'failed')) {
      res.status(422).json({ code: 'REFUND_EXCEEDS_PAYMENT', error: 'The refund is more than is left of the payment.' });
      return;
    }
    const refund: FakeRefund = {
      product,
      sellerKey,
      paymentRef,
      amountCents: typeof amountCents === 'number' ? amountCents : null,
      idempotencyKey,
      refundRef: `ns_rfd_fake${String(refunds.length + 1).padStart(6, '0')}`,
      status: relay.refundStatus,
    };
    refunds.push(refund);
    res.json({ refundRef: refund.refundRef, paymentRef, status: refund.status, amountCents: refund.amountCents });
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
    const to = String(req.body.to);
    if (relay.limited.sms) {
      // The relay's sms-caps.js refusal.
      res.status(429).json({ error: true, code: 20429, message: `Too many texts to ${to} in the last hour. Try again later.` });
      return;
    }
    if (to === '+15552161000') {
      res.status(400).json({ error: true, code: 21610, message: 'unsubscribed' });
      return;
    }
    if (failSmsTo.has(to)) {
      res.status(502).json({ error: true, message: 'relay unavailable' });
      return;
    }
    const refusal = refuseSmsTo.get(to);
    if (refusal) {
      res.status(refusal.status).json({ error: true, code: refusal.code, message: refusal.message });
      return;
    }
    const body = String(req.body.body);
    const sid = `SMfake${String(sms.length + 1).padStart(26, '0')}`;
    sms.push({ to, body, appEnv: req.header('x-app-env') ?? null, sid });
    // The relay's real answer (sms-routes.js): the Twilio sid sits under message.
    res.status(201).json({
      success: true,
      message: {
        twilio_sid: sid,
        to,
        from: '+18005550100',
        body,
        status: 'queued',
        created_at: new Date().toISOString(),
      },
    });
  });

  // The relay's native shape: to, subject, text or html, optional from / fromName.
  app.post('/email/send', (req, res) => {
    if (!requireApiKey(req, res)) return;
    if (relay.limited.email) {
      res.status(429).json({ error: true, message: 'Too many requests, please try again later.' });
      return;
    }
    const { to, subject, text, html, from, fromName } = req.body ?? {};
    if (!to || !subject || (!html && !text)) {
      res.status(422).json({ error: true, message: 'to, subject, and html or text are required' });
      return;
    }
    emails.push({
      to: String(to),
      subject: String(subject),
      text: String(text ?? ''),
      html: html ? String(html) : null,
      from: from ? String(from) : null,
      fromName: fromName ? String(fromName) : null,
    });
    res.status(201).json({ success: true, email: { to, subject, status: 'sent', messageId: `email_${emails.length}` } });
  });

  const server: Server = createServer(app);
  const port = await listenLoopback(server);
  const base = `http://127.0.0.1:${port}`;

  return Object.assign(relay, {
    url: base,
    sms,
    emails,
    failSmsTo,
    refuseSmsTo,
    buyLinks,
    onboards,
    refunds,
    seller: (product: string, sellerKey: string) => sellers.get(id(product, sellerKey)),
    enableCharges: (product: string, sellerKey: string) => {
      const s = sellers.get(id(product, sellerKey)) ?? { product, sellerKey, agreementVersion: relay.agreementVersion, chargesEnabled: false };
      s.chargesEnabled = true;
      sellers.set(id(product, sellerKey), s);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
