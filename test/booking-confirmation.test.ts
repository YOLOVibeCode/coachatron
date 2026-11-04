import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { bookOnline, latestBooking, postCheckout } from './helpers/booking.js';
import { createCredit } from '../src/domain/pricing.js';
import { segmentCount } from '../src/domain/outbound.js';
import type { DbClient } from '../src/db/client.js';
import type { FakeRelay } from './fakes/relay.js';

/** When a booking becomes booked, by any way of paying, the parent is told:
 * by text when they chose texts, by email when they gave a real address,
 * and on the page they come back to, so every parent has the manage link. */

const GSM7 = /^[\x20-\x7E\n]*$/;

async function placeSession(db: DbClient, sessionId: number, location: string): Promise<void> {
  await db.query('update session set location_text = $1 where id = $2', [location, sessionId]);
}

async function payDropIn(base: string, handle: string, key: string, amountCents: number, paymentId: string): Promise<string> {
  const pay = await postCheckout(base, handle, key, { mode: 'dropin' });
  assert.equal(pay.status, 303);
  const location = pay.headers.get('location');
  const hook = await postStorePaid(base, { userId: buyerFromLocation(location), amountCents, paymentId });
  assert.equal(hook.status, 200);
  return new URL(location ?? '', base).searchParams.get('return') ?? '';
}

function textsTo(relay: FakeRelay, phone: string) {
  return relay.sms.filter((m) => m.to === phone);
}

test('a paid drop-in texts the parent one segment with the session, time, place and manage link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await placeSession(db, seed.sessionId, 'Field 3');
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await payDropIn(base, seed.coach.handle, b.key, 3500, 'ch_alex');
      const manage = await (await fetch(`${base}/booking/${(await latestBooking(db)).manage_token}`)).text();
      assert.match(manage, /Field 3/);
      assert.match(manage, /Confirmed/);
    });
    const { manage_token: token } = await latestBooking(db);
    const [text] = textsTo(relay, '+15551112222');
    assert.ok(text, 'a confirmation was texted');
    assert.match(text.body, /^Coachatron: Alex is booked: Goalkeeper Group \w{3} \w{3} \d{1,2} \d{1,2}(:\d{2})?[ap]m, Field 3\. https:\/\//);
    assert.ok(text.body.includes(`/booking/${token} `), text.body);
    assert.match(text.body, /Reply STOP to opt out\.$/);
    assert.ok(text.body.length <= 160 && segmentCount(text.body) === 1 && GSM7.test(text.body), text.body);
  });
});

test('a long name with accents still gets one segment that ends with the whole link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await db.query("update session_type set name = 'Advanced Goalkeeper Footwork and Distribution' where id = $1", [seed.sessionTypeId]);
    await placeSession(db, seed.sessionId, 'Northside Community Park, Field 3 (behind the library)');
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'José María de la Cruz-Fernández', '5551112222');
      assert.ok(b.key);
      await payDropIn(base, seed.coach.handle, b.key, 3500, 'ch_long');
    });
    const { manage_token: token } = await latestBooking(db);
    const [text] = textsTo(relay, '+15551112222');
    assert.ok(text);
    assert.ok(text.body.includes(`/booking/${token} Reply STOP to opt out.`), text.body);
    assert.ok(text.body.startsWith('Coachatron: Jose Maria'), text.body);
    assert.ok(segmentCount(text.body) === 1 && text.body.length <= 160 && GSM7.test(text.body), text.body);
  });
});

test('a parent who gave an email gets the confirmation by email too; the stand-in address never gets mail', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const withEmail = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222', {
        contact_email: 'Alex.Parent@Example.com',
      });
      assert.ok(withEmail.key);
      await payDropIn(base, seed.coach.handle, withEmail.key, 3500, 'ch_email');
      const token = (await latestBooking(db)).manage_token;
      assert.equal(relay.emails.length, 1);
      assert.equal(relay.emails[0].to, 'alex.parent@example.com');
      assert.match(relay.emails[0].subject, /^Booked: Goalkeeper Group/);
      assert.ok(relay.emails[0].text.includes(`/booking/${token}`));
      assert.ok((relay.emails[0].html ?? '').includes(`/booking/${token}`));

      const noEmail = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Sam', '5553334444');
      assert.ok(noEmail.key);
      await payDropIn(base, seed.coach.handle, noEmail.key, 3500, 'ch_noemail');
    });
    assert.equal(relay.emails.length, 1, 'no email for the parent who gave none');
    assert.ok(relay.emails.every((e) => !e.to.endsWith('@book.coachatron.test')));
    assert.ok(textsTo(relay, '+15553334444').length === 1, 'that parent still got the text');
  });
});

test('a parent who chose no texts gets none, and the page they return to has the manage link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5559998888', { sms_consent: '' });
      assert.ok(b.key);
      const returnUrl = await payDropIn(base, seed.coach.handle, b.key, 3500, 'ch_quiet');
      assert.ok(returnUrl.includes(`/checkout/${b.key}`));
      const back = await fetch(new URL(new URL(returnUrl).pathname + new URL(returnUrl).search, base));
      assert.equal(back.status, 200);
      const body = await back.text();
      assert.match(body, /You're booked/);
      assert.ok(body.includes(`/booking/${(await latestBooking(db)).manage_token}`));
    });
    assert.equal(textsTo(relay, '+15559998888').length, 0);
  });
});

test('back from paying before the payment is confirmed, the page says so and has the manage link', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      const returnUrl = new URL(new URL(pay.headers.get('location') ?? '', base).searchParams.get('return') ?? '');
      const back = await fetch(new URL(returnUrl.pathname + returnUrl.search, base));
      const body = await back.text();
      assert.match(body, /Confirming your payment/);
      assert.ok(body.includes(`/booking/${(await latestBooking(db)).manage_token}`));
      assert.doesNotMatch(body, /name="mode" value="dropin"/, 'no second payment is offered on this page');
    });
  });
});

test('package, one-time pack and credit bookings are confirmed too', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 5, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const planId = await seedPlan(db, seed.coach.id, 4, 12000);
    await createCredit(db, seed.coach.id, '+15557770003', null, 'test', 2, null);
    await withServer(async (base) => {
      const pkg = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Pat', '5557770001');
      assert.ok(pkg.key);
      const pkgPay = await postCheckout(base, seed.coach.handle, pkg.key, { mode: 'package', package_id: String(packageId) });
      await postStorePaid(base, { userId: buyerFromLocation(pkgPay.headers.get('location')), amountCents: 30000, paymentId: 'ch_pkg' });

      const plan = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Quinn', '5557770002');
      assert.ok(plan.key);
      const planPay = await postCheckout(base, seed.coach.handle, plan.key, { mode: 'plan', plan_id: String(planId) });
      await postStorePaid(base, { userId: buyerFromLocation(planPay.headers.get('location')), amountCents: 12000, paymentId: 'ch_plan' });

      const credit = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Rae', '5557770003');
      assert.ok(credit.key);
      await db.query('update booking set phone_verified_at = now() where checkout_token = $1', [credit.key]);
      assert.equal((await postCheckout(base, seed.coach.handle, credit.key, { mode: 'credit' })).status, 303);
    });
    for (const [phone, athlete] of [['+15557770001', 'Pat'], ['+15557770002', 'Quinn'], ['+15557770003', 'Rae']]) {
      const texts = textsTo(relay, phone).filter((m) => m.body.includes(`${athlete} is booked`));
      assert.equal(texts.length, 1, `${athlete} was confirmed once`);
      assert.match(texts[0].body, /\/booking\/[A-Za-z0-9_-]+ Reply STOP/);
    }
  });
});

test('a confirmation text that fails to send does not undo the booking', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    relay.failSmsTo.add('+15551112222');
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await payDropIn(base, seed.coach.handle, b.key, 3500, 'ch_fail');
    });
    assert.equal((await latestBooking(db)).status, 'booked');
    const logged = await db.query<{ status: string }>("select status from message_log where template = 'booking-confirmation'");
    assert.deepEqual(logged.rows.map((r) => r.status), ['failed']);
  });
});
