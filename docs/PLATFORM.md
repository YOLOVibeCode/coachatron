# Platform integration — what Coachatron does not build

**Status:** Draft v0.1 · 2026-09-21
**Companion to:** [`../SPEC.md`](../SPEC.md)

Coachatron is a product on the **Noctusoft relay**, not a standalone stack. Email,
SMS, inbound routing, object storage, Square billing, and marketplace payments
with application fees already exist there, are tested, and are multi-tenant by
product key. Coachatron's job is to add a manifest row and write product logic.

Source of truth: `~/Dev/Noctusoft/noctusoft-relay` (`AGENTS.md`, `connect/README.md`).

---

## 1. What the relay already provides

| Surface | Endpoint | Coachatron uses it for |
|---|---|---|
| **Email** | `POST /email/send` (SendGrid drop-in at `/v3/mail/send`) | Booking confirmations, receipts, cancellations |
| **SMS out** | `POST /sms/send` (Twilio drop-in at `/2010-04-01/Accounts/:sid/Messages.json`) | Reminders, overflow offers, coach alerts |
| **Inbound SMS** | `inbound.js` `ROUTES`, keyed by phone number → product webhook | Offer replies, and the NL control channel (§4) |
| **Inbound email** | `ROUTES.email`, keyed by domain, with auto-reply + forward | `reply.coachatron.com` support address |
| **Connect Hub** | `/connect/:productKey/*` | Coach connects their Square; we take an app fee |
| **Storage** | `/v1/storage/<bucket>/<key>` (R2) | Not needed in Slice 1 |
| **Billing (one-store)** | `billing.js`, `POST /order` | Not needed — Coachatron sells on the *coach's* merchant, not ours |

**Do not build a second mailer, SMS client, or Square client.** The relay's
authorization model makes the product key the tenancy boundary, and
`test/cross-tenant.test.js` proves a product key is 403 on every other product's
billing, Connect, and storage rows.

### 1.1 Adding Coachatron as a product

Per `AGENTS.md`, this is data, not code:

1. Add the entry below to `products/manifest.json`
2. `npm test` — the product-matrix test now covers it
3. `npm run verify:products` — anything marked **GAP** is a hardcoded config
   needing a code change (`inbound.js ROUTES`, `storage/index.js BROWSER_ORIGINS`)
4. Follow `docs/NEW-PROPERTY.md` to create the row and issue the product key
5. `npm run plans:wire -- --alias coachatron`, then
   `npm run smoke:lifecycle -- --alias coachatron`

```json
{
  "key": "coachatron",
  "brand": "Coachatron",
  "repos": ["YOLOVibeCode/coachatron"],
  "status": "planned",
  "connect": {
    "productKey": "coachatron",
    "appFeeBps": 500,
    "squareEnv": "sandbox",
    "postConnectRedirect": "https://coachatron.com/settings/payments"
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
A later default applies to coaches who connect after the change. Per-transaction
override is supported and bounded by `app_fee_bps_max`, so pilot coaches can
be zero-rated without a deploy.

---

## 2. Payments — Connect Hub is built, not activated

**This materially reduces Coachatron's build.** Connect Hub Slice 1 is done:
8 files, ~1,050 LOC, 68 passing tests, mounted at `/connect/:productKey/*`.

Already covered, and exactly what SPEC.md §9 asked for:

- Square OAuth connect (authorize + callback, product-scoped signed state)
- Versioned recipient agreement, **runtime-enforced** — 428 on missing/stale
- One-time payments with `application_fee_money` + per-transaction fee override
- **Full subscription lifecycle** — catalog plan + variation, customer and
  card-on-file, create / cancel / pause / resume / swap-plan, hosted card-update
  link
- Multi-tenant by `productKey`

So SPEC.md §15.1 ("is Connect Hub ready enough to build against?") is **answered:
yes, build against it.** Do not implement Square directly.

### 2.1 What still blocks a real charge

Per `connect/README.md`, Slice 1 has **never run against a real Square
Application**. Eight out-of-code steps gate that, and three are slow:

1. **Attorney review** of Terms, Recipient Agreement, and dispute language —
   start this now, it is the long pole
2. **Recipient Agreement v1** drafted and versioned
3. **Chargeback handoff one-pager** — the coach owns dispute response
4. One shared **Square OAuth Application** ("Noctusoft Marketplace"), sandbox
   first, adding `https://coachatron.com/...` + the relay callback as redirect URIs
5. Env vars on `ns`: `NOCTUSOFT_SQUARE_CLIENT_SECRET`, `NOCTUSOFT_STATE_SECRET`
6. `connect_apps` row seeded (SQL in `connect/test/sandbox.sh` header)
7. Sandbox run: `bash connect/test/sandbox.sh`
8. Production canary — one $1 real charge, refunded immediately

**Sequencing consequence:** items 1–3 are legal/ops work with no code dependency.
They should start in parallel with Slice 1 development, or they become the
critical path to first revenue.

Connect Hub explicitly does *not* cover **coach onboarding UI** — that is
product-side, i.e. Coachatron's screen #6 in SPEC.md §8.1.

---

## 3. Messaging

All sends go through the relay. Rules from SPEC.md §10 stand (transactional only,
`STOP` honored, quiet hours 9pm–8am local, per-recipient rate limits).

Inbound needs a **dedicated Coachatron Twilio number** registered in
`inbound.js ROUTES.sms`, pointing at `https://coachatron.com/webhooks/sms`.
`verify-products` will flag this as a GAP until the code change lands — that is
expected and documented, not a bug.

A20XX, TankRoom, Scholarmancy, and the Earl POC already occupy numbers there;
follow the same shape.

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
- **R4 — Coach-only.** NL control is authorized by the coach's verified phone
  number. Athlete and roster numbers reach only the keyword layer. An unknown
  number gets the public booking link and nothing else.
- **R5 — Bounded blast radius.** One intent affects one session or one broadcast.
  No "cancel everything next week" in Slice 1 — multi-entity operations go to the
  web UI.
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
zero-rated pilot costs us the texts and nothing else, which at this volume is
a few dollars.

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
