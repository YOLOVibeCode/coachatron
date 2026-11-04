import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedPlan } from './helpers/fixtures.js';
import { postSellerEvent } from './helpers/store-event.js';
import { createCoach, createCoachSession, type CoachRow } from '../src/domain/auth.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { createPendingBooking } from '../src/domain/pricing.js';
import { zonedParts } from '../src/domain/scheduling.js';
import {
  getPaymentsRow,
  markPaymentsStarted,
  notePublished,
  paymentsOpen,
  PAYMENTS_RETRY_MS,
  recordChargesEnabled,
  sendPaymentReminders,
} from '../src/domain/payments.js';
import { runTick } from '../src/jobs/tick.js';
import { runMigrations } from '../src/db/migrate.js';
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

test('a check the relay does not answer still waits 15 minutes before the tick asks again', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    await db.query('update coach_payments set checked_at = $2 where coach_id = $1', [
      seed.coach.id,
      new Date(MORNING.getTime() - 60 * 60 * 1000).toISOString(),
    ]);
    await markPaymentsStarted(db, seed.coach.id, MORNING);
    relay.statusDown = true;
    await runTick(db, MORNING);
    assert.equal(relay.statusChecks, 1);
    const row = await getPaymentsRow(db, seed.coach.id);
    assert.equal(row?.charges_enabled, false, 'what was known stays');
    assert.ok(row?.attempted_at, 'the ask is saved');

    await runTick(db, new Date(MORNING.getTime() + 60 * 1000));
    await runTick(db, new Date(MORNING.getTime() + 14 * 60 * 1000));
    assert.equal(relay.statusChecks, 1, 'not again inside 15 minutes');

    relay.statusDown = false;
    relay.enableCharges('coachatron', seed.coach.handle);
    await runTick(db, new Date(MORNING.getTime() + 15 * 60 * 1000));
    assert.equal(relay.statusChecks, 2);
    assert.equal(await chargesEnabled(db, seed.coach.id), true);
  });
});

test('coaches the relay cannot answer for take turns with everyone else in the tick', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const ids: number[] = [];
    for (let n = 0; n < 26; n += 1) {
      const coach = await createCoach(db, {
        name: `Coach ${n}`,
        phone: `+1555020${String(n).padStart(4, '0')}`,
        email: '',
        tz: 'America/Chicago',
      });
      await markPaymentsStarted(db, coach.id, MORNING);
      ids.push(coach.id);
    }
    relay.statusDown = true;
    await runTick(db, MORNING);
    assert.equal(relay.statusChecks, 25, 'one batch');
    await runTick(db, new Date(MORNING.getTime() + 60 * 1000));
    assert.equal(relay.statusChecks, 26, 'the next tick asks about the one left, not the same batch again');
    const asked = await db.query<{ n: number }>('select count(*)::int as n from coach_payments where attempted_at is not null');
    assert.equal(asked.rows[0].n, ids.length);
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
    const pending = await createPendingBooking(db, {
      sessionId: seed.sessionId,
      capacity: 2,
      athleteName: 'Sam Reyes',
      contactPhone: '+15550007777',
      contactEmail: null,
    });
    assert.ok(pending);
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

      const checkoutPath = `/c/${seed.coach.handle}/checkout/${pending.id}`;
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

test('a family with session credits can still book with them while payments are paused', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    const packageId = await seedPackage(db, seed.coach.id, 5, 15000);
    await seedPlan(db, seed.coach.id, 4, 12000);
    await db.query(
      `insert into credit (coach_id, contact_phone, remaining, source) values ($1, '+15550007777', 3, $2)`,
      [seed.coach.id, `package:${packageId}`],
    );
    await withServer(async (base) => {
      const bookPath = `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`;
      const coachPage = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(coachPage, /Booking opens soon/);
      assert.doesNotMatch(coachPage, />Book</, 'no Book button');
      assert.match(coachPage, new RegExp(`<a href="${bookPath}">Have session credits\\? Book with them</a>`));

      const formHtml = await (await fetch(`${base}${bookPath}`)).text();
      assert.match(formHtml, /only with session credits/);
      assert.match(formHtml, /Continue with a credit/);

      const none = await form(base, bookPath, { athlete_name: 'Mia Ortiz', contact_phone: '5550008888' });
      assert.equal(none.status, 409, 'a phone without credits cannot book yet');
      const noneHtml = await none.text();
      assert.match(noneHtml, /Booking opens soon/);
      assert.match(noneHtml, /Only session credits can be used until then/);
      assert.equal((await db.query('select id from booking where athlete_name = $1', ['Mia Ortiz'])).rows.length, 0);

      const booked = await form(base, bookPath, { athlete_name: 'Sam Reyes', contact_phone: '5550007777' });
      assert.equal(booked.status, 303);
      const checkoutPath = booked.headers.get('location') ?? '';
      assert.match(checkoutPath, new RegExp(`^/c/${seed.coach.handle}/checkout/\\d+$`));

      const checkout = await (await fetch(`${base}${checkoutPath}`)).text();
      assert.match(checkout, /Use 1 of 3 session credits/);
      assert.doesNotMatch(checkout, /Pay \$/);
      assert.doesNotMatch(checkout, /Buy |Subscribe to /);

      const used = await form(base, checkoutPath, { mode: 'credit' });
      assert.equal(used.status, 303);
      const rows = await db.query<{ status: string; payment_source: string }>(
        'select status, payment_source from booking where athlete_name = $1',
        ['Sam Reyes'],
      );
      assert.equal(rows.rows[0].status, 'booked');
      assert.equal(rows.rows[0].payment_source, 'PackageCredit');
      const left = await db.query<{ remaining: number }>('select remaining from credit where coach_id = $1', [seed.coach.id]);
      assert.equal(left.rows[0].remaining, 2);
      assert.equal(relay.buyLinks.length, 0);
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

test('while the relay cannot say whether a coach takes payments, booking waits, and the page asks at most once a minute', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await db.query('delete from coach_payments');
    relay.statusDown = true;
    await withServer(async (base) => {
      const coachPage = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(coachPage, /Booking opens soon/);
      assert.doesNotMatch(coachPage, />Book</);
      const bookPath = `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`;
      assert.match(await (await fetch(`${base}${bookPath}`)).text(), /Booking opens soon/);
      const booked = await form(base, bookPath, { athlete_name: 'Mia Ortiz', contact_phone: '5550008888' });
      assert.equal(booked.status, 409);
    });
    assert.equal(relay.statusChecks, 1, 'one ask, then the saved attempt holds the rest');
    assert.equal(relay.buyLinks.length, 0);

    const asked = (await getPaymentsRow(db, seed.coach.id))?.attempted_at;
    assert.ok(asked);
    const soon = new Date(new Date(asked).getTime() + PAYMENTS_RETRY_MS - 1000);
    assert.equal(await paymentsOpen(db, seed.coach, soon), false);
    assert.equal(relay.statusChecks, 1);

    relay.statusDown = false;
    relay.enableCharges('coachatron', seed.coach.handle);
    const later = new Date(new Date(asked).getTime() + PAYMENTS_RETRY_MS);
    assert.equal(await paymentsOpen(db, seed.coach, later), true);
    assert.equal(relay.statusChecks, 2);
    assert.equal(await chargesEnabled(db, seed.coach.id), true);
  });
});

// ---- coaches from before readiness was saved ------------------------------

/** The next whole hour from `from` that is mid-morning in Chicago. */
function chicagoMorningAfter(from: Date): Date {
  let at = new Date(Math.ceil(from.getTime() / 3_600_000) * 3_600_000);
  while (zonedParts(at, 'America/Chicago').hour !== 10) at = new Date(at.getTime() + 3_600_000);
  return at;
}

test('a coach with sessions from before readiness was saved gets no go-live text and no reminders', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const before = await seedCoachWithSession(db);
    // As the database stood before migration 0015 ran.
    await db.query('delete from coach_payments');
    await db.query(`delete from schema_migrations where name = '0015_payment_readiness.sql'`);
    await runMigrations(db);
    const row = await getPaymentsRow(db, before.coach.id);
    assert.ok(row?.published_at && row.live_texted_at);
    assert.equal(row.reminders_sent, 2);
    assert.equal(row.charges_enabled, null);

    // A coach who goes live after it, as a check that the texts do go out.
    const after = await seedCoachWithSession(db, { paymentsReady: false });
    const now = new Date();
    await notePublished(db, before.coach, now);
    await notePublished(db, after.coach, now);
    const later = chicagoMorningAfter(new Date(now.getTime() + 4 * 24 * 3_600_000));
    await sendPaymentReminders(db, later);
    await sendPaymentReminders(db, new Date(later.getTime() + 24 * 3_600_000));

    assert.equal(relay.sms.filter((m) => m.to === before.coach.phone).length, 0);
    const afterTexts = relay.sms.filter((m) => m.to === after.coach.phone).map((m) => m.body);
    assert.equal(afterTexts.length, 3, 'go-live text and two reminders');
    assert.match(afterTexts[0], /You're live/);
    assert.match(afterTexts[1], /Tap to finish/);
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
