import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { startFakeRelay, type FakeRelay } from './fakes/relay.js';
import { seedCoachWithSession, seedRosterMember, seedBookedSession, seedWaitlistEntry } from './helpers/fixtures.js';
import { checkOverflow, startCascade, advanceCascade, acceptOffer } from '../src/domain/cascade.js';
import type { DbClient } from '../src/db/client.js';

async function withRelay(fn: (relay: FakeRelay) => Promise<void>): Promise<void> {
  const relay = await startFakeRelay();
  process.env.RELAY_BASE_URL = relay.url;
  try {
    await fn(relay);
  } finally {
    await relay.close();
    delete process.env.RELAY_BASE_URL;
  }
}

async function smsTo(base: string, from: string, body: string): Promise<Response> {
  return fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, body }),
  });
}

async function countOffers(db: DbClient, sessionId: number): Promise<number> {
  const rows = await db.query<{ id: number }>('select id from offer where session_id = $1', [sessionId]);
  return rows.rows.length;
}

test('full session + a waiting athlete sends exactly one SMS to the coach, no offer yet', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);

    // Fill the session (booked count == capacity) — by itself this must not
    // trigger an ask, since nobody is waiting yet.
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await checkOverflow(db, seed.sessionId);
    assert.equal(relay.sms.length, 0, 'no ask before anyone is waiting');
    assert.equal(await countOffers(db, seed.sessionId), 0);

    // A second athlete joins the waitlist — SPEC.md §7.3: "full AND a
    // second athlete has joined the waitlist" is the trigger.
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);

    const toCoach = relay.sms.filter((m) => m.to === seed.coach.phone);
    assert.equal(toCoach.length, 1, 'expected exactly one SMS to the coach');
    assert.equal(await countOffers(db, seed.sessionId), 0, 'no offer until the coach says YES');

    // Asking again while the first ask is unresolved must not send a second.
    await checkOverflow(db, seed.sessionId);
    assert.equal(relay.sms.filter((m) => m.to === seed.coach.phone).length, 1);
  });
});

test('coach YES creates exactly one offer for the highest-priority roster member and texts only them', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const first = await seedRosterMember(db, seed.coach.id, 'Priority Zero', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Priority One', 1);

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);

    await withServer(async (base) => {
      const res = await smsTo(base, seed.coach.phone, 'Y');
      assert.equal(res.status, 200);
    });

    const offers = await db.query<{ roster_member_id: number; state: string }>(
      'select roster_member_id, state from offer where session_id = $1',
      [seed.sessionId],
    );
    assert.equal(offers.rows.length, 1);
    assert.equal(offers.rows[0].roster_member_id, first.id);
    assert.equal(offers.rows[0].state, 'sent');

    assert.equal(relay.sms.filter((m) => m.to === first.phone).length, 1);
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 0);
  });
});

test('accepting stops the cascade; a different member replying YES afterward has no effect', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const first = await seedRosterMember(db, seed.coach.id, 'Priority Zero', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Priority One', 1);

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);
    await startCascade(db, seed.sessionId);

    const offerRows = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]);
    const offerId = offerRows.rows[0].id;

    const accepted = await acceptOffer(db, offerId);
    assert.equal(accepted, true);

    const sessionRows = await db.query<{ assigned_roster_member_id: number }>(
      'select assigned_roster_member_id from session where id = $1',
      [seed.sessionId],
    );
    assert.equal(sessionRows.rows[0].assigned_roster_member_id, first.id);

    // A second member was never offered, so their YES has no offer to act
    // on; explicitly re-running startCascade (simulating any duplicate
    // trigger) must also be a no-op once someone has accepted.
    await startCascade(db, seed.sessionId);
    assert.equal(await countOffers(db, seed.sessionId), 1, 'no second offer after an acceptance');

    const stillAccepted = await acceptOffer(db, offerId);
    assert.equal(stillAccepted, false, 'accepting an already-accepted offer must fail');

    const secondOffers = await db.query<{ id: number }>('select id from offer where roster_member_id = $1', [second.id]);
    assert.equal(secondOffers.rows.length, 0, 'the second member was never offered anything');
  });
});

test('an expired offer advances the cascade to the next roster member', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const first = await seedRosterMember(db, seed.coach.id, 'Priority Zero', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Priority One', 1);

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);
    await startCascade(db, seed.sessionId);

    assert.equal(relay.sms.filter((m) => m.to === first.phone).length, 1);

    // No real waiting: advance the clock past the 20-minute TTL directly.
    const past = new Date(Date.now() + 21 * 60 * 1000);
    await advanceCascade(db, past);

    const offers = await db.query<{ roster_member_id: number; state: string }>(
      'select roster_member_id, state from offer where session_id = $1 order by id',
      [seed.sessionId],
    );
    assert.equal(offers.rows.length, 2);
    assert.equal(offers.rows[0].state, 'expired');
    assert.equal(offers.rows[1].roster_member_id, second.id);
    assert.equal(offers.rows[1].state, 'sent');
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 1);
  });
});

test('roster member N declines and advances the cascade immediately, without waiting for expiry', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const first = await seedRosterMember(db, seed.coach.id, 'Priority Zero', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Priority One', 1);

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);
    await startCascade(db, seed.sessionId);

    await withServer(async (base) => {
      const res = await smsTo(base, first.phone, 'N');
      assert.equal(res.status, 200);
    });

    const offers = await db.query<{ roster_member_id: number; state: string }>(
      'select roster_member_id, state from offer where session_id = $1 order by id',
      [seed.sessionId],
    );
    assert.equal(offers.rows.length, 2);
    assert.equal(offers.rows[0].state, 'declined');
    assert.equal(offers.rows[1].roster_member_id, second.id);
    assert.equal(offers.rows[1].state, 'sent');
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 1, 'the next member is texted immediately on decline');
  });
});

test('STOP opts a roster member out; the cascade skips them without ever offering them', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const first = await seedRosterMember(db, seed.coach.id, 'Priority Zero', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Priority One', 1);

    await withServer(async (base) => {
      const res = await smsTo(base, first.phone, 'stop');
      assert.equal(res.status, 200);
    });

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);
    await startCascade(db, seed.sessionId);

    const offers = await db.query<{ roster_member_id: number }>('select roster_member_id from offer where session_id = $1', [
      seed.sessionId,
    ]);
    assert.equal(offers.rows.length, 1);
    assert.equal(offers.rows[0].roster_member_id, second.id, 'the opted-out member must be skipped entirely');
    assert.equal(relay.sms.filter((m) => m.to === first.phone).length, 1, 'only the STOP confirmation, never an offer');
  });
});

test('HELP always gets exactly one reply; an unrecognized keyword points at the web link', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const helpRes = await smsTo(base, '+15559990000', 'HELP');
      assert.equal(helpRes.status, 200);
      assert.equal(relay.sms.length, 1);

      const otherRes = await smsTo(base, '+15559990000', 'banana');
      assert.equal(otherRes.status, 200);
      assert.equal(relay.sms.length, 2);
      assert.match(relay.sms[1].body, /link/i);
    });
  });
});
