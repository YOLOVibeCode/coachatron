# Coachatron — Specification

**Status:** Draft v0.1 · 2026-09-21
**Owner:** Ricardo Vega
**Launch customer:** an independent goalkeeper coach
**Companion doc:** [`docs/PLATFORM.md`](docs/PLATFORM.md) — relay integration, Connect Hub status, SMS natural-language control

---

## 1. What this is

A coach sells their time. Coachatron takes the booking and the money.

That is the entire product. Every feature below either helps an athlete buy time
from a coach, or helps a coach deliver and get paid for it. Anything that does
neither is out of scope, permanently.

---

## 2. The problem

An independent coach — goalkeeper trainer, pitching coach, swim instructor,
tutor — runs their business out of group texts, a paper roster, a Venmo handle,
and their own memory. It works until roughly twenty regular clients, at which
point they start losing money in three specific ways:

1. **Unbilled sessions.** Someone shows up, trains, and pays "next time." Next
   time does not always arrive.
2. **Unfilled capacity.** A 6pm slot goes half empty because nobody knew it was
   open. The coach still drives to the field.
3. **Refused demand.** Demand exceeds what one person can run, so the coach
   turns athletes away rather than taking on the coordination of a second coach.

Existing software does not solve this for them. Mindbody, Acuity, and TeamSnap
are built for studios and clubs that employ front-desk staff: full CRM,
marketing automation, membership tiers, retail POS, waivers, check-in kiosks. A
solo coach opens the setup wizard, meets fourteen screens of configuration, and
closes the tab. **The product is not too expensive for them. It is too much.**

---

## 3. Non-goals

These are not "later." These are things we do not build, so that the things we
do build stay usable. Any proposal to add one of these requires deleting
something else.

- No CRM, lead pipeline, or marketing automation
- No email campaign builder or newsletters
- No retail/inventory/POS
- No native mobile app (iOS or Android) — mobile web only
- No video hosting, drills library, or training-content CMS
- No athlete performance tracking, stats, or progress charts
- No team management, league scheduling, or tournament brackets
- No chat/messaging inbox — SMS and email are transactional only
- No white-labeling or custom domains in v1
- No multi-location / franchise hierarchy
- No payroll, tax filing, or 1099 generation for assistant coaches
- **We never hold funds.** Money moves from the athlete to the coach's own
  merchant account. We collect a fee on top. See §9.

---

## 4. Principles

These are testable constraints, not slogans.

**P1 — Five-minute setup.** From landing page to a bookable, payable session
link in under five minutes, on a phone. If a step cannot be completed in that
budget it is removed or deferred until after the first booking.

**P2 — One screen per job.** Every task a coach does regularly gets exactly one
screen. No settings tree. No tabs within tabs. If a screen needs a sub-screen,
the job is too big and gets split or cut.

**P3 — Defaults over configuration.** Every setting ships with a working
default. A coach who changes nothing still has a functioning business. Options
appear only after the behavior they modify has been used at least once.

**P4 — The 9pm phone test.** Every coach-facing action must be completable one
-handed, on a phone, in a parking lot, in under thirty seconds. Features that
require a laptop are not coach features.

**P5 — Money goes to the coach.** We are never the merchant of record and never
custody funds. This removes money-transmitter exposure, chargeback liability,
and payout scheduling from the product entirely.

**P6 — Simplicity budget.** Slice 1 ships in **12 screens or fewer** (§8.1).
Adding a thirteenth requires removing one. This number is a feature.

**P7 — Boring to operate.** No feature ships that requires the coach to learn a
new concept word. "Session," "package," "subscription," "roster" are the entire
vocabulary.

---

## 5. Roles

| Role | Who | What they can do |
|---|---|---|
| **Coach** | The business owner. One per account in v1. | Everything: session types, schedule, pricing, roster, money |
| **Assistant coach** | On the coach's roster. Invited by phone number. | See sessions assigned to them; accept/decline overflow offers; mark attendance |
| **Athlete / Parent** | The buyer. No account required to book. | Browse open sessions, buy, cancel within policy, see what they've bought |
| **Platform admin** | Us. | Support access, fee configuration, impersonation with audit trail |

**No athlete login in v1.** Booking is done by email + phone with a magic link
for managing an existing booking. Account creation is the single largest drop-off
point in booking flows and buys us nothing at this scale.

---

## 6. Domain model

```
Coach
  └── SessionType        "60-min Goalkeeper Group", capacity 8, $35
        └── Session      a dated instance: Tue Oct 7, 6:00pm, Field 3
              └── Booking   one athlete in one session
                              └── paid by: DropIn | PackageCredit | Pack (one-time)

Coach
  ├── Package            "10 sessions for $300" → issues 10 PackageCredits
  ├── Plan               "4 sessions for $120, one-time" → charged once, issues its credits (§9.2)
  └── RosterMember       an assistant coach, reachable by SMS
        └── Offer        "Session #841 needs a coach" → accepted | declined | expired
```

Deliberately absent: Location, Program, Season, Team, Waiver, Membership Tier,
Family, Household. Each is a real concept in club software and each is a tax on
the solo coach. They return only when a paying customer is blocked without them.

---

## 7. Primary journeys

### 7.1 Coach onboarding (target: under 5 minutes)

1. Lands on `coachatron.com` and types or texts their week: *what it's called, how
   long, how many athletes, how much, which days and times*.
2. Enters an email or a mobile number in one box, then the one-time code we send
   (by email, or by text to a US or Canadian mobile), and their name. No password.
   Email works from anywhere; a mobile can be added later for texts. A coach who
   texted their week taps the link we text back instead. The model runs only after
   the code or link proves who they are. *(Updated 2026-10-02.)*
   *(Updated 2026-11-03: a code works once and for 10 minutes, a new code ends
   the earlier ones, and a code stops working after 5 wrong tries. Email
   sign-in matches only an address a code has proved. Asking for codes, and
   the public forms that send texts, are limited per number or email and per
   client address; `docs/PLATFORM.md` §4.5.)*
3. The product shows what it understood, asks for anything missing (never guesses
   a price), and writes nothing until the coach taps **Publish**. *(Added 2026-09-30.
   The landing box and the texted week feed this same setup. The one-form session
   type and the weekly grid below remain as the by-hand fallback.)*
   Fallback: creates a session type in one form. Every other field is defaulted.
4. Picks recurring times on a weekly grid (tap the slots). Sessions are generated
   8 weeks ahead, rolling. *(Implemented: each weekly time is a `weekly_slot`,
   topped up by the one-minute tick job.)*
5. Connects payments on the Money screen: accepts the marketplace terms (v1),
   then a relay link opens Stripe's hosted onboarding (identity and bank
   details) and brings them back. **Skippable** — the coach can
   share a booking link immediately and connect before the first paid booking
   (charges are made on the coach's own Stripe account, so until then checkout
   cannot take a card).
   *(Updated 2026-11-03: Stripe Connect through the relay, not Square OAuth.
   Until the coach's account can take charges, each paid session on their
   page says "Booking opens soon" in place of Book; free sessions book as
   usual, and families who hold session credits can still book with them.
   Publishing texts the coach their page link and, until payments work, a
   payments link (one use, within 7 days) that signs them in on Money. One
   text says when payments are ready, and a coach who has not finished gets
   the link again about a day and about three days after publishing.
   `docs/PLATFORM.md` §2.2.)*
6. Gets their link: `coachatron.com/c/<handle>`. Done.

Steps 5 and 6 are the only places a coach can fail. Everything before is
one-field-per-screen.

### 7.2 Athlete books and pays

1. Opens the coach's link. Sees a list of open sessions with date, time, spots
   left, price. No login wall.
2. Taps a session → enters athlete name, parent email, phone. A parent can add
   more children in the same pass, up to the coach's limit (default 2, §9.5).
3. Chooses how to pay: **this session** ($35), **a package** (10 for $300), or
   **a monthly plan** ($120/mo). Existing credits are detected by phone number
   and applied automatically.
   *(Updated 2026-11-03: the spot is held for 15 minutes while the parent pays,
   counted again from when they pick a way to pay. One phone holds one spot
   per session at a time: sending the form again moves the hold to the new
   booking, and a payment for the earlier one still books it. A payment that arrives but cannot book (the session filled or
   started first) is kept for the coach, and the parent's pages say so.
   A plan is charged once, so parents and coaches see it as a one-time pack.
   Credits are used once the phone is proven: a code texted to it at
   checkout, or arriving from a manage link that was proven the same way.)*
4. Pays. A signed relay buy link opens Stripe's hosted checkout — we never touch
   card data. *(Updated 2026-11-03: checkout is reached by an unguessable
   token, not the booking number. Each payment event is recorded once and
   checked: it books the spot only when the amount matches and the session is
   still open with room. Any other payment is kept, and the coach sees it on
   Money under "Payments to resolve" (§7.4).)*
5. Gets an SMS + email confirmation with a manage link (reschedule/cancel within
   the coach's cancellation window, §9.5). *(Implemented 2026-11-03: a text
   when the parent chose texts, an email when they gave an address, and the
   manage link on the page they return to after paying.)*
   *(Reschedule implemented 2026-11-04: until the coach's window closes, the
   manage page lists the other upcoming sessions of the same session type
   with room, and the parent moves the booking to one of them. The booking
   keeps its manage link and its payment or credit: nothing is charged,
   refunded or drawn, and a later cancel follows the window from the new
   time. Room is counted the way a booking counts it, under the same session
   locks (both sessions', in id order), after the people waiting there, who
   keep their first claim; the spot the booking leaves goes to that
   session's waitlist in order. The children one payment paid for move
   together, so a refund of it still covers each of them (§9.4); children
   who each used their own credit move one at a time. A booking does not
   move once it is refunded or cancelled, while a refund of its payment is on
   its way, or when a child its payment also paid for is no longer booked.
   The parent gets the confirmation again with the new time (a text with
   their consent, an email to an address they gave), the 24-hour reminder
   follows the new time, and the coach sees the move on Session detail of
   both sessions, where a parent's cancel shows too. Inside the window the
   page says why the booking cannot move and keeps the cancel the policy
   allows. These are states of screen 11, not a new screen.)*

### 7.3 Capacity overflow — the differentiating flow

1. A session type's bookings cross its **overflow threshold** (default: the
   session is full *and* a second athlete has joined the waitlist; configurable).
2. Coachatron does **not** auto-book anyone. It sends the coach one SMS that
   asks which kind of help they want, and the Schedule screen asks the same
   question with buttons:
   *"Tue 6pm is full with 3 waiting. Reply 1 to open a second group, 2 to add a
   backup coach, N for no."* *(Decided 2026-10-14: the coach chooses each time.)*
   - **Second group:** a parallel session at the same time and place, with the
     same session type and capacity, run by the roster member who accepts.
   - **Backup coach:** the roster member who accepts joins the original
     session, and its capacity grows by the session type's capacity.
3. On 1 or 2, we SMS the roster **in priority order**, one at a time, each with
   a short expiry (default 20 min). The offer says which job it is:
   *"Coachatron: Tue Oct 7, 6pm, Field 3, 8 keepers, $80. Reply Y to claim."*
4. First acceptance assigns the roster member (to the new session, or to the
   original) and stops the cascade. Everyone else gets nothing (no "sorry"
   spam).
5. Waitlisted athletes are told a slot opened and are charged only when they
   confirm.
6. If nobody accepts before the cascade exhausts, the coach gets one SMS saying
   so. No further nagging.

The rule that makes this safe: **the coach's YES is always required before any
money or commitment moves.** The system proposes; the coach disposes.

*(Implemented 2026-11-04. A session is asked about once, and a coach answers
one question at a time: the next full session is asked about after that. 1,
2 and N answer only the coach's own open question, from the coach's phone or
the Schedule screen's three buttons; a Y gets the choices again. One offer is
out at a time, and the first acceptance is decided in one transaction holding
the ask's, the offer's and the session's rows, so it happens once. A roster
member who answers an offer that has closed is told so, once. A second group
is a new session linked to the full one. A roster member who cannot get texts is
not offered anything, and the coach is told who, once, with a link to send
them: screen 12 in its opt-in state, which records consent by the same rules
as the other forms. The new spots go to the waitlist in the order people
joined: a text when the parent chose texts, an email otherwise, each with a
link that holds the spot for 15 minutes, and a spot nobody claims in that
time goes to the next person. A text or email that does not go out just
then (the relay busy or down, or a sending limit reached) keeps that parent
first in line, and it is tried again after 5 minutes, then 10, 20 and 40,
then every hour; only someone with no texts and no working email is passed
over. The waitlist also gets a spot freed by a parent's cancel or a hold that
ran out, and keeps first claim on free spots until each person waiting has
been offered one: a hold that ran out is renewed only after them, unless its
payment was already made. A full session's card on the coach's page leads to
the booking form in its waitlist state, and a parent who books a spot
themselves leaves the line for that child. In quiet hours the offers wait
until 8am in the coach's zone, unless the session starts first. The coach is
told who took the job and how many waitlisted parents (one each, however many
children) were offered a spot. A coach's cancel, or the session starting, ends its question and
withdraws any offer still out.)*

### 7.4 Coach gets paid

Money settles directly into the coach's own Stripe account, and Stripe pays it
out to their bank on Stripe's schedule. Coachatron's fee is deducted at the time
of the charge as an application fee. There is no payout screen, no balance, no
withdrawal. The coach has no Stripe dashboard (§9.1), so a coach who wants to
know what they earned looks at our read-only **Money** screen, which shows:
booked this week, collected this week, outstanding package credits (a
liability), and next week's projected. Bank and identity details change in the
same Stripe-hosted form, opened from the Money screen.
*(Updated 2026-11-03: when the coach cancels a session, a parent who paid a
drop-in for it gets one session credit with the coach, with no expiry, as
package and pack bookings get their credit back. A returned credit goes back
to the credit it came from and keeps that credit's expiry: a pack's never
expires, and a package's expires with the package if the coach set an expiry.
The parent's cancel text and the coach's cancel summary say so. A payment
kept as credit this way still counts in collected, since it reached the
coach's account. Money also lists, under "Payments to resolve", payments that
reached the coach's account but did not book (the session filled or started
first, the amount did not match, or a second payment), with the parent's name
and number, for the coach to settle with the parent.)*
*(Updated 2026-11-04: the coach refunds a payment from Money or Session
detail, after a confirmation (§9.4). Money lists recent payments with their
Refund, a Refund on each payment under "Payments to resolve", refunds that
did not go through, the refunds made, and card disputes with what they
mean. A refunded booking is out of booked and collected, and Money shows
what was refunded this week.)*

---

## 8. Scope by slice

### 8.1 Slice 1 — MVP (the 12 screens)

Ship nothing else until a real coach has taken real money through this.

**Coach-facing (7)**
1. Sign in (email or mobile + one-time code)
2. Schedule — this week's sessions, tap one to see who's in it
3. Session detail — roster of athletes, mark attendance, cancel session, refund a paid booking
4. Session types — list + create/edit (name, duration, capacity, price)
5. Pricing — packages and plans (create/retire); a plan is shown as a one-time pack
6. My roster — assistant coaches, add by phone, reorder priority
7. Money — summary (§7.4), refunds and card disputes (§9.4), connecting payments

**Athlete-facing (4)**
8. Coach's public page — open sessions list
9. Booking form — athlete details
10. Checkout — pick drop-in / package / one-time pack, then Stripe hosted payment
11. Manage booking — magic-link page to cancel or reschedule

**Assistant-facing (1)**
12. Offer response page — deep link from SMS; accept or decline (SMS reply also
    works; this page is the fallback)

**Included non-screen work:** Stripe Connect onboarding, SMS send/receive via the
Noctusoft relay, overflow cascade engine, package-credit ledger, recurring
session generation, cancellation policy enforcement (the coach-set window and
credit rules in §9.5).

### 8.2 Slice 2 — after 10 paying coaches

- Coach-set refund policy (the cancellation window moved to Slice 1, §9.5)
- Multiple locations on a session type
- Athlete "my sessions" magic-link dashboard
- Assistant coach pay tracking (what we owe them, not payroll)
- iCal feed of a coach's schedule
- Basic reporting export (CSV)

### 8.3 Slice 3 — only if pulled

- ~~Stripe as an alternative to Square~~ Stripe is the processor today (§9.1).
  A second processor would be a relay change behind its neutral store
  contract, not Coachatron code.
- Multi-coach accounts (a business with employees, not a roster)
- Niche landing pages (§12)

---

## 9. Payments and revenue

### 9.1 Architecture

Uses the **Noctusoft Connect Hub** on the relay's neutral store contract
("v1"): **Stripe Connect** (Accounts v2) with **application fees**. Each coach
is a connected account and the merchant of record; charges are made on the
coach's own account. Funds never enter a Noctusoft-controlled balance. This is a
hard architectural constraint, not a preference — holding funds would make us a
money transmitter. *(Updated 2026-11-03: this section first described Square.)*

How the relay sets up each coach's account (`stripe/adapter.js` in the relay):

- **No Stripe dashboard** (`dashboard: "none"`). The coach never makes a Stripe
  login. The Money screen is their window onto bookings and collections.
- **Stripe collects its fees and carries losses**
  (`responsibilities: { fees_collector: "stripe", losses_collector: "stripe" }`).
  Stripe takes its processing fee from the coach's account, and a negative
  balance (after a dispute, say) is Stripe's to recover, not Noctusoft's.
- **Onboarding is Stripe-hosted.** After the coach accepts the marketplace
  terms (v1) on the Money screen, a relay link opens Stripe's form for identity
  and bank details, then returns to `/app/money`.
- **Platform fee: 500 bps (5%)**, held on the relay's Connect row for the
  product (§9.3). Coachatron never sends the fee; the relay applies it.

Checkout is a signed relay buy link (`GET /buy/connect/coachatron/:seller`)
that opens Stripe's hosted page. Coachatron hears back through signed store
events at `/webhooks/store` and holds no Stripe key, id, or card data.

Connect Hub (mounted at `/connect/:productKey/*`) also covers a
runtime-enforced versioned seller agreement, refunds, and seller
subscriptions. **Build against it; do not call Stripe or any processor
directly.** Coachatron uses the agreement, onboarding, seller status, and the
one-time buy link, and the seller refund today: a plan is sold as a one-time
pack, charged once (§9.2), and a coach refunds a whole payment from Money or
Session detail (§9.4). The legal steps (attorney review of
the marketplace terms, parent terms, and payments privacy notice) have no
code dependency; drafts are in `docs/legal/`. Detail in `docs/PLATFORM.md` §2.

### 9.2 What an athlete can buy

| Mode | Shape | Notes |
|---|---|---|
| **Drop-in** | One session, one charge | Default. Always available. |
| **Package** | N sessions prepaid, credits drawn down per booking | Credits are a liability; surface on the Money screen. Expiry optional, default none. |
| **Subscription** | Monthly recurring, grants N credits/month | Unused credits expire at period end by default. *Today the plan is charged once, at purchase, for its credits, so parents and coaches see it as a one-time pack whose sessions do not expire; monthly renewal is not built.* |

Credits are tracked per **phone number**, not per account, so a parent booking
for two children with one phone draws from one pool.

### 9.3 Our cut

**Locked 2026-09-22: free to the coach, 5% application fee on each transaction**,
on top of Stripe's processing (its standard US online card rate, 2.9% + 30¢,
when this was written), which Stripe takes from the coach's account.

The rate is the ease. A coach has a bookable link in five minutes, a parent
pays with no account, and a full session texts the next coach. On a $35
session that is $1.75, on top of Stripe. The text assistant — set something up
by text, or ask and wait for Y — is included. It is the same work for a small
book and a large one, so the rate stays 5% rather than climbing with the
lessons. A lower rate is still how the product spreads: one coach's athletes
and roster are how the next coach shows up. FieldView's 10% is a different
product: a paid stream the team did not previously sell.

The rate is one number per environment: `app_fee_bps` (500) on the relay's
Connect row, read at each charge. Changing it needs no deploy, and it changes
the fee for every coach in that environment at once; no connected coach keeps
the old rate. *(Updated 2026-11-03: this said a higher default would reach
only coaches who connect later.)*

Offer a **$49/mo, 0% fee** plan once a coach clears roughly $1,000/mo in
bookings — at 5%, that is the crossover, and letting them switch themselves
is how a growing coach stays. Like zero-rating a pilot coach, this needs a
per-coach rate, which is not built.

A per-coach or per-transaction-type fee needs a relay change first.
Coachatron's buy links carry no fee, and the relay gives a public buy link the
Connect row's rate; it takes another rate (up to `app_fee_bps_max`) only on an
authenticated checkout call, which Coachatron does not make. Detail in
`docs/PLATFORM.md` §1.1. *(Updated 2026-11-03: this said the fee was
configurable per coach and per transaction type from day one.)*

### 9.4 Refunds

*(Built 2026-11-04. This section first said refunds were not built and went
through Coachatron support.)* The coach has no Stripe dashboard (§9.1), so
Coachatron refunds for them, through the relay's seller refund route
(`POST /connect/:productKey/recipients/:seller/refunds`, `refund()` in
`packages/store-client`). Coachatron never holds the money: the refund comes
out of the coach's Stripe balance and goes back to the card that paid.

- **Where.** Session detail shows what each booking paid, with **Refund**.
  Money lists recent payments with theirs, and a Refund on each payment
  under "Payments to resolve". The coach confirms on the same screen, which
  says what the refund changes. No new screen.
- **Whole payments only.** A refund is the whole payment, and only while
  nothing it bought beyond its own booking has been used: a drop-in any
  time, including a no-show or a late cancel, except that one the parent
  cancelled in time, whose session the coach cancelled, or that the coach
  gave back (§9.5) is refundable only while the credit it became is unused;
  and a package or one-time pack while none of the credits it added has
  been used. Its own booking counts as its own session while it stands or
  was cancelled late, the same as a no-show (§9.5), and not once the coach
  gave that session back. Otherwise the screen says how many sessions were
  used and refunds nothing; a partial refund goes through Coachatron
  support. The relay's route takes an amount, so a partial refund needs
  only a product decision, not a relay change.
- **Once.** Each payment has one refund row (`refund`), so a second tap
  sends nothing. The relay is called with an idempotency key per payment
  and try: the same key again when its answer never came, a new one only
  after a refund failed.
- **Held while on its way.** From the moment the coach confirms, the credit
  the payment bought cannot be used, so nothing more is booked with it
  while Stripe confirms. A credit the payment becomes in the meantime (the
  coach cancels its session, the parent cancels in time, or the coach gives
  a no-show or late cancel back) is held the same way, and neither the
  parent's cancel text nor their manage page offers it. A refund that does
  not go through gives it back.
- **What a refund does,** once, whether the relay confirms at once or by the
  `marketplace.purchase.refunded` event: the booking it bought is marked
  refunded, and when its session is still to come its spot is free again
  and goes to the waitlist in order (§7.3);
  the session credits it bought are withdrawn for good (any already used are
  counted and shown, never below zero, and a booking that used one and is
  cancelled later gives nothing back); a
  payment under "Payments to resolve" leaves that list; and the parent is
  told once, by text if they chose texts and by email if they gave one.
- **Several children.** A booking pass (§9.5) is one payment for each child's
  booking, so its refund is of that whole payment, from any of those
  bookings: it ends every one that stands, withdraws the credits they left,
  and is counted once (a session a child's cancel turned into a credit that
  was spent counts as used). Money lists the payment once, with every child.
- **Refunds made elsewhere.** A refund event for a payment Coachatron did not
  refund is applied when it covers the whole payment. One for part of a
  payment changes nothing, and Money shows it under "Payments to resolve".
- **Failures.** `marketplace.purchase.refund_failed`, or a refusal from the
  relay, shows under "Payments to resolve" with a way to try again.
- **Disputes.** `marketplace.purchase.disputed`, `…dispute_won` and
  `…dispute_lost` are recorded (`payment_dispute`) and shown on Money with
  what they mean. Stripe handles disputes and Coachatron holds no funds; a
  dispute changes no booking or credit. A coach answers one through
  Coachatron support.

**We return our application fee with a refund** (in proportion for a partial
refund): the relay's seller refund does this, and the Money screen tells the
coach before they connect payments and on each refund's confirmation. Stripe
keeps its own processing fee. As before, this is stated plainly in the
coach's terms rather than hidden.

### 9.5 Booking policy

*(Decided 2026-10-14.)* Every rule has a default, so a coach who changes
nothing still has a working policy (P3). The coach changes the defaults on the
Pricing screen (screen 5) and waives a credit on Session detail (screen 3). No
new screen.

| Rule | Default | The coach can |
|---|---|---|
| **No-show** | The booking's credit is used | Waive it for that booking; the credit comes back |
| **Cancellation window** | 24 hours before the session starts | Set a different window |
| **Parent cancels before the window** | The credit comes back | — |
| **Parent cancels inside the window** | Treated as a no-show: the credit is used | Waive it for that booking |
| **Children per parent** | Up to 2 in one booking pass | Set a different limit |
| **Overflow** | The coach picks a second group or a backup coach each time (§7.3) | — |

Each child takes one spot and uses one credit (or one drop-in charge). The
manage-booking page tells a parent, before they confirm, when cancelling now
will use their credit. Card refunds still follow §9.4; these rules move credits
only.

*(Implemented 2026-11-04. The window is 0 to 168 hours and the limit 1 to 10
children. A parent's paid drop-in cancelled before the window becomes one
session credit with the coach, with no expiry. A late cancel's payment stays
with the coach and counts as collected. When the coach cancels the session
itself, a late cancel's credit comes back, and a credit already given back is
not given twice. A credit a refund withdrew (§9.4) gives nothing back: a
booking that drew on it says no credit comes back, and the coach is not
offered to give one back. The children of one booking pass are held, paid for and
booked together, each with their own manage link and confirmation. The
relay's buy link names one open amount with no quantity, so several
children's drop-ins are one charge of the price for each, and a package or
pack is offered only when it covers every child.)*

---

## 10. Messaging

All SMS and email route through the existing **Noctusoft messaging relay**
(Twilio for SMS, SendGrid for email). No new provider accounts.

**Transactional only.** Every message is triggered by an event and none are
marketing. Messages are short enough to read in a notification preview.

| Event | To | Channel |
|---|---|---|
| Booking confirmed | Athlete/parent | SMS + email |
| Session reminder (24h before) | Athlete/parent | SMS |
| Session cancelled by coach | All booked | SMS + email |
| Overflow threshold reached | Coach | SMS |
| Coach approved overflow → offer | Roster member (cascade) | SMS |
| Offer claimed / cascade exhausted | Coach | SMS |
| Slot opened from waitlist | Waitlisted athlete | SMS |
| Payment failed (subscription) | Athlete/parent | SMS + email |
| Payment refunded | Athlete/parent | SMS + email |

*(Updated 2026-11-03, as built: a booking confirmation carries the manage
link and goes by text when the parent ticked the texts box and by email when
they gave an address. A coach's cancel is texted, and returns a credit for
every paid booking, a paid drop-in included. A parent the text does not
reach (no consent, opted out, or the text failed or hit a limit) who gave an
email is emailed instead, once, with what was cancelled and any credit they
now hold; the cancel page says how many will be emailed, the coach's summary
counts them ("Texted 1 and emailed 1 of 3 parents"), and the session screen
lists the parents it could not reach. When a payment arrives for a session the coach
cancelled while the parent paid, it becomes credit and the parent is told the
same way as a confirmation. No subscription payment can fail while plans are
one-time packs. The coach also gets payment texts: the go-live text with the
page link and, until payments work, a payments link; one "You can take
payments now" text; and up to two set-up reminders. A refund is told once,
by text only with the parent's consent and by email only to an address they
gave, with the amount, what it was for, and the manage link.)*

**Inbound SMS** is parsed for a small fixed vocabulary only in Slice 1: `Y`/`YES`,
`N`/`NO`, `STOP`, `HELP`, plus `1` and `2` as the coach's answer to an overflow
ask (§7.3). Anything else gets a single reply pointing at the web link.
*(Updated 2026-11-03: an inbound text or status callback is acted on only
when the relay confirms Twilio's own signature checked out; anything else
changes nothing. `docs/PLATFORM.md` §3.)*

In Slice 2 this grows into **natural-language control** — the coach runs the
business by texting in plain English. Intent extraction goes through one
model interface. The only production implementation of that interface is the
LiteLLM relay on **litellm-vm**. Reads answer immediately;
anything that moves money, cancels a session, or messages athletes requires a
`Y` confirmation whose text is rendered by template code, never by the model.
Full design, safety rules, and cost model in `docs/PLATFORM.md` §4. This is still
not a chat interface (§3).

`STOP` handling, quiet hours (no non-urgent SMS 9pm–8am local), and per-recipient
rate limits are required, not optional.

**The fee has to survive the texts.** The full assistant stays: the coach texts
to schedule, to set a session up, or to answer the question we ask before
anything is changed, and athletes still get confirmations, reminders, and
overflow texts. Those ceilings sit above that month. Outbound SMS stops at
**300 segments per coach per day** and **2,000 per coach per month**. One
automatic reply per non-coach number per day. No message longer than one
segment. No destination priced above $0.02 per segment. Model calls stop at
**30 per coach per day** and **400 per month**, and the Coachatron model key
has a **$20 per month** ceiling. A coach using the whole feature stays under
these. The stop is there for a loop. Worked cost in `docs/PLATFORM.md` §4.5.

---

## 11. Technical direction

Decisions that can be made cheaply now; anything not listed is deliberately open.

- **Frontend:** server-rendered, mobile-first, no SPA framework unless a screen
  demands it. Total JS budget for the athlete booking flow: keep it small enough
  to load fast on stadium LTE. This flow is where revenue happens.
- **Visual:** Postcard, locked 2026-09-21. Sand ground, a clay phone, a cream
  screen, one teal action, round corners. Serif for the name of a thing, system
  sans for the rest. Reference `design/index.html`.
- **Backend:** one service, one database. No microservices, no queue in v1 — the
  overflow cascade is a scheduled job over a table, not a message bus.
- **Database:** Postgres. The credit ledger and the cascade both want
  transactions.
- **Hosting:** Railway, matching the rest of the estate.
- **Secrets:** 1Password at runtime. No `.env` in any deployed environment.
- **Model:** one interface in the product (`complete` a closed prompt, return
  structured output). Tests use a fake. Production calls the LiteLLM relay on
  **litellm-vm** (`https://ai.noctusoft.com/v1`). No provider SDK. The model
  name is configuration on that VM, so swapping the small model does not change
  Coachatron code. Detail in `docs/PLATFORM.md` §4.4.
- **Time:** every session stores an explicit IANA timezone. Never store a naive
  local time. Half of all scheduling bugs live here. *(2026-11-04: a weekly
  time keeps its clock time on the days the clocks change, read the way
  Postgres reads a repeated or skipped hour.)*
- **Money:** integer minor units (cents). Never floats.
- **Idempotency:** every payment and every SMS send carries an idempotency key.
  Webhook handlers must be safe to replay — the relay will replay them.

### 11.1 Data model sketch

```
coach(id, handle, name, email, phone, tz, square_merchant_id, fee_bps, created_at)
session_type(id, coach_id, name, duration_min, capacity, price_cents, active)
session(id, session_type_id, starts_at_utc, tz, location_text, capacity_override,
        assigned_coach_id, status)                      -- scheduled|cancelled|done
booking(id, session_id, athlete_name, contact_phone, contact_email,
        payment_source, credit_id, charge_id, status)   -- booked|cancelled|attended|noshow
package(id, coach_id, name, credits, price_cents, expires_days, active)
credit(id, coach_id, contact_phone, package_id, remaining, source, expires_at)
plan(id, coach_id, name, price_cents, credits_per_month, active)
subscription(id, plan_id, contact_phone, square_subscription_id, status)
roster_member(id, coach_id, name, phone, priority, active)
offer(id, session_id, roster_member_id, sent_at, expires_at, state)
                                                        -- sent|accepted|declined|expired
waitlist(id, session_id, contact_phone, athlete_name, created_at)
message_log(id, to_phone, template, body, provider_id, sent_at, status)
```

`credit.contact_phone` is the join key for a buyer, by design (§9.2). Normalize
to E.164 on write.

Added since the sketch (migrations 0013–0031): `request_limit` (fixed-window
counts per client address, phone, or email) and `otp_code.attempts`;
`coach.email_verified_at`; `coach_payments` (whether the coach can take
charges, and the payment texts owed) and `payments_link`;
`booking.hold_expires_at`, `booking.checkout_token`,
`booking.phone_verified_at`, and `booking.cancel_notice`; `store_event` (each
store event, handled once) and `payment_attention` (payments kept for the
coach to resolve). Migration 0019 adds `refund` (one row per refunded
payment: its status, try, and what it withdrew) and `payment_dispute`, and a
booking's status can be `refunded`. Migration 0020 adds `credit.refund_id`
(held while a refund is on its way) and `withdrawn_at`. Migrations 0021–0025 add
`overflow_ask.kind`, `closed_at` and `outcome`, `offer.kind` and `ask_id`,
`session.overflow_of` (a second group's full session), and
`roster_member.optin_token`; `waitlist.contact_email`, `state`,
`offer_booking_id`, `send_tries` and `retry_at`; `coach.cancel_window_hours`
and `children_per_booking`, `booking.late_cancel` and `waived_at`; and
`booking.pass_id` (the children of one booking pass). Migration 0026 adds
CHECK constraints for what the forms already check (capacity and duration
above zero, no negative price or credit balance, a package expiry above
zero), after moving any stored value they refuse to the nearest one they
take (a package expiry of 0 days, which already meant none, becomes null),
and indexes on the columns the pages, the tick and the send path filter on,
`booking.session_id` first. Migration 0027 adds `booking.price_cents` (the
session's price when the booking was made, which Money's "booked" total
reads), and records a plan purchase as payment source `Pack` with no
`subscription` row (rows from before read `one-time`). Migration 0028 adds
`otp_code.purpose` (`signin` or `credits`: a code works only for its own),
0029 `message_log.visitor` (a text set off by someone not signed in, for the
app-wide visitor ceiling; such a text is logged `reserved` before it goes,
and counts from then on), and 0030 `coach_payments.test_mode` (whether the
coach's payment account is a test one; production takes only live ones).
Migration 0031 adds `booking_move` (each move a parent made from a manage
link: the booking, the session it left and the one it joined).

Two column names predate the move to Stripe and were kept: `square_merchant_id`
is unused (a coach reaches their Stripe account through
`coach.connect_recipient_key`, the relay's seller key), and
`square_subscription_id` holds the relay's opaque payment reference for a plan
purchase made before migration 0027; nothing writes `subscription` now. `booking.charge_id` holds the same kind of reference. Coachatron
stores no Stripe id. `coach.fee_bps` (default 500) is stored but not sent to
the relay; the Connect row sets the fee (§9.3).

---

## 12. Positioning

**Build general, market niche.** Nothing in the model above is goalkeeper
-specific — it is sessions with capacity, sold three ways, with an overflow
roster. That serves pitching coaches, swim instructors, martial arts studios, and
tutors identically.

But the launch surface is narrow on purpose: "goalkeeper training software" is a
search term with almost no competition, while "coaching software" is a fight with
Mindbody's ad budget. One product, several landing pages, each speaking one
niche's language.

**Do not put "goalie," "keeper," or "soccer" in the product name, schema, or
URL structure.** The first customer is a design partner and a case study, not the
brand.

---

## 13. Non-functional requirements

- **Availability:** the athlete booking flow is the only truly critical path. A
  coach can live with an admin screen being down for an hour; a parent who cannot
  book at 9pm will not come back.
- **Performance:** public coach page and booking form render in under 1s on 4G.
- **Accessibility:** the booking flow must work with a screen reader and at 200%
  zoom. Parents are not all twenty-five.
- **Privacy:** athletes are frequently minors. Collect the minimum — name, and a
  parent's phone and email. No date of birth, no address, no photos in v1. Do not
  build anything that would pull us into COPPA scope.
- **Auditability:** every state change on money, offers, and bookings is
  append-only logged with actor and timestamp.
- **Data export:** a coach can export their athletes and bookings as CSV at any
  time, unprompted. Nobody trusts a system they cannot leave.

---

## 14. Success criteria

Slice 1 is done when the launch coach has, without assistance:

1. Set up their own session types and pricing
2. Taken at least $500 in real bookings through the product
3. Run one overflow cascade that a real assistant coach accepted
4. Stopped maintaining their parallel paper/text roster

Item 4 is the only one that matters. The others are how we get there.

---

## 15. Open questions

1. ~~**Connect Hub readiness.**~~ **Answered 2026-09-21: build against it.** It
   is implemented and tested, including subscriptions. The remaining risk moved
   from engineering to legal/ops — see `docs/PLATFORM.md` §2.1.
2. ~~**No-show policy.**~~ **Answered 2026-10-14:** a no-show uses the credit,
   and the coach can waive it per booking. See §9.5.
3. **Assistant coach payment.** Coachatron tells the coach what they owe an
   assistant. Do we ever move that money? Recommend no, indefinitely.
4. ~~**Cancellation window.**~~ **Answered 2026-10-14:** the coach sets it,
   default 24 hours. Cancelling inside it uses the credit, like a no-show, and
   the coach can waive it. See §9.5.
5. ~~**Multiple athletes, one parent, one session.**~~ **Answered 2026-10-14:**
   one flow, up to a coach-set limit, default 2 children. See §9.5.
6. **Trademark.** "Coachatron" needs a USPTO knockout search before any spend on
   brand assets.
7. **Email confirmations (§7.2 step 5, §10).** Slice 1 as built sends SMS
   only for booking confirmations, cancellations, and the overflow flow —
   no email. The relay's `/email/send` exists and is exercised by the fake
   in tests, but no Coachatron code calls it yet. The build brief for
   Slice 1 ("Must have") only ever specified SMS; email confirmation was
   never in a milestone's acceptance criteria across the build. Recommend
   deciding whether email is Slice 1 scope (small addition: one relay call
   alongside the existing SMS confirmation) or explicitly Slice 2, rather
   than leaving it an unstated gap.
   **Answered 2026-11-03:** booking confirmations, and the notice when a
   payment for a cancelled session becomes credit, go by email too when the
   parent gave an address.
