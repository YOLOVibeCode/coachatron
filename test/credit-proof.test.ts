import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, latestBooking, postCheckout } from './helpers/booking.js';
import { createCredit } from '../src/domain/pricing.js';
import type { DbClient } from '../src/db/client.js';

/** Session credits belong to a phone, so using them needs proof of that
 * phone: a code texted to it on the checkout step, or arriving from a manage
 * link whose own booking was proven the same way. Typing a number is not
 * proof. */

const PHONE = '+15551112222';

async function remaining(db: DbClient, creditId: number): Promise<number> {
  return (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId])).rows[0].remaining;
}

function lastCode(sms: Array<{ to: string; body: string }>, to: string): string {
  const text = [...sms].reverse().find((m) => m.to === to);
  const code = text ? /\b(\d{6})\b/.exec(text.body)?.[1] : undefined;
  assert.ok(code, 'a code was texted');
  return code;
}

test('an unproven phone sees an offer of a code, not its credits, and cannot spend them', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const creditId = await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const page = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      assert.doesNotMatch(page, /Use 1 of/);
      assert.match(page, /Text me a code/);
      assert.match(page, /••••2222/);

      const spend = await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' });
      assert.equal(spend.status, 403);
    });
    assert.equal(await remaining(db, creditId), 3);
    assert.equal((await latestBooking(db)).status, 'pending');
  });
});

test('a code texted to the booking’s phone unlocks its credits, and a wrong code does not', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const creditId = await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const sent = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
      assert.equal(sent.status, 200);
      assert.match(await sent.text(), /We texted a 6-digit code to ••••2222/);
      const code = lastCode(relay.sms, PHONE);
      const text = relay.sms.at(-1);
      assert.match(text?.body ?? '', /^Coachatron: /);

      const wrong = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: code === '000000' ? '111111' : '000000' });
      assert.equal(wrong.status, 401);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 403);

      const right = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code });
      assert.equal(right.status, 303);
      const page = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      assert.match(page, /Use 1 of 3 session credits/);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 303);
    });
    assert.equal(await remaining(db, creditId), 2);
    assert.equal((await latestBooking(db)).status, 'booked');
  });
});

test('a code works once, and checkout codes share the daily limit on codes to a number', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const second = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Sam', '5551112222');
      assert.ok(first.key && second.key);
      await postCheckout(base, seed.coach.handle, first.key, { mode: 'send_code' });
      const code = lastCode(relay.sms, PHONE);
      assert.equal((await postCheckout(base, seed.coach.handle, first.key, { mode: 'verify_code', code })).status, 303);
      assert.equal((await postCheckout(base, seed.coach.handle, second.key, { mode: 'verify_code', code })).status, 401, 'used code');

      // One code went out above; four more reach the daily limit of five.
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await postCheckout(base, seed.coach.handle, second.key, { mode: 'send_code' })).status, 200, `code ${i + 2}`);
      }
      const capped = await postCheckout(base, seed.coach.handle, second.key, { mode: 'send_code' });
      assert.equal(capped.status, 429);
    });
    assert.equal(relay.sms.filter((m) => m.to === PHONE && /\b\d{6}\b/.test(m.body)).length, 5);
  });
});

test('no code is offered when nobody holds credits with the coach', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const page = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      assert.doesNotMatch(page, /Text me a code|session credits/);
    });
  });
});

async function provenBooking(db: DbClient, sessionId: number, phone: string): Promise<string> {
  const id = await seedBookedSession(db, sessionId, 'Alex', phone);
  await db.query('update booking set phone_verified_at = now() where id = $1', [id]);
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [id])).rows[0].manage_token;
}

test('arriving from a proven manage link fills in the phone and unlocks its credits', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const later = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       values ($1, now() + interval '3 days', 'America/Chicago', 'scheduled') returning id`,
      [seed.sessionTypeId],
    );
    const nextSessionId = later.rows[0].id;
    const token = await provenBooking(db, seed.sessionId, PHONE);
    const creditId = await createCredit(db, seed.coach.id, PHONE, null, 'test', 2, null);
    await withServer(async (base) => {
      const manage = await (await fetch(`${base}/booking/${token}`)).text();
      assert.ok(manage.includes(`/c/${seed.coach.handle}?from=${token}`), 'the manage page links to booking another session');

      const coachPage = await (await fetch(`${base}/c/${seed.coach.handle}?from=${token}`)).text();
      assert.ok(coachPage.includes(`/sessions/${nextSessionId}/book?from=${token}`), 'the link rides along to the booking form');

      const form = await (await fetch(`${base}/c/${seed.coach.handle}/sessions/${nextSessionId}/book?from=${token}`)).text();
      assert.match(form, /value="\+15551112222"/);
      assert.ok(form.includes(`name="from" value="${token}"`));

      const b = await bookOnline(base, seed.coach.handle, nextSessionId, 'Alex', '5551112222', { from: token });
      assert.ok(b.key);
      const checkout = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
      assert.match(checkout, /Use 1 of 2 session credits/);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 303);
    });
    assert.equal(await remaining(db, creditId), 1);
  });
});

test('a manage link proves nothing for a different phone, an unproven booking, or another coach', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    const other = await seedCoachWithSession(db, { capacity: 6 });
    const proven = await provenBooking(db, seed.sessionId, PHONE);
    const unprovenId = await seedBookedSession(db, seed.sessionId, 'Sam', '+15553334444');
    const unproven = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [unprovenId])).rows[0]
      .manage_token;
    const otherCoach = await provenBooking(db, other.sessionId, '+15556667777');
    await createCredit(db, seed.coach.id, '+15559990000', null, 'test', 2, null);
    await createCredit(db, seed.coach.id, '+15553334444', null, 'test', 2, null);
    await createCredit(db, seed.coach.id, '+15556667777', null, 'test', 2, null);

    await withServer(async (base) => {
      const cases: Array<[string, string, string]> = [
        ['a proven link with another number', proven, '5559990000'],
        ['an unproven link with its own number', unproven, '5553334444'],
        ["another coach's proven link", otherCoach, '5556667777'],
      ];
      for (const [label, from, phone] of cases) {
        const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Kid', phone, { from });
        assert.ok(b.key, label);
        const checkout = await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${b.key}`)).text();
        assert.doesNotMatch(checkout, /Use 1 of/, label);
        assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 403, label);
      }
      const form = await (await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book?from=${otherCoach}`)).text();
      assert.doesNotMatch(form, /5556667777|6667777/, "another coach's link fills in nothing");
    });
    const verified = await db.query<{ n: string }>(
      "select count(*)::text as n from booking where status = 'pending' and phone_verified_at is not null",
    );
    assert.equal(verified.rows[0].n, '0');
  });
});
