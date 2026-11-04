**DRAFT for attorney review. Not in effect. Not legal advice.**

# Coachatron Terms for Parents and Athletes

*Draft of 2026-11-03. For the people who book and pay a coach through
Coachatron. Not shown anywhere in the app yet.*

Notes in square brackets, "[Attorney: ...]", are open questions for review. They
are not part of the terms.

[Attorney: decide where these appear. Today the booking form links only the SMS
terms and the privacy policy. Showing these terms must not add a screen
(`SPEC.md` §8.1 caps the product at twelve): a section of /terms linked from the
booking form and checkout would do.]

---

## 1. Who is who

- **Coachatron** (coachatron.com) is booking software operated by Noctusoft,
  Inc. ("Coachatron", "we").
- **The coach** you book is an independent business. The coach sells the
  session, runs it, and is responsible for it. Coachatron does not employ
  coaches and is not at the session.
- **You** are the parent, guardian, or adult athlete who books. You do not need
  an account: you give the athlete's name, your mobile number, and an email if
  you like, and you manage a booking from the private link in your
  confirmation.
- If the athlete is under 18, a parent or guardian must make the booking.

[Attorney: minimum age to book for oneself, and whether to ask the person
booking to confirm they are the parent or guardian.]

## 2. Your payment goes to the coach

- **You pay the coach, not Coachatron.** The coach is the merchant. Your
  payment is processed by Stripe on the coach's own Stripe account.
- **The price you see is the price you pay.** Coachatron's fee (5%) comes out
  of the coach's side of the payment; nothing is added on top for you.
- **Your card details go to Stripe, not to us.** You enter them on the hosted
  checkout page that opens when you choose how to pay. Coachatron never sees or
  stores your card number.
- Prices are in US dollars.
- **Booking opens when the coach can take payments.** Until the coach has
  finished setting up payments, their page shows paid sessions as "Booking
  opens soon" and does not take payment. If you already hold session credits
  with that coach, you can still book with them.
- **Your spot is held while you pay.** When you start a booking, we hold the
  spot for 15 minutes while you choose how to pay and pay. One mobile number
  holds one spot in a session at a time.
- **If your payment cannot book the spot.** A payment that arrives after the
  session filled or started, for a different amount than the price, or for a
  booking that is already paid does not book the session. The payment has
  reached the coach, who sees it in Coachatron and will contact you to sort it
  out. The page you return to says so; please do not pay again.

[Attorney: a payment that cannot book is settled between the coach and the
parent today (a booking, a credit, or a refund the coach issues, section 6).
Decide what these terms promise the parent and by when.]

[Attorney: confirm the name parents will see on their card statement (Stripe
sets it from the product name) so it can be stated here, which helps parents
recognize the charge.]

## 3. Three ways to pay

**This session (drop-in).** One charge for one booking.

**A package.** Several sessions paid in advance (for example, 10 for $300). One
is used for the booking you are making; the rest become **credits** with that
coach.

**A one-time pack.** A set number of sessions, **charged once** when you buy
it. One is used for the booking you are making; the rest become credits with
that coach. It does not renew, and you will not be charged again unless you
buy another.

[Attorney: checkout labels the pack "one-time" and no plan renews today. If
monthly renewal is built later, these terms must explain the renewal date,
the amount, and how to cancel before the next charge, under automatic-renewal
laws (for example, California's).]

**Confirmation.** Once you are booked, we send a confirmation with your private
manage link: by text if you opted in to texts, and by email if you gave one.
The page you return to after paying shows the link too.

**About credits:**

- Credits are tied to the **mobile number you booked with** and to **that
  coach**. A parent booking for two children with one number draws from one
  pool of credits.
- You can book more than one child at once, up to the coach's limit (2 unless
  the coach sets another). Each child takes a spot and uses one credit, or one
  drop-in payment, and has their own manage link.
- When you book again with that coach, checkout offers to use a credit. To
  use one, you enter a code we text to the booking's mobile number, which
  shows the number is yours; arriving from the manage link of a booking
  already shown to be yours works too.
- Credits are for sessions only. They have no cash value and cannot be moved to
  another coach.
- **Expiry.** A package's credits expire only if the coach set an expiry for
  that package. A one-time pack's sessions do not expire. A credit that comes
  back when a coach cancels keeps the expiry it had (section 4).

[Attorney: the checkout page does not show a package's expiry yet. It must be
shown before an expiring package is sold. Check state rules on prepaid
services and expiring credits (some limit expiry or require cash back for
unused value). A package credit that comes back after its package's expiry
has passed cannot be used; decide whether a coach's cancel should give a
credit that does not expire instead.]

## 4. Cancelling

**If the coach cancels a session,** your booking is cancelled, you get a text
if you opted in to texts, and **you get a session credit with that coach** on
your number: the credit you used comes back, and a session you paid for by
card becomes one session credit. That session credit, and a one-time pack's
credit, do not expire; a package credit that comes back keeps that package's
expiry, if the coach set one. If you could not be texted, the coach is shown
that you were not reached.

**If the coach cancels while you are paying,** your whole payment becomes
credit with that coach, and we tell you by text (if you opted in) or email
(if you gave one).

[Attorney: today a card-paid booking cancelled by the coach becomes a credit
automatically; the coach may refund the card instead while the credit is
unused (section 6). Decide whether a parent may ask for a card refund
instead of the credit, and say so here.]

**If you cancel,** use the manage link from your confirmation.

- **The cancellation window is [COACH'S WINDOW] before the session starts.**
  The coach sets it; if they have not, it is **24 hours**.
- Cancel **before the window** (earlier than [COACH'S WINDOW] before the
  start): the credit you used comes back, and a session you paid for by card
  becomes one session credit with that coach, which does not expire.
- Cancel **inside the window**: it counts as a no-show (section 5), and the
  credit is used. The coach may choose to give it back.
- The manage page tells you, before you confirm, whether cancelling now will
  use your credit.

- If the coach cancels the session after you cancelled inside the window,
  your credit comes back.

[Attorney: the app applies this window as of 2026-11-04 (`SPEC.md` §9.5): the
coach sets 0 to 168 hours, the default is 24, the manage page shows the cut-off
time and says before you confirm whether cancelling now uses the credit, and
a card-paid drop-in cancelled before the window becomes a session credit, not
a card refund. Decide whether a parent may ask for a card refund instead.]

**Waitlist.** If a session is full, you can join its waitlist. When a spot
opens, people waiting are offered it in the order they joined: we hold it for
you for 15 minutes and send you a link to book it, by text if you opted in to
texts, or by email if you gave one. If you do not book it in that time, it goes
to the next person. Spots do not open overnight: between 9pm and 8am in the
coach's time zone we wait until morning, unless the session starts first.
Nothing is charged until you book.

## 5. No-shows

If the athlete does not come and you did not cancel in time, the session counts
as used: the credit is used, or the drop-in payment is kept. The coach may
choose to give the credit back.

## 6. Refunds

- Refunds come from the coach, because the coach is the merchant. Each coach
  decides their refund policy, within these terms and the law.
- **How:** ask the coach. The coach refunds a payment in Coachatron, and it
  goes back to the card you paid with, through Stripe. A refund is for the
  whole payment.
- **What a refund ends:** the booking the payment was for is cancelled (or,
  for a session that already happened, marked refunded), and the unused
  session credits it bought are removed. From the moment the coach confirms
  the refund, those credits cannot be booked with; if the refund does not go
  through, they can be used again. A package or one-time
  pack can be refunded this way only while none of its credits has been
  used; for anything else, the coach or support@coachatron.com can help.
- **We tell you** when a refund is made: by text if you opted in to texts,
  and by email if you gave one. Your manage page shows the booking as
  refunded.
- A refund can take several business days to reach your card, depending on
  your bank.
- **Card disputes.** Please contact the coach or us first. A dispute you open
  with your card issuer is handled by Stripe and your issuer; the coach sees
  that it was opened and how it was decided.

[Attorney: who answers for unused credits if a coach stops coaching or leaves
Coachatron. The coach terms require the coach to deliver or refund them; decide
what Coachatron promises parents if the coach does not.]

## 7. Texts

- Texts are **optional**. You can book, pay, and manage a booking without them.
- If you check the box when you book or join a waitlist, we text you booking
  confirmations, reminders, and session updates from Coachatron. Message
  frequency varies. Message and data rates may apply. Reply STOP to opt out and
  HELP for help. Consent is not a condition of purchase.
- When you ask to use session credits, we text a one-time code to the
  booking's number, even if you did not check the box, because you asked for
  it. If that number has replied STOP, we do not send it.
- Check the box only for a number that is yours or that you may use.
- We text only US and Canadian mobile numbers.

## 8. Safety

The coach runs the session and is responsible for it. Sports carry a risk of
injury.

[Attorney: whether these terms carry an assumption-of-risk statement or a
participation waiver, or whether each coach collects their own. `SPEC.md` §6
leaves a waiver out of the product on purpose.]

## 9. Privacy

How we handle your details, including payments, is in our Privacy Policy
(coachatron.com/privacy).

## 10. Contact

support@coachatron.com · Coachatron is operated by Noctusoft, Inc.
(https://noctusoft.com).

[Attorney: limitation of liability, governing law, and dispute resolution for
parents.]
