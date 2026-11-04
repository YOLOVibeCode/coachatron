// @ts-check
/**
 * `npm test`: runs the suite with node's test runner, as before, and reruns a
 * test file once only when V8 itself crashed in it (see test-crash-retry.mjs
 * for the Node 24 bug and when to remove this).
 *
 *   node scripts/run-tests.mjs [node options] <test files>
 *
 * Node options are the arguments that start with "-" (use the --name=value
 * form); they go before --test, like --test-name-pattern=... . Everything
 * else is a test file.
 *
 * The exit code is the runner's, except that a run whose only failures were
 * V8 aborts takes the exit code of the rerun of those files. A test that
 * fails, a process that ends any other way, or a second crash fails the run.
 *
 * A V8 abort kills a test file's process partway through, and results the
 * runner had not yet received die with it. So each test file's process also
 * loads scripts/test-failure-recorder.mjs, which writes every failure to disk
 * as it happens; a file with a failure there is never rerun.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOutcomes, planRetry, wasmWorkaroundFlags } from './test-crash-retry.mjs';

const reporter = fileURLToPath(new URL('./test-crash-retry.mjs', import.meta.url));
const recorder = new URL('./test-failure-recorder.mjs', import.meta.url).href;
const args = process.argv.slice(2);
const nodeOptions = args.filter((a) => a.startsWith('-'));
const files = args.filter((a) => !a.startsWith('-'));
const say = (line = '') => process.stdout.write(`${line}\n`);
const show = (/** @type {string | null} */ file) => (file ? relative(process.cwd(), file) : '(no file)');

/** @type {import('node:child_process').ChildProcess | null} */
let running = null;
let interrupted = false;
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    interrupted = true;
    running?.kill(signal);
  });
}

/**
 * One run of node's test runner over `testFiles`, printing the spec reporter
 * as usual and collecting failures and stderr per file on the side: what the
 * runner received (outcomes.jsonl, from the reporter) and what each test
 * file's process wrote down itself (recorded.jsonl, from the recorder).
 * @param {string[]} testFiles
 */
async function runOnce(testFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'coachatron-tests-'));
  const outcomes = join(dir, 'outcomes.jsonl');
  const recorded = join(dir, 'recorded.jsonl');
  try {
    const child = spawn(
      process.execPath,
      [
        ...wasmWorkaroundFlags(),
        '--import', 'tsx',
        '--import', recorder,
        '--test',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${reporter}`, `--test-reporter-destination=${outcomes}`,
        ...nodeOptions,
        ...testFiles,
      ],
      { stdio: 'inherit', env: { ...process.env, COACHATRON_TEST_FAILURES: recorded } },
    );
    running = child;
    /** @type {[number | null, NodeJS.Signals | null]} */
    const [code, signal] = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('exit', (c, s) => done([c, s]));
    });
    running = null;
    /** @param {string} path */
    const read = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return ''; // The runner died before its reporters wrote anything, or nothing failed.
      }
    };
    return { code: code ?? 1, signal, records: parseOutcomes(read(outcomes) + read(recorded)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} message one line for the Actions summary */
function annotate(message) {
  if (process.env.GITHUB_ACTIONS === 'true') say(`::warning title=Test file rerun after a V8 crash::${message}`);
}

const first = await runOnce(files);
if (first.code === 0 || interrupted || first.signal) process.exit(first.code);

const plan = planRetry(first.records);
if (plan.retry.length === 0) {
  if (plan.notRetried.length > 0) {
    const shown = 10;
    say();
    say('[run-tests] Not rerunning anything: the run also failed for another reason.');
    for (const b of plan.blocking.slice(0, shown)) say(`[run-tests]   ${show(b.file)}: ${b.reason}`);
    if (plan.blocking.length > shown) say(`[run-tests]   ...and ${plan.blocking.length - shown} more`);
    for (const r of plan.notRetried) say(`[run-tests]   (${show(r.file)} also crashed: ${r.reason})`);
  }
  process.exit(first.code);
}

const names = plan.retry.map((r) => show(r.file));
say();
say(`[run-tests] Retrying ${names.length} test file${names.length === 1 ? '' : 's'} once.`);
say('[run-tests] V8 itself aborted these partway through. No failure was reported before');
say('[run-tests] the crash, to the runner or by the recorder inside the process. The crash');
say('[run-tests] cut off the rest of each file, so each runs again in full and must pass.');
say('[run-tests] The known cause is a Node 24 bug in WebAssembly code memory that PGlite');
say('[run-tests] hits (nodejs/node#66366; see scripts/test-crash-retry.mjs).');
for (const r of plan.retry) say(`[run-tests]   ${show(r.file)}: ${r.reason}`);
say();

const second = await runOnce(names);
say();
if (second.code === 0) {
  say(`[run-tests] Retried after a V8 crash, then passed: ${names.join(', ')}`);
  annotate(`V8 crashed in ${names.join(', ')}; rerun once and passed (nodejs/node#66366)`);
  process.exit(0);
}
say(`[run-tests] The rerun failed too, so the run fails: ${names.join(', ')}`);
process.exit(second.code);
