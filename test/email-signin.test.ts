import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { seedBookedSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { createCoach, createCoachSession, parseContact } from '../src/domain/auth.js';
import { checkOverflow } from '../src/domain/cascade.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import type { DbClient } from '../src/db/client.js';

function cookieFrom(res: Response, name: string): string | null {
  const header = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`));
  const match = header ? /^[^=]+=([^;]*)/.exec(header) : null;
  return match ? `${name}=${match[1]}` : null;
}

function post(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function codeIn(subject: string): string {
  const m = /(\d{6})/.exec(subject);
  assert.ok(m, `no code in ${subject}`);
  return m[1];
}

async function count(db: DbClient, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params)).rows[0].n);
}

/** A coach who joined by email: no phone, a session that is full, one waiting. */
async function seedEmailCoachWithFullSession(db: DbClient) {
  const coach = await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana Keeper', tz: 'America/Chicago' });
  const type = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Keeper Group', 60, 1, 3500, true) returning id`,
    [coach.id],
  );
  const session = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status) values ($1, $2, 'America/Chicago', 'scheduled') returning id`,
    [type.rows[0].id, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()],
  );
  const sessionId = session.rows[0].id;
  await seedBookedSession(db, sessionId, 'Sam Reyes', '+15550000001');
  await seedWaitlistEntry(db, sessionId, 'Mia Ortiz', '+15550000002');
  return { coach, sessionId };
}

test('parseContact reads an email or a mobile from one box', () => {
  assert.deepEqual(parseContact('  Dana@Example.COM '), { kind: 'email', email: 'dana@example.com' });
  assert.deepEqual(parseContact('(555) 555-0100'), { kind: 'phone', phone: '+15555550100' });
  assert.deepEqual(parseContact('+44 7700 900123'), { kind: 'phone', phone: '+447700900123' });
  assert.equal(parseContact('dana@'), null);
  assert.equal(parseContact('hello'), null);
});

test('a coach joins with just an email: code by email, no phone needed', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const form = await (await fetch(`${base}/signin`)).text();
      assert.match(form, /Email or mobile number/);
      assert.match(form, /name="contact"/);

      const ask = await post(base, '/signin/otp', { contact: '  Dana@Example.com ' });
      assert.equal(ask.status, 303);
      assert.equal(ask.headers.get('location'), '/signin/verify?to=dana%40example.com');
      assert.equal(relay.sms.length, 0, 'an email join sends no text');
      assert.equal(relay.emails.length, 1);
      const sent = relay.emails[0];
      assert.equal(sent.to, 'dana@example.com');
      assert.equal(sent.fromName, 'Coachatron');
      assert.equal(sent.from, null, 'the relay default sender until COACHATRON_EMAIL_FROM is set');
      assert.match(sent.subject, /^Your Coachatron code: \d{6}$/);
      assert.doesNotMatch(sent.text, /https?:\/\//, 'a code, never a link');

      const verifyPage = await (await fetch(`${base}${ask.headers.get('location')}`)).text();
      assert.match(verifyPage, /We emailed a 6-digit code to dana@example\.com/);
      assert.doesNotMatch(verifyPage, /Email \(optional\)/);

      const done = await post(base, '/signin/verify', {
        to: 'dana@example.com',
        code: codeIn(sent.subject),
        name: 'Dana Keeper',
        tz: 'America/Denver',
      });
      assert.equal(done.status, 303);
      const session = cookieFrom(done, 'cx_session');
      assert.ok(session);
      assert.match((done.headers.getSetCookie?.() ?? []).join('\n'), /HttpOnly; Secure; SameSite=Lax/);

      const coach = await db.query<{ email: string; phone: string | null; tz: string }>('select email, phone, tz from coach');
      assert.deepEqual(coach.rows, [{ email: 'dana@example.com', phone: null, tz: 'America/Denver' }]);
      const logged = await db.query<{ channel: string; status: string }>("select channel, status from message_log where template = 'otp'");
      assert.deepEqual(logged.rows, [{ channel: 'email', status: 'sent' }]);

      // Coming back with different capitals signs in to the same coach.
      await post(base, '/signin/otp', { contact: 'DANA@example.com' });
      const again = await post(base, '/signin/verify', { to: 'dana@example.com', code: codeIn(relay.emails[1].subject) });
      assert.equal(again.status, 303);
      assert.equal(await count(db, 'coach'), 1);
    });
  });
});

test('COACHATRON_EMAIL_FROM switches the sender', async () => {
  const prev = process.env.COACHATRON_EMAIL_FROM;
  process.env.COACHATRON_EMAIL_FROM = 'no-reply@coachatron.com';
  try {
    await withRelay(async (relay) => {
      await freshDb();
      await withServer(async (base) => {
        await post(base, '/signin/otp', { contact: 'dana@example.com' });
        assert.equal(relay.emails[0].from, 'no-reply@coachatron.com');
      });
    });
  } finally {
    if (prev === undefined) delete process.env.COACHATRON_EMAIL_FROM;
    else process.env.COACHATRON_EMAIL_FROM = prev;
  }
});

test('a foreign mobile is pointed to email; codes are capped and single-use', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const abroad = await post(base, '/signin/otp', { contact: '+63 917 123 4567' });
      assert.equal(abroad.status, 422);
      assert.match(await abroad.text(), /Use your email instead/);
      assert.equal(relay.sms.length, 0);

      const bad = await post(base, '/signin/otp', { contact: 'not an address' });
      assert.equal(bad.status, 422);

      for (let i = 0; i < 5; i += 1) assert.equal((await post(base, '/signin/otp', { contact: 'cap@example.com' })).status, 303);
      const sixth = await post(base, '/signin/otp', { contact: 'cap@example.com' });
      assert.equal(sixth.status, 429);
      assert.match(await sixth.text(), /Too many codes for this email/);
      assert.equal(relay.emails.length, 5);

      const wrong = await post(base, '/signin/verify', { to: 'cap@example.com', code: '000000', name: 'Cap' });
      assert.equal(wrong.status, 401);
      const code = codeIn(relay.emails[4].subject);
      assert.equal((await post(base, '/signin/verify', { to: 'cap@example.com', code, name: 'Cap' })).status, 303);
      assert.equal((await post(base, '/signin/verify', { to: 'cap@example.com', code })).status, 401, 'a code works once');
    });
  });
});

test('a phone join cannot claim an email another coach already has', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana', tz: 'America/Chicago' });
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: '5550007777' });
      const code = /code is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
      const res = await post(base, '/signin/verify', { to: '+15550007777', code, name: 'Other', email: 'DANA@example.com' });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /already has an account/);
      assert.equal(await count(db, 'coach'), 1);
    });
  });
});

test('the landing box plus an email join leads to a draft and Publish', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    setComplete(
      fakeComplete({
        coach_timezone: null,
        session_types: [{ key: 'g', name: 'Evening group', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: null }],
        weekly: [{ type_key: 'g', weekday: 2, time_local: '18:00', location: null }],
        packages: [],
        plans: [],
      }),
    );
    try {
      await withServer(async (base) => {
        const start = await post(base, '/start', { text: 'Tuesdays at 6, an hour, 8 athletes, $35' });
        const startCookie = cookieFrom(start, 'cx_start')!;
        const signin = await (await fetch(`${base}/signin`, { headers: { cookie: startCookie } })).text();
        assert.match(signin, /Saved\. Now your email or mobile/);

        await post(base, '/signin/otp', { contact: 'alex@example.com' }, startCookie);
        const verify = await post(
          base,
          '/signin/verify',
          { to: 'alex@example.com', code: codeIn(relay.emails[0].subject), name: 'Alex Coach', tz: 'America/Chicago' },
          startCookie,
        );
        assert.equal(verify.headers.get('location'), '/app/schedule?setup=1');
        const session = cookieFrom(verify, 'cx_session')!;
        const draftId = String((await db.query<{ id: number }>('select id from setup_draft')).rows[0].id);
        const published = await post(base, '/app/setup/publish', { id: draftId }, session);
        assert.equal(published.headers.get('location'), '/app/schedule?published=1');
        assert.ok((await count(db, 'session')) >= 8);
      });
    } finally {
      resetComplete();
    }
  });
});

test('a coach with no phone gets the overflow question by email and answers it on the schedule', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, sessionId } = await seedEmailCoachWithFullSession(db);
    const backup = await seedRosterMember(db, coach.id, 'Backup Bailey', 0);
    const outsider = await createCoach(db, { phone: '+15550009999', email: '', name: 'Outsider', tz: 'America/Chicago' });

    await checkOverflow(db, sessionId);
    assert.equal(relay.sms.length, 0, 'no text to a coach with no phone');
    const ask = relay.emails.find((e) => e.to === 'dana@example.com');
    assert.ok(ask);
    assert.match(ask.subject, /Keeper Group is full, 1 waiting/);
    assert.match(ask.text, /\/app\/schedule/);
    assert.doesNotMatch(ask.text, /Reply YES/);

    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /Ask my roster/);
      assert.match(schedule, new RegExp(`action="/app/overflow/${sessionId}"`));

      // Another coach cannot answer this coach's question.
      const other = `cx_session=${await createCoachSession(db, outsider.id)}`;
      await post(base, `/app/overflow/${sessionId}`, { answer: 'yes' }, other);
      assert.equal(relay.sms.filter((m) => m.to === backup.phone).length, 0);

      const yes = await post(base, `/app/overflow/${sessionId}`, { answer: 'yes' }, cookie);
      assert.equal(yes.status, 303);
      assert.equal(relay.sms.filter((m) => m.to === backup.phone).length, 1, 'the roster is asked after the coach says yes');
      const after = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.doesNotMatch(after, /Ask my roster/);
    });
  });
});

test('a coach who joined by email adds a mobile with a text code', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await seedEmailCoachWithFullSession(db);
    await createCoach(db, { phone: '+15550004444', email: '', name: 'Taken', tz: 'America/Chicago' });
    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /Your mobile \(US or Canada\)/);

      assert.equal((await post(base, '/app/phone', { phone: '+44 7700 900123' }, cookie)).headers.get('location'), '/app/schedule?phone=bad');

      const sent = await post(base, '/app/phone', { phone: '(555) 000-3333' }, cookie);
      assert.equal(sent.headers.get('location'), '/app/schedule?phone=sent&to=%2B15550003333');
      const code = /is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
      const wrong = await post(base, '/app/phone/verify', { phone: '+15550003333', code: '000000' }, cookie);
      assert.equal(wrong.headers.get('location'), '/app/schedule?phone=wrong&to=%2B15550003333');
      const ok = await post(base, '/app/phone/verify', { phone: '+15550003333', code }, cookie);
      assert.equal(ok.headers.get('location'), '/app/schedule?phone=done');
      assert.equal((await db.query<{ phone: string }>('select phone from coach where id = $1', [coach.id])).rows[0].phone, '+15550003333');
      const done = await (await fetch(`${base}/app/schedule?phone=done`, { headers: { cookie } })).text();
      assert.match(done, /Texts about your sessions will go to \+15550003333/);
      assert.doesNotMatch(done, /Your mobile \(US or Canada\)/);

      // A number that belongs to another coach is refused.
      const second = await createCoach(db, { phone: null, email: 'sam@example.com', name: 'Sam', tz: 'America/Chicago' });
      const secondCookie = `cx_session=${await createCoachSession(db, second.id)}`;
      await post(base, '/app/phone', { phone: '5550004444' }, secondCookie);
      const takenCode = /is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
      const taken = await post(base, '/app/phone/verify', { phone: '+15550004444', code: takenCode }, secondCookie);
      assert.equal(taken.headers.get('location'), '/app/schedule?phone=taken');
    });
  });
});
