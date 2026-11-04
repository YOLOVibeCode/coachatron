import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Railway stops a deploy with SIGTERM to the process it started. When that
 * was "npm start", npm passed the signal to the shell it runs the start
 * script in, and that shell, not the server, was what the signal stopped:
 * npm logged "signal SIGTERM" and the server's shutdown never ran. These
 * tests build the server, start it with npm the same way, and stop it the
 * same way. */

const root = fileURLToPath(new URL('..', import.meta.url));
let dir = '';

before(() => {
  // A folder of its own: the real package.json, the build, and the repo's
  // node_modules. realpath, so the server's "am I the main module" check
  // sees the same path node does (macOS's tmpdir is behind a symlink).
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'coachatron-start-')));
  execFileSync(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    path.join(root, 'tsconfig.json'),
    '--outDir',
    path.join(dir, 'dist'),
  ]);
  // The rest of npm run build: the migrations go next to the compiled code.
  mkdirSync(path.join(dir, 'dist/db/migrations'), { recursive: true });
  for (const file of readdirSync(path.join(root, 'src/db/migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(path.join(root, 'src/db/migrations', file), path.join(dir, 'dist/db/migrations', file));
  }
  copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  // A shell that keeps itself between npm and the command it runs. The ":"
  // after the script means the script's command is not the shell's last, so
  // the shell starts it as a child and waits instead of becoming it.
  writeFileSync(path.join(dir, 'parent-shell.sh'), '#!/bin/sh\nexec /bin/sh -c "$2\n:"\n');
  chmodSync(path.join(dir, 'parent-shell.sh'), 0o755);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** npm as `npm test` runs it, or the one on PATH. */
function npmCommand(): [string, string[]] {
  const cli = process.env.npm_execpath ?? '';
  return /\.c?js$/.test(cli) ? [process.execPath, [cli]] : ['npm', []];
}

interface Stopped {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  /** Whether any process npm started was still running after npm exited. */
  leftBehind: boolean;
}

/** Starts the built server with `npm start`, waits until it listens, sends
 * SIGTERM to the npm process alone (as Railway does to the process it
 * started), and reports how npm exited. */
async function startThenStop(extraNpmArgs: string[] = []): Promise<Stopped> {
  const [cmd, args] = npmCommand();
  const child = spawn(cmd, [...args, 'start', ...extraNpmArgs], {
    cwd: dir,
    // Its own process group, so whatever it leaves running can be found and
    // stopped afterwards.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? dir,
      PORT: '0',
      NODE_ENV: 'development',
      // Nothing this server does at boot calls these, and if it did, nothing answers.
      RELAY_BASE_URL: 'http://127.0.0.1:9',
      STORE_BASE_URL: 'http://127.0.0.1:9',
      LITELLM_BASE: 'http://127.0.0.1:9/v1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
    },
  });
  const group = child.pid ?? 0;
  let output = '';
  const listening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start:\n${output}`)), 30_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Coachatron listening on/.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await listening;
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`npm did not exit:\n${output}`)), 20_000)),
    ]);
    // Give anything npm left behind a moment to show itself.
    await new Promise((r) => setTimeout(r, 200));
    let leftBehind = true;
    try {
      process.kill(-group, 0);
    } catch {
      leftBehind = false;
    }
    return { ...result, output, leftBehind };
  } finally {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // Nothing was left running.
    }
  }
}

test('npm start hands SIGTERM to the server, which shuts down cleanly and exits 0', async () => {
  const stopped = await startThenStop();
  assert.match(stopped.output, /SIGTERM: finishing requests in flight, then stopping/, stopped.output);
  assert.equal(stopped.signal, null, stopped.output);
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(stopped.leftBehind, false, 'nothing is left running');
});

test('the server still gets SIGTERM when npm\'s shell would otherwise stay in between', async () => {
  const stopped = await startThenStop(['--script-shell', path.join(dir, 'parent-shell.sh')]);
  assert.match(stopped.output, /SIGTERM: finishing requests in flight, then stopping/, stopped.output);
  assert.doesNotMatch(stopped.output, /signal SIGTERM/, 'npm does not report its child stopped by the signal');
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal(stopped.leftBehind, false, 'the server did not outlive npm');
});

test('Railway starts node itself, and npm start replaces its shell with node', () => {
  const start = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: { start: string } }).scripts.start;
  assert.equal(start, 'exec node dist/server.js');
  assert.match(readFileSync(path.join(root, '.railway/railway.ts'), 'utf8'), /^\s+start: "node dist\/server\.js",$/m);
});
