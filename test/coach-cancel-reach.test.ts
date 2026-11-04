import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { handleCoachMessage } from '../src/domain/assistant.js';
import { createCoachSession } from '../src/domain/auth.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '../src/domain/scheduling.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { segmentCount } from '../src/domain/outbound.js';
import { summarizeMoney } from '../src/domain/money.js';
import type { DbClient } from '../src/db/client.js';

/** A coach's cancel tells the coach how many parents were texted and who
 * could not be reached, so they can be told another way. One parent's text
 * failing never stops the credits and texts for the rest, and a cancel that
 * stopped part way finishes on the next try without texting anyone twice. */

/** A booked athlete whose parent never opted in to texts. */
async function bookWithoutTexts(db: DbClient, sessionId: number, athlete: string, phone: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into booking (session_id, athlete_name, contact_phone, payment_source, status, manage_token)
     values ($1, $2, $3, 'DropIn', 'booked', $4) returning id`,
    [sessionId, athlete, phone, crypto.randomBytes(16).toString('base64url')],
  );
  return r.rows[0].id;
}

async function bookWithCredit(db: DbClient, coachId: number, sessionId: number, athlete: string, phone: string): Promise<number> {
  const bookingId = await seedBookedSession(db, sessionId, athlete, phone);
  const credit = await db.query<{ id: number }>(
    "insert into credit (coach_id, contact_phone, remaining, source) values ($1, $2, 2, 'test') returning id",
    [coachId, phone],
  );
  await db.query("update booking set payment_source = 'PackageCredit', credit_id = $2 where id = $1", [bookingId, credit.rows[0].id]);
  return credit.rows[0].id;
}

async function creditLeft(db: DbClient, creditId: number): Promise<number> {
  return (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId])).rows[0].remaining;
}

test("the coach's cancel says how many parents were texted and lists the ones not reached", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    // The failing parent is first, so everyone after them shows the loop goes on.
    await seedBookedSession(db, seed.sessionId, 'Failing Fran', '+15550000001');
    relay.failSmsTo.add('+15550000001');
    await bookWithoutTexts(db, seed.sessionId, 'Quiet Quinn', '+15550000002');
    const creditA = await bookWithCredit(db, seed.coach.id, seed.sessionId, 'Texted Tess', '+15550000003');
    const creditB = await bookWithCredit(db, seed.coach.id, seed.sessionId, 'Texted Theo', '+15550000004');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;

    await withServer(async (base) => {
      const confirm = await (await fetch(`${base}/app/sessions/${seed.sessionId}/cancel`, { headers: { cookie } })).text();
      assert.match(confirm, /3 athletes will get a text/);
      assert.match(confirm, /1 parent has not opted in to texts/);

      const res = await fetch(`${base}/app/sessions/${seed.sessionId}/cancel`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/app/sessions/${seed.sessionId}`);

      const detail = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
      assert.match(detail, /Texted 2 of 4 parents\. 2 credits returned\./);
      assert.match(detail, /Not reached — please contact them yourself/);
      assert.match(detail, /Failing Fran · <a href="tel:\+15550000001">\+15550000001<\/a> · text failed to send/);
      assert.match(detail, /Quiet Quinn · <a href="tel:\+15550000002">\+15550000002<\/a> · has not opted in to texts/);
      assert.doesNotMatch(detail, /Texted Tess ·|Texted Theo ·/);
    });

    const statuses = await db.query<{ status: string }>('select status from booking where session_id = $1', [seed.sessionId]);
    assert.ok(statuses.rows.every((r) => r.status === 'cancelled'));
    assert.equal(await creditLeft(db, creditA), 3);
    assert.equal(await creditLeft(db, creditB), 3);
    for (const phone of ['+15550000003', '+15550000004']) {
      assert.equal(relay.sms.filter((m) => m.to === phone && /cancelled/.test(m.body)).length, 1, phone);
    }
    assert.equal(relay.sms.filter((m) => m.to === '+15550000002').length, 0);
  });
});

test('a cancel that stopped part way finishes on the next try without texting anyone twice', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    const done = await seedBookedSession(db, seed.sessionId, 'Already Told', '+15550000011');
    const waiting = await seedBookedSession(db, seed.sessionId, 'Not Told Yet', '+15550000012');
    const creditId = await bookWithCredit(db, seed.coach.id, seed.sessionId, 'Still Booked', '+15550000013');
    // As left by a cancel that stopped after cancelling two bookings and texting one.
    await db.query("update session set status = 'cancelled' where id = $1", [seed.sessionId]);
    await db.query("update booking set status = 'cancelled', cancel_notice = 'texted' where id = $1", [done]);
    await db.query("update booking set status = 'cancelled', cancel_notice = 'pending' where id = $1", [waiting]);

    const result = await cancelScheduledSession(db, seed.coach.id, seed.sessionId);
    assert.equal(result.kind, 'cancelled');
    if (result.kind === 'cancelled') {
      assert.deepEqual([result.athletesNotified, result.athletesTotal, result.creditsReturned, result.unreached.length], [3, 3, 1, 0]);
    }
    assert.equal(relay.sms.filter((m) => m.to === '+15550000011').length, 0, 'not texted twice');
    assert.equal(relay.sms.filter((m) => m.to === '+15550000012').length, 1);
    assert.equal(relay.sms.filter((m) => m.to === '+15550000013').length, 1);
    assert.equal(await creditLeft(db, creditId), 3);

    assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'already_cancelled');
    assert.equal(await creditLeft(db, creditId), 3, 'the credit is returned once');
    assert.equal(relay.sms.length, 2);
  });
});

function tomorrowAt(tz: string, hour: number): Date {
  const p = zonedParts(new Date(), tz);
  const d = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedTimeToUtc(d.year, d.month, d.day, hour, 0, tz);
}

test("the assistant's cancel reply says how many were texted and who was not reached", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000021');
    await bookWithoutTexts(db, seed.sessionId, 'Mia Ortiz', '+15550000022');
    setComplete(fakeComplete(new Error('the model must not run')));
    try {
      const ask = await handleCoachMessage(db, seed.coach, "cancel tomorrow's 6pm", 'sms');
      assert.match(ask.text, /\? 2 athletes, 1 can be texted\. Reply Y\.$/);
      assert.doesNotMatch(ask.text, /credits/, 'a drop-in gets no credit back, so none is promised');
      const done = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.match(done.text, /Cancelled\. 1 of 2 athletes texted, 0 credits returned\. Not reached: Mia Ortiz\./);
      assert.ok(done.text.length <= 160);
    } finally {
      resetComplete();
    }
  });
});

test('a cancelled session with nobody booked just says it was cancelled', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const detail = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
      assert.match(detail, /<strong>Cancelled\.<\/strong><\/p>/);
      assert.doesNotMatch(detail, /Texted \d+ of|Not reached/);
    });
  });
});

test("the assistant's cancel question says when every parent will be texted, or that nobody is booked", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
    setComplete(fakeComplete(new Error('the model must not run')));
    try {
      const empty = await handleCoachMessage(db, seed.coach, "cancel tomorrow's 6pm", 'sms');
      assert.match(empty.text, /\? Nobody is booked\. Reply Y\.$/);
      assert.equal((await handleCoachMessage(db, seed.coach, 'N', 'sms')).text, 'Dropped.');

      await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000031');
      await seedBookedSession(db, seed.sessionId, 'Ana Diaz', '+15550000032');
      const all = await handleCoachMessage(db, seed.coach, "cancel tomorrow's 6pm", 'sms');
      assert.match(all.text, /\? 2 athletes, all will be texted\. Reply Y\.$/);
      assert.ok(all.text.length <= 160);
    } finally {
      resetComplete();
    }
  });
});

/** A drop-in booked and paid through the booking form, checkout and a paid event. */
async function payDropIn(base: string, handle: string, sessionId: number, athlete: string, phone: string, paymentId: string): Promise<void> {
  const b = await bookOnline(base, handle, sessionId, athlete, phone);
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, handle, b.key, { mode: 'dropin' });
  const paid = await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId });
  assert.equal(paid.status, 200);
}

test('a paid drop-in becomes one session credit with the coach when the coach cancels, and the text and summary say so', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    const packCredit = await bookWithCredit(db, seed.coach.id, seed.sessionId, 'Pack Pat', '+15550000041');
    await seedBookedSession(db, seed.sessionId, 'Free Fay', '+15550000042');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      await payDropIn(base, seed.coach.handle, seed.sessionId, 'Drop Dana', '5550000043', 'ch_dropin_paid');

      const res = await fetch(`${base}/app/sessions/${seed.sessionId}/cancel`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const detail = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
      assert.match(detail, /Texted 3 of 3 parents\. 2 credits returned, 1 of them for a paid drop-in\./);
    });

    const dropIn = await db.query<{ id: number; remaining: number; source: string; expires_at: string | null; package_id: number | null }>(
      "select id, remaining, source, expires_at, package_id from credit where coach_id = $1 and contact_phone = '+15550000043'",
      [seed.coach.id],
    );
    assert.equal(dropIn.rows.length, 1);
    assert.deepEqual(
      { ...dropIn.rows[0], id: undefined },
      { id: undefined, remaining: 1, source: `cancelled-session:${seed.sessionId}`, expires_at: null, package_id: null },
      'one session, no expiry, as a payment for a cancelled session becomes',
    );
    const booking = await db.query<{ status: string; credit_id: number | null }>(
      "select status, credit_id from booking where contact_phone = '+15550000043'",
    );
    assert.deepEqual(booking.rows[0], { status: 'cancelled', credit_id: dropIn.rows[0].id });
    assert.equal(await creditLeft(db, packCredit), 3, 'the pack credit comes back as before');
    const free = await db.query("select id from credit where contact_phone = '+15550000042'");
    assert.equal(free.rows.length, 0, 'a free drop-in gets no credit');

    const textTo = (phone: string) => relay.sms.filter((m) => m.to === phone && /cancelled/.test(m.body));
    const dropInText = textTo('+15550000043');
    assert.equal(dropInText.length, 1);
    assert.match(dropInText[0].body, /^Coachatron: Goalkeeper Group on .+ is cancelled for Drop Dana\. Your payment is now 1 session credit with Jamie Coach\. Reply STOP to opt out\.$/);
    assert.equal(segmentCount(dropInText[0].body), 1);
    assert.match(textTo('+15550000041')[0].body, /^Coachatron: Goalkeeper Group on .+ is cancelled for Pack Pat\. Your session credit with Jamie Coach is back\. Reply STOP/);
    assert.doesNotMatch(textTo('+15550000042')[0].body, /credit/);

    // The drop-in's payment reached the coach and now stands as credit.
    const start = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0];
    assert.equal((await summarizeMoney(db, seed.coach.id, new Date(start.starts_at_utc))).collectedThisWeekCents, 3500);

    assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'already_cancelled');
    const again = await db.query<{ remaining: number }>("select remaining from credit where contact_phone = '+15550000043'");
    assert.deepEqual(again.rows.map((r) => r.remaining), [1], 'a second run adds no second credit');
  });
});

test('long names still leave the cancel and the whole credit line in one segment', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    await db.query("update coach set name = 'Zoë Montgomery-Fairweather' where id = $1", [seed.coach.id]);
    await withServer(async (base) => {
      await payDropIn(base, seed.coach.handle, seed.sessionId, 'Maximiliana Alexandrina Cortés-Villanueva', '5550000051', 'ch_long_name');
    });
    assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
    const text = relay.sms.filter((m) => m.to === '+15550000051' && /cancelled/.test(m.body)).at(-1);
    assert.ok(text);
    assert.equal(segmentCount(text.body), 1, text.body);
    assert.match(text.body, /^Coachatron: Goalkeeper Group on \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2}[ap]m is cancelled/, 'what, when and the cancel stay whole; the name is shortened');
    assert.match(text.body, /Your payment is now 1 session credit with Zoe Montgomery-Fairweather\. Reply STOP to opt out\.$/);
  });
});

test("the assistant's cancel reply counts a paid drop-in's credit", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
    await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
    await withServer(async (base) => {
      await payDropIn(base, seed.coach.handle, seed.sessionId, 'Drop Dana', '5550000061', 'ch_assistant');
    });
    setComplete(fakeComplete(new Error('the model must not run')));
    try {
      await handleCoachMessage(db, seed.coach, "cancel tomorrow's 6pm", 'sms');
      const done = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.match(done.text, /Cancelled\. 1 of 1 athletes texted, 1 credits returned, 1 of them for a paid drop-in\./);
      assert.ok(done.text.length <= 160);
    } finally {
      resetComplete();
    }
  });
});

/** A paid drop-in whose parent gave an email and did not tick the texts box. */
async function bookEmailOnly(db: DbClient, sessionId: number, athlete: string, phone: string, email: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into booking (session_id, athlete_name, contact_phone, contact_email, payment_source, gross_cents, charge_id, status, manage_token)
     values ($1, $2, $3, $4, 'DropIn', 3500, $5, 'booked', $6) returning id`,
    [sessionId, athlete, phone, email, `ch_${athlete.replace(/\W/g, '')}`, crypto.randomBytes(16).toString('base64url')],
  );
  return r.rows[0].id;
}

test("the coach's cancel emails a parent with no texts who gave an email, and the summary counts them as reached", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await seedBookedSession(db, seed.sessionId, 'Texted Tess', '+15550000061');
    await bookEmailOnly(db, seed.sessionId, 'Emailed Emma', '+15550000062', 'emma.parent@example.com');
    await bookWithoutTexts(db, seed.sessionId, 'Quiet Quinn', '+15550000063');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;

    await withServer(async (base) => {
      const confirm = await (await fetch(`${base}/app/sessions/${seed.sessionId}/cancel`, { headers: { cookie } })).text();
      assert.match(confirm, /2 parents have not opted in to texts; 1 will get an email instead\./);
      await fetch(`${base}/app/sessions/${seed.sessionId}/cancel`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        redirect: 'manual',
      });
      const detail = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
      assert.match(detail, /Texted 1 and emailed 1 of 3 parents\./);
      assert.match(detail, /Quiet Quinn · <a href="tel:\+15550000063">\+15550000063<\/a> · has not opted in to texts/);
      assert.doesNotMatch(detail, /Emailed Emma ·/);
    });

    assert.equal(relay.sms.filter((m) => m.to === '+15550000062').length, 0, 'no text without consent');
    const emails = relay.emails.filter((e) => e.to === 'emma.parent@example.com');
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /^Cancelled: Goalkeeper Group, /);
    assert.match(emails[0].text, /Jamie Coach cancelled Emailed Emma's Goalkeeper Group on .+\. Your payment is now 1 session credit with Jamie Coach, for another session\./);
    assert.match(emails[0].text, /\/booking\/[A-Za-z0-9_-]+/);

    const result = await cancelScheduledSession(db, seed.coach.id, seed.sessionId);
    assert.equal(result.kind, 'already_cancelled');
    assert.equal(relay.emails.filter((e) => e.to === 'emma.parent@example.com').length, 1, 'not emailed twice');
  });
});

test("the assistant's cancel counts emailed parents in its question and its answer", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000071');
    await bookEmailOnly(db, seed.sessionId, 'Mia Ortiz', '+15550000072', 'mia.parent@example.com');
    setComplete(fakeComplete(new Error('the model must not run')));
    try {
      const ask = await handleCoachMessage(db, seed.coach, "cancel tomorrow's 6pm", 'sms');
      assert.match(ask.text, /\? 2 athletes, 1 can be texted, 1 emailed\. Reply Y\.$/);
      const done = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.match(done.text, /^Cancelled\. 1 of 2 athletes texted, 1 emailed, 1 credits returned, 1 of them for a paid drop-in\.$/);
    } finally {
      resetComplete();
    }
  });
});
