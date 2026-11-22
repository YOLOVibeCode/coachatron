import assert from 'node:assert/strict';

/** Loads the session-types create form token and cx_type_create cookie. */
export async function loadSessionTypeCreate(
  base: string,
  cookie: string,
): Promise<{ bodyToken: string; cookie: string }> {
  const res = await fetch(`${base}/app/session-types`, { headers: { cookie } });
  const html = await res.text();
  const match = /name="create_token" value="([^"]+)"/.exec(html);
  assert.ok(match, 'expected create_token on session types page');
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const typeLine = setCookie.map((c) => /^([^;]+)/.exec(c)?.[1]).find((c) => c?.startsWith('cx_type_create='));
  const merged = typeLine ? `${cookie}; ${typeLine}` : cookie;
  return { bodyToken: match[1], cookie: merged };
}

export async function postNewSessionType(
  base: string,
  cookie: string,
  fields: Record<string, string>,
): Promise<Response> {
  const { bodyToken, cookie: withCreate } = await loadSessionTypeCreate(base, cookie);
  return fetch(`${base}/app/session-types`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: withCreate },
    body: JSON.stringify({ ...fields, create_token: bodyToken }),
    redirect: 'manual',
  });
}