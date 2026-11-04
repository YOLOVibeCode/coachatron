import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { bookOnline, latestBooking, postCheckout } from './helpers/booking.js';
import { createCredit } from '../src/domain/pricing.js';
import { cameBackFromPaying } from '../src/relay/buy-link.js';
import { APP_BASE_URL } from '../src/config.js';

/** The checkout page (screen 10) is reached by an unguessable token, never by
 * the booking's serial number. Anything else is a plain 404 that shows
 * nothing about the booking. */

test('checkout is reached by a long random token, and the booking number is a 404', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const creditId = await createCredit(db, seed.coach.id, '+15551112222', packageId, `package:${packageId}`, 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222', {
        contact_email: 'alex.parent@example.com',
      });
      assert.equal(b.status, 303);
      assert.ok(b.key);
      assert.ok(b.key.length >= 16, `checkout key "${b.key}" is long`);
      assert.doesNotMatch(b.key, /^\d+$/);
      assert.equal((await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).status, 200);

      const { id } = await latestBooking(db);
      const byNumber = await fetch(`${base}/c/${seed.coach.handle}/checkout/${id}`);
      assert.equal(byNumber.status, 404);
      const body = await byNumber.text();
      assert.doesNotMatch(body, /Alex|5551112222|555-?111|alex\.parent|credit/i);

      for (const mode of ['credit', 'dropin']) {
        const res = await postCheckout(base, seed.coach.handle, String(id), { mode });
        assert.equal(res.status, 404, mode);
        assert.equal(res.headers.get('location'), null, mode);
      }
    });
    assert.equal(relay.buyLinks.length, 0);
    const credit = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId]);
    assert.equal(credit.rows[0].remaining, 3);
    assert.equal((await latestBooking(db)).status, 'pending');
  });
});

test('a wrong or another coach’s checkout token is a 404 with no contact details', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const A = await seedCoachWithSession(db, { capacity: 2 });
    const B = await seedCoachWithSession(db, { capacity: 2 });
    await withServer(async (base) => {
      const b = await bookOnline(base, A.coach.handle, A.sessionId, 'Alex', '5551112222', { contact_email: 'alex.parent@example.com' });
      assert.ok(b.key);
      const wrong = [
        `/c/${A.coach.handle}/checkout/${b.key}x`,
        `/c/${A.coach.handle}/checkout/${b.key.slice(0, -1)}`,
        `/c/${A.coach.handle}/checkout/not-a-real-token-at-all`,
        `/c/${B.coach.handle}/checkout/${b.key}`,
      ];
      for (const path of wrong) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 404, path);
        assert.doesNotMatch(await res.text(), /Alex|5551112222|alex\.parent/, path);
        const post = await postCheckout(base, path.split('/')[2], path.split('/')[4], { mode: 'dropin' });
        assert.equal(post.status, 404, `POST ${path}`);
      }
    });
  });
});

test('the hosted payment page sends the parent back to the token page', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      assert.equal(pay.status, 303);
      const returnUrl = new URL(pay.headers.get('location') ?? '', base).searchParams.get('return') ?? '';
      assert.match(returnUrl, new RegExp(`/c/${seed.coach.handle}/checkout/${b.key}(\\?|$)`));
    });
  });
});

test('a checkout URL reads as back from paying in every shape the return link comes back in', () => {
  const page = '/c/jamie/checkout/AbCdEfGhIjKlMnOpQrStUv';
  // As built, and as the payment provider sends the parent back to it.
  assert.equal(cameBackFromPaying(`${page}?paid=1`), true);
  // A provider that adds its own query with "&".
  assert.equal(cameBackFromPaying(`${page}?paid=1&session_id=cs_test_1`), true);
  // One that adds "?" after the query already there.
  assert.equal(cameBackFromPaying(`${page}?paid=1?checkoutId=chk_1&orderId=ord_1`), true);
  assert.equal(cameBackFromPaying(`${page}?checkoutId=chk_1&paid=1`), true);
  assert.equal(cameBackFromPaying(page), false);
  assert.equal(cameBackFromPaying(`${page}?`), false);
  assert.equal(cameBackFromPaying(`${page}?paid=0`), false);
  assert.equal(cameBackFromPaying(`${page}?paid=10`), false);
  assert.equal(cameBackFromPaying(`${page}?unpaid=1`), false);
});

test('back from the hosted payment page, the return link says the payment is being confirmed', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const buyLink = pay.headers.get('location') ?? '';
      // The relay passes a web return link to the payment provider unchanged,
      // and the provider sends the parent back to exactly that link.
      const hosted = await fetch(buyLink, { redirect: 'manual' });
      const returnUrl = hosted.headers.get('location') ?? '';
      const appBase = process.env.APP_BASE_URL ?? APP_BASE_URL;
      assert.equal(returnUrl, `${appBase}/c/${seed.coach.handle}/checkout/${b.key}?paid=1`);

      const back = new URL(returnUrl);
      const path = `${back.pathname}${back.search}`;
      for (const shape of [path, `${path}&session_id=cs_test_1`, `${path}?checkoutId=chk_1&orderId=ord_1`]) {
        const res = await fetch(`${base}${shape}`);
        assert.equal(res.status, 200, shape);
        const html = await res.text();
        assert.match(html, /Checking for your payment/, shape);
        assert.match(html, /Manage this booking/, shape);
        assert.doesNotMatch(html, /Pay \$/, shape);
      }
      for (const shape of [back.pathname, `${back.pathname}?paid=0`]) {
        const html = await (await fetch(`${base}${shape}`)).text();
        assert.doesNotMatch(html, /Checking for your payment/, shape);
        assert.match(html, /Pay \$35\.00/, shape);
      }
    });
  });
});
