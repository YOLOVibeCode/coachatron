import type { NextFunction, Request, Response } from 'express';

/** Pages whose URL is the only key to something private: a booking's
 * manage link, a start link, an offer, a payments link, a sign-in code
 * page, a checkout. Express matches routes whatever the case, so these do too. */
const PRIVATE_LINK = /^\/(?:booking|start|offer|p)\/|^\/signin\/verify(?:\/|$)|^\/c\/[^/]+\/checkout\//i;

export function isPrivateLinkPath(path: string): boolean {
  return PRIVATE_LINK.test(path);
}

/** Headers on every response. No page may be framed by another site,
 * nothing is sniffed as a different type, and pages behind a private link
 * or a session are neither cached nor named in a Referer. */
export function pageHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  const path = req.path.toLowerCase();
  if (isPrivateLinkPath(path)) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  } else if (path === '/app' || path.startsWith('/app/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

/** Railway's edge is one proxy hop in front of the app, so the client's
 * address is the last one it appends to X-Forwarded-For. TRUST_PROXY_HOPS
 * overrides that when another proxy is put in front. */
export function trustProxyHops(): number {
  const raw = (process.env.TRUST_PROXY_HOPS ?? '').trim();
  const hops = raw ? Number(raw) : 1;
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}
