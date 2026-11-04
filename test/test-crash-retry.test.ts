import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import outcomeReporter, {
  hasWasmWrapperBug,
  parseOutcomes,
  planRetry,
  wasmWorkaroundFlags,
} from '../scripts/test-crash-retry.mjs';

/** `npm test` reruns a test file once when V8 crashed in it and none of its
 * tests failed (scripts/run-tests.mjs; the Node 24 bug is nodejs/node#66366).
 * The first half feeds the decision made-up runner events. The second half
 * runs scripts/run-tests.mjs on the test files in test/fixtures/crash-retry/,
 * some of which print V8's crash text and end themselves with SIGTRAP. */

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = 'test/fixtures/crash-retry';

const JIT_PAGE_CRASH =
  '\n\n#\n# Fatal error in , line 0\n# Check failed: jit_page_->allocations_.erase(addr) == 1.\n#\n#\n#\n' +
  '#FailureMessage Object: 0x7fffbbbd3240\n----- Native stack trace -----\n\n' +
  ' 3: 0xd959e4 v8::internal::ThreadIsolation::JitPageReference::UnregisterAllocation(unsigned long) [node]\n';

type Event = { type: string; data: Record<string, unknown> };

/** stderr lines as the runner reports them: one event per line, file as given. */
function stderr(file: string, text: string): Event[] {
  return text.split(/(?<=\n)/).map((message) => ({ type: 'test:stderr', data: { file, message } }));
}

/** A test inside `file` that failed, as the runner reports it. */
function testFailed(file: string, name: string): Event {
  const error = Object.assign(new Error('test failed'), {
    failureType: 'testCodeFailure',
    cause: new assert.AssertionError({ message: '1 !== 2', actual: 1, expected: 2, operator: 'strictEqual' }),
  });
  return { type: 'test:fail', data: { file: resolve(file), name, nesting: 0, details: { error } } };
}

/** The runner's own failure for a test file whose process ended badly. */
function processEnded(file: string, exitCode: number | null, signal: string | null, failureType = 'testCodeFailure'): Event {
  const error = Object.assign(new Error('test failed'), { failureType, exitCode, signal, stack: undefined });
  return { type: 'test:fail', data: { file: resolve(file), name: file, nesting: 0, details: { error } } };
}

function passed(file: string, name: string): Event {
  return { type: 'test:pass', data: { file: resolve(file), name, nesting: 0, details: {} } };
}

/** Runs the reporter over fake events and plans from what it wrote. */
async function plan(events: Event[]) {
  async function* source() {
    yield* events;
  }
  let text = '';
  for await (const chunk of outcomeReporter(source())) text += chunk;
  return planRetry(parseOutcomes(text));
}

test('a test that fails an assertion is never retried', async () => {
  const p = await plan([passed('test/a.test.ts', 'one'), testFailed('test/a.test.ts', 'two')]);
  assert.deepEqual(p.retry, []);
  assert.deepEqual(p.blocking, [{ file: resolve('test/a.test.ts'), reason: 'test failed: two' }]);
});

test('a file whose process died of the V8 WebAssembly check, with no failed test, is retried', async () => {
  const p = await plan([
    passed('test/refund-events.test.ts', 'one'),
    ...stderr('test/refund-events.test.ts', JIT_PAGE_CRASH),
    processEnded('test/refund-events.test.ts', null, 'SIGTRAP'),
    passed('test/other.test.ts', 'fine'),
  ]);
  assert.deepEqual(p.blocking, []);
  assert.equal(p.retry.length, 1);
  assert.equal(p.retry[0].file, resolve('test/refund-events.test.ts'));
  assert.match(p.retry[0].reason, /WebAssembly code memory \(ended by SIGTRAP\)/);
  assert.match(p.retry[0].reason, /"Check failed: jit_page_->allocations_\.erase\(addr\) == 1\."/);
  assert.match(p.retry[0].reason, /nodejs\/node#66366/);
});

test('any other V8 fatal check that ends the process with a signal is retried too', async () => {
  const p = await plan([
    ...stderr('test/a.test.ts', '\n#\n# Fatal error in , line 0\n# Check failed: code->is_dying().\n#\n'),
    processEnded('test/a.test.ts', null, 'SIGILL'),
  ]);
  assert.equal(p.retry.length, 1);
  assert.match(p.retry[0].reason, /^V8 fatal error \(ended by SIGILL\): "Check failed: code->is_dying\(\)\."/);
});

test('other crashes are not retried: an exit code, running out of memory, a V8 banner with no signal', async () => {
  const exit3 = await plan([processEnded('test/a.test.ts', 3, null)]);
  assert.deepEqual(exit3.retry, []);
  assert.deepEqual(exit3.blocking, [{ file: resolve('test/a.test.ts'), reason: 'its process exit code 3, not a V8 fatal error' }]);

  const oom = await plan([
    ...stderr('test/a.test.ts', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'),
    processEnded('test/a.test.ts', null, 'SIGABRT'),
  ]);
  assert.deepEqual(oom.retry, []);
  assert.match(oom.blocking[0].reason, /ended by SIGABRT, not a V8 fatal error/);

  const killed = await plan([processEnded('test/a.test.ts', null, 'SIGKILL')]);
  assert.deepEqual(killed.retry, []);

  const noSignal = await plan([
    ...stderr('test/a.test.ts', '#\n# Fatal error in , line 0\n# Check failed: x.\n'),
    processEnded('test/a.test.ts', 1, null),
  ]);
  assert.deepEqual(noSignal.retry, []);
});

test('a file with a failed test is not retried even if V8 also crashed in it', async () => {
  const p = await plan([
    testFailed('test/a.test.ts', 'two'),
    ...stderr('test/a.test.ts', JIT_PAGE_CRASH),
    processEnded('test/a.test.ts', null, 'SIGTRAP', 'subtestsFailed'),
  ]);
  assert.deepEqual(p.retry, []);
  assert.deepEqual(p.blocking, [{ file: resolve('test/a.test.ts'), reason: 'test failed: two' }]);
  assert.deepEqual(p.notRetried.map((r) => r.file), [resolve('test/a.test.ts')], 'the crash is still named');
});

test('two files that crashed in V8 are both retried, once each', async () => {
  const p = await plan([
    ...stderr('test/credit-proof.test.ts', JIT_PAGE_CRASH),
    processEnded('test/credit-proof.test.ts', null, 'SIGTRAP'),
    ...stderr('test/tick.test.ts', JIT_PAGE_CRASH),
    processEnded('test/tick.test.ts', null, 'SIGTRAP'),
  ]);
  assert.deepEqual(p.blocking, []);
  assert.deepEqual(
    p.retry.map((r) => r.file),
    [resolve('test/credit-proof.test.ts'), resolve('test/tick.test.ts')],
  );
});

test('a V8 crash is not retried when another file failed: the run fails as it is', async () => {
  const p = await plan([
    ...stderr('test/a.test.ts', JIT_PAGE_CRASH),
    processEnded('test/a.test.ts', null, 'SIGTRAP'),
    testFailed('test/b.test.ts', 'real failure'),
  ]);
  assert.deepEqual(p.retry, []);
  assert.deepEqual(p.blocking, [{ file: resolve('test/b.test.ts'), reason: 'test failed: real failure' }]);
  assert.deepEqual(p.notRetried.map((r) => r.file), [resolve('test/a.test.ts')]);
});

test('stderr counts only for the file that wrote it', async () => {
  const p = await plan([
    ...stderr('test/a.test.ts', JIT_PAGE_CRASH),
    processEnded('test/b.test.ts', null, 'SIGTRAP'),
  ]);
  assert.deepEqual(p.retry, []);
  assert.equal(p.blocking[0].file, resolve('test/b.test.ts'));
});

test('the WebAssembly workaround flag is only for V8 13.6, the V8 in Node 24', () => {
  assert.deepEqual(wasmWorkaroundFlags('13.6.233.17-node.63'), ['--no-wasm-code-gc']);
  assert.deepEqual(wasmWorkaroundFlags('12.4.254.21-node.33'), []);
  assert.deepEqual(wasmWorkaroundFlags('14.6.202.31-node.20'), []);
  assert.equal(hasWasmWrapperBug('13.6.233.17'), true);
  assert.equal(hasWasmWrapperBug('13.60.1'), false);
});

/** Runs `npm test`'s script on fixture files and returns its exit code and output. */
async function runTests(...files: string[]) {
  const markers = mkdtempSync(join(tmpdir(), 'crash-retry-markers-'));
  const env: NodeJS.ProcessEnv = { ...process.env, CRASH_RETRY_MARKERS: markers, GITHUB_ACTIONS: 'true' };
  delete env.NODE_TEST_CONTEXT; // or the inner runner reports to this one instead of printing
  try {
    const child = spawn(process.execPath, ['scripts/run-tests.mjs', ...files.map((f) => `${fixtures}/${f}`)], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    return { code, output, ran: readdirSync(markers) };
  } finally {
    rmSync(markers, { recursive: true, force: true });
  }
}

test('npm test: a file V8 crashed in once is rerun, passes, and the run passes with a notice', async () => {
  const r = await runTests('passes.mjs', 'v8-crash-once.mjs');
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /\[run-tests\] Retrying 1 test file once\./);
  assert.match(r.output, /\[run-tests\] {3}test\/fixtures\/crash-retry\/v8-crash-once\.mjs: V8 crashed inside WebAssembly code memory \(ended by SIGTRAP\)/);
  assert.match(r.output, /\[run-tests\] Retried after a V8 crash, then passed: test\/fixtures\/crash-retry\/v8-crash-once\.mjs/);
  assert.match(r.output, /^::warning title=Test file rerun after a V8 crash::V8 crashed in test\/fixtures\/crash-retry\/v8-crash-once\.mjs/m);
  assert.doesNotMatch(r.output, /passes\.mjs:/, 'only the crashed file is rerun');
});

test('npm test: a second crash fails the run', async () => {
  const r = await runTests('v8-crash-always.mjs');
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /Retrying 1 test file once/);
  assert.match(r.output, /\[run-tests\] The rerun failed too, so the run fails: test\/fixtures\/crash-retry\/v8-crash-always\.mjs/);
  assert.doesNotMatch(r.output, /::warning/);
});

test('npm test: an assertion failure fails the run, and a V8 crash beside it is not rerun', async () => {
  const r = await runTests('assertion-fails.mjs', 'v8-crash-once.mjs');
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /fails an assertion/);
  assert.doesNotMatch(r.output, /Retrying/);
  assert.match(r.output, /Not rerunning anything: the run also failed for another reason\./);
  assert.deepEqual(r.ran, ['v8-crash-once.ran'], 'the crashed file ran once');
});

test('npm test: a process that exits non-zero for another reason fails the run, no rerun', async () => {
  const r = await runTests('exits-3.mjs');
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /Retrying|Not rerunning/);
});

test('npm test: each test file process gets the V8 flag when the V8 needs it', async () => {
  const r = await runTests('wasm-flag.mjs', 'passes.mjs');
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /\[run-tests\]/);
});

test('npm test runs every test file through scripts/run-tests.mjs, and CI runs npm test', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs test/*.test.ts test/pg/*.test.ts');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /node [^\n]*--test/, 'CI runs the suite through npm test, not node --test');
  assert.equal(ci.match(/run: npm test$/gm)?.length, 2, 'the CI job and the Next Node jobs');
});
