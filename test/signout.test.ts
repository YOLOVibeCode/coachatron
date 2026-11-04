import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';

function signOut(base: string, cookie?: string): Promise<Response> {
  return fetch(`${base}/signout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: '',
    redirect: 'manual',
  });
}

test('signing out ends that session on the server and clears the cookie', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const here = await createCoachSession(db, seed.coach.id);
    const elsewhere = await createCoachSession(db, seed.coach.id);
    await withServer(async (base) => {
      const money = await (await fetch(`${base}/app/money`, { headers: { cookie: `cx_session=${here}` } })).text();
      assert.match(money, /<form method="post" action="\/signout">/);
      assert.match(money, />Sign out</);

      const out = await signOut(base, `cx_session=${here}`);
      assert.equal(out.status, 303);
      assert.equal(out.headers.get('location'), '/signin');
      const cleared = out.headers.getSetCookie().find((c) => c.startsWith('cx_session='));
      assert.ok(cleared);
      assert.match(cleared, /^cx_session=;/);
      assert.match(cleared, /Max-Age=0/);

      const after = await fetch(`${base}/app/schedule`, { headers: { cookie: `cx_session=${here}` }, redirect: 'manual' });
      assert.equal(after.status, 303, 'the old cookie no longer opens the schedule');
      assert.equal(after.headers.get('location'), '/signin');
      const other = await fetch(`${base}/app/schedule`, { headers: { cookie: `cx_session=${elsewhere}` }, redirect: 'manual' });
      assert.equal(other.status, 200, 'another browser stays signed in');
    });
    const rows = await db.query<{ token: string }>('select token from coach_session where coach_id = $1', [seed.coach.id]);
    assert.deepEqual(rows.rows.map((r) => r.token), [elsewhere]);
  });
});

test('signing out without a session just goes to sign in', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      for (const cookie of [undefined, 'cx_session=not-a-session', 'stray=100%']) {
        const out = await signOut(base, cookie);
        assert.equal(out.status, 303, String(cookie));
        assert.equal(out.headers.get('location'), '/signin');
      }
    });
  });
});
