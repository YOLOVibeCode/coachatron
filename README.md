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

- **Sell sessions** — drop-in, prepaid packages, or one-time packs
- **Take the money** — straight into the coach's own Stripe account (Stripe
  Connect, through the Noctusoft relay); we never hold funds
- **Find a second coach** — when a session fills past a threshold, text the
  backup roster in priority order until someone claims it

Later, the coach runs all of it by texting the number in plain English.

## Prerequisites

- Node.js 24 (the current LTS). `.nvmrc` names it, so `nvm use` (or a shell
  that switches on `.nvmrc`) picks it up; `npm ci` refuses an older Node
  (`engine-strict` in `.npmrc`). That's the whole list.
- No Postgres, no Docker, no database to install — tests run against
  [PGlite](https://pglite.dev) (Postgres compiled to WASM, in-memory).
- No accounts to create and no secrets required to run locally. Payments
  and SMS go through an in-process fake relay in tests (`test/fakes/relay.ts`),
  never a real Stripe or Twilio account.

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

End-to-end test: `test/north-star.test.ts` runs in `npm test` and follows one
coach from a texted week to a parent's paid booking through the real routes
(text in, start link, preview, Publish, the texted page and payments links,
"Booking opens soon" until payments work, connect payments, the payments-ready
text, book, checkout by its token, signed buy link, payment event, the
confirmation with the manage link, manage page), against the fake relay and a
fake model.

`npm run migrate` applies the SQL migrations in `src/db/migrations/` to
`DATABASE_URL` if you've set one (Postgres in production); it's optional for
local development, since `npm run dev` and `npm test` both work against
PGlite with no `DATABASE_URL` at all.

## Status

Slice 1 is implemented: all twelve screens below, tested against a fake of
the relay's marketplace (Stripe Connect behind it) and its SMS and email
(`docs/PLATFORM.md`). See `ROADMAP.md` for the milestone-by-milestone build log.

📄 **[SPEC.md](SPEC.md)** — full specification: scope, domain model, journeys,
payments, messaging, data model, and the explicit non-goals.

📄 **[docs/PLATFORM.md](docs/PLATFORM.md)** — what we *don't* build, because the
Noctusoft relay already has it: email, SMS, inbound routing, and marketplace
payments on Stripe Connect. Also the design for SMS natural-language control
(Slice 2 — Slice 1 ships the `Y`/`N`/`STOP`/`HELP` keyword layer only).

📄 **[docs/legal/](docs/legal/)** — drafts for attorney review, not in effect: coach marketplace terms (v1), parent terms, payments privacy.

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
| 1 | Sign in (and the texted payments link) | `/signin`, `/signin/otp`, `/signin/verify`, `/p/:token` | Coach |
| 2 | Schedule (and voice setup) | `/app/schedule`, `/app/setup`, `/app/setup/publish`, `/app/setup/discard` | Coach |
| 3 | Session detail | `/app/sessions/:id`, `/app/sessions/:id/bookings/:bookingId/attendance`, `/app/sessions/:id/cancel` | Coach |
| 4 | Session types | `/app/session-types`, `/app/session-types/:id/generate-week` (weekly times), `/app/session-types/:id/slots/:slotId/remove` | Coach |
| 5 | Pricing | `/app/pricing`, `/app/pricing/package`, `/app/pricing/plan` | Coach |
| 6 | Roster | `/app/roster`, `/app/roster/:id/priority` | Coach |
| 7 | Money (and connecting payments) | `/app/money`, `/app/money/payments`, `/signout` | Coach |
| 8 | Public page | `/c/:handle` | Athlete |
| 9 | Booking form | `/c/:handle/sessions/:sessionId/book`, `/c/:handle/sessions/:sessionId/waitlist` | Athlete |
| 10 | Checkout | `/c/:handle/checkout/:token` | Athlete |
| 11 | Manage booking | `/booking/:token`, `/booking/:token/cancel` | Athlete |
| 12 | Offer response | `/offer/:token` | Assistant coach |

All routes are server-rendered HTML. No SPA.

## Relay environment

To exercise real Connect Hub, SMS, and email against Noctusoft `ns` (not used in CI):

| Variable | Purpose |
| --- | --- |
| `RELAY_BASE_URL` | Relay base URL for Connect Hub, SMS, and email calls (default `http://localhost:4000`) |
| `RELAY_API_KEY` | Relay key for this environment's Connect app, sent as `X-Api-Key` |
| `RELAY_CONNECT_PRODUCT` | The relay Connect app: `coachatron-dev`, `coachatron-uat`, or `coachatron` (default). Its Connect row decides test or live payments; use `coachatron-dev` for test mode |
| `RELAY_WEBHOOK_SECRET` | That Connect app's signing key: signs buy links and verifies `/webhooks/store` |
| `STORE_BASE_URL` | Optional. Host for signed buy links (`/buy/connect/…`); defaults to `RELAY_BASE_URL`, then the relay's store host `https://store.noctusoft.com` |
| `STORE_WEBHOOK_URL` | Optional. The URL store events are signed for, checked on `/webhooks/store`; defaults to `APP_BASE_URL` + `/webhooks/store` |
| `RELAY_APP_ENV` | Set to `dev` so relay email is captured (smtp4dev) instead of delivered |

Do not commit secrets. `npm test` uses the in-process fake in `test/fakes/relay.ts`.

## Known gaps

- **Plans are one-time packs.** A plan is charged once: checkout charges the
  pack's price one time and grants its sessions as credits that do not
  expire, and nothing renews it, so the Pricing screen and checkout call it a
  one-time pack. Monthly renewal would use the relay's seller subscriptions,
  which this slice doesn't call (see `ROADMAP.md` M3).
- **Refunds are not built.** Coaches have no Stripe dashboard, so there is
  no refund button anywhere yet; the Money screen tells a coach to ask
  Coachatron. The relay already has a seller refund route
  (`POST /connect/:productKey/recipients/:seller/refunds`, which returns
  Coachatron's fee with the refund). A later change will call it and reverse
  a credit when `marketplace.purchase.refunded` arrives (`SPEC.md §9.4`).
  Until then a payment that reached the coach but could not book is listed
  on Money for the coach to settle with the parent (see "Booking and paying").
- **The overflow cascade reuses the original session**, rather than
  creating a literal second "parallel session" row — the accepted backup
  coach is recorded on the same session via `assigned_roster_member_id`.
  See `ROADMAP.md` M4 for why.

## Joining

A coach signs in with one box: an email or a mobile number. An email gets a
6-digit code by email (it works anywhere); a US or Canadian mobile gets the code
by text. Sign-in emails go through the relay's `/email/send` from its shared
sender with the name "Coachatron" until `COACHATRON_EMAIL_FROM` names an
authenticated coachatron.com address. A coach who joined by email adds a mobile
on the schedule screen to get texts; until then the overflow question arrives by
email and is answered on the schedule screen.

A code works once and for 10 minutes, a new code ends the earlier ones, and a
code stops working after 5 wrong tries. Email sign-in matches only an address
that a code sent to it has proved. Asking for codes and checking them are
limited per number or email and per client address (`docs/PLATFORM.md` §4.5).

## Going live and taking payments

Publishing a week texts the coach once (when they have a mobile and ticked the
texts box) with their page link and, until payments work, a payments link
(`/p/:token`): it works once within 7 days, signs the coach in, and opens
Money, where they accept the terms and connect payments. Until the relay says
the coach's account can take charges, each paid session on `/c/:handle` shows
**Booking opens soon** instead of Book, and nothing leads a parent to a
payment page; free sessions book as usual, and families who hold session
credits with the coach can still book with them. When charges turn on, the
coach gets one "You can take payments now" text, held until 8am if it is
quiet hours. A coach who published but has not finished gets the payments
link again about a day and about three days after publishing, two reminders
at most. Whether a coach can take charges is saved (`coach_payments`), so the
public page does not ask the relay on every view.

## Booking and paying

- **Spot holds.** Starting a booking holds the spot for 15 minutes while the
  parent pays, counted again from when they pick a way to pay. One phone
  holds one spot per session at a time. Starting a booking is limited per
  client address (20 an hour, 60 a day).
- **Checkout** is reached by an unguessable token, not the booking number.
  Using session credits needs a code texted to the booking's phone, or a
  manage link whose booking was proved the same way.
- **Payment checks.** Each paid event from the relay is recorded once
  (`store_event`), so a redelivery or a restart never handles it twice; one
  that another delivery is still handling is answered so the relay retries
  it. A payment books the spot only when its booking is waiting for it, the
  amount matches the price, and the session is still open with room. Any
  other payment (the session filled or started first, the amount differs, a
  second payment, a booking or pack that no longer exists) reached the
  coach's account but books nothing: it is kept with its reason
  (`payment_attention`) and listed on Money under **Payments to resolve**
  with the parent's name and number, and the parent's pages say the coach
  has the payment instead of asking them to pay again.
- **Confirmations.** A booked parent gets a confirmation with the manage
  link, by text when they ticked the texts box and by email when they gave an
  address; the page they return to after paying shows the link too.
- **A coach's cancel** returns a credit for every paid booking: a package or
  pack credit comes back, and a paid drop-in becomes one session credit with
  the coach, with no expiry. Each parent who chose texts is told; the session
  screen shows who could not be reached. A payment that arrives for a session
  the coach cancelled while the parent was paying becomes credit the same
  way, and the parent is told by text or email.

## Texting in

A coach can text their week to the Coachatron number once it exists. The relay
forwards Twilio's form fields to `/webhooks/sms`, signed with
`x-relay-signature`; the app checks it when `RELAY_INBOUND_SECRET` is set. The
app acts on an inbound text or status callback only when the relay also says
Twilio's own signature checked out (`x-relay-twilio-verified: 1`); anything
else gets an empty TwiML 200 and changes nothing. One number serves every
environment for sending; incoming texts go to uat while testing and to
production at launch (`docs/PLATFORM.md` section 3).

## Testing texts without a phone (development)

Development runs with `RELAY_APP_ENV=dev`. The relay then captures every text
and email instead of sending it, in smtp4dev at
[mail.dev.noctusoft.com](https://mail.dev.noctusoft.com/) (IP-allowlisted). A
text to `+1 555 555 0100` shows up as an email to
`sms-15555550100@sms.capture.noctusoft.com`. Nothing reaches a phone, so any
number, including one outside the US and Canada, can sign in on development to
try the text flows. uat and production leave `RELAY_APP_ENV` unset and really
send.

## Texting ceilings

Every outbound text goes through `sendText()` in `src/domain/outbound.ts`
(a test fails if anything calls the relay directly). Before it sends, it:
fits the text into one segment (flattening curly quotes, dashes, and the
narrow space `Intl` puts before "PM", so a text never silently becomes
UCS-2); refuses numbers outside `+1` (US and Canada, the destinations priced
near $0.0083 a segment); and stops at 300 texts per coach per local day,
2,000 per coach per month, 400 per active coach per day for the product
(never below 500), and 5 sign-in codes per number or email per day. Requests
that send a code, opt in at `/sms`, join a waitlist, start a booking, or use
the landing page's box are also limited per client address
(`src/domain/requestLimits.ts`). Every attempt, sent or stopped, is written
to `message_log`.

## Voice-setup eval (live model, opt-in)

`npm test` only ever uses a fake model. To check extraction against the
real one on litellm-vm, run `LITELLM_API_KEY=... npm run eval:setup`. It
runs the production prompt, schema, and validation over
`eval/setup-utterances.json` and prints PASS/MISS per case. The starter
cases are synthetic; add the launch coach's real descriptions before
trusting the number.

## Background job

The running server ticks once a minute (`src/jobs/tick.ts`). Each tick keeps
every weekly time 8 weeks ahead on the calendar, passes an expired overflow
offer to the next backup coach, and sends 24-hour reminders outside quiet
hours (9pm–8am in the coach's timezone). It also asks the relay about coaches
still setting up payments (at most every 15 minutes each, in case an event
was missed), sends payments-ready texts that waited out quiet hours, and sends
the payment set-up reminders. Tests call `runTick()` directly
with a fixed clock; `createApp()` never starts the timer.

None of these affect the three journeys in the product brief (booking +
payment, the overflow cascade, the read-only Money screen), which are all
covered by `test/journeys.test.ts`.

## License

MIT — see [LICENSE](LICENSE).
