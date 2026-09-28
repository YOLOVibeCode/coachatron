import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { createCoach, createCoachSession, type CoachRow } from '../src/domain/auth.js';
import type { DbClient } from '../src/db/client.js';

async function signedInCoach(db: DbClient): Promise<{ coach: CoachRow; cookie: string }> {
  const coach = await createCoach(db, { name: 'Pat Keeper', phone: '+15550102030', email: 'pat@example.com', tz: 'America/Chicago' });
  return { coach, cookie: `cx_session=${await createCoachSession(db, coach.id)}` };
}

function connect(base: string, cookie: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/app/money/payments`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
}

async function moneyPage(base: string, cookie: string, query = ''): Promise<string> {
  const res = await fetch(`${base}/app/money${query}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return res.text();
}

test('a coach with no seller yet sees the terms and a Connect payments button', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { cookie } = await signedInCoach(db);
    await withServer(async (base) => {
      const page = await moneyPage(base, cookie);
      assert.match(page, /Connect payments/);
      assert.match(page, /Coachatron keeps 5% of each payment/);
      assert.match(page, /marketplace terms \(v1\)/);
      assert.ok(!/balance|withdraw/i.test(page), 'Money screen must not show a balance or a withdrawal control');
    });
  });
});

test('connecting without accepting the terms is refused and nothing reaches the relay', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    await withServer(async (base) => {
      const res = await connect(base, cookie, {});
      assert.equal(res.status, 422);
      assert.match(await res.text(), /Check the box to accept the marketplace terms/);
      assert.equal(relay.seller('coachatron', coach.handle), undefined);
      assert.equal(relay.onboards.length, 0);
    });
  });
});

test('accepting the terms records the agreement and sends the coach to the relay onboarding link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    process.env.APP_BASE_URL = 'https://dev.coachatron.com';
    try {
      await withServer(async (base) => {
        const res = await connect(base, cookie, { agree: '1' });
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), `${relay.url}/connect/coachatron/onboard?state=fake-${coach.handle}`);
        assert.equal(relay.seller('coachatron', coach.handle)?.agreementVersion, 'v1');
        assert.deepEqual(relay.onboards, [
          { product: 'coachatron', sellerKey: coach.handle, returnUrl: 'https://dev.coachatron.com/app/money', email: 'pat@example.com' },
        ]);
      });
    } finally {
      delete process.env.APP_BASE_URL;
    }
  });
});

test('a coach who accepted but did not finish is not asked to accept again', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    await withServer(async (base) => {
      assert.equal((await connect(base, cookie, { agree: '1' })).status, 303);
      const page = await moneyPage(base, cookie, '?seller=pending');
      assert.match(page, /still being reviewed/);
      assert.match(page, /Finish connecting payments/);
      assert.doesNotMatch(page, /name="agree"/);

      const again = await connect(base, cookie, {});
      assert.equal(again.status, 303);
      assert.equal(relay.onboards.length, 2);
      assert.equal(relay.seller('coachatron', coach.handle)?.agreementVersion, 'v1');
    });
  });
});

test('once onboarding enables charges the Money screen says payments are connected', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    await withServer(async (base) => {
      await connect(base, cookie, { agree: '1' });
      relay.enableCharges('coachatron', coach.handle);
      const page = await moneyPage(base, cookie, '?seller=connected');
      assert.match(page, /Payments are connected\./);
      assert.match(page, /Athletes pay you directly/);
      assert.doesNotMatch(page, /action="\/app\/money\/payments"/);
    });
  });
});

test('a stale agreement version asks the coach to accept the current terms', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    await withServer(async (base) => {
      await connect(base, cookie, { agree: '1' });
      relay.seller('coachatron', coach.handle)!.agreementVersion = 'v0';
      const page = await moneyPage(base, cookie);
      assert.match(page, /name="agree"/);
    });
  });
});

test('the Connect app comes from RELAY_CONNECT_PRODUCT', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await signedInCoach(db);
    process.env.RELAY_CONNECT_PRODUCT = 'coachatron-uat';
    try {
      await withServer(async (base) => {
        const res = await connect(base, cookie, { agree: '1' });
        assert.equal(res.status, 303);
        assert.match(res.headers.get('location') ?? '', /\/connect\/coachatron-uat\/onboard\?/);
        assert.equal(relay.seller('coachatron-uat', coach.handle)?.agreementVersion, 'v1');
        assert.equal(relay.seller('coachatron', coach.handle), undefined);
      });
    } finally {
      delete process.env.RELAY_CONNECT_PRODUCT;
    }
  });
});

test('an unreachable relay shows a notice on Money and a retry message on connect', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { cookie } = await signedInCoach(db);
    process.env.RELAY_BASE_URL = 'http://127.0.0.1:1';
    await withServer(async (base) => {
      const page = await moneyPage(base, cookie);
      assert.match(page, /Payments status is unavailable right now/);
      const res = await connect(base, cookie, { agree: '1' });
      assert.equal(res.status, 502);
      assert.match(await res.text(), /Payments could not start/);
    });
  });
});
