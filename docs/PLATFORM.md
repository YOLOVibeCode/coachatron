# Platform integration — what Coachatron does not build

**Status:** Draft v0.1 · 2026-09-21
**Companion to:** [`../SPEC.md`](../SPEC.md)

Coachatron is a product on the **Noctusoft relay**, not a standalone stack. Email,
SMS, inbound routing, object storage, store billing, and marketplace payments
with application fees (Stripe Connect, behind the relay's neutral store
contract) already exist there, are tested, and are multi-tenant by product key.
Coachatron's job is to add a manifest row and write product logic.

Source of truth: `~/Dev/Noctusoft/noctusoft-relay` (`AGENTS.md`,
`docs/api/store/README.md` "Marketplace (Connect Hub)", `stripe/adapter.js`).

---

## 1. What the relay already provides

| Surface | Endpoint | Coachatron uses it for |
|---|---|---|
| **Email** | `POST /email/send` (SendGrid drop-in at `/v3/mail/send`) | Sign-in codes, booking confirmations with the manage link, and the notice when a payment for a cancelled session becomes credit |
| **SMS out** | `POST /sms/send` (Twilio drop-in at `/2010-04-01/Accounts/:sid/Messages.json`) | Confirmations, reminders, cancels, overflow offers, coach alerts, and the coach's go-live and payments texts |
| **Inbound SMS** | `inbound.js` `ROUTES`, keyed by phone number → product webhook | Offer replies, and the NL control channel (§4) |
| **Inbound email** | `ROUTES.email`, keyed by domain, with auto-reply + forward | `reply.coachatron.com` support address |
| **Connect Hub** | `/connect/:productKey/*`, buy links at `/buy/connect/:productKey/:seller` | Coach onboards a Stripe connected account; parents pay it; we take an app fee |
| **Storage** | `/v1/storage/<bucket>/<key>` (R2) | Not needed in Slice 1 |
| **Billing (one-store)** | `billing.js`, `POST /order` | Not needed — Coachatron sells on the *coach's* merchant, not ours |

**Do not build a second mailer, SMS client, or payment client (Stripe or
Square).** The relay's authorization model makes the product key the tenancy
boundary, and `test/cross-tenant.test.js` proves a product key is 403 on every
other product's billing, Connect, and storage rows.

### 1.1 Adding Coachatron as a product

Per `AGENTS.md`, this is data, not code:

1. Add the entry below to `products/manifest.json`
2. `npm test` — the product-matrix test now covers it
3. `npm run verify:products` — anything marked **GAP** is a hardcoded config
   needing a code change (`inbound.js ROUTES`, `storage/index.js BROWSER_ORIGINS`)
4. Follow `docs/NEW-PROPERTY.md` to create the row and issue the product key
5. Do not run `plans:wire`: Coachatron has no one-store billing row (the
   manifest says so). Each environment's Connect row on `ns` is the store
   (below)

```json
{
  "key": "coachatron",
  "brand": "Coachatron",
  "repos": ["YOLOVibeCode/coachatron"],
  "status": "planned",
  "connect": {
    "productKey": "coachatron",
    "envKeys": ["coachatron-dev", "coachatron-uat"],
    "returnOrigins": ["*.coachatron.com"],
    "appFeeBps": 500,
    "postConnectRedirect": "https://coachatron.com/app/money"
  },
  "email": true,
  "sms": true,
  "inbound": {
    "email": ["reply.coachatron.com"],
    "sms": ["<coachatron Twilio number, to be provisioned>"]
  }
}
```

`appFeeBps: 500` is the locked 5% from SPEC.md §9.3 (2026-09-22): the ease
of a five-minute link, a parent who pays with no account, and a full session
that texts the next coach. FieldView runs 1000 (10%) for a different product.

**The fee is one rate per environment.** The fee the relay applies, and
whether an environment takes live or test payments, live on that
environment's Connect row (`connect_apps`) on `ns`: `coachatron`,
`coachatron-dev`, and `coachatron-uat` are Stripe rows at 500 bps
(`app_fee_bps`) on store contract v1. The relay reads the rate at each charge,
so changing the row changes the fee for every coach in that environment at
once, with no deploy, and no connected coach keeps the earlier rate.
Coachatron's buy links carry no fee, and the relay gives a public buy link the
row's rate. It takes another rate (`feeBps`, up to `app_fee_bps_max`) only on
an authenticated checkout call, which Coachatron does not make. So a per-coach
rate (a zero-rated pilot coach, or holding connected coaches at their rate
when the default rises) needs a relay change first. `coach.fee_bps` in
Coachatron's schema is not sent to the relay, and `appFeeBps` in the manifest
records the same number as the rows. The live manifest entry still carries a
leftover `squareEnv` field; nothing reads it for payments.

---

## 2. Payments — Stripe Connect through Connect Hub

**This materially reduces Coachatron's build.** Connect Hub is the relay's
marketplace, mounted at `/connect/:productKey/*`. It runs on **Stripe Connect
(Accounts v2)** behind the relay's neutral store contract ("v1"): Coachatron
sees opaque refs and Noctusoft event v1, never a Stripe key, id, or type
(`packages/store-client`). *(Updated 2026-11-03: this section first described
Square OAuth, which the relay no longer uses.)*

What Coachatron calls today:

| Step | Relay | Coachatron |
|---|---|---|
| Accept the terms | `POST /connect/:product/recipients/:seller/agreement` with `agreement_version: "v1"` | Money screen box "I accept the Coachatron marketplace terms (v1)" (`SELLER_AGREEMENT_VERSION`) |
| Onboard | `POST …/onboard` → signed relay link → Stripe's hosted form (identity, bank) → back to `/app/money?seller=connected\|pending\|failed` | "Connect payments"; once connected, "Update payout details" opens the same form. A coach who only texts reaches Money from the payments link in their go-live text (§2.2) |
| Status | `GET /connect/:product/recipients/:seller` | Charges and payouts enabled, accepted agreement version; whether charges work is saved in `coach_payments` (§2.2) |
| Pay | Signed buy link `GET /buy/connect/:product/:seller?…&sig=` → Stripe's hosted checkout, with the platform fee | Checkout (screen 10, reached by its token): drop-in, package, or one-time pack, each one charge, offered only while the coach's charges work |
| Hear back | Event v1 `marketplace.purchase.paid` at `/webhooks/store`; `seller.updated` and `seller.disconnected` for the coach's account | Records the event once, checks it, then books the held spot and grants package or pack credits, or keeps the payment for the coach (§2.2) |
| Refund | `POST …/recipients/:seller/refunds` with `{ paymentRef, idempotencyKey }` (no amount: the whole payment); the platform fee is returned with it | **Refund** on Session detail and Money, after a confirmation; one key per payment and try (§2.2) |
| Hear back on refunds and disputes | `marketplace.purchase.refunded`, `marketplace.purchase.refund_failed`, `marketplace.purchase.disputed`, `marketplace.purchase.dispute_won`, `marketplace.purchase.dispute_lost` | Each recorded once; a refund's effects applied once; failures and disputes shown on Money (§2.2) |

How the relay sets up each coach (`stripe/adapter.js`, `beginOnboarding`):

- **The coach is the merchant.** Charges are made on the coach's own
  connected account, with Coachatron's fee taken as the application fee.
- **No Stripe dashboard** (`dashboard: "none"`). The coach makes no Stripe
  login; Stripe's form confirms them with a phone code.
- **Stripe collects fees and carries losses**
  (`responsibilities: { fees_collector: "stripe", losses_collector: "stripe" }`).
  Stripe takes its processing fee from the coach's account, and a negative
  balance is Stripe's to recover, not Noctusoft's.
- **US sellers**, card payments (`identity.country: "us"`).
- **Terms first.** The relay will not start onboarding (428
  `AGREEMENT_REQUIRED` / `AGREEMENT_STALE`) until the coach has accepted the
  Connect app's current agreement version.
- **Fee from the Connect row:** 500 bps (§1.1). The app never sends it.

Built in the relay, not used by Coachatron yet:

- **Partial refunds:** the refund route also takes `amountCents`; the fee is
  returned in proportion. Coachatron refunds whole payments only, and a
  partial refund is a support request (SPEC.md §9.4).
- **Seller subscriptions** (`…/plans`, `…/subscriptions` and cancel / pause /
  resume / swap-plan / update-card). A plan is sold as a one-time pack,
  charged once, and parents and coaches see it that way; monthly renewal
  would use these.
- **Answering a dispute:** Stripe handles disputes. Coachatron records each
  one and its outcome and shows them on Money, but a coach with no Stripe
  dashboard sends evidence through Coachatron support.

So SPEC.md §15.1 ("is Connect Hub ready enough to build against?") is **answered:
yes, build against it.** Do not call Stripe, or any processor, directly.

### 2.1 What still blocks a real charge

No live charge has run for Coachatron yet. What gates it, slowest first:

1. **Attorney review** of the drafts in [`legal/`](legal/): the coach's
   marketplace terms (v1), the parent terms, and the payments additions to the
   privacy policy — start this now, it is the long pole
2. **Marketplace terms v1 published** where the Money screen's box can point
   to them. The box names v1; the text has to exist before a coach accepts it
3. **Dispute handoff** — how a coach with no Stripe dashboard answers a
   dispute (through support today), and how support handles a partial
   refund. Whole refunds, including payments listed under "Payments to
   resolve" on Money (§2.2), are made from the app
4. Production's Connect row switched from Stripe test mode to live (an
   operator step on `ns`)
5. Production canary — one $1 real charge on a real coach account, refunded
   from the Money screen through the relay's seller refund route

**Sequencing consequence:** items 1–3 are legal/ops work with no code dependency.
They should start in parallel with Slice 1 development, or they become the
critical path to first revenue.

Connect Hub explicitly does *not* cover **coach onboarding UI** — that is
product-side, i.e. Coachatron's screen 7 (Money, and connecting payments) in
SPEC.md §8.1.

### 2.2 From publish to a paid booking

*Implemented 2026-11-03* (`src/domain/payments.ts`, `src/routes/public.ts`,
`src/routes/store-webhook.ts`):

- **Whether a coach can take charges** is saved in `coach_payments`, so the
  public page asks the relay at most once a minute and only until it first
  answers. It is updated when the coach lands back on Money, by
  `seller.updated` and `seller.disconnected` events, and by the tick, which
  asks about a coach still setting up at most every 15 minutes (for 30 days
  after they started) in case an event was missed.
- **Booking opens soon.** Until charges work, each paid session on
  `/c/:handle` says "Booking opens soon" in place of Book, checkout offers
  only session credits, and nothing sends a parent to the payment page. Free
  sessions book as usual, and families who hold session credits with the
  coach can still book with them.
- **Texts to the coach** (each one segment, only to a mobile with the texts
  box ticked): on the first publish, the page link and, until charges work, a
  payments link `/p/:token` (one use, 7 days) that signs the coach in on
  Money; one "You can take payments now" text when charges turn on, held
  past quiet hours; and, while setup is unfinished, the payments link again
  about a day and about three days after publishing, two at most.
- **Spot holds.** Starting a booking holds the spot for 15 minutes while the
  parent pays (`booking.hold_expires_at`), counted again from when they pick a
  way to pay; capacity counts live bookings plus unexpired holds. One phone
  holds one spot per session at a time.
- **Several children** *(2026-11-04, SPEC.md §9.5)*. One booking pass holds a
  spot per child (`booking.pass_id`), paid for through the first booking's
  checkout. The Connect buy link (`signConnectBuyLink`, the relay's
  `sellerBuy`) carries one open amount and no quantity, so the drop-in link
  is the price times the children, and the paid event must match that total.
  A package or pack is offered only when it covers every child.
- **Waitlist spots** *(2026-11-04, SPEC.md §7.3)*. A spot that opens goes to
  the waitlist in order: a held booking with its checkout link, sent by text
  or email, for 15 minutes, then to the next person (the tick's
  `moveWaitlists`). When neither goes out just then (a relay 5xx or 429, a
  sending limit), the hold is let go and the parent stays first in line
  (`waitlist.send_tries`, `retry_at`: 5, 10, 20, 40 minutes, then hourly);
  only a relay 400, 404 or 422, an opt-out, or no consent and no email passes
  them over. People waiting count against new holds and against renewing a
  lapsed one; a paid event for a lapsed hold books whenever there is room.
- **Free sessions** book at checkout (`mode=dropin`, `gross_cents` 0) with
  no buy link: the relay's Connect charge needs at least 50 cents.
- **Checkout** is reached by `booking.checkout_token`, never the booking's
  serial id. Session credits are used only once the booking's phone is
  proven (`booking.phone_verified_at`): a code texted to it at checkout, or
  arriving from a manage link that was proven the same way.
- **Payment checks.** Every paid event is claimed in `store_event` before it
  is handled, so a redelivery or a restart never handles it twice; while
  another delivery is handling it, the app answers with an error so the relay
  retries. A payment books only when its booking is waiting for it, the
  amount equals the price, and the session is scheduled, not started, and has
  room (an expired hold still books while there is room). Anything else is
  kept in `payment_attention` with a fixed reason (booking missing or
  cancelled, already booked, item missing, amount mismatch, session started,
  session full), logged once, and listed on Money under "Payments to resolve"
  for the coach to settle with the parent. The parent's checkout page then
  says the coach has the payment. A payment for a session the coach cancelled
  while the parent was paying becomes credit with the coach instead, the
  parent is told by text or email, and Money lists it with whether they were
  told.
- **Confirmations.** A booked parent gets one confirmation with the manage
  link: a text when they ticked the texts box, an email when they gave an
  address. The page they return to after paying shows the link as well.
- **A coach's cancel** returns a credit for every paid booking, including a
  paid drop-in, which becomes one session credit with the coach with no
  expiry. Each step can run again, so a cancel that stopped part way
  finishes on the next try; how each parent was reached is kept on the
  booking (`booking.cancel_notice`), and the session screen lists who the
  coach still needs to contact.

*Refunds, implemented 2026-11-04* (`src/domain/refunds.ts`,
`src/relay/seller.ts`, `src/routes/coach.ts`, `src/routes/store-webhook.ts`):

- **Asking.** Session detail and Money offer **Refund** on a paid booking and
  on each payment under "Payments to resolve". The coach confirms on the same
  screen, which says what the refund changes. A refund is the whole payment;
  a package or pack is refunded only while none of the credits it added has
  been used, and the screen says why not otherwise.
- **Once.** A `refund` row per payment is claimed before the relay is
  called, so a second tap sends nothing. The idempotency key is the
  payment's ref and its try number: the same key goes again when the
  relay's answer never came (a timeout, a 429, or a 5xx), and a new one only
  after a refusal or a failed refund.
- **Held while on its way.** The claim locks the booking and sets its
  credit's `refund_id` in the same transaction, and a credit with one cannot
  be booked with; a booking that drew on it since the check stops the claim.
  A credit made from the booking while its refund is `requested` or
  `pending` (a coach's cancel of a paid drop-in, a parent's cancel in time,
  or the coach giving a no-show or late cancel back) gets that `refund_id`
  in the transaction that makes it. A refund that fails before its effects
  were applied clears it (migration 0020).
- **Effects, once.** When the relay answers `succeeded`, or
  `marketplace.purchase.refunded` arrives (whichever is first), the booking
  the payment bought becomes `refunded` (its spot is free when its session
  is still to come), the payment's credit is set to zero and marked
  `withdrawn_at`, so a booking that drew on it and is cancelled later gives
  nothing back (what was already used is counted and shown), a
  kept payment is resolved, and the parent is told once: a text with their
  consent, an email to an address they typed. Totals on Money leave the
  booking out and show what was refunded this week. A spot the refund
  frees is offered to the waitlist at once, and a spot offer whose booking
  was refunded leaves the line as lapsed. What was used counts a booking
  as using its own session while it stands or was cancelled late (unless
  the coach gave it back, `booking.waived_at`), and a session given back
  as used once the credit it went to is spent. A booking pass's
  payment is on each child's booking (`booking.charge_id`), so its refund
  covers every booking carrying it: all are ended, every credit they hold is
  withdrawn, the amount is the sum of their shares, and the parent's notice
  names each child.
- **Refunds made elsewhere.** A refund event for a payment Coachatron did not
  refund is applied when it is the whole payment; a part refund is only
  recorded and listed under "Payments to resolve".
- **Failures** (`marketplace.purchase.refund_failed`, or a refusal such as
  `NOT_FOUND` or `REFUND_EXCEEDS_PAYMENT`) are listed under "Payments to
  resolve" with a way to try again.
- **Disputes** are recorded in `payment_dispute` (open, then won or lost; a
  late "opened" never undoes an outcome) and shown on Money with what they
  mean. They change no booking or credit.

---

## 3. Messaging

All sends go through the relay. Rules from SPEC.md §10 stand (transactional only,
`STOP` honored, quiet hours 9pm–8am local, per-recipient rate limits).

**One Coachatron number does both jobs** (decided 2026-10-02):

- **Outbound:** the manifest's `sms` becomes `{ numbers: ["+1…"] }` (or the
  messaging service it joins), so every environment's texts come from it.
  Until then texts go from the shared Noctusoft sender.
- **Inbound:** the relay routes a number to one URL. While testing, the
  manifest's `inbound.sms` points it at `https://uat.coachatron.com/webhooks/sms`.
  At launch, that one `url` moves to `https://coachatron.com/webhooks/sms`, and
  production's `INBOUND_SMS_URL` and `RELAY_INBOUND_SECRET` follow. Adding the
  route is data in `products/manifest.json`, not an `inbound.js` change.
- **What arrives:** Twilio's own form fields (`From`, `To`, `Body`, …),
  urlencoded, with `x-relay-signature` = base64 HMAC-SHA256(secret, url + raw
  body). `src/routes/webhooks.ts` checks it whenever `RELAY_INBOUND_SECRET` is
  set, and answers 503 in production when it is not (mint it with `node scripts/relay-keys.js inbound-secret --product
  coachatron --rotate` in the relay repo). `INBOUND_SMS_URL` must equal the
  manifest `url` exactly.
- **How the app answers.** The relay passes the app's reply back to Twilio
  when it is XML (TwiML) and answers an empty `<Response></Response>` for
  anything else (`twimlFrom` in the relay's `inbound.js`). *(Corrected
  2026-11-04: this said the relay ignores a non-XML reply, so the app had to
  send a text.)* So:
  - `HELP` (and `INFO`) is answered with TwiML: one segment with the brand,
    the support address, the rates line and how to stop
    (`helpReplyText` in `src/routes/webhooks.ts`). Twilio's Messaging
    Service has its own HELP reply; it should carry the same text, or be
    turned off, so a parent does not get two.
  - `STOP` and the other opt-out words, and `START`, get empty TwiML. Twilio
    answers those keywords itself at the number level, with its own
    confirmation, and blocks the number; the app records the opt-out (or
    clears it) and sends nothing. A reply that asks to stop in its own words
    ("please stop texting me") is recorded the same way.
  - Everything else that needs an answer (the assistant's replies, a start
    link, an offer link) is sent as a text through the send path, so it is
    counted, capped and logged like any other text.
- **Only texts and status callbacks Twilio signed are acted on.** The relay
  also sends `x-relay-twilio-verified`: `1` when Twilio's own signature
  checked out, `0` when not. With the relay's `TWILIO_SIGNATURE_MODE=log` it
  still forwards the `0` kind, so the app answers anything but `1` with an
  empty TwiML 200 and does nothing with it: no reply, no opt-out, and no
  change to `message_log`.
- Texts reach only US and Canadian numbers, by the app's and the relay's
  policy; the other `+1` countries and the territories are refused. A coach
  elsewhere joins by email (SPEC.md §7.1).

---

## 4. SMS natural-language control

**Goal:** a coach runs their business by texting the number in plain English.
No app, no login, no dashboard — the 9pm phone test (SPEC.md §4, P4) taken to
its conclusion.

```
Coach: "cancel tomorrow's 6pm, field's flooded"
  →    "Cancel Tue Oct 7, 6:00pm Goalkeeper Group? 6 athletes booked,
        they'll be texted and credits returned. Reply Y."
Coach: "Y"
  →    "Cancelled. 6 athletes notified, 6 credits returned."
```

### 4.1 Three layers, cheapest first

Most inbound traffic is not conversational and **must never reach a model.**

| Layer | Handles | Cost |
|---|---|---|
| **1. Keyword** | `Y` `YES` `N` `NO` `STOP` `HELP` — offer replies and confirmations, the majority of volume | zero |
| **2. Pattern** | A handful of high-frequency exact shapes (`WHO <time>`, `CANCEL <time>`) | zero |
| **3. Model** | Everything else: one call, message → structured intent | fractions of a cent |

Layer 1 is non-negotiable: the overflow cascade (SPEC.md §7.3) depends on `Y`
being unambiguous and instant. A model must never sit between a roster member's
`Y` and the claim.

### 4.2 The model's only job

Turn one message into one **intent object from a closed set**. It does not write
to the database, does not compose athlete-facing text, and does not decide
anything. It classifies and extracts.

```jsonc
{
  "intent": "session.cancel",     // closed enum, see below
  "confidence": 0.0,              // model-reported; < 0.75 → clarify, never guess
  "args": {
    "when": "2026-10-07T18:00:00-05:00",   // resolved against coach tz
    "session_type": "Goalkeeper Group",
    "reason": "field flooded"
  }
}
```

**Closed intent set for Slice 1** — anything outside it returns `unknown`:

| Intent | Kind | Confirm? |
|---|---|---|
| `schedule.query` | read | no |
| `session.roster` | read | no |
| `money.summary` | read | no |
| `session.cancel` | write | **yes** |
| `session.add` | write | **yes** |
| `session.move` | write | **yes** |
| `broadcast.send` | write | **yes** (shows exact text first) |
| `roster.offer` | write | **yes** |
| `unknown` | — | replies with a link |

**Second closed schema: setup.** `SETUP_JSON_SCHEMA` (`src/llm/setupSchema.ts`)
extracts a coach's described week: session types, weekly times, packages,
plans, and an optional time zone. The model only fills it. Product code
validates every value, never guesses a price or a headcount (it asks), renders
the preview, and writes on Publish (`src/domain/setup.ts`). It runs on the
schedule screen, and by SMS for a coach with nothing on the calendar yet. It
shares the per-coach model caps.

### 4.3 Safety rules

These are the whole design. Without them this feature is a liability.

- **R1 — Reads answer, writes confirm.** Any intent that moves money, cancels a
  session, or sends a message to athletes replies with a one-line summary and
  waits for `Y`. Mirrors the cascade rule: the system proposes, the coach
  disposes.
- **R2 — Confirmation is deterministic.** The confirm text is rendered by
  template code from the parsed intent, never by the model. The coach confirms
  *what the system will actually do*, not a model's description of it.
- **R3 — Fail closed.** `confidence < 0.75`, ambiguous time, or `unknown` →
  "I didn't catch that" plus a deep link. Never guess a destructive action.
  *(Implemented 2026-11-04: a time from the model that is not a date gets
  the same reply. An add or a move to a time in the past, more than 8 weeks
  out, or at the same moment as a session of the same type is answered with
  the reason and asks nothing; one that overlaps another session says so in
  the question. The time is checked again on `Y`. The model is told the
  current date and time.)*
- **R4 — Coach-only.** NL control is authorized by the coach's verified phone
  number. Athlete and roster numbers reach only the keyword layer. An unknown
  number never reaches the model: a stranger gets one sign-up link a day, and a
  known parent gets the booking link.
- **R5 — Bounded blast radius.** One intent affects one session or one broadcast.
  No "cancel everything next week" in Slice 1 — multi-entity operations go to the
  web UI.
  **Exception (2026-09-30): additive setup.** Voice setup (session types, weekly
  times, packages, plans) may create many rows from one message. It cancels
  nothing, moves no money, texts no athletes, and is written only when the
  coach taps Publish on a preview the product rendered from the extracted
  plan (R2). Bulk cancel or delete stays on the web.
- **R6 — Pending confirmations expire** in 10 minutes and are single-use, so a
  stale `Y` cannot fire a forgotten action.
- **R7 — Everything is logged** — raw message, parsed intent, confirmation, and
  outcome — under SPEC.md §13's append-only audit requirement.

### 4.4 Model — one interface, litellm-vm behind it

Coachatron code depends on a single interface: complete a closed prompt and
return structured output. Callers (intent extraction, and anything later) see
that interface and nothing else. Tests inject a fake that returns a fixed
intent. The production implementation is a thin HTTP client.

That client talks only to the **LiteLLM relay on `litellm-vm`**, the same
relay the rest of the estate uses:

- Base: `https://ai.noctusoft.com/v1` (`LITELLM_BASE`)
- Call: `POST /chat/completions` with the virtual key
- Model: `LITELLM_MODEL`, a name configured on the VM (a small, cheap alias).
  Changing Haiku / Flash / mini is a change on litellm-vm, not a code change
  and not a new dependency.

No Anthropic, OpenAI, or Google SDK in this repo. Provider keys stay on the
VM. The Coachatron virtual key comes from **1Password at runtime**, with a
hard monthly budget so a loop cannot run up a bill. Budgets and the SMS
anomaly monitor are already on that VM.

Request structured output (JSON schema), temperature 0. Timeout ~3s, then the
link reply. One retry, then fall back. A retry loop on the SMS path is a bug.

### 4.5 Cost

US SMS is about **$0.013 per segment** all-in: Twilio's $0.0083 plus carrier
fees of roughly $0.0035–$0.0045. Inbound is $0.0083. A parse is about 200 input
tokens and 60 output tokens on a small model, well under a tenth of a cent.
The texts are the cost. The model is not.

A busy month — eight sessions a week, six athletes, a confirmation and a
reminder each, plus overflow and the coach texting — is on the order of
**600–1,200 segments, about $8–$16.** At 5%, a coach covers $16 of texts once
they book about $320. The $49 plan covers that same month with room left. A
zero-rated pilot (which needs a per-coach rate in the relay first, §1.1) would
cost us the texts and nothing else, which at this volume is a few dollars.

What can outrun the fee is a loop, a broadcast storm, or a number Twilio
prices like an international destination. Those are capped in the send path
(SPEC.md §10):

| Ceiling | Limit | Worst case |
|---|---|---|
| Per coach, per day | 300 outbound segments | ~$4, then silence |
| Per coach, per month | 2,000 outbound segments | ~$26 |
| Per non-coach number | 1 automatic reply per day | stops reply storms |
| Per message | 1 segment | a second segment is never sent |
| Destination price | above $0.02/segment is refused | email still goes |
| Per coach, model | 30 calls/day, 400/month | cents |
| Product model key | $20/month | raise on purpose, not by usage |
| Product, per day | 400 segments × active coaches, floor 500 | a shared-sender bug dies the same day |

*Implemented 2026-09-30* in `src/domain/outbound.ts`, the only send path.
Destination price is enforced by country code: only `+1` (US and Canada) is
texted, since the relay does not report a per-destination price. "Active
coach" means a coach with a scheduled session ahead. Sign-in codes are also
capped at 5 per number or email per day, and requests that send a code, opt
in at `/sms`, join a waitlist, start a booking (each holds a spot for 15
minutes; 20 an hour and 60 a day), or use the landing page's box are limited
per client address (`src/domain/requestLimits.ts`). A code stops working after 5
wrong tries, works once, and checks for a number or email count against its
hourly limit only while it has a live code. The code a parent asks for at
checkout to use session credits follows the same rules.
When the relay's own caps answer 429, the send path returns `busy` and the
page asks to try again later. *(Added 2026-11-04: a letter outside GSM-7
whose plain form is inside it, as in "García", is written plain, so a name
never turns a text into UCS-2 and cuts it to 70 characters; the HELP reply
is one segment too. A reminder the relay fails, cannot be reached for, or
turns away as busy is tried again on later ticks, up to 5 failures a number
a day, and never holds up the other reminders. That makes a reminder at
least once, not exactly once: `/sms/send` takes no idempotency key, and the
relay can answer 502 after Twilio has taken the text, so in that case the
parent gets it twice. A missed reminder was judged to cost more. An
idempotency key on `/sms/send` (SPEC.md §11, "every SMS send carries an
idempotency key") would make it exactly once; that is a relay change.)*

The full assistant fits inside those ceilings. Scheduling by text, setting a
session up, asking before a change, confirmations, reminders, and the overflow
cascade for a busy coach land around 600–1,200 segments and well under 400
model calls. The caps are not a smaller product. Hitting one means a loop:
sends stop until the window resets. Idempotency keys already required by
SPEC.md §11 keep a retry from being a second text. The product-day ceiling is
the backstop when a bug ignores the per-coach counter.

### 4.6 Rollout

The full assistant is what the 5% pays for: schedule, set a session up, and
ask before any write, on the closed intent set above. It is not trimmed to
save texts.

Slice 1 still ships the keyword layer only (`Y`/`N`/`STOP`), because the
cascade needs `Y` to be instant and the model must not sit in that path. The
full assistant follows as soon as the launch coach is actually texting, so the
intent set comes from real messages. It does not wait for ten paying coaches,
and it does not ship as a shorter command list.

---

## 5. Open items

1. Provision the Coachatron Twilio number; add to `inbound.js ROUTES.sms`
2. Add `reply.coachatron.com` to `ROUTES.email` + DNS
3. Start attorney review (§2.1 item 1) — long pole to first revenue
4. Create the Coachatron LiteLLM virtual key with a monthly budget
5. Decide the Slice-1 keyword vocabulary exactly (`Y/N/STOP/HELP` + what else)
6. ~~Confirm `appFeeBps: 400`~~ **Locked at 500 (5%).** See SPEC.md §9.3. Raise later by config for new coaches only.
