import type { DbClient } from '../db/client.js';
import { APP_FEE_BPS } from '../config.js';
import { html, raw, type SafeHtml } from '../lib/html.js';
import { formatCoachDollars, formatLocal } from '../lib/time.js';
import { namesList } from '../domain/bookingMessages.js';
import { cancelCutoff, type BookingPolicy, type CancelGives } from '../domain/policy.js';
import { cancelPromise, type CancelRefundState, type InTimeCancel } from '../domain/cancelRefund.js';

/** The words of the coach-set refund policy (SPEC.md §9.5) on the screens
 * that already exist: the Pricing screen's booking-policy form, checkout,
 * and the manage page. No screen of its own. The rules are in
 * src/domain/cancelRefund.ts. */

// ---- Pricing (screen 5): the coach's choice ----

const CHOICES: Array<[CancelGives, string]> = [
  ['credit', 'A session credit'],
  ['refund', 'A refund to their card'],
];

/** The third field of the booking-policy form, next to the cancellation
 * window and the children limit. */
export function cancelGivesField(policy: Pick<BookingPolicy, 'cancelGives'>): SafeHtml {
  return html`<label for="cancel_gives">When a client cancels in time</label>
    <select id="cancel_gives" name="cancel_gives">
      ${CHOICES.map(([value, label]) =>
        value === policy.cancelGives ? html`<option value="${value}" selected>${label}</option>` : html`<option value="${value}">${label}</option>`,
      )}
    </select>
    <p class="muted">For a session paid by card. A refund sends the whole payment back to the client's card: Coachatron's ${APP_FEE_BPS / 100}% fee is returned with it, and Stripe keeps its card processing fee. Bookings already made keep the choice they were made under.</p>`;
}

/** What the policy card says a paid drop-in cancelled in time becomes. */
export function cancelGivesSummary(policy: Pick<BookingPolicy, 'cancelGives'>): string {
  return policy.cancelGives === 'refund' ? 'a paid drop-in is refunded to their card' : 'a paid drop-in becomes a session credit';
}

/** The card's closing line: how card refunds are made under the choice. */
export function cardRefundsNote(policy: Pick<BookingPolicy, 'cancelGives'>): string {
  const yours = "You can refund any payment yourself, from Payments or the session's screen.";
  return policy.cancelGives === 'refund'
    ? `A refund is of a whole payment: children paid for together are refunded once each of their bookings is cancelled in time, and until then a cancelled booking gets a session credit. ${yours}`
    : `Card refunds are separate. ${yours}`;
}

// ---- Checkout (screen 10): what the booking is promised ----

function hoursWord(hours: number): string {
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** "by Tue, Nov 17, 6:00 PM", or "before it starts" when the coach's window is 0. */
function untilWords(startsAtUtc: string, tz: string, windowHours: number): string {
  if (windowHours === 0) return 'before it starts';
  return `by ${formatLocal(cancelCutoff(startsAtUtc, windowHours).toISOString(), tz)}`;
}

/** One line for the checkout page, before the parent pays: what cancelling
 * in time gives back, by the choice this booking was made under. Null for a
 * free session, which has nothing to give back. `canPay` is false while the
 * coach cannot take cards, when only session credits book. */
export async function checkoutCancelLine(
  db: DbClient,
  bookingId: number,
  opts: { children: number; canPay: boolean },
  now: Date = new Date(),
): Promise<string | null> {
  const promise = await cancelPromise(db, bookingId);
  if (!promise || promise.price_cents <= 0) return null;
  const start = new Date(promise.starts_at_utc);
  if (now >= start) return null;
  if (now >= cancelCutoff(start, promise.cancel_window_hours)) {
    return `It's less than ${hoursWord(promise.cancel_window_hours)} before this session, so cancelling uses the payment or session credit, the same as not showing up.`;
  }
  const until = untilWords(start.toISOString(), promise.tz, promise.cancel_window_hours);
  if (promise.gives !== 'refund' || !opts.canPay) return `Cancel ${until} for a session credit.`;
  const together =
    opts.children > 1
      ? ' Children paid for together are refunded together, once each of their bookings is cancelled; until then a cancelled booking gets a session credit.'
      : '';
  return `Cancel ${until} for a refund to your card.${together} A booking made with a session credit, a package or a pack gets its credit back instead.`;
}

// ---- Manage booking (screen 11) ----

/** Before the parent confirms a cancel in time: the amount and where it
 * goes, or why this cancel gives a session credit although the booking was
 * made under "a refund". Null when the booking was made under "a session
 * credit": the page keeps the sentence it always had. */
export function inTimeCancelNote(
  booking: { starts_at_utc: string; tz: string; cancel_window_hours: number; coach_name: string },
  cancel: InTimeCancel | null,
): SafeHtml | null {
  if (!cancel || (cancel.gives === 'credit' && cancel.why === 'policy')) return null;
  const until = untilWords(new Date(booking.starts_at_utc).toISOString(), booking.tz, booking.cancel_window_hours);
  const coach = booking.coach_name;
  if (cancel.gives === 'refund') {
    const amount = cancel.amountCents === null ? 'Your payment' : formatCoachDollars(cancel.amountCents);
    const whole = cancel.athletes.length > 1 ? `, the whole payment for ${namesList(cancel.athletes)},` : '';
    const n = cancel.creditsWithdrawn;
    const credits = n > 0 ? ` The ${n === 1 ? 'session credit' : `${n} session credits`} from the ${n === 1 ? 'booking' : 'bookings'} already cancelled ${n === 1 ? 'is' : 'are'} withdrawn with it.` : '';
    return html`<p class="muted cancel-terms">Cancel ${until} for a refund to your card: ${amount}${whole} goes back to the card you paid with.${credits}</p>`;
  }
  switch (cancel.why) {
    case 'others-booked': {
      const several = cancel.others.length > 1;
      return html`<p class="muted cancel-terms">Cancel ${until} for a session credit with ${coach}. This payment also paid for ${namesList(cancel.others)}, who ${several ? 'are' : 'is'} still booked, and a refund to your card is of the whole payment: it is made if ${several ? 'their bookings are' : 'that booking is'} cancelled in time too, while this credit is unused.</p>`;
    }
    case 'session-used':
      return html`<p class="muted cancel-terms">Cancel ${until} for a session credit with ${coach}. A session this payment bought was already used, so it cannot go back to your card whole.</p>`;
    case 'refund-under-way':
      return html`<p class="muted cancel-terms">A refund of this booking's payment is already on its way to your card. Cancelling ${until} gives the spot back.</p>`;
    default:
      return html`<p class="muted cancel-terms">Cancel ${until} for a session credit with ${coach}. This payment cannot be refunded to your card from here: ask ${coach}.</p>`;
  }
}

/** After a cancel whose refund is on its way, or did not go through. While
 * it is on its way the credit the cancel became is not offered: the parent
 * hears once, by the refund's own notice. When it fails, the credit is
 * theirs, and this is where they are told. */
export function cancelRefundNote(coachName: string, refund: CancelRefundState | null): SafeHtml {
  if (!refund) return raw('');
  if (refund.state === 'sending') {
    const amount = refund.amountCents === null ? 'your payment' : formatCoachDollars(refund.amountCents);
    return html`<p class="muted">We are sending your refund of ${amount} to the card you paid with.</p>`;
  }
  if (refund.state === 'on-its-way') {
    const amount = refund.amountCents === null ? 'your payment' : formatCoachDollars(refund.amountCents);
    return html`<p class="muted">A refund of ${amount} to the card you paid with is on its way.</p>`;
  }
  return refund.creditLeft
    ? html`<p class="muted">The refund to your card did not go through, so you hold a session credit with ${coachName} for this booking instead. ${coachName} can still send the refund.</p>`
    : html`<p class="muted">The refund to your card did not go through, so this booking's payment became a session credit with ${coachName} instead.</p>`;
}
