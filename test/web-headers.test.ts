import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createPendingBooking } from '../src/domain/pricing.js';
import { createStartLink } from '../src/domain/startLink.js';
import { createPaymentsLink } from '../src/domain/payments.js';
import { parseCookies } from '../src/lib/cookies.js';
import { isPrivateLinkPath } from '../src/lib/headers.js';
import type { DbClient } from '../src/db/client.js';

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

test('pages do not name the framework and are served as the type they are', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('no page can be shown inside another site\'s frame', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const token = await manageToken(db, await seedBookedSession(db, seed.sessionId, 'Sam', '+15550000001'));
    const start = await createStartLink(db, '+15553334444', 'Tuesdays at 6');
    await withServer(async (base) => {
      for (const path of ['/', '/signin', '/sms', `/c/${seed.coach.handle}`, `/booking/${token}`, `/start/${start}`]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
        assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
      }
    });
  });
});

test('pages opened by a private link are not cached and do not pass the link on as a Referer', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const token = await manageToken(db, await seedBookedSession(db, seed.sessionId, 'Sam', '+15550000001'));
    const start = await createStartLink(db, '+15553334444', 'Tuesdays at 6');
    const pending = await createPendingBooking(db, {
      sessionId: seed.sessionId,
      capacity: 2,
      athleteName: 'Mia',
      contactPhone: '+15550000002',
      contactEmail: null,
    });
    assert.ok(pending);
    const payments = await createPaymentsLink(db, seed.coach.id);
    await withServer(async (base) => {
      for (const path of [
        `/booking/${token}`,
        `/start/${start}`,
        `/p/${payments}`,
        `/P/${payments}`,
        '/offer/not-a-real-offer',
        '/signin/verify?to=pat%40example.com',
        `/c/${seed.coach.handle}/checkout/${pending.id}`,
        `/Booking/${token}`,
        `/START/${start}`,
        '/Signin/Verify?to=pat%40example.com',
      ]) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        assert.equal(res.headers.get('cache-control'), 'no-store', path);
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
      }
      const home = await fetch(`${base}/c/${seed.coach.handle}`);
      assert.equal(home.headers.get('referrer-policy'), null, 'a public page keeps the default');

      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      const schedule = await fetch(`${base}/app/schedule`, { headers: { cookie } });
      assert.equal(schedule.headers.get('cache-control'), 'no-store', 'signed-in pages are not cached either');
      const upper = await fetch(`${base}/App/Schedule`, { headers: { cookie } });
      assert.equal(upper.status, 200);
      assert.equal(upper.headers.get('cache-control'), 'no-store', 'whatever the case of the path');
    });
  });
});

test('private-link paths are told apart from public ones', () => {
  for (const path of [
    '/booking/abc',
    '/booking/abc/cancel',
    '/start/abc',
    '/offer/abc',
    '/p/abc',
    '/P/abc',
    '/signin/verify',
    '/c/pat/checkout/12',
    '/BOOKING/abc',
    '/Signin/Verify',
    '/c/pat/Checkout/12',
  ]) {
    assert.equal(isPrivateLinkPath(path), true, path);
  }
  for (const path of ['/', '/start', '/signin', '/signin/otp', '/c/pat', '/c/pat/sessions/1/book', '/sms', '/privacy', '/p']) {
    assert.equal(isPrivateLinkPath(path), false, path);
  }
});

test('the address saved with a consent is the visitor\'s, as forwarded by the one proxy in front', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await withServer(async (base) => {
      const res = await fetch(`${base}/sms`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': '198.51.100.7, 203.0.113.9',
          'user-agent': 'Mozilla/5.0 (iPhone)',
        },
        body: new URLSearchParams({ phone: '2145550123', sms_consent: '1' }),
      });
      assert.equal(res.status, 200);
    });
    const row = await db.query<{ ip: string; user_agent: string }>('select ip, user_agent from sms_consent order by id desc limit 1');
    assert.equal(row.rows[0].user_agent, 'Mozilla/5.0 (iPhone)');
    assert.equal(row.rows[0].ip, '203.0.113.9', 'the address the proxy saw, not one the client wrote in');
  });
});

test('a cookie with a bad percent-escape is read as it is, and the pages still answer', async () => {
  assert.deepEqual(parseCookies('stray=100%; ok=a%20b'), { stray: '100%', ok: 'a b' });
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const session = await createCoachSession(db, seed.coach.id);
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/signin`, { headers: { cookie: 'stray=100%' } })).status, 200);
      const anon = await fetch(`${base}/app/schedule`, { headers: { cookie: 'stray=100%' }, redirect: 'manual' });
      assert.equal(anon.status, 303);
      const signedIn = await fetch(`${base}/app/schedule`, { headers: { cookie: `stray=100%; cx_session=${session}` } });
      assert.equal(signedIn.status, 200);
    });
  });
});
