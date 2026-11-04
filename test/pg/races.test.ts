import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from '../helpers/fixtures.js';
import { createPendingBooking } from '../../src/domain/pricing.js';
import { acceptOffer, advanceCascade, checkOverflow, startCascade } from '../../src/domain/cascade.js';
import type { DbClient } from '../../src/db/client.js';

/** Two transactions at the same moment, on real Postgres (TEST_DATABASE_URL;
 * skipped without it). Each test holds the first one still right after a
 * chosen statement, with its locks held, starts the second, waits until the
 * second is waiting on a lock (or has finished without one), and only then
 * lets the first go on. So each interleaving runs the same way every time. */

/** Each test's options: skipped without Postgres, and stopped if a racer
 * never gets where it should, instead of hanging the job. */
const RACE = { skip: skipWithoutPostgres, timeout: 60_000 };

let race: RaceDb | null = null;
const db = (): DbClient => {
  assert.ok(race, 'the race database is set up');
  return race.db;
};

before(async () => {
  if (!skipWithoutPostgres) race = await raceDb();
});
after(async () => {
  await race?.close();
});

test('two parents going for the last spot at once: one holds it, the other is told it is full', RACE, async () => {
  await withRelay(async () => {
    const seed = await seedCoachWithSession(db(), { capacity: 1 });
    const hold = (name: string, phone: string, client: DbClient) =>
      createPendingBooking(client, { sessionId: seed.sessionId, capacity: 1, athleteName: name, contactPhone: phone, contactEmail: null });

    // The first parent has counted the spots and not yet written its hold.
    const first = pauseAfter(db(), (sql) => sql.includes("not (b.status = 'pending' and b.contact_phone = $2)"));
    const a = settle(hold('Ana', '+15550009001', first.db));
    await first.reached;
    const b = settle(hold('Ben', '+15550009002', db()));
    const second = await untilWaitingOrDone(db(), b).finally(first.release);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(second, 'waiting', 'the second waited for the session lock the first held');
    assert.ok(ra.ok && rb.ok, 'neither failed');
    assert.ok(ra.value, 'the first parent holds the spot');
    assert.equal(rb.value, null, 'the second is told the session is full');
    const held = await db().query<{ athlete_name: string }>(
      "select athlete_name from booking where session_id = $1 and status = 'pending' and hold_expires_at > now()",
      [seed.sessionId],
    );
    assert.deepEqual(held.rows.map((r) => r.athlete_name), ['Ana']);
  });
});

test('a roster member accepting while the tick expires their offer: one outcome, never both', RACE, async () => {
  await withRelay(async (relay) => {
    // A full session with someone waiting, and the backup coach asked first.
    const setup = async () => {
      const seed = await seedCoachWithSession(db(), { capacity: 1 });
      const first = await seedRosterMember(db(), seed.coach.id, 'First Backup', 0);
      const second = await seedRosterMember(db(), seed.coach.id, 'Second Backup', 1);
      await seedBookedSession(db(), seed.sessionId, 'Ada Lane', '+15550009101');
      await seedWaitlistEntry(db(), seed.sessionId, 'Bo Lane', '+15550009102');
      await checkOverflow(db(), seed.sessionId);
      await startCascade(db(), seed.sessionId, 'backup');
      const offer = await db().query<{ id: number }>('select id from offer where session_id = $1 and roster_member_id = $2', [
        seed.sessionId,
        first.id,
      ]);
      // Live by the database's clock; the tick below runs an hour later.
      await db().query("update offer set expires_at = now() + interval '1 minute' where id = $1", [offer.rows[0].id]);
      return { seed, first, second, offerId: offer.rows[0].id };
    };
    const offers = async (sessionId: number) =>
      (
        await db().query<{ roster_member_id: number; state: string }>(
          'select roster_member_id, state from offer where session_id = $1 order by id',
          [sessionId],
        )
      ).rows.map((r) => [r.roster_member_id, r.state]);
    const later = new Date(Date.now() + 60 * 60 * 1000);

    // 1. The accept holds the offer's row first: the tick passes it over,
    // and the job is the member's.
    {
      const { seed, first, second, offerId } = await setup();
      const accepting = pauseAfter(db(), (sql) => /from offer where id = \$1 for update/.test(sql));
      const accepted = settle(acceptOffer(accepting.db, offerId));
      await accepting.reached;
      const tick = settle(advanceCascade(db(), later));
      await untilWaitingOrDone(db(), tick).finally(accepting.release);
      const [ra, rt] = await Promise.all([accepted, tick]);
      assert.ok(ra.ok && rt.ok, 'neither failed');
      assert.equal(ra.value, true, 'the member took the job');
      assert.deepEqual(await offers(seed.sessionId), [[first.id, 'accepted']], 'nobody else was offered it');
      assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 0, 'the next member was not texted');
    }

    // 2. The tick expires the offer while the accept waits for it: the
    // accept finds it expired and takes nothing, and the next member is
    // offered the job once.
    {
      const { seed, first, second, offerId } = await setup();
      const accepting = pauseAfter(db(), (sql) => /from overflow_ask where id = \$1 for update/.test(sql));
      const accepted = settle(acceptOffer(accepting.db, offerId));
      await accepting.reached;
      const tick = settle(advanceCascade(db(), later));
      const ticked = await untilWaitingOrDone(db(), tick).finally(accepting.release);
      const [ra, rt] = await Promise.all([accepted, tick]);
      assert.equal(ticked, 'waiting', 'the tick waited for the ask the accept held');
      assert.ok(ra.ok && rt.ok, 'neither failed');
      assert.equal(ra.value, false, 'the expired offer was not taken');
      assert.deepEqual(await offers(seed.sessionId), [
        [first.id, 'expired'],
        [second.id, 'sent'],
      ]);
      const session = await db().query<{ assigned_roster_member_id: number | null }>(
        'select assigned_roster_member_id from session where id = $1',
        [seed.sessionId],
      );
      assert.equal(session.rows[0].assigned_roster_member_id, null, 'nobody joined the session');
      assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 1, 'the next member was texted once');
    }
  });
});
