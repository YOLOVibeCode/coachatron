import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { isDomesticDestination, segmentCount, sendText, toOneSegment } from '../src/domain/outbound.js';
import type { DbClient } from '../src/db/client.js';

async function statuses(db: DbClient): Promise<string[]> {
  const result = await db.query<{ status: string }>('select status from message_log order by id');
  return result.rows.map((r) => r.status);
}

/** Pre-fills the log with already-sent texts, as if the day had been busy. */
async function fillLog(db: DbClient, n: number, coachId: number | null, at: Date): Promise<void> {
  await db.query(
    `insert into message_log (to_phone, template, body, sent_at, status, coach_id)
     select '+15550000000', 'filler', 'x', $1, 'sent', $2 from generate_series(1, $3)`,
    [at.toISOString(), coachId, n],
  );
}

test('every text fits one segment: GSM up to 160, UCS-2 up to 70', () => {
  assert.equal(toOneSegment('Coachatron: Sam has Keeper Group Tue Oct 7, 6:00pm.'), 'Coachatron: Sam has Keeper Group Tue Oct 7, 6:00pm.');

  const long = toOneSegment('x'.repeat(400));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('...'));

  // Typography that would silently force UCS-2 is flattened instead.
  assert.equal(toOneSegment('Sam’s “group” — Tue · 6:00 PM…'), 'Sam\'s "group" - Tue - 6:00 PM...');

  const emoji = toOneSegment(`⚽ ${'goal '.repeat(40)}`);
  assert.ok(emoji.length <= 70);
  assert.equal(segmentCount(emoji), 1);

  // Extended GSM characters take two slots.
  assert.equal(segmentCount(toOneSegment('{'.repeat(120))), 1);

  for (const body of ['a'.repeat(161), `${'é'.repeat(100)}ş`, `Tue${' '.repeat(200)}`, '😀'.repeat(50)]) {
    assert.equal(segmentCount(toOneSegment(body)), 1, JSON.stringify(body.slice(0, 20)));
  }
});

test('only US and Canadian numbers are texted', () => {
  assert.equal(isDomesticDestination('+15551234567'), true);
  assert.equal(isDomesticDestination('+14165550100'), true);
  assert.equal(isDomesticDestination('+447700900123'), false);
  assert.equal(isDomesticDestination('+1555123'), false);
});

test('a foreign number is refused and logged, never sent', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    assert.equal(await sendText(db, { to: '+447700900123', body: 'hi', coachId: null, template: 'otp' }), 'refused');
    assert.equal(relay.sms.length, 0);
    assert.deepEqual(await statuses(db), ['refused-destination']);
  });
});

test('a coach stops at 300 texts a day and 2,000 a month', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await seedCoachWithSession(db);
    const now = new Date('2026-10-20T17:00:00Z'); // noon in Chicago, the 20th

    await fillLog(db, 299, coach.id, new Date('2026-10-20T14:00:00Z'));
    const msg = { to: '+15550001234', body: 'hi', coachId: coach.id, template: 'reminder' };
    assert.equal(await sendText(db, msg, now), 'sent');
    assert.equal(await sendText(db, msg, now), 'capped');
    assert.equal(relay.sms.length, 1);
    assert.equal((await statuses(db)).at(-1), 'capped-coach-daily');

    // The next local day opens again, until the month is spent.
    const tomorrow = new Date('2026-10-21T17:00:00Z');
    assert.equal(await sendText(db, msg, tomorrow), 'sent');
    await fillLog(db, 2000 - 301, coach.id, new Date('2026-10-02T17:00:00Z'));
    assert.equal(await sendText(db, msg, tomorrow), 'capped');
    assert.equal((await statuses(db)).at(-1), 'capped-coach-monthly');

    // Another coach is unaffected.
    const other = await seedCoachWithSession(db);
    assert.equal(await sendText(db, { ...msg, coachId: other.coach.id }, tomorrow), 'sent');
  });
});

test('the product stops at 400 a day per active coach, never below 500', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const now = new Date();
    const msg = { to: '+15550001234', body: 'hi', coachId: null, template: 'auto-reply' };

    await fillLog(db, 500, null, now);
    assert.equal(await sendText(db, msg, now), 'capped');
    assert.equal((await statuses(db)).at(-1), 'capped-product-daily');

    // Two coaches with sessions ahead raise the ceiling to 800.
    await seedCoachWithSession(db);
    await seedCoachWithSession(db);
    assert.equal(await sendText(db, msg, now), 'sent');
  });
});

test('sign-in codes: five a day per number, domestic numbers only', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const ask = (phone: string) =>
        fetch(`${base}/signin/otp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone }),
          redirect: 'manual',
        });
      for (let i = 0; i < 5; i += 1) assert.equal((await ask('5550007777')).status, 303);
      const sixth = await ask('5550007777');
      assert.equal(sixth.status, 429);
      assert.match(await sixth.text(), /Too many codes/);
      assert.equal(relay.sms.filter((m) => m.to === '+15550007777').length, 5);

      const abroad = await ask('+44 7700 900123');
      assert.equal(abroad.status, 422);
      assert.match(await abroad.text(), /US or Canadian/);
    });
  });
});

test('nothing in src sends a text except through the guarded send path', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) {
        const rel = path.relative(root, full);
        if (rel === path.join('relay', 'sms.ts') || rel === path.join('domain', 'outbound.ts')) continue;
        if (/\bsendSms\b|relay\/sms\.js/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
