import type { CompleteFn } from '../../src/llm/schema.js';

/** Test double for complete(). Returns a fixed intent object and records calls. */
export function fakeComplete(fixed: unknown): CompleteFn & { calls: unknown[] } {
  const fn = (async (req) => {
    fn.calls.push(req);
    if (fixed instanceof Error) throw fixed;
    return typeof fixed === 'function' ? (fixed as (r: unknown) => unknown)(req) : fixed;
  }) as CompleteFn & { calls: unknown[] };
  fn.calls = [];
  return fn;
}
