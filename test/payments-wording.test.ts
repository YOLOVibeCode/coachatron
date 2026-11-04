import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession, getConnectRecipientKey } from '../src/domain/auth.js';

/** Schedule and Money use one phrase for each payments step: "Connect
 * payments" before setup starts, "Finish connecting payments" once the
 * terms are accepted, and the test-account sentence when charges work on
 * a test account where only a live one takes payments. */

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TEST_ONLY = /This payment account takes test payments only, so parents cannot book paid sessions yet\./;

test('Schedule and Money name each payments step with the same words', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const screen = async (path: string) => {
        const res = await fetch(`${base}${path}`, { headers: { cookie } });
        assert.equal(res.status, 200, path);
        return res.text();
      };

      // Not started.
      assert.match(await screen('/app/money'), /<button type="submit">Connect payments<\/button>/);
      assert.match(await screen('/app/schedule'), /<a class="action" href="\/app\/money">Connect payments<\/a>/);

      // Terms accepted, onboarding not finished.
      const started = await fetch(`${base}/app/money/payments`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ agree: '1' }),
        redirect: 'manual',
      });
      assert.equal(started.status, 303);
      assert.match(await screen('/app/money'), /<button type="submit">Finish connecting payments<\/button>/);
      const schedule = await screen('/app/schedule');
      assert.match(schedule, /<a class="action" href="\/app\/money">Finish connecting payments<\/a>/);
      assert.doesNotMatch(schedule, />Connect payments</);

      // Charges on, but on a test account, in production.
      relay.enableCharges('coachatron', getConnectRecipientKey(seed.coach));
      await withEnv({ APP_ENV: 'production', ALLOW_TEST_PAYMENTS: undefined }, async () => {
        const money = await screen('/app/money');
        assert.match(money, TEST_ONLY);
        assert.doesNotMatch(money, /Connect payments|Finish connecting payments/);
        const testOnly = await screen('/app/schedule');
        assert.match(testOnly, TEST_ONLY);
        assert.match(testOnly, /<a class="action" href="\/app\/money">See payments<\/a>/);
        assert.doesNotMatch(testOnly, /Connect payments|Finish connecting payments|until payments are set up/);
      });

      // The same account outside production takes payments: Share is the main action.
      const open = await screen('/app/schedule');
      assert.doesNotMatch(open, /Connect payments|Finish connecting payments|See payments/);
      assert.match(open, /<a class="action" href="sms:/);
    });
  });
});
