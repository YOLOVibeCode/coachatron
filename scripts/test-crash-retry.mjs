// @ts-check
/**
 * The parts of scripts/run-tests.mjs that decide, kept free of side effects
 * so test/test-crash-retry.test.ts can feed them made-up runner output.
 *
 * Why this exists: Node 24 ships V8 13.6, which can free a WebAssembly import
 * wrapper twice and abort the whole process with
 *
 *   # Fatal error in , line 0
 *   # Check failed: jit_page_->allocations_.erase(addr) == 1.
 *
 * PGlite (Postgres compiled to WebAssembly, used only by the tests) triggers
 * it now and then, partway through a test file: the process dies, and the
 * results it had not yet sent to the runner are lost with it. It is
 * nodejs/node#66366, fixed upstream in V8 9b8ca54d5a; the Node 24 backport is
 * nodejs/node#66376. Node 22 and Node 26 do not have the bug. Production does
 * not run PGlite.
 *
 * Two parts:
 *   1. wasmWorkaroundFlags() turns off V8's WebAssembly code GC on V8 13.6,
 *      the path where the check fires.
 *   2. planRetry() names the test files whose process V8 aborted with no
 *      failure before the crash, so they can run once more. Because a crash
 *      cuts off results, "no failure" counts both the failures the runner
 *      received and those scripts/test-failure-recorder.mjs wrote down inside
 *      the process as they happened. The whole file runs again and must pass.
 *      Anything else fails the run as before.
 *
 * Remove both, with scripts/test-failure-recorder.mjs and run-tests.mjs (set
 * npm test back to node --import tsx --test), once the Node line in .nvmrc
 * ships the backport (or .nvmrc moves to 26) and CI has gone a while without
 * "Retrying" in its log.
 */

import { resolve } from 'node:path';

/** V8 13.6 is the V8 every Node 24 release ships (24.22.2 has 13.6.233.17). */
export function hasWasmWrapperBug(v8Version = process.versions.v8) {
  return /^13\.6\./.test(v8Version);
}

/**
 * Node flags for the test processes. The test runner passes V8 flags given on
 * its own command line on to every test file's process (getRunArgs in
 * lib/internal/test_runner/runner.js), so putting them before --test is enough.
 * With wasm code GC off, V8 keeps WebAssembly code it no longer needs until
 * the process exits; each test file is its own short process, so that is
 * cheap.
 */
export function wasmWorkaroundFlags(v8Version = process.versions.v8) {
  return hasWasmWrapperBug(v8Version) ? ['--no-wasm-code-gc'] : [];
}

/**
 * @typedef {{ kind: 'stderr', file: string, line: string }} StderrRecord
 * @typedef {{ kind: 'fail', file: string | null, name: string,
 *   failureType: string | null,
 *   process: { exitCode: number | null, signal: string | null } | null }} FailRecord
 * @typedef {{ kind: 'recorded', file: string, name: string }} RecordedRecord
 *   a failure scripts/test-failure-recorder.mjs wrote down inside the test
 *   file's process, which survives a crash that cuts off the runner's copy
 * @typedef {StderrRecord | FailRecord | RecordedRecord} OutcomeRecord
 */

/**
 * Test reporter (passed to node --test as a second --test-reporter). It writes
 * one JSON line per failure and per stderr line, tagged with the test file,
 * for run-tests.mjs to read back. The spec reporter still prints what people
 * read.
 *
 * A failure whose error carries exitCode and signal is the runner's own
 * failure for a test file whose process ended badly; any other failure is a
 * test that failed. Stderr events name the file as given on the command line
 * and failures name it as an absolute path, so both are resolved here.
 *
 * @param {AsyncIterable<{ type: string, data: any }>} source
 */
export default async function* outcomeReporter(source) {
  for await (const event of source) {
    const data = event.data ?? {};
    const file = typeof data.file === 'string' ? resolve(data.file) : null;
    if (event.type === 'test:stderr') {
      if (file) yield `${JSON.stringify({ kind: 'stderr', file, line: String(data.message ?? '') })}\n`;
    } else if (event.type === 'test:fail') {
      const error = data.details?.error;
      const ended = error && typeof error === 'object' && 'exitCode' in error && 'signal' in error;
      /** @type {FailRecord} */
      const record = {
        kind: 'fail',
        file,
        name: String(data.name ?? ''),
        failureType: error?.failureType ?? null,
        process: ended ? { exitCode: error.exitCode ?? null, signal: error.signal ?? null } : null,
      };
      yield `${JSON.stringify(record)}\n`;
    }
  }
}

/** @param {string} text */
export function parseOutcomes(text) {
  /** @type {OutcomeRecord[]} */
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim()) records.push(JSON.parse(line));
  }
  return records;
}

const V8_FATAL_BANNER = /^# Fatal error in [^\n]*$/m;
/** The line V8 prints right after its banner, e.g. "Check failed: ...". */
const V8_FATAL_MESSAGE = /^# Fatal error in [^\n]*\n# ([^\n]*?)\r?$/m;
const JIT_PAGE_CHECK = /^Check failed: jit_page/;
/**
 * How a V8 abort ends a process: SIGTRAP or SIGILL from V8's immediate crash
 * (the default, --hard-abort), SIGABRT from abort(). Never an exit code, and
 * never SIGKILL, which only comes from outside (the OOM killer, a timeout).
 */
const V8_ABORT_SIGNALS = new Set(['SIGTRAP', 'SIGILL', 'SIGABRT']);

/**
 * Why a test file's process died, when it was V8 itself that gave up: the
 * WebAssembly code-memory check this script exists for, or any other V8
 * fatal error. It has to look like a real V8 abort: V8's "# Fatal error in"
 * banner at the start of a line, and the process ended by one of the signals
 * above. Null for everything else, including the same text printed by a
 * process that then exited with a code or was killed, running out of memory
 * ("FATAL ERROR: ... heap out of memory" is not V8's banner), and an
 * ordinary non-zero exit.
 *
 * @param {string} stderr everything the file's process wrote to stderr
 * @param {{ exitCode: number | null, signal: string | null }} ended
 */
export function v8CrashReason(stderr, ended) {
  if (!ended.signal || !V8_ABORT_SIGNALS.has(ended.signal)) return null;
  if (!V8_FATAL_BANNER.test(stderr)) return null;
  const message = V8_FATAL_MESSAGE.exec(stderr)?.[1] || null;
  const how = `ended by ${ended.signal}`;
  if (message && JIT_PAGE_CHECK.test(message)) {
    return `V8 crashed inside WebAssembly code memory (${how}): "${message}", nodejs/node#66366`;
  }
  return `V8 fatal error (${how}): ${message ? `"${message}"` : 'no check line'}`;
}

/**
 * @typedef {{ file: string, reason: string }} Retry
 * @typedef {{ file: string | null, reason: string }} Blocking
 * @typedef {{ retry: Retry[], blocking: Blocking[], notRetried: Retry[] }} Plan
 */

/**
 * Splits a failed run into files that may run once more (`retry`) and
 * failures that stand (`blocking`). A file is retried only when its process
 * died of a V8 abort and no failure was reported before the crash, by the
 * runner or by the recorder inside the process. A crash can still cut off
 * tests that had not run yet, so the retry runs the whole file, and it must
 * pass. If anything failed, nothing is retried and the V8 crashes are listed
 * in `notRetried`: the run fails as it is.
 *
 * @param {OutcomeRecord[]} records
 * @returns {Plan}
 */
export function planRetry(records) {
  /** @type {Map<string, string>} */
  const stderr = new Map();
  /** @type {FailRecord[]} */
  const fails = [];
  for (const r of records) {
    if (r.kind === 'stderr') stderr.set(r.file, (stderr.get(r.file) ?? '') + r.line);
    else if (r.kind === 'fail') fails.push(r);
  }

  /** @type {Blocking[]} */
  const blocking = [];
  for (const r of records) {
    if (r.kind === 'recorded') {
      blocking.push({ file: resolve(r.file), reason: `failed, written down in its process: ${r.name}` });
    }
  }
  /** @type {Retry[]} */
  const retry = [];
  for (const f of fails) {
    if (!f.process) {
      blocking.push({ file: f.file, reason: `test failed: ${f.name}` });
      continue;
    }
    if (!f.file) {
      blocking.push({ file: null, reason: `a test process failed outside any file: ${f.name}` });
      continue;
    }
    const reason = v8CrashReason(stderr.get(f.file) ?? '', f.process);
    if (reason) retry.push({ file: f.file, reason });
    else {
      const how = f.process.signal ? `ended by ${f.process.signal}` : `exit code ${f.process.exitCode}`;
      blocking.push({ file: f.file, reason: `its process ${how}, not a V8 abort` });
    }
  }
  if (blocking.length > 0) return { retry: [], blocking, notRetried: retry };
  return { retry, blocking, notRetried: [] };
}
