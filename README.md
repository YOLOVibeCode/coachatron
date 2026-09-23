# Coachatron

**A coach sells their time. Coachatron takes the booking and the money.**

Booking and payments for independent coaches — goalkeeper trainers, pitching
coaches, swim instructors, tutors. Anyone who sells sessions with a capacity
limit and eventually needs a second pair of hands.

## Why

Existing options (Mindbody, Acuity, TeamSnap) are built for studios and clubs
with front-desk staff. A solo coach opens the setup wizard, meets fourteen
screens of configuration, and closes the tab. The problem isn't price — it's
that there's too much of it.

Coachatron does three things and refuses the rest:

- **Sell sessions** — drop-in, prepaid packages, or a monthly plan
- **Take the money** — straight into the coach's own merchant account; we never
  hold funds
- **Find a second coach** — when a session fills past a threshold, text the
  backup roster in priority order until someone claims it

Later, the coach runs all of it by texting the number in plain English.

## Prerequisites

- Node.js ≥ 20.11 (see `engines` in `package.json`). That's the whole list.
- No Postgres, no Docker, no database to install — tests run against
  [PGlite](https://pglite.dev) (Postgres compiled to WASM, in-memory).
- No accounts to create and no secrets required to run locally. Payments
  and SMS go through an in-process fake relay in tests (`test/fakes/relay.ts`),
  never a real Square or Twilio account.

## Run it

From a fresh clone:

```bash
npm ci             # install dependencies
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm test           # run the test suite (PGlite, no database required, no secrets)
npm run build      # compile to dist/
npm run dev        # start the server on http://localhost:3000
```

`npm run migrate` applies the SQL migrations in `src/db/migrations/` to
`DATABASE_URL` if you've set one (Postgres in production); it's optional for
local development, since `npm run dev` and `npm test` both work against
PGlite with no `DATABASE_URL` at all.

## Status

Slice 1 is implemented: all twelve screens below, tested against fakes of
the Square/Twilio-shaped relay (`docs/PLATFORM.md`). See `ROADMAP.md` for
the milestone-by-milestone build log.

📄 **[SPEC.md](SPEC.md)** — full specification: scope, domain model, journeys,
payments, messaging, data model, and the explicit non-goals.

📄 **[docs/PLATFORM.md](docs/PLATFORM.md)** — what we *don't* build, because the
Noctusoft relay already has it: email, SMS, inbound routing, and Square
marketplace payments. Also the design for SMS natural-language control
(Slice 2 — Slice 1 ships the `Y`/`N`/`STOP`/`HELP` keyword layer only).

## Design constraints

The spec enforces these; they're the reason the product exists.

| | |
|---|---|
| **Five-minute setup** | Landing page to a bookable, payable link, on a phone |
| **12 screens** | Slice 1's entire surface. A thirteenth requires deleting one. |
| **We never hold funds** | Coach is merchant of record; we take an application fee |
| **No native app** | Mobile web only |
| **Transactional messaging only** | No inbox, no campaigns, no chat |

## Branches

| Branch | Purpose |
|---|---|
| `main` | Released, deployable |
| `staging` | Release candidate; pre-production verification |
| `develop` | Integration branch for feature work |

## Screens

The twelve screens of Coachatron (Slice 1):

| # | Screen | Route(s) | Who |
|---|--------|----------|-----|
| 1 | Sign in | `/signin`, `/signin/otp`, `/signin/verify` | Coach |
| 2 | Schedule | `/app/schedule` | Coach |
| 3 | Session detail | `/app/sessions/:id`, `/app/sessions/:id/bookings/:bookingId/attendance`, `/app/sessions/:id/cancel` | Coach |
| 4 | Session types | `/app/session-types`, `/app/session-types/:id/generate-week` | Coach |
| 5 | Pricing | `/app/pricing`, `/app/pricing/package`, `/app/pricing/plan` | Coach |
| 6 | Roster | `/app/roster`, `/app/roster/:id/priority` | Coach |
| 7 | Money | `/app/money` | Coach |
| 8 | Public page | `/c/:handle` | Athlete |
| 9 | Booking form | `/c/:handle/sessions/:sessionId/book`, `/c/:handle/sessions/:sessionId/waitlist` | Athlete |
| 10 | Checkout | `/c/:handle/checkout/:bookingId` | Athlete |
| 11 | Manage booking | `/booking/:token`, `/booking/:token/cancel` | Athlete |
| 12 | Offer response | `/offer/:token` | Assistant coach |

All routes are server-rendered HTML. No SPA.

## Relay environment (sandbox)

To exercise real Connect Hub, SMS, and email against Noctusoft `ns` (not used in CI):

| Variable | Purpose |
| --- | --- |
| `RELAY_BASE_URL` | Hub base URL (sandbox: `https://api.square.noctusoft.com`) |
| `RELAY_API_KEY` | Product key for `coachatron`, sent as `X-Api-Key` |
| `RELAY_APP_ENV` | Set to `dev` so relay email is captured (smtp4dev) instead of delivered |

Do not commit secrets. `npm test` uses the in-process fake in `test/fakes/relay.ts`.

## Known gaps

- **No email confirmations.** `SPEC.md §7.2` describes an SMS + email
  confirmation; Slice 1 as built sends SMS only (the relay's `/email/send`
  exists and is exercised by the fake in tests, but nothing calls it yet).
  Tracked as `SPEC.md §15` item 7.
- **Monthly plan renewal isn't automated.** A parent's first month of
  credits is granted at purchase; granting the next month's credits each
  billing cycle needs a Connect Hub webhook this slice doesn't implement
  (see `ROADMAP.md` M3).
- **No refund-webhook automation.** Refunds are issued through the coach's
  own Square dashboard (`SPEC.md §9.4`); Coachatron doesn't automatically
  reverse a package credit if the coach later issues a partial refund.
- **The overflow cascade reuses the original session**, rather than
  creating a literal second "parallel session" row — the accepted backup
  coach is recorded on the same session via `assigned_roster_member_id`.
  See `ROADMAP.md` M4 for why.

None of these affect the three journeys in the product brief (booking +
payment, the overflow cascade, the read-only Money screen), which are all
covered by `test/journeys.test.ts`.

## License

MIT — see [LICENSE](LICENSE).
