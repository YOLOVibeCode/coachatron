import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';

function form(path: string, fields: Record<string, string>, cookie: string) {
  return fetch(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

test('creating a duplicate package by session count and price is rejected', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const ok = await form(
        `${base}/app/pricing/package`,
        { name: 'Ten pack', credits: '10', price_dollars: '150' },
        cookie,
      );
      assert.equal(ok.status, 303);
      const dup = await form(
        `${base}/app/pricing/package`,
        { name: 'Ten pack again', credits: '10', price_dollars: '150' },
        cookie,
      );
      assert.equal(dup.status, 422);
      assert.match(await dup.text(), /already have an active package/);
      const n = await db.query<{ c: string }>('select count(*)::text as c from package where coach_id = $1 and active', [seed.coach.id]);
      assert.equal(n.rows[0].c, '1');
    });
  });
});

test('the pricing screen shows package details, edit controls, and plain cancel choices', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      await form(
        `${base}/app/pricing/package`,
        { name: '10-session pack', credits: '10', price_dollars: '85' },
        cookie,
      );
      const html = await (await fetch(`${base}/app/pricing`, { headers: { cookie } })).text();
      assert.match(html, /10 sessions/);
      assert.match(html, /\$85/);
      assert.match(html, /8\.50 per session/);
      assert.match(html, /Edit/);
      assert.match(html, /Edit policy/);
      assert.match(html, /Not showing up:/);
      assert.match(html, /A credit for another session/);
      const saved = await form(
        `${base}/app/pricing/policy`,
        { cancel_window_hours: '24', children_per_booking: '2', cancel_gives: 'credit' },
        cookie,
      );
      assert.equal(saved.status, 303);
      assert.match(saved.headers.get('location') ?? '', /policy_saved=1/);
    });
  });
});

test('a coach can retire a package and it disappears from the list', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      await form(
        `${base}/app/pricing/package`,
        { name: 'Gone pack', credits: '4', price_dollars: '40' },
        cookie,
      );
      const id = (
        await db.query<{ id: number }>('select id from package where coach_id = $1 and name = $2', [seed.coach.id, 'Gone pack'])
      ).rows[0].id;
      const del = await form(`${base}/app/pricing/package/${id}/delete`, {}, cookie);
      assert.equal(del.status, 303);
      const html = await (await fetch(`${base}/app/pricing`, { headers: { cookie } })).text();
      assert.doesNotMatch(html, /Gone pack/);
      const row = await db.query<{ active: boolean }>('select active from package where id = $1', [id]);
      assert.equal(row.rows[0].active, false);
    });
  });
});