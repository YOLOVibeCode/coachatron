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

## Status

Pre-implementation. The specification is the current artifact.

📄 **[SPEC.md](SPEC.md)** — full specification: scope, domain model, journeys,
payments, messaging, data model, and the explicit non-goals.

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

## License

MIT — see [LICENSE](LICENSE).
