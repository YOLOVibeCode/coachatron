export interface RelayFetchOptions {
  /** Send `X-App-Env: dev` for relay email capture in non-production. */
  appEnv?: boolean;
}

function relayBaseUrl(): string {
  return (process.env.RELAY_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

function relayApiKey(): string {
  return process.env.RELAY_API_KEY ?? '';
}

function relayAppEnv(): string {
  return process.env.RELAY_APP_ENV ?? '';
}

export async function relayFetch(
  path: string,
  init: RequestInit = {},
  options: RelayFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  const apiKey = relayApiKey();
  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }
  const appEnv = relayAppEnv();
  if (options.appEnv && appEnv) {
    headers.set('x-app-env', appEnv);
  }
  const url = `${relayBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  return fetch(url, { ...init, headers });
}
