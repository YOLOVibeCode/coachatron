import type { NextFunction, Request, Response } from 'express';

/** APP_BASE_URL's origin and host, or null when it is unset or is not an
 * http(s) address. Read at call time so tests can set it. */
function siteAddress(): { origin: string; host: string } | null {
  const raw = (process.env.APP_BASE_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { origin: url.origin, host: url.host.toLowerCase() };
  } catch {
    return null;
  }
}

/** The healthcheck answers on whatever host asks: Railway's own, the
 * service's *.up.railway.app name, or www. */
function isHealthPath(path: string): boolean {
  return /^\/health\/?$/i.test(path);
}

/** www.coachatron.com is the same service as coachatron.com, so a request
 * whose Host is exactly "www." plus APP_BASE_URL's host is sent to
 * APP_BASE_URL with the same path and query: 301 for GET and HEAD, 308 for
 * anything else, so a form post keeps its method and body. Every other host
 * (Railway's healthcheck and internal names, the *.up.railway.app name,
 * localhost, uat and dev) is answered as it is, and so is /health on any
 * host. With no APP_BASE_URL nothing is redirected. */
export function wwwRedirect(req: Request, res: Response, next: NextFunction): void {
  const site = siteAddress();
  const host = (req.headers.host ?? '').toLowerCase();
  if (!site || host !== `www.${site.host}` || isHealthPath(req.path)) {
    next();
    return;
  }
  // The request line's own path and query. Anything else there (an
  // absolute URL, or "*") goes to the home page rather than being copied.
  const target = req.originalUrl.startsWith('/') ? req.originalUrl : '/';
  const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
  res.redirect(status, `${site.origin}${target}`);
}

/** The page's address on APP_BASE_URL, for a <link rel="canonical">:
 * APP_BASE_URL's origin, then `path`. Null when APP_BASE_URL is unset, so a
 * local run names no address. */
export function canonicalUrl(path: string): string | null {
  const site = siteAddress();
  return site ? `${site.origin}${path}` : null;
}
