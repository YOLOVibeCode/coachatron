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
      assert.match(ask.text, /Reply Y/);
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
