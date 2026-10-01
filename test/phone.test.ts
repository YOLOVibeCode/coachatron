import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toE164 } from '../src/lib/phone.js';

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
