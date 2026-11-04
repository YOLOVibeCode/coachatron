import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { postPaymentEvent } from './helpers/store-event.js';
import { bookingStatus, coachCookie, creditLeft, getPage, payFor, postForm, refundRow, refundTexts } from './helpers/refunds.js';

/** Refund and dispute events at /webhooks/store, each handled once: a
 * refund Stripe confirms later is finished by its event, a refund made
 * outside Coachatron is applied when it is whole and only shown when it is
 * part, a failed refund shows on Money, and card disputes are recorded and
 * explained without changing bookings or credits. */

test('a refund Stripe confirms later is finished by its event, once, however often it arrives', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_later',
        amountCents: 15000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      const cookie = await coachCookie(db, seed.coach.id);
      relay.refundStatus = 'pending';
      const sent = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(sent.headers.get('location'), '/app/money?notice=refund-pending');
      assert.equal(await bookingStatus(db, bookingId), 'booked', 'nothing changes until Stripe confirms');
      assert.equal(await creditLeft(db, bookingId), 4);
      assert.match(await getPage(base, '/app/money', cookie), /Refund of \$150 sent\. Stripe confirms it shortly\./);

      const refundId = relay.refunds[0].refundRef;
      const event = { type: 'marketplace.purchase.refunded' as const, paymentId: 'ns_pay_later', refundId, amountCents: 15000 };
      assert.equal((await postPaymentEvent(base, event)).status, 200);
      assert.equal((await postPaymentEvent(base, event)).status, 200);
      assert.equal((await postPaymentEvent(base, { ...event, eventId: 'rel_evt_other_delivery' })).status, 200);

      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.equal(await creditLeft(db, bookingId), 0);
    });
    const row = await refundRow(db, 'ns_pay_later');
    assert.equal(row.status, 'refunded');
    assert.equal(row.credits_withdrawn, 4);
    assert.equal(refundTexts(relay).length, 1, 'the parent is told once');
    const events = await db.query<{ n: string }>("select count(*)::text as n from store_event where type = 'marketplace.purchase.refunded'");
    assert.equal(events.rows[0].n, '2', 'each delivery id is recorded once');
  });
});

test('a whole refund made outside Coachatron is applied, and credits already used are counted, never below zero', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_elsewhere',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      await db.query('update credit set remaining = remaining - 2 where id = (select credit_id from booking where id = $1)', [bookingId]);
      const res = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_elsewhere',
        refundId: 'ns_rfd_outside1',
        amountCents: 30000,
      });
      assert.equal(res.status, 200);
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.equal(await creditLeft(db, bookingId), 0);
      const money = await getPage(base, '/app/money', await coachCookie(db, seed.coach.id));
      assert.match(money, /Refunded \$300 \(outside Coachatron\)\. The spot is free again\. 7 unused session credits were withdrawn\. 2 sessions it bought were already used\./);
    });
    const row = await refundRow(db, 'ns_pay_elsewhere');
    assert.deepEqual(
      { from_app: row.from_app, credits_withdrawn: row.credits_withdrawn, credits_used: row.credits_used },
      { from_app: false, credits_withdrawn: 7, credits_used: 2 },
    );
    assert.equal(relay.refundCalls, 0);
  });
});

test('part of a payment refunded outside Coachatron changes nothing and is shown to resolve', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_part', amountCents: 3500 });
      const res = await postPaymentEvent(base, { type: 'marketplace.purchase.refunded', paymentId: 'ns_pay_part', refundId: 'ns_rfd_part1', amountCents: 1000 });
      assert.equal(res.status, 200);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
      const cookie = await coachCookie(db, seed.coach.id);
      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /\$10 of this payment was refunded outside Coachatron\. The booking and its credits were not changed\./);
      const confirm = await getPage(base, `/app/money?refund=b${bookingId}`, cookie);
      assert.match(confirm, /Part of this payment was already refunded outside Coachatron\./);
    });
    assert.equal((await refundRow(db, 'ns_pay_part')).status, 'partial');
  });
});

test('a refund that fails after it was sent shows on Money as needing attention', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_bounce', amountCents: 3500 });
      const cookie = await coachCookie(db, seed.coach.id);
      relay.refundStatus = 'pending';
      await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      const res = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refund_failed',
        paymentId: 'ns_pay_bounce',
        refundId: relay.refunds[0].refundRef,
        amountCents: 3500,
      });
      assert.equal(res.status, 200);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /The refund of \$35 did not go through\. Nothing else changed\./);
      assert.ok(money.includes(`/app/money?refund=b${bookingId}#refund`), 'it can be tried again');
    });
    assert.equal((await refundRow(db, 'ns_pay_bounce')).status, 'failed');
  });
});

test('card disputes are recorded and shown with what they mean; nothing else changes', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_disputed', amountCents: 3500 });
      const cookie = await coachCookie(db, seed.coach.id);
      const dispute = { paymentId: 'ns_pay_disputed', disputeId: 'ns_dsp_one', amountCents: 3500 };
      assert.equal((await postPaymentEvent(base, { type: 'marketplace.purchase.disputed', ...dispute })).status, 200);
      let money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Card disputes/);
      assert.match(money, /Alex/);
      assert.match(money, /\$35 · Open/);
      assert.match(money, /Stripe handles card disputes, and Coachatron holds no funds: while it is open, Stripe holds the disputed amount from your payment account\./);

      assert.equal((await postPaymentEvent(base, { type: 'marketplace.purchase.dispute_won', ...dispute })).status, 200);
      // A late "opened" never undoes the outcome.
      assert.equal((await postPaymentEvent(base, { type: 'marketplace.purchase.disputed', ...dispute, eventId: 'rel_evt_late_open' })).status, 200);
      money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Decided for you/);
      assert.match(money, /was decided in your favor/);

      const lost = { paymentId: 'ns_pay_disputed', disputeId: 'ns_dsp_two', amountCents: 3500 };
      assert.equal((await postPaymentEvent(base, { type: 'marketplace.purchase.dispute_lost', ...lost })).status, 200);
      money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Decided for the cardholder/);
      assert.match(money, /The booking and its credits were not changed\./);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
    });
    const states = await db.query<{ dispute_ref: string; state: string; closed_at: string | null }>(
      'select dispute_ref, state, closed_at from payment_dispute order by id',
    );
    assert.deepEqual(
      states.rows.map((r) => [r.dispute_ref, r.state, r.closed_at !== null]),
      [
        ['ns_dsp_one', 'won', true],
        ['ns_dsp_two', 'lost', true],
      ],
    );
  });
});

