import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedPackage, type SeededSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { postPaymentEvent } from './helpers/store-event.js';
import { zoneAt } from './helpers/clock.js';
import { PHONE, bookingStatus, coachCookie, creditLeft, payFor, postForm, readable, refundRow } from './helpers/refunds.js';
import { checkRefund } from '../src/domain/refunds.js';
import { waiveBooking } from '../src/domain/policy.js';
import { getCreditBalance } from '../src/domain/pricing.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { moveWaitlists } from '../src/domain/waitlist.js';
import type { DbClient } from '../src/db/client.js';

/** Refunds (SPEC.md §9.4) under the booking policy (SPEC.md §9.5): a
 * session the coach gave back counts as unused only while the credit it
 * went to is unused; a late cancel of a package's own booking is refunded
 * the same as a no-show; a credit a cancel or a give-back makes while a
 * refund is on its way is held with it; and a spot a refund frees goes to
 * the waitlist at once. */

/** Another session of the seeded type, some hours from now. */
async function sessionInHours(db: DbClient, seed: SeededSession, hours: number): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, now() + make_interval(hours => $2::int), 'America/Chicago', 'scheduled') returning id`,
    [seed.sessionTypeId, hours],
  );
  return r.rows[0].id;
}

async function startsInHours(db: DbClient, sessionId: number, hours: number): Promise<void> {
  await db.query('update session set starts_at_utc = now() + make_interval(hours => $2::int) where id = $1', [sessionId, hours]);
}

/** The session happened and the child did not come. */
async function markNoShow(db: DbClient, sessionId: number, bookingId: number): Promise<void> {
  await db.query("update session set starts_at_utc = now() - interval '2 hours' where id = $1", [sessionId]);
  await db.query("update booking set status = 'noshow' where id = $1", [bookingId]);
}

/** The parent books another session with the credit on their number. */
async function bookWithCredit(base: string, db: DbClient, handle: string, sessionId: number): Promise<void> {
  const b = await bookOnline(base, handle, sessionId, 'Sam', '5551112222');
  assert.ok(b.key, `booked (${b.status})`);
  await db.query('update booking set phone_verified_at = now() where checkout_token = $1', [b.key]);
  assert.equal((await postCheckout(base, handle, b.key, { mode: 'credit' })).status, 303);
}

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

test("a package's no-show the coach gave back is refundable whole until that session is booked again", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const later = await sessionInHours(db, seed, 72);
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const purchaseId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_pkg_waived',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      await markNoShow(db, seed.sessionId, purchaseId);
      assert.equal(await waiveBooking(db, seed.coach.id, seed.sessionId, purchaseId), true);
      assert.equal(await creditLeft(db, purchaseId), 10);

      const before = await checkRefund(db, seed.coach.id, { bookingId: purchaseId });
      assert.ok(before.ok, 'nothing it bought is used yet');
      if (before.ok) assert.equal(before.plan.creditsWithdrawn, 10);

      await bookWithCredit(base, db, seed.coach.handle, later);
      assert.equal(await creditLeft(db, purchaseId), 9);
      const after = await checkRefund(db, seed.coach.id, { bookingId: purchaseId });
      assert.deepEqual(after, { ok: false, block: { kind: 'credits_used', used: 1, sessions: 10 } });
    });
  });
});

test('a paid drop-in no-show the coach gave back is refundable whole until its credit is spent', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    const later = await sessionInHours(db, seed, 72);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_drop_waived',
        amountCents: 3500,
      });
      await markNoShow(db, seed.sessionId, bookingId);
      assert.equal(await waiveBooking(db, seed.coach.id, seed.sessionId, bookingId), true);

      const before = await checkRefund(db, seed.coach.id, { bookingId });
      assert.ok(before.ok, 'the credit it became is unused');
      if (before.ok) assert.equal(before.plan.creditsWithdrawn, 1);

      await bookWithCredit(base, db, seed.coach.handle, later);
      assert.equal(await creditLeft(db, bookingId), 0);
      const after = await checkRefund(db, seed.coach.id, { bookingId });
      assert.deepEqual(after, { ok: false, block: { kind: 'credits_used', used: 1, sessions: 1 } });
    });
  });
});

test("a late cancel of a package's own booking is refunded whole, the same as a no-show", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const other = await sessionInHours(db, seed, 2);
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await startsInHours(db, seed.sessionId, 2);
    await withServer(async (base) => {
      const lateId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_pkg_late',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      const cancel = await fetch(`${base}/booking/${await manageToken(db, lateId)}/cancel`, { method: 'POST', redirect: 'manual' });
      assert.equal(cancel.status, 303);
      const late = await db.query<{ status: string; late_cancel: boolean }>('select status, late_cancel from booking where id = $1', [lateId]);
      assert.deepEqual(late.rows[0], { status: 'cancelled', late_cancel: true });
      assert.equal(await creditLeft(db, lateId), 9, 'the late cancel used its session');

      const noShowId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: other,
        paymentId: 'ns_pay_pkg_noshow',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
        phone: '5551113333',
      });
      await markNoShow(db, other, noShowId);

      for (const id of [lateId, noShowId]) {
        const check = await checkRefund(db, seed.coach.id, { bookingId: id });
        assert.ok(check.ok, `booking ${id} is refundable whole`);
        if (check.ok) assert.equal(check.plan.creditsWithdrawn, 9);
      }

      const cookie = await coachCookie(db, seed.coach.id);
      const done = await postForm(base, '/app/money/refund', cookie, { target: `b${lateId}` });
      assert.equal(done.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(await bookingStatus(db, lateId), 'refunded');
    });
    assert.equal(relay.refundCalls, 1);
    const row = await refundRow(db, 'ns_pay_pkg_late');
    assert.deepEqual({ status: row.status, withdrawn: row.credits_withdrawn, used: row.credits_used }, { status: 'refunded', withdrawn: 9, used: 0 });
  });
});

test("while a drop-in's refund is on its way, the credit the parent's cancel makes is held, and comes back if the refund fails", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await startsInHours(db, seed.sessionId, 72);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_parent_held',
        amountCents: 3500,
      });
      relay.refundStatus = 'pending';
      const cookie = await coachCookie(db, seed.coach.id);
      const sent = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(sent.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-pending`);

      // The parent cancels in time before Stripe confirms the refund.
      const token = await manageToken(db, bookingId);
      assert.equal((await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
      assert.equal(await bookingStatus(db, bookingId), 'cancelled');
      assert.equal(await getCreditBalance(db, seed.coach.id, PHONE), null, 'the credit it became cannot be used');
      const manage = readable(await (await fetch(`${base}/booking/${token}`)).text());
      assert.doesNotMatch(manage, /session credit with .* is back/);

      const failed = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refund_failed',
        paymentId: 'ns_pay_parent_held',
        refundId: relay.refunds[0].refundRef,
        amountCents: 3500,
      });
      assert.equal(failed.status, 200);
      assert.equal((await getCreditBalance(db, seed.coach.id, PHONE))?.remaining, 1);
      assert.match(readable(await (await fetch(`${base}/booking/${token}`)).text()), /Your session credit with .* is back\./);
    });
  });
});

test("while a drop-in's refund is on its way, the credit the coach gives back for its no-show is held, and the refund withdraws it", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_waive_held',
        amountCents: 3500,
      });
      await markNoShow(db, seed.sessionId, bookingId);
      relay.refundStatus = 'pending';
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, await coachCookie(db, seed.coach.id));
      assert.equal((await refundRow(db, 'ns_pay_waive_held')).status, 'pending');

      assert.equal(await waiveBooking(db, seed.coach.id, seed.sessionId, bookingId), true);
      assert.equal(await getCreditBalance(db, seed.coach.id, PHONE), null, 'the credit given back cannot be used');

      const event = { type: 'marketplace.purchase.refunded' as const, paymentId: 'ns_pay_waive_held', refundId: relay.refunds[0].refundRef, amountCents: 3500 };
      assert.equal((await postPaymentEvent(base, event)).status, 200);
      assert.equal(await creditLeft(db, bookingId), 0);
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
    });
    const row = await refundRow(db, 'ns_pay_waive_held');
    assert.deepEqual({ status: row.status, withdrawn: row.credits_withdrawn, used: row.credits_used }, { status: 'refunded', withdrawn: 1, used: 0 });
  });
});

test('a spot a refund frees is offered to the first person waiting at once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
    const waiting = '+15550004001';
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_frees_spot',
        amountCents: 3500,
      });
      await grantSmsConsent(db, waiting);
      await db.query('insert into waitlist (session_id, contact_phone, athlete_name) values ($1, $2, $3)', [seed.sessionId, waiting, 'Ann Waiting']);

      const done = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, await coachCookie(db, seed.coach.id));
      assert.equal(done.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-refunded`);
    });
    const line = await db.query<{ state: string }>('select state from waitlist where session_id = $1', [seed.sessionId]);
    assert.equal(line.rows[0].state, 'offered');
    assert.ok(relay.sms.some((m) => m.to === waiting && /spot opened/.test(m.body)));
  });
});

test('a spot offer whose booking was refunded leaves the line as lapsed', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db, { capacity: 2 });
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Ann Offered', '+15550004002');
  await db.query("update booking set status = 'refunded' where id = $1", [bookingId]);
  await db.query(
    "insert into waitlist (session_id, contact_phone, athlete_name, state, offer_booking_id) values ($1, $2, $3, 'offered', $4)",
    [seed.sessionId, '+15550004002', 'Ann Offered', bookingId],
  );
  await moveWaitlists(db, new Date());
  const line = await db.query<{ state: string }>('select state from waitlist where session_id = $1', [seed.sessionId]);
  assert.equal(line.rows[0].state, 'lapsed');
});
