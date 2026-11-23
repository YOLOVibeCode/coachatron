import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { postPaymentEvent } from './helpers/store-event.js';
import { bookOnline, countSold, postCheckout } from './helpers/booking.js';
import { PHONE, bookingStatus, coachCookie, getPage, payFor, postForm, quiet, refundTexts } from './helpers/refunds.js';
import {
  cancelBooking,
  cancelBy,
  coachChooses,
  creditOf,
  madeUnder,
  managePage,
  manageToken,
  refundEmails,
  refundOf,
  sessionInHours,
  startsInHours,
} from './helpers/cancel-refund.js';
import { refundIdempotencyKey } from '../src/domain/refunds.js';
import { getCreditBalance, getCreditTotal } from '../src/domain/pricing.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { runTick } from '../src/jobs/tick.js';
import type { DbClient } from '../src/db/client.js';

/** The coach-set refund policy (SPEC.md §9.5): a coach chooses whether a
 * parent's cancel before the window gives a session credit or a refund to
 * their card. A booking keeps the choice it was made under. A refund goes
 * through the coach's own refund path, once: the cancel is a held credit
 * while the refund is on its way, the parent hears once when it goes
 * through, and one that does not go through leaves them the credit. */

const EMAIL = 'parent@example.com';

function form(base: string, path: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

/** A coach whose session is three days out, and a parent's paid drop-in in it. */
async function paidDropIn(
  base: string,
  db: DbClient,
  opts: { gives: 'credit' | 'refund'; paymentId: string; hours?: number; capacity?: number },
) {
  const seed = await seedCoachWithSession(db, { capacity: opts.capacity ?? 2, priceCents: 3500 });
  await startsInHours(db, seed.sessionId, opts.hours ?? 72);
  await coachChooses(db, seed.coach.id, opts.gives);
  const bookingId = await payFor(base, db, {
    handle: seed.coach.handle,
    sessionId: seed.sessionId,
    paymentId: opts.paymentId,
    amountCents: 3500,
    extra: { contact_email: EMAIL },
  });
  return { seed, bookingId, token: await manageToken(db, bookingId), cookie: await coachCookie(db, seed.coach.id) };
}

test('the Pricing screen offers the choice next to the window and the children limit, a session credit by default', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await withServer(async (base) => {
    const cookie = await coachCookie(db, seed.coach.id);
    const before = await getPage(base, '/app/pricing', cookie);
    assert.match(before, /<label for="cancel_gives">When a client cancels in time<\/label>/);
    assert.match(before, /<option value="credit" selected>A credit for another session<\/option>/);
    assert.match(before, /<option value="refund">A refund to their card<\/option>/);
    assert.match(before, /card company keeps its own processing fee/);
    assert.match(before, /A paid drop-in becomes a session credit/);

    const saved = await form(base, '/app/pricing/policy', cookie, { cancel_window_hours: '24', children_per_booking: '2', cancel_gives: 'refund' });
    assert.equal(saved.status, 303);
    const after = await getPage(base, '/app/pricing', cookie);
    assert.match(after, /<option value="refund" selected>A refund to their card<\/option>/);
    assert.match(after, /A paid drop-in is refunded to their card/);

    // A choice the form does not offer is the form's own message, and saves nothing.
    const bad = await form(base, '/app/pricing/policy', cookie, { cancel_window_hours: '48', children_per_booking: '3', cancel_gives: 'cash' });
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /Use a window of 0 to 168 hours and 1 to 10 children\./);
    // A form sent without the field (one opened before this choice existed) keeps the coach's choice.
    const old = await form(base, '/app/pricing/policy', cookie, { cancel_window_hours: '48', children_per_booking: '3' });
    assert.equal(old.status, 303);
    const kept = await db.query<{ cancel_window_hours: number; children_per_booking: number; cancel_gives: string }>(
      'select cancel_window_hours, children_per_booking, cancel_gives from coach where id = $1',
      [seed.coach.id],
    );
    assert.deepEqual(kept.rows[0], { cancel_window_hours: 48, children_per_booking: 3, cancel_gives: 'refund' });

    const back = await form(base, '/app/pricing/policy', cookie, { cancel_window_hours: '48', children_per_booking: '3', cancel_gives: 'credit' });
    assert.equal(back.status, 303);
    assert.match(await getPage(base, '/app/pricing', cookie), /<option value="credit" selected>A credit for another session<\/option>/);
  });
});

test('a booking keeps the choice it was made under when the coach switches, both ways', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      // Made under "a session credit"; the coach then chooses "a refund".
      const first = await paidDropIn(base, db, { gives: 'credit', paymentId: 'ns_pay_was_credit' });
      assert.equal(await madeUnder(db, first.bookingId), 'credit');
      await coachChooses(db, first.seed.coach.id, 'refund');
      assert.match(await managePage(base, first.token), /Cancel by .+ and your payment becomes a session credit with Jamie Coach/);
      assert.equal(await cancelBooking(base, first.token), 303);
      assert.equal(relay.refundCalls, 0, 'no refund is asked for');
      assert.equal(await bookingStatus(db, first.bookingId), 'cancelled');
      assert.deepEqual(await creditOf(db, first.bookingId), { remaining: 1, held: false, withdrawn: false });
      assert.match(await managePage(base, first.token), /Your session credit with Jamie Coach is back\./);
      assert.equal(await refundOf(db, 'ns_pay_was_credit'), null);

      // Made under "a refund"; the coach then goes back to "a session credit".
      const second = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_was_refund' });
      assert.equal(await madeUnder(db, second.bookingId), 'refund');
      await coachChooses(db, second.seed.coach.id, 'credit');
      assert.match(await managePage(base, second.token), /Cancel by .+ for a refund to your card: \$35 goes back to the card you paid with\./);
      assert.equal(await cancelBooking(base, second.token), 303);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_was_refund');
      assert.equal(await bookingStatus(db, second.bookingId), 'refunded');
    });
  });
});

test('a cancel in time under "a refund" sends the payment back through the coach\'s refund, once, and tells the parent once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_in_time', capacity: 1 });
      const by = await cancelBy(db, seed.sessionId);
      const page = await managePage(base, token);
      assert.ok(page.includes(`Cancel by ${by} for a refund to your card: $35 goes back to the card you paid with.`), 'the amount and where it goes');
      assert.equal(relay.refundCalls, 0, 'nothing is sent before the parent confirms');

      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 1);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_in_time');
      assert.equal(relay.refunds[0].amountCents, null, 'the whole payment');
      assert.equal(relay.refunds[0].idempotencyKey, refundIdempotencyKey('ns_pay_in_time', 1), "the payment's own key");

      // The booking reads refunded, its spot is free, and the credit the
      // cancel became is withdrawn: nothing is left to book with.
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.equal(await countSold(db, seed.sessionId), 0);
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 0, held: true, withdrawn: true });
      assert.equal(await getCreditTotal(db, seed.coach.id, PHONE), 0);
      const after = await managePage(base, token);
      assert.match(after, /Refunded\. The payment went back to your card\./);
      assert.doesNotMatch(after, /session credit/);

      // One refund row, the coach's kind, marked with the cancel that asked.
      const row = await refundOf(db, 'ns_pay_in_time');
      assert.deepEqual(row, {
        status: 'refunded',
        attempt: 1,
        error_code: null,
        amount_cents: 3500,
        athlete_name: 'Alex',
        credits_withdrawn: 0,
        spot_released: false,
        parent_told: 'text+email',
        cancel_booking_id: bookingId,
      });
      assert.equal((await db.query<{ n: string }>('select count(*)::text as n from refund')).rows[0].n, '1');

      // A second tap, and a coach's tap afterwards, send nothing.
      assert.equal(await cancelBooking(base, token), 303);
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(relay.refundCalls, 1);

      // Money lists it with the other refunds, marked as the parent's cancel.
      const money = await getPage(base, '/app/payments', cookie);
      assert.match(money, /<h2>Refunds<\/h2>/);
      assert.match(money, /Alex<\/strong> · \$35 · Refunded \(client cancelled in time\)/);
      assert.match(money, /The client cancelled in time, and your booking policy refunds that to their card\. Refunded \$35\. The client was told by text and email\./);
      assert.doesNotMatch(money, /Payments to resolve/);
      assert.doesNotMatch(money, /session credit was withdrawn/);
      assert.match(await getPage(base, `/app/sessions/${seed.sessionId}`, cookie), /Paid \$35 · Drop-in · Refunded \(client cancelled in time\)/);
    });

    // The one notice: the refund's own, by text and by email. It says
    // nothing of a credit the parent never held.
    const texts = refundTexts(relay);
    assert.equal(texts.length, 1);
    assert.match(texts[0].body, /^Coachatron: Jamie Coach refunded \$35 for Alex's Goalkeeper Group /);
    const mail = refundEmails(relay, EMAIL);
    assert.equal(mail.length, 1);
    assert.match(mail[0].text, /refunded \$35 to the card you paid with/);
    assert.doesNotMatch(mail[0].text, /credit/);
    assert.equal(relay.sms.filter((m) => m.to === PHONE && /credit/i.test(m.body)).length, 0, 'no text about a credit');
  });
});

test('while the refund is on its way the parent holds no credit and hears nothing; the store event finishes it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      relay.refundStatus = 'pending';
      const { seed, bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_pending' });
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 1);

      // The cancel stands as a credit the refund holds: not offered, not usable.
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.equal(await countSold(db, seed.sessionId), 0, 'the spot is free at once');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: true, withdrawn: false });
      assert.equal(await getCreditBalance(db, seed.coach.id, PHONE), null);
      const waiting = await managePage(base, token);
      assert.match(waiting, /Cancelled/);
      assert.match(waiting, /A refund of \$35 to the card you paid with is on its way\./);
      assert.doesNotMatch(waiting, /session credit/);
      assert.equal(refundTexts(relay).length, 0);
      assert.equal(refundEmails(relay, EMAIL).length, 0);
      assert.equal((await refundOf(db, 'ns_pay_pending'))?.status, 'pending');
      assert.match(await getPage(base, '/app/payments', cookie), /Alex<\/strong> · \$35 · Refund sent \(client cancelled in time\)/);

      const event = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_pending',
        amountCents: 3500,
        refundId: relay.refunds[0].refundRef,
      });
      assert.equal(event.status, 200);
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 0, held: true, withdrawn: true });
      assert.match(await managePage(base, token), /Refunded\. The payment went back to your card\./);

      // The event again changes nothing and tells nobody twice.
      await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_pending',
        amountCents: 3500,
        refundId: relay.refunds[0].refundRef,
        eventId: 'rel_evt_again',
      });
    });
    assert.equal(refundTexts(relay).length, 1, 'told once');
    assert.equal(refundEmails(relay, EMAIL).length, 1);
    assert.equal(relay.refundCalls, 1);
  });
});

test('a refund that fails later gives the parent the credit and says so on the manage page; the coach tries again', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      relay.refundStatus = 'pending';
      const { seed, bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_fails' });
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal((await creditOf(db, bookingId))?.held, true);

      const failed = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refund_failed',
        paymentId: 'ns_pay_fails',
        amountCents: 3500,
        refundId: relay.refunds[0].refundRef,
      });
      assert.equal(failed.status, 200);

      // The credit is released to the parent, and the page tells them.
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: false, withdrawn: false });
      assert.equal((await getCreditBalance(db, seed.coach.id, PHONE))?.remaining, 1);
      const page = await managePage(base, token);
      assert.match(page, /The refund to your card did not go through, so you hold a session credit with Jamie Coach for this booking instead\./);
      assert.doesNotMatch(page, /on its way/);
      assert.equal(refundTexts(relay).length, 0, 'no refund notice for a refund that did not happen');

      // The coach sees it under "Payments to resolve", with the usual retry.
      const money = await getPage(base, '/app/payments', cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(
        money,
        /The client cancelled in time, and your booking policy refunds that to their card\. The refund of \$35 did not go through\. The booking stays cancelled, and the client holds a session credit for it instead\./,
      );
      assert.ok(money.includes(`/app/payments?refund=b${bookingId}#refund`), 'a way to try again');

      // The coach's retry is the same refund, under a new key, and tells the
      // parent once, now naming the credit they had been given.
      relay.refunds[0].status = 'failed';
      relay.refundStatus = 'succeeded';
      const again = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(again.headers.get('location'), '/app/payments?notice=refund-refunded');
      assert.equal(relay.refunds.length, 2);
      assert.equal(relay.refunds[1].idempotencyKey, refundIdempotencyKey('ns_pay_fails', 2));
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 0, held: true, withdrawn: true });
      const row = await refundOf(db, 'ns_pay_fails');
      assert.equal(row?.status, 'refunded');
      assert.equal(row?.credits_withdrawn, 1);
      assert.equal(row?.cancel_booking_id, bookingId, "still the parent's cancel");
    });
    assert.equal(refundTexts(relay).length, 1);
    const mail = refundEmails(relay, EMAIL);
    assert.equal(mail.length, 1);
    assert.match(mail[0].text, /The 1 unused session credit from this payment was removed\./);
  });
});

test('a relay refusal leaves the cancel standing as a session credit and lists the payment under Payments to resolve', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_refused', capacity: 1 });
      relay.refundError = { status: 404, code: 'NOT_FOUND' };
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 1);
      assert.equal(relay.refunds.length, 0, 'no refund was made');

      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.equal(await countSold(db, seed.sessionId), 0, 'the cancel stands and the spot is free');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: false, withdrawn: false });
      assert.equal((await getCreditBalance(db, seed.coach.id, PHONE))?.remaining, 1, 'the parent holds their credit');
      assert.match(await managePage(base, token), /The refund to your card did not go through, so you hold a session credit with Jamie Coach/);
      const row = await refundOf(db, 'ns_pay_refused');
      assert.deepEqual({ status: row?.status, code: row?.error_code, by: row?.cancel_booking_id }, { status: 'failed', code: 'NOT_FOUND', by: bookingId });

      const money = await getPage(base, '/app/payments', cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /The refund of \$35 did not go through\. Stripe has no record of this payment for your account\./);
      assert.match(money, /Try the refund again/);

      // A second cancel tap does not ask again: the retry is the coach's.
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 1);
    });
    assert.equal(refundTexts(relay).length, 0);
    assert.equal(refundEmails(relay, EMAIL).length, 0);
  });
});

test('payments not answering keeps the credit held; the tick sends the same request again, and never gives up', async (t) => {
  quiet(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const first = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_no_answer' });
      relay.refundError = { status: 503, code: 'UNAVAILABLE' };
      assert.equal(await cancelBooking(base, first.token), 303);
      assert.equal(relay.refundCalls, 1);
      assert.equal(await bookingStatus(db, first.bookingId), 'cancelled');
      assert.deepEqual(await creditOf(db, first.bookingId), { remaining: 1, held: true, withdrawn: false }, 'held: the refund may yet be made');
      assert.deepEqual(
        { status: (await refundOf(db, 'ns_pay_no_answer'))?.status, code: (await refundOf(db, 'ns_pay_no_answer'))?.error_code },
        { status: 'requested', code: 'unavailable' },
      );
      assert.match(await managePage(base, first.token), /We are sending your refund of \$35/);
      assert.match(await getPage(base, '/app/payments', first.cookie), /could not be confirmed yet and is still being tried/);

      // Too soon: the tick leaves it. Ten minutes on, it sends it again.
      assert.deepEqual(await runTick(db, new Date()), []);
      assert.equal(relay.refundCalls, 1);
      relay.refundError = null;
      await db.query("update refund set requested_at = now() - interval '11 minutes' where payment_ref = 'ns_pay_no_answer'");
      assert.deepEqual(await runTick(db, new Date()), []);
      assert.equal(relay.refundCalls, 2);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].idempotencyKey, refundIdempotencyKey('ns_pay_no_answer', 1), 'the same key, so the refund is made once');
      assert.equal(await bookingStatus(db, first.bookingId), 'refunded');
      assert.equal(refundTexts(relay).length, 1);
      await runTick(db, new Date());
      assert.equal(relay.refundCalls, 2, 'nothing more to send');

      // A request the app never got to send (it stopped between the cancel
      // and the call) is sent by the tick too.
      const second = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_lost' });
      relay.refundStatus = 'pending';
      assert.equal(await cancelBooking(base, second.token), 303);
      await db.query(
        "update refund set status = 'requested', refund_ref = null, requested_at = now() - interval '11 minutes' where payment_ref = 'ns_pay_lost'",
      );
      relay.refundStatus = 'succeeded';
      relay.refunds.pop();
      await runTick(db, new Date());
      assert.equal(relay.refunds.at(-1)?.idempotencyKey, refundIdempotencyKey('ns_pay_lost', 1));
      assert.equal(await bookingStatus(db, second.bookingId), 'refunded');

      // No answer for a day: the credit stays held and the refund is never
      // marked failed. The tick sends it every hour under the same key.
      const third = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_slow' });
      relay.refundError = { status: 503, code: 'UNAVAILABLE' };
      assert.equal(await cancelBooking(base, third.token), 303);
      assert.match(await managePage(base, third.token), /We are sending your refund of \$35 to the card you paid with\./);
      assert.doesNotMatch(await managePage(base, third.token), /on its way/);
      await db.query(
        "update refund set requested_at = now() - interval '11 minutes', silent_since = now() - interval '25 hours' where payment_ref = 'ns_pay_slow'",
      );
      const calls = relay.refundCalls;
      await runTick(db, new Date());
      assert.equal(relay.refundCalls, calls, 'after a day it is sent hourly, not every ten minutes');
      await db.query("update refund set requested_at = now() - interval '61 minutes' where payment_ref = 'ns_pay_slow'");
      await runTick(db, new Date());
      assert.equal(relay.refundCalls, calls + 1, 'sent again within the hour');
      assert.equal((await refundOf(db, 'ns_pay_slow'))?.status, 'requested', 'never marked failed');
      assert.deepEqual(await creditOf(db, third.bookingId), { remaining: 1, held: true, withdrawn: false }, 'the credit stays held');
      assert.match(await managePage(base, third.token), /We are sending your refund/);
      const money = await getPage(base, '/app/payments', third.cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /could not be confirmed yet and is still being tried\. The client's session credit stays held until it is\./);
      // The relay answers at last, with the original result: one refund.
      relay.refundError = null;
      await db.query("update refund set requested_at = now() - interval '61 minutes' where payment_ref = 'ns_pay_slow'");
      await runTick(db, new Date());
      assert.equal(relay.refunds.filter((r) => r.paymentRef === 'ns_pay_slow').length, 1);
      assert.equal(await bookingStatus(db, third.bookingId), 'refunded');
      assert.deepEqual(await creditOf(db, third.bookingId), { remaining: 0, held: true, withdrawn: true });

      // While payments still do not answer, a tick asks once and leaves the
      // other waiting refunds for the next tick.
      const fourth = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_wait_a' });
      const fifth = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_wait_b' });
      relay.refundError = { status: 503, code: 'UNAVAILABLE' };
      assert.equal(await cancelBooking(base, fourth.token), 303);
      assert.equal(await cancelBooking(base, fifth.token), 303);
      await db.query("update refund set requested_at = now() - interval '11 minutes' where payment_ref in ('ns_pay_wait_a', 'ns_pay_wait_b')");
      const asked = relay.refundCalls;
      assert.deepEqual(await runTick(db, new Date()), []);
      assert.equal(relay.refundCalls, asked + 1);
    });
  });
});

test('unchanged under "a refund": a late cancel, a booking paid with a credit, and the coach\'s own cancel refund nothing', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      // Inside the window: the payment is used, as for a no-show.
      const late = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_late', hours: 3 });
      const latePage = await managePage(base, late.token);
      assert.match(latePage, /so cancelling now uses this booking's payment, the same as not showing up/);
      assert.doesNotMatch(latePage, /refund to your card/);
      assert.equal(await cancelBooking(base, late.token), 303);
      const lateRow = await db.query<{ status: string; late_cancel: boolean; credit_id: number | null }>(
        'select status, late_cancel, credit_id from booking where id = $1',
        [late.bookingId],
      );
      assert.deepEqual(lateRow.rows[0], { status: 'cancelled', late_cancel: true, credit_id: null });

      // A package bought at checkout: its booking drew on the package's
      // credit, which comes back. There is nothing to refund.
      const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
      await startsInHours(db, seed.sessionId, 72);
      await coachChooses(db, seed.coach.id, 'refund');
      const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
      const withCredit = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_package',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
        phone: '5551113333',
      });
      assert.equal(await madeUnder(db, withCredit), 'refund');
      const creditToken = await manageToken(db, withCredit);
      assert.match(await managePage(base, creditToken), /Cancel by .+ and your session credit comes back\./);
      assert.equal(await cancelBooking(base, creditToken), 303);
      assert.deepEqual(await creditOf(db, withCredit), { remaining: 10, held: false, withdrawn: false });

      // A booking paid with one of those credits: the credit comes back too.
      const again = await sessionInHours(db, seed.sessionTypeId, 120);
      const held = await bookOnline(base, seed.coach.handle, again, 'Sam', '5551113333');
      assert.ok(held.key);
      await db.query('update booking set phone_verified_at = now() where checkout_token = $1', [held.key]);
      assert.equal((await postCheckout(base, seed.coach.handle, held.key, { mode: 'credit' })).status, 303);
      const used = await db.query<{ id: number; manage_token: string; cancel_gives: string }>(
        'select id, manage_token, cancel_gives from booking where checkout_token = $1',
        [held.key],
      );
      assert.equal(used.rows[0].cancel_gives, 'refund');
      assert.equal((await creditOf(db, used.rows[0].id))?.remaining, 9);
      assert.match(await managePage(base, used.rows[0].manage_token), /Cancel by .+ and your session credit comes back\./);
      assert.equal(await cancelBooking(base, used.rows[0].manage_token), 303);
      assert.equal((await creditOf(db, used.rows[0].id))?.remaining, 10);

      // The coach cancels a session: every paid booking gets a credit, as before.
      const other = await sessionInHours(db, seed.sessionTypeId, 96);
      const dropIn = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: other,
        paymentId: 'ns_pay_coach_cancels',
        amountCents: 3500,
        phone: '5551114444',
      });
      const cancelled = await cancelScheduledSession(db, seed.coach.id, other);
      assert.equal(cancelled.kind, 'cancelled');
      assert.equal(await bookingStatus(db, dropIn), 'cancelled');
      assert.deepEqual(await creditOf(db, dropIn), { remaining: 1, held: false, withdrawn: false });
      // The coach can still refund it from Session detail.
      assert.ok(
        (await getPage(base, `/app/sessions/${other}`, await coachCookie(db, seed.coach.id))).includes(`/app/sessions/${other}?refund=${dropIn}#refund`),
      );
    });
    assert.equal(relay.refundCalls, 0, 'none of these asks for a refund');
    assert.equal((await db.query<{ n: string }>('select count(*)::text as n from refund')).rows[0].n, '0');
  });
});

test("a coach's refund already on its way when the parent cancels is the only refund, with one notice", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      relay.refundStatus = 'pending';
      const { seed, bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_coach_first' });
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(relay.refundCalls, 1);
      assert.equal(await bookingStatus(db, bookingId), 'booked');

      assert.match(await managePage(base, token), /A refund of this booking's payment is already on its way to your card\./);
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 1, "the parent's cancel asks for no second refund");
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: true, withdrawn: false }, "held by the coach's refund");
      assert.match(await managePage(base, token), /A refund of \$35 to the card you paid with is on its way\./);

      await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_coach_first',
        amountCents: 3500,
        refundId: relay.refunds[0].refundRef,
      });
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      const row = await refundOf(db, 'ns_pay_coach_first');
      assert.equal(row?.status, 'refunded');
      assert.equal(row?.cancel_booking_id, null, "the coach's refund, not the cancel's");
    });
    assert.equal(relay.refunds.length, 1);
    assert.equal(refundTexts(relay).length, 1);
  });
});

test('a payment partly refunded elsewhere cannot go back whole, so the cancel gives a credit and the page says so', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, bookingId, token } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_part' });
      // $10 of it was refunded outside Coachatron, and the store reported it.
      const event = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_part',
        amountCents: 1000,
        refundId: 'ns_rfd_elsewhere',
      });
      assert.equal(event.status, 200);
      assert.equal((await refundOf(db, 'ns_pay_part'))?.status, 'partial');

      const page = await managePage(base, token);
      assert.match(page, /Cancel by .+ for a session credit with Jamie Coach\. This payment cannot be refunded to your card from here: ask Jamie Coach\./);
      assert.doesNotMatch(page, /goes back to the card you paid with/);
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal(relay.refundCalls, 0);
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: false, withdrawn: false });
      assert.equal((await getCreditBalance(db, seed.coach.id, PHONE))?.remaining, 1);
      assert.equal((await refundOf(db, 'ns_pay_part'))?.cancel_booking_id, null);
    });
  });
});

test("a coach's retry of a failed refund starts its no-answer time again, so the tick does not slow it", async (t) => {
  quiet(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { bookingId, token, cookie } = await paidDropIn(base, db, { gives: 'refund', paymentId: 'ns_pay_retry_clock' });
      relay.refundError = { status: 404, code: 'NOT_FOUND' };
      assert.equal(await cancelBooking(base, token), 303);
      assert.equal((await refundOf(db, 'ns_pay_retry_clock'))?.status, 'failed');
      // The failure is more than a day old when the coach tries again.
      await db.query("update refund set silent_since = now() - interval '30 hours' where payment_ref = 'ns_pay_retry_clock'");
      relay.refundError = { status: 503, code: 'UNAVAILABLE' };
      await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      const since = await db.query<{ fresh: boolean }>(
        "select silent_since > now() - interval '1 minute' as fresh from refund where payment_ref = 'ns_pay_retry_clock'",
      );
      assert.equal(since.rows[0].fresh, true, 'the day is counted from this try');
      await db.query("update refund set requested_at = now() - interval '11 minutes' where payment_ref = 'ns_pay_retry_clock'");
      const calls = relay.refundCalls;
      await runTick(db, new Date());
      assert.equal(relay.refundCalls, calls + 1, 'resent at the ten-minute rate');
      assert.deepEqual(await creditOf(db, bookingId), { remaining: 1, held: true, withdrawn: false });
    });
  });
});
