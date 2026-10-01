import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** One Node version, read three ways: nvm and CI read .nvmrc, Railway
 * (Railpack) reads package.json engines first. If they drift, a deploy runs
 * a Node nobody tested. */

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

function major(v: string): number {
  const m = /(\d+)/.exec(v);
  assert.ok(m, `no version number in ${JSON.stringify(v)}`);
  return Number(m[1]);
}

test('.nvmrc, package.json engines, and CI name the same Node line', () => {
  const nvmrc = read('.nvmrc').trim();
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
  assert.match(engines, /^>=\d+$/, 'engines.node is a floor like ">=24"; Railpack deploys that major');
  assert.equal(major(engines), major(nvmrc), `engines ${engines} and .nvmrc ${nvmrc} disagree`);
  assert.equal(major(nvmrc) % 2, 0, 'production runs an even (LTS) Node line');
  assert.match(read('.github/workflows/ci.yml'), /node-version-file: \.nvmrc/);
});

test('the Node running these tests meets engines', () => {
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
  assert.ok(
    major(process.version) >= major(engines),
    `running Node ${process.version}, but package.json needs ${engines}. Run "nvm use" in this folder.`,
  );
});
