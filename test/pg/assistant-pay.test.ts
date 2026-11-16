import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { seedCoachWithSession, seedRosterMember } from '../helpers/fixtures.js';
import { acceptOffer, startCascade } from '../../src/domain/cascade.js';
import { listAssistantPay, markAllPaid, markPaid, owedToAssistantsCents, setPayAmount, summarizeAssistantPay, undoPaid } from '../../src/domain/assistantPay.js';
import { inTransaction, type DbClient } from '../../src/db/client.js';

/** Assistant pay with two requests at the same moment, on real Postgres
 * (TEST_DATABASE_URL; skipped without it). As in races.test.ts, the first
 * is held right after a chosen statement, with its locks, until the second
 * is waiting on a lock or has finished. */

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

interface Pay {
  id: number;
  amount_cents: number | null;
  paid_at: string | Date | null;
  paid_note: string | null;
}

async function payRows(coachId: number): Promise<Pay[]> {
  return (await db().query<Pay>('select id, amount_cents, paid_at, paid_note from assistant_pay where coach_id = $1 order by id', [coachId])).rows;
}

/** A coach whose backup coach pays $80, with the offer out to one person. */
async function offerOut() {
  const seed = await seedCoachWithSession(db(), { capacity: 2 });
  await db().query('update session_type set backup_pay_cents = 8000 where id = $1', [seed.sessionTypeId]);
  const member = await seedRosterMember(db(), seed.coach.id, 'Sam Lee', 0);
  await startCascade(db(), seed.sessionId, 'backup');
  const offer = await db().query<{ id: number }>("select id from offer where session_id = $1 and state = 'sent'", [seed.sessionId]);
  return { seed, member, offerId: offer.rows[0].id };
}

/** The same, accepted, with the session's start now in the past: owed. */
async function owedSession() {
  const out = await offerOut();
  assert.equal(await acceptOffer(db(), out.offerId), true);
  await db().query("update session set starts_at_utc = now() - interval '2 hours' where id = $1", [out.seed.sessionId]);
  const [row] = await payRows(out.seed.coach.id);
  return { ...out, payId: row.id };
}

test('the totals, the list and each change read the same on Postgres', RACE, async () => {
  await withRelay(async () => {
    const { seed, member, payId } = await owedSession();
    const coachId = seed.coach.id;
    const summary = async () => {
      const [s] = await summarizeAssistantPay(db(), coachId);
      return { coached: s.coached, owed: s.owedCents, paid: s.paidCents, owedCount: s.owedCount };
    };
    assert.deepEqual(await summary(), { coached: 1, owed: 8000, paid: 0, owedCount: 1 });
    assert.equal(await owedToAssistantsCents(db(), coachId), 8000);
    assert.deepEqual((await listAssistantPay(db(), coachId, member.id)).map((r) => [r.id, r.state, r.kind, r.amountCents]), [[payId, 'owed', 'backup', 8000]]);
    assert.equal(await markAllPaid(db(), coachId, member.id, 'Venmo'), 1);
    assert.deepEqual(await summary(), { coached: 1, owed: 0, paid: 8000, owedCount: 0 });
    assert.equal((await listAssistantPay(db(), coachId, member.id))[0].paidNote, 'Venmo');
    assert.equal((await undoPaid(db(), coachId, payId)).kind, 'ok');
    assert.equal(await owedToAssistantsCents(db(), coachId), 8000);
  });
});

test('the same acceptance arriving twice at once writes one pay row', RACE, async () => {
  await withRelay(async () => {
    const { seed, offerId } = await offerOut();
    // The first has written its pay row and not yet finished.
    const first = pauseAfter(db(), (sql) => sql.includes('insert into assistant_pay'));
    const a = settle(acceptOffer(first.db, offerId));
    await first.reached;
    const b = settle(acceptOffer(db(), offerId));
    const second = await untilWaitingOrDone(db(), b).finally(first.release);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(second, 'waiting', 'the second waited for what the first held');
    assert.ok(ra.ok && rb.ok, 'neither failed');
    assert.deepEqual([ra.value, rb.value], [true, false], 'the job was taken once');
    const rows = await payRows(seed.coach.id);
    assert.deepEqual(rows.map((r) => r.amount_cents), [8000]);
  });
});

test('an amount changed while the session is being marked paid: what was paid stands', RACE, async () => {
  await withRelay(async () => {
    const { seed, payId } = await owedSession();
    // The payment is marked and not yet committed.
    const paying = pauseAfter(db(), (sql) => sql.includes('set paid_at = $3'));
    const paid = settle(inTransaction(paying.db, (tx) => markPaid(tx, seed.coach.id, payId, 'Venmo')));
    await paying.reached;
    const change = settle(setPayAmount(db(), seed.coach.id, payId, 2500));
    const second = await untilWaitingOrDone(db(), change).finally(paying.release);
    const [rp, rc] = await Promise.all([paid, change]);
    assert.equal(second, 'waiting', "the amount change waited for the row's lock");
    assert.ok(rp.ok && rc.ok, 'neither failed');
    assert.equal(rp.value.kind, 'ok');
    assert.deepEqual(rc.value.kind === 'refused' ? rc.value.state : rc.value.kind, 'paid', 'the change was refused: the session is paid');
    const [row] = await payRows(seed.coach.id);
    assert.deepEqual([row.amount_cents, row.paid_note], [8000, 'Venmo']);
    assert.notEqual(row.paid_at, null);
  });
});

test('a session marked paid while its amount is being changed is paid at the new amount', RACE, async () => {
  await withRelay(async () => {
    const { seed, payId } = await owedSession();
    const changing = pauseAfter(db(), (sql) => sql.includes('set amount_cents = $3'));
    const change = settle(inTransaction(changing.db, (tx) => setPayAmount(tx, seed.coach.id, payId, 2500)));
    await changing.reached;
    const paid = settle(markPaid(db(), seed.coach.id, payId, 'Cash'));
    const second = await untilWaitingOrDone(db(), paid).finally(changing.release);
    const [rc, rp] = await Promise.all([change, paid]);
    assert.equal(second, 'waiting', "the payment waited for the row's lock");
    assert.ok(rc.ok && rp.ok, 'neither failed');
    assert.deepEqual([rc.value.kind, rp.value.kind], ['ok', 'ok']);
    const [row] = await payRows(seed.coach.id);
    assert.deepEqual([row.amount_cents, row.paid_note], [2500, 'Cash']);
    assert.notEqual(row.paid_at, null);
  });
});

test('two requests marking the same session paid at once: the first one\'s date and note stand', RACE, async () => {
  await withRelay(async () => {
    const { seed, payId } = await owedSession();
    const paying = pauseAfter(db(), (sql) => sql.includes('set paid_at = $3'));
    const first = settle(inTransaction(paying.db, (tx) => markPaid(tx, seed.coach.id, payId, 'Venmo')));
    await paying.reached;
    const again = settle(markPaid(db(), seed.coach.id, payId, 'Cash'));
    const second = await untilWaitingOrDone(db(), again).finally(paying.release);
    const [r1, r2] = await Promise.all([first, again]);
    assert.equal(second, 'waiting');
    assert.ok(r1.ok && r2.ok, 'neither failed');
    assert.deepEqual([r1.value.kind, r2.value.kind], ['ok', 'ok'], 'the second finds it paid already');
    const [row] = await payRows(seed.coach.id);
    assert.equal(row.paid_note, 'Venmo');
  });
});
