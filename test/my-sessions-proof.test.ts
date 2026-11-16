import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import {
  ask,
  emailedToken,
  enterCode,
  from,
  myCookie,
  openLink,
  proveMobile,
  sessionsPage,
  textedCode,
  useLink,
  visible,
} from './helpers/my-sessions.js';
import { createCoachSession, createOtp } from '../src/domain/auth.js';
import { segmentCount } from '../src/domain/outbound.js';
import { createCredit } from '../src/domain/pricing.js';
import { readMySessions, signMySessions } from '../src/domain/mySessionsProof.js';
import type { DbClient } from '../src/db/client.js';

/** The My sessions page shows one person's bookings to whoever proves the
 * email or mobile they were booked with. These tests are about the proof:
 * what is sent, what a code, a link and the cookie open, and what nobody
 * can learn by asking. */

const json = { 'content-type': 'application/json' };

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

const TEN_MINUTES = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Request limits count in fixed windows. Runs `fn` again, as a new attempt
 * with addresses and numbers of its own, until it starts and ends inside one
 * window, so a window ending mid-test changes nothing. `fn` returns what it
 * saw; the test asserts on that afterwards. */
async function inOneWindow<T>(windowMs: number, fn: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const window = Math.floor(Date.now() / windowMs);
    const seen = await fn(attempt);
    if (Math.floor(Date.now() / windowMs) === window) return seen;
  }
}

/** A six-digit code that is not `code`. */
function wrong(code: string, n = 1): string {
  return String((Number(code) + n) % 1_000_000).padStart(6, '0');
}

/** A page with the contact it was asked about taken out, so two contacts'
 * pages can be compared word for word. */
function without(page: string, ...contacts: string[]): string {
  return contacts.reduce((text, contact) => text.split(contact).join('<contact>'), page);
}

test('asking answers a contact with bookings and one without them with the same page, and sends to both', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const booking = await seedBookedSession(db, seed.sessionId, 'Mia', '+15551110001');
    await db.query("update booking set contact_email = 'known@example.com' where id = $1", [booking]);
    await withServer(async (base) => {
      const known = await ask(base, '(555) 111-0001');
      const unknown = await ask(base, '(555) 111-0002');
      assert.equal(known.status, 200);
      assert.equal(unknown.status, known.status);
      assert.equal(
        without(await unknown.text(), '+15551110002', '(555) 111-0002'),
        without(await known.text(), '+15551110001', '(555) 111-0001'),
        'the page after a mobile is the same with and without bookings',
      );
      assert.deepEqual(relay.sms.map((m) => m.to).sort(), ['+15551110001', '+15551110002'], 'both numbers were texted a code');

      const knownEmail = await ask(base, 'known@example.com');
      const unknownEmail = await ask(base, 'nobody@example.com');
      assert.equal(knownEmail.status, 200);
      assert.equal(unknownEmail.status, knownEmail.status);
      assert.equal(
        without(await unknownEmail.text(), 'nobody@example.com'),
        without(await knownEmail.text(), 'known@example.com'),
        'the page after an email is the same with and without bookings',
      );
      assert.deepEqual(relay.emails.map((m) => m.to).sort(), ['known@example.com', 'nobody@example.com'], 'both addresses were sent a link');

      for (const res of [known, unknown, knownEmail, unknownEmail]) {
        assert.equal(myCookie(res), null, 'asking proves nothing');
        assert.deepEqual(res.headers.getSetCookie(), []);
      }
    });
  });
});

test('the code is one text the person asked for: its wording, one segment, and no consent needed', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const page = visible(await (await ask(base, '555-111-0003')).text());
      assert.match(page, /Enter your code If \(555\) 111-0003 can get our texts, a 6-digit code is on its way\. It lasts 10 minutes\./);
    });
    assert.equal(relay.sms.length, 1);
    const code = textedCode(relay, '+15551110003');
    assert.equal(relay.sms[0].body, `Coachatron: your code to see your sessions is ${code}. It expires in 10 minutes. Reply STOP to opt out.`);
    assert.equal(segmentCount(relay.sms[0].body), 1);
    const logged = await db.query<{ template: string; visitor: boolean; coach_id: number | null; status: string }>(
      "select template, visitor, coach_id, status from message_log where to_phone = '+15551110003'",
    );
    assert.deepEqual(logged.rows, [{ template: 'otp', visitor: true, coach_id: null, status: 'sent' }], 'logged, and counted as a visitor\'s text');
  });
});

test('what is typed is checked before anything is sent', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const form = await fetch(`${base}/my`);
      assert.equal(form.status, 200);
      const formHtml = await form.text();
      assert.match(formHtml, /<form method="post" action="\/my">/);
      assert.match(formHtml, /<label for="contact">The email or mobile you booked with<\/label>/);

      for (const typed of ['', 'not a contact', '12345', 'a@b', `${'x'.repeat(300)}@example.com`]) {
        const res = await ask(base, typed);
        assert.equal(res.status, 422, JSON.stringify(typed.slice(0, 20)));
        assert.match(visible(await res.text()), /Enter the email address or mobile number you booked with\./);
      }
      // Outside the US and Canada no text can go out, whoever the number is.
      const abroad = await ask(base, '+44 20 7946 0958');
      assert.equal(abroad.status, 422);
      assert.match(visible(await abroad.text()), /We text only US and Canadian mobile numbers\. Use the email you booked with instead\./);

      // A body that is not a form's (a number, a list) is a bad request, not a fault.
      for (const body of ['{"contact":["a@example.com","b@example.com"]}', '{"contact":5551110001}', '{"contact":{"a":1}}']) {
        const res = await fetch(`${base}/my`, { method: 'POST', headers: json, body });
        assert.equal(res.status, 422, body);
      }
    });
    assert.equal(relay.sms.length + relay.emails.length, 0);
  });
});

test('a texted code opens the page; a wrong, unknown, used, expired or worn-out code all get the same page', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await seedBookedSession(db, seed.sessionId, 'Mia', '+15551110010');
    await withServer(async (base) => {
      const strip = (page: string, digits: string) => without(page, `+1555111${digits}`, `(555) 111-${digits}`);

      await ask(base, '+15551110010');
      const code = textedCode(relay, '+15551110010');
      const wrongCode = await enterCode(base, '+15551110010', wrong(code));
      assert.equal(wrongCode.status, 401);
      assert.equal(myCookie(wrongCode), null);
      const refused = strip(await wrongCode.text(), '0010');
      assert.match(visible(refused), /That code didn't work\. Check it and try again, or ask for a new one\./);

      // A number nobody asked about: no code is out for it.
      const none = await enterCode(base, '+15551110011', '123456');
      assert.equal(none.status, 401);
      assert.equal(strip(await none.text(), '0011'), refused, 'no code out reads the same as a wrong code');

      // Not six digits at all.
      const shape = await enterCode(base, '+15551110010', 'abc');
      assert.equal(shape.status, 401);
      assert.equal(strip(await shape.text(), '0010'), refused);

      // The right code, with the space a phone's keyboard adds.
      const right = await enterCode(base, '+15551110010', `${code.slice(0, 3)} ${code.slice(3)}`);
      assert.equal(right.status, 303);
      assert.equal(right.headers.get('location'), '/my/sessions');
      const cookie = myCookie(right);
      assert.ok(cookie);
      assert.equal((await sessionsPage(base, cookie)).status, 200);

      const used = await enterCode(base, '+15551110010', code);
      assert.equal(used.status, 401, 'a code works once');
      assert.equal(myCookie(used), null);
      assert.equal(strip(await used.text(), '0010'), refused, 'a used code reads the same as a wrong one');

      await ask(base, '+15551110012');
      const late = textedCode(relay, '+15551110012');
      await db.query("update otp_code set expires_at = now() - interval '1 second' where phone = '+15551110012'");
      const expired = await enterCode(base, '+15551110012', late);
      assert.equal(expired.status, 401, 'a code lasts 10 minutes');
      assert.equal(strip(await expired.text(), '0012'), refused, 'an expired code reads the same as a wrong one');

      // Five wrong tries end a code, the limit sign-in codes have.
      await ask(base, '+15551110013');
      const worn = textedCode(relay, '+15551110013');
      for (let i = 1; i <= 5; i += 1) assert.equal((await enterCode(base, '+15551110013', wrong(worn, i))).status, 401);
      const tooLate = await enterCode(base, '+15551110013', worn);
      assert.equal(tooLate.status, 401, 'the right code no longer works after five wrong ones');
      assert.equal(strip(await tooLate.text(), '0013'), refused, 'a worn-out code reads the same as a wrong one');
    });
    const expiry = await db.query<{ minutes: number }>(
      "select round(extract(epoch from (expires_at - now())) / 60)::int as minutes from otp_code where phone = '+15551110013'",
    );
    assert.equal(expiry.rows[0].minutes, 10);
  });
});

test('a code works only for what it was sent for: sign-in and checkout codes do not open the page, and its code opens nothing else', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const phone = '+15551110020';
    await createCredit(db, seed.coach.id, phone, null, 'test', 2, null);
    await withServer(async (base) => {
      await createOtp(db, { kind: 'phone', phone }, { code: '111111', purpose: 'signin' });
      await createOtp(db, { kind: 'phone', phone }, { code: '222222', purpose: 'credits' });
      assert.equal((await enterCode(base, phone, '111111')).status, 401, 'a sign-in code does not open the page');
      assert.equal((await enterCode(base, phone, '222222')).status, 401, 'a checkout code does not open the page');

      await ask(base, phone);
      const code = textedCode(relay, phone);
      assert.ok(code !== '111111' && code !== '222222');

      // As a sign-in code: nobody is signed in and no coach is made.
      const signIn = await fetch(`${base}/signin/verify`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ to: phone, code, name: 'Not A Coach' }),
        redirect: 'manual',
      });
      assert.equal(signIn.status, 401);
      assert.deepEqual(signIn.headers.getSetCookie(), []);
      assert.equal((await db.query('select 1 from coach where phone = $1', [phone])).rows.length, 0);

      // As a checkout code: the booking's phone stays unproven.
      const booked = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', phone);
      assert.ok(booked.key);
      assert.equal((await postCheckout(base, seed.coach.handle, booked.key, { mode: 'verify_code', code })).status, 401);
      assert.equal((await postCheckout(base, seed.coach.handle, booked.key, { mode: 'credit' })).status, 403);

      // Asking for it ended neither of the other codes, and it still works here.
      const live = await db.query<{ purpose: string }>(
        'select purpose from otp_code where phone = $1 and consumed_at is null and expires_at > now() order by purpose',
        [phone],
      );
      assert.deepEqual(live.rows.map((r) => r.purpose), ['credits', 'sessions', 'signin']);
      assert.equal((await enterCode(base, phone, code)).status, 303);

      // Proving the mobile here proves nothing at checkout: credits there still ask for their own code.
      const again = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Sam', phone);
      assert.ok(again.key);
      assert.match(await (await fetch(`${base}/c/${seed.coach.handle}/checkout/${again.key}`)).text(), /Text me a code/);
    });
  });
});

test('an emailed link opens the page once, for 20 minutes, and a look at it does not use it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const asked = await ask(base, 'Pat@Example.com');
      assert.equal(asked.status, 200);
      assert.match(
        visible(await asked.text()),
        /Check your email If we can reach pat@example\.com, a link is on its way\. It works once and lasts 20 minutes\./,
      );
      assert.equal(relay.emails.length, 1);
      const email = relay.emails[0];
      assert.equal(email.to, 'pat@example.com');
      assert.equal(email.subject, 'Your link to see your Coachatron sessions');
      const token = emailedToken(relay, 'pat@example.com');
      assert.ok(email.text.includes(`/my/link?t=${token}`));
      assert.ok((email.html ?? '').includes(`/my/link?t=${token}`));
      assert.match(email.text, /It works once and expires in 20 minutes\./);

      // Only the token's hash is kept, and the log keeps the subject, never the link.
      const stored = await db.query<{ token_hash: string; minutes: number }>(
        'select token_hash, round(extract(epoch from (expires_at - now())) / 60)::int as minutes from my_sessions_link',
      );
      assert.equal(stored.rows.length, 1);
      assert.notEqual(stored.rows[0].token_hash, token);
      assert.equal(stored.rows[0].minutes, 20);
      const logged = await db.query<{ body: string; template: string }>("select body, template from message_log where channel = 'email'");
      assert.deepEqual(logged.rows, [{ body: 'Your link to see your Coachatron sessions', template: 'otp' }]);

      // A mail program that opens the link ahead of the reader leaves it working.
      for (let i = 0; i < 2; i += 1) {
        const looked = await openLink(base, token);
        assert.equal(looked.status, 200);
        assert.deepEqual(looked.headers.getSetCookie(), [], 'looking proves nothing');
        const html = await looked.text();
        assert.match(html, /<form method="post" action="\/my\/link">/);
        assert.doesNotMatch(html, /pat@example\.com/, 'the button page does not say whose link it is');
      }

      const used = await useLink(base, token);
      assert.equal(used.status, 303);
      assert.equal(used.headers.get('location'), '/my/sessions');
      const cookie = myCookie(used);
      assert.ok(cookie);
      const page = await sessionsPage(base, cookie);
      assert.equal(page.status, 200);
      assert.match(visible(await page.text()), /Booked with pat@example\.com\./);

      const second = await useLink(base, token);
      assert.equal(second.status, 410, 'a link works once');
      assert.equal(myCookie(second), null);
      const done = await second.text();
      assert.match(visible(done), /That link is done It was already used, or it has expired\. Ask for a new one\./);
      const lookedAfter = await openLink(base, token);
      assert.equal(lookedAfter.status, 410);
      assert.equal(await lookedAfter.text(), done);

      // Unknown and malformed links read the same as a used one.
      for (const other of ['AAAAAAAAAAAAAAAAAAAAAA', 'x', '', `${token}x`, '../../booking']) {
        const opened = await openLink(base, other);
        assert.equal(opened.status, 410, other);
        assert.equal(await opened.text(), done, other);
        const posted = await useLink(base, other);
        assert.equal(posted.status, 410, other);
        assert.equal(await posted.text(), done, other);
        assert.equal(myCookie(posted), null);
      }

      // An expired link reads the same too.
      await ask(base, 'pat@example.com');
      const late = emailedToken(relay, 'pat@example.com');
      assert.notEqual(late, token);
      await db.query("update my_sessions_link set expires_at = now() - interval '1 second' where used_at is null");
      const expired = await useLink(base, late);
      assert.equal(expired.status, 410, 'a link lasts 20 minutes');
      assert.equal(await expired.text(), done);
      assert.equal((await openLink(base, late)).status, 410);

      // A new link ends the one before it.
      await ask(base, 'pat@example.com');
      const first = emailedToken(relay, 'pat@example.com');
      await ask(base, 'pat@example.com');
      const newest = emailedToken(relay, 'pat@example.com');
      assert.notEqual(newest, first);
      assert.equal((await useLink(base, first)).status, 410, 'the earlier link ended when a new one was sent');
      assert.equal((await useLink(base, newest)).status, 303);

      // A row is dropped a day after its link ran out, the next time a link is made.
      const rows = async () => (await db.query<{ id: number }>('select id from my_sessions_link order by id')).rows.map((r) => r.id);
      const kept = await rows();
      assert.equal(kept.length, 4);
      await db.query("update my_sessions_link set expires_at = now() - interval '25 hours' where id = any($1::int[])", [kept.slice(0, 2)]);
      await db.query("update my_sessions_link set expires_at = now() - interval '23 hours' where id = $1", [kept[2]]);
      await ask(base, 'pat@example.com');
      const after = await rows();
      assert.deepEqual(after.slice(0, 2), kept.slice(2), 'the two that ran out over a day ago are gone');
      assert.equal(after.length, 3, 'and the new link has its row');
    });
  });
});

test('the cookie holds one proven contact for 30 minutes, and a changed or expired one is refused', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await seedBookedSession(db, seed.sessionId, 'Mia', '+15551110030');
    await seedBookedSession(db, seed.sessionId, 'Zoe', '+15551110031');
    await withServer(async (base) => {
      await ask(base, '+15551110030');
      const proved = await enterCode(base, '+15551110030', textedCode(relay, '+15551110030'));
      const set = proved.headers.getSetCookie().find((c) => c.startsWith('cx_my='));
      assert.ok(set);
      assert.match(set, /; Path=\/my(;|$)/, 'sent only to this page');
      assert.match(set, /; HttpOnly(;|$)/);
      assert.match(set, /; SameSite=Lax(;|$)/);
      assert.match(set, /; Max-Age=1800(;|$)/, '30 minutes');
      const cookie = myCookie(proved);
      assert.ok(cookie);
      const value = decodeURIComponent(cookie.slice('cx_my='.length));
      assert.deepEqual(readMySessions(value), { kind: 'phone', phone: '+15551110030' });

      const mine = await sessionsPage(base, cookie);
      assert.equal(mine.status, 200);
      const page = visible(await mine.text());
      assert.match(page, /Mia/);
      assert.doesNotMatch(page, /Zoe/);

      const refused = async (cookieHeader: string, why: string) => {
        const res = await sessionsPage(base, cookieHeader);
        assert.equal(res.status, 303, why);
        assert.equal(res.headers.get('location'), '/my', why);
        assert.doesNotMatch(await res.text(), /Mia|Zoe/, why);
        const cleared = res.headers.getSetCookie().find((c) => c.startsWith('cx_my='));
        assert.ok(cleared, `${why}: the browser is told to drop it`);
        assert.match(cleared, /^cx_my=; Path=\/my; .*Max-Age=0/, why);
      };

      // The same signature over another parent's number.
      const [version, payload, signature] = value.split('.');
      const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), c: '+15551110031' })).toString('base64url');
      await refused(`cx_my=${version}.${other}.${signature}`, 'another contact under the same signature');
      // A longer life under the same signature.
      const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), x: 4102444800 })).toString('base64url');
      await refused(`cx_my=${version}.${longer}.${signature}`, 'a later expiry under the same signature');
      const flipped = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.slice(-1);
      await refused(`cx_my=${version}.${payload}.${flipped}`, 'a changed signature');
      // The same signature bytes written another way are not the signature.
      await refused(`cx_my=${version}.${payload}.${signature}=`, 'a padded signature');
      await refused(`cx_my=${version}.${payload}.${signature}!`, 'a signature with something after it');
      await refused(`cx_my=${version}.${payload}`, 'no signature');
      await refused(`cx_my=${version}.${payload}.`, 'an empty signature');
      await refused('cx_my=v1..', 'an empty value');
      await refused(`cx_my=v2.${payload}.${signature}`, 'another version');
      await refused(`cx_my=${'a'.repeat(5000)}`, 'a very long value');

      // Signed here, but run out.
      const contact = { kind: 'phone' as const, phone: '+15551110030' };
      const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
      await refused(`cx_my=${signMySessions(contact, minutesAgo(31))}`, 'signed 31 minutes ago');
      assert.equal((await sessionsPage(base, `cx_my=${signMySessions(contact, minutesAgo(29))}`)).status, 200, 'signed 29 minutes ago still opens it');
      await refused(`cx_my=${signMySessions(contact, new Date(Date.now() + 60 * 60 * 1000))}`, 'dated an hour ahead');

      // With no cookie there is nothing to drop.
      const none = await sessionsPage(base);
      assert.equal(none.status, 303);
      assert.equal(none.headers.get('location'), '/my');
      assert.deepEqual(none.headers.getSetCookie(), []);
    });
  });
});

test('the coach\'s cookie does not open this page, and this cookie does not open the coach\'s screens', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    assert.ok(seed.coach.phone);
    // The coach is also a parent's contact on a booking, the closest the two can come.
    await seedBookedSession(db, seed.sessionId, 'Mia', seed.coach.phone);
    const coachToken = await createCoachSession(db, seed.coach.id);
    await withServer(async (base) => {
      for (const cookie of [`cx_session=${coachToken}`, `cx_my=${coachToken}`, `cx_session=${coachToken}; cx_my=${coachToken}`]) {
        const res = await sessionsPage(base, cookie);
        assert.equal(res.status, 303, cookie.replaceAll(coachToken, '<coach>'));
        assert.equal(res.headers.get('location'), '/my');
      }

      const mine = await proveMobile(base, relay, seed.coach.phone);
      assert.equal((await sessionsPage(base, mine)).status, 200);
      const value = mine.slice('cx_my='.length);
      for (const cookie of [mine, `cx_session=${value}`]) {
        for (const path of ['/app/schedule', '/app/money', '/app/roster']) {
          const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
          assert.equal(res.status, 303, path);
          assert.equal(res.headers.get('location'), '/signin', path);
        }
      }
      assert.equal((await db.query('select 1 from coach_session where token = $1', [decodeURIComponent(value)])).rows.length, 0);
    });
  });
});

test('signing out clears the cookie', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const cookie = await proveMobile(base, relay, '+15551110040');
      const page = await (await sessionsPage(base, cookie)).text();
      assert.match(page, /<form method="post" action="\/my\/signout">/);
      assert.match(page, />Sign out</);

      const out = await fetch(`${base}/my/signout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
      assert.equal(out.status, 303);
      assert.equal(out.headers.get('location'), '/my');
      const cleared = out.headers.getSetCookie().find((c) => c.startsWith('cx_my='));
      assert.ok(cleared);
      assert.match(cleared, /^cx_my=; Path=\/my; .*Max-Age=0/);
      // What the browser does next: it has no cookie to send.
      assert.equal((await sessionsPage(base)).status, 303);
    });
  });
});

test('a booking\'s manage link alone never opens the page', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const token = await manageToken(db, await seedBookedSession(db, seed.sessionId, 'Mia', '+15551110050'));
    await seedBookedSession(db, seed.sessionId, 'Leo', '+15551110050');
    await withServer(async (base) => {
      const manage = await fetch(`${base}/booking/${token}`);
      assert.equal(manage.status, 200);
      assert.deepEqual(manage.headers.getSetCookie(), [], 'a manage page sets no cookie');
      assert.doesNotMatch(await manage.text(), /Leo/, 'and shows its own booking only');

      for (const path of ['/my/sessions', `/my/sessions?from=${token}`, `/my/sessions?t=${token}`, `/my/sessions/${token}`]) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.notEqual(res.status, 200, path);
        assert.doesNotMatch(await res.text(), /Mia|Leo/, path);
      }
      for (const cookie of [`cx_my=${token}`, `cx_session=${token}`]) {
        const res = await sessionsPage(base, cookie);
        assert.equal(res.status, 303, 'a manage token is not this page\'s cookie');
        assert.equal(res.headers.get('location'), '/my');
      }
      const asLink = await useLink(base, token);
      assert.equal(asLink.status, 410, 'a manage token is not an emailed link');
      assert.equal(myCookie(asLink), null);
      assert.equal((await openLink(base, token)).status, 410);
    });
  });
});

test('repeated requests hit the ceilings codes already have: per address and per contact', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      // One address: 10 requests in 10 minutes, the limit sign-in codes share.
      const seen = await inOneWindow(TEN_MINUTES, async (attempt) => {
        const one = from(`198.51.100.${10 + attempt}`);
        const texted = relay.sms.length;
        const statuses: number[] = [];
        for (let i = 0; i < 10; i += 1) statuses.push((await ask(base, `+1555222${attempt}${100 + i}`, one)).status);
        const eleventh = await ask(base, `+1555222${attempt}200`, one);
        const email = await ask(base, `someone${attempt}@example.com`, one);
        const signIn = await fetch(`${base}/signin/otp`, {
          method: 'POST',
          headers: { ...json, ...one },
          body: JSON.stringify({ contact: `+1555222${attempt}300` }),
        });
        return {
          statuses,
          eleventh: eleventh.status,
          page: visible(await eleventh.text()),
          email: email.status,
          signIn: signIn.status,
          texted: relay.sms.length - texted,
          emailed: relay.emails.filter((m) => m.to === `someone${attempt}@example.com`).length,
        };
      });
      assert.deepEqual(seen.statuses, Array.from({ length: 10 }, () => 200));
      assert.equal(seen.eleventh, 429);
      assert.match(seen.page, /Too many requests from here\. Try again later\./);
      assert.equal(seen.email, 429, 'emails count against the same limit');
      assert.equal(seen.signIn, 429, 'the address is out of sign-in codes too: one limit');
      assert.equal(seen.texted, 10);
      assert.equal(seen.emailed, 0);

      // One mobile: five codes a day from anywhere, and the sixth request reads the same.
      const pages: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await ask(base, '+15552223000', from(`203.0.113.${20 + i}`));
        assert.equal(res.status, 200, `request ${i + 1}`);
        pages.push(await res.text());
      }
      assert.equal(relay.sms.filter((m) => m.to === '+15552223000').length, 5, 'five codes a day to one number');
      assert.equal(pages[5], pages[0], 'the request past the ceiling reads the same as the first');
      const capped = await db.query<{ status: string }>(
        "select status from message_log where to_phone = '+15552223000' and status like 'capped%'",
      );
      assert.deepEqual(capped.rows, [{ status: 'capped-recipient-daily' }]);

      // One email: five links a day, and the sixth request reads the same.
      const emailPages: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await ask(base, 'often@example.com', from(`203.0.113.${40 + i}`));
        assert.equal(res.status, 200);
        emailPages.push(await res.text());
      }
      assert.equal(relay.emails.filter((m) => m.to === 'often@example.com').length, 5, 'five links a day to one address');
      assert.equal(emailPages[5], emailPages[0]);
      // The request past the ceiling ended nothing: the fifth link still works.
      assert.equal((await useLink(base, emailedToken(relay, 'often@example.com'), from('203.0.113.60'))).status, 303);
    });
  });
});

test('codes to people not signed in share the app-wide ceiling, and a request past it reads the same', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withEnv({ SMS_VISITOR_HOURLY_CAP: '2' }, () =>
      withServer(async (base) => {
        const pages: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const res = await ask(base, `+1555333000${i}`, from(`203.0.113.${70 + i}`));
          assert.equal(res.status, 200);
          pages.push(without(await res.text(), `+1555333000${i}`, `(555) 333-000${i}`));
        }
        assert.deepEqual(relay.sms.map((m) => m.to), ['+15553330000', '+15553330001'], 'the third text waits for the ceiling');
        assert.equal(pages[2], pages[0], 'and its page reads the same');
        assert.equal((await db.query("select 1 from otp_code where phone = '+15553330002'")).rows.length, 0, 'no code is kept for a text that did not go');
        // An email is not a text: it still goes.
        assert.equal((await ask(base, 'still@example.com', from('203.0.113.80'))).status, 200);
        assert.equal(relay.emails.length, 1);
      }),
    );
  });
});

test('an opted-out number and a relay that refuses get the same page, and no code is kept', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await db.query("insert into opt_out (phone) values ('+15554440001')");
    relay.failSmsTo.add('+15554440002');
    await withServer(async (base) => {
      const ok = without(await (await ask(base, '+15554440000')).text(), '+15554440000', '(555) 444-0000');
      for (const digits of ['0001', '0002']) {
        const res = await ask(base, `+1555444${digits}`);
        assert.equal(res.status, 200, digits);
        assert.equal(without(await res.text(), `+1555444${digits}`, `(555) 444-${digits}`), ok, digits);
      }
      relay.limited.email = true;
      const email = await ask(base, 'busy@example.com');
      assert.equal(email.status, 200);
      assert.match(visible(await email.text()), /Check your email/);
    });
    assert.deepEqual(relay.sms.map((m) => m.to), ['+15554440000']);
    assert.equal((await db.query("select 1 from otp_code where phone in ('+15554440001', '+15554440002')")).rows.length, 0);
    assert.equal((await db.query('select 1 from my_sessions_link')).rows.length, 0);
  });
});

test('code and link checks from one address stop at the limit sign-in checks have', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      // 30 checks in 10 minutes from one address, across numbers and links.
      const seen = await inOneWindow(TEN_MINUTES, async (attempt) => {
        const one = from(`198.51.100.${40 + attempt}`);
        const own = from(`198.51.100.${70 + attempt}`);
        const phone = `+155555500${10 + attempt}`;
        await ask(base, phone, own);
        const code = textedCode(relay, phone);
        const checks: number[] = [];
        for (let i = 0; i < 20; i += 1) checks.push((await enterCode(base, `+1555666${attempt}${100 + i}`, '123456', one)).status);
        const looks: number[] = [];
        for (let i = 0; i < 10; i += 1) looks.push((await openLink(base, 'AAAAAAAAAAAAAAAAAAAAAA', one)).status);
        const next = await enterCode(base, phone, code, one);
        return {
          checks,
          looks,
          next: next.status,
          page: visible(await next.text()),
          look: (await openLink(base, 'AAAAAAAAAAAAAAAAAAAAAA', one)).status,
          use: (await useLink(base, 'AAAAAAAAAAAAAAAAAAAAAA', one)).status,
          // From the parent's own address the code still works.
          own: (await enterCode(base, phone, code, own)).status,
        };
      });
      assert.deepEqual(seen.checks, Array.from({ length: 20 }, () => 401));
      assert.deepEqual(seen.looks, Array.from({ length: 10 }, () => 410));
      assert.equal(seen.next, 429, 'even the right code waits');
      assert.match(seen.page, /Too many tries Too many from here for now\. Try again later\./);
      assert.equal(seen.look, 429);
      assert.equal(seen.use, 429);
      assert.equal(seen.own, 303);
    });
  });
});

test('checks for one number stop at the hourly limit, and past it read the same as a wrong code', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      // 15 checks an hour for a number with a code out. Each code takes five
      // wrong tries, so three codes' worth.
      const seen = await inOneWindow(HOUR, async (attempt) => {
        const phone = `+155555501${10 + attempt}`;
        const address = (n: number) => from(`192.0.2.${(attempt * 30 + n) % 250}`);
        const wrongTries: number[] = [];
        let refused = '';
        for (let round = 0; round < 3; round += 1) {
          await ask(base, phone, address(round));
          const code = textedCode(relay, phone);
          for (let i = 1; i <= 5; i += 1) {
            const res = await enterCode(base, phone, wrong(code, i), address(3 + round * 5 + i));
            wrongTries.push(res.status);
            refused = await res.text();
          }
        }
        await ask(base, phone, address(20));
        const past = await enterCode(base, phone, textedCode(relay, phone), address(21));
        return { wrongTries, refused, past: past.status, pastPage: await past.text(), cookie: myCookie(past) };
      });
      assert.deepEqual(seen.wrongTries, Array.from({ length: 15 }, () => 401));
      assert.equal(seen.past, 401, 'the 16th check in the hour is not made, right code or not');
      assert.equal(seen.pastPage, seen.refused, 'and reads the same as a wrong code');
      assert.equal(seen.cookie, null);
    });
  });
});

test('every page under /my is kept out of caches, Referers and search indexes', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withEnv({ APP_ENV: 'production' }, () =>
      withServer(async (base) => {
        const cookie = await proveMobile(base, relay, '+15557770001');
        await ask(base, 'pat@example.com');
        const token = emailedToken(relay, 'pat@example.com');
        const responses: Array<[string, Response]> = [
          ['GET /my', await fetch(`${base}/my`)],
          ['POST /my', await ask(base, 'someone@example.com')],
          ['POST /my/code', await enterCode(base, '+15557770002', '123456')],
          ['GET /my/link', await openLink(base, token)],
          ['GET /my/link (done)', await openLink(base, 'AAAAAAAAAAAAAAAAAAAAAA')],
          ['GET /my/sessions', await sessionsPage(base, cookie)],
          ['GET /my/sessions (no cookie)', await sessionsPage(base)],
          ['GET /MY/Sessions', await fetch(`${base}/MY/Sessions`, { headers: { cookie }, redirect: 'manual' })],
        ];
        for (const [name, res] of responses) {
          assert.equal(res.headers.get('cache-control'), 'no-store', name);
          assert.equal(res.headers.get('referrer-policy'), 'no-referrer', name);
          assert.equal(res.headers.get('x-robots-tag'), 'noindex', name);
        }
        const robots = await (await fetch(`${base}/robots.txt`)).text();
        assert.match(robots, /^Disallow: \/my\/$/m);
        // The coach's public page, which links here, may still be indexed.
        assert.equal((await fetch(`${base}/`)).headers.get('x-robots-tag'), null);
      }),
    );
  });
});

test('the cookie is signed with SESSION_SECRET when it is long enough, and never with a short one', async () => {
  const contact = { kind: 'email' as const, email: 'pat@example.com' };
  const long = 'a-long-random-value-for-tests-0123456789';
  await withEnv({ SESSION_SECRET: long }, async () => {
    const value = signMySessions(contact);
    assert.deepEqual(readMySessions(value), contact);
    await withEnv({ SESSION_SECRET: `${long}-changed` }, async () => {
      assert.equal(readMySessions(value), null, 'another secret does not read it');
    });
    await withEnv({ SESSION_SECRET: undefined }, async () => {
      assert.equal(readMySessions(value), null, 'nor does the key used when no secret is set');
    });
  });
  // A short secret is not used: what it "signs" reads under any other short
  // secret and under none, because the key is this process's random one.
  await withEnv({ SESSION_SECRET: 'short' }, async () => {
    const value = signMySessions(contact);
    await withEnv({ SESSION_SECRET: 'other' }, async () => assert.deepEqual(readMySessions(value), contact));
    await withEnv({ SESSION_SECRET: undefined }, async () => assert.deepEqual(readMySessions(value), contact));
    await withEnv({ SESSION_SECRET: 'dev-only-not-a-secret' }, async () => assert.deepEqual(readMySessions(value), contact));
  });
  // What the cookie names must be an email or a mobile number.
  assert.equal(readMySessions(signMySessions({ kind: 'email', email: 'Not An Email' })), null);
  assert.equal(readMySessions(signMySessions({ kind: 'phone', phone: 'coach:1' })), null);
  assert.equal(readMySessions(undefined), null);
});

test('a body the parser refuses gets the same private headers on its error page', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      const bad = await fetch(`${base}/my`, { method: 'POST', headers: json, body: '{bad' });
      const big = await fetch(`${base}/my`, { method: 'POST', headers: json, body: JSON.stringify({ contact: 'x'.repeat(300_000) }) });
      assert.equal(bad.status, 400);
      assert.equal(big.status, 413);
      for (const res of [bad, big]) {
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(res.headers.get('x-robots-tag'), 'noindex');
      }
    });
  });
});
