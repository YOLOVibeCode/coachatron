import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createPackage } from '../src/domain/pricing.js';

function form(body: Record<string, string>, cookie: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body),
    redirect: 'manual' as const,
  };
}

test('manual package create rejects a duplicate with the same sessions and price', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await createPackage(db, seed.coach.id, '10-session pack', 10, 15000, null);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const dup = await fetch(
        `${base}/app/pricing/package`,
        form({ name: 'Another name', credits: '10', price_dollars: '150', expires_days: '' }, cookie),
      );
      assert.equal(dup.status, 422);
      assert.match(await dup.text(), /same number of sessions and price/);
      const n = await db.query<{ c: string }>(
        'select count(*)::text as c from package where coach_id = $1 and active',
        [seed.coach.id],
      );
      assert.equal(n.rows[0].c, '1');
    });
  });
});

test('the pricing page lists package details with edit and delete', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await createPackage(db, seed.coach.id, '10-session pack', 10, 15000, 60);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const html = await (await fetch(`${base}/app/pricing`, { headers: { cookie } })).text();
      assert.match(html, /Prepaid sessions clients buy up front/);
      assert.match(html, /Session credits from the pack never expire/);
      assert.match(html, /10 sessions/);
      assert.match(html, /\$150/);
      assert.match(html, /\$15\.00 per session/);
      assert.match(html, /Credits expire after 60 days/);
      assert.match(html, />Edit</);
      assert.match(html, />Delete</);
      assert.match(html, /<details class="pricing-create">/);
      assert.doesNotMatch(html, /<details class="pricing-create" open/);
      assert.match(html, /inputmode="numeric"/);
      assert.match(html, /inputmode="decimal"/);
      assert.match(html, /pricing-per-session/);
      assert.match(html, /action ghost" href="\/app\/pricing">Cancel/);
    });
  });
});

test('edit package updates the row and retire leaves credits unchanged', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const pkgId = await createPackage(db, seed.coach.id, 'Old pack', 5, 10000, null);
    const credit = await db.query<{ id: number }>(
      `insert into credit (coach_id, contact_phone, package_id, remaining, source)
       values ($1, '+15550009991', $2, 3, 'package:${pkgId}') returning id`,
      [seed.coach.id, pkgId],
    );
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const edited = await fetch(
        `${base}/app/pricing/package/${pkgId}/edit`,
        form({ name: 'Five pack', credits: '5', price_dollars: '120', expires_days: '30' }, cookie),
      );
      assert.equal(edited.status, 303);
      const row = await db.query<{ name: string; price_cents: number; expires_days: number }>(
        'select name, price_cents, expires_days from package where id = $1',
        [pkgId],
      );
      assert.deepEqual(row.rows[0], { name: 'Five pack', price_cents: 12000, expires_days: 30 });

      const removed = await fetch(`${base}/app/pricing/package/${pkgId}/delete`, form({}, cookie));
      assert.equal(removed.status, 303);
      const active = await db.query<{ active: boolean }>('select active from package where id = $1', [pkgId]);
      assert.equal(active.rows[0].active, false);
      const rem = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [credit.rows[0].id]);
      assert.equal(rem.rows[0].remaining, 3);
    });
  });
});