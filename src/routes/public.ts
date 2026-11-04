import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import {
  checkOtp,
  consumeOtp,
  contactKey,
  createOtp,
  findCoachByHandle,
  getConnectRecipientKey,
  hasLiveOtp,
  newOtpCode,
  normalizePhone,
  type CoachRow,
  type Contact,
} from '../domain/auth.js';
import { html, operatorLine, page, raw, smsConsentCheckbox } from '../lib/html.js';
import { formatLocal } from '../lib/time.js';
import {
  getPackagesForCoach,
  getPackageById,
  getPlansForCoach,
  getPlanById,
  getCreditBalance,
  coachHasOpenCredits,
  decrementCredit,
  createPendingBooking,
  getBookingByCheckoutToken,
  bookPendingBooking,
  renewHold,
  restoreCredit,
  takesSpotSql,
  markPhoneVerified,
  type BookingRow,
} from '../domain/pricing.js';
import { checkOverflow, acceptOffer, declineOffer, describeOffer, getOfferByToken } from '../domain/cascade.js';
import { buyerEmail, cameBackFromPaying, connectBuyUrl } from '../relay/buy-link.js';
import { hasActiveConsent, isOptedOut, optedOutNotice, recordConsent } from '../domain/sms-consent.js';
import {
  BOOKING_HOLD_LIMITS,
  clientKey,
  CODE_CHECK_CONTACT_LIMITS,
  CODE_CHECK_IP_LIMITS,
  SIGNIN_CODE_LIMITS,
  SMS_OPT_IN_LIMITS,
  takeRequest,
  WAITLIST_LIMITS,
} from '../domain/requestLimits.js';
import { canText, sendText, type SendOutcome } from '../domain/outbound.js';
import { paymentsOpen } from '../domain/payments.js';
import { sendBookingConfirmation } from '../domain/bookingMessages.js';
import { hasPaymentHeldForCoach } from '../domain/paymentAttention.js';
import { OTP_DAILY_MAX_PER_CONTACT, SMS_BRAND, SMS_OPT_IN_CONFIRMATION, SMS_PURPOSE, SUPPORT_EMAIL } from '../config.js';
import type { Request } from 'express';

export const publicRouter = Router();

interface SessionForBooking {
  id: number;
  starts_at_utc: string;
  tz: string;
  session_type_id: number;
  name: string;
  capacity: number;
  price_cents: number;
  status: string;
}

/** A scheduled session of this coach. `anyStatus` also finds a cancelled
 * one, for a checkout page that has to say so. */
async function loadSessionForCoach(
  db: DbClient,
  coach: CoachRow,
  sessionId: number,
  opts: { anyStatus?: boolean } = {},
): Promise<SessionForBooking | null> {
  const result = await db.query<SessionForBooking>(
    `select s.id, s.starts_at_utc, s.tz, st.id as session_type_id, st.name, st.capacity, st.price_cents, s.status
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2 and ($3::boolean or s.status = 'scheduled')`,
    [sessionId, coach.id, opts.anyStatus === true],
  );
  return result.rows[0] ?? null;
}

function notFound() {
  return page('Not found', html`<h1>Not found</h1><p class="muted">That page does not exist.</p>`);
}

/** A session needs payment unless it is free. */
function needsPayment(session: { price_cents: number }): boolean {
  return session.price_cents > 0;
}

/** What a parent sees instead of a Pay button the coach cannot take yet.
 * Nothing is sent to the payment page, which would answer an error. */
function bookingOpensSoon(coach: CoachRow, note?: string) {
  return page(
    'Booking opens soon',
    html`<h1>Booking opens soon</h1>
      <p class="muted">${coach.name} is still setting up payments. Check back soon to book.</p>
      ${note ? html`<p class="muted">${note}</p>` : raw('')}
      <a class="action" href="/c/${coach.handle}">See ${coach.name}'s sessions</a>`,
  );
}

const CREDITS_ONLY_NOTE = 'Only session credits can be used until then.';

/** A manage-link token passed along as ?from= or a hidden field, when it
 * looks like one. */
function fromToken(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

/** The parent's earlier booking with this coach that a ?from= link names. */
async function bookingFromLink(db: DbClient, coach: CoachRow, value: unknown): Promise<BookingWithSession | null> {
  const token = fromToken(value);
  if (!token) return null;
  const booking = await loadBookingByToken(db, token);
  return booking && booking.coach_id === coach.id ? booking : null;
}

function sessionStarted(session: { starts_at_utc: string }): boolean {
  return new Date(session.starts_at_utc) <= new Date();
}

function renderSessionCancelled(coach: CoachRow, session: SessionForBooking) {
  return page(
    'Session cancelled',
    html`<h1>That session was cancelled</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)} is no longer running.</p>
      <a class="action" href="/c/${coach.handle}">See other times</a>`,
  );
}

function renderSessionStarted(coach: CoachRow, session: SessionForBooking) {
  return page(
    'Session started',
    html`<h1>That session has started</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)} can no longer be booked.</p>
      <a class="action" href="/c/${coach.handle}">See other times</a>`,
  );
}

function renderSessionFull(
  coach: CoachRow,
  session: SessionForBooking,
  values: { athleteName: string; rawPhone: string; contactEmail: string | null },
) {
  return page(
    'Session full',
    html`<h1>That session just filled up</h1>
      <p class="muted">Someone booked the last spot, but you can wait for one to open.</p>
      <form method="post" action="/c/${coach.handle}/sessions/${session.id}/waitlist">
        <input type="hidden" name="athlete_name" value="${values.athleteName}" />
        <input type="hidden" name="contact_phone" value="${values.rawPhone}" />
        <input type="hidden" name="contact_email" value="${values.contactEmail ?? ''}" />
        ${smsConsentCheckbox()}
        <button type="submit">Join the waitlist</button>
      </form>
      <a class="action" href="/c/${coach.handle}">See other times</a>`,
  );
}

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function smsConsentChecked(body: unknown): boolean {
  const value = (body as Record<string, unknown> | undefined)?.sms_consent;
  return value === '1' || value === 'on' || value === true;
}

function consentMeta(req: Request, source: string): { ip: string | null; userAgent: string | null; source: string } {
  return {
    ip: typeof req.ip === 'string' ? req.ip : null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    source,
  };
}

publicRouter.get('/privacy', (_req, res) => {
  res.status(200).send(
    page(
      'Privacy',
      html`<h1>Privacy Policy</h1>
        ${operatorLine()}
        <h2>Text messages</h2>
        <p>
          ${SMS_BRAND} sends SMS for ${SMS_PURPOSE}. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.
        </p>
        <p>
          We do not share, sell, or provide your mobile phone number or SMS opt-in data to third parties or affiliates for marketing or promotional purposes.
        </p>`,
    ),
  );
});

publicRouter.get('/terms', (_req, res) => {
  res.status(200).send(
    page(
      'Terms',
      html`<h1>Terms of Service</h1>
        ${operatorLine()}
        <section id="sms">
          <h2>SMS program</h2>
          <p><strong>Program name:</strong> ${SMS_BRAND} session texts</p>
          <p>
            ${SMS_BRAND} sends ${SMS_PURPOSE} when you opt in by checking the SMS consent box on our booking, waitlist, or sign-in forms, or at <a href="/sms">coachatron.com/sms</a>. The box is never checked for you, and texts are not required to sign in or book.
          </p>
          <p>A sign-in code you ask for is sent once and does not sign you up for other texts. If you text us first, we reply to that text.</p>
          <p>Message frequency varies.</p>
          <p>Message and data rates may apply.</p>
          <p>Reply STOP to opt out; reply HELP for help.</p>
          <p>Help: ${SUPPORT_EMAIL}</p>
          <p>Carriers are not liable for delayed or undelivered messages.</p>
        </section>`,
    ),
  );
});

// ---- Text messages: what Coachatron texts and a standalone opt-in ----

const SMS_NO_SHARING =
  'We do not share, sell, or provide your mobile phone number or SMS opt-in data to third parties or affiliates for marketing or promotional purposes.';

function renderSmsPage(values: { phone?: string } = {}, notice?: { kind: 'error' | 'ok'; text: string }) {
  return page(
    'Text messages',
    html`<h1>Text messages from ${SMS_BRAND}</h1>
      ${operatorLine()}
      <p>
        ${SMS_BRAND} (coachatron.com) is a booking site for independent youth sports coaches. Coaches
        publish their sessions; parents and athletes book and pay. Texts are optional: you can sign in with your email and book
        a session without them.
      </p>
      <h2>What we text</h2>
      <ul>
        <li>Sign-in codes you ask for. Each request sends one code and does not sign you up for other texts.</li>
        <li>If you check the box: booking confirmations, session reminders, and session updates such as a time change or a cancellation.</li>
        <li>Coaches who check the box also get their page link and a link to set up payments when they go live, up to two reminders until payments are set up, a text when payments are ready, a text when a session fills, and offers to coach an extra session.</li>
        <li>Replies to texts you send us. A coach who texts their week to our number gets a link back to see it and go live.</li>
      </ul>
      <ul>
        <li>Every message starts with "${SMS_BRAND}:".</li>
        <li>Message frequency varies with your bookings.</li>
        <li>Message and data rates may apply.</li>
        <li>Reply STOP to opt out at any time, or HELP for help.</li>
        <li>Support: ${SUPPORT_EMAIL}</li>
        <li>No marketing texts.</li>
        <li>${SMS_NO_SHARING}</li>
      </ul>
      <p>See our <a href="/terms#sms">SMS Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
      <h2>Opt in</h2>
      <p class="muted">
        The same box appears wherever ${SMS_BRAND} asks for a mobile number: sign-in, booking, and the waitlist. It is never
        checked for you, and you can sign in or book without it.
      </p>
      <form method="post" action="/sms">
        <label for="sms-phone">Mobile number (US or Canada)</label>
        <input id="sms-phone" name="phone" type="tel" autocomplete="tel" placeholder="(555) 555-0100" value="${values.phone ?? ''}" required />
        <div hidden aria-hidden="true">
          <label for="sms-website">Leave this empty</label>
          <input id="sms-website" name="website" tabindex="-1" autocomplete="off" />
        </div>
        ${smsConsentCheckbox()}
        <button type="submit">Opt in</button>
      </form>
      ${notice ? html`<p class="${notice.kind === 'error' ? 'error' : 'muted'}">${notice.text}</p>` : raw('')}`,
  );
}

publicRouter.get('/sms', (_req, res) => {
  res.status(200).send(renderSmsPage());
});

publicRouter.post('/sms', async (req, res) => {
  const rawPhone = field(req.body, 'phone');
  // Bots fill every field; a person never sees this one.
  if (field(req.body, 'website')) {
    res.status(200).send(renderSmsPage({}, { kind: 'ok', text: "You're opted in." }));
    return;
  }
  const phone = normalizePhone(rawPhone);
  if (!phone || !canText(phone)) {
    res.status(422).send(renderSmsPage({ phone: rawPhone }, { kind: 'error', text: 'Enter a US or Canadian mobile number.' }));
    return;
  }
  if (!smsConsentChecked(req.body)) {
    res
      .status(422)
      .send(renderSmsPage({ phone: rawPhone }, { kind: 'error', text: 'Check the box to get texts. A number alone is not consent.' }));
    return;
  }
  const db = getDb();
  if (!(await takeRequest(db, SMS_OPT_IN_LIMITS, clientKey(req)))) {
    res.status(429).send(renderSmsPage({ phone: rawPhone }, { kind: 'error', text: 'Too many tries from here. Try again later.' }));
    return;
  }
  // Typing a number here does not prove it is yours, so it cannot undo
  // that number's STOP. Only a START from the phone does.
  if (await isOptedOut(db, phone)) {
    res.status(422).send(renderSmsPage({ phone: rawPhone }, { kind: 'error', text: optedOutNotice('to opt back in') }));
    return;
  }
  const meta = consentMeta(req, '/sms');
  await recordConsent(db, phone, meta.source, { ip: meta.ip, userAgent: meta.userAgent });
  let confirmed = false;
  try {
    confirmed =
      (await sendText(db, {
        to: phone,
        body: SMS_OPT_IN_CONFIRMATION,
        coachId: null,
        template: 'opt-in-confirmation',
        perRecipientDailyMax: 1,
      })) === 'sent';
  } catch (err) {
    console.error('sms opt-in confirmation not sent:', err instanceof Error ? err.message : err);
  }
  const text = confirmed
    ? `You're opted in. We texted ${phone} to confirm. Reply STOP any time to opt out.`
    : "You're opted in. Reply STOP to any of our texts to opt out.";
  res.status(200).send(renderSmsPage({}, { kind: 'ok', text }));
});

// ---- Screen 8: coach's public page (sessions list) ----

publicRouter.get('/c/:handle', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }

  const from = (await bookingFromLink(db, coach, req.query.from)) ? fromToken(req.query.from) : null;
  const bookQuery = from ? `?from=${encodeURIComponent(from)}` : '';

  const sessions = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
    capacity: number;
    price_cents: number;
    booked: string;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, st.capacity, st.price_cents,
            coalesce((select count(*) from booking b where b.session_id = s.id and ${takesSpotSql('b')}), 0)::text as booked
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
     order by s.starts_at_utc
     limit 50`,
    [coach.id],
  );
  const open = sessions.rows.some(needsPayment) ? await paymentsOpen(db, coach) : true;
  // Families who already hold credits can still book with them.
  const creditsWork = !open && (await coachHasOpenCredits(db, coach.id));

  res.status(200).send(
    page(
      coach.name,
      html`<h1>${coach.name}</h1>
        ${sessions.rows.length === 0
          ? html`<p class="muted">No open sessions right now.</p>`
          : sessions.rows.map((s) => {
              const spotsLeft = s.capacity - Number(s.booked);
              return html`<div class="card">
                <strong>${formatLocal(s.starts_at_utc, s.tz)}</strong>
                <div class="meta">
                  <span>${s.name}</span>
                  <span>${spotsLeft > 0 ? `${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left · $${(s.price_cents / 100).toFixed(2)}` : 'Full'}</span>
                </div>
                ${spotsLeft <= 0
                  ? raw('')
                  : open || !needsPayment(s)
                    ? html`<a class="action" href="/c/${coach.handle}/sessions/${s.id}/book${bookQuery}">Book</a>`
                    : html`<p class="muted">Booking opens soon</p>
                        ${creditsWork
                          ? html`<p class="muted"><a href="/c/${coach.handle}/sessions/${s.id}/book${bookQuery}">Have session credits? Book with them</a></p>`
                          : raw('')}`}
              </div>`;
            })}`,
    ),
  );
});

// ---- Screen 9: booking form ----

publicRouter.get('/c/:handle/sessions/:sessionId/book', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const session = await loadSessionForCoach(db, coach, Number(req.params.sessionId));
  if (!session) {
    res.status(404).send(notFound());
    return;
  }
  if (sessionStarted(session)) {
    res.status(409).send(renderSessionStarted(coach, session));
    return;
  }
  // Arriving from one of their own manage links, the parent's contact
  // details are filled in and the link rides along to checkout.
  const earlier = await bookingFromLink(db, coach, req.query.from);
  const values = earlier
    ? { contact_phone: earlier.contact_phone, contact_email: earlier.contact_email ?? undefined, from: fromToken(req.query.from) ?? undefined }
    : {};
  if (needsPayment(session) && !(await paymentsOpen(db, coach))) {
    // Only a family holding credits can book now; the form stays for them.
    if (!(await coachHasOpenCredits(db, coach.id))) {
      res.status(200).send(bookingOpensSoon(coach));
      return;
    }
    res.status(200).send(renderBookingForm(coach, session, values, undefined, { creditsOnly: true }));
    return;
  }
  res.status(200).send(renderBookingForm(coach, session, values));
});

function renderBookingForm(
  coach: CoachRow,
  session: SessionForBooking,
  values: { athlete_name?: string; contact_phone?: string; contact_email?: string; from?: string },
  error?: string,
  opts: { creditsOnly?: boolean } = {},
) {
  return page(
    'Book a session',
    html`<h1>${session.name}</h1>
      <p class="muted">${formatLocal(session.starts_at_utc, session.tz)} — $${(session.price_cents / 100).toFixed(2)}</p>
      ${opts.creditsOnly
        ? html`<p class="muted">${coach.name} is still setting up payments, so for now you can book only with session credits. Enter the phone number your credits are under.</p>`
        : raw('')}
      <form method="post" action="/c/${coach.handle}/sessions/${session.id}/book">
        ${values.from ? html`<input type="hidden" name="from" value="${values.from}" />` : raw('')}
        <label for="athlete_name">Athlete name</label>
        <input id="athlete_name" name="athlete_name" value="${values.athlete_name ?? ''}" required />
        <label for="contact_phone">Your phone</label>
        <input id="contact_phone" name="contact_phone" type="tel" value="${values.contact_phone ?? ''}" required />
        ${smsConsentCheckbox()}
        <label for="contact_email">Your email (optional)</label>
        <input id="contact_email" name="contact_email" type="email" value="${values.contact_email ?? ''}" />
        <button type="submit">${opts.creditsOnly ? 'Continue with a credit' : 'Continue to payment'}</button>
      </form>
      ${error ? raw(`<p class="error">${error}</p>`) : raw('')}`,
  );
}

publicRouter.post('/c/:handle/sessions/:sessionId/book', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const session = await loadSessionForCoach(db, coach, Number(req.params.sessionId));
  if (!session) {
    res.status(404).send(notFound());
    return;
  }

  if (sessionStarted(session)) {
    res.status(409).send(renderSessionStarted(coach, session));
    return;
  }
  // While the coach cannot take payments, a family with session credits can
  // still book; checkout then offers only the credit. Whether any family
  // holds credits is the coach's fact, so this is the only check here: the
  // typed number's own credits are looked at once the phone is proven at
  // checkout, and every number gets the same answer until then.
  const creditsOnly = needsPayment(session) && !(await paymentsOpen(db, coach));
  if (creditsOnly && !(await coachHasOpenCredits(db, coach.id))) {
    res.status(409).send(bookingOpensSoon(coach));
    return;
  }

  const athleteName = field(req.body, 'athlete_name');
  const rawPhone = field(req.body, 'contact_phone');
  const contactPhone = normalizePhone(rawPhone);
  const contactEmail = field(req.body, 'contact_email') || null;

  if (!athleteName || !contactPhone) {
    res
      .status(422)
      .send(
        renderBookingForm(
          coach,
          session,
          { athlete_name: athleteName, contact_phone: rawPhone, contact_email: contactEmail ?? undefined, from: fromToken(field(req.body, 'from')) ?? undefined },
          'Enter the athlete’s name and a valid phone number.',
          { creditsOnly },
        ),
      );
    return;
  }

  // Each form sent holds a spot, so one address can hold only so many.
  if (!(await takeRequest(db, BOOKING_HOLD_LIMITS, clientKey(req)))) {
    res
      .status(429)
      .send(
        renderBookingForm(
          coach,
          session,
          { athlete_name: athleteName, contact_phone: rawPhone, contact_email: contactEmail ?? undefined, from: fromToken(field(req.body, 'from')) ?? undefined },
          'Too many bookings started from here for now. Please try again later.',
          { creditsOnly },
        ),
      );
    return;
  }

  if (smsConsentChecked(req.body)) {
    const meta = consentMeta(req, `/c/${coach.handle}/sessions/${session.id}/book`);
    await recordConsent(db, contactPhone, meta.source, { ip: meta.ip, userAgent: meta.userAgent });
  }

  // A manage link proves the phone only when its own booking's phone was
  // proven, by a texted code or by an earlier proven link, and only for
  // that same phone. Anyone can type a number; credits follow the proof.
  const earlier = await bookingFromLink(db, coach, field(req.body, 'from'));
  const phoneVerified = Boolean(earlier && earlier.phone_verified_at && earlier.contact_phone === contactPhone);

  // Capacity is checked server-side even if the list page the parent saw was
  // stale (SPEC.md §7.2). The pending booking holds the spot while they pay.
  const pending = await createPendingBooking(db, {
    sessionId: session.id,
    capacity: session.capacity,
    athleteName,
    contactPhone,
    contactEmail,
    phoneVerified,
  });
  if (!pending) {
    res.status(409).send(renderSessionFull(coach, session, { athleteName, rawPhone, contactEmail }));
    return;
  }
  res.redirect(303, `/c/${coach.handle}/checkout/${pending.checkoutToken}`);
});

// Joining the waitlist for a full session (SPEC.md §7.3 step 1: "the
// session is full AND a second athlete has joined the waitlist" is what
// triggers the coach's overflow ask). This is the same screen 9 form in a
// different state, not a new screen.
publicRouter.post('/c/:handle/sessions/:sessionId/waitlist', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const session = await loadSessionForCoach(db, coach, Number(req.params.sessionId));
  if (!session) {
    res.status(404).send(notFound());
    return;
  }

  const athleteName = field(req.body, 'athlete_name');
  const contactPhone = normalizePhone(field(req.body, 'contact_phone'));
  // waitlist has no email column (SPEC.md §11.1) — phone is the contact of record.
  if (!athleteName || !contactPhone) {
    res.status(422).send(notFound());
    return;
  }
  if (!(await takeRequest(db, WAITLIST_LIMITS, clientKey(req)))) {
    res.status(429).send(
      page(
        'Try again later',
        html`<h1>Too many waitlist requests</h1>
          <p class="muted">Too many from here for now. Try again later.</p>
          <a class="action" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
      ),
    );
    return;
  }

  if (smsConsentChecked(req.body)) {
    const meta = consentMeta(req, `/c/${coach.handle}/sessions/${session.id}/waitlist`);
    await recordConsent(db, contactPhone, meta.source, { ip: meta.ip, userAgent: meta.userAgent });
  }
  const textsOn = await hasActiveConsent(db, contactPhone);

  await db.query(
    'insert into waitlist (session_id, contact_phone, athlete_name) values ($1, $2, $3)',
    [session.id, contactPhone, athleteName],
  );

  await checkOverflow(db, session.id);

  res.status(200).send(
    page(
      'On the waitlist',
      html`<h1>You're on the waitlist</h1>
        <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}. ${textsOn
          ? `We'll text ${contactPhone} if a spot opens.`
          : `You didn't choose texts, so check back at ${coach.name}'s page for an open spot.`}</p>
        <a class="action" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
    ),
  );
});

// ---- Screen 10: checkout ----

/** A checkout page is found by its booking's checkout token only. A serial
 * booking id, or any other wrong token, is a plain 404. */
async function loadCheckoutContext(db: DbClient, coach: CoachRow, token: string) {
  const booking = await getBookingByCheckoutToken(db, token);
  if (!booking || !booking.checkout_token) return null;
  const session = await loadSessionForCoach(db, coach, booking.session_id, { anyStatus: true });
  if (!session) return null;
  return { booking, session };
}

/** What the checkout screen says about session credits. Credits belong to a
 * proven phone: until the parent proves it, the screen offers a texted code
 * and says nothing about whether this number has any. */
type CreditState =
  | { kind: 'available'; remaining: number }
  | { kind: 'none-on-number' }
  | { kind: 'offer-code'; masked: string }
  | { kind: 'code-sent'; masked: string }
  | { kind: 'hidden' };

type CheckoutOptions = {
  packages: Array<{ id: number; name: string; credits: number; price_cents: number }>;
  plans: Array<{ id: number; name: string; price_cents: number; credits_per_month: number }>;
  credit: CreditState;
  /** False while the coach cannot take payments: only credits and free sessions are offered. */
  canPay: boolean;
};

function maskPhone(phone: string): string {
  return `••••${phone.slice(-4)}`;
}

async function loadCheckoutOptions(
  db: DbClient,
  coach: CoachRow,
  booking: BookingRow,
  opts: { codeSent?: boolean } = {},
): Promise<CheckoutOptions> {
  const packages = await getPackagesForCoach(db, coach.id);
  const plans = await getPlansForCoach(db, coach.id);
  const phone = booking.contact_phone;
  let credit: CreditState = { kind: 'hidden' };
  if (booking.phone_verified_at) {
    const balance = await getCreditBalance(db, coach.id, phone);
    credit = balance ? { kind: 'available', remaining: balance.remaining } : { kind: 'none-on-number' };
  } else if (canText(phone) && (await coachHasOpenCredits(db, coach.id))) {
    // Whether any parent holds credits with this coach is the coach's fact,
    // not this number's, so offering a code gives nothing away.
    credit = opts.codeSent ? { kind: 'code-sent', masked: maskPhone(phone) } : { kind: 'offer-code', masked: maskPhone(phone) };
  }
  return { packages, plans, credit, canPay: await paymentsOpen(db, coach) };
}

publicRouter.get('/c/:handle/checkout/:token', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const ctx = await loadCheckoutContext(db, coach, req.params.token);
  if (!ctx) {
    res.status(404).send(notFound());
    return;
  }
  if (ctx.booking.status !== 'pending') {
    res.status(200).send(renderAlreadyBooked(coach, ctx.session, ctx.booking));
    return;
  }
  if (await hasPaymentHeldForCoach(db, ctx.booking.id)) {
    res.status(200).send(renderPaymentHeld(coach, ctx.session, ctx.booking));
    return;
  }
  if (ctx.session.status !== 'scheduled') {
    res.status(200).send(renderSessionCancelled(coach, ctx.session));
    return;
  }
  // Back from the hosted payment page before its confirmation has arrived.
  // A parent who leaves that page without paying comes back to the same
  // link, so this page reads right for both.
  if (cameBackFromPaying(req.originalUrl)) {
    res.status(200).send(renderPaymentConfirming(coach, ctx.session, ctx.booking, req.params.token));
    return;
  }

  const options = await loadCheckoutOptions(db, coach, ctx.booking);
  // While the coach cannot take payments, the page is for session credits
  // only; with no credit to offer it says booking opens soon.
  if (!options.canPay && needsPayment(ctx.session) && (options.credit.kind === 'hidden' || options.credit.kind === 'none-on-number')) {
    res.status(200).send(bookingOpensSoon(coach, options.credit.kind === 'none-on-number' ? CREDITS_ONLY_NOTE : undefined));
    return;
  }

  res.status(200).send(renderCheckout(coach, ctx.session, req.params.token, options));
});

/** The manage link on the page a parent lands on, so a parent who gets no
 * texts or email still has it. */
function manageLinkBlock(booking: Pick<BookingRow, 'manage_token'>, style: 'action' | 'action ghost' = 'action') {
  return html`<p>Keep this link to see or cancel the booking:</p>
    <a class="${style}" href="/booking/${booking.manage_token}">Manage this booking</a>`;
}

function renderAlreadyBooked(coach: CoachRow, session: SessionForBooking, booking: Pick<BookingRow, 'manage_token' | 'status'>) {
  if (booking.status === 'refunded') {
    return page(
      'Refunded',
      html`<h1>This booking was refunded</h1>
        <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}. The payment went back to your card.</p>
        ${manageLinkBlock(booking)}
        <a class="action ghost" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
    );
  }
  if (booking.status === 'cancelled') {
    return page(
      'Cancelled',
      html`<h1>This booking was cancelled</h1>
        <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}</p>
        ${manageLinkBlock(booking)}
        <a class="action ghost" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
    );
  }
  return page(
    'Booked',
    html`<h1>You're booked</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}</p>
      ${manageLinkBlock(booking)}
      <a class="action ghost" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
  );
}

function renderPaymentConfirming(coach: CoachRow, session: SessionForBooking, booking: Pick<BookingRow, 'manage_token'>, checkoutToken: string) {
  return page(
    'Checking for your payment',
    html`<h1>Checking for your payment</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}. If you paid, this takes a moment. Please don't pay again.</p>
      <a class="action" href="/c/${coach.handle}/checkout/${checkoutToken}?paid=1">Check again</a>
      ${manageLinkBlock(booking, 'action ghost')}
      <p class="muted">Didn't finish paying? <a href="/c/${coach.handle}/checkout/${checkoutToken}">Choose how to pay</a>.</p>`,
  );
}

/** A payment arrived for this booking but could not book it (the session
 * filled or started first, or the amount did not match). The coach has it
 * on the Money screen; the parent is told, and not offered to pay again. */
function renderPaymentHeld(coach: CoachRow, session: SessionForBooking, booking: Pick<BookingRow, 'manage_token'>) {
  return page(
    'Payment received',
    html`<h1>We got your payment</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}. We could not book this spot with it. ${coach.name} has it and will be in touch. Please don't pay again.</p>
      ${manageLinkBlock(booking, 'action ghost')}
      <a class="action ghost" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
  );
}

function renderCreditState(coach: CoachRow, action: string, credit: CreditState) {
  switch (credit.kind) {
    case 'available':
      return html`<form method="post" action="${action}">
        <input type="hidden" name="mode" value="credit" />
        <button type="submit">Use 1 of ${credit.remaining} session credits</button>
      </form>`;
    case 'none-on-number':
      return html`<p class="muted">No session credits with ${coach.name} on this number.</p>`;
    case 'offer-code':
      return html`<form method="post" action="${action}">
        <input type="hidden" name="mode" value="send_code" />
        <p class="muted">Have session credits with ${coach.name}? We'll text a code to ${credit.masked} to use them.</p>
        <button type="submit" class="ghost">Text me a code</button>
      </form>`;
    case 'code-sent':
      return html`<form method="post" action="${action}">
        <input type="hidden" name="mode" value="verify_code" />
        <label for="code">We texted a 6-digit code to ${credit.masked}</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
        <button type="submit">Use my credits</button>
      </form>`;
    default:
      return raw('');
  }
}

function renderCheckout(
  coach: CoachRow,
  session: SessionForBooking,
  checkoutToken: string,
  options: CheckoutOptions,
  error?: string,
) {
  const action = `/c/${coach.handle}/checkout/${checkoutToken}`;
  const canPay = options.canPay;
  const packages = canPay ? options.packages : [];
  const plans = canPay ? options.plans : [];

  return page(
    'Checkout',
    html`<h1>${session.name}</h1>
      <p class="muted">${formatLocal(session.starts_at_utc, session.tz)}</p>
      ${canPay
        ? html`<p class="muted">Pay on the Noctusoft hosted page. Apple Pay and cards are there — this app never sees a card.</p>`
        : html`<p class="muted">${coach.name} is still setting up payments, so paying here opens soon.</p>`}

      ${renderCreditState(coach, action, options.credit)}

      ${canPay || !needsPayment(session)
        ? html`<form method="post" action="${action}">
            <input type="hidden" name="mode" value="dropin" />
            <button type="submit">Pay $${(session.price_cents / 100).toFixed(2)} — this session only</button>
          </form>`
        : raw('')}

      ${packages.map(
        (p) => html`<form method="post" action="${action}">
          <input type="hidden" name="mode" value="package" />
          <input type="hidden" name="package_id" value="${p.id}" />
          <button type="submit">Buy ${p.name} — ${p.credits} sessions for $${(p.price_cents / 100).toFixed(2)}</button>
        </form>`,
      )}

      ${plans.map(
        (p) => html`<form method="post" action="${action}">
          <input type="hidden" name="mode" value="plan" />
          <input type="hidden" name="plan_id" value="${p.id}" />
          <button type="submit">Buy ${p.name} — ${p.credits_per_month} ${p.credits_per_month === 1 ? 'session' : 'sessions'} for $${(p.price_cents / 100).toFixed(2)}, one-time</button>
        </form>`,
      )}
      ${error ? html`<p class="error">${error}</p>` : raw('')}`,
  );
}

const CODE_NOT_SENT: Record<Exclude<SendOutcome, 'sent'> | 'failed', [number, string]> = {
  capped: [429, 'Too many codes for this number today. Try again tomorrow.'],
  busy: [429, "We can't send codes right now. Try again in a few minutes."],
  failed: [502, "We couldn't send a code just now. Try again in a minute."],
  refused: [422, "We can't text that number."],
};

const CODE_GONE = {
  'used-up': 'That code had too many wrong tries. Ask for a new one.',
  none: 'That code has expired or was already used. Ask for a new one.',
} as const;

/** Texts a code that proves the booking's phone, and stores it only once
 * the text has gone out, so a send the limits refuse leaves no code. */
async function sendCreditCode(db: DbClient, phone: string): Promise<SendOutcome | 'failed'> {
  const code = newOtpCode();
  let outcome: SendOutcome;
  try {
    outcome = await sendText(db, {
      to: phone,
      body: `Coachatron: your code to use your session credits is ${code}. It expires in 10 minutes.`,
      coachId: null,
      template: 'otp',
      perRecipientDailyMax: OTP_DAILY_MAX_PER_CONTACT,
    });
  } catch (err) {
    console.error('checkout code not sent:', err instanceof Error ? err.message : err);
    return 'failed';
  }
  if (outcome === 'sent') await createOtp(db, { kind: 'phone', phone }, { code });
  return outcome;
}

publicRouter.post('/c/:handle/checkout/:token', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const checkoutToken = req.params.token;
  const ctx = await loadCheckoutContext(db, coach, checkoutToken);
  if (!ctx) {
    res.status(404).send(notFound());
    return;
  }

  // One checkout per booking: a booked booking is never sent to pay again.
  if (ctx.booking.status !== 'pending') {
    res.status(409).send(renderAlreadyBooked(coach, ctx.session, ctx.booking));
    return;
  }
  if (await hasPaymentHeldForCoach(db, ctx.booking.id)) {
    res.status(409).send(renderPaymentHeld(coach, ctx.session, ctx.booking));
    return;
  }
  if (ctx.session.status !== 'scheduled') {
    res.status(409).send(renderSessionCancelled(coach, ctx.session));
    return;
  }
  if (sessionStarted(ctx.session)) {
    res.status(409).send(renderSessionStarted(coach, ctx.session));
    return;
  }

  const mode = field(req.body, 'mode');
  const phone = ctx.booking.contact_phone;
  const recipientKey = getConnectRecipientKey(coach);
  const bookingId = ctx.booking.id;
  const email = buyerEmail(phone, ctx.booking.contact_email, bookingId);

  // Every mode but a credit (or a free drop-in) goes to the payment page.
  const paying = mode === 'package' || mode === 'plan' || (mode === 'dropin' && needsPayment(ctx.session));
  if (paying && !(await paymentsOpen(db, coach))) {
    res.status(409).send(bookingOpensSoon(coach));
    return;
  }

  const showCheckout = async (status: number, error: string, opts: { codeSent?: boolean } = {}) => {
    res.status(status).send(renderCheckout(coach, ctx.session, checkoutToken, await loadCheckoutOptions(db, coach, ctx.booking, opts), error));
  };

  try {
    // Proving the phone, so its credits can be used: the same one-time codes,
    // limits and wrong-try count as signing in.
    if (mode === 'send_code') {
      if (ctx.booking.phone_verified_at) {
        res.redirect(303, `/c/${coach.handle}/checkout/${checkoutToken}`);
        return;
      }
      if (!canText(phone)) {
        await showCheckout(422, "We can't text that number.");
        return;
      }
      if (!(await takeRequest(db, SIGNIN_CODE_LIMITS, clientKey(req)))) {
        await showCheckout(429, 'Too many codes asked for from here. Try again later.');
        return;
      }
      const outcome = await sendCreditCode(db, phone);
      if (outcome === 'sent') {
        res.status(200).send(renderCheckout(coach, ctx.session, checkoutToken, await loadCheckoutOptions(db, coach, ctx.booking, { codeSent: true })));
        return;
      }
      if (outcome === 'refused' && (await isOptedOut(db, phone))) {
        await showCheckout(422, optedOutNotice('to get a code'));
        return;
      }
      const [status, error] = CODE_NOT_SENT[outcome];
      await showCheckout(status, error);
      return;
    }

    if (mode === 'verify_code') {
      const contact: Contact = { kind: 'phone', phone };
      // Counted per address, and per number while it has a live code. Each
      // code also stops working after a few wrong tries.
      const byAddress = await takeRequest(db, CODE_CHECK_IP_LIMITS, clientKey(req));
      const byNumber = (await hasLiveOtp(db, contact)) ? await takeRequest(db, CODE_CHECK_CONTACT_LIMITS, contactKey(contact)) : true;
      if (!byAddress || !byNumber) {
        await showCheckout(429, 'Too many tries. Try again in an hour.', { codeSent: true });
        return;
      }
      const check = await checkOtp(db, contact, field(req.body, 'code'));
      if (!check.ok) {
        // A wrong code can be tried again; a code that is used up or gone
        // needs a new one, so the page offers to text one.
        if (check.reason === 'wrong') await showCheckout(401, "That code didn't work. Check it and try again.", { codeSent: true });
        else await showCheckout(401, CODE_GONE[check.reason]);
        return;
      }
      // Another request may have used the same code a moment ago.
      if (!(await consumeOtp(db, check.id))) {
        await showCheckout(401, CODE_GONE.none);
        return;
      }
      await markPhoneVerified(db, bookingId);
      res.redirect(303, `/c/${coach.handle}/checkout/${checkoutToken}`);
      return;
    }

    if (mode === 'credit' && !ctx.booking.phone_verified_at) {
      await showCheckout(403, 'Confirm your phone with a texted code to use session credits.');
      return;
    }

    // The spot was not this booking's after all: say why, with what the
    // parent can do next.
    const notBooked = async (why: 'full' | 'closed' | 'not_pending') => {
      if (why === 'closed') {
        res.status(409).send(renderSessionCancelled(coach, ctx.session));
        return;
      }
      if (why === 'not_pending') {
        const now = await getBookingByCheckoutToken(db, checkoutToken);
        res.status(409).send(renderAlreadyBooked(coach, ctx.session, now ?? ctx.booking));
        return;
      }
      res.status(409).send(
        renderSessionFull(coach, ctx.session, {
          athleteName: ctx.booking.athlete_name,
          rawPhone: phone,
          contactEmail: ctx.booking.contact_email,
        }),
      );
    };

    // Whatever the parent picks, their spot must still be theirs: a lapsed
    // hold is renewed only while the session has room.
    const hold = await renewHold(db, ctx.booking, ctx.session.capacity);
    if (hold !== 'held') {
      await notBooked(hold);
      return;
    }

    if (mode === 'credit') {
      const credit = await getCreditBalance(db, coach.id, phone);
      if (!credit || !(await decrementCredit(db, credit.id))) {
        await showCheckout(409, 'That credit is no longer available.');
        return;
      }
      const booked = await bookPendingBooking(db, ctx.booking, ctx.session.capacity, {
        paymentSource: 'PackageCredit',
        creditId: credit.id,
        chargeId: null,
        grossCents: null,
      });
      if (booked !== 'booked') {
        await restoreCredit(db, credit.id);
        await notBooked(booked);
        return;
      }
      await sendBookingConfirmation(db, bookingId);
      void checkOverflow(db, ctx.session.id);
      res.redirect(303, `/c/${coach.handle}/checkout/${checkoutToken}`);
      return;
    }

    if (mode === 'dropin') {
      const url = connectBuyUrl({
        seller: recipientKey,
        amountCents: ctx.session.price_cents,
        bookingId,
        checkoutToken,
        mode: 'dropin',
        email,
        handle: coach.handle,
        description: `${ctx.session.name} — ${formatLocal(ctx.session.starts_at_utc, ctx.session.tz)}`,
      });
      res.redirect(303, url);
      return;
    }

    if (mode === 'package') {
      const packageId = Number(field(req.body, 'package_id'));
      const pkg = await getPackageById(db, coach.id, packageId);
      if (!pkg) {
        res.status(404).send(notFound());
        return;
      }
      const url = connectBuyUrl({
        seller: recipientKey,
        amountCents: pkg.price_cents,
        bookingId,
        checkoutToken,
        mode: 'package',
        itemId: pkg.id,
        email,
        handle: coach.handle,
        description: `${pkg.name} — ${coach.name}`,
      });
      res.redirect(303, url);
      return;
    }

    if (mode === 'plan') {
      const planId = Number(field(req.body, 'plan_id'));
      const plan = await getPlanById(db, coach.id, planId);
      if (!plan) {
        res.status(404).send(notFound());
        return;
      }
      const url = connectBuyUrl({
        seller: recipientKey,
        amountCents: plan.price_cents,
        bookingId,
        checkoutToken,
        mode: 'plan',
        itemId: plan.id,
        email,
        handle: coach.handle,
        description: `${plan.name} — ${coach.name}`,
      });
      res.redirect(303, url);
      return;
    }

    res.status(422).send(notFound());
  } catch {
    await showCheckout(502, 'Checkout is not available right now. Please try again.');
  }
});

// ---- Screen 12: offer response page (web fallback for a roster member's
// SMS reply; SPEC.md §8.1 item 12) ----

publicRouter.get('/offer/:token', async (req, res) => {
  const db = getDb();
  const offer = await getOfferByToken(db, req.params.token);
  if (!offer) {
    res.status(404).send(notFound());
    return;
  }
  res.status(200).send(renderOfferPage(offer.state, await describeOffer(db, offer.sessionId)));
});

function renderOfferPage(state: string, summary: string | null, message?: string) {
  const resolved = state !== 'sent';
  return page(
    'Overflow offer',
    html`<h1>Backup coach needed</h1>
      ${summary ? html`<p>${summary}</p>` : raw('')}
      ${resolved
        ? html`<p class="muted">This offer is no longer open (${state}).</p>`
        : html`<form method="post">
            <button type="submit" name="action" value="accept">Accept</button>
          </form>
          <form method="post">
            <button type="submit" name="action" value="decline" class="ghost">Decline</button>
          </form>`}
      ${message ? html`<p class="muted">${message}</p>` : raw('')}`,
  );
}

publicRouter.post('/offer/:token', async (req, res) => {
  const db = getDb();
  const offer = await getOfferByToken(db, req.params.token);
  if (!offer) {
    res.status(404).send(notFound());
    return;
  }

  const action = field(req.body, 'action');
  const summary = await describeOffer(db, offer.sessionId);
  if (offer.state !== 'sent') {
    res.status(200).send(renderOfferPage(offer.state, summary));
    return;
  }

  if (action === 'accept') {
    const accepted = await acceptOffer(db, offer.id);
    res
      .status(200)
      .send(renderOfferPage(accepted ? 'accepted' : offer.state, summary, accepted ? undefined : 'Too late — someone else already claimed it.'));
    return;
  }
  if (action === 'decline') {
    await declineOffer(db, offer.id);
    res.status(200).send(renderOfferPage('declined', summary));
    return;
  }
  res.status(422).send(renderOfferPage(offer.state, summary, 'Choose accept or decline.'));
});

// ---- Screen 11: manage booking (M5 self-service) ----

interface BookingWithSession {
  id: number;
  session_id: number;
  athlete_name: string;
  contact_phone: string;
  contact_email: string | null;
  phone_verified_at: string | null;
  status: string;
  credit_id: number | null;
  starts_at_utc: string;
  tz: string;
  location_text: string | null;
  session_type_name: string;
  coach_id: number;
  coach_handle: string;
  coach_name: string;
}

async function loadBookingByToken(db: DbClient, token: string): Promise<BookingWithSession | null> {
  const result = await db.query<BookingWithSession>(
    `select b.id, b.session_id, b.athlete_name, b.contact_phone, b.contact_email, b.phone_verified_at, b.status, b.credit_id,
            s.starts_at_utc, s.tz, s.location_text, st.name as session_type_name, c.id as coach_id, c.handle as coach_handle,
            c.name as coach_name
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where b.manage_token = $1`,
    [token],
  );
  return result.rows[0] ?? null;
}

// starts_at_utc is already an absolute instant (timestamptz); compare it
// directly against "now" - no SET timezone needed for this check.
function cancellationAllowed(booking: BookingWithSession): boolean {
  return new Date(booking.starts_at_utc) > new Date();
}

publicRouter.get('/booking/:token', async (req, res) => {
  const db = getDb();
  const booking = await loadBookingByToken(db, req.params.token);
  if (!booking) {
    res.status(404).send(notFound());
    return;
  }
  const held = booking.status === 'pending' && (await hasPaymentHeldForCoach(db, booking.id));

  res.status(200).send(
    page(
      'Manage booking',
      html`<h1>${booking.session_type_name}</h1>
        <p class="muted">${formatLocal(booking.starts_at_utc, booking.tz)}${booking.location_text ? ` · ${booking.location_text}` : ''}</p>

        <p class="card">
          <strong>Athlete:</strong> ${booking.athlete_name}<br />
          <strong>Status:</strong>
          ${booking.status === 'booked'
            ? html`<span class="good">Confirmed</span>`
            : booking.status === 'cancelled'
              ? html`<span class="muted">Cancelled</span>`
              : booking.status === 'refunded'
                ? html`<span class="muted">Refunded. The payment went back to your card.</span>`
                : held
                  ? html`<span>Payment received, not booked. ${booking.coach_name} will be in touch.</span>`
                  : booking.status === 'pending'
                    ? html`<span>Payment not confirmed yet</span>`
                    : html`<span>${booking.status}</span>`}
        </p>

        <h2>Action</h2>
        ${booking.status === 'booked' && cancellationAllowed(booking)
          ? html`<form method="post" action="/booking/${req.params.token}/cancel">
              <button type="submit" class="action">Cancel this booking</button>
            </form>`
          : booking.status === 'cancelled' || booking.status === 'pending' || booking.status === 'refunded'
            ? raw('')
            : html`<p class="muted">Cancellations are not accepted after the session starts.</p>`}

        <a class="action" href="/c/${booking.coach_handle}?from=${req.params.token}">Book another session</a>
        <a class="action ghost" href="/c/${booking.coach_handle}">Back to ${booking.coach_handle}'s page</a>`,
    ),
  );
});

publicRouter.post('/booking/:token/cancel', async (req, res) => {
  const db = getDb();
  const booking = await loadBookingByToken(db, req.params.token);
  if (!booking) {
    res.status(404).send(notFound());
    return;
  }

  if (booking.status !== 'cancelled' && !cancellationAllowed(booking)) {
    res.status(409).send(
      page('Cannot cancel', html`<h1>Session already started</h1>
        <p class="error">This session has already passed and cannot be cancelled.</p>
        <a class="action" href="/booking/${req.params.token}">Back to booking detail</a>`),
    );
    return;
  }

  // Idempotent: cancelling an already-cancelled booking succeeds without
  // refunding a credit a second time. The WHERE clause only matches (and
  // only refunds) on the transition that actually happens.
  const result = await db.query<{ id: number }>(
    `update booking set status = 'cancelled'
     where manage_token = $1 and status in ('booked', 'attended', 'noshow')
     returning id`,
    [req.params.token],
  );

  if (result.rows.length > 0 && booking.credit_id) {
    await restoreCredit(db, booking.credit_id);
  }

  res.redirect(303, `/booking/${req.params.token}`);
});
