import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { inboundSmsUrl, parseInboundSms, relaySignature } from '../src/lib/inboundSms.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { isOptedOut } from '../src/domain/cascade.js';

const SECRET = 'test-inbound-secret';

/** What the relay sends: Twilio's own form fields, urlencoded. */
function twilioForm(from: string, body: string): string {
  return new URLSearchParams({ MessageSid: 'SM123', From: from, To: '+15551230000', Body: body, NumMedia: '0' }).toString();
}

function sendInbound(base: string, form: string, signature?: string): Promise<Response> {
  return fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-relay-twilio-verified': '1',
      ...(signature ? { 'x-relay-signature': signature } : {}),
    },
    body: form,
  });
}

async function withSecret(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.RELAY_INBOUND_SECRET;
  process.env.RELAY_INBOUND_SECRET = SECRET;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.RELAY_INBOUND_SECRET;
    else process.env.RELAY_INBOUND_SECRET = prev;
  }
}

test('the relay form fields and the JSON shape read the same', () => {
  assert.deepEqual(parseInboundSms(Buffer.from(twilioForm('+15559990000', ' Tuesdays at 6 ')), 'application/x-www-form-urlencoded'), {
    from: '+15559990000',
    body: 'Tuesdays at 6',
  });
  assert.deepEqual(parseInboundSms(Buffer.from(JSON.stringify({ from: '+15559990000', body: 'hi' })), 'application/json'), {
    from: '+15559990000',
    body: 'hi',
  });
  assert.equal(inboundSmsUrl(), 'https://coachatron.com/webhooks/sms');
});

test('with a secret set, only a correctly signed inbound text is handled', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withSecret(async () => {
      await withServer(async (base) => {
        const form = twilioForm('+15559990000', 'STOP');
        assert.equal((await sendInbound(base, form)).status, 401, 'unsigned');
        assert.equal((await sendInbound(base, form, relaySignature('wrong-secret', inboundSmsUrl(), Buffer.from(form)))).status, 401);
        assert.equal(
          (await sendInbound(base, form, relaySignature(SECRET, 'https://evil.example/webhooks/sms', Buffer.from(form)))).status,
          401,
          'signed for a different URL',
        );
        assert.equal(relay.sms.length, 0);

        const ok = await sendInbound(base, form, relaySignature(SECRET, inboundSmsUrl(), Buffer.from(form)));
        assert.equal(ok.status, 200);
      });
    });
  });
});

test('a signed STOP is answered with empty TwiML, records the opt-out, and sends no text of its own', async () => {
  // The relay passes the app's TwiML reply back to Twilio, and Twilio
  // answers STOP itself at the number level, so the app adds no message.
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withSecret(async () => {
      await withServer(async (base) => {
        const form = twilioForm('+15559990000', 'STOP');
        const res = await sendInbound(base, form, relaySignature(SECRET, inboundSmsUrl(), Buffer.from(form)));
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /xml/);
        assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      });
    });
    assert.equal(await isOptedOut(db, '+15559990000'), true);
    assert.equal(relay.sms.filter((m) => m.to === '+15559990000').length, 0, 'no text is sent');
  });
});

test(
  'a stranger texts their week in the relay format and gets a start link',
  async () => {
  await withRelay(async (relay) => {
    await freshDb();
    const llm = fakeComplete(new Error('the model must not run for an unknown number'));
    setComplete(llm);
    try {
      await withSecret(async () => {
        await withServer(async (base) => {
          const form = twilioForm('+15559990000', 'Keeper group Tuesdays at 6, an hour, 8 kids, $35');
          const res = await sendInbound(base, form, relaySignature(SECRET, inboundSmsUrl(), Buffer.from(form)));
          assert.equal(res.status, 200);
          const reply = relay.sms.find((m) => m.to === '+15559990000');
          assert.ok(reply);
          assert.match(reply.body, /\/start\/[a-f0-9]+/);
          assert.equal(llm.calls.length, 0);
        });
      });
    } finally {
      resetComplete();
    }
  });
  },
);
