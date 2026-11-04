import { test, after } from 'node:test';
import { crashLikeV8, firstTime } from './v8-crash.mjs';

test('passes', () => {});
after(() => {
  if (firstTime('v8-crash-once')) crashLikeV8();
});
