import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from '../helpers/fixtures.js';
import type { FakeRelay } from '../fakes/relay.js';
import { newBookingToken } from '../../src/domain/pricing.js';
import { applyRefunded, requestRefund } from '../../src/domain/refunds.js';
import { cancelUnderPolicy } from '../../src/domain/cancelRefund.js';
import type { DbClient } from '../../src/db/client.js';

/** A parent's cancel in time, under the coach's "a refund to their card"
 * (SPEC.md §9.5), and the coach's own Refund tap on the same payment at the
 * same moment, on real Postgres (TEST_DATABASE_URL; skipped without it).
 * Both ask through the one refund path, which claims the payment's one
 * refund row first, so whichever is first makes the refund and the other
 * makes none: one call to the relay, one notice to the parent, and no
 * credit left beside the refund. Each test holds the first one still right
 * after it has claimed the row, starts the second, waits until the second
 * is waiting on it, and only then lets the first go on. */

const RACE = { skip: skipWithoutPostgres, timeout: 60_000 };

let race: RaceDb | null = null;
const db = (): DbClient => {
  assert.ok(race, 'the race database is set up');
  return race.db;
};

before(async () => {
  if (!skipWithoutPostgres) race = await raceDb();
});
after(async () => {
  await race?.close();
});

let made = 0;

/** A drop-in paid by card, three days out, made under "a refund". */
async function paidDropIn() {
  made += 1;
  const seed = await seedCoachWithSession(db(), { capacity: 4, priceCents: 3500 });
  await db().query("update session set starts_at_utc = now() + interval '72 hours' where id = $1", [seed.sessionId]);
  const phone = `+1555000${String(9300 + made)}`;
  const bookingId = await seedBookedSession(db(), seed.sessionId, 'Cleo Park', phone);
  const token = newBookingToken();
  const charge = `ch_cancel_race_${made}_${Date.now()}`;
  await db().query("update booking set gross_cents = 3500, charge_id = $2, manage_token = $3, cancel_gives = 'refund' where id = $1", [
    bookingId,
    charge,
    token,
  ]);
  return { seed, bookingId, token, charge, phone };
}

/** What both racers must leave behind, whoever was first. */
async function assertOneRefund(relay: FakeRelay, b: { bookingId: number; charge: string; phone: string }): Promise<void> {
  assert.equal(relay.refundCalls, 1, 'the relay was asked once');
  assert.equal(relay.refunds.filter((r) => r.paymentRef === b.charge).length, 1, 'one refund');
  const rows = await db().query<{ status: string }>('select status from refund where payment_ref = $1', [b.charge]);
  assert.deepEqual(rows.rows, [{ status: 'refunded' }], 'one refund row, refunded');
  const booking = await db().query<{ status: string }>('select status from booking where id = $1', [b.bookingId]);
  assert.equal(booking.rows[0].status, 'refunded');
  const usable = await db().query<{ n: number }>(
    'select count(*)::int as n from credit where contact_phone = $1 and remaining > 0',
    [b.phone],
  );
  assert.equal(usable.rows[0].n, 0, 'no credit is left beside the refund');
  assert.equal(relay.sms.filter((m) => m.to === b.phone && /refunded/.test(m.body)).length, 1, 'the parent is told once');
}

test("the coach's Refund tap claims the payment first: the parent's cancel waits, then asks for nothing", RACE, async () => {
  await withRelay(async (relay) => {
    const b = await paidDropIn();
    // The coach's tap has claimed the refund row and not yet committed.
    const tapping = pauseAfter(db(), (sql) => sql.includes('insert into refund'));
    const coach = settle(requestRefund(tapping.db, b.seed.coach, { bookingId: b.bookingId }));
    await tapping.reached;
    const parent = settle(cancelUnderPolicy(db(), b.token));
    const waited = await untilWaitingOrDone(db(), parent).finally(tapping.release);
    const [rc, rp] = await Promise.all([coach, parent]);
    assert.equal(waited, 'waiting', "the parent's cancel waited for the claim the coach's tap held");
    assert.ok(rc.ok && rp.ok, 'neither failed');
    assert.deepEqual(rc.value, { kind: 'refunded' });
    assert.equal(rp.value.refund, null, "the parent's cancel asked for no refund of its own");
    await assertOneRefund(relay, b);
    const row = await db().query<{ cancel_booking_id: number | null }>('select cancel_booking_id from refund where payment_ref = $1', [b.charge]);
    assert.equal(row.rows[0].cancel_booking_id, null, "it is the coach's refund");
  });
});

test("the parent's cancel claims the payment first: the coach's tap waits, then finds the refund on its way", RACE, async () => {
  await withRelay(async (relay) => {
    const b = await paidDropIn();
    // The parent's cancel has claimed the refund row and not yet committed.
    const cancelling = pauseAfter(db(), (sql) => sql.includes('insert into refund'));
    const parent = settle(cancelUnderPolicy(cancelling.db, b.token));
    await cancelling.reached;
    const coach = settle(requestRefund(db(), b.seed.coach, { bookingId: b.bookingId }));
    const waited = await untilWaitingOrDone(db(), coach).finally(cancelling.release);
    const [rp, rc] = await Promise.all([parent, coach]);
    assert.equal(waited, 'waiting', "the coach's tap waited for the claim the parent's cancel held");
    assert.ok(rp.ok && rc.ok, 'neither failed');
    assert.equal(rp.value.result.kind, 'cancelled');
    assert.equal(rp.value.refund, 'refunded');
    assert.deepEqual(rc.value, { kind: 'blocked', block: { kind: 'in_progress' } }, "the coach's tap sent nothing");
    await assertOneRefund(relay, b);
    const row = await db().query<{ cancel_booking_id: number | null }>('select cancel_booking_id from refund where payment_ref = $1', [b.charge]);
    assert.equal(row.rows[0].cancel_booking_id, b.bookingId, "it is the refund the parent's cancel asked for");
  });
});

test("the parent's cancel holds the booking it is cancelling: the coach's tap waits, and still one refund is made", RACE, async () => {
  await withRelay(async (relay) => {
    const b = await paidDropIn();
    // The parent's cancel has cancelled the booking inside its claim, with
    // the booking's row and the refund row both held.
    const cancelling = pauseAfter(db(), (sql) => sql.includes("update booking set status = 'cancelled'"));
    const parent = settle(cancelUnderPolicy(cancelling.db, b.token));
    await cancelling.reached;
    const coach = settle(requestRefund(db(), b.seed.coach, { bookingId: b.bookingId }));
    const waited = await untilWaitingOrDone(db(), coach).finally(cancelling.release);
    const [rp, rc] = await Promise.all([parent, coach]);
    assert.equal(waited, 'waiting');
    assert.ok(rp.ok && rc.ok, 'neither failed');
    assert.equal(rp.value.refund, 'refunded');
    assert.deepEqual(rc.value, { kind: 'blocked', block: { kind: 'in_progress' } });
    await assertOneRefund(relay, b);
  });
});

test("the coach's refund is confirmed while the parent's cancel holds the booking: neither waits for the other's row for good", RACE, async () => {
  await withRelay(async (relay) => {
    const b = await paidDropIn();
    // The coach's refund is on its way: Stripe has not confirmed it yet.
    relay.refundStatus = 'pending';
    assert.deepEqual(await requestRefund(db(), b.seed.coach, { bookingId: b.bookingId }), { kind: 'pending' });
    const ref = relay.refunds[0].refundRef;

    // The parent's cancel has cancelled the booking, holds its row, and has
    // not yet made the credit. The confirmation arrives now: it takes the
    // refund's row and waits for the booking. The cancel then has to tie
    // its new credit to that refund without waiting for the refund's row.
    const cancelling = pauseAfter(db(), (sql) => sql.includes("update booking set status = 'cancelled'"));
    const parent = settle(cancelUnderPolicy(cancelling.db, b.token));
    await cancelling.reached;
    const confirmed = settle(applyRefunded(db(), { paymentRef: b.charge, refundRef: ref, amountCents: 3500, sellerKey: null }));
    const waited = await untilWaitingOrDone(db(), confirmed).finally(cancelling.release);
    const [rp, rr] = await Promise.all([parent, confirmed]);
    assert.equal(waited, 'waiting', 'the confirmation waited for the booking the cancel held');
    assert.ok(rp.ok && rr.ok, 'neither failed');
    assert.equal(rp.value.result.kind, 'cancelled');
    assert.equal(rp.value.refund, null, "the cancel asked for no refund: the coach's was on its way");
    assert.equal(rr.value, 'refunded');
    await assertOneRefund(relay, b);
    const credit = await db().query<{ remaining: number; withdrawn: boolean }>(
      'select c.remaining, c.withdrawn_at is not null as withdrawn from credit c join booking k on k.credit_id = c.id where k.id = $1',
      [b.bookingId],
    );
    assert.deepEqual(credit.rows, [{ remaining: 0, withdrawn: true }], 'the credit the cancel made was withdrawn with the refund');
  });
});
