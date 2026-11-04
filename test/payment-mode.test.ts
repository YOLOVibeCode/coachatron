import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postPaymentEvent, postSellerEvent, postStorePaid } from './helpers/store-event.js';
import { zoneAt } from './helpers/clock.js';
import { createCoachSession, getConnectRecipientKey } from '../src/domain/auth.js';
import { sendDueReadyTexts } from '../src/domain/payments.js';
import type { DbClient } from '../src/db/client.js';

/** Test-mode money in production. The relay marks every event and every
 * seller account test or live. In the production app a test-mode payment
 * books nothing and gives no credit, and a coach whose payment account is
 * a test one cannot take bookings, unless ALLOW_TEST_PAYMENTS is set.
 * Everywhere else test mode works as before. */

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const PRODUCTION = { APP_ENV: 'production', ALLOW_TEST_PAYMENTS: undefined };

async function bookingState(db: DbClient, sessionId: number): Promise<{ status: string; credits: number }> {
  const booking = await db.query<{ status: string }>('select status from booking where session_id = $1 order by id desc limit 1', [sessionId]);
  const credits = await db.query<{ n: string }>('select count(*)::text as n from credit');
  return { status: booking.rows[0].status, credits: Number(credits.rows[0].n) };
}

test('in production a test-mode payment books nothing and gives no credit; a live one books', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    const packageId = (
      await db.query<{ id: number }>("insert into package (coach_id, name, credits, price_cents) values ($1, 'Five', 5, 15000) returning id", [
        seed.coach.id,
      ])
    ).rows[0].id;
    await withServer(async (base) => {
      // Started where test payments work, so a buy link exists.
      const dropIn = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const pack = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Bo', '5553334444');
      assert.ok(dropIn.key && pack.key);
      const dropInUser = buyerFromLocation((await postCheckout(base, seed.coach.handle, dropIn.key, { mode: 'dropin' })).headers.get('location'));
      const packUser = buyerFromLocation(
        (await postCheckout(base, seed.coach.handle, pack.key, { mode: 'package', package_id: String(packageId) })).headers.get('location'),
      );

      await withEnv(PRODUCTION, async () => {
        assert.equal((await postStorePaid(base, { userId: dropInUser, amountCents: 3500, paymentId: 'ch_test_1' })).status, 200);
        assert.equal((await postStorePaid(base, { userId: packUser, amountCents: 15000, paymentId: 'ch_test_2' })).status, 200);
      });
      const kept = await db.query<{ status: string }>("select status from booking where session_id = $1 and status <> 'pending'", [seed.sessionId]);
      assert.equal(kept.rows.length, 0, 'nothing booked');
      assert.equal((await bookingState(db, seed.sessionId)).credits, 0, 'no credit given');
      assert.equal((await db.query('select id from payment_attention')).rows.length, 0, 'no money reached the coach, so nothing to resolve');

      await withEnv(PRODUCTION, async () => {
        // Nor does a test-mode dispute or refund show on Money.
        const dispute = await postPaymentEvent(base, {
          type: 'marketplace.purchase.disputed',
          paymentId: 'ch_test_1',
          amountCents: 3500,
          disputeId: 'dp_test_1',
          sellerKey: getConnectRecipientKey(seed.coach),
        });
        assert.equal(dispute.status, 200);
        assert.equal((await db.query('select id from payment_dispute')).rows.length, 0);
        assert.equal((await postStorePaid(base, { userId: dropInUser, amountCents: 3500, paymentId: 'ch_live_1', mode: 'live' })).status, 200);
      });
      const booked = await db.query<{ athlete_name: string }>("select athlete_name from booking where session_id = $1 and status = 'booked'", [
        seed.sessionId,
      ]);
      assert.deepEqual(booked.rows.map((r) => r.athlete_name), ['Alex'], 'a live payment books');
    });
  });
});

test('ALLOW_TEST_PAYMENTS lets production take test-mode payments, and outside production they work as before', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const second = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Bo', '5553334444');
      assert.ok(first.key && second.key);
      const firstUser = buyerFromLocation((await postCheckout(base, seed.coach.handle, first.key, { mode: 'dropin' })).headers.get('location'));
      const secondUser = buyerFromLocation((await postCheckout(base, seed.coach.handle, second.key, { mode: 'dropin' })).headers.get('location'));

      await withEnv({ APP_ENV: 'production', ALLOW_TEST_PAYMENTS: '1' }, async () => {
        await postStorePaid(base, { userId: firstUser, amountCents: 3500, paymentId: 'ch_allowed' });
      });
      await withEnv({ APP_ENV: 'uat', ALLOW_TEST_PAYMENTS: undefined }, async () => {
        await postStorePaid(base, { userId: secondUser, amountCents: 3500, paymentId: 'ch_uat' });
      });
    });
    const booked = await db.query<{ athlete_name: string }>("select athlete_name from booking where status = 'booked' order by id");
    assert.deepEqual(booked.rows.map((r) => r.athlete_name), ['Alex', 'Bo']);
  });
});

test('in production a coach whose payment account is a test one cannot open booking until it is live or test payments are allowed', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    const key = getConnectRecipientKey(seed.coach);
    relay.enableCharges('coachatron', key);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const publicPage = async () => (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      const bookForm = () => bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');

      await withEnv(PRODUCTION, async () => {
        const page = await publicPage();
        assert.match(page, /Booking opens soon/);
        assert.doesNotMatch(page, />Book</);
        assert.equal((await bookForm()).status, 409);
        const money = await (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
        assert.match(money, /takes test payments only, so parents cannot book paid sessions yet/);
      });
      const row = await db.query<{ test_mode: boolean | null }>('select test_mode from coach_payments where coach_id = $1', [seed.coach.id]);
      assert.equal(row.rows[0].test_mode, true, 'learned from the relay');

      // The same account outside production, and in production with test payments allowed.
      assert.match(await publicPage(), />Book</);
      await withEnv({ APP_ENV: 'production', ALLOW_TEST_PAYMENTS: 'true' }, async () => {
        assert.match(await publicPage(), />Book</);
      });

      // The account goes live: booking opens in production.
      relay.sellerMode = 'live';
      await withEnv(PRODUCTION, async () => {
        assert.equal((await postSellerEvent(base, { sellerKey: key, chargesEnabled: true, mode: 'live' })).status, 200);
        assert.match(await publicPage(), />Book</);
        const money = await (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
        assert.doesNotMatch(money, /test payments only/);
      });
    });
  });
});

test('in production the payments-ready text waits until the account is a live one', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
    const key = getConnectRecipientKey(seed.coach);
    const ready = () => relay.sms.filter((m) => m.to === seed.coach.phone && /You can take payments now/.test(m.body));
    await withEnv(PRODUCTION, async () => {
      await withServer(async (base) => {
        await postSellerEvent(base, { sellerKey: key, chargesEnabled: true, mode: 'test' });
        assert.equal(ready().length, 0, 'not for a test account');
        await sendDueReadyTexts(db, new Date());
        assert.equal(ready().length, 0);
        await postSellerEvent(base, { sellerKey: key, chargesEnabled: true, mode: 'live' });
      });
      await sendDueReadyTexts(db, new Date());
      assert.equal(ready().length, 1, 'once the account is live');
    });
  });
});
