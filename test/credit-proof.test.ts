import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, latestBooking, postCheckout } from './helpers/booking.js';
import { createCredit } from '../src/domain/pricing.js';
import { SIGNIN_CODE_LIMITS, takeRequest } from '../src/domain/requestLimits.js';
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

async function codesStored(db: DbClient, phone: string): Promise<number> {
  return Number((await db.query<{ n: string }>('select count(*)::text as n from otp_code where phone = $1', [phone])).rows[0].n);
}

test('a checkout code is stored only once its text has gone out', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);

      relay.limited.sms = true;
      const busy = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
      assert.equal(busy.status, 429);
      assert.match(await busy.text(), /send codes right now/);
      assert.equal(await codesStored(db, PHONE), 0, 'a text the relay held back leaves no code');
      relay.limited.sms = false;

      for (let i = 0; i < 5; i += 1) {
        assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' })).status, 200, `code ${i + 1}`);
      }
      const capped = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
      assert.equal(capped.status, 429);
      assert.match(await capped.text(), /Too many codes for this number today/);
      assert.equal(await codesStored(db, PHONE), 5, 'the request over the daily limit stores no code');
    });
    assert.equal(relay.sms.filter((m) => m.to === PHONE).length, 5);
  });
});

test('wrong checkout codes count toward the code’s limit of tries', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    const creditId = await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
      const code = lastCode(relay.sms, PHONE);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 4; i += 1) {
        const tried = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: wrong });
        assert.equal(tried.status, 401, `wrong try ${i + 1}`);
        assert.match(await tried.text(), /didn&#39;t work|didn't work/);
      }
      const fifth = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: wrong });
      assert.equal(fifth.status, 401);
      assert.match(await fifth.text(), /too many wrong tries/);

      const right = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code });
      assert.equal(right.status, 401, 'the right code no longer works');
      const page = await right.text();
      assert.match(page, /too many wrong tries/);
      assert.match(page, /Text me a code/, 'the page offers a new code');
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 403);

      await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
      const fresh = lastCode(relay.sms, PHONE);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: fresh })).status, 303, 'a new code works');
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 303);
    });
    assert.equal(await remaining(db, creditId), 2);
  });
});

test('one code sent to two checkouts at once proves only one of them', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    const other = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       select session_type_id, starts_at_utc + interval '1 day', tz, 'scheduled' from session where id = $1 returning id`,
      [seed.sessionId],
    );
    await withServer(async (base) => {
      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      const second = await bookOnline(base, seed.coach.handle, other.rows[0].id, 'Sam', '5551112222');
      assert.ok(first.key && second.key);
      await postCheckout(base, seed.coach.handle, first.key, { mode: 'send_code' });
      const code = lastCode(relay.sms, PHONE);
      const results = await Promise.all([
        postCheckout(base, seed.coach.handle, first.key, { mode: 'verify_code', code }),
        postCheckout(base, seed.coach.handle, second.key, { mode: 'verify_code', code }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [303, 401]);
    });
    const proven = await db.query<{ n: string }>('select count(*)::text as n from booking where phone_verified_at is not null');
    assert.equal(proven.rows[0].n, '1');
  });
});

test('checkout code requests from one address are limited like sign-in code requests', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    for (let i = 0; i < 10; i += 1) await takeRequest(db, SIGNIN_CODE_LIMITS, '203.0.113.70');
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const held = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' }, { 'x-forwarded-for': '203.0.113.70' });
      assert.equal(held.status, 429);
      assert.match(await held.text(), /Too many codes asked for from here/);
      assert.equal(relay.sms.filter((m) => m.to === PHONE).length, 0);
      assert.equal(await codesStored(db, PHONE), 0);

      const elsewhere = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' }, { 'x-forwarded-for': '203.0.113.71' });
      assert.equal(elsewhere.status, 200, 'another address is not held back');
    });
  });
});

function form(base: string, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

test('a checkout code is not a sign-in code, and asking for one leaves a live sign-in code working', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await createCredit(db, seed.coach.id, PHONE, null, 'test', 3, null);
    await withServer(async (base) => {
      // A sign-in code for the number, then a checkout code for the same number.
      assert.equal((await form(base, '/signin/otp', { contact: '5551112222' })).status, 303);
      const signInCode = lastCode(relay.sms, PHONE);
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' })).status, 200);
      const creditCode = lastCode(relay.sms, PHONE);
      assert.notEqual(creditCode, signInCode);

      const withCreditCode = await form(base, '/signin/verify', { to: PHONE, code: creditCode, name: 'Pat' });
      assert.equal(withCreditCode.status, 401, 'the checkout code does not sign in');
      const withSignInCode = await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: signInCode });
      assert.equal(withSignInCode.status, 401, 'the sign-in code does not unlock credits');

      const signedIn = await form(base, '/signin/verify', { to: PHONE, code: signInCode, name: 'Pat' });
      assert.equal(signedIn.status, 303, 'the sign-in code still works');
      assert.match(signedIn.headers.get('set-cookie') ?? '', /cx_session=/);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'verify_code', code: creditCode })).status, 303);
    });
  });
});

test('the stand-in email on a buy link carries no phone digits and stays the same for one checkout', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3 });
    await withServer(async (base) => {
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551112222');
      assert.ok(b.key);
      const emails: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
        assert.equal(pay.status, 303);
        emails.push(new URL(pay.headers.get('location') ?? '', 'http://relay.test').searchParams.get('email') ?? '');
      }
      assert.match(emails[0], /^b-[0-9a-f]{20}@book\.coachatron\.test$/);
      assert.equal(emails[1], emails[0]);
      for (const leak of ['5551112222', b.key]) assert.ok(!emails[0].includes(leak), leak);
    });
  });
});
