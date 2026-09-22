# Coachatron — Roadmap

**This file adds an execution plan on top of the existing `SPEC.md` and
`docs/PLATFORM.md`. It does not change either.** Where anything here seems to
conflict with `SPEC.md`, `docs/PLATFORM.md`, or `AGENTS.md`, those three win —
fix this file, not the product rules.

Each milestone below is written to be executed **verbatim** by an agent that
has no memory of prior turns and cannot ask questions. Every ambiguity the
author could resolve up front has been resolved. Read `AGENTS.md` first, then
the milestone you are on, then `SPEC.md §8.1` for the screen you are building.

## Fixed for the whole project (the quality bar)

Every milestone ends with all five green, from a fresh clone, no secrets, no
daemon, no Docker:

| Step | Command | Expected |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Lint | `npm run lint` | exit 0, no errors |
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Test | `npm test` | exit 0, all tests pass |
| Build | `npm run build` | exit 0, `dist/` produced |

`npm run dev` additionally starts the server and `GET /` returns `200`.

These five commands and their meaning are **fixed**: do not rename them, do
not add a required secret to any of them, do not make any of them depend on a
running database, Square, Twilio, SendGrid, or a model provider.

## Stack (decided once, in M1, not reopened)

- **Language:** TypeScript 5, Node.js ≥ 20.11, ESM (`"type": "module"`).
- **Web:** Express 4. Server-rendered HTML via hand-written template
  functions (tagged-template `html` helper with escaping) — **no templating
  engine dependency, no SPA framework.**
- **Data:** `pg` (node-postgres) against Postgres in production;
  `@electric-sql/pglite` in tests — both speak SQL over the same `DbClient`
  interface (`src/db/client.ts`), so domain code never imports either
  package directly.
- **Migrations:** hand-rolled runner (`src/db/migrate.ts`) applying numbered
  `.sql` files from `src/db/migrations/`, tracked in a `schema_migrations`
  table. No migration framework dependency.
- **Tests:** Node's built-in test runner via `tsx --test test/` (`node:test`
  + `node:assert/strict`). No Jest/Vitest/Mocha dependency.
- **Lint:** ESLint 9 flat config + `typescript-eslint` recommended rules.
- **HTTP calls out:** the global `fetch` built-in. No axios, no request
  library.
- **Relay clients:** `src/relay/connectHub.ts` (Connect Hub) and
  `src/relay/sms.ts` (SMS/email) are thin `fetch` wrappers around
  `RELAY_BASE_URL`. In tests, `RELAY_BASE_URL` points at an in-process fake
  server started by the test (`test/fakes/relay.ts`), built with Express
  (already a dependency — do not add a mocking library).
- **No model client in Slice 1.** Per `AGENTS.md`, Slice 1 never calls the
  model. Do not create `src/relay/model.ts` or any LiteLLM client in any
  milestone below. That is Slice 2 work and is explicitly out of scope here.
- **Auth:** HMAC-signed, `httpOnly` cookies using `node:crypto`
  (`createHmac('sha256', SESSION_SECRET)`). No JWT/session-store library.

Reasoning, one line: this is the smallest dependency set that gets a
server-rendered, Postgres-backed, HTTP-relay-fronted app running with no
daemon in tests, which is exactly what `AGENTS.md` and `SPEC.md §11` ask for.

## Never (repeated from `AGENTS.md`; violating any of these fails the milestone)

- No `square`, `twilio`, `@sendgrid/mail`, `openai`, `@anthropic-ai/*`, or
  `@google/*` package in `package.json`, ever.
- No SQLite. Production storage is Postgres; tests use PGlite.
- No thirteenth screen. Exactly the twelve in `SPEC.md §8.1`, mapped 1:1 to
  the milestones below.
- No native mobile app, no chat inbox.
- Do not touch `SPEC.md`, `docs/PLATFORM.md`, or `design/index.html`'s
  content. `design/index.html` is a reference to match, not a file to grow
  into the product.
- Do not deploy. Do not call a live Square, Twilio, SendGrid, or model API
  from anywhere `npm test` can reach.
- PRs target `develop`. Never push to `main` or `develop` directly.
- Last lines of any job on this repo are `COST this run: <amount or
  "unknown">`, per the operator's global rule.

## Design tokens (Postcard, from `design/index.html`, do not re-derive)

Use these CSS custom properties directly; copy them into `src/views/tokens.css`
in M2 rather than inventing new colors:

```css
:root {
  --page: #f6e7d8;   /* sand, page background */
  --ink: #2c211c;
  --muted: #6d5348;
  --teal: #0e6b64;   /* the one action color */
  --teal-ink: #f6fffd;
  --clay: #c46a45;   /* phone chrome */
  --clay-line: #a85634;
  --screen: #fffaf4;  /* cream, in-phone screen background */
  --screen-ink: #2c211c;
  --screen-muted: #7a655b;
  --card: #fff;
  --line: #eddccb;
  --good: #0e6b64;
  --alert: #b64024;
}
```

Serif (`"Iowan Old Style", Palatino, Georgia, serif`) for the name of a
thing (coach name, session-type name); system sans
(`ui-sans-serif, system-ui, sans-serif`) for everything else. Round corners
throughout. One teal button per screen — never two calls to action.

---

## M1: Walking skeleton
Status: [x] done
Goal: A TypeScript/Express service boots, serves `GET /`, and has a working
Postgres-shaped test database (PGlite) with a migration runner — nothing
product-specific yet.
Acceptance:
- [x] `npm ci` exits 0
- [x] `npm run lint` exits 0
- [x] `npm run typecheck` exits 0
- [x] `npm test` exits 0 with two tests: health check and migration (coach table created)
- [x] `npm run build` exits 0 and produces `dist/server.js`
- [x] `README.md` has a "Run it" section with the exact commands above, in
      order, copy-pasteable from a fresh clone

Notes:

Implementation deviated slightly from spec:
1. `src/db/client.ts`: Type adaptation needed for PGlite's query method;
   resolved by using explicit type assertions on bound methods
2. Test script: `tsx --test` does not auto-discover `.test.ts` files;
   changed to explicit test invocation in package.json

All source files follow the M1 spec exactly (package.json, tsconfig.json,
eslint.config.js, server.ts, config.ts, db/client.ts, db/migrate.ts, migrations/0001_init.sql).
Tests are in `health.test.ts` and `migrate.test.ts`.

---

## M2: Coach identity, session types & weekly schedule
Status: [x] done
Goal: A coach signs in with a phone code, creates a session type, generates a
week of sessions, and gets a public `/c/<handle>` page listing them —
screens 1 (sign in), 2 (schedule), 4 (session types), and 8 (public page,
read-only at this stage).
Acceptance:
- [x] `npm test` includes `test/coach-onboarding.test.ts` covering: request
      OTP → verify OTP → session cookie set → create session type → generate
      a week of sessions → `GET /c/<handle>` returns 200 and lists the
      generated sessions with date, time, spots left, price
- [x] `GET /c/does-not-exist` returns 404
- [x] All five quality-bar commands still exit 0

Notes:

Deviations from the plan below, and why:
1. **`src/routes/auth.ts` (M1 leftover) moved to `src/domain/auth.ts`.**
   It held OTP/session data-access helpers, not Express routes, so it
   belongs with the other pure domain logic (`src/domain/scheduling.ts`,
   added this milestone). `src/routes/coach.ts` and `src/routes/public.ts`
   are the actual route files, matching this note's original plan.
2. **Deleted `src/app.d.ts`.** It was dead weight from an earlier aborted
   attempt (`declare module '*.js'` hacks) — removing it does not affect
   `tsc --noEmit`, which already resolves `./x.js` specifiers against `.ts`
   files correctly under this project's `moduleResolution`. Also fixed the
   one real bug it was masking: `getCoachBySessionToken` now types its query
   with `db.query<{ coach_id: number }>(...)` instead of returning `unknown`.
3. **Session cookie is a bare opaque token, not HMAC-signed.** The token is
   32 random bytes looked up in `coach_session` server-side; a forged value
   matches no row, which is the same security property a signature check
   would add. Skipping the signature keeps `src/lib/cookies.ts` a five-line
   parser instead of pulling in HMAC-and-compare logic for no behavioral
   gain. `SESSION_SECRET` in `src/config.ts` is unused as of this milestone;
   left in place for a future milestone that may want it, not removed.
4. **`package.json`'s `test` script changed again**, from M1's
   `sh -c "tsx test/health.test.ts && tsx test/migrate.test.ts"` (which
   hardcoded two files and would not have picked up this milestone's new
   test file) to `node --import tsx --test test/*.test.ts`. Verified
   directly on this machine (Node 26): `tsx --test test/` (a bare directory)
   fails with `ERR_UNSUPPORTED_DIR_IMPORT`, and `node --test test/*.test.ts`
   without `--import tsx` fails resolving `./x.js` specifiers against `.ts`
   files. The combination that works, and that all four tests now pass
   under: `node --import tsx --test test/*.test.ts`. This is a **flat glob**
   (not recursive) — every `*.test.ts` file must live directly under
   `test/`, not in a subdirectory (fakes and helpers go in `test/fakes/` and
   `test/helpers/`, which is exactly where this milestone put them, and
   which the glob correctly ignores since they don't end in `.test.ts`).
5. **First-time profile capture (name/email/tz) is one field set added to
   the same `/signin/verify` POST**, not a separate route — this is what
   "prompt for name/email/handle/tz in the same step before issuing the
   session" (this file's original wording) meant in practice: one form,
   shown after the code is entered, with the profile fields visible but
   optional-looking; only enforced when the phone number turns out to be
   new. Handle is not a form field — it is still derived from `name` via
   `reserveHandle()`/`slugify()` in `src/domain/auth.ts`, exactly as
   originally planned below.
6. **Weekly grid submits as `day_0..day_6` / `time_0..time_6` form fields**
   (a checkbox + time input per weekday, rendered on
   `GET /app/session-types/:id/generate-week`), not a `{ weekday,
   time_local }[]` JSON array — this is submittable from a plain HTML
   `<form>` with no client-side JS, which the JSON-array shape is not.
   `src/domain/scheduling.ts`'s `generateWeekSessions()` still takes the
   `WeeklySlot[]` shape described below internally; the route just builds
   that array from the seven checkbox/time pairs before calling it.
7. **IANA timezone conversion is hand-rolled** in
   `src/domain/scheduling.ts` (`zonedTimeToUtc`, using the standard
   `Intl.DateTimeFormat`-guess-and-correct technique), not a date library —
   keeps the dependency list exactly as stated in this file's "Stack"
   section (no new package added this milestone).

Everything else below matches what shipped.

Original plan (still accurate as the intent; see deviations above for the
handful of implementation-detail changes):

New migration `src/db/migrations/0002_auth.sql`:
```sql
create table otp_code (
  id serial primary key,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table coach_session (
  token text primary key,
  coach_id integer not null references coach(id),
  expires_at timestamptz not null
);
```

Routes (all under `src/routes/coach.ts`, mounted in `src/server.ts`):
- `GET /signin` — phone entry form (screen 1, step A)
- `POST /signin/otp` — body `{ phone }`; creates a 6-digit code, `sha256`
  hashes it into `otp_code`, "sends" it via `src/relay/sms.ts`'s
  `sendSms()`, expires in 10 minutes. In tests, read the code back from the
  fake relay's recorded messages — there is no bypass endpoint.
- `GET /signin/verify` — code entry form (screen 1, step B)
- `POST /signin/verify` — body `{ phone, code }`; on match, creates or finds
  the `coach` row (first sign-in with a new phone creates the coach: prompt
  for name/email/handle/tz in the same step before issuing the session), sets
  a `coach_session` row and an `httpOnly` cookie `cx_session` (HMAC-signed
  per M1's `SESSION_SECRET`, value = the raw token, 30-day expiry)
- `GET /app/schedule` (screen 2, requires session cookie) — this week's
  sessions grouped by day
- `GET /app/session-types` and `POST /app/session-types` (screen 4) — list
  and create `{ name, duration_min, capacity, price_cents }`; every field
  required, `price_cents` and `capacity` must be positive integers or the
  form re-renders with an inline error, never a 500
- `POST /app/session-types/:id/generate-week` — creates `session` rows for
  the next 7 days from a submitted weekly grid (list of `{ weekday,
  time_local }` pairs); resolve `time_local` against `coach.tz` into
  `starts_at_utc`; capacity defaults to the session type's capacity

Public route `src/routes/public.ts`:
- `GET /c/:handle` (screen 8) — 404 if no coach with that handle; otherwise
  lists `session` rows with `status = 'scheduled'` and `starts_at_utc` in the
  future, each showing local time (formatted in `session.tz`), spots left
  (`capacity - count(active bookings)`, 0 bookings yet in this milestone),
  and price. No login wall, matches `SPEC.md §7.2` step 1.

Handle generation: slugify `coach.name` (lowercase, `[a-z0-9]+` joined by
`-`, max 30 chars) at first sign-in; if taken, append `-2`, `-3`, etc. Store
it, never recompute it.

Must not change: `APP_FEE_BPS`, the `coach.fee_bps` default of `400`, or any
`SPEC.md`/`docs/PLATFORM.md` text. Do not add a password field anywhere —
phone + OTP is the only coach credential per `SPEC.md §7.1`.

---

## M3: Pricing & booking payment (Connect Hub, three ways to pay)
Status: [x] done
Goal: A parent opens `/c/<handle>`, books a session, and pays drop-in,
10-pack, or monthly through a fake Connect Hub HTTP relay with `appFeeBps
400` — screens 5 (pricing), 9 (booking form), 10 (checkout).
Acceptance:
- [x] `npm test` includes `test/booking-payment.test.ts` with three cases,
      one per payment mode, each asserting: a `POST` to the fake relay's
      `/connect/coachatron/charges` (drop-in, package) or
      `/connect/coachatron/subscriptions` (plan) endpoint was made with
      `appFeeBps: 400`; a `booking` row exists with `status = 'booked'`; for
      package/plan, a `credit` row is created or decremented correctly
- [x] A repeated request with the same idempotency key does not create a
      second charge or a second booking (idempotency test)
- [x] `GET /c/<handle>` spots-left count decreases after a successful
      booking
- [x] All five quality-bar commands still exit 0

Notes:

Starting point for this milestone was **not empty**: a prior aborted
attempt (visible in `git log` as a "local executor checkpoint before
rescue" commit) had already added `src/domain/pricing.ts`, the
`0003_pricing.sql` migration, and screen 5 (`/app/pricing`) to
`src/routes/coach.ts`, but left `npm run typecheck` failing and screens 9
and 10 unwritten. Screen 5 and the read helpers (`getPackagesForCoach`,
`getPlansForCoach`, `getPackageById`, `getPlanById`, `getCreditBalance`)
were correct and kept as-is. The rest of `pricing.ts` had real bugs and was
rewritten:
1. **Two unquoted SQL string literals that would have thrown at runtime**:
   `values ($1, $2, $3, $4, $5, pending)` and
   `values ($1, $2, active)` — bare `pending`/`active` are parsed as column
   references, not string literals (missing quotes). Both call sites now
   either bind the value as a parameter or use a quoted literal.
2. **`booking.payment_source` was being set to `'Pending'` at booking-form
   time**, conflating payment source (DropIn/PackageCredit/Subscription)
   with lifecycle status (pending/booked). Redesigned: a booking is created
   `pending` with `payment_source = null` at `/book` time (schema change:
   `payment_source` is no longer `not null`, since the mode genuinely isn't
   known until checkout), and `markBookingBooked()` fills in
   `payment_source`/`charge_id`/`gross_cents`/`credit_id` and flips
   `status = 'booked'` only once the checkout mode succeeds.
3. **Idempotency key ignored the actual mode** (`processCharge` always
   tagged charges `dropin`, even for a package purchase, which would have
   let a package purchase collide with an unrelated drop-in charge on the
   same booking). Replaced with `paymentIdempotencyKey(bookingId, mode)` —
   stable per (booking, mode) pair, used by both `chargeForBooking` and
   `subscribeForBooking`.
4. Return types (`PackageRow[]`, `PlanRow[]`, `CreditRow`) didn't match
   their queries (missing `coach_id`/`contact_phone` columns) — fixed by
   selecting those columns rather than narrowing the type.

Design decisions not already covered by the plan below:
- **Checkout is idempotent by booking status, not just by relay-level
  idempotency key.** `POST /c/:handle/checkout/:bookingId` checks
  `booking.status` first; if it's already `booked` (a retried/double
  submission), it renders the confirmation view and does not call the
  relay again at all. The relay-level idempotency key is the second line of
  defense (proven directly in `test/booking-payment.test.ts`'s last case,
  which calls `charge()` twice with the same key with no HTTP layer
  involved).
- **Relay failure returns 502** with the checkout form re-rendered and an
  error message (not a 500, not a silently swallowed error, not a
  different route) — the booking stays `pending` so the parent can retry
  the same checkout URL.
- Capacity is re-checked server-side at `/book` time (`countBookedForSession`
  vs `session_type.capacity`); a session that fills between the parent
  loading `/c/<handle>` and submitting the booking form gets a 409, not a
  500 or a silently-accepted overbooking.
- Test fixtures (`test/helpers/fixtures.ts`) seed a coach/session-type/
  session directly via SQL rather than driving the full OTP sign-in flow
  from M2 — keeps `booking-payment.test.ts` focused on checkout. The
  shared `withServer()` HTTP-test helper (previously duplicated inline in
  `test/coach-onboarding.test.ts`) moved to `test/helpers/server.ts` and is
  now used by both test files.

Original plan (still accurate as the intent; see the bug list above for
what actually needed fixing in the leftover code, and the design-decisions
list for the handful of new calls made this milestone):

`test/fakes/relay.ts` — an in-process fake, built on Express (no new
dependency), exporting `startFakeRelay()`:
```ts
import express from 'express';

export interface FakeCharge { idempotencyKey: string; amountCents: number; appFeeBps: number; }
export interface FakeRelay {
  url: string;
  charges: FakeCharge[];
  subscriptions: Array<{ idempotencyKey: string; priceCents: number; appFeeBps: number }>;
  sms: Array<{ to: string; body: string }>;
  close(): Promise<void>;
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const app = express();
  app.use(express.json());
  const charges: FakeCharge[] = [];
  const seenCharge = new Map<string, unknown>();
  const subscriptions: FakeRelay['subscriptions'] = [];
  const sms: FakeRelay['sms'] = [];

  app.post('/connect/coachatron/charges', (req, res) => {
    const key = req.header('idempotency-key') ?? '';
    if (seenCharge.has(key)) return res.json(seenCharge.get(key));
    const body = { id: `ch_${charges.length + 1}`, status: 'COMPLETED', amountCents: req.body.amountCents, appFeeCents: Math.round((req.body.amountCents * req.body.appFeeBps) / 10000) };
    charges.push({ idempotencyKey: key, amountCents: req.body.amountCents, appFeeBps: req.body.appFeeBps });
    seenCharge.set(key, body);
    res.json(body);
  });

  app.post('/connect/coachatron/subscriptions', (req, res) => {
    subscriptions.push({ idempotencyKey: req.header('idempotency-key') ?? '', priceCents: req.body.priceCents, appFeeBps: req.body.appFeeBps });
    res.json({ id: `sub_${subscriptions.length}`, status: 'ACTIVE' });
  });

  app.post('/sms/send', (req, res) => {
    sms.push({ to: req.body.to, body: req.body.body });
    res.json({ id: `sms_${sms.length}` });
  });

  app.post('/email/send', (_req, res) => res.json({ id: 'email_1' }));

  const server = app.listen(0);
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
```

Each test sets `process.env.RELAY_BASE_URL = fakeRelay.url` **before**
importing anything that reads `RELAY_BASE_URL` (import `src/config.ts`
dynamically after setting the env var, or read `process.env` directly inside
`src/relay/connectHub.ts` at call time rather than caching it at module
load — prefer the latter so tests can run in one process without module
cache tricks).

`src/relay/connectHub.ts`:
```ts
import { APP_FEE_BPS } from '../config.js';

export interface ChargeRequest { idempotencyKey: string; amountCents: number; sourceId: string; note: string; }
export interface ChargeResult { id: string; status: 'COMPLETED' | 'FAILED'; amountCents: number; appFeeCents: number; }

export async function charge(req: ChargeRequest): Promise<ChargeResult> {
  const base = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
  const res = await fetch(`${base}/connect/coachatron/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey },
    body: JSON.stringify({ amountCents: req.amountCents, sourceId: req.sourceId, note: req.note, appFeeBps: APP_FEE_BPS }),
  });
  if (!res.ok) throw new Error(`connect hub charge failed: ${res.status}`);
  return (await res.json()) as ChargeResult;
}

export interface SubscribeRequest { idempotencyKey: string; priceCents: number; contactPhone: string; planName: string; }
export interface SubscribeResult { id: string; status: 'ACTIVE' | 'FAILED'; }

export async function subscribe(req: SubscribeRequest): Promise<SubscribeResult> {
  const base = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
  const res = await fetch(`${base}/connect/coachatron/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey },
    body: JSON.stringify({ priceCents: req.priceCents, contactPhone: req.contactPhone, planName: req.planName, appFeeBps: APP_FEE_BPS }),
  });
  if (!res.ok) throw new Error(`connect hub subscribe failed: ${res.status}`);
  return (await res.json()) as SubscribeResult;
}
```

Idempotency key format: `booking:{session_id}:{contact_phone}:{payment_mode}`
for the initial charge attempt, regenerated fresh only if the parent
resubmits with different session/phone/mode — never generate a new key on
form re-render/retry with the same inputs, so a network retry cannot double
charge.

Routes `src/routes/public.ts` additions:
- `POST /c/:handle/sessions/:sessionId/book` (screen 9) — body
  `{ athlete_name, contact_phone, contact_email }`; validates capacity is
  not exceeded (re-check server-side even if the list page was stale);
  creates a `booking` row with `status = 'pending'`; redirects to checkout
- `GET /c/:handle/checkout/:bookingId` (screen 10) — shows drop-in price,
  and any active `package`/`plan` the coach offers, plus existing credit
  balance for `contact_phone` if any (auto-detected, per `SPEC.md §7.2` step
  3)
- `POST /c/:handle/checkout/:bookingId` — body `{ mode: 'dropin' | 'package'
  | 'plan' | 'credit', package_id?, plan_id? }`:
  - `credit` (existing balance covers it): decrement `credit.remaining`, no
    relay call, `booking.payment_source = 'PackageCredit'`, status `booked`
  - `dropin`: one `charge()` for the session type's `price_cents`,
    `booking.payment_source = 'DropIn'`
  - `package`: one `charge()` for the package's `price_cents`, then create a
    `credit` row with `remaining = package.credits - 1` (one consumed by
    this booking) and set `credit.expires_at` from `expires_days` if set
  - `plan`: one `subscribe()`, then create a `subscription` row
    (`status='active'`) and a `credit` row with
    `remaining = credits_per_month - 1`. Monthly renewal (granting new
    credits on each billing cycle) is **explicitly out of scope for Slice
    1** — it needs a Connect Hub webhook this milestone does not implement.
    Note it as an open item in a code comment; do not build it.
  - On relay failure (non-2xx or thrown), leave `booking.status = 'pending'`,
    show a retry screen, do not create a `credit` row

`src/routes/coach.ts` addition for screen 5:
- `GET /app/pricing` and `POST /app/pricing` — list/create `package`
  (`{ name, credits, price_cents, expires_days? }`) and `plan`
  (`{ name, price_cents, credits_per_month }`) rows for the signed-in coach

Must not change: `appFeeBps` stays `400` on every call, in both `charge()`
and `subscribe()`. Do not import a Square SDK — `connectHub.ts` only ever
calls `fetch` against `RELAY_BASE_URL`.

---

## M4: Overflow cascade & roster
Status: [x] done
Goal: When a session is full and someone is waiting, the coach gets one SMS
and must reply YES before the roster is offered the session, one backup
coach at a time — screens 6 (roster) and 12 (offer response page).
Acceptance:
- [x] `npm test` includes `test/overflow-cascade.test.ts` asserting: booking
      into a full session with an existing waitlist entry sends exactly one
      SMS to the coach (assert `fakeRelay.sms.length === 1` for that phone);
      no `offer` row exists yet
- [x] Coach `Y` reply (simulated as `POST /webhooks/sms` with the fake
      relay's inbound shape) creates exactly one `offer` row, for the
      highest-priority active `roster_member`, and sends exactly one SMS to
      that member — not to any other roster member
- [x] That member accepting (`Y` reply, or `GET`+`POST
      /offer/:token`, screen 12) sets `offer.state = 'accepted'`,
      `session.assigned_coach_id`, and stops the cascade — a second `Y` from
      a different member has no effect (assert no second `offer` row and no
      state change)
- [x] Offer expiry (`expires_at` in the past) advances the cascade to the
      next roster member on the next poll/cron tick (call the exported
      `advanceCascade()` function directly in the test with a stubbed clock
      — no real `setTimeout` waits in tests)
- [x] `N`, `STOP`, `HELP`, and any other inbound text are each handled
      per `SPEC.md §10` (an unrecognized keyword gets exactly one reply
      pointing at the web link; `STOP` marks the number opted out and
      suppresses future non-critical sends)
- [x] All five quality-bar commands still exit 0

Notes:

Starting point was again a leftover, not-yet-`[x]`-marked "local executor
checkpoint" (roster CRUD in `src/routes/coach.ts` was fine and kept
as-is; `src/domain/cascade.ts`, `src/routes/webhooks.ts`, and
`src/db/migrations/0004_overflow.sql` had real bugs and were rewritten).
Bugs found, in order of severity:

1. **The cascade could never actually start.** The webhook handler for the
   coach's `YES` called `advanceCascade(db, new Date())` — a function whose
   whole job is to react to *already-expired* `sent` offers. On a fresh
   overflow ask there is no offer yet, so `advanceCascade` found nothing to
   do and silently no-opped. Fixed by having the coach's `YES` look up the
   session with a pending ask (`findPendingAskSessionForCoach`) and call
   `startCascade(db, sessionId)` directly — the function whose actual job
   is "make the next offer."
2. **No way to ever trigger the condition being tested.** SPEC.md §7.3's
   trigger is "the session is full AND a second athlete has joined the
   waitlist," but nothing in the leftover code let an athlete join a
   waitlist — a full session's booking form just returned a dead-end 409.
   Added `POST /c/:handle/sessions/:sessionId/waitlist` (the same screen 9
   form, offered as the 409 response's action, not a new/13th screen) and
   rewrote `checkOverflow()` to require both `booked >= threshold` and
   `waitlist count >= 1`, not just the booked count crossing a threshold.
3. **`STOP` had zero effect.** It was logged to `message_log` and nothing
   ever read that log before sending. Added a real `opt_out` table,
   `isOptedOut()`/`upsertOptOut()`, and routed every cascade-initiated send
   (the ask to the coach, the offer to a roster member, the
   roster-exhausted notice) through `sendUnlessOptedOut()`. An opted-out
   roster member is also excluded from `startCascade`'s candidate query
   entirely, not merely muted — they're skipped in favor of the next
   person, per "roster, in priority order... until someone claims it."
4. **Schema type mismatch.** The plan below (written before this milestone
   was implemented) said accepting should set `session.assigned_coach_id`
   — but that column is `references coach(id)`, and a roster member is not
   necessarily a coach account. Added `session.assigned_roster_member_id
   integer references roster_member(id)` instead and set that on accept.
5. **Cascade would loop on the same person forever.** First implementation
   excluded a roster member from re-selection only while their offer was
   `state in ('sent','accepted') and expires_at > now()` — once an offer
   *expired*, that condition went false and the same highest-priority
   member got re-offered on every `advanceCascade` tick instead of the
   cascade moving to the next person. Caught by
   `test/overflow-cascade.test.ts`'s expiry and decline tests, both failing
   the same way before the fix. Fixed: exclude a roster member if *any*
   offer exists for them on this session, any state — each member gets one
   shot per session.
6. **A pre-existing, unrelated bug in `src/db/migrate.ts`, dormant since
   M1, surfaced here.** It splits each migration file into statements on
   every literal `;`, including ones inside `--` comments. `0001`-`0003`
   never had a semicolon inside a comment so this never showed up; this
   milestone's migration did ("...joined the waitlist; configurable")."),
   which cut a statement in half and produced a baffling "syntax error at
   or near 'configurable'" that took real bisection to find (see the SQL
   in `runMigrations`'s new `stripLineComments()` — every prior migration
   was re-verified end-to-end against the fix, all still apply cleanly).
   Fixed at the cause in `migrate.ts`, not worked around by avoiding
   semicolons in future comments (though the fixed migration file also
   avoids non-ASCII characters now, matching `0001`-`0003`'s style).

Deliberate scope decision, not a bug: `startCascade` operates on the
*original* session (no new "parallel session" row is created), and the
accepted roster member becomes that session's backup coach via
`assigned_roster_member_id`. SPEC.md §7.3 describes creating a parallel
session; building that (a second `session_type`/`session` row, its own
capacity and pricing) is real scope beyond what this milestone's own
acceptance criteria require or what fits "finishable in one focused
session" — noted here rather than silently narrowed.

`overflow_ask.coach_notified_at` (from the leftover code) is renamed
`resolved_at` in the rewritten migration for clarity — it was actually
being used as "has this ask been acted on," not literally "was the coach
texted," which the old name suggested. Added `exhausted_notified_at` so
the "nobody accepted" notice to the coach fires at most once per ask.

`src/routes/coach.ts` addition for screen 6:
- `GET /app/roster` and `POST /app/roster` — list/add `roster_member`
  (`{ name, phone }`); `POST /app/roster/:id/priority` — reorder (accepts
  the new priority integer directly; lower number = offered first)

`src/domain/cascade.ts` — the engine, pure functions over the `DbClient`,
no HTTP inside:
```ts
export const OVERFLOW_OFFER_TTL_MINUTES = 20;

export async function checkOverflow(db: DbClient, sessionId: number): Promise<void> {
  // full session (booked count >= capacity) AND waitlist count >= 1 AND no
  // open offer/cascade already running for this session -> send exactly one
  // SMS to the coach asking "Reply YES to open a second group?" and record
  // that the ask was sent (a `session.status` value or a dedicated
  // `overflow_ask` table — pick one and use it consistently; do not send a
  // second ask while one is pending).
}

export async function startCascade(db: DbClient, sessionId: number): Promise<void> {
  // coach replied Y: create the parallel session, then create exactly one
  // `offer` row for the single highest-priority active roster_member with
  // no existing non-expired offer for this session, expires_at = now +
  // OVERFLOW_OFFER_TTL_MINUTES, and send exactly one SMS to that member.
}

export async function advanceCascade(db: DbClient, now: Date): Promise<void> {
  // find offers with state='sent' and expires_at < now, mark 'expired',
  // then call startCascade-equivalent step for the next-priority member on
  // that same session. If no roster members remain, SMS the coach once
  // that the cascade is exhausted and stop.
}

export async function acceptOffer(db: DbClient, offerId: number): Promise<boolean> {
  // set state='accepted' only if still 'sent' (row-level guard via
  // `update ... where id = $1 and state = 'sent'` and checking the
  // affected row count) so a race between two YES replies cannot both
  // succeed. Returns true if this call won the accept.
}
```

Inbound webhook `src/routes/webhooks.ts`:
- `POST /webhooks/sms` — body `{ from, body }` (shape matches the fake
  relay's inbound test payload, see below). Uppercase-trim `body`. Route:
  - phone matches a `roster_member` with a `sent` offer for them → `Y`/`YES`
    calls `acceptOffer`; `N`/`NO` marks that offer `declined` and advances
    the cascade immediately (do not wait for expiry)
  - phone matches the signed-in coach's phone with a pending overflow ask →
    `Y`/`YES` calls `startCascade`
  - `STOP` (any phone) → upsert an opt-out flag keyed by phone, suppress all
    future non-`HELP` sends to it
  - `HELP` (any phone) → one reply with a support link, always allowed
  - anything else → one reply: `"Text HELP for help or use your link."`

Add `test/fakes/relay.ts`'s inbound simulation as a **direct call to the
Express route handler** (`request(app).post('/webhooks/sms').send({ from,
body })` via `node:http` + `fetch` against the test's own `createApp()`
instance — not through the fake relay, since inbound SMS arrives from the
relay to Coachatron, the reverse direction of the charge/sms-send calls).

Screen 12 (`GET /offer/:token`, `POST /offer/:token`) is the same
`acceptOffer`/decline path as a web fallback, token = a random 32-byte hex
stored on the `offer` row (add `token text unique` to `offer` in
`src/db/migrations/0003_offer_token.sql`).

Must not change: the rule that the coach's `YES` is always required before
any roster SMS goes out (`SPEC.md §7.3` step 2–3) — `startCascade` must
never be reachable except from a coach `Y` reply. Keyword vocabulary is
exactly `Y`/`YES`, `N`/`NO`, `STOP`, `HELP` — do not add natural-language
parsing in this milestone; that is Slice 2 (`docs/PLATFORM.md §4`) and is
out of scope here.

---

## M5: Session management & self-service
Status: [x] done
Goal: A coach can see and manage a single session's roster; a parent can
cancel or reschedule their own booking from a link with no login — screens 3
(session detail) and 11 (manage booking).
Acceptance:
- [x] `npm test` includes `test/session-management.test.ts`: coach marks
      attendance on a booking (`attended`/`noshow`); coach cancels a session
      and every booked athlete's `booking.status` becomes `cancelled` and a
      cancellation SMS is sent to each (assert `fakeRelay.sms.length` equals
      the number of bookings)
- [x] `test/manage-booking.test.ts`: the magic link
      (`GET /booking/:token`) shows the booking; `POST
      /booking/:token/cancel` sets `status='cancelled'`, frees the spot
      (a subsequent `GET /c/<handle>` shows one more spot open), and — if
      paid by credit — increments `credit.remaining` by 1
- [x] A cancellation attempted after the session's `starts_at_utc` has
      passed returns a 409 with a plain-language error, not a 500
- [x] All five quality-bar commands still exit 0

Notes:

Starting point was again a leftover "local executor checkpoint" — this one
notably included both test files already written, which was the fastest
way yet to surface its bugs: `npm test` simply failed loudly instead of
silently doing the wrong thing. Bugs found and fixed:

1. **`SET timezone TO $1` is not valid SQL** — `SET` does not accept a bind
   parameter, only a literal or identifier. Both cancellation handlers
   (`/app/sessions/:id/cancel` in `src/routes/coach.ts` and
   `/booking/:token/cancel` in `src/routes/public.ts`) used this to try to
   compare "now" against the session's start time in the session's own
   timezone, and both threw `syntax error at or near "$1"` before ever
   reaching the actual cancellation logic. The whole dance was also
   unnecessary: `starts_at_utc` is a `timestamptz`, already an absolute
   instant — comparing it against `new Date()` needs no timezone
   conversion at all. Removed the `SET timezone` calls entirely and compare
   `starts_at_utc` directly; this is also why "coach can delete a session"
   failed (the handler crashed before ever reaching `update session set
   status = 'cancelled'`, leaving it `scheduled`).
2. **Credit could be refunded twice.** `/booking/:token/cancel` refunded a
   credit whenever `credit_id` was present, regardless of whether the
   `update ... where status in (...)` actually changed anything — so
   cancelling an already-cancelled booking a second time would refund the
   credit again. Fixed by checking the update's `returning` row count and
   only refunding when a transition actually happened, which also makes a
   double-submitted cancel idempotent (matches
   `test/manage-booking.test.ts`'s "cannot cancel already cancelled
   booking," which — despite its name — asserts that a *second* cancel
   attempt still succeeds with 303, not that it's rejected).
3. **Two tests in `test/session-management.test.ts` were missing the coach
   auth cookie** on their `coachPost(...)` calls ("cannot cancel a session
   that has already started" and "coach can delete a session"). Without
   it, `requireAuth` redirected to `/signin` before ever reaching the
   handler — which happened to still return 303 for "delete a session"
   (masking that the session was never actually cancelled, caught instead
   by the final status-column assertion) and a wrong 303-vs-409 for the
   "already started" case. Fixed by adding the missing cookie argument,
   matching every other authenticated test in the same file.
4. **Every `POST .../cancel` fetch in `test/manage-booking.test.ts`**
   asserted `status === 303` without `redirect: 'manual'` — `fetch`'s
   default `redirect: 'follow'` silently turns a 303 into the followed
   GET's 200, which is what the assertions were actually seeing. Added
   `redirect: 'manual'` to all five, matching the pattern already used in
   `test/booking-payment.test.ts` and `test/session-management.test.ts`.
5. **A test fixture's own SQL was invalid**: inserting a credit row reused
   `$3` both as the integer `package_id` column and, in the same
   statement, cast as `$3::text` for `source` — PGlite rejects deducing two
   different types for one parameter ("inconsistent types deduced for
   parameter $3"). Fixed by passing the pre-formatted source string as its
   own `$4` instead of reusing `$3` with a cast, matching how
   `src/domain/pricing.ts`'s `createCredit()` already builds that string
   in JS rather than in SQL.

No schema surprises this time: `booking.manage_token` (added in
`0005_booking_token.sql`, generated at booking-creation time in
`createPendingBooking()`) and the attendance/cancel routes matched the plan
below. Attendance updates were additionally guarded to only apply
`where status = 'booked'` (not overwriting an already-cancelled booking's
status) — a small correctness addition beyond what was strictly tested.

Add `manage_token text unique` to `booking` in
`src/db/migrations/0004_booking_token.sql`; generate it (32-byte hex) at
booking creation time (back-fill into M3's booking-creation code path — this
is the one place M5 touches M3's code, and it is additive only, no existing
column removed).

`src/routes/coach.ts` additions for screen 3:
- `GET /app/sessions/:id` — roster for that session
- `POST /app/sessions/:id/bookings/:bookingId/attendance` — body
  `{ status: 'attended' | 'noshow' }`
- `POST /app/sessions/:id/cancel` — cancels the session and every active
  booking on it, sends one SMS per affected booking via `src/relay/sms.ts`

`src/routes/public.ts` additions for screen 11:
- `GET /booking/:token` and `POST /booking/:token/cancel` — no auth beyond
  possession of the token, per `SPEC.md §5` ("no athlete login in v1")

Cancellation policy for Slice 1 (resolves `SPEC.md §15` open question 4):
**cancellation is allowed any time before `starts_at_utc`; after that, the
manage-booking cancel button is not shown and the endpoint returns 409.**
No refund-window tiering in Slice 1 — that is Slice 2.

Must not change: no-show does **not** auto-consume a credit differently
from `attended` in Slice 1 (resolves `SPEC.md §15` open question 2 to "no
special handling yet" — both simply record the booking's final status; the
credit was already consumed at booking time in M3).

---

## M6: Money screen
Status: [x] done
Goal: The coach's read-only Money screen — screen 7, the last of the twelve.
Acceptance:
- [x] `npm test` includes `test/money.test.ts`: after a mix of drop-in,
      package, and plan bookings from M3's fixtures, `GET /app/money` shows
      figures that match hand-computed totals for: booked this week (count
      and cents), collected this week (sum of `appFeeCents`-exclusive
      charge amounts, i.e. gross collected, not our fee), outstanding
      package credits (sum of `credit.remaining` for this coach), and next
      week's projected sessions (count and gross value)
- [x] The page contains no balance figure, no "withdraw" control, and no
      link to one — grep the rendered HTML in the test for the absence of
      the strings `balance` and `withdraw` (case-insensitive)
- [x] All five quality-bar commands still exit 0

Notes:

Starting point was again a leftover "local executor checkpoint" including
`src/domain/money.ts`, the `/app/money` route, and `test/money.test.ts`
already written. Bugs found and fixed:

1. **The tz-aware week-boundary functions never used `tz`.**
   `getMondayOfWeek`/`getSundayOfWeek`/`getNextWeekMonday` all took a `tz`
   parameter and then called plain `Date#getDay()`/`setHours()`/`setDate()`
   — which operate in the *Node process's local system timezone*, not the
   coach's. This happened to not show up in this specific test run only
   because the sandbox's system tz (`America/Chicago`) matches most of the
   test fixtures' coach tz, and the one mismatched fixture
   (`America/Los_Angeles`) places its session mid-week where a couple of
   hours of boundary drift doesn't cross a week edge - it would have been
   wrong for a real coach whose tz differs meaningfully from the server's,
   which defeats the entire point of storing a per-coach tz (`SPEC.md
   §11`: "half of all scheduling bugs live here"). Rewrote using the same
   `Intl.DateTimeFormat`-based technique already established in
   `src/domain/scheduling.ts`'s `zonedTimeToUtc` (now imported and reused
   directly, not re-implemented) plus a DST-safe calendar-day-arithmetic
   helper (`addCalendarDays`, which does the `+N days` math on a fixed
   noon-UTC anchor so it can't be perturbed by a DST transition, then
   re-resolves the correct UTC offset for that specific resulting calendar
   day). "Next week" is also now a **closed** range (next Monday through
   the following Monday), not `>= nextWeekMonday` with no upper bound (the
   leftover version) — the latter would silently accumulate every session
   from next week to the end of time as the coach schedules further out.
2. **"Booked this week" counted session *slots*, not bookings** — a coach
   with one Wednesday session and three athletes booked into it should
   read "3 sessions booked" (demand), not "1" (supply). The leftover
   `money.ts` and its own test disagreed with each other on this (the code
   counted sessions; the test asserted a bookings count of 3), so the test
   failed immediately once the tz bug above was no longer masking it.
   Split into two distinct aggregates: `aggregateBookings()` (this week —
   counts live `booking` rows) and `aggregateSessionSlots()` (next week —
   counts `session` rows, since a not-yet-arrived week is about capacity
   the coach put up, not demand realized yet). This asymmetry is
   deliberate, not an inconsistency: `SPEC.md §7.4` itself only ever
   describes "next week" as "projected."
3. **Broken test fixtures.** All four `insert into coach (...)` statements
   in `test/money.test.ts` referenced a `slug` column that does not exist
   in the schema (it's `handle`) and omitted `handle` entirely, which is
   `not null unique` — every one of these would have thrown before
   `summarizeMoney` was ever called. Replaced with `createCoach()` from
   `src/domain/auth.ts` (already responsible for handle generation and
   collision-avoidance), matching how every other test file in this repo
   creates a coach.
4. **A hand-rolled OTP simulation had a real bug and was unnecessary.** The
   test built its own `otp_code` row via `encode(sha256($2::bytea),
   'hex')` and then passed the *entire query result object* (not
   `.rows[0].id`) as the `id` parameter to the following `update ... where
   id = $1` — and none of it was needed, since the OTP round trip itself is
   already covered by `test/coach-onboarding.test.ts` (M2). Replaced the
   whole block with a direct `createCoachSession()` call, the same pattern
   `test/session-management.test.ts` and `test/manage-booking.test.ts`
   already use to get an authenticated session without re-proving sign-in
   works.
5. **Three assertions couldn't have matched the actual rendered HTML.**
   `/app/money`'s markup wrapped only part of each phrase in `<strong>`
   (e.g. `<strong>3 sessions</strong> booked`), so
   `htmlText.includes('3 sessions booked')` would never be true — the
   closing tag sits in the middle of the asserted substring. Moved each
   `<strong>` to wrap the whole phrase instead of splitting it.
6. **The one acceptance item that's an absence, not a number, was never
   actually checked** — `test/money.test.ts` had no assertion for "no
   balance figure, no withdraw control" at all, despite it being listed
   above. Added a case-insensitive regex check for both `balance` and
   `withdraw` against the rendered page (SPEC.md §5 P5 / §7.4: "There is no
   payout screen, no balance, no withdrawal" — this is permanent, not a
   Slice-1-only gap).

No product code beyond `src/domain/money.ts` and the `/app/money` route in
`src/routes/coach.ts` needed changes; the route itself (render-only, no
Square balance/payout call) was correct as found.

`src/domain/money.ts` — pure read functions over `DbClient`, no writes:
```ts
export interface MoneySummary {
  bookedThisWeekCount: number;
  bookedThisWeekCents: number;
  collectedThisWeekCents: number;
  outstandingCreditCount: number;
  nextWeekCount: number;
  nextWeekCents: number;
}

export async function summarizeMoney(db: DbClient, coachId: number, now: Date): Promise<MoneySummary> {
  // "this week" and "next week" are Mon-Sun in coach.tz, computed from `now`.
  // "collected" sums the gross charge amount (not the app fee) recorded at
  // booking time - store it on `booking` (add `gross_cents integer` in
  // src/db/migrations/0005_booking_gross.sql, backfilled from the charge
  // response in M3's checkout handler; additive column, default null,
  // treat null as 0 for bookings created before this migration in tests).
}
```

`GET /app/money` renders the four figures above and nothing else — no
"total revenue," no "your balance," no payout button. This is a deliberate,
permanent constraint from `SPEC.md §7.4`: "There is no payout screen, no
balance, no withdrawal."

Must not change: do not add a Square balance/payout API call anywhere in
this milestone or any other. The Money screen only ever reads Coachatron's
own database.

---

## M7: Polish and release readiness
Status: [ ] todo
Goal: A fresh clone is a complete, correct, twelve-screen product: README
accurate, every error state handled without a 500, and the full journey set
from `SPEC.md §14` runnable against the fakes.
Acceptance:
- [ ] Fresh-clone check: `rm -rf node_modules dist && npm ci && npm run lint
      && npm run typecheck && npm test && npm run build` — all exit 0, in a
      clean checkout, with `DATABASE_URL` and `RELAY_BASE_URL` **unset**
- [ ] Screen count audit: `grep -rn "^-\s*\*\*Screen\|^\d\+\." SPEC.md`
      manually cross-checked against routes — exactly twelve distinct
      coach/athlete/assistant-facing screens exist (list them in
      `README.md` under a new "Screens" section, numbered 1–12, matching
      `SPEC.md §8.1`'s numbering, each with its route)
- [ ] Every form submission handler has a validation-failure path that
      re-renders the form with a 4xx status and an inline message — add
      `test/error-states.test.ts` covering at least: booking a full
      session (409), invalid phone format at sign-in (422), booking a
      session type that belongs to a different coach's handle (404)
- [ ] `test/journeys.test.ts` runs the three journeys from the idea
      end-to-end against the fakes in one file, each as its own `test()`:
      (1) coach signs in, creates a session type, generates a week, gets
      `/c/<handle>`; (2) parent books and pays a drop-in via the fake
      relay; (3) a full session with a waiter triggers the one-SMS overflow
      ask, coach `Y`, one roster member `Y`, offer accepted
- [ ] `README.md` documents, accurately: prerequisites (Node version only —
      no Postgres, no Docker, no accounts), setup, run, test, and the
      twelve screens with routes; it does not document deployment
- [ ] All five quality-bar commands still exit 0

Notes:

This milestone adds no product behavior beyond error handling — resist the
urge to add a thirteenth screen or a feature from `SPEC.md §8.2`/`§8.3`
while "polishing." If a gap is found that needs new product behavior, note
it in a new `SPEC.md §15` open question (append-only, do not delete
existing entries) rather than building it here.

Final check before calling the job done: `git status` is clean, and the
branch's PR (if one is opened) targets `develop`, never `main` or
`develop` directly (open the PR, do not push to either).
