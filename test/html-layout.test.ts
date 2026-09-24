import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSTCARD_TOKENS_CSS, page, html } from '../src/lib/html.js';
import { withServer } from './helpers/server.js';

test('POSTCARD_TOKENS_CSS includes responsive layout and touch targets', () => {
  assert.match(POSTCARD_TOKENS_CSS, /--touch-min:\s*44px/);
  assert.match(POSTCARD_TOKENS_CSS, /min-height:\s*var\(--touch-min\)/);
  assert.match(POSTCARD_TOKENS_CSS, /@media \(min-width: 768px\)/);
  assert.match(POSTCARD_TOKENS_CSS, /@media \(min-width: 1024px\)/);
  assert.match(POSTCARD_TOKENS_CSS, /\.schedule-ask/);
  assert.doesNotMatch(POSTCARD_TOKENS_CSS, /max-width:\s*360px/);
  const tabletBlock = POSTCARD_TOKENS_CSS.split('@media (min-width: 768px)')[1];
  assert.ok(tabletBlock, 'expected tablet media query block');
  assert.match(tabletBlock, /--shell-max:/);
});

test('page() includes viewport meta and screen shell', () => {
  const doc = page('Test', html`<h1>Hi</h1>`);
  assert.match(doc, /name="viewport"/);
  assert.match(doc, /class="phone"/);
  assert.match(doc, /class="screen"/);
});

test('GET /signin returns responsive shell markup', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/signin`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /--touch-min:\s*44px/);
    assert.match(body, /class="phone"/);
    assert.doesNotMatch(body, /max-width:\s*360px/);
  });
});
