import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { checkOverflow, startCascade, upsertOptOut } from '../src/domain/cascade.js';
import { runTick } from '../src/jobs/tick.js';
import type { DbClient } from '../src/db/client.js';

// 10am in Chicago.
const MORNING = new Date('2026-10-20T15:00:00Z');

async function pinSession(db: DbClient, sessionId: number, startsAt: Date): Promise<void> {
  await db.query('update session set starts_at_utc = $1, location_text = $2 where id = $3', [
    startsAt.toISOString(),
    'Field 3',
    sessionId,
  ]);
}

test('tick advances an expired offer to the next roster member, naming the session and pay', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await db.query('update session_type set backup_pay_cents = 8000 where id = $1', [seed.sessionTypeId]);
    const first = await seedRosterMember(db, seed.coach.id, 'First', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Second', 1);
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');

    await checkOverflow(db, seed.sessionId);
    const ask = relay.sms.find((m) => m.to === seed.coach.phone);
    assert.match(ask!.body, /Goalkeeper Group is full, 1 waiting/);

    await startCascade(db, seed.sessionId);
    const offer = relay.sms.find((m) => m.to === first.phone);
    assert.match(offer!.body, /Goalkeeper Group, 1 athletes, pays \$80\. Reply Y/);
    assert.ok(offer!.body.length <= 160);

    await runTick(db, new Date(Date.now() + 21 * 60 * 1000));
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 1);
  });
});

test('tick sends one reminder inside 24 hours, once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await pinSession(db, seed.sessionId, new Date(MORNING.getTime() + 23 * 60 * 60 * 1000));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');

    await runTick(db, MORNING);
    await runTick(db, MORNING);
    const reminders = relay.sms.filter((m) => m.to === '+15550000001');
    assert.equal(reminders.length, 1);
    assert.match(reminders[0].body, /Sam Reyes's Goalkeeper Group is Wed Oct 21, 9:00am at Field 3\./);
    assert.ok(reminders[0].body.length <= 160);
  });
});

test('tick holds reminders in quiet hours, sends at 8am, and skips opted-out numbers', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    // 7am Wednesday; the 24h mark falls at 7am Tuesday, inside quiet hours.
    await pinSession(db, seed.sessionId, new Date('2026-10-21T12:00:00Z'));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');
    await seedBookedSession(db, seed.sessionId, 'Opted Out', '+15550000002');
    await upsertOptOut(db, '+15550000002');

    await runTick(db, new Date('2026-10-20T12:30:00Z')); // 7:30am
    assert.equal(relay.sms.length, 0);

    await runTick(db, new Date('2026-10-20T13:00:00Z')); // 8:00am
    assert.equal(relay.sms.filter((m) => m.to === '+15550000001').length, 1);
    assert.equal(relay.sms.filter((m) => m.to === '+15550000002').length, 0);
  });
});

test('one failing tick step does not stop the others', async () => {
  const db = await freshDb();
  let ran = false;
  const failed = await runTick(db, MORNING, [
    ['boom', async () => {
      throw new Error('boom');
    }],
    ['after', async () => {
      ran = true;
    }],
  ]);
  assert.deepEqual(failed, ['boom']);
  assert.equal(ran, true);
});
