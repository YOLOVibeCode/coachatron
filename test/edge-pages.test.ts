import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { setDb, type DbClient } from '../src/db/client.js';
import { createCoachSession } from '../src/domain/auth.js';
import { seedCoachWithSession } from './helpers/fixtures.js';

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

/** Collects what is logged at warn and error level while `fn` runs. */
async function captureLogs(fn: () => Promise<void>): Promise<{ warn: string[]; error: string[] }> {
  const logs = { warn: [] as string[], error: [] as string[] };
  const { warn, error } = console;
  console.warn = (...args: unknown[]) => logs.warn.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.error.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return logs;
}

/** The app's own page (the Postcard shell with the footer), not Express's
 * bare <pre> one. */
function assertBranded(body: string, heading: RegExp, what: string): void {
  assert.match(body, /<title>[^<]+ — Coachatron<\/title>/, what);
  assert.match(body, /class="site-footer"/, what);
  assert.match(body, heading, what);
  assert.doesNotMatch(body, /<pre>|Cannot (GET|POST)|at .+\.(ts|js):\d+/, what);
}

const jsonHeaders = { 'content-type': 'application/json' };

test('a body too large gets the branded 413 page and one warning line, with no stack', async () => {
  await freshDb();
  let res: Response | undefined;
  let body = '';
  const logs = await captureLogs(() =>
    withServer(async (base) => {
      res = await fetch(`${base}/signin/otp?to=pat%40example.com`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ contact: 'x'.repeat(200_000) }),
      });
      body = await res.text();
    }),
  );
  assert.equal(res?.status, 413);
  assert.match(res?.headers.get('content-type') ?? '', /^text\/html/);
  assertBranded(body, /<h1>Too much to send<\/h1>/, '413');
  assert.deepEqual(logs.warn, ['413 POST /signin/otp entity.too.large'], 'one line: status, method, path without the query, type');
  assert.deepEqual(logs.error, [], 'nothing at error level');
});

test('a body that does not parse gets the branded 400 page and one warning line', async () => {
  await freshDb();
  const statuses: number[] = [];
  const bodies: string[] = [];
  const logs = await captureLogs(() =>
    withServer(async (base) => {
      // JSON cut short.
      const json = await fetch(`${base}/signin/otp`, { method: 'POST', headers: jsonHeaders, body: '{"contact": "pat@' });
      statuses.push(json.status);
      bodies.push(await json.text());
      // A form nested deeper than the parser reads.
      const form = await fetch(`${base}/sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `a${'[b]'.repeat(40)}=1`,
      });
      statuses.push(form.status);
      bodies.push(await form.text());
    }),
  );
  assert.deepEqual(statuses, [400, 400]);
  for (const body of bodies) assertBranded(body, /<h1>Something was wrong with that<\/h1>/, '400');
  assert.doesNotMatch(bodies[0], /pat@/, 'what was sent is not echoed back');
  assert.deepEqual(logs.warn, ['400 POST /signin/otp entity.parse.failed', '400 POST /sms querystring.parse.rangeError']);
  assert.deepEqual(logs.error, []);
});

test('a bad percent-escape in a link is a branded 400, and the log leaves out a private link\'s key', async () => {
  await freshDb();
  const statuses: number[] = [];
  const bodies: string[] = [];
  const logs = await captureLogs(() =>
    withServer(async (base) => {
      for (const path of ['/c/pat%E0%A4%A', '/booking/abc123%E0%A4%A/cancel?x=1', '/app/sessions/%zz']) {
        const res = await fetch(`${base}${path}`, { redirect: 'manual' });
        statuses.push(res.status);
        bodies.push(await res.text());
      }
    }),
  );
  assert.deepEqual(statuses, [400, 400, 400]);
  for (const body of bodies) assertBranded(body, /<h1>Something was wrong with that<\/h1>/, 'URIError');
  assert.deepEqual(logs.warn, [
    '400 GET /c/pat%E0%A4%A URIError',
    '400 GET /booking/:token/cancel URIError',
    '400 GET /app/sessions/%zz URIError',
  ]);
  assert.ok(!logs.warn.join('\n').includes('abc123'), 'the manage link\'s key is not logged');
  assert.deepEqual(logs.error, []);
});

test('a fault in a route logs its stack once and shows a branded 500 that gives nothing away', async () => {
  const broken = {
    query: async () => {
      throw new Error('connection to the database was lost');
    },
  } as unknown as DbClient;
  setDb(broken);
  let res: Response | undefined;
  let body = '';
  const logs = await captureLogs(() =>
    withServer(async (base) => {
      res = await fetch(`${base}/c/pat?from=secret-link`);
      body = await res.text();
    }),
  );
  assert.equal(res?.status, 500);
  assertBranded(body, /<h1>Something went wrong<\/h1>/, '500');
  assert.doesNotMatch(body, /database|Error/, 'no detail reaches the visitor');
  assert.equal(logs.error.length, 1, 'logged once');
  assert.match(logs.error[0], /^500 GET \/c\/pat: Error: connection to the database was lost\n\s+at /, 'with its stack');
  assert.doesNotMatch(logs.error[0], /secret-link/, 'and without the query');
  assert.deepEqual(logs.warn, []);
});

test('an address nothing answers gets the same branded Not found page as an unknown coach', async () => {
  await freshDb();
  await withServer(async (base) => {
    const coach = await fetch(`${base}/c/nobody-here`);
    assert.equal(coach.status, 404);
    const coachPage = await coach.text();
    for (const [method, path] of [
      ['GET', '/no-such-page'],
      ['GET', '/c'],
      ['POST', '/no-such-form'],
      ['GET', '/app/no-such-screen'],
    ]) {
      const res = await fetch(`${base}${path}`, { method, redirect: 'manual' });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
      const body = await res.text();
      assert.equal(body, coachPage, `${method} ${path}`);
      assertBranded(body, /<h1>Not found<\/h1>/, `${method} ${path}`);
    }
  });
});

test('/app and /app/ open the coach\'s home screen, which signs a stranger in first', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
  await withServer(async (base) => {
    for (const path of ['/app', '/app/', '/App']) {
      const res = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.get('location'), '/app/schedule', path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
    }
    const stranger = await fetch(`${base}/app/schedule`, { redirect: 'manual' });
    assert.equal(stranger.status, 303);
    assert.equal(stranger.headers.get('location'), '/signin');
    const coach = await fetch(`${base}/app`, { headers: { cookie } });
    assert.equal(coach.status, 200, 'a signed-in coach lands on the schedule');
    assert.equal(new URL(coach.url).pathname, '/app/schedule');
  });
});

/** Whether robots.txt lets a crawler fetch `path`: the longest matching rule
 * wins, Allow on a tie, as RFC 9309 says. */
function robotsAllows(robots: string, path: string): boolean {
  let best: { length: number; allow: boolean } = { length: -1, allow: true };
  for (const line of robots.split('\n')) {
    const m = /^(Allow|Disallow):\s*(\S*)$/i.exec(line.trim());
    if (!m || m[2] === '') continue;
    const pattern = new RegExp(`^${m[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`);
    if (!pattern.test(path)) continue;
    const allow = m[1].toLowerCase() === 'allow';
    if (m[2].length > best.length || (m[2].length === best.length && allow)) best = { length: m[2].length, allow };
  }
  return best.allow;
}

test('in production, robots.txt lets crawlers read the public pages and keeps them off links and the coach\'s screens', async () => {
  await freshDb();
  await withEnv({ APP_ENV: 'production' }, () =>
    withServer(async (base) => {
      const res = await fetch(`${base}/robots.txt`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      const robots = await res.text();
      for (const path of ['/', '/c/pat', '/c/pat/sessions/12/book', '/privacy', '/terms', '/sms', '/signin']) {
        assert.equal(robotsAllows(robots, path), true, `${path} is public`);
      }
      for (const path of [
        '/app',
        '/app/schedule',
        '/booking/abc',
        '/booking/abc/cancel',
        '/offer/abc',
        '/start/abc',
        '/p/abc',
        '/c/pat/checkout/abc',
        '/signin/verify?to=pat%40example.com',
        '/c/pat?from=abc',
        '/c/pat/sessions/12/book?x=1&from=abc',
      ]) {
        assert.equal(robotsAllows(robots, path), false, `${path} is not crawled`);
      }
      for (const path of ['/', '/robots.txt', '/c/pat']) {
        assert.equal((await fetch(`${base}${path}`)).headers.get('x-robots-tag'), null, `${path} may be indexed`);
      }
    }),
  );
});

test('outside production, robots.txt turns every crawler away and every response says noindex', async () => {
  await freshDb();
  for (const appEnv of [undefined, 'uat', 'dev', 'development']) {
    await withEnv({ APP_ENV: appEnv }, () =>
      withServer(async (base) => {
        const robots = await (await fetch(`${base}/robots.txt`)).text();
        assert.match(robots, /^User-agent: \*\nDisallow: \/\n$/, String(appEnv));
        assert.equal(robotsAllows(robots, '/'), false);
        for (const [method, path] of [
          ['GET', '/'],
          ['GET', '/robots.txt'],
          ['GET', '/signin'],
          ['GET', '/no-such-page'],
          ['GET', '/app'],
          ['POST', '/no-such-form'],
        ]) {
          const res = await fetch(`${base}${path}`, { method, redirect: 'manual' });
          assert.equal(res.headers.get('x-robots-tag'), 'noindex', `${appEnv} ${method} ${path}`);
        }
      }),
    );
  }
});

test('an https site tells browsers to keep to https for a year, for this host only', async () => {
  await freshDb();
  for (const [baseUrl, expected] of [
    ['https://coachatron.com', 'max-age=31536000'],
    ['https://uat.coachatron.com', 'max-age=31536000'],
    ['http://localhost:3000', null],
    [undefined, null],
  ] as const) {
    await withEnv({ APP_BASE_URL: baseUrl }, () =>
      withServer(async (base) => {
        for (const path of ['/', '/signin', '/no-such-page']) {
          const res = await fetch(`${base}${path}`);
          assert.equal(res.headers.get('strict-transport-security'), expected, `${baseUrl} ${path}`);
        }
      }),
    );
  }
});
