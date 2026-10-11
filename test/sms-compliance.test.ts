import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
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

test('adding a roster member texts nobody; a YES to a request sent before still records consent', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const { hasActiveConsent } = await import('../src/domain/sms-consent.js');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;

    await withServer(async (base) => {
      const added = await fetch(`${base}/app/roster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Backup', phone: '5550007777' }),
        redirect: 'manual',
      });
      assert.equal(added.status, 303);
      assert.equal(relay.sms.length, 0);
      assert.equal(await hasActiveConsent(db, '+15550007777'), false);

      const roster = await (await fetch(`${base}/app/roster`, { headers: { cookie } })).text();
      assert.match(roster, /Not opted in yet/);
      assert.match(roster, /\/sms/);

      await db.query(
        `insert into sms_consent_pending (phone, added_by_coach_id, added_for_label, purpose, sent_at)
         values ($1, $2, $3, $4, now())`,
        ['+15550006666', seed.coach.id, seed.coach.name, 'booking confirmations, reminders, and session updates'],
      );
      await postSignedSms(base, { From: '+15550006666', Body: 'YES' });
    });
    assert.equal(await hasActiveConsent(db, '+15550006666'), true);
  });
});

test('a mobile sign-in code needs no box; the box records consent; adding a mobile still needs it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { hasActiveConsent } = await import('../src/domain/sms-consent.js');
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
      assert.doesNotMatch(signinForm, /name="sms_consent"[^>]*checked/);
      assert.match(signinForm, /one-time code/);

      assert.equal((await post('/signin/otp', { contact: 'nobox@example.com' })).status, 303);
      assert.equal(relay.emails.length, 1);

      const unchecked = await post('/signin/otp', { contact: '5550008888' });
      assert.equal(unchecked.status, 303);
      assert.equal(relay.sms.length, 1);
      assert.match(relay.sms[0].body, /^Coachatron: your sign-in code is \d{6}\./);
      assert.match(relay.sms[0].body, /Reply STOP to opt out\.$/);
      assert.equal(await hasActiveConsent(db, '+15550008888'), false);

      const checked = await post('/signin/otp', { contact: '5550008889', sms_consent: '1' });
      assert.equal(checked.status, 303);
      assert.equal(await hasActiveConsent(db, '+15550008889'), true);

      const coach = await createCoach(db, { phone: null, email: 'add@example.com', name: 'Add', tz: 'America/Chicago' });
      const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
      const added = await post('/app/phone', { phone: '5550009999' }, cookie);
      assert.equal(added.headers.get('location'), '/app/schedule?phone=consent');
      assert.equal(relay.sms.length, 2);
    });
  });
});

test('a coach who signed in by text without the box can turn texts on later', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const { hasActiveConsent } = await import('../src/domain/sms-consent.js');
    const phone = seed.coach.phone as string;
    await db.query('delete from sms_consent where phone = $1', [phone]);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /action="\/app\/phone\/consent"/);

      const post = (body: Record<string, string>) =>
        fetch(`${base}/app/phone/consent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
          redirect: 'manual',
        });
      assert.equal((await post({})).headers.get('location'), '/app/schedule?phone=consent');
      assert.equal(await hasActiveConsent(db, phone), false);
      assert.equal((await post({ sms_consent: '1' })).headers.get('location'), '/app/schedule?phone=done');
      assert.equal(await hasActiveConsent(db, phone), true);
    });
  });
});

test('/sms is public, says texts are optional, and opts in only with the box', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { hasActiveConsent } = await import('../src/domain/sms-consent.js');
    await withServer(async (base) => {
      const res = await fetch(`${base}/sms`);
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.match(page, /Texts are optional/);
      assert.match(page, /Every message starts with &quot;Coachatron:&quot;|Every message starts with "Coachatron:"/);
      assert.match(page, /Message and data rates may apply/);
      assert.match(page, /Reply STOP to opt out at any time, or HELP for help/);
      assert.match(page, /support@coachatron\.com/);
      assert.match(
        page,
        /We do not share, sell, or provide your mobile phone number or SMS opt-in data to third parties or affiliates for marketing or promotional purposes\./,
      );
      assert.match(page, /<input type="checkbox" name="sms_consent" value="1" \/>/);
      assert.match(page, /href="\/terms#sms"/);
      assert.match(page, /href="\/privacy"/);

      const post = (body: Record<string, string>) =>
        fetch(`${base}/sms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const noBox = await post({ phone: '5550004444' });
      assert.equal(noBox.status, 422);
      assert.equal(await hasActiveConsent(db, '+15550004444'), false);

      const bot = await post({ phone: '5550004445', sms_consent: '1', website: 'spam' });
      assert.equal(bot.status, 200);
      assert.equal(await hasActiveConsent(db, '+15550004445'), false);

      const foreign = await post({ phone: '+447700900123', sms_consent: '1' });
      assert.equal(foreign.status, 422);

      assert.equal(relay.sms.length, 0);

      const ok = await post({ phone: '5550004444', sms_consent: '1' });
      assert.equal(ok.status, 200);
      assert.equal(await hasActiveConsent(db, '+15550004444'), true);
      assert.equal(relay.sms.length, 1);
      assert.match(relay.sms[0].body, /^Coachatron: you're opted in/);
      assert.match(relay.sms[0].body, /STOP to opt out\.$/);
    });
  });
});

const OPERATOR = 'Coachatron is operated by Noctusoft, Inc. (<a href="https://noctusoft.com">https://noctusoft.com</a>)';

test('every public page links /sms and names the operator in the footer', async () => {
  await withServer(async (base) => {
    for (const path of ['/', '/signin', '/privacy', '/terms', '/sms']) {
      const html = await (await fetch(`${base}${path}`)).text();
      assert.match(html, /href="\/sms"/, path);
      const footer = html.slice(html.lastIndexOf('<footer class="site-footer">'));
      assert.ok(footer.includes(OPERATOR), path);
    }
  });
});

test('privacy, terms, and /sms name the operator right under the heading', async () => {
  await withServer(async (base) => {
    for (const path of ['/privacy', '/terms', '/sms']) {
      const html = await (await fetch(`${base}${path}`)).text();
      const afterHeading = html.slice(html.indexOf('</h1>'), html.indexOf('</h1>') + 200);
      assert.ok(afterHeading.includes(OPERATOR), path);
    }
  });
});
