import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedRosterMember } from './helpers/fixtures.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { sendText } from '../src/domain/outbound.js';
import { isOptedOut } from '../src/domain/cascade.js';
import { createCoach, createCoachSession } from '../src/domain/auth.js';
import {
  postSignedSms,
  postSignedSmsStatus,
  TEST_INBOUND_SECRET,
} from './helpers/sms-webhook.js';
import { relayInboundSignature } from '../src/lib/relay-inbound.js';

test('inbound webhook rejects missing signature when secret is set', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const body = Object.entries({ From: '+15551234567', Body: 'STOP' })
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const res = await fetch(`${base}/webhooks/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      assert.equal(res.status, 401);
    });
  });
});

test('inbound webhook accepts valid signature and handles STOP', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: '+15551234567', Body: 'STOP' });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<Response><\/Response>/);
      assert.equal(await isOptedOut(db, '+15551234567'), true);
    });
  });
});

test('inbound webhook rejects tampered body', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const fields = { From: '+15551234567', Body: 'STOP' };
      const body = Object.entries(fields)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const sig = relayInboundSignature(TEST_INBOUND_SECRET, `${base}/webhooks/sms`, Buffer.from(body));
      const tampered = `${body}&x=1`;
      const res = await fetch(`${base}/webhooks/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-relay-signature': sig },
        body: tampered,
      });
      assert.equal(res.status, 401);
    });
  });
});

test('inbound webhook rejects signature for wrong public URL', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const fields = { From: '+15551234567', Body: 'HELP' };
      const body = Object.entries(fields)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const sig = relayInboundSignature(TEST_INBOUND_SECRET, 'https://coachatron.com/webhooks/sms', Buffer.from(body));
      const res = await fetch(`${base}/webhooks/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-relay-signature': sig },
        body,
      });
      assert.equal(res.status, 401);
    });
  });
});

test('START clears opt-out', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      await postSignedSms(base, { From: '+15551234567', Body: 'STOP' });
      assert.equal(await isOptedOut(db, '+15551234567'), true);
      await postSignedSms(base, { From: '+15551234567', Body: 'START' });
      assert.equal(await isOptedOut(db, '+15551234567'), false);
    });
  });
});

test('HELP returns TwiML with support email', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: '+15551234567', Body: 'HELP' });
      const xml = await res.text();
      assert.match(xml, /<Message>/);
      assert.match(xml, /support@coachatron\.com/);
    });
  });
});

test('OptOutType=STOP is honored', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      await postSignedSms(base, { From: '+15551234567', Body: 'hi', OptOutType: 'STOP' });
      assert.equal(await isOptedOut(db, '+15551234567'), true);
    });
  });
});

test('OptOutType=START clears opt-out', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      await postSignedSms(base, { From: '+15551234567', Body: 'hi', OptOutType: 'STOP' });
      assert.equal(await isOptedOut(db, '+15551234567'), true);
      await postSignedSms(base, { From: '+15551234567', Body: 'hi', OptOutType: 'START' });
      assert.equal(await isOptedOut(db, '+15551234567'), false);
    });
  });
});

test('OptOutType=HELP returns TwiML', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: '+15551234567', Body: 'hello', OptOutType: 'HELP' });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<Message>/);
    });
  });
});

test('relay 21610 on send records opt-out', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15552161000');
    const outcome = await sendText(db, { to: '+15552161000', body: 'hi', coachId: null, template: 'reminder' });
    assert.equal(outcome, 'refused');
    assert.equal(await isOptedOut(db, '+15552161000'), true);
  });
});

test('status callback 21610 records opt-out', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      await postSignedSmsStatus(base, {
        MessageSid: 'SM123',
        MessageStatus: 'failed',
        ErrorCode: '21610',
        To: '+15551234567',
      });
      assert.equal(await isOptedOut(db, '+15551234567'), true);
    });
  });
});

test('roster member replies YES to record consent after confirmation text', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Backup', 0, { consent: false });
    const { sendRosterConsentRequest } = await import('../src/domain/cascade.js');
    const { hasActiveConsent } = await import('../src/domain/sms-consent.js');
    await sendRosterConsentRequest(db, seed.coach.id, seed.coach.name, member.phone);
    assert.equal(relay.sms.filter((m) => m.to === member.phone).length, 1);
    assert.equal(await hasActiveConsent(db, member.phone), false);

    await withServer(async (base) => {
      await postSignedSms(base, { From: member.phone, Body: 'YES' });
    });
    assert.equal(await hasActiveConsent(db, member.phone), true);
  });
});

test('SMS consent is required for a mobile sign-in or added mobile, not for email', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const post = (path: string, body: Record<string, string>, cookie = '') =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
          redirect: 'manual',
        });

      const signinForm = await (await fetch(`${base}/signin`)).text();
      assert.match(signinForm, /name="sms_consent"/);

      assert.equal((await post('/signin/otp', { contact: 'nobox@example.com' })).status, 303);
      assert.equal(relay.emails.length, 1);

      const unchecked = await post('/signin/otp', { contact: '5550008888' });
      assert.equal(unchecked.status, 422);
      assert.match(await unchecked.text(), /Check the box/);
      assert.equal(relay.sms.length, 0);

      const coach = await createCoach(db, { phone: null, email: 'add@example.com', name: 'Add', tz: 'America/Chicago' });
      const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
      const added = await post('/app/phone', { phone: '5550009999' }, cookie);
      assert.equal(added.headers.get('location'), '/app/schedule?phone=consent');
      assert.equal(relay.sms.length, 0);
    });
  });
});
