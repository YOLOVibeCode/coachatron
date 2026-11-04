// @ts-check
/**
 * Loaded into every test file's process by scripts/run-tests.mjs with
 * node --import. The test runner passes --import on to each file's process,
 * the same way it passes --import tsx.
 *
 * Why: a test's result reaches the runner only after it has gone through the
 * test file's output stream, and a V8 abort kills the process before that
 * stream is flushed. In CI the crash came partway through files (2 of 5, 3 of
 * 12 and 2 of 4 results arrived), so a failure just before the crash could be
 * lost, and the file would be rerun as if nothing had failed. This writes each
 * failure to disk the moment it happens, with a synchronous append, so a
 * later abort in the same process cannot lose it. run-tests.mjs then refuses
 * to rerun a file with a failure written here.
 *
 * What it writes (one JSON line each, to the file named by
 * COACHATRON_TEST_FAILURES):
 *   - every test that did not pass, from a root-level afterEach. That covers
 *     a failed assertion, a timeout, and a failing before, beforeEach or
 *     afterEach hook, in nested tests too. A failing todo test is written
 *     down as well, which only means the file is not rerun.
 *   - every uncaught exception, including one thrown after its test ended.
 *
 * Not covered: a failing after() hook at the top of a file, and a promise
 * rejection nobody handled after its test ended. Those reach the runner only
 * if they arrive before a crash.
 *
 * It does nothing outside a test file's process (NODE_TEST_CONTEXT is
 * 'child-v8' there), so the runner process itself is untouched.
 */

import { appendFileSync } from 'node:fs';
import { afterEach } from 'node:test';

const out = process.env.COACHATRON_TEST_FAILURES;
if (out && process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const file = process.argv[1];
  /** @param {string} name */
  const record = (name) => appendFileSync(out, `${JSON.stringify({ kind: 'recorded', file, name })}\n`);

  afterEach((t) => {
    // context.passed is documented since Node 21.7 but missing from
    // @types/node. Anything but true is written down, so a Node that does not
    // report it fails safe: nothing is rerun.
    const { passed } = /** @type {{ passed?: boolean }} */ (t);
    if (passed !== true) record(t.fullName);
  });
  process.on('uncaughtExceptionMonitor', (error) => {
    record(`uncaught error: ${error instanceof Error ? error.message : String(error)}`);
  });
}
