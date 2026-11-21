import { Router } from 'express';
import { coachatronSmsNumber } from '../config.js';
import { getDb } from '../db/client.js';
import {
  createCoach,
  createCoachSession,
  emailTakenNotice,
  findCoachByPhone,
  findCoachHoldingEmail,
  normalizeEmail,
  normalizePhone,
  type CoachRow,
} from '../domain/auth.js';
import { consumeStartLink, getOpenStartLink, reopenStartLink } from '../domain/startLink.js';
import { clientKey, START_BOX_LIMITS, takeRequest } from '../domain/requestLimits.js';
import { handleSetupMessage } from '../domain/setup.js';
import { html, landingPage, landingSmsDisclosure, page, raw, smsConsentCheckbox } from '../lib/html.js';
import {
  COPY_SMS_NUMBER_SCRIPT,
  LANDING_PREVIEW_SCRIPT,
  LANDING_WEEK_EXAMPLE,
  renderLandingPhonePreview,
} from '../lib/landingPreview.js';
import { recordConsent } from '../domain/sms-consent.js';
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
  'Tell us your week in plain words. You get a link parents can book and pay on, in about five minutes, on your phone.';
// Every time says am or pm: a bare hour is read as pm (src/domain/setup.ts),
// so "Saturday at 9" would mean 9pm.
const WEEK_EXAMPLE = LANDING_WEEK_EXAMPLE;

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function displaySmsNumber(raw: string): { href: string; label: string; e164: string } | null {
  const phone = normalizePhone(raw);
  if (!phone) return null;
  const label =
    phone.startsWith('+1') && phone.length === 12
      ? `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`
      : phone;
  return { href: `sms:${phone}`, label, e164: phone };
}

const VOICE_SCRIPT = raw(`<script>(function(){
var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
var btn=document.getElementById("week-voice");
var ta=document.getElementById("week");
var status=document.getElementById("week-voice-status");
if(!btn||!ta)return;
if(!SR){btn.hidden=true;if(status)status.textContent="Voice isn't available here. You can type it instead.";return;}
var rec=new SR();rec.continuous=true;rec.interimResults=true;var listening=false;
btn.addEventListener("click",function(){if(listening){rec.stop();return;}try{rec.start();}catch(e){btn.hidden=true;if(status)status.textContent="Voice isn't available here. You can type it instead.";}});
rec.onstart=function(){listening=true;btn.setAttribute("aria-pressed","true");if(status)status.textContent="Listening… tap to stop";};
rec.onend=function(){listening=false;btn.setAttribute("aria-pressed","false");if(status&&status.textContent==="Listening… tap to stop")status.textContent="";};
rec.onerror=function(){listening=false;btn.setAttribute("aria-pressed","false");btn.hidden=true;if(status)status.textContent="Voice isn't available here. You can type it instead.";};
rec.onresult=function(ev){var chunk="";for(var i=ev.resultIndex;i<ev.results.length;i++)chunk+=ev.results[i][0].transcript;if(chunk){var base=ta.value;ta.value=base+(base&&!/\\s$/.test(base)?" ":"")+chunk;}};
})();</script>`);

function renderLanding(): string {
  const sms = displaySmsNumber(coachatronSmsNumber());
  return landingPage(
    `${TITLE} — Coachatron`,
    DESCRIPTION,
    html`<header class="site-header">
      <div class="site-header-inner">
        <a class="site-brand" href="/">Coachatron</a>
        <nav class="site-nav" aria-label="On this page">
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div class="site-header-actions">
          <a class="header-cta" href="#week">Set it up</a>
          <a class="btn-outline" href="/signin">Sign in</a>
        </div>
      </div>
    </header>
    <div class="wrap">
      <div class="hero">
        <div>
          <div class="kicker">For coaches and trainers</div>
          <h1>Say your week. Start taking bookings.</h1>
          <p class="lede">${DESCRIPTION}</p>
          <form class="box" method="post" action="/start">
            <label for="week">Your week</label>
            <div class="week-field">
              <div class="week-input-row">
                <textarea id="week" name="text" rows="5" placeholder="${WEEK_EXAMPLE}"></textarea>
                <button type="button" id="week-voice" class="week-voice" aria-label="Talk instead of typing">🎙</button>
              </div>
              <p id="week-voice-status" class="voice-status" aria-live="polite"></p>
            </div>
            <button type="submit">Set it up</button>
          </form>
          <p class="form-alt">Prefer forms? <a href="/signin">Set up with a form instead</a></p>
          ${sms
            ? html`<div class="sms-card">
                <strong>Or just text it</strong>
                <a class="sms-number" href="${sms.href}">${sms.label}</a>
                <input class="sms-number-digits" id="landing-sms-number" type="text" readonly tabindex="-1" value="${sms.e164}" aria-hidden="true" />
                <button type="button" class="sms-copy" onclick="${COPY_SMS_NUMBER_SCRIPT}">Copy number</button>
                ${landingSmsDisclosure()}
              </div>`
            : raw('')}
        </div>
        ${renderLandingPhonePreview()}
      </div>
      ${LANDING_PREVIEW_SCRIPT}
      <section class="steps" id="how-it-works">
        <h2>How it works</h2>
        <ol>
          <li><strong>Say it</strong><span>One box, or one text. What you coach, how long, how many, the price, your days.</span></li>
          <li><strong>Check it</strong><span>We show what we understood and ask about anything missing. We never guess a price. Nothing goes live until you tap Publish.</span></li>
          <li><strong>Share it</strong><span>Parents pick a time and pay. No app. No account.</span></li>
        </ol>
      </section>
      <section class="faq" id="faq">
        <h2>Questions</h2>
        <dl>
          <dt>Is there a setup wizard?</dt>
          <dd>No. One box, or one text, and you're started.</dd>
          <dt>Do I need a password?</dt>
          <dd>No. Your email or phone is the sign-in.</dd>
          <dt>Do parents need an app?</dt>
          <dd>No. They pick a time and pay on your link.</dd>
        </dl>
      </section>
      <section class="price" id="pricing">
        <h2>Pricing</h2>
        <p class="price-lede">Free to start. 5% when they pay.</p>
        <p>Money goes straight to your own account. We never hold it. Card processing is extra, on top.</p>
      </section>
      <footer class="colophon">
        <p>Already set up? <a href="/signin">Sign in</a></p>
        <p>Prefer forms? <a href="/signin">Set up with a form instead</a></p>
      </footer>
    </div>
    ${VOICE_SCRIPT}`,
    { canonicalPath: '/' },
  );
}

landingRouter.get('/', (_req, res) => {
  res.status(200).send(renderLanding());
});

landingRouter.post('/start', async (req, res) => {
  if (!(await takeRequest(getDb(), START_BOX_LIMITS, clientKey(req)))) {
    res.status(429).send(
      page(
        'Slow down',
        html`<h1>Too many tries.</h1>
          <p class="muted">Wait a few minutes, then try again.</p>
          <a class="action" href="/">Say your week</a>`,
      ),
    );
    return;
  }
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

function smsConsentChecked(body: unknown): boolean {
  const value = (body as Record<string, unknown> | undefined)?.sms_consent;
  return value === '1' || value === 'on' || value === true;
}

const TRY_AGAIN = 'That did not go through. Tap Continue to try again.';
/** The unique index on a coach's email (migration 0011). */
const EMAIL_INDEX = 'coach_email_unique';

/** The constraint a unique violation names ('' when it names none), or null for any other error. */
function uniqueViolation(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== '23505') return null;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : '';
}

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
        <p class="muted">Check the box to get your page link and a link to set up payments by text when you go live.</p>
        ${smsConsentCheckbox()}
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
  // The optional email stays unproved, and must not be on another account.
  // Checked before the link is used, so the coach can fix it and try again
  // with the same link.
  const extraEmail = existing ? null : normalizeEmail(email);
  const holder = extraEmail ? await findCoachHoldingEmail(db, extraEmail) : null;
  if (holder) {
    res.status(422).send(renderStartForm(token, { name, email, tz }, emailTakenNotice(holder)));
    return;
  }
  const consumed = await consumeStartLink(db, token);
  if (!consumed) {
    res.status(410).send(gonePage());
    return;
  }
  // The phone is proven by the text that sent this link. The box is what
  // allows the texts after this one (SPEC.md §10).
  if (smsConsentChecked(req.body)) {
    await recordConsent(db, consumed.phone, '/start', {
      ip: typeof req.ip === 'string' ? req.ip : null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
  }
  let coach: CoachRow | null = existing;
  // Two tries: the handle (picked from the name) or the phone can be taken
  // between the check and the insert by a coach signing up at the same time.
  for (let attempt = 0; !coach && attempt < 2; attempt += 1) {
    try {
      coach = await createCoach(db, {
        phone: consumed.phone,
        name,
        email: extraEmail ?? '',
        emailVerified: false,
        tz: isValidTimeZone(tz) ? tz : DEFAULT_TZ,
      });
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === null) throw err;
      if (constraint === EMAIL_INDEX) {
        await reopenStartLink(db, token);
        // Said the same way as when the email was already taken above.
        const taken = extraEmail ? await findCoachHoldingEmail(db, extraEmail) : null;
        res.status(422).send(renderStartForm(token, { name, email, tz }, emailTakenNotice(taken ?? { email_verified: false })));
        return;
      }
      // The phone was proven by the text with this link, so the coach who
      // now has it is this coach; otherwise the next try picks another handle.
      coach = await findCoachByPhone(db, consumed.phone);
    }
  }
  if (!coach) {
    await reopenStartLink(db, token);
    res.status(422).send(renderStartForm(token, { name, email, tz }, TRY_AGAIN));
    return;
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
