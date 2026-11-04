import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { bookOnline, countSold, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { seedBookedSession, seedCoachWithSession, seedPackage } from './helpers/fixtures.js';
import { createCredit } from '../src/domain/pricing.js';
import type { DbClient } from '../src/db/client.js';

/** Children per parent (SPEC.md §9.5): one booking pass adds up to the
 * coach's limit, each child takes one spot and uses one credit or one
 * drop-in. The relay's buy link names one amount with no quantity, so
 * several children's drop-ins are one charge of the price for each. */

const PHONE = '+15551113333';

async function pass(db: DbClient) {
  const r = await db.query<{
    id: number;
    athlete_name: string;
    status: string;
    pass_id: string | null;
    checkout_token: string | null;
    manage_token: string;
    gross_cents: number | null;
    credit_id: number | null;
  }>('select id, athlete_name, status, pass_id, checkout_token, manage_token, gross_cents, credit_id from booking where contact_phone = $1 order by id', [
    PHONE,
  ]);
  return r.rows;
}

function lastCode(sms: Array<{ to: string; body: string }>, to: string): string {
  const text = [...sms].reverse().find((m) => m.to === to);
  const code = text ? /\b(\d{6})\b/.exec(text.body)?.[1] : undefined;
  assert.ok(code, 'a code was texted');
  return code;
}

async function proveAndOpen(base: string, handle: string, key: string, sms: Array<{ to: string; body: string }>): Promise<string> {
  assert.equal((await postCheckout(base, handle, key, { mode: 'send_code' })).status, 200);
  assert.equal((await postCheckout(base, handle, key, { mode: 'verify_code', code: lastCode(sms, PHONE) })).status, 303);
  return (await fetch(`${base}/c/${handle}/checkout/${key}`)).text();
}

test("the booking form offers up to the coach's limit of children", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await withServer(async (base) => {
      const form = async () => (await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`)).text();
      const byDefault = await form();
      assert.match(byDefault, /Booking for more than one child\? Up to 2 at once/);
      assert.match(byDefault, /name="athlete_name_2"/);
      assert.doesNotMatch(byDefault, /name="athlete_name_3"/);

      await db.query('update coach set children_per_booking = 3 where id = $1', [seed.coach.id]);
      assert.match(await form(), /name="athlete_name_3"/);

      await db.query('update coach set children_per_booking = 1 where id = $1', [seed.coach.id]);
      assert.doesNotMatch(await form(), /athlete_name_2|more than one child/);
    });
  });
});

test('two children are one pass: one checkout, one charge of twice the price, two bookings', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      assert.equal(b.status, 303);
      const rows = await pass(db);
      assert.deepEqual(rows.map((r) => [r.athlete_name, r.status]), [
        ['Mia', 'pending'],
        ['Leo', 'pending'],
      ]);
      assert.ok(rows[0].pass_id && rows[0].pass_id === rows[1].pass_id, 'one pass');
      assert.equal(rows[1].checkout_token, null, 'paid for through the first booking');
      assert.notEqual(rows[0].manage_token, rows[1].manage_token, 'each child has a manage link');

      const page = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      assert.match(page, /For Mia and Leo: 2 spots\./);
      assert.match(page, /Pay \$70\.00 — this session, 2 spots/);

      const pay = await postCheckout(base, seed.coach.handle, b.key!, { mode: 'dropin' });
      assert.equal(pay.status, 303);
      const link = new URL(pay.headers.get('location')!);
      assert.equal(link.searchParams.get('amount'), '7000');
      assert.match(link.searchParams.get('desc') ?? '', /\(2 spots\)/);

      const paid = await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 7000, paymentId: 'ch_two' });
      assert.equal(paid.status, 200);
      assert.equal(await countSold(db, seed.sessionId), 2);
      const booked = await pass(db);
      assert.deepEqual(booked.map((r) => [r.status, r.gross_cents]), [
        ['booked', 3500],
        ['booked', 3500],
      ]);
      const done = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      for (const r of booked) assert.ok(done.includes(`/booking/${r.manage_token}`), 'a manage link for each child');
    });
    const confirmations = relay.sms.filter((m) => m.to === PHONE && /is booked/.test(m.body));
    assert.equal(confirmations.length, 2, 'one confirmation per child, each with its own link');
  });
});

test("one child's price for two children books neither and is kept for the coach", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      const pay = await postCheckout(base, seed.coach.handle, b.key!, { mode: 'dropin' });
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ch_short' });
    });
    assert.equal(await countSold(db, seed.sessionId), 0);
    const kept = await db.query<{ reason: string; expected_cents: number }>('select reason, expected_cents from payment_attention');
    assert.deepEqual(kept.rows, [{ reason: 'amount_mismatch', expected_cents: 7000 }]);
  });
});

test('more children than the limit is refused, and nothing is held', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await withServer(async (base) => {
      const res = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo', athlete_name_3: 'Sam' });
      assert.equal(res.status, 422);
    });
    assert.equal((await pass(db)).length, 0);
  });
});

test('with too few spots for every child, nothing is held and the waitlist takes them all', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await seedBookedSession(db, seed.sessionId, 'Booked One', '+15550000001');
    await seedBookedSession(db, seed.sessionId, 'Booked Two', '+15550000002');
    await withServer(async (base) => {
      const res = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ athlete_name: 'Mia', athlete_name_2: 'Leo', contact_phone: PHONE }),
      });
      assert.equal(res.status, 409);
      const full = await res.text();
      assert.match(full, /Not enough spots for 2 children/);
      assert.match(full, /name="athlete_name_2" value="Leo"/);
      assert.equal((await pass(db)).length, 0);

      await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ athlete_name: 'Mia', athlete_name_2: 'Leo', contact_phone: PHONE }),
      });
    });
    const line = await db.query<{ athlete_name: string }>('select athlete_name from waitlist where session_id = $1 order by id', [seed.sessionId]);
    assert.deepEqual(line.rows.map((r) => r.athlete_name), ['Mia', 'Leo']);
  });
});

test('session credits: one per child, from more than one credit if need be', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const a = await createCredit(db, seed.coach.id, PHONE, null, 'test', 1, null);
    const b = await createCredit(db, seed.coach.id, PHONE, null, 'test', 2, null);
    await withServer(async (base) => {
      const booking = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      const page = await proveAndOpen(base, seed.coach.handle, booking.key!, relay.sms);
      assert.match(page, /Use 2 of 3 session credits/);
      assert.equal((await postCheckout(base, seed.coach.handle, booking.key!, { mode: 'credit' })).status, 303);
    });
    const left = await db.query<{ id: number; remaining: number }>('select id, remaining from credit order by id');
    assert.deepEqual(left.rows.map((r) => r.remaining), [0, 1]);
    const rows = await pass(db);
    assert.deepEqual(rows.map((r) => [r.status, r.credit_id]), [
      ['booked', a],
      ['booked', b],
    ]);
  });
});

test('one credit is not enough for two children: the page says so and nothing is used', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const only = await createCredit(db, seed.coach.id, PHONE, null, 'test', 1, null);
    await withServer(async (base) => {
      const booking = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      const page = await proveAndOpen(base, seed.coach.handle, booking.key!, relay.sms);
      assert.match(page, /You have 1 session credit with Jamie Coach; this booking needs 2, one for each child\./);
      assert.doesNotMatch(page, /name="mode" value="credit"/);
      assert.equal((await postCheckout(base, seed.coach.handle, booking.key!, { mode: 'credit' })).status, 409);
    });
    const r = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [only]);
    assert.equal(r.rows[0].remaining, 1);
    assert.equal(await countSold(db, seed.sessionId), 0);
  });
});

test('a package must cover every child; its leftover sessions become the credit both children draw from', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const single = await seedPackage(db, seed.coach.id, 1, 3000);
    const ten = await seedPackage(db, seed.coach.id, 10, 30000);
    await withServer(async (base) => {
      const booking = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      const page = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${booking.key}`)).text();
      assert.doesNotMatch(page, new RegExp(`name="package_id" value="${single}"`));
      assert.match(page, new RegExp(`name="package_id" value="${ten}"`));
      assert.equal(
        (await postCheckout(base, seed.coach.handle, booking.key!, { mode: 'package', package_id: String(single) })).status,
        404,
      );
      const pay = await postCheckout(base, seed.coach.handle, booking.key!, { mode: 'package', package_id: String(ten) });
      assert.equal(new URL(pay.headers.get('location')!).searchParams.get('amount'), '30000');
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 30000, paymentId: 'ch_pkg' });
    });
    const rows = await pass(db);
    assert.deepEqual(rows.map((r) => r.status), ['booked', 'booked']);
    assert.ok(rows[0].credit_id && rows[0].credit_id === rows[1].credit_id);
    const credit = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [rows[0].credit_id]);
    assert.equal(credit.rows[0].remaining, 8, 'ten sessions, two used');
  });
});

test("each child's booking is cancelled on its own manage link, and gives back its own credit", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    await db.query("update session set starts_at_utc = now() + interval '3 days' where id = $1", [seed.sessionId]);
    const credit = await createCredit(db, seed.coach.id, PHONE, null, 'test', 2, null);
    await withServer(async (base) => {
      const booking = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo' });
      await proveAndOpen(base, seed.coach.handle, booking.key!, relay.sms);
      assert.equal((await postCheckout(base, seed.coach.handle, booking.key!, { mode: 'credit' })).status, 303);
      assert.equal(await countSold(db, seed.sessionId), 2);
      const [, leo] = await pass(db);
      await fetch(`${base}/booking/${leo.manage_token}/cancel`, { method: 'POST', redirect: 'manual' });
    });
    assert.deepEqual((await pass(db)).map((r) => [r.athlete_name, r.status]), [
      ['Mia', 'booked'],
      ['Leo', 'cancelled'],
    ]);
    const left = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [credit]);
    assert.equal(left.rows[0].remaining, 1, "Leo's credit is back; Mia's is still used");
  });
});
