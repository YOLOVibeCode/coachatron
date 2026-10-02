import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import type { DbClient } from '../src/db/client.js';

async function withAppEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.RELAY_APP_ENV;
  if (value === undefined) delete process.env.RELAY_APP_ENV;
  else process.env.RELAY_APP_ENV = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.RELAY_APP_ENV;
    else process.env.RELAY_APP_ENV = prev;
  }
}

function post(base: string, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function coachPhones(db: DbClient): Promise<string[]> {
  return (await db.query<{ phone: string }>('select phone from coach order by id')).rows.map((r) => r.phone);
}

test('without RELAY_APP_ENV, texts carry no X-App-Env and only +1 numbers get one', async () => {
  await withAppEnv(undefined, async () => {
    await withRelay(async (relay) => {
      await freshDb();
      await withServer(async (base) => {
        assert.equal((await post(base, '/signin/otp', { contact: '5550001111' })).status, 303);
        assert.equal(relay.sms[0].appEnv, null);
        assert.equal((await post(base, '/signin/otp', { contact: '+63 917 123 4567' })).status, 422);
      });
    });
  });
});

test('with RELAY_APP_ENV=dev, every text is marked for capture and any number can sign in', async () => {
  await withAppEnv('dev', async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      await withServer(async (base) => {
        const ask = await post(base, '/signin/otp', { contact: '+63 917 123 4567' });
        assert.equal(ask.status, 303, 'a Philippine number is fine when nothing is really texted');
        const sent = relay.sms.find((m) => m.to === '+639171234567');
        assert.ok(sent);
        assert.equal(sent.appEnv, 'dev');
        const code = /code is (\d{6})/.exec(sent.body)![1];
        const done = await post(base, '/signin/verify', { to: '+639171234567', code, name: 'Acel Tester', tz: 'Asia/Manila' });
        assert.equal(done.status, 303);
        assert.deepEqual(await coachPhones(db), ['+639171234567']);
      });
    });
  });
});

test('with RELAY_APP_ENV=uat, texts are tagged by the relay but still only reach +1 numbers', async () => {
  await withAppEnv('uat', async () => {
    await withRelay(async (relay) => {
      await freshDb();
      await withServer(async (base) => {
        assert.equal((await post(base, '/signin/otp', { contact: '5550002222' })).status, 303);
        assert.equal(relay.sms[0].appEnv, 'uat');
        assert.equal((await post(base, '/signin/otp', { contact: '+63 917 123 4567' })).status, 422);
      });
    });
  });
});
