import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasWasmWrapperBug } from '../../../scripts/test-crash-retry.mjs';

test('the test file process gets --no-wasm-code-gc exactly when its V8 has the bug', () => {
  assert.equal(process.execArgv.includes('--no-wasm-code-gc'), hasWasmWrapperBug(), process.execArgv.join(' '));
});
