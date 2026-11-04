**DRAFT for attorney review. Not in effect. Not legal advice.**

# Coachatron Marketplace Terms for Coaches (v1)

*Draft of 2026-11-03. These are the terms named by the box on the Money screen,
"I accept the Coachatron marketplace terms (v1)". Version `v1` is the value of
`SELLER_AGREEMENT_VERSION` in `src/config.ts` and of the relay Connect app's
agreement version.*

Notes in square brackets, "[Attorney: ...]", are open questions for review. They
are not part of the terms. Facts about how the product works today come from
`SPEC.md` and `docs/PLATFORM.md`; where a promise below depends on something
not built yet, the note says so.

---

## 1. Who we are and what these terms cover

Coachatron (coachatron.com) is operated by Noctusoft, Inc. ("Coachatron",
"we", "us"). These terms are an agreement between Noctusoft, Inc. and you, the
coach who publishes sessions on Coachatron and takes payment through it ("you").

They cover selling your sessions and taking payment through Coachatron. Our
Terms of Service (coachatron.com/terms) and Privacy Policy
(coachatron.com/privacy) also apply.

[Attorney: the /terms page today covers only the SMS program. Decide whether
these terms become a section of a full Terms of Service or stay a separate
coach agreement that /terms links to.]

**Accepting.** You accept these terms by checking the box on the Money screen
and choosing "Connect payments". We record the version you accepted and when.
You cannot start connecting payments until you have accepted the current
version.

**New versions.** If we change these terms, we will give the new version a new
number, tell you what changed, and ask you to accept it on the Money screen.

[Attorney: notice period before a new version applies, and what happens to a
coach who does not accept it. Today the relay checks the accepted version when
a coach starts or updates payment onboarding; it does not pause payments to a
coach who accepted an older version.]

## 2. You are the merchant

- You sell your sessions, packages, and one-time packs directly to the
  parents and athletes who book you. **You are the seller and the merchant of
  record for every payment.** Coachatron is not a party to that sale.
- You set your prices and what each package or pack includes. A one-time pack
  is charged once and does not renew.
- Coachatron is software: your public page, booking, checkout links, texts
  about bookings, and the Money screen. We do not employ you, we do not
  supervise how you coach, and we do not resell your sessions.

[Attorney: marketplace-facilitator rules for sales tax on coaching or
instruction in the states where coaches sell. Confirm Coachatron is not the
facilitator when payments run on the coach's own Stripe account.]

## 3. Payments are processed by Stripe

**Stripe's agreement.** Payment processing services for coaches on Coachatron
are provided by Stripe and are subject to the Stripe Connected Account
Agreement, which includes the Stripe Terms of Service (together, the "Stripe
Services Agreement"). By agreeing to these terms or continuing to operate as a
coach on Coachatron, you agree to be bound by the Stripe Services Agreement, as
Stripe may modify it from time to time. As a condition of Coachatron enabling
payment processing services through Stripe, you agree to provide Coachatron
accurate and complete information about you and your business, and you
authorize Coachatron to share it and transaction information related to your
use of the payment processing services provided by Stripe.

[Attorney: this paragraph follows the language Stripe asks Connect platforms to
include (stripe.com/connect-account/legal). Confirm the current wording and the
link to show coaches.]

**Your Stripe account.**

- When you connect payments, Coachatron opens Stripe's own onboarding form.
  Stripe asks for your identity and bank details, verifies them, and decides
  whether your account can take payments and receive payouts. Coachatron does
  not collect your bank account number, tax ID, or identity documents; Stripe
  does.
- Your account has **no Stripe dashboard** and needs no Stripe login. You see
  your bookings and collections on the Coachatron Money screen. To change bank
  or identity details, choose "Update payout details" on the Money screen; it
  opens the same Stripe form.
- Stripe tells us your account's status (whether it can take payments and
  receive payouts, and what Stripe still needs from you). We show that on the
  Money screen.
- Today Coachatron supports coaches in the United States, paid in US dollars.
- **Booking opens when your account can take payments.** Until Stripe says it
  can, your public page shows paid sessions as "Booking opens soon" and
  takes no payment. Free sessions can still be booked, and families who hold
  session credits with you can still book with them.
- **Texts about setting up payments.** If your mobile has opted in to texts,
  when you first publish we text you your page link and, until payments work,
  a link that signs you in on the Money screen to set them up (it works once,
  within 7 days). We text you once when your account can take payments, and
  if setup is still unfinished we send the link again about one and about
  three days after you publish, twice at most.

## 4. Fees

- **Free to sign up and publish.** There is no monthly charge.
- **Platform fee: 5% (500 basis points) of each payment** a parent or athlete
  makes to you through Coachatron. It is taken at the time of the charge, as an
  application fee, from that payment. We never invoice you for it.
- **Stripe's processing fees are separate.** Stripe collects them from your
  Stripe account under the Stripe Services Agreement.
- Example: on a $35 session, the platform fee is $1.75. Stripe's processing fee
  also comes off. The rest is yours.
- The price a parent sees is the price they pay. We add nothing on top.
- We may lower or waive the platform fee for you (for example, during a pilot)
  without a new version of these terms. A higher fee applies to you only
  through a new version that you accept.

[Attorney: lowering or waiving the fee for one coach needs a relay change
before it can be offered. Today the fee is one rate for every coach in an
environment, set on the relay and applied at each charge.]

[Attorney: raising that rate raises it at once for every connected coach,
including any who never accepted a new version. Accepting a version gates
starting or updating payment onboarding (section 1), not charges. Decide the
notice period before a raise, and whether the relay must be able to hold
existing coaches at their rate before any raise; without that, "a higher fee
applies to you only through a new version that you accept" cannot be kept.]

**Taxes.** You are responsible for taxes on your income and for any sales or
use tax on your services.

[Attorney: who issues and files Form 1099-K for coaches whose Stripe accounts
have no dashboard, and whether Coachatron must collect or confirm a coach's
taxpayer details for it.]

## 5. Payouts

- Payments go into your Stripe account, not to Coachatron. **Coachatron never
  holds, receives, or transfers your money**, and there is no Coachatron balance
  to withdraw.
- Stripe pays your balance out to your bank account on Stripe's payout
  schedule. Payouts are paused until your bank details are complete; the Money
  screen tells you when that is the case.
- Stripe may delay, hold, or reverse payouts under the Stripe Services
  Agreement (for example, to verify your identity, or to cover a refund or a
  dispute). Coachatron cannot release a hold that Stripe places.

## 6. Refunds

- **Your policy.** You decide when a parent gets money back, consistent with
  the parent terms shown at booking and with applicable law. Returning a
  session credit when you cancel a session (section 8) is separate from a card
  refund.
- **How you issue a refund.** On the Money screen or a session's screen,
  tap **Refund** on a payment and confirm. Coachatron asks Stripe to refund
  the whole payment on your Stripe account, to the card the parent paid
  with. The refund comes out of your Stripe balance. When it goes through,
  the booking it paid for is cancelled and its spot opens, the unused
  session credits it bought are removed, and we tell the parent (by text if
  they opted in, and by email if they gave one).
- **What can be refunded in the app.** A whole payment, while nothing it
  bought beyond its own booking has been used: a session paid by card, or
  a package or pack none of whose credits has been used. For anything else
  (for example, part of a package after some sessions were used), ask
  Coachatron support at support@coachatron.com, and we will issue it at
  your request.
- **Our fee on a refund.** When a payment is refunded through Coachatron, our
  platform fee is returned with it, in proportion for a partial refund.
  Stripe keeps its own processing fee on the original payment.
- We may issue a refund without your request only where the law, Stripe, or a
  card network requires it, or to correct a charge made in error by
  Coachatron.
- **Payments that could not book.** A payment can arrive after its spot was
  taken (a parent's spot is held for 15 minutes while they pay), after the
  session started, for an amount that does not match the price, or as a
  second payment for one booking. Coachatron does not book it. The payment is
  in your Stripe account, and the Money screen lists it under "Payments to
  resolve" with the athlete's name, the parent's mobile number, and the
  reason. You agree to settle each one with the parent, for example by
  booking another session, giving a credit, or refunding it from the Money
  screen.
- **Refunds that do not go through.** If Stripe cannot complete a refund,
  the Money screen lists it under "Payments to resolve", and you may try
  again or settle it with the parent.

[Attorney: the app refunds whole payments only, from the coach's own signed-in
screens. Partial refunds still go through support; decide how support
confirms that a request comes from the coach before acting on it, and
whether the terms should state that Stripe keeps its processing fee on a
refunded payment.]

[Attorney: decide how soon a coach must settle a payment listed under
"Payments to resolve", and what Coachatron does if they do not.]

[Attorney: until 2026-11-03, `SPEC.md` §9.4 said the platform keeps its fee
on partial refunds. The relay returns the fee with any refund, and the Money screen tells
coaches "Coachatron's fee is returned with the refund". This draft follows the
relay and the Money screen.]

## 7. Disputes and chargebacks

- If a parent disputes a charge with their card issuer, **Stripe handles the
  dispute** under the Stripe Services Agreement. Stripe debits the disputed
  amount and its dispute fee from your Stripe account, and returns them if the
  dispute is decided in your favor, as Stripe's terms provide. The Money screen
  says this as "A card dispute is charged to your payment account."
- **What you see.** The Money screen lists each dispute Stripe reports, open
  or decided, with what it means. A dispute does not change the booking or
  the credits it paid for; what to do about the session is up to you.
- **Losses.** Stripe is the party responsible for collecting a negative balance
  on your account (for example, after a dispute you lose when your balance
  cannot cover it), under Stripe's terms. Noctusoft does not cover that loss
  and does not charge you for it.
- **Evidence.** You agree to help answer a dispute, for example with the
  session date, place, and attendance. Coachatron keeps booking records that
  can help: when the booking was made, the session, attendance you marked, and
  the texts we sent about it.

[Attorney: confirm how Stripe's terms allocate a dispute loss when Stripe is
the losses collector on the connected account, and what Stripe may recover
from the coach directly (for example, by debiting the coach's bank account).]

[Attorney: the Money screen shows disputes but cannot answer them, and coaches
have no Stripe dashboard. Decide how a coach submits evidence (through support
today) and the deadline we promise to pass it on by.]

## 8. What you promise as a coach

- **Deliver what you sell.** Hold each session at the published time and place,
  within the published capacity, at the published price.
- **If you cancel a session,** Coachatron cancels its bookings, texts the
  parents who opted in to texts, and gives each paid booking a session credit
  with you: a package or pack credit comes back, and a booking paid by card
  for that one session becomes one session credit, which does not expire. A
  pack's credit does not expire either; a package credit that comes back
  keeps that package's expiry, if you set one. The session screen shows
  which parents could not be texted, so you can tell them yourself. If a parent's payment arrives after you cancelled
  the session, the whole payment becomes credit with you, the parent is told,
  and the Money screen lists it.
  [Attorney: today the credit is automatic, and the coach may refund the
  card instead from the Money screen while the credit is unused. Decide
  whether these terms let a parent ask for a refund instead of the credit,
  or leave it to the coach's published policy.]
- **Honor prepaid sessions.** Packages, packs, and the credits you give are
  sessions you owe. The Money screen shows the credits outstanding. If you
  stop coaching, you must deliver or refund the credits parents have paid for.
- **No-shows and late cancellations** follow the policy the parent saw when
  they booked (see the parent terms).
- **Be truthful** about who coaches, your qualifications, what a session
  includes, and where it takes place.
- **Safety and the law.** You are responsible for the safety of the athletes in
  your sessions, many of whom are minors, and for following the laws and the
  rules of your sport that apply to you, including any licenses, insurance, and
  background checks.
  [Attorney: whether to require background checks or a youth-safety
  certification for coaches who work with minors, and minimum insurance.]
- **Your roster.** Assistant coaches on your roster work with you, not for
  Coachatron. What you pay them is between you and them; Coachatron never moves
  that money.
- **Your account.** Keep the email and mobile you sign in with under your
  control, and tell us if someone else gets access. Each sign-in code works
  once, for 10 minutes, and stops working after a few wrong tries.

## 9. Texting and consent

- Coachatron sends only transactional texts: sign-in codes, booking
  confirmations with the parent's manage link, reminders, session updates,
  offers to coach an extra session, and texts to you about setting up
  payments. Every text starts with "Coachatron:". We send no marketing texts.
- Coachatron texts a number only after the person who owns it opts in, by
  checking the unchecked box at sign-in, booking, or the waitlist, or at
  coachatron.com/sms. The exceptions are a sign-in or checkout code someone
  asks for and a reply to a text someone sends us. Replying STOP opts out.
- **Your duties for your athletes and roster:**
  - Add someone to your roster only if they have agreed to be on it. A number
    you add is not texted until its owner opts in themselves.
  - Let each parent, athlete, and roster member opt in for themselves. Do not
    check the box or opt in for someone else, and do not enter a number you do
    not have permission to use.
  - Texts and messages you send yourself, outside Coachatron, are your
    responsibility, including getting consent for them.
  - Do not use Coachatron's number or its text assistant to send marketing or
    messages unrelated to your sessions.
- When you text the Coachatron number, we read your text to carry out what you
  ask (for example, setting up your week), and we ask you to confirm before we
  change anything. We act on a text only when our SMS provider confirms it
  delivered that text to us.

[Attorney: TCPA and carrier rules for the coach's own messages. Coachatron
keeps, for each opt-in, the consent text version, where it was given, the time,
and the IP address and browser.]

## 10. Acceptable use

Do not use Coachatron to:

- sell anything other than coaching sessions, packages, and packs that you or
  your roster deliver;
- sell anything Stripe does not allow (Stripe's restricted and prohibited
  businesses list);
- mislead parents about price, time, place, or who coaches;
- take money for sessions you do not intend to deliver;
- harass or discriminate against anyone;
- use someone else's identity or bank account; or
- interfere with the service or with other coaches' accounts.

[Attorney: whether to add a clause on steering parents who booked through
Coachatron to pay outside it. `SPEC.md` prefers a low fee over lock-in.]

## 11. Suspension and ending these terms

- **You can stop at any time.** Stop publishing, cancel your future sessions,
  and ask us to close your account. Before you go, deliver or refund the
  credits parents have paid for.
- **Your Stripe account is yours.** Closing your Coachatron account stops
  Coachatron from acting on your Stripe account; it does not delete that
  account.
- **We may suspend** payments to you or your public page if you break these
  terms, if Stripe restricts your account, if the law requires it, or to
  protect parents (for example, after sessions are repeatedly cancelled without
  refunds). We will tell you why when we can.
- **What continues after the end:** fees on payments already made, refunds and
  disputes on those payments, and sections 7, 12, and 13.

[Attorney: notice and cure periods before a suspension; whether a coach can
appeal.]

## 12. Data

- **What we keep about your business:** your name, email, mobile, handle, and
  time zone; your session types, schedule, prices, packages, and packs; your
  roster; bookings, credits, and attendance; a log of the texts we send;
  whether your Stripe account can take payments; and the version of these
  terms you accepted.
- **Athletes' and parents' details** (an athlete's name, a parent's phone, and
  an email if they give one) are collected to run bookings with you. We do not
  sell them and do not use them for marketing. You may use them only to run
  your sessions with those families, and must keep them secure.
- **Payments data:** Stripe holds card and bank details. Coachatron stores the
  amount of each payment and an opaque payment reference, never card numbers.
  It records each payment it is told about once, with whether it booked, so
  no payment goes unseen. See the payments section of our Privacy Policy.
- **Leaving with your data:** you can ask support for a CSV export of your
  athletes and bookings at any time.
  [Attorney: `SPEC.md` §13 promises a self-serve export; it is not built yet.]

[Attorney: roles for athlete data between Noctusoft and the coach (who decides
what is collected and why), given that many athletes are minors. `SPEC.md` §13
keeps athlete data to a name and a parent's contact details.]

## 13. Warranties, liability, and disputes between us

[Attorney: standard terms to draft: no warranty beyond what is written here;
limitation of Noctusoft's liability (for example, to the platform fees you paid
in the prior 12 months); your indemnity of Noctusoft for claims about your
sessions, including injuries during a session; governing law and venue;
arbitration or small-claims option; notices by email.]

[Attorney: `SPEC.md` §6 leaves a waiver out of the product on purpose. Decide
whether coaches must collect their own participation waivers and whether these
terms should say so.]

## 14. Contact

Questions about these terms: support@coachatron.com.

Noctusoft, Inc. · https://noctusoft.com
