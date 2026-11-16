import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/client.js';
import { checkOtp, consumeOtp, contactKey, hasLiveOtp, parseContact, type Contact } from '../domain/auth.js';
import {
  clientKey,
  CODE_CHECK_CONTACT_LIMITS,
  CODE_CHECK_IP_LIMITS,
  SIGNIN_CODE_LIMITS,
  takeRequest,
} from '../domain/requestLimits.js';
import { canText } from '../domain/outbound.js';
import { loadMySessions, PAST_DAYS, type CoachCredits, type MySessions, type PastWord, type UpcomingBooking } from '../domain/mySessions.js';
import {
  consumeMySessionsLink,
  MY_SESSIONS_COOKIE,
  MY_SESSIONS_COOKIE_PATH,
  MY_SESSIONS_LINK_MINUTES,
  MY_SESSIONS_TTL_SECONDS,
  mySessionsLinkIsOpen,
  readMySessions,
  sendMySessionsProof,
  signMySessions,
} from '../domain/mySessionsProof.js';
import { clearCookie, parseCookies, serializeCookie } from '../lib/cookies.js';
import { html, page, raw, type SafeHtml } from '../lib/html.js';
import { displayPhone } from '../lib/phone.js';
import { formatClockLocal, NOT_A_TIME } from '../lib/time.js';

/** Screen 13, the parent's "My sessions" page: every session and credit a
 * parent has, across coaches, shown to whoever proves the email or mobile
 * they booked with. No account and no password.
 *
 *   GET  /my           the form: the email or mobile you booked with
 *   POST /my           sends a link (email) or a code (mobile)
 *   POST /my/code      checks a texted code
 *   GET  /my/link      an emailed link, opened: one button
 *   POST /my/link      uses the link
 *   GET  /my/sessions  the page, for the contact the cookie holds
 *   POST /my/signout   clears the cookie
 *
 * Whether a contact has bookings is not learnable here: asking answers
 * every email or mobile with the same page, a wrong, used or expired code
 * gets one page, and so does an unknown, used or expired link. A booking's
 * manage link never opens this page. */

export const mySessionsRouter = Router();

// Everything under /my is one person's: never cached, never passed on as a
// Referer, never indexed.
mySessionsRouter.use('/my', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
});

/** The longest contact the form reads: an email address's limit. */
const CONTACT_MAX_LENGTH = 254;

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function contactLabel(contact: Contact): string {
  return contact.kind === 'email' ? contact.email : displayPhone(contact.phone);
}

function provenContact(req: Request): Contact | null {
  return readMySessions(parseCookies(req.headers.cookie)[MY_SESSIONS_COOKIE]);
}

function openSessions(res: Response, contact: Contact): void {
  res.setHeader('Set-Cookie', serializeCookie(MY_SESSIONS_COOKIE, signMySessions(contact), MY_SESSIONS_TTL_SECONDS, MY_SESSIONS_COOKIE_PATH));
  res.redirect(303, '/my/sessions');
}

// ---- Asking ----

function renderAsk(values: { contact?: string; signedIn?: boolean } = {}, error?: string) {
  return page(
    'Your sessions',
    html`<h1>Your sessions</h1>
      <p class="muted">See every session you've booked and your session credits, with every coach, in one place. There is no account and no password.</p>
      <form method="post" action="/my">
        <label for="contact">The email or mobile you booked with</label>
        <input id="contact" name="contact" type="text" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="${CONTACT_MAX_LENGTH}" placeholder="you@example.com or (555) 555-0100" value="${values.contact ?? ''}" required />
        <p class="muted sms-once">An email gets a link. A mobile gets a one-time code by text; message and data rates may apply. Session credits show with your mobile.</p>
        <button type="submit">Continue</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}
      ${values.signedIn ? html`<a class="action ghost" href="/my/sessions">Back to your sessions</a>` : raw('')}`,
  );
}

/** The page after asking with a mobile. It reads the same whether or not a
 * code went out, and whoever the number belongs to. */
function renderCodeForm(contact: Extract<Contact, { kind: 'phone' }>, error?: string) {
  return page(
    'Enter your code',
    html`<h1>Enter your code</h1>
      <p class="muted">If ${displayPhone(contact.phone)} can get our texts, a 6-digit code is on its way. It lasts 10 minutes.</p>
      <form method="post" action="/my/code">
        <input type="hidden" name="contact" value="${contact.phone}" />
        <label for="code">Code</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required />
        <button type="submit">See my sessions</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}
      <p class="muted">No text after a minute? <a href="/my">Ask again</a>, or use the email you booked with. A number that replied STOP gets our texts again once it replies START.</p>`,
  );
}

/** The page after asking with an email. The same for every address. */
function renderLinkSent(contact: Extract<Contact, { kind: 'email' }>) {
  return page(
    'Check your email',
    html`<h1>Check your email</h1>
      <p class="muted">If we can reach ${contact.email}, a link is on its way. It works once and lasts ${MY_SESSIONS_LINK_MINUTES} minutes. Check spam if it is not there in a minute.</p>
      <a class="action ghost" href="/my">Use a different email or mobile</a>`,
  );
}

function renderTooMany() {
  return page(
    'Try again later',
    html`<h1>Too many tries</h1>
      <p class="muted">Too many from here for now. Try again later.</p>
      <a class="action ghost" href="/my">Back</a>`,
  );
}

/** One page for a link that is unknown, used, or expired. */
function renderLinkDone() {
  return page(
    'Link expired',
    html`<h1>That link is done</h1>
      <p class="muted">It was already used, or it has expired. Ask for a new one.</p>
      <a class="action" href="/my">Get a new link</a>`,
  );
}

/** One message for a code that is wrong, used, expired, or out of tries. */
const CODE_DID_NOT_WORK = "That code didn't work. Check it and try again, or ask for a new one.";

mySessionsRouter.get('/my', (req, res) => {
  res.status(200).send(renderAsk({ signedIn: provenContact(req) !== null }));
});

mySessionsRouter.post('/my', async (req, res) => {
  const typed = field(req.body, 'contact');
  const signedIn = provenContact(req) !== null;
  const again = (status: number, error: string) => {
    res.status(status).send(renderAsk({ contact: typed.slice(0, CONTACT_MAX_LENGTH), signedIn }, error));
  };
  const contact = typed.length <= CONTACT_MAX_LENGTH ? parseContact(typed) : null;
  if (!contact) {
    again(422, 'Enter the email address or mobile number you booked with.');
    return;
  }
  if (contact.kind === 'phone' && !canText(contact.phone)) {
    again(422, 'We text only US and Canadian mobile numbers. Use the email you booked with instead.');
    return;
  }
  const db = getDb();
  // The limit sign-in and checkout codes share: one address asks for only
  // so many codes and links, whoever they are for.
  if (!(await takeRequest(db, SIGNIN_CODE_LIMITS, clientKey(req)))) {
    again(429, 'Too many requests from here. Try again later.');
    return;
  }
  // Every email and every mobile is sent its link or code, with or without
  // bookings, and the answer below does not depend on how the send went
  // (a daily ceiling reached, an opted-out number, the relay busy): the
  // page is the same for every contact.
  await sendMySessionsProof(db, contact);
  res.status(200).send(contact.kind === 'email' ? renderLinkSent(contact) : renderCodeForm(contact));
});

// ---- Proof: a texted code ----

mySessionsRouter.post('/my/code', async (req, res) => {
  const typed = field(req.body, 'contact');
  const contact = typed.length <= CONTACT_MAX_LENGTH ? parseContact(typed) : null;
  if (!contact || contact.kind !== 'phone') {
    res.redirect(303, '/my');
    return;
  }
  const db = getDb();
  if (!(await takeRequest(db, CODE_CHECK_IP_LIMITS, clientKey(req)))) {
    res.status(429).send(renderTooMany());
    return;
  }
  const refuse = () => {
    res.status(401).send(renderCodeForm(contact, CODE_DID_NOT_WORK));
  };
  // "123 456" and "123-456" are the code too.
  const code = field(req.body, 'code').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) {
    refuse();
    return;
  }
  // Checks for one number are counted while it has a live code, as at
  // sign-in. Past the limit the answer is the same as for a wrong code, so
  // it does not say whether the number has a code out.
  const byNumber = (await hasLiveOtp(db, contact, 'sessions')) ? await takeRequest(db, CODE_CHECK_CONTACT_LIMITS, contactKey(contact)) : true;
  if (!byNumber) {
    refuse();
    return;
  }
  const check = await checkOtp(db, contact, code, 'sessions');
  // Another request may have used the same code a moment ago.
  if (!check.ok || !(await consumeOtp(db, check.id))) {
    refuse();
    return;
  }
  openSessions(res, contact);
});

// ---- Proof: an emailed link ----

/** The link's token, from the query (GET) or the form (POST). */
function linkToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

// Opening the link only shows a button: a mail program that opens links
// ahead of the reader must not use it up.
mySessionsRouter.get('/my/link', async (req, res) => {
  const db = getDb();
  if (!(await takeRequest(db, CODE_CHECK_IP_LIMITS, clientKey(req)))) {
    res.status(429).send(renderTooMany());
    return;
  }
  const token = linkToken(req.query.t);
  if (!(await mySessionsLinkIsOpen(db, token))) {
    res.status(410).send(renderLinkDone());
    return;
  }
  res.status(200).send(
    page(
      'See your sessions',
      html`<h1>See your sessions</h1>
        <p class="muted">Opens your sessions on this device for ${MY_SESSIONS_TTL_SECONDS / 60} minutes.</p>
        <form method="post" action="/my/link">
          <input type="hidden" name="t" value="${token}" />
          <button type="submit">Continue</button>
        </form>`,
    ),
  );
});

mySessionsRouter.post('/my/link', async (req, res) => {
  const db = getDb();
  if (!(await takeRequest(db, CODE_CHECK_IP_LIMITS, clientKey(req)))) {
    res.status(429).send(renderTooMany());
    return;
  }
  const email = await consumeMySessionsLink(db, linkToken((req.body as Record<string, unknown> | undefined)?.t));
  const contact = email ? parseContact(email) : null;
  if (!contact || contact.kind !== 'email') {
    res.status(410).send(renderLinkDone());
    return;
  }
  openSessions(res, contact);
});

// ---- The page ----

/** "Sat, Nov 21, 6:00 PM CST": the session's own zone, named, since one
 * parent's coaches can be in different zones. */
function whenInZone(isoUtc: string, tz: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return NOT_A_TIME;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** "Dec 1, 2026", in the coach's zone. */
function dateInZone(isoUtc: string, tz: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return NOT_A_TIME;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function sessionsWord(n: number): string {
  return `${n} ${n === 1 ? 'session' : 'sessions'}`;
}

function upcomingStatus(b: UpcomingBooking): SafeHtml {
  switch (b.state.kind) {
    case 'held':
      return html`<p class="muted">Held until ${formatClockLocal(b.state.until, b.tz)}. Not paid yet.</p>`;
    case 'payment-kept':
      return html`<p class="muted">Payment received, not booked. ${b.coachName} will be in touch.</p>`;
    default:
      return raw('');
  }
}

function renderUpcoming(list: UpcomingBooking[]) {
  if (list.length === 0) return html`<p class="muted">Nothing coming up.</p>`;
  return list.map(
    (b) => html`<div class="card">
      <strong>${whenInZone(b.startsAtUtc, b.tz)}</strong>
      <div class="meta">
        <span>${b.athleteName} · ${b.sessionName}</span>
        <span>${b.coachName}</span>
      </div>
      ${b.location ? html`<p class="muted">${b.location}</p>` : raw('')}
      ${upcomingStatus(b)}
      ${b.manageToken ? html`<div class="meta"><a href="/booking/${b.manageToken}">Manage this booking</a></div>` : raw('')}
    </div>`,
  );
}

const PAST_WORDS: Record<PastWord, string> = {
  attended: 'Attended',
  missed: 'Missed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  booked: 'Booked',
  'payment-kept': 'Payment received, not booked',
};

function renderPast(list: MySessions['past']) {
  if (list.length === 0) return html`<p class="muted">Nothing in the last ${PAST_DAYS} days.</p>`;
  return list.map(
    (b) => html`<div class="row">
      <span>${whenInZone(b.startsAtUtc, b.tz)}<br />${b.athleteName} · ${b.sessionName} · ${b.coachName}</span>
      <span>${PAST_WORDS[b.word]}</span>
    </div>`,
  );
}

function expiryLine(c: CoachCredits): SafeHtml {
  // Only worth a line when something expires.
  if (!c.expiring.some((e) => e.expiresAt !== null)) return raw('');
  const parts = c.expiring.map((e) =>
    e.expiresAt === null ? `${e.count} with no expiry` : `${e.count} ${e.count === 1 ? 'expires' : 'expire'} ${dateInZone(e.expiresAt, c.tz)}`,
  );
  return html`<p class="muted">${parts.join(' · ')}</p>`;
}

function renderCredits(credits: CoachCredits[] | null) {
  if (credits === null) {
    // Credits are kept per mobile, so an email does not show them.
    return html`<p class="muted">Verify your mobile to see credits. They are kept under the mobile number you booked with.</p>
      <form method="post" action="/my">
        <label for="mobile">Mobile number</label>
        <input id="mobile" name="contact" type="tel" autocomplete="tel" maxlength="${CONTACT_MAX_LENGTH}" required />
        <button type="submit" class="ghost">Text me a code</button>
      </form>`;
  }
  if (credits.length === 0) return html`<p class="muted">No session credits on this number.</p>`;
  return credits.map(
    (c) => html`<div class="card">
      <strong>${c.coachName}</strong>
      <div class="meta">
        <span>${c.usable === 0 ? 'No sessions to use right now' : `${sessionsWord(c.usable)} left`}</span>
      </div>
      ${expiryLine(c)}
      ${c.onHold > 0 ? html`<p class="muted">${sessionsWord(c.onHold)} on hold while a refund is on its way.</p>` : raw('')}
      <div class="meta"><a href="/c/${c.coachHandle}">See ${c.coachName}'s sessions</a></div>
    </div>`,
  );
}

mySessionsRouter.get('/my/sessions', async (req, res) => {
  const contact = provenContact(req);
  if (!contact) {
    // No cookie, or one that was changed or has run out: back to asking,
    // and the browser drops whatever it sent.
    if (parseCookies(req.headers.cookie)[MY_SESSIONS_COOKIE] !== undefined) {
      res.setHeader('Set-Cookie', clearCookie(MY_SESSIONS_COOKIE, MY_SESSIONS_COOKIE_PATH));
    }
    res.redirect(303, '/my');
    return;
  }
  const mine = await loadMySessions(getDb(), contact);
  res.status(200).send(
    page(
      'Your sessions',
      html`<h1>Your sessions</h1>
        <p class="muted">Booked with ${contactLabel(contact)}. This page closes after ${MY_SESSIONS_TTL_SECONDS / 60} minutes.</p>

        <h2>Coming up</h2>
        ${renderUpcoming(mine.upcoming)}

        <h2>Past</h2>
        <p class="muted">The last ${PAST_DAYS} days.</p>
        ${renderPast(mine.past)}

        <h2>Session credits</h2>
        ${renderCredits(mine.credits)}

        <form method="post" action="/my/signout">
          <button type="submit" class="ghost">Sign out</button>
        </form>`,
    ),
  );
});

mySessionsRouter.post('/my/signout', (_req, res) => {
  res.setHeader('Set-Cookie', clearCookie(MY_SESSIONS_COOKIE, MY_SESSIONS_COOKIE_PATH));
  res.redirect(303, '/my');
});
