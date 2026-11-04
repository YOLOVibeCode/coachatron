import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, parseContact } from '../src/domain/auth.js';
import { cancelsTooMuch } from '../src/domain/assistant.js';

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

test('normalizeEmail keeps what an address looks like and turns the rest away', () => {
  assert.equal(normalizeEmail('  Pat.Coach+x@Example.com '), 'pat.coach+x@example.com');
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
  assert.equal(normalizeEmail('a@sub.example.co.uk'), 'a@sub.example.co.uk');
  for (const bad of ['', 'dana@', '@example.com', 'dana@example', 'dana@.com', 'dana@example.', 'a b@example.com', 'a@b@example.com', 'hello']) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
  assert.equal(normalizeEmail(`${'a'.repeat(242)}@example.com`), `${'a'.repeat(242)}@example.com`, '254 characters is the most');
  assert.equal(normalizeEmail(`${'a'.repeat(243)}@example.com`), null, 'over 254 characters');
});

test('a very long or odd address is answered in one quick pass', () => {
  for (const input of [`a@${'.'.repeat(40_000)}@`, `a@${'a.'.repeat(40_000)}`, `${'a@'.repeat(30_000)}x`, '@'.repeat(80_000)]) {
    const { value, ms } = timed(() => parseContact(input));
    assert.equal(value, null);
    assert.ok(ms < 50, `${Math.round(ms)} ms for ${input.length} characters`);
  }
});

test('"cancel" with a wide target is spotted the same way, and quickly on long text', () => {
  assert.equal(cancelsTooMuch('cancel everything next week'), true);
  assert.equal(cancelsTooMuch('please cancel all sessions'), true);
  assert.equal(cancelsTooMuch('cancel the whole week'), true);
  assert.equal(cancelsTooMuch('can you cancel tues and next week'), true);
  assert.equal(cancelsTooMuch('cancel tomorrows 6pm'), false);
  assert.equal(cancelsTooMuch('cancel everythingx'), false, 'whole words only');
  assert.equal(cancelsTooMuch('cancel next week'), true);
  assert.equal(cancelsTooMuch('cancelnext week'), false, 'something must come between, as before');
  assert.equal(cancelsTooMuch('cancel next weekend'), false);
  assert.equal(cancelsTooMuch('everything is fine'), false);

  const { value, ms } = timed(() => cancelsTooMuch('cancel'.repeat(20_000)));
  assert.equal(value, false);
  assert.ok(ms < 50, `${Math.round(ms)} ms`);
});
