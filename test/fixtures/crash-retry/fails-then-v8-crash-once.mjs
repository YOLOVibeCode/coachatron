import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashLikeV8, firstTime } from './v8-crash.mjs';

// The first time: a test fails, then V8 aborts the process while the next
// test runs, before the failure has reached the runner. The second time
// everything passes, so only the recorder stops a green rerun.
const first = firstTime('fails-then-v8-crash-once');

test('fails the first time only', () => {
  assert.ok(!first, 'fails on the first run');
});

test('V8 aborts the process the first time, while this test runs', async () => {
  await Promise.resolve();
  if (first) crashLikeV8();
});
