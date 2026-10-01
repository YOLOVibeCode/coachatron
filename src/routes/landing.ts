import { Router } from 'express';
import { coachatronSmsNumber } from '../config.js';
import { getDb } from '../db/client.js';
import {
  createCoach,
  createCoachSession,
  findCoachByPhone,
  normalizePhone,
  type CoachRow,
} from '../domain/auth.js';
import { consumeStartLink, getOpenStartLink } from '../domain/startLink.js';
import { handleSetupMessage } from '../domain/setup.js';
import { html, landingPage, page, raw } from '../lib/html.js';
import { clearCookie, serializeCookie } from '../lib/cookies.js';
import {
  encodeStartCookie,
  START_COOKIE,
  START_COOKIE_MAX_AGE,
} from '../lib/startCookie.js';
import { DEFAULT_TZ, isValidTimeZone } from '../lib/time.js';

const SESSION_COOKIE = 'cx_session';

export const landingRouter = Router();

const TITLE = 'Say your week. Start taking bookings.';
const DESCRIPTION =
  'Type it or talk it — what you coach, how long, how many, the price, your days. Get a link parents book and pay on. About five minutes, on your phone.';
const WEEK_EXAMPLE =
  'Tuesdays and Thursdays at 6, an hour, 8 athletes, $35. Privates Saturday at 9, 45 minutes, $70. 10-pack for $300.';

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function displaySmsNumber(raw: string): { href: string; label: string } | null {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  const label =
    phone.startsWith('+1') && phone.length === 12
      ? `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`
      : phone;
  return { href: `sms:${phone}`, label };
}

function renderLanding(): string {
  const sms = displaySmsNumber(coachatronSmsNumber());
  return landingPage(
    `${TITLE} — Coachatron`,
    DESCRIPTION,
    html`<div class="wrap">
      <div class="hero">
        <div>
          <div class="kicker">Coachatron</div>
          <h1>Say your week. Start taking bookings.</h1>
          <p class="lede">${DESCRIPTION}</p>
          <form class="box" method="post" action="/start">
            <label for="week">Your week</label>
            <textarea id="week" name="text" rows="6" placeholder="${WEEK_EXAMPLE}"></textarea>
            <p class="hint">Tap the mic on your keyboard and just talk.</p>
            <button type="submit">Set it up</button>
          </form>
          ${sms
            ? html`<p class="sms">Or text it to <a href="${sms.href}">${sms.label}</a>.</p>`
            : raw('')}
        </div>
        <div class="stage" aria-hidden="true">
          <div class="phone"><div class="screen">
            <div class="status"><span>9:14</span><span>LTE</span></div>
            <div class="body">
              <p class="eyebrow">coachatron.com/c/northfield</p>
              <h2>Evening sessions</h2>
              <p class="sub">Tap a time. Pay before you arrive.</p>
              <div class="card"><strong>Tue 7 Oct · 6:00pm</strong><div class="meta"><span>60 min · Field 3</span><span class="spots">2 spots · $35</span></div></div>
              <div class="card"><strong>Thu 9 Oct · 6:00pm</strong><div class="meta"><span>60 min · Field 3</span><span class="spots">5 spots · $35</span></div></div>
              <div class="card"><strong>Sat 11 Oct · 9:00am</strong><div class="meta"><span>60 min · Field 1</span><span class="spots">5 spots · $35</span></div></div>
              <div class="btn">Book Tue 6:00pm</div>
            </div>
          </div></div>
        </div>
      </div>
      <section class="steps">
        <h2>Three steps. Then you're live.</h2>
        <ol>
          <li><strong>Say it</strong><span>One box, or one text. What you coach, how long, how many, the price, your days.</span></li>
          <li><strong>Check it</strong><span>We show what we understood and ask about anything missing. We never guess a price. Nothing goes live until you tap Publish.</span></li>
          <li><strong>Share it</strong><span>Parents pick a time and pay. No app. No account.</span></li>
        </ol>
      </section>
      <section class="skip">
        <h2>What you skip</h2>
        <ul>
          <li>No setup wizard.</li>
          <li>No passwords. Your phone is the sign-in.</li>
          <li>No app to download.</li>
        </ul>
      </section>
      <section class="price">
        <h2>Free to start. 5% when they pay.</h2>
        <p>Money goes straight to your own account. We never hold it. Card processing is extra, on top.</p>
      </section>
      <footer class="colophon">
        <p>Already set up? <a href="/signin">Sign in</a></p>
        <p>Prefer forms? <a href="/signin">Set it up by hand</a></p>
      </footer>
    </div>`,
  );
}

landingRouter.get('/', (_req, res) => {
  res.status(200).send(renderLanding());
});

landingRouter.post('/start', (req, res) => {
  const text = field(req.body, 'text');
  if (!text) {
    res.setHeader('Set-Cookie', clearCookie(START_COOKIE));
    res.redirect(303, '/signin');
    return;
  }
  res.setHeader('Set-Cookie', serializeCookie(START_COOKIE, encodeStartCookie(text), START_COOKIE_MAX_AGE));
  res.redirect(303, '/signin');
});

const TZ_SCRIPT = raw(
  `<script>try{var t=document.getElementById('tz');if(t&&!t.value)t.value=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}</script>`,
);

function gonePage(): string {
  return page(
    'Link expired',
    html`<h1>That link is done.</h1>
      <p class="muted">Start again from the home page.</p>
      <a class="action" href="/">Say your week</a>`,
  );
}

function renderStartForm(
  token: string,
  values: { name?: string; email?: string; tz?: string },
  error?: string,
): string {
  return page(
    'Your name',
    html`<h1>Your name</h1>
      <p class="muted">We already have your phone from the text. Then we'll show your week.</p>
      <form method="post" action="/start/${token}">
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" value="${values.name ?? ''}" required />
        <label for="email">Email (optional)</label>
        <input id="email" name="email" type="email" autocomplete="email" value="${values.email ?? ''}" />
        <input id="tz" name="tz" type="hidden" value="${values.tz ?? ''}" />
        <button type="submit">Continue</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}
      ${TZ_SCRIPT}`,
  );
}

landingRouter.get('/start/:token', async (req, res) => {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  const link = await getOpenStartLink(getDb(), token);
  if (!link) {
    res.status(410).send(gonePage());
    return;
  }
  res.status(200).send(renderStartForm(token, {}));
});

landingRouter.post('/start/:token', async (req, res) => {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  const name = field(req.body, 'name');
  const email = field(req.body, 'email');
  const tz = field(req.body, 'tz');
  const db = getDb();
  const open = await getOpenStartLink(db, token);
  if (!open) {
    res.status(410).send(gonePage());
    return;
  }
  const existing = await findCoachByPhone(db, open.phone);
  if (!existing && !name) {
    res.status(422).send(renderStartForm(token, { name, email, tz }, 'Enter your name.'));
    return;
  }
  const consumed = await consumeStartLink(db, token);
  if (!consumed) {
    res.status(410).send(gonePage());
    return;
  }
  let coach: CoachRow | null = existing;
  if (!coach) {
    coach = await createCoach(db, {
      phone: consumed.phone,
      name,
      email,
      tz: isValidTimeZone(tz) ? tz : DEFAULT_TZ,
    });
  }
  const session = await createCoachSession(db, coach.id);
  const cookies = [serializeCookie(SESSION_COOKIE, session, 30 * 24 * 60 * 60)];
  const result = await handleSetupMessage(db, coach, consumed.text, 'web');
  if (result.kind !== 'draft') {
    cookies.push(serializeCookie(START_COOKIE, encodeStartCookie(consumed.text), START_COOKIE_MAX_AGE));
  }
  res.setHeader('Set-Cookie', cookies);
  const error = result.kind === 'cap' ? '&e=cap' : result.kind === 'error' ? '&e=read' : '';
  res.redirect(303, `/app/schedule?setup=1${error}`);
});
