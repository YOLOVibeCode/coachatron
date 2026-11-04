import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { createPendingBooking } from '../src/domain/pricing.js';
import { createStartLink } from '../src/domain/startLink.js';
import { createPaymentsLink } from '../src/domain/payments.js';
import type { DbClient } from '../src/db/client.js';

/** www.coachatron.com is the same service as coachatron.com: it sends every
 * request to APP_BASE_URL, except /health, and no other host is sent
 * anywhere. The public pages name their address on APP_BASE_URL as
 * canonical; the coach's screens and private links name none. */

/** Runs `fn` with these environment variables set (undefined: unset), then
 * puts them back. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    await fn();
  } finally {
    apply(before);
  }
}

interface Answer {
  status: number;
  location: string | undefined;
  body: string;
}

/** One request with this Host header, which fetch() will not send. */
function ask(base: string, opts: { host: string; path: string; method?: string; body?: string }): Promise<Answer> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(port),
        method: opts.method ?? 'GET',
        path: opts.path,
        agent: false,
        headers: {
          host: opts.host,
          ...(opts.body === undefined
            ? {}
            : { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(opts.body) }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

const PRODUCTION = { APP_BASE_URL: 'https://coachatron.com' };

test('www sends GET and HEAD to APP_BASE_URL with a 301, keeping the path and query', async () => {
  await freshDb();
  await withEnv(PRODUCTION, async () => {
    await withServer(async (base) => {
      for (const [method, path] of [
        ['GET', '/'],
        ['GET', '/c/jamie-coach?utm_source=flyer&x=1'],
        ['GET', '/terms'],
        ['HEAD', '/privacy'],
        ['HEAD', '/c/jamie-coach?utm_source=flyer'],
      ] as const) {
        const res = await ask(base, { host: 'www.coachatron.com', method, path });
        assert.equal(res.status, 301, `${method} ${path}`);
        assert.equal(res.location, `https://coachatron.com${path}`, `${method} ${path}`);
      }
      const upper = await ask(base, { host: 'WWW.Coachatron.com', path: '/sms' });
      assert.equal(upper.status, 301, 'a host name is the same whatever its case');
      assert.equal(upper.location, 'https://coachatron.com/sms');
    });
  });
});

test('www answers a POST or any other method with a 308, so the method and body are kept', async () => {
  await freshDb();
  await withEnv(PRODUCTION, async () => {
    await withServer(async (base) => {
      const post = await ask(base, { host: 'www.coachatron.com', method: 'POST', path: '/sms', body: 'phone=5555550100&sms_consent=1' });
      assert.equal(post.status, 308);
      assert.equal(post.location, 'https://coachatron.com/sms');
      const signin = await ask(base, { host: 'www.coachatron.com', method: 'POST', path: '/signin/otp?next=%2Fapp', body: 'contact=a' });
      assert.equal(signin.status, 308);
      assert.equal(signin.location, 'https://coachatron.com/signin/otp?next=%2Fapp');
      for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
        const res = await ask(base, { host: 'www.coachatron.com', method, path: '/app' });
        assert.equal(res.status, 308, method);
        assert.equal(res.location, 'https://coachatron.com/app', method);
      }
    });
  });
});

test('www keeps the redirect on APP_BASE_URL, whatever the request line holds', async () => {
  await freshDb();
  await withEnv(PRODUCTION, async () => {
    await withServer(async (base) => {
      const absolute = await ask(base, { host: 'www.coachatron.com', path: 'http://elsewhere.example/c/x?y=1' });
      assert.equal(absolute.status, 301);
      assert.equal(absolute.location, 'https://coachatron.com/', 'an absolute URL in the request line is not copied');
      const doubled = await ask(base, { host: 'www.coachatron.com', path: '//elsewhere.example/x' });
      assert.equal(doubled.status, 301);
      assert.equal(new URL(doubled.location ?? '').host, 'coachatron.com', 'a path that starts with // stays a path');
    });
  });
});

test('/health answers on every host, www included, without a redirect, while the rest of www is sent on', async () => {
  await freshDb();
  await withEnv(PRODUCTION, async () => {
    await withServer(async (base) => {
      const home = await ask(base, { host: 'www.coachatron.com', path: '/' });
      assert.equal(home.status, 301, 'www itself is redirected');
      for (const host of [
        'www.coachatron.com',
        'coachatron.com',
        'healthcheck.railway.app',
        'web-production-1a2b.up.railway.app',
        'web.railway.internal:3000',
        'localhost:3000',
      ]) {
        for (const path of ['/health', '/health?probe=1', '/health/']) {
          const res = await ask(base, { host, path });
          assert.equal(res.status, 200, `${host}${path}`);
          assert.equal(res.location, undefined, `${host}${path}`);
          assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, true, `${host}${path}`);
        }
      }
      const head = await ask(base, { host: 'www.coachatron.com', method: 'HEAD', path: '/health' });
      assert.equal(head.status, 200, 'HEAD /health on www');
    });
  });
});

test('no host but www.<APP_BASE_URL host> is redirected', async () => {
  await freshDb();
  await withEnv(PRODUCTION, async () => {
    await withServer(async (base) => {
      const www = await ask(base, { host: 'www.coachatron.com', path: '/sms' });
      assert.equal(www.location, 'https://coachatron.com/sms', 'www is');
      for (const host of [
        'coachatron.com',
        'healthcheck.railway.app',
        'web-production-1a2b.up.railway.app',
        'web.railway.internal:3000',
        'localhost',
        'localhost:3000',
        new URL(base).host,
        'uat.coachatron.com',
        'dev.coachatron.com',
        'www.uat.coachatron.com',
        'www.coachatron.com.example.net',
        'wwwcoachatron.com',
        'xwww.coachatron.com',
      ]) {
        for (const method of ['GET', 'POST']) {
          const res = await ask(base, { host, method, path: '/sms', ...(method === 'POST' ? { body: 'phone=' } : {}) });
          assert.equal(res.location, undefined, `${method} ${host}`);
          assert.notEqual(res.status, 301, `${method} ${host}`);
          assert.notEqual(res.status, 308, `${method} ${host}`);
        }
      }
    });
  });
});

test('www is redirected only to its own environment\'s base, and not at all without one', async () => {
  await freshDb();
  await withEnv({ APP_BASE_URL: 'https://uat.coachatron.com' }, async () => {
    await withServer(async (base) => {
      const www = await ask(base, { host: 'www.uat.coachatron.com', path: '/terms?x=1' });
      assert.equal(www.status, 301);
      assert.equal(www.location, 'https://uat.coachatron.com/terms?x=1', 'www of the base the environment names');
      const prod = await ask(base, { host: 'www.coachatron.com', path: '/' });
      assert.equal(prod.status, 200, 'uat does not redirect production\'s www');
      const own = await ask(base, { host: 'uat.coachatron.com', path: '/' });
      assert.equal(own.status, 200);
    });
  });
  await withEnv({ APP_BASE_URL: undefined }, async () => {
    await withServer(async (base) => {
      const res = await ask(base, { host: 'www.coachatron.com', path: '/' });
      assert.equal(res.status, 200, 'a local run with no APP_BASE_URL answers every host');
    });
  });
});

// ---- rel=canonical ----

function canonicals(page: string): string[] {
  return [...page.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]);
}

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

test('the landing, legal and texting pages and a coach\'s page name their address on APP_BASE_URL, without the query', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    // A trailing slash on APP_BASE_URL does not double the slash.
    await withEnv({ APP_BASE_URL: 'https://coachatron.com/' }, async () => {
      await withServer(async (base) => {
        for (const [path, href] of [
          ['/', 'https://coachatron.com/'],
          ['/?utm_source=flyer', 'https://coachatron.com/'],
          ['/terms', 'https://coachatron.com/terms'],
          ['/terms?ref=footer', 'https://coachatron.com/terms'],
          ['/privacy', 'https://coachatron.com/privacy'],
          ['/sms', 'https://coachatron.com/sms'],
          ['/sms?ref=x', 'https://coachatron.com/sms'],
          [`/c/${seed.coach.handle}`, `https://coachatron.com/c/${seed.coach.handle}`],
          [`/c/${seed.coach.handle}?utm_source=flyer`, `https://coachatron.com/c/${seed.coach.handle}`],
        ]) {
          const res = await fetch(`${base}${path}`);
          assert.equal(res.status, 200, path);
          assert.deepEqual(canonicals(await res.text()), [href], path);
        }
      });
    });
  });
});

test('the coach\'s screens, pages a private link opens, and pages that are not found name no canonical address', async () => {
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
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withEnv(PRODUCTION, async () => {
      await withServer(async (base) => {
        const open = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
        assert.deepEqual(canonicals(open), [`https://coachatron.com/c/${seed.coach.handle}`], 'the coach\'s page on its own does');
        for (const path of [
          '/app/schedule',
          `/app/sessions/${seed.sessionId}`,
          '/app/money',
          `/booking/${token}`,
          `/start/${start}`,
          `/p/${payments}`,
          `/c/${seed.coach.handle}/checkout/${pending.checkoutToken}`,
          '/signin/verify?to=pat%40example.com',
          // Opened from a booking's manage page, with its link along as ?from=.
          `/c/${seed.coach.handle}?from=${token}`,
          '/c/nobody-here',
        ]) {
          const res = await fetch(`${base}${path}`, { headers: { cookie } });
          assert.ok(res.status < 500, `${path}: ${res.status}`);
          assert.deepEqual(canonicals(await res.text()), [], path);
        }
      });
    });
  });
});

test('with no APP_BASE_URL no page names a canonical address', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await withEnv(PRODUCTION, async () => {
      await withServer(async (base) => {
        const page = await (await fetch(`${base}/`)).text();
        assert.deepEqual(canonicals(page), ['https://coachatron.com/'], 'with APP_BASE_URL set, it does');
      });
    });
    await withEnv({ APP_BASE_URL: undefined }, async () => {
      await withServer(async (base) => {
        for (const path of ['/', '/terms', '/privacy', '/sms', `/c/${seed.coach.handle}`]) {
          const page = await (await fetch(`${base}${path}`)).text();
          assert.doesNotMatch(page, /rel="canonical"/, path);
        }
      });
    });
  });
});
