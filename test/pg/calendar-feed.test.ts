import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseAfter, raceDb, settle, skipWithoutPostgres, untilWaitingOrDone, type RaceDb } from './helpers.js';
import { seedCoachWithSession } from '../helpers/fixtures.js';
import { findFeedCoach, getCalendarToken, replaceCalendarToken, turnOnCalendarFeed } from '../../src/domain/calendarFeed.js';
import type { DbClient } from '../../src/db/client.js';

/** The calendar link (SPEC.md §8.2) when two requests change it at the same
 * moment, on real Postgres (TEST_DATABASE_URL; skipped without it). The
 * first is held right after its statement, uncommitted, the second is
 * started and seen to wait for it, and only then is the first let go. */

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

const writesLink = (sql: string) => sql.includes('insert into calendar_feed');

test('two first uses at once end with one link, and both are told the same one', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  const first = pauseAfter(db(), writesLink);
  const a = settle(first.db.transaction!((tx) => turnOnCalendarFeed(tx, seed.coach.id)));
  await first.reached;
  const b = settle(turnOnCalendarFeed(db(), seed.coach.id));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting', 'the second waited for the first to finish');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.equal(rb.value, ra.value, 'the second got the link the first made');
  assert.equal(await getCalendarToken(db(), seed.coach.id), ra.value);
  const rows = await db().query<{ n: number }>('select count(*)::int as n from calendar_feed where coach_id = $1', [seed.coach.id]);
  assert.equal(rows.rows[0].n, 1);
});

test('a first use and a new link at once leave exactly one working link', RACE, async () => {
  const seed = await seedCoachWithSession(db());
  const first = pauseAfter(db(), writesLink);
  const a = settle(first.db.transaction!((tx) => turnOnCalendarFeed(tx, seed.coach.id)));
  await first.reached;
  const b = settle(replaceCalendarToken(db(), seed.coach.id));
  const second = await untilWaitingOrDone(db(), b).finally(first.release);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(second, 'waiting');
  assert.ok(ra.ok && rb.ok, 'neither failed');
  assert.notEqual(rb.value, ra.value);
  assert.equal(await getCalendarToken(db(), seed.coach.id), rb.value, 'the new link, asked for last, is the one that stands');
  assert.equal(await findFeedCoach(db(), ra.value), null, 'the first link stopped working');
  assert.equal((await findFeedCoach(db(), rb.value))?.id, seed.coach.id);
});
