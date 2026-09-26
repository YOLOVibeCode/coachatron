"use strict";

/**
 * @noctusoft/store-client — the app side of the Noctusoft store.
 *
 * An app holds four things: its store alias, the store's signing secret, its
 * webhook callback URL, and its product relay key (nsk_…). It never holds a
 * Stripe or Square key, id, or type; refs the relay hands back are opaque.
 *
 *   const { createStoreClient, createWebhookHandler, signBuyLink } = require("@noctusoft/store-client");
 *
 * Use only the part you need: a link-only app never builds a client, a
 * webhook-only receiver never signs a link. Zero dependencies, Node 18+
 * (global fetch). Server-side only: every function here takes a secret.
 *
 * Contract: docs/api/store/README.md on noctusoft-relay. The relay's
 * test/store-client.test.js checks this file against the relay's own signer,
 * verifier, and routes.
 */

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

// ---------------------------------------------------------------- event v1 ----

const EVENT_FAMILIES = {
  checkout: ["checkout.completed", "checkout.expired"],
  purchase: [
    "purchase.paid",
    "purchase.failed",
    "purchase.refunded",
    "purchase.refund_failed",
    "purchase.disputed",
    "purchase.dispute_won",
    "purchase.dispute_lost",
    "purchase.fraud_warning",
  ],
  subscription: [
    "subscription.started",
    "subscription.renewed",
    "subscription.payment_failed",
    "subscription.action_required",
    "subscription.changed",
    "subscription.paused",
    "subscription.resumed",
    "subscription.canceled",
    "subscription.trial_ending",
    "subscription.renewal_upcoming",
  ],
  seller: [
    "seller.updated",
    "seller.disconnected",
    "seller.payout_paid",
    "seller.payout_failed",
  ],
  wallet: [
    "wallet.method_added",
    "wallet.method_updated",
    "wallet.method_removed",
  ],
};

const EVENT_TYPES = Object.values(EVENT_FAMILIES).flat();

/** A v1 type, including the `marketplace.` mirror of checkout / purchase / subscription types. */
function isEventType(type) {
  const t = String(type || "");
  if (EVENT_TYPES.includes(t)) return true;
  if (t.startsWith("marketplace.")) {
    const base = t.slice("marketplace.".length);
    return EVENT_FAMILIES.purchase.includes(base) || EVENT_FAMILIES.subscription.includes(base) || EVENT_FAMILIES.checkout.includes(base);
  }
  return false;
}

function familyOf(type) {
  const t = String(type || "");
  if (t.startsWith("marketplace.")) return "marketplace";
  const head = t.split(".")[0];
  if (EVENT_FAMILIES[head]) return head;
  return null;
}

// ------------------------------------------------------------------- links ----

const DEFAULT_LINK_TTL_S = 86400;

const hmacHex = (secret, payload) => createHmac("sha256", secret).update(payload).digest("hex");
const canon = (parts) => parts.map((p) => (p == null ? "" : String(p))).join("|");
const absolute = (baseUrl, url) => (baseUrl ? `${String(baseUrl).replace(/\/+$/, "")}${url}` : url);

function lifetime({ exp, nonce, ttlSeconds = DEFAULT_LINK_TTL_S }) {
  return {
    exp: exp == null ? Math.floor(Date.now() / 1000) + Number(ttlSeconds) : Number(exp),
    nonce: nonce || randomBytes(12).toString("hex"),
  };
}

function need(args, names) {
  const missing = names.filter((n) => args[n] == null || args[n] === "");
  if (missing.length) throw new TypeError(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`);
}

/**
 * A buy link for one plan or SKU of a store, signed with the store's signing
 * secret. The relay prices it from the catalog: a link carries no amount.
 * `url` is relative unless `baseUrl` (the relay's public URL) is given.
 */
function signBuyLink({ secret, store, code, user = "", email = "", returnUrl = "", qty = 1, exp, nonce, ttlSeconds, baseUrl }) {
  need({ secret, store, code }, ["secret", "store", "code"]);
  const life = lifetime({ exp, nonce, ttlSeconds });
  const payload = { store, code, user, email, return: returnUrl, qty: Number(qty) || 1, exp: life.exp, nonce: life.nonce };
  const sig = hmacHex(secret, canon(["buy-link-v1", payload.store, payload.code, payload.user, payload.email, payload.return, payload.qty, payload.exp, payload.nonce]));
  const q = new URLSearchParams({
    user: payload.user, email: payload.email, return: payload.return, qty: String(payload.qty), exp: String(payload.exp), nonce: payload.nonce, sig,
  });
  return { url: absolute(baseUrl, `/buy/${encodeURIComponent(store)}/${encodeURIComponent(code)}?${q}`), sig, payload };
}

/**
 * A marketplace buy link: one amount paid to one seller, signed with the
 * product's Connect signing key. The amount is inside the signature.
 */
function signConnectBuyLink({ secret, product, seller, amountCents, currency = "USD", user = "", email = "", returnUrl = "", exp, nonce, ttlSeconds, baseUrl }) {
  need({ secret, product, seller }, ["secret", "product", "seller"]);
  if (!Number.isInteger(amountCents)) throw new TypeError("amountCents must be a whole number of cents");
  const life = lifetime({ exp, nonce, ttlSeconds });
  const payload = { product, seller, amountCents, currency, user, email, return: returnUrl, exp: life.exp, nonce: life.nonce };
  const sig = hmacHex(secret, canon(["buy-link-v1", "connect", payload.product, payload.seller, payload.amountCents, payload.currency, payload.user, payload.email, payload.return, payload.exp, payload.nonce]));
  const q = new URLSearchParams({
    amount: String(payload.amountCents), currency: payload.currency, user: payload.user, email: payload.email, return: payload.return,
    exp: String(payload.exp), nonce: payload.nonce, sig,
  });
  return { url: absolute(baseUrl, `/buy/connect/${encodeURIComponent(product)}/${encodeURIComponent(seller)}?${q}`), sig, payload };
}

/**
 * A link to the relay's page where one buyer saves a card, signed with the
 * store's signing secret. `mode` is part of the signature: the buyer's
 * browser sends no mode header. POST /wallet/setup mints the same link.
 */
function signWalletLink({ secret, store, user, email, returnUrl, mode = "live", exp, nonce, ttlSeconds, baseUrl }) {
  need({ secret, store, user, email, returnUrl }, ["secret", "store", "user", "email", "returnUrl"]);
  if (mode !== "live" && mode !== "test") throw new TypeError(`mode must be "test" or "live", not ${JSON.stringify(mode)}`);
  const life = lifetime({ exp, nonce, ttlSeconds });
  const payload = { store, user, email, return: returnUrl, exp: life.exp, nonce: life.nonce, mode };
  const sig = hmacHex(secret, canon(["wallet-link-v1", payload.store, payload.user, payload.email, payload.return, payload.exp, payload.nonce, payload.mode]));
  const q = new URLSearchParams({ user, email, return: returnUrl, exp: String(payload.exp), nonce: payload.nonce, mode, sig });
  return { url: absolute(baseUrl, `/wallet/${encodeURIComponent(store)}/setup?${q}`), sig, payload };
}

// ---------------------------------------------------------------- webhooks ----

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return String(Array.isArray(v) ? v[0] : v ?? "");
  }
  return "";
}

function same(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const isRaw = (body) => typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array;

/**
 * Verify one relay delivery. `body` is the raw request body (string or
 * Buffer), before any JSON parsing; `callbackUrl` is the URL registered on
 * the store. Every signature the request carries must verify, and it must
 * carry one:
 *
 *   x-noctusoft-signature  hex HMAC-SHA256(secret, body)
 *   x-relay-signature      base64 HMAC-SHA256(secret, callbackUrl + body)
 *
 * Returns { ok: true, event } or { ok: false, reason: "unsigned" | "signature" | "json" }.
 */
function verifyWebhook({ secret, body, callbackUrl = "", headers }) {
  if (!secret) throw new TypeError("secret is required");
  if (!isRaw(body)) throw new TypeError("body must be the raw request body (string or Buffer), not parsed JSON");
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const noct = header(headers, "x-noctusoft-signature");
  const relay = header(headers, "x-relay-signature");
  const noctusoft = same(noct, createHmac("sha256", secret).update(bytes).digest("hex"));
  const relayOk = same(relay, createHmac("sha256", secret).update(String(callbackUrl)).update(bytes).digest("base64"));
  if (!noct && !relay) return { ok: false, reason: "unsigned", noctusoft, relay: relayOk };
  if ((noct && !noctusoft) || (relay && !relayOk)) return { ok: false, reason: "signature", noctusoft, relay: relayOk };
  let event;
  try { event = JSON.parse(bytes.toString("utf8")); } catch (_) { event = null; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return { ok: false, reason: "json", noctusoft, relay: relayOk };
  return { ok: true, event, noctusoft, relay: relayOk };
}

const PATTERN_FAMILIES = new Set([...Object.keys(EVENT_FAMILIES), "marketplace"]);

function checkPattern(key) {
  if (key === "*" || isEventType(key)) return;
  if (key.endsWith(".*") && PATTERN_FAMILIES.has(key.slice(0, -2))) return;
  throw new TypeError(`"${key}" is not an event type, a family ("purchase.*"), or "*"`);
}

const reply = (status, body) => ({ status, body });

/**
 * A webhook endpoint. `on` maps an event type ("purchase.paid"), a family
 * ("subscription.*", "marketplace.*"), or "*" to a handler; the most specific
 * one runs. 2xx is done, including an event nobody handles. Anything else
 * (401 bad signature, 400 not JSON, 500 handler threw) is retried with
 * backoff, then dead-lettered for an operator to replay.
 *
 * `idempotency: { seen(id), remember(id) }` skips a redelivered event id.
 * Without it, handlers must be idempotent themselves: the relay retries.
 */
function createWebhookHandler({ secret, callbackUrl, on = {}, idempotency = null, onError = null }) {
  if (!secret) throw new TypeError("secret is required");
  if (!callbackUrl) throw new TypeError("callbackUrl is required: it is the URL registered on the store, and part of x-relay-signature");
  for (const key of Object.keys(on)) {
    checkPattern(key);
    if (typeof on[key] !== "function") throw new TypeError(`on["${key}"] must be a function`);
  }
  const report = onError || ((err, event) => console.error("[store-client] handler failed", event?.type, event?.id, err));
  const pick = (type) => on[type] || on[`${familyOf(type)}.*`] || on["*"] || null;

  async function handle({ body, headers }) {
    if (!isRaw(body)) return reply(500, { ok: false, code: "RAW_BODY_REQUIRED", error: "Verify the raw request body, not a parsed one." });
    const v = verifyWebhook({ secret, body, callbackUrl, headers });
    if (!v.ok) return v.reason === "json" ? reply(400, { ok: false, code: "INVALID_JSON" }) : reply(401, { ok: false, code: "SIGNATURE_INVALID" });
    const event = v.event;
    const fn = pick(String(event.type || ""));
    if (!fn) return reply(200, { ok: true, handled: false });
    const id = event.id || header(headers, "x-relay-event-id") || null;
    if (idempotency && id && (await idempotency.seen(id))) return reply(200, { ok: true, duplicate: true });
    try {
      await fn(event, { headers });
    } catch (err) {
      report(err, event);
      return reply(500, { ok: false, code: "HANDLER_FAILED" });
    }
    if (idempotency && id) await idempotency.remember(id);
    return reply(200, { ok: true, handled: true });
  }

  function readStream(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  return {
    handle,
    /** node:http / Express. Mount before express.json(), or behind express.raw({ type: "application/json" }). */
    async node(req, res) {
      let body = isRaw(req.rawBody) ? req.rawBody : req.body;
      if (body === undefined) body = await readStream(req);
      const out = await handle({ body, headers: req.headers });
      res.statusCode = out.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out.body));
    },
    /** Fetch-style handlers (Next.js route handlers, Hono, Workers on Node). */
    async fetch(request) {
      const out = await handle({ body: Buffer.from(await request.arrayBuffer()), headers: request.headers });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    },
  };
}

// ------------------------------------------------------------------ client ----

class StoreError extends Error {
  constructor({ status, code, message, retryable = false, body = null }) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
  }
}

const seg = encodeURIComponent;

/**
 * Server calls to the relay with the product's relay key. `store` picks one
 * of the product's store aliases (X-Test-Store); `mode` ("test" | "live")
 * picks the mode (X-Store-Mode). Results are the relay's JSON; failures throw
 * StoreError with the relay's status and code.
 */
function createStoreClient({ baseUrl, apiKey, store = null, mode = null, fetch: fetchImpl = globalThis.fetch, headers: extra = {} } = {}) {
  if (!baseUrl) throw new TypeError("baseUrl is required (the relay's public URL)");
  if (!apiKey) throw new TypeError("apiKey is required (the product's nsk_… relay key)");
  if (mode != null && mode !== "test" && mode !== "live") throw new TypeError(`mode must be "test" or "live", not ${JSON.stringify(mode)}`);
  if (typeof fetchImpl !== "function") throw new TypeError("no fetch: use Node 18+ or pass { fetch }");
  const base = String(baseUrl).replace(/\/+$/, "");

  async function request(method, path, { query = null, body, pickStore = true } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString() : "";
    const res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(store && pickStore ? { "x-test-store": store } : {}),
        ...(mode ? { "x-store-mode": mode } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      throw new StoreError({
        status: res.status,
        code: data?.code || `HTTP_${res.status}`,
        message: data?.error || `${method} ${path} failed with ${res.status}`,
        retryable: typeof data?.retryable === "boolean" ? data.retryable : res.status >= 500,
        body: data,
      });
    }
    return data;
  }

  const get = (path, query, opts) => request("GET", path, { query, ...opts });
  const post = (path, body = {}, opts) => request("POST", path, { body, ...opts });

  function subscriptionsAt(prefix, paths, opts) {
    return {
      cancel: (ref, { atPeriodEnd = true } = {}) => post(`${prefix}/subscriptions/${seg(ref)}/cancel`, { atPeriodEnd }, opts),
      pause: (ref, { months } = {}) => post(`${prefix}/subscriptions/${seg(ref)}/pause`, { months }, opts),
      resume: (ref) => post(`${prefix}/subscriptions/${seg(ref)}/resume`, {}, opts),
      changePlan: (ref, { plan, effective } = {}) => post(`${prefix}/subscriptions/${seg(ref)}/${paths.changePlan}`, { plan, effective }, opts),
      updatePaymentMethod: (ref, { returnUrl } = {}) => post(`${prefix}/subscriptions/${seg(ref)}/${paths.updatePaymentMethod}`, { returnUrl }, opts),
    };
  }

  function walletAt(prefix, opts) {
    return {
      setup: (args) => post(`${prefix}/wallet/setup`, args, opts),
      list: (userId) => get(`${prefix}/wallet`, { userId }, opts),
      remove: (paymentMethodRef, { userId } = {}) => request("DELETE", `${prefix}/wallet/${seg(paymentMethodRef)}`, { query: { userId }, ...opts }),
    };
  }

  function seller(product, key) {
    const at = `/connect/${seg(product)}/recipients/${seg(key)}`;
    const opts = { pickStore: false };
    return {
      agree: ({ version } = {}) => post(`${at}/agreement`, { agreement_version: version }, opts),
      status: () => get(at, null, opts),
      onboard: (args) => post(`${at}/onboard`, args, opts),
      createPlan: (args) => post(`${at}/plans`, args, opts),
      catalog: () => get(`${at}/catalog`, null, opts),
      checkout: (args) => post(`${at}/subscriptions`, args, opts),
      charge: (args) => post(`${at}/charge`, args, opts),
      refund: (paymentRef, args = {}) => post(`${at}/refunds`, { ...args, paymentRef }, opts),
      subscriptions: subscriptionsAt(at, { changePlan: "swap-plan", updatePaymentMethod: "update-card" }, opts),
      wallet: walletAt(at, opts),
    };
  }

  return {
    catalog: () => get("/catalog"),
    entitlements: (userId) => get("/entitlements", { userId }),
    purchases: ({ userId, limit } = {}) => get("/purchases", { userId, limit }),
    checkout: (args) => post("/checkout", args),
    order: (args) => post("/order", args),
    quote: (args) => post("/quote", args),
    charge: (args) => post("/charge", args),
    refund: (paymentRef, args = {}) => post(`/payments/${seg(paymentRef)}/refund`, args),
    subscriptions: subscriptionsAt("", { changePlan: "change-plan", updatePaymentMethod: "update-payment-method" }),
    wallet: walletAt(""),
    marketplace: (product) => ({ seller: (key) => seller(product, key) }),
  };
}

module.exports = {
  EVENT_FAMILIES,
  EVENT_TYPES,
  isEventType,
  familyOf,
  signBuyLink,
  signConnectBuyLink,
  signWalletLink,
  verifyWebhook,
  createWebhookHandler,
  createStoreClient,
  StoreError,
};
