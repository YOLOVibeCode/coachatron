import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { dollarsToCents, LIMITS, rowId, wholeNumber } from '../src/lib/input.js';

/** What the coach's forms and the app's URLs accept: plain numbers in a
 * sensible range, and row ids. Anything else is a 4xx with a message. */

function form(body: Record<string, string>, cookie?: string) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual' as const,
  };
}

const goodType = { name: 'Group', duration_min: '60', capacity: '8', price_dollars: '35' };

test('numbers are read as plain whole numbers or dollars inside their range', () => {
  assert.equal(wholeNumber('12', LIMITS.capacity), 12);
  for (const raw of ['', '0', '1.5', '1e3', '-2', '0x10', '1001', '99999999999']) {
    assert.equal(wholeNumber(raw, LIMITS.capacity), null, raw);
  }
  assert.equal(dollarsToCents('19.99', LIMITS.priceCents), 1999);
  assert.equal(dollarsToCents('0.29', LIMITS.priceCents), 29);
  assert.equal(dollarsToCents('$35', LIMITS.priceCents), 3500);
  assert.equal(dollarsToCents('.5', LIMITS.priceCents), 50);
  assert.equal(dollarsToCents('25000', LIMITS.priceCents), 2_500_000);
  for (const raw of ['', '.', '0', '1e9', '-5', '19.999', '25000.01', 'abc']) {
    assert.equal(dollarsToCents(raw, LIMITS.priceCents), null, raw);
  }
  assert.equal(rowId('42'), 42);
  for (const raw of ['abc', '1.5', '0', '-1', '99999999999', '', undefined, 2.5]) {
    assert.equal(rowId(raw), null, String(raw));
  }
});

test('numbers past what the forms accept get the form message, and ordinary ones save', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Backup', 1);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const refused: Array<[string, Record<string, string>]> = [
        ['/app/session-types', { ...goodType, price_dollars: '1e9' }],
        ['/app/session-types', { ...goodType, capacity: '999999999999' }],
        ['/app/session-types', { ...goodType, duration_min: '999999999999' }],
        ['/app/session-types', { ...goodType, backup_pay_dollars: '-5' }],
        [`/app/session-types/${seed.sessionTypeId}/edit`, { ...goodType, price_dollars: '1e9' }],
        ['/app/pricing/package', { name: 'Pack', credits: '999999999999', price_dollars: '10' }],
        ['/app/pricing/package', { name: 'Pack', credits: '10', price_dollars: '1e9' }],
        ['/app/pricing/package', { name: 'Pack', credits: '10', price_dollars: '100', expires_days: '0' }],
        ['/app/pricing/package', { name: 'Pack', credits: '10', price_dollars: '100', expires_days: '-5' }],
        ['/app/pricing/package', { name: 'Pack', credits: '10', price_dollars: '100', expires_days: '1000000000' }],
        ['/app/pricing/plan', { name: 'Pack', price_dollars: '1e9', credits_per_month: '4' }],
        [`/app/roster/${member.id}/priority`, { priority: '99999999999999' }],
      ];
      for (const [path, body] of refused) {
        const res = await fetch(`${base}${path}`, form(body, cookie));
        assert.equal(res.status, 422, `${path} ${JSON.stringify(body)} answered ${res.status}`);
      }
      const message = await (await fetch(`${base}/app/session-types`, form({ ...goodType, capacity: '0' }, cookie))).text();
      assert.match(message, /1–1000 athletes/);

      const saved: Array<[string, Record<string, string>]> = [
        ['/app/session-types', { ...goodType, capacity: '99', price_dollars: '19.99' }],
        ['/app/pricing/package', { name: 'Pack', credits: '10', price_dollars: '100', expires_days: '60' }],
        ['/app/pricing/plan', { name: 'Four', price_dollars: '120', credits_per_month: '4' }],
        [`/app/roster/${member.id}/priority`, { priority: '3' }],
      ];
      for (const [path, body] of saved) {
        const res = await fetch(`${base}${path}`, form(body, cookie));
        assert.equal(res.status, 303, `${path} ${JSON.stringify(body)} answered ${res.status}`);
      }
    });
    const type = await db.query<{ price_cents: number; capacity: number }>('select price_cents, capacity from session_type order by id desc limit 1');
    assert.deepEqual(type.rows[0], { price_cents: 1999, capacity: 99 });
    const pack = await db.query<{ expires_days: number; n: string }>(
      'select max(expires_days) as expires_days, count(*)::text as n from package where coach_id = $1',
      [seed.coach.id],
    );
    assert.deepEqual(pack.rows[0], { expires_days: 60, n: '1' }, 'only the sixty-day package was saved');
  });
});

test('an id that is not a row id is a 404, and a NUL character in a request is a 400', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      for (const path of [
        '/app/sessions/abc',
        '/app/sessions/1.5',
        '/app/sessions/99999999999',
        '/app/sessions/abc/cancel',
        '/app/session-types/abc/edit',
        '/app/session-types/x/generate-week',
      ]) {
        const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
        assert.equal(res.status, 404, `GET ${path} answered ${res.status}`);
      }
      for (const path of ['/app/roster/abc/priority', `/app/sessions/${seed.sessionId}/bookings/1e3/attendance`, '/app/overflow/abc']) {
        const res = await fetch(`${base}${path}`, form({ priority: '1', status: 'attended', answer: 'no' }, cookie));
        assert.equal(res.status, 404, `POST ${path} answered ${res.status}`);
      }
      const handle = seed.coach.handle;
      for (const path of [`/c/${handle}/sessions/abc/book`, `/c/${handle}/sessions/99999999999/book`, `/c/${handle}/checkout/abc`]) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(res.status, 404, `GET ${path} answered ${res.status}`);
      }
      for (const path of ['/offer/%00', '/booking/%00', '/c/%00', `/c/${handle}?from=%00`]) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(res.status, 400, `GET ${path} answered ${res.status}`);
      }
      const nulName = await fetch(`${base}/app/session-types`, form({ ...goodType, name: 'Group\u0000' }, cookie));
      assert.equal(nulName.status, 400);
      // The pages themselves still answer.
      assert.equal((await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${base}/c/${handle}`)).status, 200);
    });
  });
});

test('a capacity below what a session already has booked is refused, and the type stays as it was', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    for (let i = 1; i <= 6; i += 1) await seedBookedSession(db, seed.sessionId, `Athlete ${i}`, `+1555000000${i}`);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const path = `/app/session-types/${seed.sessionTypeId}/edit`;
      const low = await fetch(`${base}${path}`, form({ ...goodType, capacity: '4', price_dollars: '40' }, cookie));
      assert.equal(low.status, 422);
      assert.match(await low.text(), /already has 6 booked\. Set the capacity to at least 6/);
      const row = await db.query<{ capacity: number; price_cents: number }>('select capacity, price_cents from session_type where id = $1', [
        seed.sessionTypeId,
      ]);
      assert.deepEqual(row.rows[0], { capacity: 8, price_cents: 3500 }, 'nothing was changed');

      const enough = await fetch(`${base}${path}`, form({ ...goodType, capacity: '6' }, cookie));
      assert.equal(enough.status, 303);
    });
  });
});
