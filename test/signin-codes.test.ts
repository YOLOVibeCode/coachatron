import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { checkOtp, consumeOtp, createCoach, createCoachSession, createOtp } from '../src/domain/auth.js';
import { isOptedOut } from '../src/domain/cascade.js';
import { sendEmailMessage, sendText } from '../src/domain/outbound.js';
import { grantSmsConsent, hasActiveConsent, revokeConsent } from '../src/domain/sms-consent.js';
import { purgeRequestLimits, SIGNIN_CODE_LIMITS, takeRequest } from '../src/domain/requestLimits.js';
import { setDb, type DbClient } from '../src/db/client.js';

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
      await post(base, '/signin/otp', { contact: 'sam@example.com' });
      const first = emailedCode(relay.emails[0].subject);
      for (let i = 0; i < 15; i += 1) {
        const res = await post(base, '/signin/verify', { to: 'sam@example.com', code: wrong(first, i + 1) }, from(`198.51.100.${i}`));
        assert.equal(res.status, 401, `check ${i + 1}`);
      }
      await post(base, '/signin/otp', { contact: 'sam@example.com' });
      const code = emailedCode(relay.emails[1].subject);
      const paused = await post(base, '/signin/verify', { to: 'sam@example.com', code, name: 'Sam' }, from('198.51.100.200'));
      assert.equal(paused.status, 429);
      assert.match(await paused.text(), /Too many tries\. Try again in an hour\./);
      assert.equal((await post(base, '/signin/verify', { to: 'other@example.com', code: '000000' })).status, 401, 'another email is not paused');
    });
  });
});

test('checks for an email with no code out do not hold back the next code asked for', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      for (let i = 0; i < 20; i += 1) {
        assert.equal((await post(base, '/signin/verify', { to: 'sam@example.com', code: '000000' }, from(`198.51.100.${i}`))).status, 401);
      }
      assert.equal(await count(db, "request_limit where key = 'email:sam@example.com'"), 0, 'nothing counted for the email');
      await post(base, '/signin/otp', { contact: 'sam@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      assert.equal((await post(base, '/signin/verify', { to: 'sam@example.com', code, name: 'Sam' }, from('198.51.100.200'))).status, 303);
    });
  });
});

/** The app's database, except that each request whose code is accepted
 * waits there until `n` requests have had theirs accepted (or two seconds
 * pass), as when the same code is sent several times at once. */
function holdAcceptedCodes(db: DbClient, n: number): DbClient {
  let held: Array<() => void> = [];
  const releaseAll = () => {
    for (const release of held) release();
    held = [];
  };
  return {
    query: async <T>(sql: string, params?: unknown[]) => {
      const result = await db.query<T>(sql, params);
      if (sql.includes('attempts = attempts - 1')) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
          if (held.length >= n) releaseAll();
          else setTimeout(releaseAll, 2000).unref();
        });
      }
      return result;
    },
  };
}

test('the same right code sent several times at once signs up only once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: 'pat@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      setDb(holdAcceptedCodes(db, 3));
      const answers = await Promise.all(
        Array.from({ length: 3 }, () => post(base, '/signin/verify', { to: 'pat@example.com', code, name: 'Pat' })),
      );
      setDb(db);
      assert.deepEqual(answers.map((res) => res.status).sort(), [303, 401, 401]);
      for (const res of answers.filter((r) => r.status === 401)) {
        assert.match(await res.text(), /Invalid or expired code/);
        assert.equal(res.headers.getSetCookie().length, 0);
      }
    });
    assert.equal(await count(db, 'coach'), 1);
    assert.equal(await count(db, 'coach_session'), 1);
  });
});

test('the same right code for an existing coach sent several times at once signs in only once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana', tz: 'America/Chicago' });
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: 'dana@example.com' });
      const code = emailedCode(relay.emails[0].subject);
      setDb(holdAcceptedCodes(db, 3));
      const answers = await Promise.all(Array.from({ length: 3 }, () => post(base, '/signin/verify', { to: 'dana@example.com', code })));
      setDb(db);
      assert.deepEqual(answers.map((res) => res.status).sort(), [303, 401, 401]);
    });
    assert.equal(await count(db, 'coach_session'), 1);
  });
});

test('a code accepted by two checks is used up by the first', async () => {
  const db = await freshDb();
  const contact = { kind: 'email', email: 'lee@example.com' } as const;
  const code = await createOtp(db, contact);
  const first = await checkOtp(db, contact, code);
  const second = await checkOtp(db, contact, code);
  if (!first.ok || !second.ok) assert.fail('both checks accept the code');
  assert.equal(await consumeOtp(db, first.id), true);
  assert.equal(await consumeOtp(db, second.id), false);
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
      assert.match(await refused.text(), /Too many codes asked for from here\. Try again later\./);
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

test('adding a mobile or confirming an email says when too many codes were asked for from one address', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { cookie } = await emailCoachWithSchedule(db);
    const phoneCoach = await seedCoachWithSession(db);
    await db.query('update coach set email_verified_at = null where id = $1', [phoneCoach.coach.id]);
    const phoneCookie = `cx_session=${await createCoachSession(db, phoneCoach.coach.id)}`;
    // Over both the ten-minute and the daily limit, so a window ending mid-test changes nothing.
    for (let i = 0; i < 30; i += 1) await takeRequest(db, SIGNIN_CODE_LIMITS, '203.0.113.60');
    await withServer(async (base) => {
      const phone = await post(base, '/app/phone', { phone: '5550003434', sms_consent: '1' }, { cookie, ...from('203.0.113.60') });
      assert.equal(phone.headers.get('location'), '/app/schedule?phone=wait');
      const phonePage = await (await fetch(`${base}/app/schedule?phone=wait`, { headers: { cookie } })).text();
      assert.match(phonePage, /Too many codes asked for from here\. Try again later\./);
      assert.match(phonePage, /action="\/app\/phone"/, 'the form to ask again');

      const email = await post(base, '/app/email', {}, { cookie: phoneCookie, ...from('203.0.113.60') });
      assert.equal(email.headers.get('location'), '/app/schedule?email=wait');
      const emailPage = await (await fetch(`${base}/app/schedule?email=wait`, { headers: { cookie: phoneCookie } })).text();
      assert.match(emailPage, /Too many codes asked for from here\. Try again later\./);
    });
    assert.equal(relay.sms.length + relay.emails.length, 0);
  });
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
      // A text code that cannot go now points to email, which may still work.
      const text = await post(base, '/signin/otp', { contact: '5550202020' });
      assert.equal(text.status, 429);
      assert.match(await text.text(), /We can(&#39;|')t text codes right now\. Try again later, or use your email instead\./);
      const email = await post(base, '/signin/otp', { contact: 'busy@example.com' });
      assert.equal(email.status, 429);
      assert.match(await email.text(), /We can(&#39;|')t send codes right now\. Try again in a few minutes\./);
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

test('a STOP texted after asking for a code stays in place when the code is entered', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: '5551212121', sms_consent: '1' });
      const code = textedCode(relay.sms[0].body);
      assert.equal((await postSignedSms(base, { From: '+15551212121', Body: 'STOP' })).status, 200);
      const joined = await post(base, '/signin/verify', { to: '+15551212121', code, name: 'Pat' });
      assert.equal(joined.status, 303, 'signing in still works');
    });
    assert.equal(await isOptedOut(db, '+15551212121'), true);
    assert.equal(await hasActiveConsent(db, '+15551212121'), false);
  });
});

test('a STOP texted after asking for a code to add a mobile stays in place when the code is entered', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await emailCoachWithSchedule(db);
    await withServer(async (base) => {
      await post(base, '/app/phone', { phone: '5551313131', sms_consent: '1' }, { cookie });
      const code = textedCode(relay.sms[0].body);
      assert.equal((await postSignedSms(base, { From: '+15551313131', Body: 'STOP' })).status, 200);
      const done = await post(base, '/app/phone/verify', { phone: '+15551313131', code }, { cookie });
      assert.equal(done.headers.get('location'), '/app/schedule?phone=done');
    });
    assert.equal((await db.query<{ phone: string | null }>('select phone from coach where id = $1', [coach.id])).rows[0].phone, '+15551313131');
    assert.equal(await isOptedOut(db, '+15551313131'), true);
    assert.equal(await hasActiveConsent(db, '+15551313131'), false);
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

test('waitlist joins from one address are limited', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    // Full, so there is a line to join.
    await seedBookedSession(db, seed.sessionId, 'Booked One', '+15550003900');
    await withServer(async (base) => {
      const join = (phone: string, address: string) =>
        post(base, `/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`, { athlete_name: 'Sam', contact_phone: phone }, from(address));
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await join(`214555${3000 + i}`, '203.0.113.70')).status, 200, `join ${i + 1}`);
      }
      const limited = await join('2145553999', '203.0.113.70');
      assert.equal(limited.status, 429);
      assert.match(await limited.text(), /Too many waitlist requests/);
      assert.equal(await count(db, 'waitlist where session_id = $1', [seed.sessionId]), 10);
      assert.equal((await join('2145553998', '203.0.113.71')).status, 200, 'another address is not limited');
    });
  });
});
