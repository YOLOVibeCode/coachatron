import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsOrCanada, toE164 } from '../src/lib/phone.js';
import { canText } from '../src/domain/outbound.js';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';

test('toE164 normalizes US numbers', () => {
  assert.equal(toE164('5551234567'), '+15551234567');
  assert.equal(toE164('(555) 123-4567'), '+15551234567');
  assert.equal(toE164('+1 555 123 4567'), '+15551234567');
  assert.equal(toE164('15551234567'), '+15551234567');
});

test('toE164 rejects invalid numbers', () => {
  assert.equal(toE164('invalid-phone'), null);
  assert.equal(toE164('123'), null);
});

test('only US and Canadian numbers count as textable', () => {
  for (const phone of ['+12145550100', '+15551234567', '+14165550100', '+16045550100', '+18333645083']) {
    assert.equal(isUsOrCanada(phone), true, phone);
    assert.equal(canText(phone), true, phone);
  }
  const elsewhere = [
    '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664', '670', '671',
    '684', '721', '758', '767', '784', '787', '809', '829', '849', '868', '869', '876', '939',
  ];
  for (const area of elsewhere) {
    assert.equal(canText(`+1${area}5550100`), false, area);
  }
  for (const phone of ['+10005550100', '+11235550100', '+1214555010', '+121455501000', '+442071234567', '5551234567', '']) {
    assert.equal(canText(phone), false, phone || '(empty)');
  }
});

test('a +1 number outside the US and Canada is turned away at sign-in with a clear message', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      for (const contact of ['+1 876 555 0100', '(787) 555-0100', '+1 441 555 0100']) {
        const res = await fetch(`${base}/signin/otp`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ contact }),
          redirect: 'manual',
        });
        assert.equal(res.status, 422, contact);
        assert.match(await res.text(), /We text only US and Canadian mobile numbers\. Use your email instead\./);
      }
    });
    assert.equal(relay.sms.length, 0);
  });
});
