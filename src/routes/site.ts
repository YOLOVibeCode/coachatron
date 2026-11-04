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

siteRouter.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(isProductionSite() ? PRODUCTION_ROBOTS : ELSEWHERE_ROBOTS);
});

// /app is the coach's area; its home is the schedule, which sends a coach
// who is signed out to /signin.
siteRouter.get('/app', (_req, res) => {
  res.redirect(303, '/app/schedule');
});
