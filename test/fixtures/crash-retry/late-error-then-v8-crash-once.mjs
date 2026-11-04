import { test } from 'node:test';
import { crashLikeV8, firstTime } from './v8-crash.mjs';

// The first time: a test passes, an error escapes from it after it ended,
// and V8 aborts the process right after. The second time everything passes.
const first = firstTime('late-error-then-v8-crash-once');

test('passes, then throws after it ended', () => {
  if (first) {
    setTimeout(() => {
      setImmediate(crashLikeV8);
      throw new Error('thrown after the test ended');
    }, 20);
  }
});

test('waits', async () => {
  await new Promise((done) => setTimeout(done, 300));
});
