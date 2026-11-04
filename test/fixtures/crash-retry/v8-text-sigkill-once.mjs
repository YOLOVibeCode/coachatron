import { test, after } from 'node:test';
import { firstTime, printV8CrashText } from './v8-crash.mjs';

// V8's crash text, but the process is killed with SIGKILL (the first time),
// which V8 never sends itself: not a V8 abort, so it must not be rerun.
test('passes', () => {});
after(() => {
  if (firstTime('v8-text-sigkill-once')) {
    printV8CrashText();
    process.kill(process.pid, 'SIGKILL');
  }
});
