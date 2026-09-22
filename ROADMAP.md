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
Status: [ ] todo
Goal: A TypeScript/Express service boots, serves `GET /`, and has a working
Postgres-shaped test database (PGlite) with a migration runner — nothing
product-specific yet.
Acceptance:
- [ ] `npm ci` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with at least two real tests: one HTTP test hitting
      `GET /`, one migration test asserting the `coach` table exists after
      `runMigrations()` against a fresh PGlite instance
- [ ] `npm run build` exits 0 and produces `dist/server.js`
- [ ] `npm run dev` starts and `curl -s -o /dev/null -w '%{http_code}'
      http://localhost:3000/` prints `200`
- [ ] `README.md` has a "Run it" section with the exact commands above, in
      order, copy-pasteable from a fresh clone

Notes:

Create these files exactly as given. Do not deviate from filenames or
script names — later milestones assume them.

`package.json`:
```json
{
  "name": "coachatron",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "tsx --test test/",
    "migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.12",
    "@types/express": "^4.17.21",
    "@types/node": "^22.5.0",
    "@types/pg": "^8.11.6",
    "eslint": "^9.9.0",
    "typescript": "^5.5.4",
    "typescript-eslint": "^8.3.0",
    "tsx": "^4.19.0"
  }
}
```

If `tsx --test test/` does not discover `*.test.ts` files on the installed
tsx version, replace the `test` script with
`"node --import tsx --test $(find test -name '*.test.ts' | tr '\\n' ' ')"`
wrapped for `sh -c`, i.e.
`"sh -c \"node --import tsx --test $(find test -name '*.test.ts')\""` —
whichever variant makes `npm test` exit 0 and discover every `*.test.ts`
file under `test/`. Do not switch to a different test framework to solve
this.

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`eslint.config.js`:
```js
// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
```

`src/config.ts`:
```ts
export const APP_FEE_BPS = 400;
export const PORT = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
export const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-not-a-secret';
```

`src/db/client.ts`:
```ts
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { DATABASE_URL } from '../config.js';

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let current: DbClient | undefined;

export function getDb(): DbClient {
  if (current) return current;
  current = DATABASE_URL
    ? wrapPool(new Pool({ connectionString: DATABASE_URL }))
    : wrapPglite(new PGlite());
  return current;
}

// Tests call this with a fresh PGlite-backed client per test file so tests
// never share state.
export function setDb(client: DbClient): void {
  current = client;
}

function wrapPool(pool: Pool): DbClient {
  return { query: (sql, params) => pool.query(sql, params as unknown[]) };
}

function wrapPglite(pglite: PGlite): DbClient {
  return { query: (sql, params) => pglite.query(sql, params as unknown[]) };
}
```

`src/db/migrate.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DbClient } from './client.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(db: DbClient): Promise<void> {
  await db.query(
    'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const appliedRows = await db.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(appliedRows.rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.query(sql);
    await db.query('insert into schema_migrations (name) values ($1)', [file]);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { getDb } = await import('./client.js');
  await runMigrations(getDb());
  console.log('migrations applied');
}
```

`src/db/migrations/0001_init.sql` — the domain model from `SPEC.md §11.1`,
verbatim in SQL (integer PKs via `serial`, no `pgcrypto`/`uuid` extension so
it runs unmodified on PGlite):
```sql
create table coach (
  id serial primary key,
  handle text not null unique,
  name text not null,
  email text not null,
  phone text not null unique,
  tz text not null,
  square_merchant_id text,
  fee_bps integer not null default 400,
  created_at timestamptz not null default now()
);

create table session_type (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  duration_min integer not null,
  capacity integer not null,
  price_cents integer not null,
  active boolean not null default true
);

create table session (
  id serial primary key,
  session_type_id integer not null references session_type(id),
  starts_at_utc timestamptz not null,
  tz text not null,
  location_text text,
  capacity_override integer,
  assigned_coach_id integer references coach(id),
  status text not null default 'scheduled'
);

create table booking (
  id serial primary key,
  session_id integer not null references session(id),
  athlete_name text not null,
  contact_phone text not null,
  contact_email text,
  payment_source text not null,
  credit_id integer,
  charge_id text,
  status text not null default 'booked',
  created_at timestamptz not null default now()
);

create table package (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  credits integer not null,
  price_cents integer not null,
  expires_days integer,
  active boolean not null default true
);

create table credit (
  id serial primary key,
  coach_id integer not null references coach(id),
  contact_phone text not null,
  package_id integer references package(id),
  remaining integer not null,
  source text not null,
  expires_at timestamptz
);

create table plan (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  price_cents integer not null,
  credits_per_month integer not null,
  active boolean not null default true
);

create table subscription (
  id serial primary key,
  plan_id integer not null references plan(id),
  contact_phone text not null,
  square_subscription_id text,
  status text not null default 'active'
);

create table roster_member (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  phone text not null,
  priority integer not null default 0,
  active boolean not null default true
);

create table offer (
  id serial primary key,
  session_id integer not null references session(id),
  roster_member_id integer not null references roster_member(id),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'sent'
);

create table waitlist (
  id serial primary key,
  session_id integer not null references session(id),
  contact_phone text not null,
  athlete_name text not null,
  created_at timestamptz not null default now()
);

create table message_log (
  id serial primary key,
  to_phone text not null,
  template text not null,
  body text not null,
  provider_id text,
  sent_at timestamptz not null default now(),
  status text not null default 'sent'
);
```

`src/server.ts`:
```ts
import express from 'express';
import { PORT } from './config.js';

export function createApp() {
  const app = express();
  app.get('/', (_req, res) => {
    res.status(200).type('html').send('<!doctype html><html><body><h1>Coachatron</h1></body></html>');
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => {
    console.log(`Coachatron listening on ${PORT}`);
  });
}
```

`test/health.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

test('GET / returns 200', async () => {
  const server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});
```

`test/migrate.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runMigrations } from '../src/db/migrate.js';

test('migrations create the coach table', async () => {
  const pglite = new PGlite();
  const db = { query: (sql: string, params?: unknown[]) => pglite.query(sql, params as unknown[]) };
  await runMigrations(db);
  const result = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_name = 'coach'",
  );
  assert.equal(result.rows.length, 1);
});
```

Add a `.gitignore` `dist/` entry check (already present) and update
`README.md`'s "Run it" section to list, in order: `npm ci`, `npm run
migrate` (optional locally, not required for tests), `npm run dev`, `npm
test`. Do not add a "Deploy" section — deploying is explicitly out of scope
for this job.

---

## M2: Coach identity, session types & weekly schedule
Status: [ ] todo
Goal: A coach signs in with a phone code, creates a session type, generates a
week of sessions, and gets a public `/c/<handle>` page listing them —
screens 1 (sign in), 2 (schedule), 4 (session types), and 8 (public page,
read-only at this stage).
Acceptance:
- [ ] `npm test` includes `test/coach-onboarding.test.ts` covering: request
      OTP → verify OTP → session cookie set → create session type → generate
      a week of sessions → `GET /c/<handle>` returns 200 and lists the
      generated sessions with date, time, spots left, price
- [ ] `GET /c/does-not-exist` returns 404
- [ ] All five quality-bar commands still exit 0

Notes:

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
Status: [ ] todo
Goal: A parent opens `/c/<handle>`, books a session, and pays drop-in,
10-pack, or monthly through a fake Connect Hub HTTP relay with `appFeeBps
400` — screens 5 (pricing), 9 (booking form), 10 (checkout).
Acceptance:
- [ ] `npm test` includes `test/booking-payment.test.ts` with three cases,
      one per payment mode, each asserting: a `POST` to the fake relay's
      `/connect/coachatron/charges` (drop-in, package) or
      `/connect/coachatron/subscriptions` (plan) endpoint was made with
      `appFeeBps: 400`; a `booking` row exists with `status = 'booked'`; for
      package/plan, a `credit` row is created or decremented correctly
- [ ] A repeated request with the same idempotency key does not create a
      second charge or a second booking (idempotency test)
- [ ] `GET /c/<handle>` spots-left count decreases after a successful
      booking
- [ ] All five quality-bar commands still exit 0

Notes:

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
Status: [ ] todo
Goal: When a session is full and someone is waiting, the coach gets one SMS
and must reply YES before the roster is offered the session, one backup
coach at a time — screens 6 (roster) and 12 (offer response page).
Acceptance:
- [ ] `npm test` includes `test/overflow-cascade.test.ts` asserting: booking
      into a full session with an existing waitlist entry sends exactly one
      SMS to the coach (assert `fakeRelay.sms.length === 1` for that phone);
      no `offer` row exists yet
- [ ] Coach `Y` reply (simulated as `POST /webhooks/sms` with the fake
      relay's inbound shape) creates exactly one `offer` row, for the
      highest-priority active `roster_member`, and sends exactly one SMS to
      that member — not to any other roster member
- [ ] That member accepting (`Y` reply, or `GET`+`POST
      /offer/:token`, screen 12) sets `offer.state = 'accepted'`,
      `session.assigned_coach_id`, and stops the cascade — a second `Y` from
      a different member has no effect (assert no second `offer` row and no
      state change)
- [ ] Offer expiry (`expires_at` in the past) advances the cascade to the
      next roster member on the next poll/cron tick (call the exported
      `advanceCascade()` function directly in the test with a stubbed clock
      — no real `setTimeout` waits in tests)
- [ ] `N`, `STOP`, `HELP`, and any other inbound text are each handled
      per `SPEC.md §10` (an unrecognized keyword gets exactly one reply
      pointing at the web link; `STOP` marks the number opted out and
      suppresses future non-critical sends)
- [ ] All five quality-bar commands still exit 0

Notes:

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
Status: [ ] todo
Goal: A coach can see and manage a single session's roster; a parent can
cancel or reschedule their own booking from a link with no login — screens 3
(session detail) and 11 (manage booking).
Acceptance:
- [ ] `npm test` includes `test/session-management.test.ts`: coach marks
      attendance on a booking (`attended`/`noshow`); coach cancels a session
      and every booked athlete's `booking.status` becomes `cancelled` and a
      cancellation SMS is sent to each (assert `fakeRelay.sms.length` equals
      the number of bookings)
- [ ] `test/manage-booking.test.ts`: the magic link
      (`GET /booking/:token`) shows the booking; `POST
      /booking/:token/cancel` sets `status='cancelled'`, frees the spot
      (a subsequent `GET /c/<handle>` shows one more spot open), and — if
      paid by credit — increments `credit.remaining` by 1
- [ ] A cancellation attempted after the session's `starts_at_utc` has
      passed returns a 409 with a plain-language error, not a 500
- [ ] All five quality-bar commands still exit 0

Notes:

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
Status: [ ] todo
Goal: The coach's read-only Money screen — screen 7, the last of the twelve.
Acceptance:
- [ ] `npm test` includes `test/money.test.ts`: after a mix of drop-in,
      package, and plan bookings from M3's fixtures, `GET /app/money` shows
      figures that match hand-computed totals for: booked this week (count
      and cents), collected this week (sum of `appFeeCents`-exclusive
      charge amounts, i.e. gross collected, not our fee), outstanding
      package credits (sum of `credit.remaining` for this coach), and next
      week's projected sessions (count and gross value)
- [ ] The page contains no balance figure, no "withdraw" control, and no
      link to one — grep the rendered HTML in the test for the absence of
      the strings `balance` and `withdraw` (case-insensitive)
- [ ] All five quality-bar commands still exit 0

Notes:

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
