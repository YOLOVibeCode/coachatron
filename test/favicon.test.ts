import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';

/** The tab icon: a small inline SVG at /favicon.svg (and /favicon.ico, the
 * name browsers and crawlers ask for unprompted), cached for a day, and
 * named in the head of every page, the landing page included. */

test('the favicon is a small SVG cached for a day, and every page head links it', async () => {
  await freshDb();
  await withServer(async (base) => {
    for (const path of ['/favicon.svg', '/favicon.ico']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /^image\/svg\+xml/, path);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=86400', path);
      const svg = await res.text();
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*<\/svg>$/s, path);
      assert.ok(svg.length < 1024, `${path} is ${svg.length} bytes`);
    }
    const link = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
    for (const path of ['/', '/privacy', '/signin', '/sms', '/no-such-page']) {
      const page = await (await fetch(`${base}${path}`)).text();
      assert.ok(page.includes(link), `${path} links the icon`);
    }
  });
});
