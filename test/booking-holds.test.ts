import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { bookOnline, countSold, expireHolds, postCheckout } from './helpers/booking.js';
import { createCredit } from '../src/domain/pricing.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import type { DbClient } from '../src/db/client.js';

/** A pending booking holds its spot for 15 minutes while the parent pays, so
 * a spot is sold once. Booking and the credit path both count live bookings
 * plus unexpired holds; a hold that runs out frees the spot. */

async function confirmPhones(db: DbClient, sessionId: number): Promise<void> {
  await db.query("update booking set phone_verified_at = now() where session_id = $1 and status = 'pending'", [sessionId]);
}

async function creditLeft(db: DbClient, creditId: number): Promise<number> {
  return (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId])).rows[0].remaining;
}

test('a pending booking holds the last spot, so a second parent is offered the waitlist', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.equal(first.status, 303);
      const second = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Blake', '5553334444');
      assert.equal(second.status, 409);
      assert.equal(second.key, null);

      const publicPage = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(publicPage, /Full/);
      assert.doesNotMatch(publicPage, /sessions\/\d+\/book/);
    });
    const held = await db.query<{ hold_expires_at: string }>('select hold_expires_at from booking where session_id = $1', [seed.sessionId]);
    assert.equal(held.rows.length, 1, 'the refused booking left nothing behind');
    const minutes = (new Date(held.rows[0].hold_expires_at).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 14 && minutes <= 15, `the hold lasts 15 minutes (${minutes.toFixed(2)})`);
  });
});

test('an expired hold frees the spot for the next parent', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      assert.equal((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222')).status, 303);
      await expireHolds(db, seed.sessionId);
      assert.equal((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Blake', '5553334444')).status, 303);
    });
  });
});

test('two parents going for the last spot: only one gets to pay, and only one is booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    await withServer(async (base) => {
      const keys: string[] = [];
      for (const [name, phone] of [['Alex', '5551112222'], ['Blake', '5553334444']] as const) {
        const b = await bookOnline(base, seed.coach.handle, seed.sessionId, name, phone);
        if (b.status === 303 && b.key) keys.push(b.key);
      }
      assert.equal(keys.length, 1);
      const pay = await postCheckout(base, seed.coach.handle, keys[0], { mode: 'dropin' });
      assert.equal(pay.status, 303);
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_first' });
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
  });
});

test('a credit books the spot its booking holds', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const creditId = await createCredit(db, seed.coach.id, '+15551112222', packageId, `package:${packageId}`, 5, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await confirmPhones(db, seed.sessionId);
      const res = await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' });
      assert.equal(res.status, 303);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.equal(await creditLeft(db, creditId), 4);
  });
});

test('a credit still books after the hold lapsed when the session has room', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    const creditId = await createCredit(db, seed.coach.id, '+15551112222', null, 'test', 2, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await confirmPhones(db, seed.sessionId);
      await expireHolds(db, seed.sessionId);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 303);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.equal(await creditLeft(db, creditId), 1);
  });
});

test('a credit does not book a session that filled after the hold lapsed, and the credit is kept', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    const packageId = await seedPackage(db, seed.coach.id, 10, 30000);
    const creditId = await createCredit(db, seed.coach.id, '+15551112222', packageId, `package:${packageId}`, 5, null);
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(first.key);
      await confirmPhones(db, seed.sessionId);
      await expireHolds(db, seed.sessionId);

      const other = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Blake', '5553334444');
      assert.ok(other.key);
      const pay = await postCheckout(base, seed.coach.handle, other.key, { mode: 'dropin' });
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_blake' });

      const late = await postCheckout(base, seed.coach.handle, first.key, { mode: 'credit' });
      assert.equal(late.status, 409);
      assert.match(await late.text(), /just filled up/);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.equal(await creditLeft(db, creditId), 5);
  });
});

test('a session that has already started cannot be booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    await db.query("update session set starts_at_utc = now() - interval '2 hours' where id = $1", [seed.sessionId]);
    await withServer(async (base) => {
      const form = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`);
      assert.equal(form.status, 409);
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.equal(b.status, 409);
      assert.equal(b.key, null);
    });
    const rows = await db.query('select id from booking where session_id = $1', [seed.sessionId]);
    assert.equal(rows.rows.length, 0);
  });
});

test('checkout does not start a payment once the session has started', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await db.query("update session set starts_at_utc = now() - interval '5 minutes' where id = $1", [seed.sessionId]);
      const res = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      assert.equal(res.status, 409);
      assert.equal(res.headers.get('location'), null);
    });
    assert.equal(relay.buyLinks.length, 0);
  });
});

test('a booking that is already booked is not sent to pay a second time', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_once' });

      for (const mode of ['dropin', 'credit']) {
        const again = await postCheckout(base, seed.coach.handle, b.key, { mode });
        assert.equal(again.status, 409, mode);
        assert.equal(again.headers.get('location'), null, mode);
        assert.match(await again.text(), /You're booked/);
      }
      const page = await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /You're booked/);
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
  });
});

test('attended and no-show bookings still take their spots', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const id = await seedBookedSession(db, seed.sessionId, 'Sam', '+15550000001');
    await db.query("update booking set status = 'attended' where id = $1", [id]);
    await withServer(async (base) => {
      assert.equal((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222')).status, 409);
    });
  });
});

async function liveHolds(db: DbClient, sessionId: number): Promise<number> {
  const r = await db.query<{ n: string }>(
    "select count(*)::text as n from booking where session_id = $1 and status = 'pending' and hold_expires_at > now()",
    [sessionId],
  );
  return Number(r.rows[0].n);
}

test('sending the booking form again for the last spot keeps the spot for that parent', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.equal(first.status, 303);
      const again = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alexis', '5551112222');
      assert.equal(again.status, 303, 'the parent is not shut out by their own earlier hold');
      assert.ok(again.key && again.key !== first.key);
      assert.equal(await liveHolds(db, seed.sessionId), 1, 'one phone holds one spot');

      assert.equal((await bookOnline(base, seed.coach.handle, seed.sessionId, 'Blake', '5553334444')).status, 409);
      assert.equal((await postCheckout(base, seed.coach.handle, again.key, { mode: 'dropin' })).status, 303);
      const stale = await postCheckout(base, seed.coach.handle, first.key!, { mode: 'dropin' });
      assert.equal(stale.status, 409, 'the earlier form no longer holds a spot');
    });
  });
});

test('one phone can still book two athletes into a session with room', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const a = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Sam', '5551112222');
      assert.ok(a.key && b.key);
      for (const [key, ref] of [[a.key, 'ch_alex'], [b.key, 'ch_sam']]) {
        const pay = await postCheckout(base, seed.coach.handle, key, { mode: 'dropin' });
        assert.equal(pay.status, 303);
        await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: ref });
      }
    });
    assert.equal(await countSold(db, seed.sessionId), 2);
  });
});

test('parents sending the form at the same moment for the last spot: exactly one holds it', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      const phones = ['5551112222', '5553334444', '5555556666', '5557778888'];
      const results = await Promise.all(phones.map((p, i) => bookOnline(base, seed.coach.handle, seed.sessionId, `Athlete ${i}`, p)));
      assert.deepEqual(results.map((r) => r.status).sort(), [303, 409, 409, 409]);
    });
    assert.equal(await liveHolds(db, seed.sessionId), 1);
  });
});

test('choosing how to pay gives the parent the full hold to pay in', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await db.query("update booking set hold_expires_at = now() + interval '1 minute' where session_id = $1", [seed.sessionId]);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' })).status, 303);
    });
    const held = await db.query<{ hold_expires_at: string }>('select hold_expires_at from booking where session_id = $1', [seed.sessionId]);
    const minutes = (new Date(held.rows[0].hold_expires_at).getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 14 && minutes <= 15, `the hold runs 15 minutes from choosing (${minutes.toFixed(2)})`);
  });
});

test('a credit does not book a session the coach cancels while the parent is checking out, and the credit is kept', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    const creditId = await createCredit(db, seed.coach.id, '+15551112222', null, 'test', 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await confirmPhones(db, seed.sessionId);

      // The coach's cancel lands just after the credit is taken and before
      // the booking is written.
      const query = db.query.bind(db);
      let cancelled = false;
      db.query = (async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (!cancelled && sql.includes('set remaining = remaining - 1')) {
          cancelled = true;
          assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
        }
        return result;
      }) as DbClient['query'];

      const res = await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' });
      assert.ok(cancelled);
      assert.equal(res.status, 409);
      assert.match(await res.text(), /That session was cancelled/);
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    assert.equal(await creditLeft(db, creditId), 3);
  });
});

test("a payment for a parent's earlier form takes the spot back from the same phone's newer unpaid hold", async (t) => {
  t.mock.method(console, 'error', () => {});
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, priceCents: 3500 });
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(first.key);
      const pay = await postCheckout(base, seed.coach.handle, first.key, { mode: 'dropin' });
      // Waiting on the payment, the parent sends the form again.
      const again = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(again.key);
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_first_form' });

      assert.match(await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${first.key}`)).text(), /You're booked/);
      assert.equal((await postCheckout(base, seed.coach.handle, again.key, { mode: 'dropin' })).status, 409, 'the unpaid hold ended');
    });
    assert.equal(await countSold(db, seed.sessionId), 1);
    assert.equal(await liveHolds(db, seed.sessionId), 0);
    const kept = await db.query('select id from payment_attention');
    assert.equal(kept.rows.length, 0);
  });
});
