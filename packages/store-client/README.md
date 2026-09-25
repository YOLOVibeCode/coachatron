# @noctusoft/store-client

The app side of the Noctusoft store. Zero dependencies, Node 18+, server-side only.

An app holds four things: its **store alias**, the store's **signing secret**, its **callback URL**, and its product **relay key** (`nsk_…`). It never holds a Stripe or Square key, id, or type. Every ref the relay returns (`checkoutRef`, `paymentRef`, `subscriptionRef`, `paymentMethodRef`) is opaque: store it and pass it back.

Use only the part you need. A link-only app never builds a client, and a webhook receiver never signs a link.

## Sell

```js
const { createStoreClient, signBuyLink } = require("@noctusoft/store-client");

const store = createStoreClient({
  baseUrl: process.env.RELAY_URL,      // the relay's public URL
  apiKey: process.env.RELAY_API_KEY,   // nsk_…, scoped to your product
  store: "captionflow-uat",            // one of your product's store aliases
  mode: "test",                        // "test" = provider sandbox, "live" = real money
});

const { plans, skus } = await store.catalog();
const { url } = await store.checkout({ userId, email, plan: plans[0].code, returnUrl, idempotencyKey });
const { url: packUrl } = await store.order({ userId, email, items: [{ code: skus[0].code, quantity: 2 }], returnUrl, idempotencyKey });

// Or a link you can put in an email; the relay prices it from the catalog.
const link = signBuyLink({ secret: process.env.RELAY_WEBHOOK_SECRET, store: "captionflow-uat", code: plans[0].code, user: userId, email, returnUrl, baseUrl: process.env.RELAY_URL });
```

A public link carries no mode. A store pinned to test sells in test, and any other store sells live.

### Coupons and tax

```js
const q = await store.quote({ plan: "pro", coupon: "FIRE50", userId });          // { subtotalCents, discount, amountCents, tax, taxCents, totalCents, trialDays }
const { url } = await store.checkout({ userId, email, plan: "pro", coupon: "FIRE50", returnUrl, idempotencyKey });
```

The relay checks the code against the store's coupons. A code that does not apply throws `StoreError` with code `COUPON_INVALID` and `err.body.reason` (`NOT_FOUND`, `EXPIRED`, `ALREADY_USED`, …). On a store that charges tax, the hosted page adds it at the buyer's address, and `quote({ …, address })` shows it first. Events report what came off in `money.discountCents` and `discount.code`, and the tax in `money.taxCents`.

### Native apps

List your app's scheme in the manifest (`billing.returnSchemes: ["tankroom"]`), then open the hosted page in an in-app browser session so Apple Pay and Google Pay work:

```js
import * as WebBrowser from "expo-web-browser";
const { url } = await store.checkout({ userId, email, plan: "pro", returnUrl: "tankroom://checkout/return", idempotencyKey });
const result = await WebBrowser.openAuthSessionAsync(url, "tankroom://checkout/return");
// result.url ends in ?checkout=completed or ?checkout=canceled. Grant access from the event or entitlements(), not from the URL.
```

The same works for `wallet.setup` and `subscriptions.updatePaymentMethod` (`?card=updated|canceled`). Call the relay from your server, not the app: the key must not ship in the binary.

## Know what they own

```js
const owns = await store.entitlements(userId);   // { plan, active, until, subscription: { ref, … }, owns, … }
const { purchases } = await store.purchases({ userId });
```

## Change, refund, cancel

```js
await store.subscriptions.changePlan(subscriptionRef, { plan: "NOCTU-CAPTIONFLOW-PRO" });
await store.subscriptions.pause(subscriptionRef, { months: 1 });
await store.subscriptions.cancel(subscriptionRef);              // at period end unless { atPeriodEnd: false }
await store.refund(paymentRef, { idempotencyKey, amountCents }); // omit amountCents for a full refund
```

## Saved cards

```js
const { url } = await store.wallet.setup({ userId, email, returnUrl });   // the relay's save-a-card page
const { paymentMethods } = await store.wallet.list(userId);
await store.charge({ userId, item: "boost", quantity: 1, coupon: "BOOST2", idempotencyKey }); // a catalog SKU on the first saved card
await store.charge({ userId, amountCents: 500, idempotencyKey });         // or an open amount (no coupon)
```

A charge the bank wants the buyer to confirm fails with `StoreError` status 402, code `AUTHENTICATION_REQUIRED`, and `err.body.actionUrl` pointing at the page to send them to.

## Marketplace (Connect Hub)

```js
const shop = store.marketplace("fieldview").seller("shop-1");
await shop.agree({ version: "v1" });
const { url } = await shop.onboard({ returnUrl });            // the seller connects a payout account
await shop.createPlan({ key: "monthly", name: "Monthly", priceCents: 5000 });
await shop.checkout({ userId, email, plan: "monthly", returnUrl, idempotencyKey });
await shop.charge({ userId, email, amountCents: 2500, returnUrl, idempotencyKey });
```

The platform fee comes from the product's Connect row. The app never sends it.

## Receive events

```js
const { createWebhookHandler } = require("@noctusoft/store-client");

const hook = createWebhookHandler({
  secret: process.env.RELAY_WEBHOOK_SECRET,
  callbackUrl: "https://captionflow.example/hooks/store",   // exactly as registered on the store
  on: {
    "purchase.paid": async (e) => grant(e.buyer.userId, e.item.key),
    "purchase.refunded": async (e) => revoke(e.refs.paymentId),
    "subscription.*": async (e) => syncPlan(e.buyer.userId, e.subscription),
    "*": () => {},
  },
});

// node:http or Express (mount before express.json(), or behind express.raw({ type: "application/json" }))
app.post("/hooks/store", (req, res) => hook.node(req, res));
// Next.js route handler
export const POST = (request) => hook.fetch(request);
```

The most specific key runs: an exact type, then a family (`"purchase.*"`, `"marketplace.*"`), then `"*"`. A key that is not an event type throws at startup.

| Status | When |
|--------|------|
| 200 | handled, no handler for this type, or a duplicate |
| 401 | a signature is missing or wrong (check the secret and `callbackUrl`) |
| 400 | the signed body is not JSON |
| 500 | your handler threw, or the body was parsed before it reached the handler |

Anything but 2xx is retried with backoff and dead-lettered after the last attempt, and an operator can replay a dead letter. Fix the cause and the next retry succeeds.

The relay retries, so handlers must be idempotent. Or pass `idempotency: { seen(id), remember(id) }` backed by your database, and a redelivered `event.id` is acknowledged without running the handler again.

`verifyWebhook({ secret, body, callbackUrl, headers })` is the check on its own. It returns `{ ok: true, event }` or `{ ok: false, reason }`.

## Errors

A non-2xx response throws `StoreError` with `status`, `code` (the relay's, for example `INVALID_REQUEST`, `NOT_FOUND`, `SCOPE_FORBIDDEN`, `COUPON_INVALID`, `TAX_LOCATION_REQUIRED`), `retryable`, and `body`.

## Contract

`docs/api/store/README.md` on noctusoft-relay. The relay's `test/store-client.test.js` checks this package against the relay's own link signer, webhook signer, event catalog, and routes.
