import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { postSellerEvent } from './helpers/store-event.js';
import { createCoach, createCoachSession, type CoachRow } from '../src/domain/auth.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { createPendingBooking } from '../src/domain/pricing.js';
import { zonedParts } from '../src/domain/scheduling.js';
import { getPaymentsRow, markPaymentsStarted, recordChargesEnabled } from '../src/domain/payments.js';
import { runTick } from '../src/jobs/tick.js';
import type { DbClient } from '../src/db/client.js';

/** Whether parents can pay a coach yet: saved locally, kept fresh from the
 * onboarding return, seller events, and the tick; and the coach page and
 * booking routes never send a parent to a payment page that cannot work. */

const MORNING = new Date('2026-10-20T15:00:00Z'); // 10am in Chicago

/** A zone where it is the middle of the day right now, so a text sent with
 * the real clock is never held for quiet hours. */
function daytimeZone(now = new Date()): string {
  const zones = ['America/Chicago', 'Pacific/Honolulu', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland'];
  const zone = zones.find((tz) => {
    const hour = zonedParts(now, tz).hour;
    return hour >= 9 && hour <= 18;
  });
  assert.ok(zone, 'some zone is in the daytime');
  return zone;
}

async function textingCoach(db: DbClient, tz = 'America/Chicago'): Promise<{ coach: CoachRow; cookie: string }> {
  const coach = await createCoach(db, { name: 'Pat Keeper', phone: '+15550102030', email: 'pat@example.com', tz });
  await grantSmsConsent(db, coach.phone!);
  return { coach, cookie: `cx_session=${await createCoachSession(db, coach.id)}` };
}

function form(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function chargesEnabled(db: DbClient, coachId: number): Promise<boolean | null> {
  return (await getPaymentsRow(db, coachId))?.charges_enabled ?? null;
}

// ---- keeping readiness fresh -------------------------------------------

test('starting payments saves that the coach started, and the return from onboarding saves that charges work', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await textingCoach(db);
    await withServer(async (base) => {
      assert.equal((await form(base, '/app/money/payments', { agree: '1' }, cookie)).status, 303);
      const started = await getPaymentsRow(db, coach.id);
      assert.ok(started?.started_at, 'started is saved');
      assert.equal(started?.charges_enabled, false);

      relay.enableCharges('coachatron', coach.handle);
      const back = await fetch(`${base}/app/money?seller=connected`, { headers: { cookie } });
      assert.equal(back.status, 200);
      const row = await getPaymentsRow(db, coach.id);
      assert.equal(row?.charges_enabled, true);
      assert.ok(row?.checked_at);
    });
  });
});

test('a signed seller.updated event saves what it says; an event with a bad signature changes nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await withServer(async (base) => {
      const bad = await postSellerEvent(base, { sellerKey: seed.coach.handle, chargesEnabled: true, secret: 'not-the-secret' });
      assert.equal(bad.status, 401);
      assert.equal(await chargesEnabled(db, seed.coach.id), false);

      const ok = await postSellerEvent(base, { sellerKey: seed.coach.handle, chargesEnabled: true });
      assert.equal(ok.status, 200);
      assert.equal(await chargesEnabled(db, seed.coach.id), true);

      const off = await postSellerEvent(base, { sellerKey: seed.coach.handle, chargesEnabled: false });
      assert.equal(off.status, 200);
      assert.equal(await chargesEnabled(db, seed.coach.id), false);
    });
  });
});

test('a disconnected seller closes booking, and an event for another Connect app is ignored', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await withServer(async (base) => {
      const other = await postSellerEvent(base, { sellerKey: seed.coach.handle, type: 'seller.disconnected', product: 'another-app' });
      assert.equal(other.status, 200);
      assert.equal(await chargesEnabled(db, seed.coach.id), true);

      await postSellerEvent(base, { sellerKey: seed.coach.handle, type: 'seller.disconnected' });
      assert.equal(await chargesEnabled(db, seed.coach.id), false);

      const unknown = await postSellerEvent(base, { sellerKey: 'nobody-here', chargesEnabled: true });
      assert.equal(unknown.status, 200);
    });
  });
});

test('a seller event without the flags asks the relay', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    relay.enableCharges('coachatron', seed.coach.handle);
    await withServer(async (base) => {
      assert.equal((await postSellerEvent(base, { sellerKey: seed.coach.handle, chargesEnabled: null })).status, 200);
    });
    assert.equal(relay.statusChecks, 1);
    assert.equal(await chargesEnabled(db, seed.coach.id), true);
  });
});

test('the tick asks about a coach who started, at most every 15 minutes, and stops once charges work', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await db.query('update coach_payments set checked_at = $2 where coach_id = $1', [
      seed.coach.id,
      new Date(MORNING.getTime() - 60 * 60 * 1000).toISOString(),
    ]);
    await runTick(db, MORNING);
    assert.equal(relay.statusChecks, 0, 'a coach who never started is not polled');

    await markPaymentsStarted(db, seed.coach.id, MORNING);
    await runTick(db, MORNING);
    assert.equal(relay.statusChecks, 1);
    await runTick(db, new Date(MORNING.getTime() + 5 * 60 * 1000));
    await runTick(db, new Date(MORNING.getTime() + 14 * 60 * 1000));
    assert.equal(relay.statusChecks, 1, 'not again inside 15 minutes');

    relay.enableCharges('coachatron', seed.coach.handle);
    await runTick(db, new Date(MORNING.getTime() + 15 * 60 * 1000));
    assert.equal(relay.statusChecks, 2);
    assert.equal(await chargesEnabled(db, seed.coach.id), true);

    await runTick(db, new Date(MORNING.getTime() + 60 * 60 * 1000));
    assert.equal(relay.statusChecks, 2, 'a coach who can take charges is not polled');
  });
});

test('a coach never checked is asked once by the tick, which also learns they started', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await db.query('update coach_payments set charges_enabled = null, checked_at = null where coach_id = $1', [seed.coach.id]);
    // Accepted the terms on the relay before readiness was saved here.
    await fetch(`${relay.url}/connect/coachatron/recipients/${seed.coach.handle}/agreement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ agreement_version: 'v1' }),
    });

    await runTick(db, MORNING);
    assert.equal(relay.statusChecks, 1);
    const row = await getPaymentsRow(db, seed.coach.id);
    assert.equal(row?.charges_enabled, false);
    assert.ok(row?.started_at, 'accepted terms count as started');
  });
});

// ---- the coach page and booking ----------------------------------------

test('until payments work, the coach page says booking opens soon and has no Book button', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(page, /Goalkeeper Group/);
      assert.match(page, /Booking opens soon/);
      assert.doesNotMatch(page, /\/book"/);
      assert.doesNotMatch(page, />Book</);
    });
  });
});

test('until payments work, booking and paying answer a friendly page and nothing goes to the payment page', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    const pending = await createPendingBooking(db, seed.sessionId, 'Sam Reyes', '+15550007777', null);
    await withServer(async (base) => {
      const bookPath = `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`;
      const formPage = await fetch(`${base}${bookPath}`);
      assert.equal(formPage.status, 200);
      const formHtml = await formPage.text();
      assert.match(formHtml, /Booking opens soon/);
      assert.doesNotMatch(formHtml, /Continue to payment/);

      const booked = await form(base, bookPath, { athlete_name: 'Mia Ortiz', contact_phone: '5550008888' });
      assert.equal(booked.status, 409);
      assert.equal(booked.headers.get('location'), null);
      assert.match(await booked.text(), /Booking opens soon/);
      const rows = await db.query('select id from booking where athlete_name = $1', ['Mia Ortiz']);
      assert.equal(rows.rows.length, 0, 'no booking is started');

      const checkoutPath = `/c/${seed.coach.handle}/checkout/${pending}`;
      const checkout = await fetch(`${base}${checkoutPath}`);
      assert.equal(checkout.status, 200);
      const checkoutHtml = await checkout.text();
      assert.match(checkoutHtml, /Booking opens soon/);
      assert.doesNotMatch(checkoutHtml, /Pay \$/);

      for (const mode of ['dropin', 'package', 'plan']) {
        const paid = await form(base, checkoutPath, { mode, package_id: '1', plan_id: '1' });
        assert.equal(paid.status, 409, mode);
        assert.equal(paid.headers.get('location'), null, mode);
        assert.match(await paid.text(), /Booking opens soon/);
      }
      assert.equal(relay.buyLinks.length, 0);
    });
  });
});

test('a free session stays bookable while payments are not set up', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false, priceCents: 0 });
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(page, new RegExp(`href="/c/${seed.coach.handle}/sessions/${seed.sessionId}/book">Book<`));
      assert.doesNotMatch(page, /Booking opens soon/);
      const booked = await form(base, `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        athlete_name: 'Mia Ortiz',
        contact_phone: '5550008888',
      });
      assert.equal(booked.status, 303);
      assert.match(booked.headers.get('location') ?? '', /\/checkout\/\d+$/);
    });
  });
});

test('a parent with session credits can still use one while payments are paused', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await db.query(
      `insert into credit (coach_id, contact_phone, remaining, source) values ($1, '+15550007777', 3, 'package:1')`,
      [seed.coach.id],
    );
    const pending = await createPendingBooking(db, seed.sessionId, 'Sam Reyes', '+15550007777', null);
    await withServer(async (base) => {
      const path = `/c/${seed.coach.handle}/checkout/${pending}`;
      const checkout = await (await fetch(`${base}${path}`)).text();
      assert.match(checkout, /Use 1 of 3 session credits/);
      assert.doesNotMatch(checkout, /Pay \$/);
      const used = await form(base, path, { mode: 'credit' });
      assert.equal(used.status, 303);
      const status = await db.query<{ status: string }>('select status from booking where id = $1', [pending]);
      assert.equal(status.rows[0].status, 'booked');
    });
  });
});

test('booking opens as soon as the seller event says charges work', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await withServer(async (base) => {
      assert.match(await (await fetch(`${base}/c/${seed.coach.handle}`)).text(), /Booking opens soon/);
      await postSellerEvent(base, { sellerKey: seed.coach.handle, chargesEnabled: true });
      const page = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.doesNotMatch(page, /Booking opens soon/);
      assert.match(page, />Book</);
    });
  });
});

test('a coach whose readiness was never saved is looked up once, then the saved answer is used', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const ready = await seedCoachWithSession(db);
    const notReady = await seedCoachWithSession(db);
    await db.query('delete from coach_payments');
    relay.enableCharges('coachatron', ready.coach.handle);
    await withServer(async (base) => {
      assert.match(await (await fetch(`${base}/c/${ready.coach.handle}`)).text(), />Book</);
      assert.match(await (await fetch(`${base}/c/${notReady.coach.handle}`)).text(), /Booking opens soon/);
      assert.equal(relay.statusChecks, 2);
      await fetch(`${base}/c/${ready.coach.handle}`);
      await fetch(`${base}/c/${notReady.coach.handle}`);
      assert.equal(relay.statusChecks, 2, 'the saved answer is used after that');
    });
    assert.equal(await chargesEnabled(db, ready.coach.id), true);
    assert.equal(await chargesEnabled(db, notReady.coach.id), false);
  });
});

// ---- the text when charges start working --------------------------------

test('when charges start working the coach gets one text with their page, even if told twice', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await textingCoach(db, daytimeZone());
    await recordChargesEnabled(db, coach, false);
    await withServer(async (base) => {
      await postSellerEvent(base, { sellerKey: coach.handle, chargesEnabled: true });
      await postSellerEvent(base, { sellerKey: coach.handle, chargesEnabled: true });
    });
    const texts = relay.sms.filter((m) => m.to === coach.phone);
    assert.equal(texts.length, 1);
    assert.equal(
      texts[0].body,
      `Coachatron: You can take payments now. Your page: coachatron.com/c/${coach.handle} Reply STOP to opt out.`,
    );
  });
});

test('the text waits for 8am when charges start working at night, and is sent once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await textingCoach(db);
    await recordChargesEnabled(db, coach, false, new Date('2026-10-20T02:00:00Z'));
    const night = new Date('2026-10-20T04:00:00Z'); // 11pm in Chicago
    await recordChargesEnabled(db, coach, true, night);
    assert.equal(relay.sms.length, 0);
    await runTick(db, new Date('2026-10-20T11:30:00Z')); // 6:30am
    assert.equal(relay.sms.length, 0);
    await runTick(db, new Date('2026-10-20T13:00:00Z')); // 8am
    await runTick(db, new Date('2026-10-20T13:01:00Z'));
    assert.equal(relay.sms.filter((m) => /You can take payments now/.test(m.body)).length, 1);
  });
});

test('no text the first time a coach is seen able to take charges, or for a coach without the texts box', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await textingCoach(db);
    await recordChargesEnabled(db, coach, true, MORNING);
    assert.equal(relay.sms.length, 0, 'nothing was known before, so nothing changed');

    const quiet = await createCoach(db, { name: 'No Texts', phone: '+15550104040', email: '', tz: 'America/Chicago' });
    await recordChargesEnabled(db, quiet, false, MORNING);
    await recordChargesEnabled(db, quiet, true, MORNING);
    await runTick(db, new Date(MORNING.getTime() + 60_000));
    assert.equal(relay.sms.length, 0);
    const logged = await db.query('select id from message_log');
    assert.equal(logged.rows.length, 0, 'nothing is attempted');
  });
});
