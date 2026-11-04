import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { fakeComplete } from './fakes/llm.js';
import { isOptedOut } from '../src/domain/cascade.js';
import { grantSmsConsent, hasActiveConsent } from '../src/domain/sms-consent.js';
import { isStopRequest, matchInboundKeyword } from '../src/domain/sms-keywords.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';

const PARENT = '+15551234567';

test('a short reply that asks to stop in its own words counts as STOP', () => {
  for (const body of [
    'stop texting me',
    'Please stop',
    'stop please!!',
    'STOP.',
    'Stop sending me texts',
    'please stop the reminders',
    'unsubscribe me',
    'Please unsubscribe',
    'I want to be unsubscribed',
    'opt out',
    'Opt-out please',
    'opt me out',
    'remove me',
    'Remove me from your list',
    'take me off the list',
    'revoke',
    'revoke consent',
    'quit texting me',
    'cancel my texts',
    'end these messages',
    "don't text me",
    'do not message me again',
    "don't contact me",
    'do not contact me again',
    'never contact me',
    'stop contacting me',
    'no more texts',
  ]) {
    assert.equal(isStopRequest(body), true, body);
    assert.equal(matchInboundKeyword(body, ''), 'STOP', body);
  }
});

test('a message that only contains a stop word while asking for something else is not STOP', () => {
  for (const body of [
    'stop the 6pm session',
    'cancel tomorrow',
    "cancel tomorrow's 6pm",
    'cancel all',
    'cancel everything next week',
    'end it',
    'remove Sam from Tuesday',
    'stopping by at six',
    'stop texting the athletes about rain',
    "don't stop",
    'please contact me',
    'contact me about the 6pm',
    'no more sessions this week',
    'I need help with my booking',
    'Y',
    'yes',
    '',
    `stop ${'please '.repeat(20)}`,
  ]) {
    assert.equal(isStopRequest(body), false, body);
    assert.equal(matchInboundKeyword(body, ''), null, body);
  }
});

test('"please stop texting me" from a parent opts the number out', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await grantSmsConsent(db, PARENT);
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: PARENT, Body: 'please stop texting me' });
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /<Message>/);
    });
    assert.equal(await isOptedOut(db, PARENT), true);
    assert.equal(await hasActiveConsent(db, PARENT), false);
    assert.equal(relay.sms.length, 0);
  });
});

test('a coach\'s "stop the 6pm session" goes to the assistant and leaves texts on', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const coachPhone = seed.coach.phone as string;
    const llm = fakeComplete({
      intent: 'unknown',
      confidence: 0,
      session_id: null,
      session_type_id: null,
      session_type: null,
      when: null,
      new_when: null,
      location: null,
      reason: null,
    });
    setComplete(llm);
    try {
      await withServer(async (base) => {
        assert.equal((await postSignedSms(base, { From: coachPhone, Body: 'stop the 6pm session' })).status, 200);
      });
    } finally {
      resetComplete();
    }
    assert.equal(await isOptedOut(db, coachPhone), false);
    assert.equal(await hasActiveConsent(db, coachPhone), true);
    const logged = await db.query<{ layer: string }>("select layer from assistant_log where raw_message = 'stop the 6pm session'");
    assert.ok(logged.rows.length > 0 && logged.rows.every((r) => r.layer !== 'keyword'), 'handled as a command');
    assert.ok(relay.sms.some((m) => m.to === coachPhone), 'the assistant answered');
  });
});
