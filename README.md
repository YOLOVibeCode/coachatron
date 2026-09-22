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

## Run it

From a fresh clone:

```bash
npm ci          # install dependencies
npm run migrate # (optional) apply migrations to DATABASE_URL
npm run dev     # start server on localhost:3000
npm test        # run tests (uses PGlite, no database required)
```

## Status

Pre-implementation. The specification is the current artifact.

📄 **[SPEC.md](SPEC.md)** — full specification: scope, domain model, journeys,
payments, messaging, data model, and the explicit non-goals.

📄 **[docs/PLATFORM.md](docs/PLATFORM.md)** — what we *don't* build, because the
Noctusoft relay already has it: email, SMS, inbound routing, and Square
marketplace payments. Also the design for SMS natural-language control.

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

## License

MIT — see [LICENSE](LICENSE).
