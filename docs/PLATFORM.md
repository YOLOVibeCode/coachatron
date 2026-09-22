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
    "appFeeBps": 400,
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

`appFeeBps: 400` is the 4% from SPEC.md §9.3. FieldView runs 1000 (10%) for
comparison. Per-transaction override is supported and bounded by
`app_fee_bps_max`, so pilot coaches can be zero-rated without a deploy.

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

### 4.4 Model routing — LiteLLM

All model calls go through the existing **LiteLLM VM at `llm.noctusoft.com`**
(live; `/health/liveliness` returns 200). Not the provider APIs directly.

- Dedicated **virtual key** for Coachatron with a hard monthly budget, so a loop
  or an abusive sender cannot run up a bill. Budgets and the SMS anomaly monitor
  are already wired on that VM.
- Key from **1Password at runtime** — never a `.env` in a deployed environment.
- Pin a **small, cheap model** (Haiku / Flash / mini class). This is closed-set
  classification over a 2-line prompt; frontier capability buys nothing here.
- Request **structured output** (JSON schema / tool-call), temperature 0.
- Set an explicit **timeout of ~3s** and fall back to the link reply. A coach
  texting from a parking lot would rather get a link fast than a perfect parse
  slowly.
- One retry, then fall back. Never a retry loop on an SMS path.

### 4.5 Cost

The AI is **not** the expensive part of this feature, and it is worth being
precise about that before optimizing the wrong thing.

A parse is roughly 200 input + 60 output tokens against a small model — a small
fraction of a cent, so a heavy coach at ~100 parsed messages a month costs cents.
**The outbound SMS costs more than the model call by roughly an order of
magnitude.** Twilio per-segment pricing dominates the unit economics of the
entire messaging feature.

Consequences for the design:

- Optimize **message count**, not token count. Layer 1/2 routing exists to keep
  volume off the model, but the bigger win is not sending avoidable texts at all.
- Keep every message inside **one 160-character segment** where possible. Two
  segments is two charges.
- The per-coach LLM budget is an **abuse stop, not a cost control.** Set it, then
  stop thinking about it.

### 4.6 Rollout

NL control is **Slice 2**, not Slice 1. Slice 1 ships the keyword layer only
(`Y`/`N`/`STOP`), because the cascade needs it and it needs no model at all.

Add the model layer once there is real inbound traffic to read: the actual
messages coaches send are the intent set. Guessing the set before launch is how
this feature grows twelve intents nobody uses.

---

## 5. Open items

1. Provision the Coachatron Twilio number; add to `inbound.js ROUTES.sms`
2. Add `reply.coachatron.com` to `ROUTES.email` + DNS
3. Start attorney review (§2.1 item 1) — long pole to first revenue
4. Create the Coachatron LiteLLM virtual key with a monthly budget
5. Decide the Slice-1 keyword vocabulary exactly (`Y/N/STOP/HELP` + what else)
6. Confirm `appFeeBps: 400` against the launch coach's actual volume
