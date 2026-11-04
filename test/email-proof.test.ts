import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { createCoach, findCoachById } from '../src/domain/auth.js';
import { createStartLink } from '../src/domain/startLink.js';
import { runMigrations } from '../src/db/migrate.js';
import type { DbClient } from '../src/db/client.js';

/** An email typed during a phone sign-up is a way to reach the coach, not a
 * way in, until a code sent to it is entered. */

function post(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

const emailedCode = (subject: string) => /(\d{6})/.exec(subject)![1];

function sessionCookie(res: Response): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('cx_session='));
  assert.ok(header, 'a session cookie');
  return /^([^;]*)/.exec(header)![1];
}

async function coachOf(db: DbClient, cookie: string): Promise<number> {
  const token = cookie.slice('cx_session='.length);
  return (await db.query<{ coach_id: number }>('select coach_id from coach_session where token = $1', [token])).rows[0].coach_id;
}

/** Joins by text with an optional email; returns the new coach's cookie. */
async function joinByPhone(base: string, relay: { sms: Array<{ body: string }> }, phone: string, email: string): Promise<string> {
  await post(base, '/signin/otp', { contact: phone });
  const code = /code is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
  const joined = await post(base, '/signin/verify', { to: phone, code, name: 'Pat Coach', email });
  assert.equal(joined.status, 303);
  return sessionCookie(joined);
}

async function giveAWeek(db: DbClient, coachId: number): Promise<void> {
  const type = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Evening group', 60, 8, 3500, true) returning id`,
    [coachId],
  );
  await db.query(`insert into session (session_type_id, starts_at_utc, tz, status) values ($1, $2, 'America/Chicago', 'scheduled')`, [
    type.rows[0].id,
    new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  ]);
}

test('an email typed during a phone sign-up does not open that account by email', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const phoneCoach = await coachOf(db, await joinByPhone(base, relay, '+15550101010', 'pat@example.com'));
      assert.equal((await findCoachById(db, phoneCoach))?.email_verified, false);

      await post(base, '/signin/otp', { contact: 'pat@example.com' });
      const code = emailedCode(relay.emails.at(-1)!.subject);
      const noName = await post(base, '/signin/verify', { to: 'pat@example.com', code });
      assert.equal(noName.status, 422);
      assert.match(await noName.text(), /isn&#39;t confirmed on an account yet|isn't confirmed on an account yet/);
      assert.equal(noName.headers.getSetCookie().length, 0, 'no session for the phone account');

      const named = await post(base, '/signin/verify', { to: 'pat@example.com', code, name: 'Email Owner' });
      assert.equal(named.status, 303);
      const emailCoach = await coachOf(db, sessionCookie(named));
      assert.notEqual(emailCoach, phoneCoach, 'the person who proved the email gets their own account');
      assert.deepEqual(
        { email: (await findCoachById(db, emailCoach))?.email, verified: (await findCoachById(db, emailCoach))?.email_verified },
        { email: 'pat@example.com', verified: true },
      );
      assert.equal((await findCoachById(db, phoneCoach))?.email, '', 'the unconfirmed copy comes off the phone account');
    });
  });
});

test('a coach confirms a typed email with an emailed code, then signs in with it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const cookie = await joinByPhone(base, relay, '+15550202020', 'sam@example.com');
      const coachId = await coachOf(db, cookie);
      await giveAWeek(db, coachId);

      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /Confirm sam@example\.com to sign in with it too/);
      assert.match(schedule, /action="\/app\/email"/);

      const sent = await post(base, '/app/email', {}, cookie);
      assert.equal(sent.headers.get('location'), '/app/schedule?email=sent');
      assert.equal(relay.emails.at(-1)!.to, 'sam@example.com');
      const code = emailedCode(relay.emails.at(-1)!.subject);
      assert.match(await (await fetch(`${base}/app/schedule?email=sent`, { headers: { cookie } })).text(), /action="\/app\/email\/verify"/);

      const wrong = await post(base, '/app/email/verify', { code: code === '111111' ? '222222' : '111111' }, cookie);
      assert.equal(wrong.headers.get('location'), '/app/schedule?email=wrong');
      const right = await post(base, '/app/email/verify', { code }, cookie);
      assert.equal(right.headers.get('location'), '/app/schedule?email=done');
      assert.equal((await findCoachById(db, coachId))?.email_verified, true);
      const done = await (await fetch(`${base}/app/schedule?email=done`, { headers: { cookie } })).text();
      assert.match(done, /You can sign in with sam@example\.com too/);
      assert.doesNotMatch(done, /action="\/app\/email"/);

      await post(base, '/signin/otp', { contact: 'sam@example.com' });
      const signIn = await post(base, '/signin/verify', { to: 'sam@example.com', code: emailedCode(relay.emails.at(-1)!.subject) });
      assert.equal(signIn.status, 303);
      assert.equal(await coachOf(db, sessionCookie(signIn)), coachId, 'the same account');
    });
  });
});

test('an email already on another account cannot be typed at a phone sign-up, proved or not', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana', tz: 'America/Chicago' });
    await createCoach(db, { phone: '+15550303030', email: 'lee@example.com', name: 'Lee', tz: 'America/Chicago' });
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: '5550404040' });
      const code = /code is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
      const proved = await post(base, '/signin/verify', { to: '+15550404040', code, name: 'Other', email: 'Dana@example.com' });
      assert.equal(proved.status, 422);
      assert.match(await proved.text(), /That email already has an account\. Sign in with it instead\./);
      const unproved = await post(base, '/signin/verify', { to: '+15550404040', code, name: 'Other', email: 'lee@example.com' });
      assert.equal(unproved.status, 422);
      assert.match(await unproved.text(), /That email is already on another account\. Leave it out, or use a different one\./);
      assert.equal((await post(base, '/signin/verify', { to: '+15550404040', code, name: 'Other' })).status, 303, 'without it the join goes through');
    });
    assert.equal(Number((await db.query<{ n: string }>('select count(*)::text as n from coach')).rows[0].n), 3);
  });
});

test('a start link with an email already on another account says so and keeps the link', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'taken@example.com', name: 'Taken', tz: 'America/Chicago' });
    const token = await createStartLink(db, '+15553334444', 'Tuesdays at 6, 60 min, 8 kids, $35');
    await withServer(async (base) => {
      const res = await post(base, `/start/${token}`, { name: 'New Coach', email: 'taken@example.com' });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /That email already has an account/);
      assert.equal((await fetch(`${base}/start/${token}`)).status, 200, 'the link still works');

      const joined = await post(base, `/start/${token}`, { name: 'New Coach', email: 'new@example.com' });
      assert.equal(joined.status, 303);
    });
    const row = await db.query<{ email: string; verified: boolean }>(
      "select email, email_verified_at is not null as verified from coach where phone = '+15553334444'",
    );
    assert.deepEqual(row.rows[0], { email: 'new@example.com', verified: false }, 'typed, not proved');
  });
});

test('existing coaches who joined by email, or entered an emailed code, keep email sign-in', async () => {
  const db = await freshDb();
  await db.query(`insert into coach (handle, name, email, phone, tz) values
    ('a', 'A', 'a@example.com', null, 'America/Chicago'),
    ('b', 'B', 'b@example.com', '+15550000101', 'America/Chicago'),
    ('c', 'C', 'c@example.com', '+15550000102', 'America/Chicago'),
    ('d', 'D', '', '+15550000103', 'America/Chicago')`);
  await db.query(`insert into otp_code (email, code_hash, expires_at, consumed_at) values
    ('b@example.com', 'x', now(), now()),
    ('c@example.com', 'y', now(), null)`);
  await db.query("delete from schema_migrations where name = '0014_coach_email_verified.sql'");
  await runMigrations(db);
  const rows = await db.query<{ handle: string; verified: boolean }>(
    'select handle, email_verified_at is not null as verified from coach order by handle',
  );
  assert.deepEqual(rows.rows, [
    { handle: 'a', verified: true },
    { handle: 'b', verified: true },
    { handle: 'c', verified: false },
    { handle: 'd', verified: false },
  ]);
});
