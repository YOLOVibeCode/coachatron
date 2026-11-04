import type { NextFunction, Request, Response } from 'express';
import { appBaseUrlIsHttps, isProductionSite } from '../config.js';

/** Pages whose URL is the only key to something private: a booking's
 * manage link, a start link, an offer, a payments link, a sign-in code
 * page, a checkout. Express matches routes whatever the case, so these do too. */
const PRIVATE_LINK = /^\/(?:booking|start|offer|p)\/|^\/signin\/verify(?:\/|$)|^\/c\/[^/]+\/checkout\//i;

export function isPrivateLinkPath(path: string): boolean {
  return PRIVATE_LINK.test(path);
}

/** The path with the key of a private link replaced by ":token", for a log
 * line: /booking/<token>/cancel is written as /booking/:token/cancel. */
export function pathForLog(path: string): string {
  return path
    .replace(/^(\/(?:booking|start|offer|p)\/)[^/]+/i, '$1:token')
    .replace(/^(\/c\/[^/]+\/checkout\/)[^/]+/i, '$1:token');
}

/** A year. No includeSubDomains: the header binds only the host that sends
 * it, so coachatron.com does not commit every other name under the domain
 * (a mail provider's link-tracking host, say) to https. No preload: the
 * preload list is built into browsers, and leaving it takes months. */
const HSTS = 'max-age=31536000';

/** A page that carries a booking's manage link along as ?from= (the coach's
 * page and the booking form, opened from that booking) is as private as the
 * link: the form is filled in with that booking's phone and email. */
function carriesPrivateLink(req: Request): boolean {
  return req.query.from !== undefined;
}

/** Headers on every response. No page may be framed by another site,
 * nothing is sniffed as a different type, and pages behind a private link
 * or a session are neither cached nor named in a Referer. Where the site is
 * served over https, browsers are told to keep using https; outside
 * production, search engines are told not to index anything. */
export function pageHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (appBaseUrlIsHttps()) res.setHeader('Strict-Transport-Security', HSTS);
  if (!isProductionSite()) res.setHeader('X-Robots-Tag', 'noindex');
  const path = req.path.toLowerCase();
  if (isPrivateLinkPath(path) || carriesPrivateLink(req)) {
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
