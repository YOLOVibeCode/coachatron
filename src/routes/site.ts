import { Router } from 'express';
import { isProductionSite } from '../config.js';

export const siteRouter = Router();

/** Production lets crawlers read the public pages (the landing page, a
 * coach's page and booking form, the legal and texting pages, sign-in) and
 * keeps them off every page a link's key opens, and off the coach's screens.
 * A Disallow line is a prefix, so each private link keeps its slash: "/p"
 * alone would also hide /privacy. "*" matches any run of characters. */
export const PRODUCTION_ROBOTS = `User-agent: *
Allow: /
Disallow: /app
Disallow: /booking/
Disallow: /offer/
Disallow: /start/
Disallow: /p/
Disallow: /c/*/checkout/
Disallow: /signin/verify
Disallow: /*?from=
Disallow: /*&from=
`;

/** Development and uat: nothing is crawled. */
export const ELSEWHERE_ROBOTS = `User-agent: *
Disallow: /
`;

/** The tab icon: a cream "C" on the Postcard teal, small enough to send
 * inline. Every page's head points to /favicon.svg; /favicon.ico answers
 * the same picture for browsers and crawlers that ask for that name. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#0e6b64"/>' +
  '<path d="M44 22a14 14 0 1 0 0 20" fill="none" stroke="#f6e7d8" stroke-width="8" stroke-linecap="round"/>' +
  '</svg>';

/** A day: the icon rarely changes, and a new one shows by the next day. */
const FAVICON_CACHE = 'public, max-age=86400';

siteRouter.get(['/favicon.svg', '/favicon.ico'], (_req, res) => {
  res.setHeader('Cache-Control', FAVICON_CACHE);
  res.type('image/svg+xml').send(FAVICON_SVG);
});

siteRouter.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(isProductionSite() ? PRODUCTION_ROBOTS : ELSEWHERE_ROBOTS);
});

// /app is the coach's area; its home is the schedule, which sends a coach
// who is signed out to /signin.
siteRouter.get('/app', (_req, res) => {
  res.redirect(303, '/app/schedule');
});
