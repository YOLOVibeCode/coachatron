import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { charge } from '../src/relay/connectHub.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';

const TEST_NONCE = 'cnon:test-nonce';

function bookingIdFromLocation(location: string | null): number {
  assert.ok(location, 'expected a redirect Location header');
  const match = /\/checkout\/(\d+)/.exec(location!);
  assert.ok(match, `expected .../checkout/<id> in ${location}`);
  return Number(match![1]);
}

async function bookSession(base: string, handle: string, sessionId: number, athlete: string, phone: string): Promise<number> {
  const bookRes = await fetch(`${base}/c/${handle}/sessions/${sessionId}/book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ athlete_name: athlete, contact_phone: phone }),
    redirect: 'manual',
  });
  assert.equal(bookRes.status, 303);
  return bookingIdFromLocation(bookRes.headers.get('location'));
}

async function startHostedPay(
  base: string,
  handle: string,
  bookingId: number,
  fields: Record<string, string>,
): Promise<{ location: string; userId: string }> {
  const checkoutRes = await fetch(`${base}/c/${handle}/checkout/${bookingId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
    redirect: 'manual',
  });
  assert.equal(checkoutRes.status, 303);
  const location = checkoutRes.headers.get('location');
  assert.ok(location);
  assert.match(location, /\/buy\/connect\/coachatron\//);
  assert.doesNotMatch(location, /square/i);
  return { location, userId: buyerFromLocation(location) };
}

test('drop-in payment: signed buy link then event v1 books the session at 500 bps', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });

    await withServer(async (base) => {
      const bookingId = await bookSession(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const { userId } = await startHostedPay(base, seed.coach.handle, bookingId, { mode: 'dropin' });

      const hook = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_dropin' });
      assert.equal(hook.status, 200);

      const rows = await db.query<{ status: string; payment_source: string; gross_cents: number }>(
        'select status, payment_source, gross_cents from booking where id = $1',
        [bookingId],
      );
      assert.equal(rows.rows[0].status, 'booked');
      assert.equal(rows.rows[0].payment_source, 'DropIn');
      assert.equal(rows.rows[0].gross_cents, 3500);

      const publicHtml = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(publicHtml, /1 spot left/);
      const checkoutHtml = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`)).text();
      assert.doesNotMatch(checkoutHtml, /square\.js/i);
    });
  });
});

test('package payment: buy link + paid event creates a credit ledger row', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);

    await withServer(async (base) => {
      const bookingId = await bookSession(base, seed.coach.handle, seed.sessionId, 'Bailey', '5553334444');
      const { userId } = await startHostedPay(base, seed.coach.handle, bookingId, {
        mode: 'package',
        package_id: String(packageId),
      });
      const hook = await postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pkg' });
      assert.equal(hook.status, 200);

      const creditRows = await db.query<{ remaining: number; source: string }>(
        "select remaining, source from credit where coach_id = $1 and contact_phone = '+15553334444'",
        [seed.coach.id],
      );
      assert.equal(creditRows.rows.length, 1);
      assert.equal(creditRows.rows[0].remaining, 9);

      const bookingRows = await db.query<{ status: string; payment_source: string; credit_id: number | null }>(
        'select status, payment_source, credit_id from booking where id = $1',
        [bookingId],
      );
      assert.equal(bookingRows.rows[0].status, 'booked');
      assert.equal(bookingRows.rows[0].payment_source, 'PackageCredit');
      assert.ok(bookingRows.rows[0].credit_id);
    });
  });
});

test('plan payment: buy link + paid event creates a subscription and credits', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);

    await withServer(async (base) => {
      const bookingId = await bookSession(base, seed.coach.handle, seed.sessionId, 'Casey', '5555556666');
      const { userId } = await startHostedPay(base, seed.coach.handle, bookingId, {
        mode: 'plan',
        plan_id: String(planId),
      });
      const hook = await postStorePaid(base, { userId, amountCents: 12000, paymentId: 'ch_plan' });
      assert.equal(hook.status, 200);

      const subRows = await db.query<{ status: string }>(
        "select status from subscription where plan_id = $1 and contact_phone = '+15555556666'",
        [planId],
      );
      assert.equal(subRows.rows.length, 1);
      assert.equal(subRows.rows[0].status, 'active');

      const creditRows = await db.query<{ remaining: number }>(
        "select remaining from credit where coach_id = $1 and contact_phone = '+15555556666'",
        [seed.coach.id],
      );
      assert.equal(creditRows.rows[0].remaining, 3);

      const bookingRows = await db.query<{ status: string; payment_source: string; gross_cents: number }>(
        'select status, payment_source, gross_cents from booking where id = $1',
        [bookingId],
      );
      assert.equal(bookingRows.rows[0].status, 'booked');
      assert.equal(bookingRows.rows[0].payment_source, 'Subscription');
      assert.equal(bookingRows.rows[0].gross_cents, 12000);
    });
  });
});

test('idempotency: a second paid event does not double-book', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });

    await withServer(async (base) => {
      const bookingId = await bookSession(base, seed.coach.handle, seed.sessionId, 'Drew', '5557778888');
      const { userId } = await startHostedPay(base, seed.coach.handle, bookingId, { mode: 'dropin' });
      const first = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_once' });
      const second = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_once' });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);

      const bookingRows = await db.query<{ id: number; status: string }>('select id, status from booking where id = $1', [
        bookingId,
      ]);
      assert.equal(bookingRows.rows.length, 1);
      assert.equal(bookingRows.rows[0].status, 'booked');
    });
  });
});

test('fake relay idempotency: two charge() calls with the same key return the cached result, not a second charge', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    const recipientKey = 'test-recipient';
    const first = await charge({
      recipientKey,
      idempotencyKey: 'key-1',
      amountCents: 1000,
      sourceId: TEST_NONCE,
      note: 'n',
    });
    const second = await charge({
      recipientKey,
      idempotencyKey: 'key-1',
      amountCents: 1000,
      sourceId: TEST_NONCE,
      note: 'n',
    });
    assert.equal(first.id, second.id);
    assert.equal(relay.charges.length, 1);
  });
});
