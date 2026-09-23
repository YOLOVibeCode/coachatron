/** Minimal cookie parse/serialize so the app does not need the `cookie`
 * package. Session tokens are already high-entropy random bearer values
 * looked up server-side in `coach_session`, so no extra HMAC signature is
 * required on the cookie itself — a forged value simply matches no row. */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join('; ');
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
