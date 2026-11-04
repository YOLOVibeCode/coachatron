import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from '../helpers/fixtures.js';
import { createPendingBooking, newBookingToken } from '../../src/domain/pricing.js';
import { acceptOffer, advanceCascade, checkOverflow, startCascade } from '../../src/domain/cascade.js';
import { moveByParent } from '../../src/domain/moveBooking.js';
import { applyRefunded } from '../../src/domain/refunds.js';
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

async function sessionAt(typeId: number, hours: number, capacity: number | null = null): Promise<number> {
  const r = await db().query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status, capacity_override)
     values ($1, now() + make_interval(mins => $2::int), 'America/Chicago', 'scheduled', $3) returning id`,
    [typeId, Math.round(hours * 60), capacity],
  );
  return r.rows[0].id;
}

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

test('a refund reported while a parent moves the booking is applied to the booking where it is now', RACE, async () => {
  await withRelay(async () => {
    const seed = await seedCoachWithSession(db(), { capacity: 4 });
    await db().query("update session set starts_at_utc = now() + interval '72 hours' where id = $1", [seed.sessionId]);
    const to = await sessionAt(seed.sessionTypeId, 96);
    const bookingId = await seedBookedSession(db(), seed.sessionId, 'Cleo Park', '+15550009201');
    const token = newBookingToken();
    const charge = `ch_race_${Date.now()}`;
    await db().query('update booking set gross_cents = 3500, charge_id = $2, manage_token = $3 where id = $1', [bookingId, charge, token]);
    // The coach's refund from the app did not go through, which leaves the
    // booking free to move. The payment is then refunded another way (the
    // payment provider's dashboard, say) and the relay reports it.
    await db().query("insert into refund (coach_id, payment_ref, booking_id, amount_cents, status) values ($1, $2, $3, 3500, 'failed')", [
      seed.coach.id,
      charge,
      bookingId,
    ]);

    // The move has changed the booking's session and not yet committed when
    // the report arrives.
    const moving = pauseAfter(db(), (sql) => sql.startsWith('update booking set session_id'));
    const moved = settle(moveByParent(moving.db, token, to));
    await moving.reached;
    const refund = settle(applyRefunded(db(), { paymentRef: charge, refundRef: 're_race_1', amountCents: 3500, sellerKey: null }));
    const refunding = await untilWaitingOrDone(db(), refund).finally(moving.release);
    const [rm, rr] = await Promise.all([moved, refund]);
    assert.equal(refunding, 'waiting', 'the refund waited for the booking the move held');
    assert.ok(rm.ok && rr.ok, 'neither failed');
    assert.equal(rm.value.kind, 'moved');
    assert.equal(rr.value, 'refunded');

    const booking = await db().query<{ session_id: number; status: string }>('select session_id, status from booking where id = $1', [
      bookingId,
    ]);
    assert.deepEqual(booking.rows[0], { session_id: to, status: 'refunded' }, 'refunded in the session it moved to');
    const row = await db().query<{ status: string; booking_id: number; spot_released: boolean }>(
      'select status, booking_id, spot_released from refund where payment_ref = $1',
      [charge],
    );
    assert.deepEqual(row.rows[0], { status: 'refunded', booking_id: bookingId, spot_released: true });
  });
});
