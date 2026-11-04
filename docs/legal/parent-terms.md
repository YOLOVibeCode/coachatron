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
  you like, and you manage a booking from the private link we give you.
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

[Attorney: confirm the name parents will see on their card statement (Stripe
sets it from the product name) so it can be stated here, which helps parents
recognize the charge.]

## 3. Three ways to pay

**This session (drop-in).** One charge for one booking.

**A package.** Several sessions paid in advance (for example, 10 for $300). One
is used for the booking you are making; the rest become **credits** with that
coach.

**A monthly plan.** Today a plan is **charged once**, when you buy it, and
gives you that month's credits. It does not renew, and you will not be charged
again unless you buy it again.

[Attorney: the checkout button says "/mo". Until renewal is built, the copy
should say the plan is charged once. When renewal is built, these terms must
explain the renewal date, the amount, and how to cancel before the next charge,
under automatic-renewal laws (for example, California's).]

**About credits:**

- Credits are tied to the **mobile number you booked with** and to **that
  coach**. A parent booking for two children with one number draws from one
  pool of credits.
- When you book again with that coach, checkout offers to use a credit.
- Credits are for sessions only. They have no cash value and cannot be moved to
  another coach.
- **Expiry.** A package's credits expire only if the coach set an expiry for
  that package. Plan credits are meant to expire at the end of the month they
  were bought for.

[Attorney: the checkout page does not show a package's expiry yet, and plan
credits carry no expiry date in the app today. Both must be shown before an
expiring package or plan is sold. Check state rules on prepaid services and
expiring credits (some limit expiry or require cash back for unused value).]

## 4. Cancelling

**If the coach cancels a session,** your booking is cancelled, you get a text
if you opted in to texts, and **the credit you used for it comes back** to your
number.

[Attorney: a booking paid by card for that one session has no credit to give
back. Until refunds are built, nothing is returned automatically. Decide
whether the coach's cancellation gives that parent a credit or a card refund,
and say which here.]

**If you cancel,** use the manage link from your confirmation.

- **The cancellation window is [COACH'S WINDOW] before the session starts.**
  The coach sets it; if they have not, it is **24 hours**.
- Cancel **before the window** (earlier than [COACH'S WINDOW] before the
  start): the credit you used comes back.
- Cancel **inside the window**: it counts as a no-show (section 5), and the
  credit is used. The coach may choose to give it back.
- The manage page tells you, before you confirm, whether cancelling now will
  use your credit.

[Attorney: the window and the default of 24 hours follow the open booking-policy
decision (`SPEC.md` §15 item 4). Today the app returns the credit for any
cancellation made before the session starts and has no window yet; the manage
page does not show the warning yet. These terms should match whatever ships.]

[Attorney: a parent who cancels a card-paid drop-in gets nothing back today.
Decide whether that becomes a credit, a refund, or the coach's published
policy.]

## 5. No-shows

If the athlete does not come and you did not cancel in time, the session counts
as used: the credit is used, or the drop-in payment is kept. The coach may
choose to give the credit back.

## 6. Refunds

- Refunds come from the coach, because the coach is the merchant. Each coach
  decides their refund policy, within these terms and the law.
- **Today:** Coachatron has no refund button. Ask the coach, or write to
  support@coachatron.com. Once the coach agrees, the refund goes back to the
  card you paid with, through Stripe.
- **Later:** when refunds are built into Coachatron, a refund will still go
  back to the card you paid with, and any credit it covered will be removed.
- A refund can take several business days to reach your card, depending on
  your bank.
- **Card disputes.** Please contact the coach or us first. A dispute you open
  with your card issuer is handled by Stripe and your issuer.

[Attorney: who answers for unused credits if a coach stops coaching or leaves
Coachatron. The coach terms require the coach to deliver or refund them; decide
what Coachatron promises parents if the coach does not.]

## 7. Texts

- Texts are **optional**. You can book, pay, and manage a booking without them.
- If you check the box when you book or join a waitlist, we text you booking
  confirmations, reminders, and session updates from Coachatron. Message
  frequency varies. Message and data rates may apply. Reply STOP to opt out and
  HELP for help. Consent is not a condition of purchase.
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
