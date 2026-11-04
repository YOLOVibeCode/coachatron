import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoach, createCoachSession } from '../src/domain/auth.js';
import { isOptedOut } from '../src/domain/cascade.js';
import { sendEmailMessage, sendText } from '../src/domain/outbound.js';
import { grantSmsConsent, hasActiveConsent, revokeConsent } from '../src/domain/sms-consent.js';
import { purgeRequestLimits, SIGNIN_CODE_LIMITS, takeRequest } from '../src/domain/requestLimits.js';
import type { DbClient } from '../src/db/client.js';

function post(base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

const from = (address: string) => ({ 'x-forwarded-for': address });
const emailedCode = (subject: string) => /(\d{6})/.exec(subject)![1];
const textedCode = (body: string) => /is (\d{6})/.exec(body)![1];

/** A six-digit code that is not `code`. */
function wrong(code: string, n: number): string {
  return String((Number(code) + n) % 1_000_000).padStart(6, '0');
}

async function count(db: DbClient, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params)).rows[0].n);
}

/** A coach who joined by email and has a week, so the schedule shows the add-a-mobile card. */
async function emailCoachWithSchedule(db: DbClient) {
  const coach = await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana', tz: 'America/Chicago' });
  const type = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Evening group', 60, 8, 3500, true) returning id`,
    [coach.id],
  );
  await db.query(`insert into session (session_type_id, starts_at_utc, tz, status) values ($1, $2, 'America/Chicago', 'scheduled')`, [
    type.rows[0].id,
    new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
  return { coach, cookie: `cx_session=${await createCoachSession(db, coach.id)}` };
}

async function withSmsNumber(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.COACHATRON_SMS_NUMBER;
  process.env.COACHATRON_SMS_NUMBER = '+18333645083';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.COACHATRON_SMS_NUMBER;
    else process.env.COACHATRON_SMS_NUMBER = prev;
  }
}

// ---- one code, a few tries ----------------------------------------------

test('a code stops working after five wrong tries', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: 'pat@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      for (let i = 1; i <= 4; i += 1) {
        const res = await post(base, '/signin/verify', { to: 'pat@example.com', code: wrong(code, i), name: 'Pat' });
        assert.equal(res.status, 401);
        assert.match(await res.text(), /Invalid or expired code/);
      }
      const fifth = await post(base, '/signin/verify', { to: 'pat@example.com', code: wrong(code, 5), name: 'Pat' });
      assert.equal(fifth.status, 401);
      assert.match(await fifth.text(), /too many wrong tries/);
      const right = await post(base, '/signin/verify', { to: 'pat@example.com', code, name: 'Pat' });
      assert.equal(right.status, 401, 'the right code no longer works');
      assert.equal(right.headers.getSetCookie().length, 0);

      await post(base, '/signin/otp', { contact: 'pat@example.com' });
      const fresh = emailedCode(relay.emails[1].subject);
      assert.equal((await post(base, '/signin/verify', { to: 'pat@example.com', code: fresh, name: 'Pat' })).status, 303, 'a new code works');
    });
  });
});

test('four wrong tries leave the right code working, and the right code without a name can be sent again', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: 'pat@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      for (let i = 1; i <= 4; i += 1) await post(base, '/signin/verify', { to: 'pat@example.com', code: wrong(code, i) });
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await post(base, '/signin/verify', { to: 'pat@example.com', code })).status, 422, 'asks for a name');
      }
      assert.equal((await post(base, '/signin/verify', { to: 'pat@example.com', code, name: 'Pat' })).status, 303);
    });
  });
});

test('asking for a new code ends the one before it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: '5550101010' });
      await post(base, '/signin/otp', { contact: '5550101010' });
      const [first, second] = relay.sms.map((m) => textedCode(m.body));
      assert.notEqual(first, second);
      assert.equal(await count(db, "otp_code where phone = '+15550101010' and consumed_at is null and expires_at > now()"), 1);
      assert.equal((await post(base, '/signin/verify', { to: '+15550101010', code: first, name: 'Pat' })).status, 401);
      assert.equal((await post(base, '/signin/verify', { to: '+15550101010', code: second, name: 'Pat' })).status, 303);
    });
  });
});

test('adding a mobile: the code stops after five wrong tries, and a new one ends the old', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await emailCoachWithSchedule(db);
    await withServer(async (base) => {
      await post(base, '/app/phone', { phone: '5550003333', sms_consent: '1' }, { cookie });
      const old = textedCode(relay.sms[0].body);
      await post(base, '/app/phone', { phone: '5550003333', sms_consent: '1' }, { cookie });
      const code = textedCode(relay.sms[1].body);
      assert.equal(
        (await post(base, '/app/phone/verify', { phone: '+15550003333', code: old }, { cookie })).headers.get('location'),
        '/app/schedule?phone=wrong&to=%2B15550003333',
      );
      for (let i = 1; i <= 3; i += 1) await post(base, '/app/phone/verify', { phone: '+15550003333', code: wrong(code, i) }, { cookie });
      const fifth = await post(base, '/app/phone/verify', { phone: '+15550003333', code: wrong(code, 4) }, { cookie });
      assert.equal(fifth.headers.get('location'), '/app/schedule?phone=used');
      const right = await post(base, '/app/phone/verify', { phone: '+15550003333', code }, { cookie });
      assert.equal(right.headers.get('location'), '/app/schedule?phone=used');
      assert.equal((await db.query<{ phone: string | null }>('select phone from coach where id = $1', [coach.id])).rows[0].phone, null);
      const page = await (await fetch(`${base}/app/schedule?phone=used`, { headers: { cookie } })).text();
      assert.match(page, /too many wrong tries/);
      assert.match(page, /action="\/app\/phone"/, 'the form to ask for a new code');
    });
  });
});

// ---- code checks per address and per contact ------------------------------

test('code checks pause after too many for one email or number, even with the right code', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      for (let i = 0; i < 15; i += 1) {
        assert.equal((await post(base, '/signin/verify', { to: 'sam@example.com', code: '000000' }, from(`198.51.100.${i}`))).status, 401);
      }
      await post(base, '/signin/otp', { contact: 'sam@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      const paused = await post(base, '/signin/verify', { to: 'sam@example.com', code, name: 'Sam' }, from('198.51.100.200'));
      assert.equal(paused.status, 429);
      assert.match(await paused.text(), /Too many tries\. Wait a few minutes/);
      assert.equal((await post(base, '/signin/verify', { to: 'other@example.com', code: '000000' })).status, 401, 'another email is not paused');
    });
  });
});

test('code checks pause after too many from one address, across emails', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      for (let i = 0; i < 30; i += 1) {
        assert.equal((await post(base, '/signin/verify', { to: `p${i}@example.com`, code: '000000' }, from('203.0.113.5'))).status, 401);
      }
      assert.equal((await post(base, '/signin/verify', { to: 'p99@example.com', code: '000000' }, from('203.0.113.5'))).status, 429);
      assert.equal((await post(base, '/signin/verify', { to: 'p99@example.com', code: '000000' }, from('203.0.113.6'))).status, 401);
    });
  });
});

// ---- sending codes --------------------------------------------------------

test('code requests from one address are limited, whatever number or email they name', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      for (let i = 0; i < 10; i += 1) {
        const res = await post(base, '/signin/otp', { contact: `214555${String(1000 + i)}` }, from('203.0.113.7'));
        assert.equal(res.status, 303, `request ${i + 1}`);
      }
      const refused = await post(base, '/signin/otp', { contact: 'x@example.com' }, from('203.0.113.7'));
      assert.equal(refused.status, 429);
      assert.match(await refused.text(), /Too many tries\. Wait a few minutes/);
      assert.equal(relay.sms.length, 10);
      assert.equal(relay.emails.length, 0);
      assert.equal((await post(base, '/signin/otp', { contact: 'x@example.com' }, from('203.0.113.8'))).status, 303, 'another address is not limited');
    });
  });
});

test('the address limit also holds over a day, ten minutes at a time', async () => {
  const db = await freshDb();
  const midnight = Date.UTC(2026, 10, 4);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(await takeRequest(db, SIGNIN_CODE_LIMITS, '203.0.113.9', new Date(midnight + i * 11 * 60 * 1000)), true, `${i + 1}`);
  }
  assert.equal(await takeRequest(db, SIGNIN_CODE_LIMITS, '203.0.113.9', new Date(midnight + 30 * 11 * 60 * 1000)), false);
  assert.equal(await takeRequest(db, SIGNIN_CODE_LIMITS, '203.0.113.9', new Date(midnight + 25 * 60 * 60 * 1000)), true, 'the next day');
  await purgeRequestLimits(db, new Date(midnight + 4 * 24 * 60 * 60 * 1000));
  assert.equal(await count(db, 'request_limit'), 0, 'old counters are purged');
});

test('a request the daily limit refuses stores no code', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) statuses.push((await post(base, '/signin/otp', { contact: 'cap@example.com' })).status);
      assert.deepEqual(statuses, [303, 303, 303, 303, 303, 429, 429]);
      assert.equal(relay.emails.length, 5);
      assert.equal(await count(db, "otp_code where email = 'cap@example.com'"), 5, 'one stored code per email sent');
      assert.equal(await count(db, "otp_code where email = 'cap@example.com' and consumed_at is null and expires_at > now()"), 1);
      const last = emailedCode(relay.emails[4].subject);
      assert.equal((await post(base, '/signin/verify', { to: 'cap@example.com', code: last, name: 'Cap' })).status, 303);
    });
  });
});

test('when the relay\'s own limits refuse a code, the page says to try later and no code is stored', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    relay.limited.sms = true;
    relay.limited.email = true;
    await withServer(async (base) => {
      for (const contact of ['5550202020', 'busy@example.com']) {
        const res = await post(base, '/signin/otp', { contact });
        assert.equal(res.status, 429, contact);
        assert.match(await res.text(), /We can&#39;t send codes right now\. Try again in a few minutes\.|We can't send codes right now\. Try again in a few minutes\./);
      }
      const { cookie } = await emailCoachWithSchedule(db);
      const add = await post(base, '/app/phone', { phone: '5550303030', sms_consent: '1' }, { cookie });
      assert.equal(add.headers.get('location'), '/app/schedule?phone=busy');
      assert.match(await (await fetch(`${base}/app/schedule?phone=busy`, { headers: { cookie } })).text(), /Try again in a few minutes/);
    });
    assert.equal(await count(db, 'otp_code'), 0);
    const logged = await db.query<{ channel: string; status: string }>("select channel, status from message_log where template = 'otp' order by id");
    assert.deepEqual(logged.rows, [
      { channel: 'sms', status: 'capped-relay' },
      { channel: 'email', status: 'capped-relay' },
      { channel: 'sms', status: 'capped-relay' },
    ]);
  });
});

test('the single send paths report the relay\'s 429 as busy instead of throwing', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15550404040');
    relay.limited.sms = true;
    relay.limited.email = true;
    assert.equal(await sendText(db, { to: '+15550404040', body: 'Reminder', coachId: null, template: 'reminder' }), 'busy');
    assert.equal(await sendEmailMessage(db, { to: 'a@example.com', subject: 'Hi', text: 'Hi', coachId: null, template: 'note' }), 'busy');
    relay.limited.sms = false;
    assert.equal(await sendText(db, { to: '+15550404040', body: 'Reminder', coachId: null, template: 'reminder' }), 'sent');
  });
});

// ---- consent and opt-outs ---------------------------------------------------

test('a number that texted STOP gets no code, is told to reply START, and stays opted out', async () => {
  await withSmsNumber(async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const stopped = '+15556667777';
      await grantSmsConsent(db, stopped);
      await revokeConsent(db, stopped);
      await withServer(async (base) => {
        const res = await post(base, '/signin/otp', { contact: '5556667777', sms_consent: '1' });
        assert.equal(res.status, 422);
        assert.match(await res.text(), /Reply START to \(833\) 364-5083 first, or use your email\./);
      });
      assert.equal(await isOptedOut(db, stopped), true);
      assert.equal(await hasActiveConsent(db, stopped), false);
      assert.equal(relay.sms.length, 0);
      assert.equal(await count(db, 'otp_code'), 0);
    });
  });
});

test('the texts box at sign-in is not recorded for a code nobody enters', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await withServer(async (base) => {
      assert.equal((await post(base, '/signin/otp', { contact: '5557778888', sms_consent: '1' })).status, 303);
    });
    assert.equal(await count(db, "sms_consent where phone = '+15557778888'"), 0);
  });
});

test('adding a mobile records the texts box only once its code is entered, and an opted-out mobile is told to reply START', async () => {
  await withSmsNumber(async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const { cookie } = await emailCoachWithSchedule(db);
      await grantSmsConsent(db, '+15550006666');
      await revokeConsent(db, '+15550006666');
      await withServer(async (base) => {
        const stopped = await post(base, '/app/phone', { phone: '5550006666', sms_consent: '1' }, { cookie });
        assert.equal(stopped.headers.get('location'), '/app/schedule?phone=stopped');
        assert.match(await (await fetch(`${base}/app/schedule?phone=stopped`, { headers: { cookie } })).text(), /Reply START to \(833\) 364-5083 first\./);
        assert.equal(await isOptedOut(db, '+15550006666'), true);

        await post(base, '/app/phone', { phone: '5550005555', sms_consent: '1' }, { cookie });
        assert.equal(await hasActiveConsent(db, '+15550005555'), false, 'not before the code');
        const code = textedCode(relay.sms.at(-1)!.body);
        const done = await post(base, '/app/phone/verify', { phone: '+15550005555', code }, { cookie, 'x-forwarded-for': '203.0.113.20' });
        assert.equal(done.headers.get('location'), '/app/schedule?phone=done');
        assert.equal(await hasActiveConsent(db, '+15550005555'), true);
        const proof = await db.query<{ source: string; ip: string }>("select source, ip from sms_consent where phone = '+15550005555'");
        assert.deepEqual(proof.rows[0], { source: '/app/phone', ip: '203.0.113.20' });
      });
      assert.equal(relay.sms.filter((m) => m.to === '+15550006666').length, 0);
    });
  });
});

test('/sms cannot undo a STOP, and opt-ins from one address are limited', async () => {
  await withSmsNumber(async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      await grantSmsConsent(db, '+15550007070');
      await revokeConsent(db, '+15550007070');
      await withServer(async (base) => {
        const stopped = await post(base, '/sms', { phone: '5550007070', sms_consent: '1' });
        assert.equal(stopped.status, 422);
        assert.match(await stopped.text(), /Reply START to \(833\) 364-5083 to opt back in\./);
        assert.equal(await isOptedOut(db, '+15550007070'), true);

        for (let i = 0; i < 5; i += 1) {
          assert.equal((await post(base, '/sms', { phone: `214555${2000 + i}`, sms_consent: '1' }, from('203.0.113.30'))).status, 200);
        }
        const limited = await post(base, '/sms', { phone: '2145552999', sms_consent: '1' }, from('203.0.113.30'));
        assert.equal(limited.status, 429);
        assert.match(await limited.text(), /Too many tries/);
        assert.equal(await hasActiveConsent(db, '+12145552999'), false);
      });
      assert.equal(relay.sms.length, 5, 'one confirmation per accepted opt-in');
    });
  });
});

test('the texts box on the booking form records consent but cannot undo a STOP', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    await grantSmsConsent(db, '+15550008080');
    await revokeConsent(db, '+15550008080');
    await withServer(async (base) => {
      for (const phone of ['5550008080', '5550008181']) {
        const res = await post(base, `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
          athlete_name: 'Sam',
          contact_phone: phone,
          sms_consent: '1',
        });
        assert.equal(res.status, 303);
      }
    });
    assert.equal(await isOptedOut(db, '+15550008080'), true, 'still opted out');
    assert.equal(await hasActiveConsent(db, '+15550008080'), false);
    assert.equal(await hasActiveConsent(db, '+15550008181'), true, 'a number that never said STOP opts in');
  });
});

test('/sms still opts in when the relay is too busy to send the confirmation', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    relay.limited.sms = true;
    await withServer(async (base) => {
      const res = await post(base, '/sms', { phone: '2145550123', sms_consent: '1' });
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.match(page, /You&#39;re opted in\.|You're opted in\./);
      assert.doesNotMatch(page, /We texted/);
    });
    assert.equal(await hasActiveConsent(db, '+12145550123'), true);
  });
});

test('the landing page\'s week box is limited per address', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      for (let i = 0; i < 30; i += 1) {
        assert.equal((await post(base, '/start', { text: 'Tuesdays at 6' }, from('203.0.113.40'))).status, 303);
      }
      const limited = await post(base, '/start', { text: 'Tuesdays at 6' }, from('203.0.113.40'));
      assert.equal(limited.status, 429);
      assert.match(await limited.text(), /Too many tries/);
      assert.equal((await post(base, '/start', { text: 'Tuesdays at 6' }, from('203.0.113.41'))).status, 303);
    });
  });
});
