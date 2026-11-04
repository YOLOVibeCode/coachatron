import type { NextFunction, Request, Response } from 'express';
import { html, page } from '../lib/html.js';
import { pathForLog } from '../lib/headers.js';

/** The page for an address nothing answers. The same page the routes send
 * for a coach, session or link that does not exist. */
export function notFoundPage(): string {
  return page('Not found', html`<h1>Not found</h1><p class="muted">That page does not exist.</p>`);
}

function clientErrorPage(status: number): string {
  if (status === 404) return notFoundPage();
  if (status === 413) {
    return page('Too much to send', html`<h1>Too much to send</h1><p class="muted">That was more than this page takes. Go back, shorten it, and try again.</p>`);
  }
  return page('Something was wrong with that', html`<h1>Something was wrong with that</h1><p class="muted">We could not read what was sent. Go back and try again.</p>`);
}

function serverErrorPage(): string {
  return page('Something went wrong', html`<h1>Something went wrong</h1><p class="muted">That did not work on our side. Try again in a minute.</p>`);
}

/** Last in the chain: any request no route answered. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).send(notFoundPage());
}

/** The 4xx status of an error the request itself caused: a bad
 * percent-escape in a route parameter (a URIError, which the router marks
 * 400), or a body body-parser will not read (too large, cut short, does not
 * parse or inflate, a charset or encoding it does not take). body-parser
 * makes those with http-errors, which marks a 4xx `expose: true`; a broken
 * gzip body has no `type`, so the mark is what counts. Null for anything
 * else, including an error that only carries another service's status, such
 * as the relay refusing a text (RelayHttpError, SellerError): that went
 * wrong here, not in the request. */
function clientErrorStatus(err: unknown): number | null {
  if (err instanceof URIError) return 400;
  if (typeof err !== 'object' || err === null) return null;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  if (expose !== true) return null;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499 ? status : null;
}

/** A short name for what went wrong: body-parser's type ("entity.too.large",
 * "entity.parse.failed"), else the error's name ("URIError"). */
function errorType(err: unknown): string {
  const { type, name } = err as { type?: unknown; name?: unknown };
  const candidate = typeof type === 'string' ? type : typeof name === 'string' ? name : '';
  return /^[\w.:-]{1,64}$/.test(candidate) ? candidate : 'Error';
}

/** Express's error handler: the last middleware, with four arguments.
 * A client error is one line on stdout (status, method, path without its
 * query or a link's key, and the error type: never the body, the headers or
 * a stack) and the branded page with its status. It goes to stdout because
 * Railway files everything on stderr at level error, and a visitor's bad
 * request is not one. Anything else is a fault here: its stack is logged
 * once at error level and the visitor gets a branded 500 that says nothing
 * about it. */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // Too late for a page: Express's own handler closes the connection.
    next(err);
    return;
  }
  const path = pathForLog((req.originalUrl ?? req.url).split('?')[0]).slice(0, 200);
  const status = clientErrorStatus(err);
  if (status !== null) {
    console.info(`${status} ${req.method} ${path} ${errorType(err)}`);
    res.status(status).send(clientErrorPage(status));
    return;
  }
  console.error(`500 ${req.method} ${path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  res.status(500).send(serverErrorPage());
}
