import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { clipStartText, decodeStartCookie, START_TEXT_MAX_BYTES } from '../src/lib/startCookie.js';
import { APP_BASE_URL } from '../src/config.js';

const WEEK = {
  coach_timezone: null,
  session_types: [
    { key: 'group', name: 'Evening group', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: null },
  ],
  weekly: [{ type_key: 'group', weekday: 2, time_local: '18:00', location: 'Field 3' }],
  packages: [],
  plans: [],
};

const WEEK_TEXT = 'Tuesdays at 6, an hour, 8 athletes, $35';

function setCookieHeader(res: Response, name: string): string | undefined {
  return (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`));
}

function cookieNamed(res: Response, name: string): string | null {
  const header = setCookieHeader(res, name);
  if (!header) return null;
  const match = /^[^=]+=([^;]*)/.exec(header);
  return match ? `${name}=${match[1]}` : null;
}

function joinCookies(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join('; ');
}

async function smsTo(base: string, from: string, body: string): Promise<Response> {
  return fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, body }),
  });
}

async function signInWithStart(
  base: string,
  relay: { sms: Array<{ to: string; body: string }> },
  digits: string,
  startCookie: string,
  profile: Record<string, string>,
): Promise<Response> {
  await fetch(`${base}/signin/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: startCookie },
    body: JSON.stringify({ phone: digits }),
    redirect: 'manual',
  });
  const phone = `+1${digits}`;
  const code = /code is (\d{6})/.exec(relay.sms.filter((m) => m.to === phone).at(-1)!.body)![1];
  return fetch(`${base}/signin/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: startCookie },
    body: JSON.stringify({ phone, code, ...profile }),
    redirect: 'manual',
  });
}

test('GET / returns 200 with no database, and the box posts to /start', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Say your week/);
    assert.match(body, /action="\/start"/);
    assert.match(body, /<textarea/);
    assert.match(body, /name="description"/);
    assert.match(body, /property="og:title"/);
    assert.doesNotMatch(body, /keeper|goalie|soccer/i);
    assert.doesNotMatch(body, /sms:/);
  });
});

test('the text line is hidden until COACHATRON_SMS_NUMBER is set', async () => {
  const prev = process.env.COACHATRON_SMS_NUMBER;
  process.env.COACHATRON_SMS_NUMBER = '+15551230000';
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/`)).text();
      assert.match(body, /sms:\+15551230000/);
      assert.match(body, /\(555\) 123-0000/);
    });
  } finally {
    if (prev === undefined) delete process.env.COACHATRON_SMS_NUMBER;
    else process.env.COACHATRON_SMS_NUMBER = prev;
  }
});

test('oversized landing text is clipped to 2400 UTF-8 bytes', () => {
  const huge = 'é'.repeat(2000);
  const clipped = clipStartText(huge);
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= START_TEXT_MAX_BYTES);
  assert.ok(clipped.length < huge.length);
});

test('typed journey: landing box, phone, draft, Publish, live link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    setComplete(fakeComplete(WEEK));
    try {
      await withServer(async (base) => {
        const startRes = await fetch(`${base}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: WEEK_TEXT }),
          redirect: 'manual',
        });
        assert.equal(startRes.status, 303);
        assert.equal(startRes.headers.get('location'), '/signin');
        const startCookie = cookieNamed(startRes, 'cx_start');
        assert.ok(startCookie);

        const signin = await (await fetch(`${base}/signin`, { headers: { cookie: startCookie! } })).text();
        assert.match(signin, /Saved\. Now your email or mobile/);

        const verify = await signInWithStart(base, relay, '5552220001', startCookie!, {
          name: 'Alex Coach',
          email: 'alex@example.com',
          tz: 'America/Chicago',
        });
        assert.equal(verify.status, 303);
        assert.equal(verify.headers.get('location'), '/app/schedule?setup=1');
        const session = cookieNamed(verify, 'cx_session');
        assert.ok(session);
        const cleared = setCookieHeader(verify, 'cx_start');
        assert.ok(cleared);
        assert.match(cleared, /Max-Age=0/);

        const setup = await (await fetch(`${base}/app/schedule?setup=1`, { headers: { cookie: session! } })).text();
        assert.match(setup, /Here&#39;s your week/);
        assert.match(setup, /Evening group/);
        assert.match(setup, />Publish</);

        const draftId = String((await db.query<{ id: number }>('select id from setup_draft')).rows[0].id);
        const published = await fetch(`${base}/app/setup/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: session! },
          body: JSON.stringify({ id: draftId }),
          redirect: 'manual',
        });
        assert.equal(published.headers.get('location'), '/app/schedule?published=1');

        const live = await (await fetch(`${base}/app/schedule?published=1`, { headers: { cookie: session! } })).text();
        assert.match(live, /You're live/);
        const handle = (await db.query<{ handle: string }>('select handle from coach')).rows[0].handle;
        const publicPage = await (await fetch(`${base}/c/${handle}`)).text();
        assert.match(publicPage, /Evening group/);
      });
    } finally {
      resetComplete();
    }
  });
});

test('the start cookie survives a model error and prefills the setup box', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    setComplete(fakeComplete(new Error('timeout')));
    try {
      await withServer(async (base) => {
        const startRes = await fetch(`${base}/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: WEEK_TEXT }),
          redirect: 'manual',
        });
        const startCookie = cookieNamed(startRes, 'cx_start')!;
        const verify = await signInWithStart(base, relay, '5552220002', startCookie, {
          name: 'Blair Coach',
          tz: 'America/Chicago',
        });
        assert.equal(verify.headers.get('location'), '/app/schedule?setup=1&e=read');
        assert.equal(cookieNamed(verify, 'cx_start'), null, 'failed setup leaves the existing cookie alone');

        const session = cookieNamed(verify, 'cx_session')!;
        const page = await (
          await fetch(`${base}/app/schedule?setup=1&e=read`, {
            headers: { cookie: joinCookies(session, startCookie) },
          })
        ).text();
        assert.match(page, /couldn&#39;t read that/);
        assert.ok(page.includes(`>${WEEK_TEXT}<`));
      });
    } finally {
      resetComplete();
    }
  });
});

test('POST /start clips oversized text in the cookie', async () => {
  await withServer(async (base) => {
    const huge = 'a'.repeat(4000);
    const startRes = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: huge }),
      redirect: 'manual',
    });
    const raw = cookieNamed(startRes, 'cx_start');
    assert.ok(raw);
    const value = decodeURIComponent(raw!.slice('cx_start='.length));
    const decoded = decodeStartCookie(value);
    assert.equal(decoded.length, START_TEXT_MAX_BYTES);
  });
});

test('empty landing text goes to sign-in with no cookie', async () => {
  await withServer(async (base) => {
    const startRes = await fetch(`${base}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
      redirect: 'manual',
    });
    assert.equal(startRes.headers.get('location'), '/signin');
    const cookie = setCookieHeader(startRes, 'cx_start');
    assert.ok(cookie);
    assert.match(cookie, /Max-Age=0/);
  });
});

test('a stranger texts their week, taps the link, and gets a draft; a parent still gets the booking link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const booked = await seedCoachWithSession(db);
    await seedBookedSession(db, booked.sessionId, 'Sam Reyes', '+15559991111');
    const llm = fakeComplete(WEEK);
    setComplete(llm);
    try {
      await withServer(async (base) => {
        const stranger = '+15559990000';
        const first = await smsTo(base, stranger, WEEK_TEXT);
        assert.equal(await first.text(), 'unrecognized');
        assert.equal(llm.calls.length, 0, 'the model is not called for an unknown number');

        const toThem = relay.sms.filter((m) => m.to === stranger);
        assert.equal(toThem.length, 1);
        const token = /\/start\/([a-f0-9]+)/.exec(toThem[0].body)?.[1];
        assert.ok(token, toThem[0].body);

        const second = await smsTo(base, stranger, WEEK_TEXT);
        assert.equal(await second.text(), 'unrecognized');
        assert.equal(relay.sms.filter((m) => m.to === stranger).length, 1);

        const parent = await smsTo(base, '+15559991111', 'when is tuesday');
        assert.equal(await parent.text(), 'unrecognized');
        const toParent = relay.sms.filter((m) => m.to === '+15559991111');
        assert.equal(toParent.length, 1);
        assert.match(toParent[0].body, new RegExp(APP_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(toParent[0].body, /\/start\//);
        assert.equal(llm.calls.length, 0);

        const form = await fetch(`${base}/start/${token}`);
        assert.equal(form.status, 200);
        assert.match(await form.text(), /Your name/);

        const named = await fetch(`${base}/start/${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Casey Coach', tz: 'America/Chicago' }),
          redirect: 'manual',
        });
        assert.equal(named.status, 303);
        assert.equal(named.headers.get('location'), '/app/schedule?setup=1');
        assert.equal(llm.calls.length, 1);
        const session = cookieNamed(named, 'cx_session');
        assert.ok(session);

        const setup = await (await fetch(`${base}/app/schedule?setup=1`, { headers: { cookie: session! } })).text();
        assert.match(setup, /Evening group/);
        assert.equal((await db.query('select id from coach where phone = $1', [stranger])).rows.length, 1);
        assert.equal((await db.query('select id from setup_draft')).rows.length, 1);

        const reuse = await fetch(`${base}/start/${token}`);
        assert.equal(reuse.status, 410);
        const reusePost = await fetch(`${base}/start/${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Casey Coach' }),
          redirect: 'manual',
        });
        assert.equal(reusePost.status, 410);
      });
    } finally {
      resetComplete();
    }
  });
});

test('the landing page still has no sport-specific words when the SMS number is set', async () => {
  const prev = process.env.COACHATRON_SMS_NUMBER;
  process.env.COACHATRON_SMS_NUMBER = '5551230000';
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/`)).text();
      assert.doesNotMatch(body, /keeper|goalie|soccer/i);
    });
  } finally {
    if (prev === undefined) delete process.env.COACHATRON_SMS_NUMBER;
    else process.env.COACHATRON_SMS_NUMBER = prev;
  }
});
