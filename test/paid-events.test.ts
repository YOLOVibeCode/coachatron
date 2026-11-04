import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { bookOnline, countSold, expireHolds, latestBooking, postCheckout } from './helpers/booking.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { createCoachSession } from '../src/domain/auth.js';
import { PAYMENT_ATTENTION_LOG_PREFIX } from '../src/domain/paymentAttention.js';
import type { DbClient } from '../src/db/client.js';

/** Paid events are recorded in the database before they are handled, so a
 * redelivery or a restart never handles one twice. A payment that cannot
 * simply book is never dropped: it is kept with a reason, logged once, and
 * shown to the coach on the Money screen. */

async function startPay(base: string, handle: string, phone: string, sessionId: number, fields: Record<string, string> = { mode: 'dropin' }) {
  const b = await bookOnline(base, handle, sessionId, 'Alex', phone);
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, handle, b.key, fields);
  assert.equal(pay.status, 303);
  return { key: b.key, userId: buyerFromLocation(pay.headers.get('location')) };
}

async function attention(db: DbClient) {
  const r = await db.query<{ reason: string; coach_id: number | null; amount_cents: number | null; expected_cents: number | null; outcome: string | null }>(
    'select reason, coach_id, amount_cents, expected_cents, outcome from payment_attention order by id',
  );
  return r.rows;
}

async function moneyPage(base: string, db: DbClient, coachId: number): Promise<string> {
  const cookie = `cx_session=${await createCoachSession(db, coachId)}`;
  return (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
}

function captureErrors(t: TestContext): () => string[] {
  const mock = t.mock.method(console, 'error', () => {});
  return () => mock.mock.calls.map((c) => String(c.arguments[0]));
}

test('the same paid event is handled once, also after the server restarts', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    let userId = '';
    await withServer(async (base) => {
      ({ userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId, { mode: 'package', package_id: String(packageId) }));
      assert.equal((await postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pkg' })).status, 200);
      assert.equal((await postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pkg' })).status, 200);
    });
    // A new server process has no memory of the first one; the database does.
    await withServer(async (base) => {
      assert.equal((await postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pkg' })).status, 200);
    });
    const credits = await db.query<{ remaining: number }>("select remaining from credit where contact_phone = '+15551112222'");
    assert.deepEqual(credits.rows.map((r) => r.remaining), [9]);
    const events = await db.query<{ processed_at: string | null }>('select processed_at from store_event');
    assert.equal(events.rows.length, 1);
    assert.ok(events.rows[0].processed_at);
    assert.deepEqual(await attention(db), []);
  });
});

test('an event another delivery is still handling is sent back for a retry; one left unfinished long ago is handled', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await db.query("insert into store_event (event_id, type) values ('rel_evt_ch_busy', 'marketplace.purchase.paid')");
      const busy = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_busy' });
      assert.ok(busy.status >= 500, `the relay is asked to deliver it again (${busy.status})`);
      assert.equal((await latestBooking(db)).status, 'pending', 'left to the delivery that holds it');
      const claim = await db.query<{ n: string }>("select count(*)::text as n from store_event where event_id = 'rel_evt_ch_busy'");
      assert.equal(claim.rows[0].n, '1', "the other delivery's claim is kept");

      await db.query("update store_event set claimed_at = now() - interval '10 minutes' where event_id = 'rel_evt_ch_busy'");
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_busy' })).status, 200);
      assert.equal((await latestBooking(db)).status, 'booked');
    });
  });
});

test('a delivery that fails part way lets the retry handle the event', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    let failNext = true;
    const failing = (query: DbClient['query']) =>
      (async (sql: string, params?: unknown[]) => {
        if (failNext && sql.includes("set status = 'booked'")) {
          failNext = false;
          throw new Error('database unavailable');
        }
        return query(sql, params);
      }) as DbClient['query'];
    const transaction = db.transaction!.bind(db);
    db.query = failing(db.query.bind(db));
    db.transaction = <T>(fn: (tx: DbClient) => Promise<T>) => transaction((tx) => fn({ query: failing(tx.query.bind(tx)) }));
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      const first = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_retry' });
      assert.equal(first.status, 500);
      assert.equal((await latestBooking(db)).status, 'pending');
      const second = await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_retry' });
      assert.equal(second.status, 200);
      assert.equal((await latestBooking(db)).status, 'booked');
    });
    assert.deepEqual(await attention(db), []);
  });
});

test('a payment for the wrong amount is kept for the coach with one log line, and not booked', async (t) => {
  const errors = captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      assert.equal((await postStorePaid(base, { userId, amountCents: 1, paymentId: 'ch_cheap' })).status, 200);
      const money = await moneyPage(base, db, seed.coach.id);
      assert.match(money, /Payments to resolve/);
      assert.match(money, /Paid \$0\.01, but the price was \$35\.00\. Not booked\./);
      assert.match(money, /\+15551112222/);
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    assert.deepEqual(await attention(db), [{ reason: 'amount_mismatch', coach_id: seed.coach.id, amount_cents: 1, expected_cents: 3500, outcome: null }]);
  });
  const lines = errors().filter((line) => line.startsWith(PAYMENT_ATTENTION_LOG_PREFIX));
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0].slice(PAYMENT_ATTENTION_LOG_PREFIX.length));
  assert.equal(logged.reason, 'amount_mismatch');
  assert.ok(!lines[0].includes('5551112222'), 'the log line carries no phone number');
});

test('a second payment for a booking that is already booked is kept as paid twice', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_first' });
      await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_second' });
      assert.match(await moneyPage(base, db, seed.coach.id), /already paid for, so this is a second payment/);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.deepEqual((await attention(db)).map((a) => a.reason), ['already_booked']);
  });
});

test('a payment for a booking that does not exist is kept for the coach the seller names', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const res = await postStorePaid(base, { userId: 'booking:999999:dropin', amountCents: 3500, paymentId: 'ch_ghost', sellerKey: seed.coach.handle });
      assert.equal(res.status, 200);
      assert.match(await moneyPage(base, db, seed.coach.id), /a booking we could not find/);
    });
    assert.deepEqual((await attention(db)).map((a) => [a.reason, a.coach_id]), [['booking_missing', seed.coach.id]]);
  });
});

test('a payment for a session that has started is kept, not booked', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await db.query("update session set starts_at_utc = now() - interval '1 minute' where id = $1", [seed.sessionId]);
      await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_late' });
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    assert.deepEqual((await attention(db)).map((a) => a.reason), ['session_started']);
  });
});

test('after a lapsed hold a payment books when there is room, and is kept when the session filled', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      const first = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await expireHolds(db, seed.sessionId);
      await postStorePaid(base, { userId: first.userId, amountCents: 3500, paymentId: 'ch_room' });
      assert.equal(await countSold(db, seed.sessionId), 1, 'room was left, so it booked');

      const other = await seedCoachWithSession(db, { capacity: 1 });
      const a = await startPay(base, other.coach.handle, '5553334444', other.sessionId);
      await expireHolds(db, other.sessionId);
      const b = await startPay(base, other.coach.handle, '5555556666', other.sessionId);
      await postStorePaid(base, { userId: b.userId, amountCents: 3500, paymentId: 'ch_b' });
      await postStorePaid(base, { userId: a.userId, amountCents: 3500, paymentId: 'ch_a' });
      assert.equal(await countSold(db, other.sessionId), 1);
      assert.match(await moneyPage(base, db, other.coach.id), /filled up before this payment arrived/);
    });
    assert.deepEqual((await attention(db)).map((r) => r.reason), ['session_full']);
  });
});

test('a payment for a session the coach cancelled becomes credit with that coach, and the parent is told', async (t) => {
  captureErrors(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const dropIn = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      const pack = await startPay(base, seed.coach.handle, '5553334444', seed.sessionId, { mode: 'package', package_id: String(packageId) });
      assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
      await postStorePaid(base, { userId: dropIn.userId, amountCents: 3500, paymentId: 'ch_dropin_late' });
      await postStorePaid(base, { userId: pack.userId, amountCents: 30000, paymentId: 'ch_pack_late' });

      const money = await moneyPage(base, db, seed.coach.id);
      assert.match(money, /The parent now has 1 session credit with you and was told\./);
      assert.match(money, /The parent now has 10 session credits with you and was told\./);
      const back = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${dropIn.key}`)).text();
      assert.match(back, /This booking was cancelled/);
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    const credits = await db.query<{ contact_phone: string; remaining: number }>(
      'select contact_phone, remaining from credit where coach_id = $1 order by contact_phone',
      [seed.coach.id],
    );
    assert.deepEqual(credits.rows.map((r) => [r.contact_phone, r.remaining]), [['+15551112222', 1], ['+15553334444', 10]]);
    const bookings = await db.query<{ status: string; charge_id: string; credit_id: number | null }>(
      'select status, charge_id, credit_id from booking where session_id = $1 order by id',
      [seed.sessionId],
    );
    assert.deepEqual(bookings.rows.map((b) => [b.status, b.charge_id, b.credit_id !== null]), [
      ['cancelled', 'ch_dropin_late', true],
      ['cancelled', 'ch_pack_late', true],
    ]);
    for (const phone of ['+15551112222', '+15553334444']) {
      const told = relay.sms.filter((m) => m.to === phone && /your payment is now \d+ session credits? with Jamie Coach/.test(m.body));
      assert.equal(told.length, 1, phone);
      assert.match(told[0].body, /\/booking\/[A-Za-z0-9_-]+ Reply STOP to opt out\.$/);
    }
    assert.deepEqual((await attention(db)).map((a) => [a.reason, a.outcome]), [
      ['session_cancelled', 'credit:1:told'],
      ['session_cancelled', 'credit:10:told'],
    ]);
  });
});

test("a coach sees only their own payments to resolve", async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const A = await seedCoachWithSession(db, { capacity: 3 });
    const B = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, A.coach.handle, '5551112222', A.sessionId);
      await postStorePaid(base, { userId, amountCents: 1, paymentId: 'ch_a_only' });
      assert.match(await moneyPage(base, db, A.coach.id), /Payments to resolve/);
      const other = await moneyPage(base, db, B.coach.id);
      assert.doesNotMatch(other, /Payments to resolve|5551112222/);
    });
  });
});

test('a parent who cannot be told about their credit is flagged to the coach', async (t) => {
  captureErrors(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222', { sms_consent: '' });
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_quiet' });
      assert.match(await moneyPage(base, db, seed.coach.id), /1 session credit with you\. They could not be told: please let them know\./);
    });
    assert.equal(relay.sms.filter((m) => m.to === '+15551112222').length, 0);
    assert.equal(relay.emails.length, 0);
    assert.deepEqual((await attention(db)).map((a) => a.outcome), ['credit:1:not-told']);
  });
});

test('a payment whose session the coach cancels while it is being handled becomes credit, and the parent is told', async (t) => {
  captureErrors(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const { userId, key } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      // The coach's cancel lands after the payment read the session and
      // before it booked.
      const query = db.query.bind(db);
      let cancelled = false;
      db.query = (async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (!cancelled && sql.includes('select st.coach_id, s.status, s.starts_at_utc')) {
          cancelled = true;
          assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
        }
        return result;
      }) as DbClient['query'];
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_mid_cancel' })).status, 200);
      assert.ok(cancelled);
      assert.match(await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${key}`)).text(), /This booking was cancelled/);
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    const booking = await latestBooking(db);
    assert.equal(booking.status, 'cancelled');
    const credits = await db.query<{ remaining: number }>("select remaining from credit where contact_phone = '+15551112222'");
    assert.deepEqual(credits.rows.map((r) => r.remaining), [1]);
    assert.equal(relay.sms.filter((m) => m.to === '+15551112222' && /session credit/.test(m.body)).length, 1);
    assert.equal(relay.sms.filter((m) => m.to === '+15551112222' && /booked/i.test(m.body)).length, 0, 'no booked confirmation');
    assert.deepEqual((await attention(db)).map((a) => [a.reason, a.outcome]), [['session_cancelled', 'credit:1:told']]);
  });
});

test('a payment made before the session started books even when its event arrives after the start', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await db.query("update session set starts_at_utc = now() - interval '1 minute' where id = $1", [seed.sessionId]);
      const paidAt = new Date(Date.now() - 5 * 60_000);
      assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_in_time', occurredAt: paidAt })).status, 200);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.deepEqual(await attention(db), []);
  });
});

test('two events for one payment handled at the same moment book once and add one credit', async (t) => {
  captureErrors(t);
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const { userId } = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId, { mode: 'package', package_id: String(packageId) });
      // The second event is handled in full after the first has read the
      // booking as pending and before it books.
      const query = db.query.bind(db);
      let second: Promise<Response> | null = null;
      db.query = (async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (!second && sql.includes('from booking where id = $1') && sql.includes('checkout_token')) {
          second = postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pair', eventId: 'rel_evt_mirror' });
          assert.equal((await second).status, 200);
        }
        return result;
      }) as DbClient['query'];
      assert.equal((await postStorePaid(base, { userId, amountCents: 30000, paymentId: 'ch_pair', eventId: 'rel_evt_base' })).status, 200);
      assert.ok(second);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    const credits = await db.query<{ remaining: number }>("select remaining from credit where contact_phone = '+15551112222'");
    assert.deepEqual(credits.rows.map((r) => r.remaining), [9]);
    assert.deepEqual(await attention(db), [], 'not shown to the coach as paid twice');
  });
});

test('a parent whose payment could not book is told so, and is not offered to pay again', async (t) => {
  captureErrors(t);
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    await withServer(async (base) => {
      const late = await startPay(base, seed.coach.handle, '5551112222', seed.sessionId);
      await expireHolds(db, seed.sessionId);
      const other = await startPay(base, seed.coach.handle, '5553334444', seed.sessionId);
      await postStorePaid(base, { userId: other.userId, amountCents: 3500, paymentId: 'ch_other' });
      await postStorePaid(base, { userId: late.userId, amountCents: 3500, paymentId: 'ch_late_full' });
      const links = relay.buyLinks.length;

      for (const path of [`/c/${seed.coach.handle}/checkout/${late.key}?paid=1`, `/c/${seed.coach.handle}/checkout/${late.key}`]) {
        const body = await (await fetch(`${base}${path}`)).text();
        assert.match(body, /We got your payment/, path);
        assert.match(body, /Jamie Coach has it and will be in touch/, path);
        assert.doesNotMatch(body, /Checking for your payment|name="mode"/, path);
      }
      const again = await postCheckout(base, seed.coach.handle, late.key, { mode: 'dropin' });
      assert.equal(again.status, 409);
      assert.equal(again.headers.get('location'), null);
      assert.equal(relay.buyLinks.length, links, 'no second payment is started');

      const manage = (await db.query<{ manage_token: string }>("select manage_token from booking where contact_phone = '+15551112222'")).rows[0];
      const page = await (await fetch(`${base}/booking/${manage.manage_token}`)).text();
      assert.match(page, /Payment received, not booked\. Jamie Coach will be in touch\./);
      assert.doesNotMatch(page, /Payment not confirmed yet/);
    });
    assert.deepEqual((await attention(db)).map((a) => a.reason), ['session_full']);
  });
});
