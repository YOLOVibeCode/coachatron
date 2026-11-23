import { Router, type RequestHandler, type Response } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import {
  buildCalendarFeed,
  CALENDAR_ADDRESS_LIMITS,
  CALENDAR_FEED_LIMITS,
  calendarFeedKey,
  calendarFeedUrl,
  calendarRetryAfterSeconds,
  calendarWebcalUrl,
  findFeedCoach,
  getCalendarToken,
  isFeedToken,
  replaceCalendarToken,
  turnOffCalendarFeed,
  turnOnCalendarFeed,
} from '../domain/calendarFeed.js';
import { clientKey, takeRequest } from '../domain/requestLimits.js';
import { html, page, raw, type SafeHtml } from '../lib/html.js';

/** The coach's schedule as a calendar feed (SPEC.md §8.2): the file a
 * calendar app reads, and the "Add to your calendar" block on Schedule
 * (screen 2) that makes, replaces and turns off its link. No screen of its
 * own. */

// ---- The block on Schedule ----

const SCHEDULE_BLOCK = '/app/schedule#calendar';
const CHANGE_LINK = '/app/schedule/calendar';

/** Copies the link box. Where the clipboard API is missing or refused, the
 * older copy command is tried on the selected box, and if that fails too
 * the link is left selected to copy by hand. */
const COPY_CALENDAR_LINK_SCRIPT =
  "var b=this,i=document.getElementById('calendar-link');i.focus();i.select();" +
  "function done(){b.textContent='Copied'}" +
  "function old(){try{if(document.execCommand('copy'))done()}catch(e){}}" +
  "try{navigator.clipboard.writeText(i.value).then(done,old)}catch(e){old()}";

/** What the block says after a change, by the ?calendar= value the change
 * sends the coach back with. */
const CHANGED_NOTICES: Record<string, string> = {
  replaced: 'This is your new link. The one before no longer works, so add this one to your calendar.',
  'turned-off': 'Your calendar link is off. Calendars that used it no longer get your sessions.',
};

function confirmCard(opts: { question: string; effect: string; action: string; confirm: string; keep: string }): SafeHtml {
  return html`<div class="card calendar-feed">
    <p><strong>${opts.question}</strong></p>
    <p class="muted">${opts.effect}</p>
    <form method="post" action="${CHANGE_LINK}">
      <div class="btn-row">
        <button type="submit" name="action" value="${opts.action}" class="action danger">${opts.confirm}</button>
        <a class="action ghost" href="${SCHEDULE_BLOCK}">${opts.keep}</a>
      </div>
    </form>
  </div>`;
}

/** The "Add to your calendar" block. `state` is the page's ?calendar=
 * value: "new" or "off" asks the coach to confirm that change first, the
 * way a refund is confirmed, since either one stops the link their
 * calendar uses. */
export function renderCalendarBlock(token: string | null, state: string): SafeHtml {
  const heading = html`<h2 id="calendar">Add to your calendar</h2>`;
  const notice = Object.hasOwn(CHANGED_NOTICES, state) ? CHANGED_NOTICES[state] : null;
  if (token === null) {
    return html`${heading}
      <div class="card calendar-feed">
        ${state === 'turned-off' && notice ? html`<p>${notice}</p>` : raw('')}
        <p class="muted">See your sessions in Apple, Google or Outlook calendar, next to the rest of your week. You add one private link, once, and the calendar keeps itself current.</p>
        <form method="post" action="${CHANGE_LINK}">
          <button type="submit" name="action" value="on" class="ghost">Get your calendar link</button>
        </form>
      </div>`;
  }
  if (state === 'new') {
    return html`${heading}
      ${confirmCard({
        question: 'Get a new link?',
        effect: 'The link you have now stops working at once, in every calendar it was added to. You then add the new one to see your sessions there again.',
        action: 'new',
        confirm: 'Get a new link',
        keep: 'Keep this link',
      })}`;
  }
  if (state === 'off') {
    return html`${heading}
      ${confirmCard({
        question: 'Turn off your calendar link?',
        effect: 'The link stops working at once, and calendars it was added to no longer get your sessions. You can get a new link any time.',
        action: 'off',
        confirm: 'Turn off',
        keep: 'Keep it on',
      })}`;
  }
  return html`${heading}
    <div class="card calendar-feed">
      ${state === 'replaced' && notice ? html`<p>${notice}</p>` : raw('')}
      <p class="muted">Your sessions show in your calendar app and stay current. The link is private. It shows each session's name, time, place and how many are booked, and names no athlete or client. Share it with no one.</p>
      <a class="action ghost" href="${calendarWebcalUrl(token)}">Add to calendar</a>
      <label for="calendar-link">Or copy the link</label>
      <input id="calendar-link" type="text" readonly value="${calendarFeedUrl(token)}" onfocus="this.select()" />
      <button type="button" class="ghost" onclick="${COPY_CALENDAR_LINK_SCRIPT}">Copy calendar link</button>
      <p class="muted">Apple (iPhone, iPad or Mac): tap Add to calendar, then Subscribe.</p>
      <p class="muted">Google: copy the link, then in Google Calendar on a computer choose Other calendars, +, From URL, and paste it. Google looks for changes about once a day.</p>
      <div class="btn-row">
        <a class="action ghost" href="/app/schedule?calendar=new#calendar">Get a new link</a>
        <a class="action ghost" href="/app/schedule?calendar=off#calendar">Turn off</a>
      </div>
    </div>`;
}

/** The block for this coach, for the Schedule screen to place. */
export async function calendarBlock(db: DbClient, coachId: number, state: unknown): Promise<SafeHtml> {
  return renderCalendarBlock(await getCalendarToken(db, coachId), typeof state === 'string' ? state : '');
}

// ---- The file, and the block's one form ----

/** /cal/<token>.ics, as a calendar app asks for it. */
const FEED_FILE = /^([A-Za-z0-9_-]+)\.ics$/;

function tooManyReads(res: Response, now: Date): void {
  res.setHeader('Retry-After', String(calendarRetryAfterSeconds(now)));
  res
    .status(429)
    .send(page('Try again later', html`<h1>Try again later</h1><p class="muted">This calendar was asked for too often. A calendar app tries again by itself.</p>`));
}

/** The feed's routes. `requireAuth` is the coach screens' sign-in check,
 * handed in so this file does not import the one that mounts it. */
export function calendarRoutes(requireAuth: RequestHandler): Router {
  const router = Router();

  // The link is the only key: no sign-in, and no cookie is read or set. A
  // link that was never made, was replaced or was turned off falls through
  // to the same 404 as any address nothing answers. An error on the way is
  // logged as /cal/:token (pathForLog in lib/headers.ts), never the link.
  router.get('/cal/:file', async (req, res, next) => {
    const match = FEED_FILE.exec(String(req.params.file));
    const db = getDb();
    const now = new Date();
    const coach = match && isFeedToken(match[1]) ? await findFeedCoach(db, match[1]) : null;
    if (!coach) {
      // Only a link that does not work counts against the address: that is
      // guessing. The same 404 as any address nothing answers.
      if (!(await takeRequest(db, CALENDAR_ADDRESS_LIMITS, clientKey(req), now))) {
        tooManyReads(res, now);
        return;
      }
      next();
      return;
    }
    // A link that works is limited only per calendar, so an outsider cannot
    // spend it without the link.
    if (!(await takeRequest(db, CALENDAR_FEED_LIMITS, calendarFeedKey(coach.id), now))) {
      tooManyReads(res, now);
      return;
    }
    const feed = await buildCalendarFeed(db, coach, now);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // The calendar app's own copy may be reused for five minutes; nothing
    // in between (a shared cache) may keep it.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('ETag', feed.etag);
    // send() answers 304 with no body when the app's If-None-Match names
    // this tag.
    res.send(feed.body);
  });

  router.post(CHANGE_LINK, requireAuth, async (req, res) => {
    const db = getDb();
    const coachId = res.locals.coachId as number;
    const action = (req.body as Record<string, unknown> | undefined)?.action;
    if (action === 'on') {
      await turnOnCalendarFeed(db, coachId);
    } else if (action === 'new') {
      // A form left open after the link was turned off makes nothing.
      if ((await replaceCalendarToken(db, coachId)) !== null) {
        res.redirect(303, '/app/schedule?calendar=replaced#calendar');
        return;
      }
    } else if (action === 'off') {
      await turnOffCalendarFeed(db, coachId);
      res.redirect(303, '/app/schedule?calendar=turned-off#calendar');
      return;
    }
    // Anything else changes nothing, like the screen's other forms.
    res.redirect(303, SCHEDULE_BLOCK);
  });

  return router;
}
