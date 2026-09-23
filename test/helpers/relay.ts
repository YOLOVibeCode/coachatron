import { startFakeRelay, type FakeRelay } from '../fakes/relay.js';

export const TEST_RELAY_API_KEY = 'test-relay-key';

export async function withRelay<T>(fn: (relay: FakeRelay) => Promise<T>): Promise<T> {
  const relay = await startFakeRelay();
  process.env.RELAY_BASE_URL = relay.url;
  process.env.RELAY_API_KEY = TEST_RELAY_API_KEY;
  try {
    return await fn(relay);
  } finally {
    await relay.close();
    delete process.env.RELAY_BASE_URL;
    delete process.env.RELAY_API_KEY;
  }
}
