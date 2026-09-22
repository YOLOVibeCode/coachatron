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
                              └── paid by: DropIn | PackageCredit | Subscription

Coach
  ├── Package            "10 sessions for $300" → issues 10 PackageCredits
  ├── Plan               "$120/mo, 4 sessions/mo" → issues credits monthly
  └── RosterMember       an assistant coach, reachable by SMS
        └── Offer        "Session #841 needs a coach" → accepted | declined | expired
```

Deliberately absent: Location, Program, Season, Team, Waiver, Membership Tier,
Family, Household. Each is a real concept in club software and each is a tax on
the solo coach. They return only when a paying customer is blocked without them.

---

## 7. Primary journeys

### 7.1 Coach onboarding (target: under 5 minutes)

1. Lands on `coachatron.com`, taps **Start**.
2. Enters name, phone, email. SMS one-time code verifies the phone. No password.
3. Creates first session type in one form: *what it's called, how long, how many
   athletes, how much*. Every other field is defaulted.
4. Picks recurring times on a weekly grid (tap the slots). Sessions are generated
   8 weeks ahead, rolling.
5. Connects payments (Square OAuth, one redirect). **Skippable** — the coach can
   share a booking link immediately and connect before the first payout.
6. Gets their link: `coachatron.com/c/<handle>`. Done.

Steps 5 and 6 are the only places a coach can fail. Everything before is
one-field-per-screen.

### 7.2 Athlete books and pays

1. Opens the coach's link. Sees a list of open sessions with date, time, spots
   left, price. No login wall.
2. Taps a session → enters athlete name, parent email, phone.
3. Chooses how to pay: **this session** ($35), **a package** (10 for $300), or
   **a monthly plan** ($120/mo). Existing credits are detected by phone number
   and applied automatically.
4. Pays. Square hosted checkout — we never touch card data.
5. Gets an SMS + email confirmation with a manage link (reschedule/cancel within
   policy).

### 7.3 Capacity overflow — the differentiating flow

1. A session type's bookings cross its **overflow threshold** (default: the
   session is full *and* a second athlete has joined the waitlist; configurable).
2. Coachatron does **not** auto-book anyone. It sends the coach one SMS:
   *"Tue 6pm is full with 3 waiting. Open a second group? Reply YES and I'll ask
   your roster."*
3. On YES, we create a parallel session and SMS the roster **in priority order**,
   one at a time, each with a short expiry (default 20 min):
   *"Coachatron: Tue Oct 7, 6pm, Field 3, 8 keepers, $80. Reply Y to claim."*
4. First acceptance assigns the session and stops the cascade. Everyone else gets
   nothing (no "sorry" spam).
5. Waitlisted athletes are told a slot opened and are charged only when they
   confirm.
6. If nobody accepts before the cascade exhausts, the coach gets one SMS saying
   so. No further nagging.

The rule that makes this safe: **the coach's YES is always required before any
money or commitment moves.** The system proposes; the coach disposes.

### 7.4 Coach gets paid

Money settles directly into the coach's Square account on Square's normal
schedule. Coachatron's fee is deducted at the time of the charge as an
application fee. There is no payout screen, no balance, no withdrawal. A coach
who wants to know what they earned looks at their own Square dashboard, or at our
read-only **Money** screen, which shows: booked this week, collected this week,
outstanding package credits (a liability), and next week's projected.

---

## 8. Scope by slice

### 8.1 Slice 1 — MVP (the 12 screens)

Ship nothing else until a real coach has taken real money through this.

**Coach-facing (7)**
1. Sign in (phone + OTP)
2. Schedule — this week's sessions, tap one to see who's in it
3. Session detail — roster of athletes, mark attendance, cancel session
4. Session types — list + create/edit (name, duration, capacity, price)
5. Pricing — packages and plans (create/retire)
6. My roster — assistant coaches, add by phone, reorder priority
7. Money — read-only summary (§7.4)

**Athlete-facing (4)**
8. Coach's public page — open sessions list
9. Booking form — athlete details
10. Checkout — pick drop-in / package / plan, then Square hosted payment
11. Manage booking — magic-link page to cancel or reschedule

**Assistant-facing (1)**
12. Offer response page — deep link from SMS; accept or decline (SMS reply also
    works; this page is the fallback)

**Included non-screen work:** Square OAuth connect, SMS send/receive via the
Noctusoft relay, overflow cascade engine, package-credit ledger, recurring
session generation, cancellation policy enforcement.

### 8.2 Slice 2 — after 10 paying coaches

- Coach-set cancellation/refund policy windows
- Multiple locations on a session type
- Athlete "my sessions" magic-link dashboard
- Assistant coach pay tracking (what we owe them, not payroll)
- iCal feed of a coach's schedule
- Basic reporting export (CSV)

### 8.3 Slice 3 — only if pulled

- Stripe as an alternative to Square
- Multi-coach accounts (a business with employees, not a roster)
- Niche landing pages (§12)

---

## 9. Payments and revenue

### 9.1 Architecture

Uses the **Noctusoft Connect Hub** pattern already specified for the relay:
Square Connect with **application fees** (Path A). The coach is the merchant of
record. Funds never enter a Noctusoft-controlled balance. This is a hard
architectural constraint, not a preference — holding funds would make us a money
transmitter.

Connect Hub Slice 1 is **built and tested** (~1,050 LOC, 68 passing tests,
mounted at `/connect/:productKey/*`) and already covers OAuth connect, a
runtime-enforced versioned recipient agreement, one-time charges with
`application_fee_money` and per-transaction override, and the full subscription
lifecycle. **Build against it; do not implement Square directly.**

What it has never done is run against a real Square Application. Eight
out-of-code activation steps gate the first real charge, three of them legal
(attorney review, recipient agreement, chargeback handoff). Those have no code
dependency and must start in parallel with Slice 1 or they become the critical
path to first revenue. Detail in `docs/PLATFORM.md` §2.

### 9.2 What an athlete can buy

| Mode | Shape | Notes |
|---|---|---|
| **Drop-in** | One session, one charge | Default. Always available. |
| **Package** | N sessions prepaid, credits drawn down per booking | Credits are a liability; surface on the Money screen. Expiry optional, default none. |
| **Subscription** | Monthly recurring, grants N credits/month | Unused credits expire at period end by default. |

Credits are tracked per **phone number**, not per account, so a parent booking
for two children with one phone draws from one pool.

### 9.3 Our cut

**Locked 2026-09-21: free to the coach, 4% application fee on each transaction**,
on top of Square's processing (~2.6% + 10¢ card-present, 2.9% + 30¢ online).

The rate is set for fairness and volume. A solo coach will not sign a monthly
bill before seeing money arrive. Four percent of money that now gets collected
is small enough to keep, and a lower rate is how the product spreads: one
coach's athletes, roster, and assistant coaches are how the next coach shows
up. Ease of use does that propagation. The text assistant — set something up
by text, or ask and wait for Y — is included in the 4%. It saves the same
admin work for a small book and a large one, so the launch rate stays flat
rather than climbing with the coach's lessons. FieldView's 10% is a different
product: a paid stream the team did not previously sell.

Raising the default later is a config change (`appFeeBps`), and a higher
default propagates to new charges without a release. When it changes, it
applies to coaches who connect after the change. Coaches already on 4% stay
on 4%. Pilot coaches can be zero-rated the same way, with no deploy.

Offer a **$49/mo, 0% fee** plan once a coach clears roughly $1,200/mo in
bookings — at 4%, that is the crossover, and letting them switch themselves
is how a growing coach stays.

Fee is configurable per-coach and per-transaction-type from day one (Connect Hub
supports this).

### 9.4 Refunds

Refunds are issued through Square by the coach. Coachatron reverses the package
credit and releases the session slot when the webhook arrives. **We do not
refund our application fee on partial refunds in v1** — this is stated plainly in
the coach's terms rather than hidden.

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

**Inbound SMS** is parsed for a small fixed vocabulary only in Slice 1: `Y`/`YES`,
`N`/`NO`, `STOP`, `HELP`. Anything else gets a single reply pointing at the web
link.

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
  **litellm-vm** (`https://api.noctusoft.com/v1`). No provider SDK. The model
  name is configuration on that VM, so swapping the small model does not change
  Coachatron code. Detail in `docs/PLATFORM.md` §4.4.
- **Time:** every session stores an explicit IANA timezone. Never store a naive
  local time. Half of all scheduling bugs live here.
- **Money:** integer minor units (cents). Never floats.
- **Idempotency:** every payment and every SMS send carries an idempotency key.
  Webhook handlers must be safe to replay — Square will replay them.

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
2. **No-show policy.** Does a no-show consume a package credit? Recommend yes by
   default, coach-overridable per booking — but confirm with the launch coach.
3. **Assistant coach payment.** Coachatron tells the coach what they owe an
   assistant. Do we ever move that money? Recommend no, indefinitely.
4. **Cancellation window.** Default 24h? Below that, does the athlete lose the
   credit? Needs a real answer before checkout copy is written.
5. **Multiple athletes, one parent, one session.** Book two children into the
   same session in one flow, or two passes? Affects the booking form materially.
6. **Trademark.** "Coachatron" needs a USPTO knockout search before any spend on
   brand assets.
