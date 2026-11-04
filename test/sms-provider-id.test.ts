import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { listenLoopback } from './helpers/listen.js';
import { postSignedSmsStatus } from './helpers/sms-webhook.js';
import { sendSms } from '../src/relay/sms.js';
import { sendText } from '../src/domain/outbound.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';

/** One route that answers /sms/send however the test says, in place of the relay. */
async function withSmsRoute(reply: (res: express.Response) => void, fn: () => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post('/sms/send', (_req, res) => reply(res));
  const server = createServer(app);
  const port = await listenLoopback(server);
  const prev = { url: process.env.RELAY_BASE_URL, key: process.env.RELAY_API_KEY };
  process.env.RELAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.RELAY_API_KEY = 'test-relay-key';
  try {
    await fn();
  } finally {
    if (prev.url === undefined) delete process.env.RELAY_BASE_URL;
    else process.env.RELAY_BASE_URL = prev.url;
    if (prev.key === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = prev.key;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a sent text is recorded under the Twilio message sid the relay answers with', async () => {
  await withSmsRoute(
    (res) =>
      res.status(201).json({
        success: true,
        message: { twilio_sid: 'SM0123456789abcdef', to: '+15551234567', from: '+18005550100', body: 'hi', status: 'queued' },
      }),
    async () => {
      assert.deepEqual(await sendSms({ to: '+15551234567', body: 'hi' }), { ok: true, id: 'SM0123456789abcdef' });
    },
  );
});

test('an answer with only an id still records that id, and an answer with neither says unknown', async () => {
  await withSmsRoute(
    (res) => res.status(200).json({ id: 'sms_42' }),
    async () => {
      assert.deepEqual(await sendSms({ to: '+15551234567', body: 'hi' }), { ok: true, id: 'sms_42' });
    },
  );
  await withSmsRoute(
    (res) => res.status(201).json({ success: true, captured: true, message: { to: '+15551234567', status: 'captured' } }),
    async () => {
      assert.deepEqual(await sendSms({ to: '+15551234567', body: 'hi' }), { ok: true, id: 'unknown' });
    },
  );
});

test("a delivery report finds the logged text by its sid and updates the text's status", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    assert.equal(await sendText(db, { to: '+15551234567', body: 'hi', coachId: null, template: 'reminder' }), 'sent');
    const sid = relay.sms[0].sid!;
    const logged = await db.query<{ provider_id: string }>('select provider_id from message_log');
    assert.equal(logged.rows[0].provider_id, sid);

    await withServer(async (base) => {
      const res = await postSignedSmsStatus(base, { MessageSid: sid, MessageStatus: 'delivered', To: '+15551234567' });
      assert.equal(res.status, 200);
    });
    const after = await db.query<{ status: string }>('select status from message_log where provider_id = $1', [sid]);
    assert.equal(after.rows[0].status, 'delivered');
  });
});

test('texts a delivery report has marked delivered still count toward the daily ceiling', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const now = new Date('2026-10-20T17:00:00Z');
    await grantSmsConsent(db, '+15551234567');
    await db.query(
      `insert into message_log (to_phone, template, body, provider_id, sent_at, status)
       select '+15551234567', 'otp', 'x', 'SM' || g, $1, 'delivered' from generate_series(1, 5) g`,
      [new Date(now.getTime() - 60_000).toISOString()],
    );
    const outcome = await sendText(
      db,
      { to: '+15551234567', body: 'code', coachId: null, template: 'otp', perRecipientDailyMax: 5 },
      now,
    );
    assert.equal(outcome, 'capped');
    assert.equal(relay.sms.length, 0);
  });
});
