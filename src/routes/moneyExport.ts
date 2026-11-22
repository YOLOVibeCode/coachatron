import { Router, type Request, type RequestHandler, type Response } from 'express';
import { getDb } from '../db/client.js';
import { findCoachById } from '../domain/auth.js';
import {
  bookingsCsv,
  CUSTOM_RANGE,
  DOWNLOAD_LIMITS,
  downloadLimitKey,
  MAX_CUSTOM_DAYS,
  MAX_EXPORT_ROWS,
  paymentsCsv,
  presetRange,
  RANGE_PRESETS,
  resolveRange,
  type RangePreset,
} from '../domain/moneyExport.js';
import { isOverLimit, takeRequest } from '../domain/requestLimits.js';
import { html, page, type SafeHtml } from '../lib/html.js';
import { DEFAULT_TZ, isValidTimeZone } from '../lib/time.js';

/** The Download block on Money (screen 7) and the two files behind it: the
 * coach's payments and bookings as CSV, for a range of days in the coach's
 * timezone (src/domain/moneyExport.ts). No screen of its own. */

const PAYMENTS_PATH = '/app/money/download/payments.csv';
const BOOKINGS_PATH = '/app/money/download/bookings.csv';

const PRESET_WORDS: Record<RangePreset, string> = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'this-year': 'This year',
  'last-year': 'Last year',
};

function coachZone(tz: string): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** The block on Money: one range and two buttons. A plain GET form, so each
 * button asks for a file and works without scripts. Both buttons are
 * outlined: the screen keeps its one filled action. */
export function renderDownloadBlock(tz: string, now: Date = new Date()): SafeHtml {
  const zone = coachZone(tz);
  return html`<h2 id="download">Download</h2>
    <div class="card download">
      <p class="muted">Your payments and bookings as spreadsheet files (CSV), for your bookkeeping and taxes. Payments are listed by the day they were paid, bookings by the day of the session. Amounts are what clients paid, before fees. A part-refund made outside Coachatron appears in the file but not in Payments totals.</p>
      <form method="get" action="${PAYMENTS_PATH}">
        <label for="download_range">Range</label>
        <select id="download_range" name="range">
          ${RANGE_PRESETS.map((preset) => html`<option value="${preset}">${PRESET_WORDS[preset]} (${presetRange(preset, zone, now).words})</option>`)}
          <option value="${CUSTOM_RANGE}">Custom dates</option>
        </select>
        <label for="download_from">From (for custom dates)</label>
        <input id="download_from" name="from" type="date" />
        <label for="download_to">To (for custom dates, up to ${MAX_CUSTOM_DAYS} days)</label>
        <input id="download_to" name="to" type="date" />
        <button type="submit" class="ghost">Download payments</button>
        <button type="submit" class="ghost" formaction="${BOOKINGS_PATH}">Download bookings</button>
      </form>
    </div>`;
}

/** A short page in place of a file that was not made, with the way back. */
function refusal(res: Response, status: number, title: string, message: string): void {
  res.status(status).send(
    page(
      title,
      html`<h1>${title}</h1>
        <p class="muted">${message}</p>
        <a class="action" href="/app/payments#download">Back to Payments</a>`,
    ),
  );
}

function setFileHeaders(res: Response, kind: string, label: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="coachatron-${kind}-${label}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
}

async function sendFile(kind: 'payments' | 'bookings', req: Request, res: Response): Promise<void> {
  const headOnly = req.method === 'HEAD';
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const tz = coachZone(coach.tz);
  const range = resolveRange(req.query, tz, new Date());
  if (!range) {
    refusal(
      res,
      400,
      'That range did not work',
      `Choose a range. To use your own dates, choose "Custom dates" and give a from and a to date, the first no later than the last and no more than ${MAX_CUSTOM_DAYS} days apart. With any other range, leave the dates empty.`,
    );
    return;
  }
  // Refused before the query when the hour's downloads are used up; counted
  // only once a file was made, so a refusal or a bad range costs nothing.
  if (await isOverLimit(db, DOWNLOAD_LIMITS, downloadLimitKey(coach.id))) {
    refusal(res, 429, 'Too many downloads', 'That is more downloads than an hour allows. Try again in an hour.');
    return;
  }
  if (headOnly) {
    // Headers only: no query, nothing counted.
    setFileHeaders(res, kind, range.label);
    res.status(200).end();
    return;
  }
  const made = kind === 'payments' ? await paymentsCsv(db, coach.id, tz, range) : await bookingsCsv(db, coach.id, tz, range);
  if (!made.ok) {
    refusal(
      res,
      422,
      'That range is too long',
      `It holds more than ${MAX_EXPORT_ROWS.toLocaleString('en-US')} ${kind}, which is more than one file takes. Choose a shorter range and download it in parts.`,
    );
    return;
  }
  await takeRequest(db, DOWNLOAD_LIMITS, downloadLimitKey(coach.id));
  setFileHeaders(res, kind, range.label);
  res.status(200).send(Buffer.from(made.csv, 'utf8'));
}

/** The two downloads, behind the coach's sign-in: signed out goes to
 * sign-in, and a coach gets only their own rows. `requireAuth` is the coach
 * screens' own check, handed in by the router that mounts this one. */
export function moneyDownloadRouter(requireAuth: RequestHandler): Router {
  const router = Router();
  // HEAD is answered by the same handler, which sends headers alone.
  router.head(PAYMENTS_PATH, requireAuth, (req, res) => sendFile('payments', req, res));
  router.head(BOOKINGS_PATH, requireAuth, (req, res) => sendFile('bookings', req, res));
  router.get(PAYMENTS_PATH, requireAuth, (req, res) => sendFile('payments', req, res));
  router.get(BOOKINGS_PATH, requireAuth, (req, res) => sendFile('bookings', req, res));
  return router;
}
