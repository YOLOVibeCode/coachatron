import { test, after } from 'node:test';

test('passes', () => {});
after(() => process.exit(3));
