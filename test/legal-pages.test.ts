import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers/server.js';

const VERBATIM =
  'We do not share, sell, or provide your mobile phone number or SMS opt-in data to third parties or affiliates for marketing or promotional purposes.';

test('privacy page includes required SMS sentence verbatim', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/privacy`)).text();
    assert.match(html, new RegExp(VERBATIM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /Text messages/);
  });
});

test('terms page has sms section with required phrases', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/terms`)).text();
    assert.match(html, /id="sms"/);
    assert.match(html, /Message frequency varies/);
    assert.match(html, /Message and data rates may apply/);
    assert.match(html, /Reply STOP to opt out; reply HELP for help/);
    assert.match(html, /Carriers are not liable for delayed or undelivered messages/);
  });
});

test('sign-in page footer links to privacy and terms', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/signin`)).text();
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /href="\/terms"/);
  });
});
