import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postConnectWebhook } from './helpers/connectWebhook.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { getConnectRecipientKey } from '../src/domain/auth.js';

test('connect webhook rejects invalid signatures', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const res = await fetch(`${base}/webhooks/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-connect-signature': 'bad' },
        body: JSON.stringify({ id: 'evt_1', type: 'account.updated', data: { object: {} } }),
      });
      assert.equal(res.status, 401);
    });
  });
});

test('connect webhook dedupes by event id', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    relay.enableCharges(getConnectRecipientKey(seed.coach));

    await withServer(async (base) => {
      const event = {
        id: 'evt_dup_test',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_test',
            charges_enabled: true,
            metadata: { recipientKey: getConnectRecipientKey(seed.coach) },
          },
        },
      };
      const first = await postConnectWebhook(base, event);
      const second = await postConnectWebhook(base, event);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.status, 200);
      const body = await second.text();
      assert.equal(body, 'duplicate');

      const coach = await db.query<{ connect_status: string }>(
        'select connect_status from coach where id = $1',
        [seed.coach.id],
      );
      assert.equal(coach.rows[0].connect_status, 'ready');
    });
  });
});
