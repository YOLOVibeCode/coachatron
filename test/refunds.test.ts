import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { bookOnline, countSold, postCheckout } from './helpers/booking.js';
import { getConnectRecipientKey } from '../src/domain/auth.js';
import { refundIdempotencyKey } from '../src/domain/refunds.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { PHONE, bookingStatus, coachCookie, creditLeft, getPage, payFor, postForm, quiet, refundRow } from './helpers/refunds.js';

/** A coach refunds a whole payment from Session detail or Money, after a
 * confirmation, through the relay's seller refund route. The booking it
 * bought is refunded and its spot freed, and the session credits it bought
 * are withdrawn. A payment whose sessions were used is not refunded here,
 * and says why. A second tap sends nothing; a refusal or a lost answer can
 * be tried again without a second refund. */

test('a paid drop-in is refunded from Session detail after a confirmation, once, and its spot opens', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_alex', amountCents: 3500 });
      const cookie = await coachCookie(db, seed.coach.id);

      const detail = await getPage(base, `/app/sessions/${seed.sessionId}`, cookie);
      assert.match(detail, /Paid \$35 · Drop-in/);
      assert.ok(detail.includes(`/app/sessions/${seed.sessionId}?refund=${bookingId}#refund`), 'a Refund link');

      const confirm = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${bookingId}`, cookie);
      assert.match(confirm, /Refund \$35\?/);
      assert.match(confirm, /Alex's booking is cancelled and the spot is free again\./);
      assert.match(confirm, /Coachatron's 5% fee is returned with it/);
      assert.match(confirm, /Confirm refund/);
      assert.equal(relay.refundCalls, 0, 'nothing is sent before the coach confirms');

      const done = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(done.status, 303);
      assert.equal(done.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-refunded`);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_alex');
      assert.equal(relay.refunds[0].sellerKey, getConnectRecipientKey(seed.coach));
      assert.equal(relay.refunds[0].idempotencyKey, refundIdempotencyKey('ns_pay_alex', 1));
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.equal(await countSold(db, seed.sessionId), 0);

      // A second tap, and a second confirmation from an old page, send nothing.
      const again = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(again.status, 303);
      assert.equal(relay.refundCalls, 1);
      const rows = await db.query<{ n: string }>('select count(*)::text as n from refund');
      assert.equal(rows.rows[0].n, '1');

      const after = await getPage(base, `/app/sessions/${seed.sessionId}?notice=refund-refunded`, cookie);
      assert.match(after, /Refunded\./);
      assert.match(after, /Paid \$35 · Drop-in · Refunded/);

      // The spot is open again.
      const next = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Sam', '5553334444');
      assert.ok(next.key, `a new parent can book the spot (${next.status})`);
    });
    const row = await refundRow(db, 'ns_pay_alex');
    assert.equal(row.status, 'refunded');
    assert.equal(row.spot_released, true);
  });
});

test('a package nobody has drawn on is refunded from Money and its unused credits are withdrawn', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_pkg',
        amountCents: 30000,
        fields: { mode: 'package', package_id: String(packageId) },
      });
      assert.equal(await creditLeft(db, bookingId), 9);
      const cookie = await coachCookie(db, seed.coach.id);

      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Recent payments/);
      assert.ok(money.includes(`/app/money?refund=b${bookingId}#refund`), 'a Refund link on Money');
      assert.match(money, /9 credits outstanding/);

      const confirm = await getPage(base, `/app/money?refund=b${bookingId}`, cookie);
      assert.match(confirm, /Refund \$300\?/);
      assert.match(confirm, /The 9 unused session credits it bought are withdrawn\./);

      const done = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(done.status, 303);
      assert.equal(done.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(relay.refunds.length, 1);

      const after = await getPage(base, '/app/money?notice=refund-refunded', cookie);
      assert.match(after, /0 credits outstanding/);
      assert.match(after, /Refunded \$300\. The spot is free again\. 9 unused session credits were withdrawn\./);
    });
    assert.equal(await creditLeft(db, (await db.query<{ id: number }>("select id from booking where charge_id = 'ns_pay_pkg'")).rows[0].id), 0);
    const row = await refundRow(db, 'ns_pay_pkg');
    assert.equal(row.credits_withdrawn, 9);
    assert.equal(row.credits_used, 0);
  });
});

test('a pack whose sessions were used is not refunded here, and the coach is told why', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_pack',
        amountCents: 12000,
        fields: { mode: 'plan', plan_id: String(planId) },
      });
      // Another session was booked with one of the pack's credits.
      await db.query('update credit set remaining = remaining - 1 where id = (select credit_id from booking where id = $1)', [bookingId]);
      const cookie = await coachCookie(db, seed.coach.id);

      const detail = await getPage(base, `/app/sessions/${seed.sessionId}`, cookie);
      assert.match(detail, /Paid \$120 · One-time pack\. 1 of the 4 sessions this payment bought was used, so it cannot be refunded in full here\./);
      assert.ok(!detail.includes(`?refund=${bookingId}#refund`), 'no Refund link');

      const confirm = await getPage(base, `/app/money?refund=b${bookingId}`, cookie);
      assert.match(confirm, /1 of the 4 sessions this payment bought was used/);
      assert.doesNotMatch(confirm, /Confirm refund/);

      const tried = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(tried.status, 303);
      assert.equal(tried.headers.get('location'), `/app/money?refund=b${bookingId}#refund`);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
    });
    assert.equal(relay.refundCalls, 0);
    assert.equal(await refundRow(db, 'ns_pay_pack'), null);
  });
});

test('a booking paid with a session credit points the coach at the payment that bought it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const credit = await db.query<{ id: number }>(
      "insert into credit (coach_id, contact_phone, package_id, remaining, source) values ($1, $2, $3, 4, $4) returning id",
      [seed.coach.id, PHONE, packageId, `package:${packageId}`],
    );
    const used = await db.query<{ id: number }>(
      `insert into booking (session_id, athlete_name, contact_phone, payment_source, credit_id, status, manage_token)
       values ($1, 'Alex', $2, 'PackageCredit', $3, 'booked', 'tok-credit') returning id`,
      [seed.sessionId, PHONE, credit.rows[0].id],
    );
    await withServer(async (base) => {
      const cookie = await coachCookie(db, seed.coach.id);
      const confirm = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${used.rows[0].id}`, cookie);
      assert.match(confirm, /This booking used a session credit\. Refund the package or pack the credit came from instead\./);
      const tried = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${used.rows[0].id}/refund`, cookie);
      assert.equal(tried.status, 303);
    });
    assert.equal(relay.refundCalls, 0);
    assert.equal(await bookingStatus(db, used.rows[0].id), 'booked');
  });
});

test('a payment kept for the coach is refunded with one tap and a confirmation, and leaves the list', async (t) => {
  quiet(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const userId = buyerFromLocation(pay.headers.get('location'));
      assert.equal((await postStorePaid(base, { userId, amountCents: 100, paymentId: 'ns_pay_short' })).status, 200);
      const item = await db.query<{ id: number }>("select id from payment_attention where payment_ref = 'ns_pay_short'");
      const attentionId = item.rows[0].id;
      const cookie = await coachCookie(db, seed.coach.id);

      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Payments to resolve/);
      assert.ok(money.includes(`/app/money?refund=a${attentionId}#refund`));
      assert.match(money, /Refund \$1/);

      const confirm = await getPage(base, `/app/money?refund=a${attentionId}`, cookie);
      assert.match(confirm, /Refund \$1\?/);
      assert.match(confirm, /This payment booked nothing, so nothing else changes\./);
      assert.equal(relay.refundCalls, 0);

      const done = await postForm(base, '/app/money/refund', cookie, { target: `a${attentionId}` });
      assert.equal(done.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_short');

      const after = await getPage(base, '/app/money', cookie);
      assert.doesNotMatch(after, /Payments to resolve/);
      assert.match(after, /Refunded \$1\./);
    });
    const resolved = await db.query<{ resolved_at: string | null }>("select resolved_at from payment_attention where payment_ref = 'ns_pay_short'");
    assert.ok(resolved.rows[0].resolved_at);
    // The booking it was meant for was never booked by it, and stays as it was.
    assert.equal((await db.query<{ status: string }>('select status from booking order by id desc limit 1')).rows[0].status, 'pending');
  });
});

test('a payment that became credit when the coach cancelled is refunded while the credit is unused', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const userId = buyerFromLocation(pay.headers.get('location'));
      await cancelScheduledSession(db, seed.coach.id, seed.sessionId);
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ns_pay_credit' })).status, 200);
      const bookingId = (await db.query<{ id: number }>("select id from booking where charge_id = 'ns_pay_credit'")).rows[0].id;
      assert.equal(await creditLeft(db, bookingId), 1);
      const attentionId = (await db.query<{ id: number }>("select id from payment_attention where payment_ref = 'ns_pay_credit'")).rows[0].id;
      const cookie = await coachCookie(db, seed.coach.id);

      const confirm = await getPage(base, `/app/money?refund=a${attentionId}`, cookie);
      assert.match(confirm, /Refund \$35\?/);
      assert.match(confirm, /The 1 unused session credit it bought is withdrawn\./);
      assert.doesNotMatch(confirm, /spot is free again/, 'the booking was already cancelled');

      const done = await postForm(base, '/app/money/refund', cookie, { target: `a${attentionId}` });
      assert.equal(done.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(relay.refunds[0].paymentRef, 'ns_pay_credit');
      assert.equal(await creditLeft(db, bookingId), 0);
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
      assert.doesNotMatch(await getPage(base, '/app/money', cookie), /Payments to resolve/);
    });
    const row = await refundRow(db, 'ns_pay_credit');
    assert.deepEqual({ withdrawn: row.credits_withdrawn, released: row.spot_released }, { withdrawn: 1, released: false });
  });
});

test('a refund that the relay refuses shows on Money to try again, with a new key, and changes nothing until then', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_no', amountCents: 3500 });
      const cookie = await coachCookie(db, seed.coach.id);
      relay.refundError = { status: 404, code: 'NOT_FOUND' };
      const first = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(first.headers.get('location'), '/app/money?notice=refund-failed');
      assert.equal(await bookingStatus(db, bookingId), 'booked');

      const money = await getPage(base, '/app/money', cookie);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /The refund of \$35 did not go through\. Stripe has no record of this payment for your account\. Nothing else changed\./);
      assert.match(money, /Try the refund again/);

      relay.refundError = null;
      const second = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(second.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].idempotencyKey, refundIdempotencyKey('ns_pay_no', 2));
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
    });
    assert.equal((await refundRow(db, 'ns_pay_no')).attempt, 2);
  });
});

test('a refund call that gets no answer is sent again with the same key, so it is made once', async (t) => {
  quiet(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_slow', amountCents: 3500 });
      const cookie = await coachCookie(db, seed.coach.id);
      relay.refundError = { status: 502, code: 'PROVIDER_UNAVAILABLE' };
      const first = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(first.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-unavailable`);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
      const detail = await getPage(base, `/app/sessions/${seed.sessionId}?notice=refund-unavailable`, cookie);
      assert.match(detail, /Payments did not answer\. Try again in a minute: the refund will not be made twice\./);
      assert.match(detail, /Refund not sent yet/);
      assert.match(detail, /Try the refund again/);

      relay.refundError = null;
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].idempotencyKey, refundIdempotencyKey('ns_pay_slow', 1), 'the same key as the unanswered call');
      assert.equal(await bookingStatus(db, bookingId), 'refunded');
    });
  });
});

test("another coach's booking cannot be refunded", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    const other = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_mine', amountCents: 3500 });
      const cookie = await coachCookie(db, other.coach.id);
      const res = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.equal(res.status, 404);
      const viaMoney = await postForm(base, '/app/money/refund', cookie, { target: `b${bookingId}` });
      assert.equal(viaMoney.status, 303);
      const confirm = await getPage(base, `/app/money?refund=b${bookingId}`, cookie);
      assert.match(confirm, /We could not find that payment\./);
      assert.equal(await bookingStatus(db, bookingId), 'booked');
    });
    assert.equal(relay.refundCalls, 0);
  });
});

test('Money leaves a refunded booking out of booked and collected, and shows what was refunded', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    // In this week, so the totals include it.
    await db.query("update session set starts_at_utc = now() + interval '1 hour' where id = $1", [seed.sessionId]);
    await withServer(async (base) => {
      const kept = await payFor(base, db, { handle: seed.coach.handle, sessionId: seed.sessionId, paymentId: 'ns_pay_kept', amountCents: 3500 });
      const gone = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_gone',
        amountCents: 3500,
        phone: '5553334444',
      });
      const cookie = await coachCookie(db, seed.coach.id);
      const before = await getPage(base, '/app/money', cookie);
      assert.match(before, /Collected \(gross\): \$70\.00/);
      await postForm(base, '/app/money/refund', cookie, { target: `b${gone}` });
      const after = await getPage(base, '/app/money', cookie);
      assert.match(after, /Collected \(gross\): \$35\.00/);
      assert.match(after, /1 sessions booked/);
      assert.match(after, /Refunded: \$35\.00 \(1 payment\)\. Refunded bookings are not counted above\./);
      assert.equal(await bookingStatus(db, kept), 'booked');
    });
  });
});

