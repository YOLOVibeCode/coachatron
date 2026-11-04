import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What V8 prints when nodejs/node#66366 aborts a process. */
export function printV8CrashText() {
  process.stderr.write(
    '\n\n#\n# Fatal error in , line 0\n# Check failed: jit_page_->allocations_.erase(addr) == 1.\n#\n#\n#\n' +
      '#FailureMessage Object: 0x7fffbbbd3240\n----- Native stack trace -----\n\n' +
      ' 3: 0xd959e4 v8::internal::ThreadIsolation::JitPageReference::UnregisterAllocation(unsigned long) [node]\n',
  );
}

/** That text, then the abort the way V8 ends the process (SIGTRAP). */
export function crashLikeV8() {
  printV8CrashText();
  process.kill(process.pid, 'SIGTRAP');
}

/**
 * True the first time `name` asks, within one CRASH_RETRY_MARKERS folder.
 * @param {string} name
 */
export function firstTime(name) {
  const dir = process.env.CRASH_RETRY_MARKERS;
  if (!dir) throw new Error('CRASH_RETRY_MARKERS names the folder for this run; see test/test-crash-retry.test.ts');
  const marker = join(dir, `${name}.ran`);
  if (existsSync(marker)) return false;
  writeFileSync(marker, '');
  return true;
}
