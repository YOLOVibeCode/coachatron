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
 * it now and then, so CI loses a test file whose tests all passed. It is
 * nodejs/node#66366, fixed upstream in V8 9b8ca54d5a; the Node 24 backport is
 * nodejs/node#66376. Node 22 and Node 26 do not have the bug. Production does
 * not run PGlite.
 *
 * Two parts:
 *   1. wasmWorkaroundFlags() turns off V8's WebAssembly code GC on V8 13.6,
 *      the path where the check fires.
 *   2. planRetry() names the test files whose process died of a V8 fatal error
 *      with no failing test in them, so they can run once more. Anything else
 *      fails the run as before.
 *
 * Remove both once the Node line in .nvmrc ships the backport (or .nvmrc
 * moves to 26) and CI has gone a while without "Retrying" in its log.
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
 * @typedef {StderrRecord | FailRecord} OutcomeRecord
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

const V8_FATAL_BANNER = /^# Fatal error in /m;
const V8_CHECK = /^# (Check failed: .*)$/m;
const JIT_PAGE_CHECK = /Check failed: jit_page/;

/**
 * Why a test file's process died, when it was V8 itself that gave up: the
 * WebAssembly code-memory check this script exists for, or any V8 fatal error
 * that ended the process with a signal. Null for everything else, including
 * running out of memory ("FATAL ERROR: ... heap out of memory" is not a V8
 * check) and an ordinary non-zero exit.
 *
 * @param {string} stderr everything the file's process wrote to stderr
 * @param {{ exitCode: number | null, signal: string | null }} ended
 */
export function v8CrashReason(stderr, ended) {
  const check = V8_CHECK.exec(stderr)?.[1];
  const how = ended.signal ? `ended by ${ended.signal}` : `exit code ${ended.exitCode}`;
  if (JIT_PAGE_CHECK.test(stderr)) {
    return `V8 crashed inside WebAssembly code memory (${how}): "${check}", nodejs/node#66366`;
  }
  if (V8_FATAL_BANNER.test(stderr) && ended.signal) {
    return `V8 fatal error (${how}): "${check ?? 'no check line'}"`;
  }
  return null;
}

/**
 * @typedef {{ file: string, reason: string }} Retry
 * @typedef {{ file: string | null, reason: string }} Blocking
 * @typedef {{ retry: Retry[], blocking: Blocking[], notRetried: Retry[] }} Plan
 */

/**
 * Splits a failed run into files that may run once more (`retry`) and
 * failures that stand (`blocking`). A file is retried only when its process
 * died of a V8 fatal error and none of its tests failed. If anything else
 * failed, nothing is retried and the V8 crashes are listed in `notRetried`:
 * the run fails as it is.
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
      blocking.push({ file: f.file, reason: `its process ${how}, not a V8 fatal error` });
    }
  }
  if (blocking.length > 0) return { retry: [], blocking, notRetried: retry };
  return { retry, blocking, notRetried: [] };
}
