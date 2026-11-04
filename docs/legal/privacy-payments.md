**DRAFT for attorney review. Not in effect. Not legal advice.**

# Privacy Policy additions: payments

*Draft of 2026-11-03. Proposed new sections for the Privacy Policy at
coachatron.com/privacy, which today covers text messages only. Not wired into
the app; the /privacy page is unchanged.*

Notes in square brackets, "[Attorney: ...]", are open questions for review. They
are not part of the policy.

---

## Payments

### Who processes a payment

When you pay a coach through Coachatron, the payment is processed by **Stripe**
on the coach's own Stripe account. The coach is the merchant. Stripe's privacy
policy (https://stripe.com/privacy) covers what you give Stripe.

Between Coachatron and Stripe sits Noctusoft's payment service (the "relay"),
run by Noctusoft, Inc., the company that operates Coachatron. It creates the
checkout, tells Coachatron when a payment succeeds, and is where a refund is
issued.

### Card details

You enter card details on the hosted checkout page that opens when you choose
how to pay. They go to Stripe. **Coachatron never receives, stores, or sees your
card number, expiry date, or security code**, and does not save a card for
later.

### What Coachatron sends to the checkout

When you choose to pay, Coachatron creates a signed payment link that carries:

- the amount and currency;
- a short description: the session name and time, or the package or pack
  name and the coach's name;
- a booking reference (a Coachatron booking number and how you chose to pay);
- your email address, if you gave one; and
- the Coachatron page to return you to.

[Attorney: when a parent gives no email, Coachatron puts a placeholder address
made from the digits of the parent's mobile number in the email field
(`…@book.coachatron.test`). Decide whether to keep that, since it passes the
number to the relay and Stripe in the email field.]

### What Coachatron stores about a payment

- **The booking:** the athlete's name, the parent's mobile number and email (if
  given), the session, how it was paid (drop-in, package credit, or one-time
  pack), its status (pending, booked, cancelled, attended, no-show, or
  refunded), the amount charged, and when it was made; until it is paid,
  until when its spot is held; whether a code texted to the mobile number
  showed it is yours; and, if the coach cancelled the session, whether the
  cancel text reached you.
- **A payment reference** that the relay issues for the Stripe payment.
  Coachatron does not store Stripe's own ids; the relay keeps the link between
  its reference and Stripe's payment.
- **Credits:** how many credits are left on a mobile number with a coach, where
  they came from (a package, a one-time pack, or a session the coach
  cancelled), and when they expire, if they do.
- **Each payment event** the relay reports, recorded once so it is never
  handled twice. A payment that could not book (for example, the session
  filled first) is kept with its amount, the reason, the athlete's name, and
  the parent's mobile number, so the coach can sort it out with the parent.
- **Refunds and disputes:** for a refunded payment, its amount and status,
  the relay's reference for the refund, how many session credits it
  removed, and whether you were told; for a card dispute, its amount and
  whether it is open, won, or lost, with the athlete's name and the
  parent's mobile number, so the coach can see it.
- **For coaches:** the key that ties the coach to their Stripe account at the
  relay (by default the coach's handle), the version of the marketplace terms
  they accepted, and the account status Stripe reports (whether it can take
  payments and receive payouts). Coachatron does not store a coach's bank
  account, tax ID, or identity documents; Stripe collects those in its own
  onboarding form.

### What the relay keeps

For each purchase, the relay records the buyer's email, the booking reference,
the amount, currency, and status, and Stripe's own ids for the payment and any
refund. It uses them to tell Coachatron about the payment, to issue refunds,
and to keep accounting records.

[Attorney: retention periods for the relay's purchase records and for
Coachatron's bookings (tax and accounting rules may require several years).]

### What Stripe collects

- **From parents:** card details and whatever the checkout page asks for (such
  as email, name, or billing postal code), plus device and fraud-prevention
  signals, under Stripe's privacy policy.
- **From coaches:** identity and business details, bank account, and a phone
  check, as Stripe requires to approve an account and pay it out. Coachatron
  sees only whether the account can take payments and receive payouts, and what
  Stripe still needs.

### How payment information is used and shared

- To take the payment, confirm the booking, add credits, show the coach their
  bookings and the Money screen, return credits when a session is cancelled,
  handle a refund or dispute, and meet legal duties such as tax reporting and
  fraud prevention.
- **The coach you booked sees** the athlete's name, the session, the booking's
  status and attendance, and totals on their Money screen. Coaches do not see
  your email or how you paid, and never see card details. They see your mobile
  number only where they need to reach you: on a payment of yours that could
  not book, and after they cancel a session if the cancel text could not reach
  you. When a coach sends an update about a session, Coachatron texts it to
  you.

[Attorney: this lists what the coach's screens show today, including the two
places that show a parent's mobile number. If a later screen shows coaches
more of a parent's contact details or the payment method, this notice needs
to say so first.]
- We do not sell payment information or use it for marketing.

[Attorney: the California "sale" and "sharing" statements, and whether any
state privacy law applies at Coachatron's size.]

### Your choices

You can ask for a copy of your information, or for it to be deleted, at
support@coachatron.com. Payment and booking records that the law requires us
to keep are kept for that period.

[Attorney: the deletion process for a parent's bookings and credits when a
coach still owes sessions on them.]

### Children

Many athletes are minors. Coachatron collects only an athlete's name, with a
parent's mobile number and an optional email; no date of birth, address, or
photos. A parent or guardian makes the booking and the payment.

[Attorney: confirm Coachatron stays outside COPPA, given that it collects no
information directly from children under 13 (`SPEC.md` §13).]
