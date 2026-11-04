import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { bookOnline, expireHolds } from './helpers/booking.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember } from './helpers/fixtures.js';
import { acceptOffer, answerAsk, checkOverflow } from '../src/domain/cascade.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { runTick } from '../src/jobs/tick.js';
import type { DbClient } from '../src/db/client.js';
import { zoneAt } from './helpers/clock.js';

/** Spots that open go to the waitlist in the order people joined: a text
 * when they chose texts, an email otherwise, each with a link that holds
 * the spot for 15 minutes, and a spot nobody claims goes to the next. */

interface Waiter {
  name: string;
  phone: string;
  texts?: boolean;
  email?: string | null;
}

async function join(db: DbClient, sessionId: number, w: Waiter): Promise<void> {
  if (w.texts) await grantSmsConsent(db, w.phone);
  await db.query('insert into waitlist (session_id, contact_phone, athlete_name, contact_email) values ($1, $2, $3, $4)', [
    sessionId,
    w.phone,
    w.name,
    w.email ?? null,
  ]);
  // Join order is the order of created_at.
  await new Promise((r) => setTimeout(r, 5));
}

async function fullWithLine(db: DbClient, waiters: Waiter[], opts: { capacity?: number; coachHour?: number } = {}) {
  const capacity = opts.capacity ?? 2;
  const seed = await seedCoachWithSession(db, { capacity });
  await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(opts.coachHour ?? 12)]);
  for (let i = 0; i < capacity; i += 1) await seedBookedSession(db, seed.sessionId, `Booked ${i + 1}`, `+1555000020${i}`);
  for (const w of waiters) await join(db, seed.sessionId, w);
  const member = await seedRosterMember(db, seed.coach.id, 'Bailey Backup', 0);
  await checkOverflow(db, seed.sessionId);
  return { seed, member };
}

async function acceptFirstOffer(db: DbClient, sessionId: number): Promise<void> {
  const r = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'sent'", [sessionId]);
  assert.equal(await acceptOffer(db, r.rows[0].id), true);
}

async function line(db: DbClient, sessionId: number) {
  const r = await db.query<{ athlete_name: string; state: string; offer_booking_id: number | null }>(
    'select athlete_name, state, offer_booking_id from waitlist where session_id = $1 order by created_at, id',
    [sessionId],
  );
  return r.rows.map((w) => [w.athlete_name, w.state]);
}

const ANN = { name: 'Ann First', phone: '+15550003001', texts: true };
const BEN = { name: 'Ben Second', phone: '+15550003002', email: 'ben@example.com' };
const CAL = { name: 'Cal Third', phone: '+15550003003', texts: true };

test('a backup coach opens spots for the waitlist in order, by text or by email', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed } = await fullWithLine(db, [ANN, BEN, CAL]);
    await answerAsk(db, seed.coach.id, 'backup');
    await acceptFirstOffer(db, seed.sessionId);

    assert.deepEqual(await line(db, seed.sessionId), [
      ['Ann First', 'offered'],
      ['Ben Second', 'offered'],
      ['Cal Third', 'waiting'],
    ]);
    const annText = relay.sms.find((m) => m.to === ANN.phone);
    assert.ok(annText, 'Ann chose texts');
    assert.match(annText.body, /^Coachatron: a spot opened, held 15 min for Ann First: .* http\S+\/c\/[^/]+\/checkout\/[A-Za-z0-9_-]+ /);
    assert.ok(annText.body.length <= 160);
    const benMail = relay.emails.find((e) => e.to === 'ben@example.com');
    assert.ok(benMail, 'Ben gave an email');
    assert.match(benMail.subject, /A spot opened: Goalkeeper Group/);
    assert.match(benMail.text, /holding it for 15 minutes/);
    assert.equal(relay.sms.filter((m) => m.to === BEN.phone).length, 0);
    assert.equal(relay.sms.filter((m) => m.to === CAL.phone).length, 0, 'only as many as there are spots');

    const told = relay.sms.find((m) => m.to === seed.coach.phone && /is your backup coach/.test(m.body));
    assert.match(told!.body, /2 waitlisted parents were offered a spot\./);

    const holds = await db.query<{ status: string; minutes: number }>(
      `select status, round(extract(epoch from (hold_expires_at - now())) / 60)::int as minutes
       from booking where session_id = $1 and status = 'pending'`,
      [seed.sessionId],
    );
    assert.equal(holds.rows.length, 2);
    for (const h of holds.rows) assert.ok(h.minutes >= 14 && h.minutes <= 15, `held about 15 minutes, got ${h.minutes}`);

    await withServer(async (base) => {
      const link = /\/c\/[^/]+\/checkout\/[A-Za-z0-9_-]+/.exec(annText.body)![0];
      const checkout = await fetch(`${base}${link}`);
      assert.equal(checkout.status, 200);
      assert.match(await checkout.text(), /Pay \$35\.00/);
      const page = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(page, /Full/, 'the held spots and the one still waiting fill it');
      const walkIn = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Walk In', '+15550003999');
      assert.equal(walkIn.status, 409, 'nobody jumps the line');
    });
  });
});

test('a second group draws from the full session’s waitlist', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed } = await fullWithLine(db, [ANN, CAL], { capacity: 1 });
    await answerAsk(db, seed.coach.id, 'second_group');
    await acceptFirstOffer(db, seed.sessionId);
    const group = await db.query<{ id: number }>('select id from session where overflow_of = $1', [seed.sessionId]);
    const groupId = group.rows[0].id;
    const held = await db.query<{ session_id: number; athlete_name: string }>(
      "select session_id, athlete_name from booking where status = 'pending' order by id",
    );
    assert.deepEqual(held.rows.map((b) => [b.session_id, b.athlete_name]), [[groupId, 'Ann First']]);
    assert.ok(relay.sms.some((m) => m.to === ANN.phone && /spot opened/.test(m.body)));
    assert.ok(relay.sms.some((m) => m.to === seed.coach.phone && /took the second group\. 1 waitlisted parent was offered a spot\./.test(m.body)));
  });
});

test('a spot nobody claims in time goes to the next person waiting', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed } = await fullWithLine(db, [ANN, CAL], { capacity: 1 });
    await answerAsk(db, seed.coach.id, 'second_group');
    await acceptFirstOffer(db, seed.sessionId);
    const groupId = (await db.query<{ id: number }>('select id from session where overflow_of = $1', [seed.sessionId])).rows[0].id;

    await runTick(db, new Date());
    assert.equal(relay.sms.filter((m) => m.to === CAL.phone).length, 0, 'not while the hold stands');

    await expireHolds(db, groupId);
    await runTick(db, new Date());
    assert.deepEqual(await line(db, seed.sessionId), [
      ['Ann First', 'lapsed'],
      ['Cal Third', 'offered'],
    ]);
    assert.equal(relay.sms.filter((m) => m.to === CAL.phone && /spot opened/.test(m.body)).length, 1);
    assert.equal(relay.sms.filter((m) => m.to === ANN.phone).length, 1, 'Ann is not asked again');
  });
});

test('a spot that was booked from its link stays booked, and nobody else is offered it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed } = await fullWithLine(db, [ANN, CAL], { capacity: 1 });
    await answerAsk(db, seed.coach.id, 'second_group');
    await acceptFirstOffer(db, seed.sessionId);
    await db.query("update booking set status = 'booked', payment_source = 'DropIn' where status = 'pending' and athlete_name = 'Ann First'");
    await expireHolds(db, seed.sessionId);
    await runTick(db, new Date());
    assert.deepEqual(await line(db, seed.sessionId), [
      ['Ann First', 'booked'],
      ['Cal Third', 'waiting'],
    ]);
    assert.equal(relay.sms.filter((m) => m.to === CAL.phone).length, 0);
  });
});

test('someone who can be reached neither by text nor email is passed over', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const silent = { name: 'No Contact', phone: '+15550003004' };
    const { seed } = await fullWithLine(db, [silent, CAL], { capacity: 1 });
    await answerAsk(db, seed.coach.id, 'second_group');
    await acceptFirstOffer(db, seed.sessionId);
    assert.deepEqual(await line(db, seed.sessionId), [
      ['No Contact', 'unreachable'],
      ['Cal Third', 'offered'],
    ]);
    assert.equal(relay.sms.filter((m) => m.to === silent.phone).length, 0);
  });
});

test("a parent's cancel hands their spot to the first person waiting", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
    const bookingId = await seedBookedSession(db, seed.sessionId, 'Booked One', '+15550000201');
    await join(db, seed.sessionId, ANN);
    const token = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0]
      .manage_token;
    await withServer(async (base) => {
      const res = await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' });
      assert.equal(res.status, 303);
    });
    assert.deepEqual(await line(db, seed.sessionId), [['Ann First', 'offered']]);
    assert.ok(relay.sms.some((m) => m.to === ANN.phone && /spot opened/.test(m.body)));
  });
});

test('in quiet hours the spots wait for the morning, kept for the line, and the coach is told so', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed } = await fullWithLine(db, [ANN], { capacity: 2, coachHour: 2 });
    await answerAsk(db, seed.coach.id, 'backup');
    await acceptFirstOffer(db, seed.sessionId);
    assert.deepEqual(await line(db, seed.sessionId), [['Ann First', 'waiting']]);
    assert.equal(relay.sms.filter((m) => m.to === ANN.phone).length, 0, 'no text at 2am');
    assert.ok(relay.sms.some((m) => m.to === seed.coach.phone && /offered the spots from 8am/.test(m.body)));

    await withServer(async (base) => {
      const walkIn = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Walk In', '+15550003999');
      assert.equal(walkIn.status, 303, 'the other new spot can be booked');
      const second = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Late Walk In', '+15550003998');
      assert.equal(second.status, 409, "Ann's spot is kept for her");
    });

    await runTick(db, new Date(Date.now() + 8 * 60 * 60 * 1000));
    assert.deepEqual(await line(db, seed.sessionId), [['Ann First', 'offered']]);
    assert.equal(relay.sms.filter((m) => m.to === ANN.phone && /spot opened/.test(m.body)).length, 1);
  });
});

test('the waitlist page promises what will happen, and keeps the email for it', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await seedBookedSession(db, seed.sessionId, 'Booked One', '+15550000201');
    await withServer(async (base) => {
      const joinOnline = async (fields: Record<string, string>) =>
        (
          await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields),
          })
        ).text();
      const texts = await joinOnline({ athlete_name: 'Tex', contact_phone: '(555) 000-4001', sms_consent: '1' });
      assert.match(texts, /We(?:'|&#39;)ll text \+15550004001 if a spot opens, and hold it for you for 15 minutes\./);
      const mail = await joinOnline({ athlete_name: 'Em', contact_phone: '(555) 000-4002', contact_email: 'em@example.com' });
      assert.match(mail, /We(?:'|&#39;)ll email em@example\.com if a spot opens, and hold it for you for 15 minutes\./);
      const neither = await joinOnline({ athlete_name: 'Nell', contact_phone: '(555) 000-4003' });
      assert.match(neither, /You didn(?:'|&#39;)t choose texts or give an email, so check back/);

      const full = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Late', '+15550004004');
      assert.equal(full.status, 409);
    });
    const stored = await db.query<{ contact_email: string | null }>('select contact_email from waitlist order by id');
    assert.deepEqual(stored.rows.map((r) => r.contact_email), [null, 'em@example.com', null]);
  });
});
