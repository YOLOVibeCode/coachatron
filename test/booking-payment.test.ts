import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { charge } from '../src/relay/connectHub.js';

const TEST_NONCE = 'cnon:test-nonce';

function bookingIdFromLocation(location: string | null): number {
  assert.ok(location, 'expected a redirect Location header');
  const match = /\/checkout\/(\d+)/.exec(location!);
  assert.ok(match, `expected .../checkout/<id> in ${location}`);
  return Number(match![1]);
}

function paidCheckoutBody(fields: Record<string, string>): string {
  return JSON.stringify({ ...fields, source_id: TEST_NONCE });
}

test('drop-in payment: charges the fake relay with appFeeBps 500 and books the session', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });

    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Alex', contact_phone: '5551112222' }),
        redirect: 'manual',
      });
      assert.equal(bookRes.status, 303);
      const bookingId = bookingIdFromLocation(bookRes.headers.get('location'));

      const checkoutRes = await fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: paidCheckoutBody({ mode: 'dropin' }),
        redirect: 'manual',
      });
      assert.equal(checkoutRes.status, 303);

      assert.equal(relay.charges.length, 1);
      assert.equal(relay.charges[0].appFeeBps, 500);
      assert.equal(relay.charges[0].amountCents, 3500);
      assert.equal(relay.charges[0].sourceId, TEST_NONCE);

      const rows = await db.query<{ status: string; payment_source: string; gross_cents: number }>(
        'select status, payment_source, gross_cents from booking where id = $1',
        [bookingId],
      );
      assert.equal(rows.rows[0].status, 'booked');
      assert.equal(rows.rows[0].payment_source, 'DropIn');
      assert.equal(rows.rows[0].gross_cents, 3500);

      const publicHtml = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(publicHtml, /1 spot left/);
    });
  });
});

test('package payment: charges once, creates a credit ledger row', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);

    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Bailey', contact_phone: '5553334444' }),
        redirect: 'manual',
      });
      const bookingId = bookingIdFromLocation(bookRes.headers.get('location'));

      const checkoutRes = await fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: paidCheckoutBody({ mode: 'package', package_id: String(packageId) }),
        redirect: 'manual',
      });
      assert.equal(checkoutRes.status, 303);

      assert.equal(relay.charges.length, 1);
      assert.equal(relay.charges[0].appFeeBps, 500);
      assert.equal(relay.charges[0].amountCents, 30000);

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

test('plan payment: subscribes once, creates a subscription and a credit ledger row', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);

    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Casey', contact_phone: '5555556666' }),
        redirect: 'manual',
      });
      const bookingId = bookingIdFromLocation(bookRes.headers.get('location'));

      const checkoutRes = await fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: paidCheckoutBody({ mode: 'plan', plan_id: String(planId) }),
        redirect: 'manual',
      });
      assert.equal(checkoutRes.status, 303);

      assert.equal(relay.subscriptions.length, 1);
      assert.equal(relay.subscriptions[0].appFeeBps, 500);
      assert.equal(relay.subscriptions[0].priceCents, 12000);

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

test('idempotency: resubmitting the same checkout does not double-charge or double-book', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });

    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Drew', contact_phone: '5557778888' }),
        redirect: 'manual',
      });
      const bookingId = bookingIdFromLocation(bookRes.headers.get('location'));

      const submit = () =>
        fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: paidCheckoutBody({ mode: 'dropin' }),
          redirect: 'manual',
        });

      const first = await submit();
      const second = await submit();
      assert.equal(first.status, 303);
      assert.equal(second.status, 200);

      assert.equal(relay.charges.length, 1, 'expected exactly one charge across both submissions');

      const bookingRows = await db.query<{ id: number }>('select id from booking where id = $1', [bookingId]);
      assert.equal(bookingRows.rows.length, 1, 'expected exactly one booking row');
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
