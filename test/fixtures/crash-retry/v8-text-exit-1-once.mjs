import { test, after } from 'node:test';
import { firstTime, printV8CrashText } from './v8-crash.mjs';

// V8's crash text, but the process ends with exit code 1 (the first time):
// not a V8 abort, so it must not be rerun.
test('passes', () => {});
after(() => {
  if (firstTime('v8-text-exit-1-once')) {
    printV8CrashText();
    process.exit(1);
  }
});
