import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, type SeededSession } from './helpers/fixtures.js';
import { postPaymentEvent } from './helpers/store-event.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import type { DbClient } from '../src/db/client.js';
import {
  PHONE,
  bookingStatus,
  coachCookie,
  creditLeft,
  getPage,
  payFor,
  postForm,
  readable,
  refundRow,
  refundTexts,
} from './helpers/refunds.js';

/** What a refund does to the sessions a payment bought: a drop-in the
 * parent cancelled is refunded like any other, the credit a package bought
 * cannot be booked with while its refund is on its way (and comes back if
 * the refund fails), a refunded credit gets nothing back when a booking
 * that used it is cancelled, a booking paid with a credit points to the
 * payment it came from, and a session that already happened is marked
 * refunded rather than freed. */

/** Another session of the seeded type, a few days out. */
async function laterSession(db: DbClient, seed: SeededSession, days: number): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, now() + make_interval(days => $2::int), 'America/Chicago', 'scheduled') returning id`,
    [seed.sessionTypeId, days],
  );
  return r.rows[0].id;
}

/** The parent starts a booking with the number their credits are on, and
 * has proved they hold it; returns the checkout key. */
async function startCreditBooking(base: string, db: DbClient, handle: string, sessionId: number, athlete: string): Promise<string> {
  const b = await bookOnline(base, handle, sessionId, athlete, '5551112222');
  assert.ok(b.key, `booked (${b.status})`);
  await db.query('update booking set phone_verified_at = now() where checkout_token = $1', [b.key]);
  return b.key;
}

async function bookingByKey(db: DbClient, key: string): Promise<{ id: number; manage_token: string }> {
  return (await db.query<{ id: number; manage_token: string }>('select id, manage_token from booking where checkout_token = $1', [key])).rows[0];
}

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

test('a drop-in the parent cancelled is refunded from Session detail, once, and the parent is told', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_dropped',
        amountCents: 3500,
        extra: { contact_email: 'parent@example.com' },
      });
      const cancel = await fetch(`${base}/booking/${await manageToken(db, bookingId)}/cancel`, { method: 'POST', redirect: 'manual' });
      assert.equal(cancel.status, 303);
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      const cookie = await coachCookie(db, seed.coach.id);

      const detail = await getPage(base, `/app/sessions/${seed.sessionId}`, cookie);
      assert.match(detail, /Paid \$35 · Drop-in/);
      assert.doesNotMatch(detail, /sessions this payment bought/);
      assert.ok(detail.includes(`/app/sessions/${seed.sessionId}?refund=${bookingId}#refund`), 'a Refund link');

      const confirm = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${bookingId}`, cookie);
      assert.match(confirm, /Refund \$35\?/);
      assert.match(confirm, /Alex's booking was already cancelled, so nothing else changes\./);
      assert.doesNotMatch(confirm, /spot is free again/);

      const done = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(done.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-refunded`);
      assert.equal(relay.refundCalls, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_dropped');
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
    });
    assert.equal(refundTexts(relay).length, 1, 'the parent is texted once');
    const mail = relay.emails.filter((e) => e.to === 'parent@example.com' && /^Refund from/.test(e.subject));
    assert.equal(mail.length, 1);
    assert.doesNotMatch(mail[0].text, /That booking is/, 'the booking was already cancelled');
    const row = await refundRow(db, 'ns_pay_dropped');
    assert.deepEqual(
      { status: row.status, released: row.spot_released, withdrawn: row.credits_withdrawn, used: row.credits_used, told: row.parent_told },
      { status: 'refunded', released: false, withdrawn: 0, used: 0, told: 'text+email' },
    );
  });
});

test('the credits of a package whose refund is on its way cannot be booked with, and come back if the refund fails', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const later = await laterSession(db, seed, 3);
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const purchaseId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_held',
        amountCents: 15000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      assert.equal(await creditLeft(db, purchaseId), 4);
      const cookie = await coachCookie(db, seed.coach.id);
      relay.refundStatus = 'pending';
      const sent = await postForm(base, '/app/money/refund', cookie, { target: `b${purchaseId}` });
      assert.equal(sent.headers.get('location'), '/app/money?notice=refund-pending');

      // While Stripe confirms, the parent tries to book with one of its credits.
      const key = await startCreditBooking(base, db, seed.coach.handle, later, 'Alex');
      const tried = await postCheckout(base, seed.coach.handle, key, { mode: 'credit' });
      assert.equal(tried.status, 409);
      assert.match(readable(await tried.text()), /That credit is no longer available\./);
      assert.equal(await creditLeft(db, purchaseId), 4);
      assert.equal(await bookingStatus(db, (await bookingByKey(db, key)).id), 'pending');

      // The refund does not go through, so the credits can be used again.
      const failed = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refund_failed',
        paymentId: 'ns_pay_held',
        refundId: relay.refunds[0].refundRef,
        amountCents: 15000,
      });
      assert.equal(failed.status, 200);
      const again = await postCheckout(base, seed.coach.handle, key, { mode: 'credit' });
      assert.equal(again.status, 303);
      assert.equal(await bookingStatus(db, (await bookingByKey(db, key)).id), 'booked');
      assert.equal(await creditLeft(db, purchaseId), 3);

      // A credit is used now, so a second try is not sent, and says why.
      const retry = await postForm(base, '/app/money/refund', cookie, { target: `b${purchaseId}` });
      assert.equal(retry.headers.get('location'), `/app/money?refund=b${purchaseId}#refund`);
      assert.match(await getPage(base, `/app/money?refund=b${purchaseId}`, cookie), /1 of the 5 sessions this payment bought was used/);
    });
    assert.equal(relay.refundCalls, 1);
    assert.equal((await refundRow(db, 'ns_pay_held')).status, 'failed');
  });
});

test('a refund Stripe confirms later withdraws the credits that were held for it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const purchaseId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_confirmed',
        amountCents: 15000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      relay.refundStatus = 'pending';
      await postForm(base, '/app/money/refund', await coachCookie(db, seed.coach.id), { target: `b${purchaseId}` });
      const event = { type: 'marketplace.purchase.refunded' as const, paymentId: 'ns_pay_confirmed', refundId: relay.refunds[0].refundRef, amountCents: 15000 };
      assert.equal((await postPaymentEvent(base, event)).status, 200);
      assert.equal(await creditLeft(db, purchaseId), 0);
    });
    const row = await refundRow(db, 'ns_pay_confirmed');
    assert.deepEqual({ status: row.status, withdrawn: row.credits_withdrawn, used: row.credits_used }, { status: 'refunded', withdrawn: 4, used: 0 });
  });
});

test('after a whole refund made outside Coachatron, a cancelled booking that used its credit gives nothing back', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const first = await laterSession(db, seed, 3);
    const second = await laterSession(db, seed, 4);
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const purchaseId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_outside',
        amountCents: 15000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      const keyA = await startCreditBooking(base, db, seed.coach.handle, first, 'Alex');
      assert.equal((await postCheckout(base, seed.coach.handle, keyA, { mode: 'credit' })).status, 303);
      const keyB = await startCreditBooking(base, db, seed.coach.handle, second, 'Sam');
      assert.equal((await postCheckout(base, seed.coach.handle, keyB, { mode: 'credit' })).status, 303);
      assert.equal(await creditLeft(db, purchaseId), 2);

      const res = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ns_pay_outside',
        refundId: 'ns_rfd_outside2',
        amountCents: 15000,
      });
      assert.equal(res.status, 200);
      assert.equal(await creditLeft(db, purchaseId), 0);
      const bookedA = await bookingByKey(db, keyA);
      assert.equal(await bookingStatus(db, bookedA.id), 'booked', 'a session the credit already bought stays booked');

      // The parent cancels in time: the booking is cancelled, and the refunded credit stays at zero.
      const cancel = await fetch(`${base}/booking/${bookedA.manage_token}/cancel`, { method: 'POST', redirect: 'manual' });
      assert.equal(cancel.status, 303);
      assert.equal(await bookingStatus(db, bookedA.id), 'cancelled');
      assert.equal(await creditLeft(db, purchaseId), 0);
    });

    // The coach cancels the other session: nothing comes back, and the parent is not told it did.
    const result = await cancelScheduledSession(db, seed.coach.id, second);
    assert.equal(result.kind, 'cancelled');
    if (result.kind === 'cancelled') assert.equal(result.creditsReturned, 0);
    const credit = await db.query<{ remaining: number }>(
      "select c.remaining from credit c join booking b on b.credit_id = c.id where b.charge_id = 'ns_pay_outside'",
    );
    assert.equal(credit.rows[0].remaining, 0);
    const cancelText = relay.sms.filter((m) => m.to === PHONE && /Sam/.test(m.body) && /cancel/i.test(m.body));
    assert.equal(cancelText.length, 1);
    assert.doesNotMatch(cancelText[0].body, /credit/i);
  });
});

test('a booking paid with a session credit says so on Session detail, with a link to the payment it came from', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const later = await laterSession(db, seed, 3);
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await withServer(async (base) => {
      const purchaseId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_source',
        amountCents: 15000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      const key = await startCreditBooking(base, db, seed.coach.handle, later, 'Alex');
      assert.equal((await postCheckout(base, seed.coach.handle, key, { mode: 'credit' })).status, 303);
      const cookie = await coachCookie(db, seed.coach.id);

      const detail = await getPage(base, `/app/sessions/${later}`, cookie);
      assert.match(detail, /This booking used a session credit\. To refund it, refund the payment the credit came from\./);
      assert.ok(detail.includes(`/app/money?refund=b${purchaseId}#refund`), 'a link to the payment the credit came from');
      assert.match(detail, /See the payment the credit came from/);

      const source = await getPage(base, `/app/money?refund=b${purchaseId}`, cookie);
      assert.match(source, /1 of the 5 sessions this payment bought was used/);
    });
    assert.equal(relay.refundCalls, 0);
  });
});

test('a refund for a session that already happened marks the booking refunded and says so', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_past',
        amountCents: 3500,
        extra: { contact_email: 'parent@example.com' },
      });
      await db.query("update session set starts_at_utc = now() - interval '2 hours' where id = $1", [seed.sessionId]);
      await db.query("update booking set status = 'attended' where id = $1", [bookingId]);
      const cookie = await coachCookie(db, seed.coach.id);

      const confirm = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${bookingId}`, cookie);
      assert.match(confirm, /Alex's booking is marked refunded\./);
      assert.doesNotMatch(confirm, /spot is free again/);

      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Refunded \$35\./);
      assert.doesNotMatch(money, /The spot is free again/);
    });
    assert.equal(relay.refundCalls, 1);
    const mail = relay.emails.filter((e) => e.to === 'parent@example.com' && /^Refund from/.test(e.subject));
    assert.equal(mail.length, 1);
    assert.match(mail[0].text, /That booking is marked refunded\./);
    assert.doesNotMatch(mail[0].text, /That booking is cancelled/);
    assert.equal((await refundRow(db, 'ns_pay_past')).spot_released, false);
  });
});
