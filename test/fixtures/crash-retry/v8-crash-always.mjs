import { test, after } from 'node:test';
import { crashLikeV8 } from './v8-crash.mjs';

test('passes', () => {});
after(() => crashLikeV8());
