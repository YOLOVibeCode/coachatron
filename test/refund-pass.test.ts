import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { bookOnline, countSold, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postPaymentEvent, postStorePaid } from './helpers/store-event.js';
import { coachCookie, getPage, postForm, readable } from './helpers/refunds.js';
import { createCredit } from '../src/domain/pricing.js';
import type { DbClient } from '../src/db/client.js';

/** A booking pass (SPEC.md §9.5) is one payment for several children, each
 * with a booking that carries it. A refund is of the whole payment
 * (SPEC.md §9.4), so it ends every one of those bookings, withdraws every
 * credit they left, and is shown and counted as one payment. */

const PHONE = '+15551114444';

async function children(db: DbClient) {
  const r = await db.query<{ id: number; athlete_name: string; status: string; credit_id: number | null; manage_token: string }>(
    'select id, athlete_name, status, credit_id, manage_token from booking where contact_phone = $1 order by id',
    [PHONE],
  );
  return r.rows;
}

/** Mia and Leo are booked in one pass and paid for with one payment. */
async function payForTwo(
  base: string,
  handle: string,
  sessionId: number,
  paymentId: string,
  amountCents: number,
  fields: Record<string, string> = { mode: 'dropin' },
): Promise<void> {
  const b = await bookOnline(base, handle, sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, handle, b.key, fields);
  assert.equal(pay.status, 303);
  const paid = await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents, paymentId });
  assert.equal(paid.status, 200);
}

function lastCode(sms: Array<{ to: string; body: string }>): string {
  const text = [...sms].reverse().find((m) => m.to === PHONE);
  const code = text ? /\b(\d{6})\b/.exec(text.body)?.[1] : undefined;
  assert.ok(code, 'a code was texted');
  return code;
}

async function refundOf(db: DbClient, paymentRef: string) {
  const r = await db.query<{ status: string; amount_cents: number | null; booking_id: number | null; athlete_name: string | null; credits_withdrawn: number }>(
    'select status, amount_cents, booking_id, athlete_name, credits_withdrawn from refund where payment_ref = $1',
    [paymentRef],
  );
  return r.rows[0] ?? null;
}

test("two children's drop-in is refunded whole from either child's booking, and both bookings end", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, seed.sessionId, 'ch_pass_two', 7000);
      const [mia, leo] = await children(db);
      assert.deepEqual([mia.status, leo.status], ['booked', 'booked']);
      const cookie = await coachCookie(db, seed.coach.id);

      const confirm = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${leo.id}`, cookie);
      assert.match(confirm, /Refund \$70\?/);
      assert.match(confirm, /Mia and Leo · drop-in/);
      assert.match(confirm, /Mia and Leo's bookings are cancelled and the spots are free again\./);

      const done = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${leo.id}/refund`, cookie);
      assert.equal(done.status, 303);
      assert.equal(relay.refunds.length, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ch_pass_two');
      assert.deepEqual((await children(db)).map((c) => c.status), ['refunded', 'refunded']);
      assert.equal(await countSold(db, seed.sessionId), 0);

      // Either child's Refund link now finds the payment refunded.
      const again = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${mia.id}/refund`, cookie);
      assert.equal(again.status, 303);
      assert.equal(relay.refundCalls, 1);
    });
    const row = await refundOf(db, 'ch_pass_two');
    assert.equal(row?.status, 'refunded');
    assert.equal(row?.amount_cents, 7000);
    assert.equal(row?.athlete_name, 'Mia and Leo');
    const told = relay.sms.filter((m) => m.to === PHONE && /refunded/.test(m.body));
    assert.equal(told.length, 1, 'the parent is told once');
    assert.match(told[0].body, /refunded \$70 for Mia and Leo's/);
  });
});

test('a package bought for two children can be refunded: both bookings end and its unused credits are withdrawn', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, seed.sessionId, 'ch_pass_pkg', 30000, { mode: 'package', package_id: String(packageId) });
      const [mia, leo] = await children(db);
      const cookie = await coachCookie(db, seed.coach.id);

      const confirm = await getPage(base, `/app/money?refund=b${mia.id}`, cookie);
      assert.match(confirm, /Refund \$300\?/);
      assert.doesNotMatch(confirm, /sessions this payment bought (?:was|were) used/);
      assert.match(confirm, /Mia and Leo's bookings are cancelled and the spots are free again\./);
      assert.match(confirm, /The 8 unused session credits it bought are withdrawn\./);

      // Leo's booking points to the same payment.
      const fromLeo = await getPage(base, `/app/sessions/${seed.sessionId}?refund=${leo.id}`, cookie);
      assert.match(fromLeo, /Refund \$300\?/);

      const done = await postForm(base, '/app/money/refund', cookie, { target: `b${leo.id}` });
      assert.equal(done.headers.get('location'), '/app/money?notice=refund-refunded');
      assert.equal(relay.refunds.length, 1);
      assert.deepEqual((await children(db)).map((c) => c.status), ['refunded', 'refunded']);
      const credit = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [mia.credit_id]);
      assert.equal(credit.rows[0].remaining, 0);
    });
    const row = await refundOf(db, 'ch_pass_pkg');
    assert.equal(row?.amount_cents, 30000);
    assert.equal(row?.credits_withdrawn, 8);
  });
});

test("a child's cancel that became a credit is withdrawn with the refund; a spent one stops it", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    await db.query("update session set starts_at_utc = now() + interval '3 days' where id = $1", [seed.sessionId]);
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, seed.sessionId, 'ch_pass_cancel', 7000);
      const [mia, leo] = await children(db);
      // Leo is cancelled in time, so his share becomes one session credit.
      assert.equal((await fetch(`${base}/booking/${leo.manage_token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
      const leoCredit = (await children(db))[1].credit_id;
      assert.ok(leoCredit);
      const cookie = await coachCookie(db, seed.coach.id);

      const confirm = await getPage(base, `/app/money?refund=b${mia.id}`, cookie);
      assert.match(confirm, /Refund \$70\?/);
      assert.match(confirm, /Mia's booking is cancelled and the spot is free again\./);
      assert.match(confirm, /The 1 unused session credit it bought is withdrawn\./);

      // Once Leo's credit is spent, the payment's sessions were used.
      await db.query('update credit set remaining = 0 where id = $1', [leoCredit]);
      const used = await getPage(base, `/app/money?refund=b${mia.id}`, cookie);
      assert.match(used, /1 of the 2 sessions this payment bought was used/);
      const blocked = await postForm(base, '/app/money/refund', cookie, { target: `b${mia.id}` });
      assert.equal(blocked.status, 303);
      assert.equal(relay.refundCalls, 0);

      await db.query('update credit set remaining = 1 where id = $1', [leoCredit]);
      await postForm(base, '/app/money/refund', cookie, { target: `b${mia.id}` });
      assert.equal(relay.refunds.length, 1);
      assert.deepEqual((await children(db)).map((c) => c.status), ['refunded', 'refunded']);
      const credit = await db.query<{ remaining: number; withdrawn_at: string | null }>('select remaining, withdrawn_at from credit where id = $1', [
        leoCredit,
      ]);
      assert.equal(credit.rows[0].remaining, 0);
      assert.ok(credit.rows[0].withdrawn_at);
    });
  });
});

test('a whole refund made outside Coachatron ends every child; one child’s share of it changes nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, seed.sessionId, 'ch_pass_part', 7000);
      const part = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ch_pass_part',
        refundId: 'ns_rfd_part',
        amountCents: 3500,
      });
      assert.equal(part.status, 200);
      assert.deepEqual((await children(db)).map((c) => c.status), ['booked', 'booked']);
      assert.equal((await refundOf(db, 'ch_pass_part'))?.status, 'partial');
    });

    const other = await freshDb();
    const seed2 = await seedCoachWithSession(other, { capacity: 6, priceCents: 3500 });
    await withServer(async (base) => {
      await payForTwo(base, seed2.coach.handle, seed2.sessionId, 'ch_pass_whole', 7000);
      const whole = await postPaymentEvent(base, {
        type: 'marketplace.purchase.refunded',
        paymentId: 'ch_pass_whole',
        refundId: 'ns_rfd_whole',
        amountCents: 7000,
      });
      assert.equal(whole.status, 200);
      assert.deepEqual((await children(other)).map((c) => c.status), ['refunded', 'refunded']);
      const row = await refundOf(other, 'ch_pass_whole');
      assert.equal(row?.status, 'refunded');
      assert.equal(row?.amount_cents, 7000);
      assert.equal(row?.athlete_name, 'Mia and Leo');
    });
  });
});

test("Money lists a pass's payment once, with every child and the whole amount", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, seed.sessionId, 'ch_pass_list', 7000);
      const [mia] = await children(db);
      const cookie = await coachCookie(db, seed.coach.id);
      const money = readable(await (await fetch(`${base}/app/money`, { headers: { cookie } })).text());
      const cards = money.match(/class="card recent-payment"/g) ?? [];
      assert.equal(cards.length, 1, 'one payment');
      assert.match(money, /<strong>Mia and Leo<\/strong> · \$70/);
      assert.ok(money.includes(`/app/money?refund=b${mia.id}#refund`));
    });
  });
});

test('a credit held for a refund is not counted toward children booked together', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 1, null);
    const held = await createCredit(db, seed.coach.id, PHONE, null, 'test', 5, null);
    const refund = await db.query<{ id: number }>(
      "insert into refund (coach_id, payment_ref, status) values ($1, 'ch_held_for_refund', 'pending') returning id",
      [seed.coach.id],
    );
    await db.query('update credit set refund_id = $2 where id = $1', [held, refund.rows[0].id]);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      assert.ok(b.key);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' })).status, 200);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: lastCode(relay.sms) })).status, 303);
      const page = readable(await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text());
      assert.match(page, /You have 1 session credit with Jamie Coach; this booking needs 2, one for each child\./);
      assert.doesNotMatch(page, /name="mode" value="credit"/);
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
  });
});
