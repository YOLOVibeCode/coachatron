import assert from 'node:assert/strict';

function post(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

export function cookieJar(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).map((line) => /^([^;]*)/.exec(line)![1]).join('; ');
}

export function sessionCookie(res: Response): string | null {
  const header = res.headers.getSetCookie?.().find((c) => c.startsWith('cx_session='));
  return header ? /^([^;]*)/.exec(header)![1] ?? null : null;
}

/** Enters a code; for a new coach, redirects to the profile step. */
export async function postVerify(
  base: string,
  to: string,
  code: string,
  cookie = '',
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/signin/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...extraHeaders },
    body: new URLSearchParams({ to, code }),
    redirect: 'manual',
  });
}

/** After a successful verify for a new coach, finishes signup on the profile step. */
export async function finishNewCoachProfile(
  base: string,
  verifyRes: Response,
  profile: Record<string, string>,
): Promise<Response> {
  assert.equal(verifyRes.status, 303, 'verify should redirect to profile or schedule');
  const jar = cookieJar(verifyRes);
  const location = verifyRes.headers.get('location') ?? '';
  if (location.includes('/app/')) return verifyRes;
  assert.match(location, /\/signin\/profile/);
  return post(base, '/signin/profile', profile, jar);
}

/** OTP verify, then profile when needed, for a brand-new coach. */
export async function signUpNewCoach(
  base: string,
  to: string,
  code: string,
  name: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  const verify = await postVerify(base, to, code);
  if (verify.headers.get('location')?.includes('/app/')) return verify;
  return finishNewCoachProfile(base, verify, { name, tz: 'America/Chicago', ...extra });
}