import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { canText, sendEmailMessage, sendText, signInCodeEmail, type SendOutcome } from '../domain/outbound.js';
import {
  normalizePhone,
  normalizeEmail,
  parseContact,
  contactValue,
  findCoachByContact,
  findCoachHoldingEmail,
  emailTakenNotice,
  markEmailVerified,
  releaseUnprovedEmail,
  setCoachPhone,
  type Contact,
  createOtp,
  checkOtp,
  consumeOtp,
  contactKey,
  hasLiveOtp,
  newOtpCode,
  type OtpCheck,
  createCoachSession,
  deleteCoachSession,
  getCoachBySessionToken,
  findCoachById,
  createCoach,
  getConnectRecipientKey,
  type CoachRow,
} from '../domain/auth.js';
import {
  APP_FEE_BPS,
  OTP_DAILY_MAX_PER_CONTACT,
  SELLER_AGREEMENT_VERSION,
  SELLER_PRODUCT_DESCRIPTION,
  testPaymentsAllowed,
} from '../config.js';
import { acceptSellerAgreement, getSellerStatus, startSellerOnboarding } from '../relay/seller.js';
import {
  appBaseUrl,
  coachPageUrl,
  consumePaymentsLink,
  markPaymentsStarted,
  notePublished,
  openPaymentsLink,
  paymentsOpen,
  recordSellerStatus,
} from '../domain/payments.js';
import { createWeeklySlots, deactivateSlot, listWeeklySlots, type WeeklySlot } from '../domain/scheduling.js';
import { coachNav, html, oneTimeCodeNote, page, raw, smsConsentCheckbox, type SafeHtml } from '../lib/html.js';
import { cancelReach, cancelScheduledSession, dropInCreditNote, previewSessionCancel, type CancelReach } from '../domain/cancelSession.js';
import { DEFAULT_TZ, formatClockLocal, formatCoachDollars, formatLocal, formatTimeRange, isValidTimeZone } from '../lib/time.js';
import { getPackagesForCoach, getPlansForCoach, createPackage, createPlan, takesSpotSql } from '../domain/pricing.js';
import { clockTime, dollarsToCents, LIMITS, rowId, wholeNumber } from '../lib/input.js';
import {
  canWaive,
  CREDIT_WITHDRAWN_SQL,
  getBookingPolicy,
  MAX_CANCEL_WINDOW_HOURS,
  MAX_CHILDREN_PER_BOOKING,
  parseBookingPolicy,
  setBookingPolicy,
  waiveBooking,
  type BookingPolicy,
} from '../domain/policy.js';
import { summarizeMoney } from '../domain/money.js';
import { namesList } from '../domain/bookingMessages.js';
import { describeAttention, listPaymentAttention, type AttentionItem } from '../domain/paymentAttention.js';
import {
  canTryAgain,
  checkRefund,
  describeDispute,
  describeRefund,
  describeRefundBlock,
  listDisputes,
  listRecentPayments,
  listRefunds,
  needsAttention,
  purchaseLabel,
  refundLabel,
  refundsByPayment,
  requestRefund,
  type DisputeItem,
  type PaymentItem,
  type Refundability,
  type RefundBlock,
  type RefundItem,
  type RefundRequestOutcome,
  type RefundRow,
  type RefundTarget,
} from '../domain/refunds.js';
import { handleCoachMessage, loadScheduleAssistant, resolvePendingForCoach } from '../domain/assistant.js';
import { clearCookie, parseCookies, serializeCookie } from '../lib/cookies.js';
import {
  answerAsk,
  pendingAskForCoach,
  rosterOptInLink,
  runningCascadesForCoach,
  type OverflowAnswer,
  type PendingAsk,
  type RunningCascade,
} from '../domain/cascade.js';
import { readStartText, START_COOKIE } from '../lib/startCookie.js';
import {
  coachHasSchedule,
  discardDraft,
  getOpenDraft,
  handleSetupMessage,
  publishSetupPlan,
  renderSetupPreview,
  type SetupDraft,
} from '../domain/setup.js';
import { hasActiveConsent, isOptedOut, optedOutNotice, recordConsent } from '../domain/sms-consent.js';
import {
  clientKey,
  CODE_CHECK_CONTACT_LIMITS,
  CODE_CHECK_IP_LIMITS,
  SIGNIN_CODE_LIMITS,
  takeRequest,
} from '../domain/requestLimits.js';

// ---- Roster functions (M4 overflow cascade) ----

export async function addRosterMember(db: DbClient, coachId: number, name: string, phone: string): Promise<void> {
  // Get the highest priority currently in use
  const maxResult = await db.query<{ max_priority: number }>(
    `select coalesce(max(priority), -1) as max_priority from roster_member where coach_id = $1 and active = true`,
    [coachId]
  );
  
  const nextPriority = maxResult.rows[0].max_priority + 1;
  
  await db.query(
    `insert into roster_member (coach_id, name, phone, priority, active) values ($1, $2, $3, $4, true)`,
    [coachId, name, phone, nextPriority]
  );
}

export async function updateRosterPriority(db: DbClient, coachId: number, id: number, newPriority: number): Promise<boolean> {
  const result = await db.query<{ affected: number }>(
    `update roster_member set priority = $1 where id = $2 and coach_id = $3 and active = true returning id`,
    [newPriority, id, coachId]
  );
  
  return result.rows.length > 0;
}

export async function listRosterMembers(db: DbClient, coachId: number): Promise<Array<{ id: number; name: string; phone: string; priority: number }>> {
  const result = await db.query<{ id: number; name: string; phone: string; priority: number }>(
    `select id, name, phone, priority from roster_member where coach_id = $1 and active = true order by priority asc`,
    [coachId]
  );
  
  return result.rows;
}

export const SESSION_COOKIE = 'cx_session';
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const coachRouter = Router();

// Every id in a coach URL is a row id: anything else (abc, 1.5, a number
// past what the column holds) is a 404 before the route runs.
for (const name of ['id', 'bookingId', 'slotId', 'sessionId']) {
  coachRouter.param(name, (req, res, next, value) => {
    if (rowId(value) === null) {
      res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
      return;
    }
    next();
  });
}

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function signedInCoachId(req: Request): Promise<number | null> {
  const token = parseCookies(req.headers.cookie).cx_session;
  return token ? getCoachBySessionToken(getDb(), token) : null;
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const db = getDb();
  const token = parseCookies(req.headers.cookie).cx_session;
  const coachId = token ? await getCoachBySessionToken(db, token) : null;
  if (!coachId) {
    res.redirect(303, '/signin');
    return;
  }
  res.locals.coachId = coachId;
  next();
}

// ---- Screen 1: sign in ----

// One box: an email gets a code by email (works anywhere); a US or Canadian
// mobile gets a text code. Text codes reach only +1 numbers (SPEC.md §10).
function renderContactForm(value = '', error?: string, saved = false) {
  return page(
    'Sign in',
    html`<h1>Coachatron</h1>
      <p class="muted">${saved ? "Saved. Now your email or mobile. We'll send a code, then show your week." : 'Sign in or sign up with your email or mobile number.'}</p>
      <form method="post" action="/signin/otp">
        <label for="contact">Email or mobile number</label>
        <input id="contact" name="contact" type="text" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="you@example.com or (555) 555-0100" value="${value}" required />
        ${oneTimeCodeNote()}
        ${smsConsentCheckbox()}
        <button type="submit">Send code</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}`,
  );
}

const NOT_TEXTABLE = 'We text only US and Canadian mobile numbers. Use your email instead.';
/** Code checks: the longest of their windows is an hour. */
const TOO_MANY_TRIES = 'Too many tries. Try again in an hour.';
/** Code requests from one address: the longest window is a day. */
const TOO_MANY_CODE_REQUESTS = 'Too many codes asked for from here. Try again later.';
const RELAY_BUSY = "We can't send codes right now. Try again in a few minutes.";
/** Text codes held back (the relay's limits, or the app-wide ceiling on
 * texts to people not signed in): email still works. */
const TEXTS_BUSY = "We can't text codes right now. Try again later, or use your email instead.";
const SEND_FAILED = "We couldn't send a code just now. Try again in a minute.";
const CODE_ERRORS: Record<Exclude<OtpCheck, { ok: true }>['reason'], string> = {
  wrong: 'Invalid or expired code.',
  none: 'Invalid or expired code.',
  'used-up': 'That code had too many wrong tries. Go back and ask for a new one.',
};

function optedOutAtSignIn(): string {
  return optedOutNotice('first, or use your email');
}

type CodeOutcome = SendOutcome | 'failed';

function signInCodeText(code: string): string {
  return `Coachatron: your sign-in code is ${code}. Expires in 10 minutes.`;
}

/** Sends a sign-in code and stores it only once it has gone out, so a
 * request the send limits refuse leaves no code behind. `visitor`: asked
 * for by someone not signed in, so a text code counts against the
 * app-wide visitor ceiling; a signed-in coach's codes do not. */
async function sendCode(
  db: DbClient,
  contact: Contact,
  opts: { coachId: number | null; smsConsent: boolean; text?: (code: string) => string; visitor?: boolean },
): Promise<CodeOutcome> {
  const code = newOtpCode();
  let outcome: SendOutcome;
  try {
    outcome =
      contact.kind === 'email'
        ? await sendEmailMessage(db, {
            to: contact.email,
            ...signInCodeEmail(code),
            coachId: opts.coachId,
            template: 'otp',
            perRecipientDailyMax: OTP_DAILY_MAX_PER_CONTACT,
          })
        : await sendText(db, {
            to: contact.phone,
            body: (opts.text ?? signInCodeText)(code),
            coachId: opts.coachId,
            template: 'otp',
            perRecipientDailyMax: OTP_DAILY_MAX_PER_CONTACT,
            ...(opts.visitor ? { visitor: 'always' as const } : {}),
          });
  } catch (err) {
    console.error('sign-in code not sent:', err instanceof Error ? err.message : err);
    return 'failed';
  }
  if (outcome === 'sent') await createOtp(db, contact, { code, smsConsent: opts.smsConsent });
  return outcome;
}

/** Counts one code check for this address, and for this phone or email
 * while it has a live code. With no code out there is nothing to guess,
 * so checks alone never hold back the next code asked for. */
async function takeCodeCheck(db: DbClient, req: Request, contact: Contact): Promise<boolean> {
  const byAddress = await takeRequest(db, CODE_CHECK_IP_LIMITS, clientKey(req));
  const byContact = (await hasLiveOtp(db, contact)) ? await takeRequest(db, CODE_CHECK_CONTACT_LIMITS, contactKey(contact)) : true;
  return byAddress && byContact;
}

/** The texts box ticked when the code was asked for. A STOP sent since
 * then stands: the number opts back in by texting START. */
async function recordCodeConsent(db: DbClient, req: Request, phone: string, source: string): Promise<void> {
  if (await isOptedOut(db, phone)) return;
  await recordConsent(db, phone, source, { ...consentMeta(req), numberVerified: true });
}

function smsConsentChecked(body: unknown): boolean {
  const value = (body as Record<string, unknown> | undefined)?.sms_consent;
  return value === '1' || value === 'on' || value === true;
}

function consentMeta(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = typeof req.ip === 'string' ? req.ip : null;
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  return { ip, userAgent };
}

/** The submitted contact: the new one-box field, or the older phone field. */
function contactField(body: unknown): string {
  return field(body, 'contact') || field(body, 'to') || field(body, 'phone');
}

coachRouter.get('/signin', (req, res) => {
  res.status(200).send(renderContactForm('', undefined, Boolean(readStartText(req.headers.cookie))));
});

coachRouter.post('/signin/otp', async (req, res) => {
  const saved = Boolean(readStartText(req.headers.cookie));
  const rawContact = contactField(req.body);
  const contact = parseContact(rawContact);
  const again = (status: number, error: string) => {
    res.status(status).send(renderContactForm(rawContact, error, saved));
  };
  if (!contact) {
    again(422, 'Enter an email address or a mobile number.');
    return;
  }
  if (contact.kind === 'phone' && !canText(contact.phone)) {
    again(422, NOT_TEXTABLE);
    return;
  }
  const db = getDb();
  if (!(await takeRequest(db, SIGNIN_CODE_LIMITS, clientKey(req)))) {
    again(429, TOO_MANY_CODE_REQUESTS);
    return;
  }
  if (contact.kind === 'phone' && (await isOptedOut(db, contact.phone))) {
    again(422, optedOutAtSignIn());
    return;
  }
  // The code is one text the person asked for; the box only covers the
  // texts after it, so leaving it unchecked never blocks signing in. It is
  // recorded once the code proves the number belongs to whoever ticked it.
  const outcome = await sendCode(db, contact, {
    coachId: null,
    smsConsent: contact.kind === 'phone' && smsConsentChecked(req.body),
    visitor: true,
  });
  if (outcome === 'sent') {
    res.redirect(303, `/signin/verify?to=${encodeURIComponent(contactValue(contact))}`);
    return;
  }
  if (outcome === 'capped') {
    again(429, `Too many codes for ${contact.kind === 'email' ? 'this email' : 'this number'} today. Try again tomorrow.`);
  } else if (outcome === 'busy') {
    again(429, contact.kind === 'phone' ? TEXTS_BUSY : RELAY_BUSY);
  } else if (outcome === 'failed') {
    again(502, SEND_FAILED);
  } else {
    again(422, contact.kind === 'phone' ? optedOutAtSignIn() : SEND_FAILED);
  }
});

coachRouter.get('/signin/verify', (req, res) => {
  const to = typeof req.query.to === 'string' ? req.query.to : typeof req.query.phone === 'string' ? req.query.phone : '';
  const contact = parseContact(to);
  if (!contact) {
    res.redirect(303, '/signin');
    return;
  }
  res.status(200).send(renderVerifyForm(contact, {}));
});

// The browser knows the coach's timezone; a typed IANA name was a
// five-minute-setup tax. The server still validates it and falls back.
const TZ_SCRIPT = raw(
  `<script>try{var t=document.getElementById('tz');if(t&&!t.value)t.value=Intl.DateTimeFormat().resolvedOptions().timeZone||''}catch(e){}</script>`,
);

function renderVerifyForm(
  contact: Contact,
  values: { code?: string; name?: string; email?: string; tz?: string },
  error?: string,
) {
  const to = contactValue(contact);
  return page(
    'Verify',
    html`<h1>Enter your code</h1>
      <p class="muted">We ${contact.kind === 'email' ? 'emailed' : 'texted'} a 6-digit code to ${to}.${contact.kind === 'email' ? ' Check spam if it is not there in a minute.' : ''}</p>
      <form method="post" action="/signin/verify">
        <input type="hidden" name="to" value="${to}" />
        <label for="code">Code</label>
        <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" value="${values.code ?? ''}" required />

        <p class="muted">New here? Just your name. Everything else can wait.</p>
        <label for="name">Your name</label>
        <input id="name" name="name" autocomplete="name" value="${values.name ?? ''}" />
        ${contact.kind === 'phone'
          ? html`<label for="email">Email (optional)</label>
              <input id="email" name="email" type="email" autocomplete="email" value="${values.email ?? ''}" />`
          : raw('')}
        <input id="tz" name="tz" type="hidden" value="${values.tz ?? ''}" />

        <button type="submit">Continue</button>
      </form>
      ${error ? raw(`<p class="error">${error}</p>`) : raw('')}
      ${TZ_SCRIPT}`,
  );
}

coachRouter.post('/signin/verify', async (req, res) => {
  const contact = parseContact(contactField(req.body));
  const code = field(req.body, 'code');
  const name = field(req.body, 'name');
  const email = field(req.body, 'email');
  const tz = field(req.body, 'tz');
  if (!contact) {
    res.redirect(303, '/signin');
    return;
  }

  const db = getDb();
  if (!(await takeCodeCheck(db, req, contact))) {
    res.status(429).send(renderVerifyForm(contact, { code, name, email, tz }, TOO_MANY_TRIES));
    return;
  }
  const check = await checkOtp(db, contact, code);
  if (!check.ok) {
    res.status(401).send(renderVerifyForm(contact, { code, name, email, tz }, CODE_ERRORS[check.reason]));
    return;
  }
  const otpId = check.id;

  let coach: CoachRow | null = await findCoachByContact(db, contact);
  if (!coach) {
    // An email that only sits, unproved, on an account that signs in by
    // text does not open that account.
    const unproved = contact.kind === 'email' && (await findCoachHoldingEmail(db, contact.email)) !== null;
    if (!name) {
      res
        .status(422)
        .send(
          renderVerifyForm(
            contact,
            { code, name, email, tz },
            unproved
              ? "That email isn't confirmed on an account yet. Sign in with your mobile, or enter your name to start a new account."
              : 'Enter your name.',
          ),
        );
      return;
    }
    // An optional email given on a phone join must not belong to another
    // coach, and stays unproved until a code sent to it is entered.
    const extraEmail = contact.kind === 'phone' ? normalizeEmail(email) : null;
    const holder = extraEmail ? await findCoachHoldingEmail(db, extraEmail) : null;
    if (holder) {
      res.status(422).send(renderVerifyForm(contact, { code, name, email, tz }, emailTakenNotice(holder)));
      return;
    }
    if (!(await consumeOtp(db, otpId))) {
      res.status(401).send(renderVerifyForm(contact, { code, name, email, tz }, CODE_ERRORS.none));
      return;
    }
    if (unproved) await releaseUnprovedEmail(db, contactValue(contact));
    coach = await createCoach(db, {
      phone: contact.kind === 'phone' ? contact.phone : null,
      email: contact.kind === 'email' ? contact.email : (extraEmail ?? ''),
      emailVerified: contact.kind === 'email',
      name,
      tz: isValidTimeZone(tz) ? tz : DEFAULT_TZ,
    });
  } else if (!(await consumeOtp(db, otpId))) {
    res.status(401).send(renderVerifyForm(contact, { code, name, email, tz }, CODE_ERRORS.none));
    return;
  }
  if (contact.kind === 'phone' && check.smsConsent) await recordCodeConsent(db, req, contact.phone, '/signin/otp');

  const token = await createCoachSession(db, coach.id);
  const cookies = [serializeCookie(SESSION_COOKIE, token, 30 * 24 * 60 * 60)];
  const startText = readStartText(req.headers.cookie);
  if (startText) {
    const result = await handleSetupMessage(db, coach, startText, 'web');
    if (result.kind === 'draft') {
      cookies.push(clearCookie(START_COOKIE));
    }
    res.setHeader('Set-Cookie', cookies);
    const error = result.kind === 'cap' ? '&e=cap' : result.kind === 'error' ? '&e=read' : '';
    res.redirect(303, `/app/schedule?setup=1${error}`);
    return;
  }
  res.setHeader('Set-Cookie', cookies);
  res.redirect(303, '/app/schedule');
});

// Sign out: ends this browser's session on the server and clears the cookie.
coachRouter.post('/signout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await deleteCoachSession(getDb(), token);
  res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
  res.redirect(303, '/signin');
});

// ---- Screen 1, from a text: the payments link ----

// A coach who only texts gets this link after publishing. It signs them in
// once and opens Money, where the terms box and the payments button are.
// Opening it only shows a button: a link preview must not use it up.

function renderPaymentsLinkPage(token: string, coachName: string) {
  return page(
    'Set up payments',
    html`<h1>Set up payments</h1>
      <p class="muted">Signs you in as ${coachName} and opens payments, so parents can pay you when they book.</p>
      <form method="post" action="/p/${token}">
        <button type="submit">Continue</button>
      </form>`,
  );
}

function paymentsLinkDonePage() {
  return page(
    'Link expired',
    html`<h1>That link is done.</h1>
      <p class="muted">Sign in to set up payments.</p>
      <a class="action" href="/signin">Sign in</a>`,
  );
}

async function answerUsedPaymentsLink(req: Request, res: Response): Promise<void> {
  if (await signedInCoachId(req)) {
    res.redirect(303, '/app/money');
    return;
  }
  res.status(410).send(paymentsLinkDonePage());
}

coachRouter.get('/p/:token', async (req, res) => {
  const db = getDb();
  const coachId = await openPaymentsLink(db, req.params.token);
  const coach = coachId ? await findCoachById(db, coachId) : null;
  if (!coach) {
    await answerUsedPaymentsLink(req, res);
    return;
  }
  res.status(200).send(renderPaymentsLinkPage(req.params.token, coach.name));
});

coachRouter.post('/p/:token', async (req, res) => {
  const db = getDb();
  const coachId = await consumePaymentsLink(db, req.params.token);
  if (!coachId) {
    await answerUsedPaymentsLink(req, res);
    return;
  }
  const token = await createCoachSession(db, coachId);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, 30 * 24 * 60 * 60));
  res.redirect(303, '/app/money');
});

// ---- Screen 4: session types ----

type SessionTypeFields = {
  name: string;
  durationMin: number;
  capacity: number;
  priceCents: number;
  backupPayCents: number | null;
};

function parseSessionTypeBody(body: Record<string, unknown>): SessionTypeFields | null {
  const name = field(body, 'name');
  const durationMin = wholeNumber(field(body, 'duration_min'), LIMITS.durationMin);
  const capacity = wholeNumber(field(body, 'capacity'), LIMITS.capacity);
  const priceCents = dollarsToCents(field(body, 'price_dollars'), LIMITS.priceCents);
  const backupPayRaw = field(body, 'backup_pay_dollars');
  const backupPayCents = backupPayRaw ? dollarsToCents(backupPayRaw, LIMITS.backupPayCents) : null;
  if (!name || durationMin === null || capacity === null || priceCents === null || (backupPayRaw && backupPayCents === null)) {
    return null;
  }
  return { name, durationMin, capacity, priceCents, backupPayCents };
}

/** The form's message when a number is missing or out of range. */
const SESSION_TYPE_RANGES = `Fill in every field: ${LIMITS.durationMin.min}–${LIMITS.durationMin.max} minutes, ${LIMITS.capacity.min}–${LIMITS.capacity.max} athletes, and a price up to ${formatCoachDollars(LIMITS.priceCents.max)}.`;

/** The future session of this type with the most spots taken, when that is
 * more than the new capacity. Sessions given their own capacity (a backup
 * coach joined) keep it and are not counted. */
async function sessionAboveCapacity(
  db: DbClient,
  coachId: number,
  typeId: number,
  capacity: number,
): Promise<{ starts_at_utc: string; tz: string; taken: number } | null> {
  const result = await db.query<{ starts_at_utc: string; tz: string; taken: number }>(
    `select s.starts_at_utc, s.tz, count(b.id)::int as taken
     from session s
     join session_type st on st.id = s.session_type_id
     join booking b on b.session_id = s.id and ${takesSpotSql('b')}
     where st.id = $1 and st.coach_id = $2 and s.status = 'scheduled' and s.starts_at_utc > now()
       and s.capacity_override is null
     group by s.id
     having count(b.id) > $3
     order by count(b.id) desc, s.starts_at_utc
     limit 1`,
    [typeId, coachId, capacity],
  );
  return result.rows[0] ?? null;
}

function renderSessionTypeForm(
  action: string,
  submitLabel: string,
  values?: Partial<SessionTypeFields> & { priceDollars?: number; backupPayDollars?: number },
) {
  const priceDollars = values?.priceDollars ?? (values?.priceCents != null ? values.priceCents / 100 : undefined);
  const backupPayDollars =
    values?.backupPayDollars ?? (values?.backupPayCents != null ? values.backupPayCents / 100 : undefined);
  return html`<form method="post" action="${action}">
    <label for="name">Session name</label>
    <input id="name" name="name" required placeholder="e.g. Group training" value="${values?.name ?? ''}" />
    <label for="duration_min">Duration (minutes)</label>
    <input id="duration_min" name="duration_min" type="number" min="${LIMITS.durationMin.min}" max="${LIMITS.durationMin.max}" required value="${values?.durationMin ?? ''}" />
    <label for="capacity">Capacity</label>
    <input id="capacity" name="capacity" type="number" min="${LIMITS.capacity.min}" max="${LIMITS.capacity.max}" required value="${values?.capacity ?? ''}" />
    <label for="price_dollars">Price (dollars)</label>
    <input id="price_dollars" name="price_dollars" type="number" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required value="${priceDollars ?? ''}" />
    <label for="backup_pay_dollars">Backup coach pays (dollars, optional)</label>
    <input id="backup_pay_dollars" name="backup_pay_dollars" type="number" min="0" max="${LIMITS.backupPayCents.max / 100}" step="0.01" value="${backupPayDollars ?? ''}" />
    <button type="submit">${submitLabel}</button>
  </form>`;
}

coachRouter.get('/app/session-types', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const types = await db.query<{
    id: number;
    name: string;
    duration_min: number;
    capacity: number;
    price_cents: number;
    backup_pay_cents: number | null;
  }>(
    'select id, name, duration_min, capacity, price_cents, backup_pay_cents from session_type where coach_id = $1 order by id',
    [coachId],
  );
  res.status(200).send(
    page(
      'Session types',
      html`${coachNav('types')}
        <h1>Session types</h1>
        ${types.rows.map(
          (t) =>
            html`<div class="card">
              <strong>${t.name}</strong>
              <div class="meta">
                <span>${t.duration_min} min · ${t.capacity} athletes · ${formatCoachDollars(t.price_cents)}</span>
              </div>
              ${t.backup_pay_cents ? html`<div class="meta"><span>Backup coach pays ${formatCoachDollars(t.backup_pay_cents)}</span></div>` : raw('')}
              <div class="btn-row">
                <a class="action ghost" href="/app/session-types/${t.id}/edit">Edit</a>
                <a class="action" href="/app/session-types/${t.id}/generate-week">Weekly times ›</a>
              </div>
            </div>`,
        )}
        ${renderSessionTypeForm('/app/session-types', 'Create session type')}`,
    ),
  );
});

coachRouter.post('/app/session-types', requireAuth, async (req, res) => {
  const coachId = res.locals.coachId as number;
  const parsed = parseSessionTypeBody(req.body as Record<string, unknown>);
  if (!parsed) {
    res.status(422).send(
      page(
        'Session types',
        html`<h1>Session types</h1>
          <p class="error">${SESSION_TYPE_RANGES}</p>
          <a class="action" href="/app/session-types">Back</a>`,
      ),
    );
    return;
  }

  const db = getDb();
  await db.query(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, backup_pay_cents, active)
     values ($1, $2, $3, $4, $5, $6, true)`,
    [coachId, parsed.name, parsed.durationMin, parsed.capacity, parsed.priceCents, parsed.backupPayCents || null],
  );
  res.redirect(303, '/app/session-types');
});

coachRouter.get('/app/session-types/:id/edit', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);
  const typeRows = await db.query<{
    id: number;
    name: string;
    duration_min: number;
    capacity: number;
    price_cents: number;
    backup_pay_cents: number | null;
  }>(
    'select id, name, duration_min, capacity, price_cents, backup_pay_cents from session_type where id = $1 and coach_id = $2',
    [typeId, coachId],
  );
  if (typeRows.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const t = typeRows.rows[0];
  res.status(200).send(
    page(
      'Edit session type',
      html`${coachNav('types')}
        <h1>Edit session type</h1>
        ${renderSessionTypeForm(`/app/session-types/${typeId}/edit`, 'Save changes', {
          name: t.name,
          durationMin: t.duration_min,
          capacity: t.capacity,
          priceCents: t.price_cents,
          backupPayCents: t.backup_pay_cents,
        })}
        <a class="action ghost" href="/app/session-types">Back</a>`,
    ),
  );
});

coachRouter.post('/app/session-types/:id/edit', requireAuth, async (req, res) => {
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);
  const parsed = parseSessionTypeBody(req.body as Record<string, unknown>);
  if (!parsed) {
    res.status(422).send(
      page(
        'Edit session type',
        html`<h1>Edit session type</h1>
          <p class="error">${SESSION_TYPE_RANGES}</p>
          <a class="action" href="/app/session-types/${typeId}/edit">Back</a>`,
      ),
    );
    return;
  }
  const db = getDb();
  const crowded = await sessionAboveCapacity(db, coachId, typeId, parsed.capacity);
  if (crowded) {
    res.status(422).send(
      page(
        'Edit session type',
        html`<h1>Edit session type</h1>
          <p class="error">${formatLocal(crowded.starts_at_utc, crowded.tz)} already has ${crowded.taken} booked. Set the capacity to at least ${crowded.taken}, or cancel that session first.</p>
          <a class="action" href="/app/session-types/${typeId}/edit">Back</a>`,
      ),
    );
    return;
  }
  const updated = await db.query<{ id: number }>(
    `update session_type
     set name = $1, duration_min = $2, capacity = $3, price_cents = $4, backup_pay_cents = $5
     where id = $6 and coach_id = $7
     returning id`,
    [
      parsed.name,
      parsed.durationMin,
      parsed.capacity,
      parsed.priceCents,
      parsed.backupPayCents || null,
      typeId,
      coachId,
    ],
  );
  if (updated.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  res.redirect(303, '/app/session-types');
});

coachRouter.get('/app/session-types/:id/generate-week', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);
  const typeRows = await db.query<{
    id: number;
    name: string;
    duration_min: number;
    capacity: number;
    price_cents: number;
  }>(
    'select id, name, duration_min, capacity, price_cents from session_type where id = $1 and coach_id = $2',
    [typeId, coachId],
  );
  if (typeRows.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const kept = typeof req.query.kept === 'string' ? Number(req.query.kept) : 0;
  res.status(200).send(renderWeeklyTimes(typeRows.rows[0], await listWeeklySlots(db, typeId), kept));
});

function renderWeeklyTimes(
  type: { id: number; name: string; duration_min: number; capacity: number; price_cents: number },
  slots: Array<{ id: number; weekday: number; time_local: string; location_text: string | null }>,
  kept: number,
  error?: string,
) {
  const typeLine = `${type.name} · ${type.duration_min} min · ${type.capacity} athletes · ${formatCoachDollars(type.price_cents)}`;
  return page(
    'Weekly times',
    html`${coachNav('types')}
      <h1>Weekly times</h1>
      <p class="muted">${typeLine}. Sessions stay on your calendar 8 weeks ahead.</p>
      ${kept > 0
        ? html`<p class="muted">${kept} upcoming ${kept === 1 ? 'session has' : 'sessions have'} bookings and stayed. Cancel ${kept === 1 ? 'it' : 'them'} from the schedule if you need to.</p>`
        : raw('')}
      ${slots.map(
        (slot) => html`<div class="card">
          <div class="row">
            <span>${WEEKDAY_LABELS[slot.weekday]} ${slot.time_local}${slot.location_text ? ` · ${slot.location_text}` : ''}</span>
            <form method="post" action="/app/session-types/${type.id}/slots/${slot.id}/remove">
              <button type="submit" class="ghost">Remove</button>
            </form>
          </div>
        </div>`,
      )}
      <form method="post" action="/app/session-types/${type.id}/generate-week">
        ${WEEKDAY_LABELS.map(
          (label, i) =>
            html`<label><input type="checkbox" name="day_${i}" value="1" /> ${label}
              <input type="time" name="time_${i}" aria-label="${label} start time" /></label>`,
        )}
        <label for="location">Where (optional)</label>
        <input id="location" name="location" placeholder="Field 3" />
        <button type="submit">Add weekly times</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}`,
  );
}

coachRouter.post('/app/session-types/:id/generate-week', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);

  const typeRows = await db.query<{
    id: number;
    name: string;
    duration_min: number;
    capacity: number;
    price_cents: number;
  }>(
    'select id, name, duration_min, capacity, price_cents from session_type where id = $1 and coach_id = $2',
    [typeId, coachId],
  );
  if (typeRows.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const coachRows = await db.query<{ tz: string }>('select tz from coach where id = $1', [coachId]);
  const tz = coachRows.rows[0]?.tz ?? DEFAULT_TZ;

  const body = req.body as Record<string, unknown>;
  const locationText = field(body, 'location') || null;
  const current = await listWeeklySlots(db, typeId);
  const refuse = (message: string) => res.status(422).send(renderWeeklyTimes(typeRows.rows[0], current, 0, message));
  const slots: WeeklySlot[] = [];
  for (let i = 0; i < 7; i += 1) {
    const checked = field(body, `day_${i}`) === '1';
    const raw = field(body, `time_${i}`);
    if (!checked || !raw) continue;
    const timeLocal = clockTime(raw);
    if (!timeLocal) {
      refuse(`${WEEKDAY_LABELS[i]}: use a time from 00:00 to 23:59.`);
      return;
    }
    slots.push({ weekday: i, timeLocal, locationText });
  }

  if (slots.length === 0) {
    refuse('Pick at least one day and time.');
    return;
  }

  // A weekday and time the type already has stays as it is, so a new place
  // for it would not be saved: say so instead of adding the rest.
  const elsewhere = slots.flatMap((slot) => {
    const have = current.find((c) => c.weekday === slot.weekday && c.time_local === slot.timeLocal);
    return have && locationText && (have.location_text ?? '') !== locationText ? [have] : [];
  });
  if (elsewhere.length > 0) {
    const which = elsewhere
      .map((c) => `${WEEKDAY_LABELS[c.weekday]} ${c.time_local}${c.location_text ? ` (at ${c.location_text})` : ''}`)
      .join(', ');
    const are = elsewhere.length === 1 ? 'is already a weekly time and keeps its place' : 'are already weekly times and keep their places';
    refuse(`${which} ${are}, so nothing was added.`);
    return;
  }

  await createWeeklySlots(db, typeId, tz, slots, new Date());
  const coach = await findCoachById(db, coachId);
  if (coach) await notePublished(db, coach);
  res.redirect(303, '/app/schedule');
});

coachRouter.post('/app/session-types/:id/slots/:slotId/remove', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);
  const kept = await deactivateSlot(db, coachId, Number(req.params.slotId), new Date());
  if (kept === null) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  res.redirect(303, `/app/session-types/${typeId}/generate-week${kept > 0 ? `?kept=${kept}` : ''}`);
});

// ---- Screen 2: schedule ----

// Voice setup lives on the schedule screen (screen 2), not a thirteenth
// screen: a coach with nothing on the calendar sees "Tell me your week".

const SETUP_NOTICES: Record<string, string> = {
  read: "I couldn't read that. Try again, or set up with a form instead.",
  cap: "That's all the reading I can do today. Set up with a form instead for now.",
  stale: 'That setup already went live or was cleared.',
};

// Every time says am or pm: a bare hour is read as pm (src/domain/setup.ts).
const SETUP_EXAMPLE =
  'Keeper group Tuesdays and Thursdays at 6pm at Field 3, an hour, 8 kids, $35. Backup coach gets $80. Privates Saturday at 9am, 10am and 11am, 45 minutes, $70. 10-pack for $300.';

function renderSetupScreen(
  coach: CoachRow,
  draft: SetupDraft | null,
  notice: string | null,
  hasSchedule: boolean,
  startText = '',
) {
  const questions = draft?.questions ?? [];
  const ready = draft !== null && questions.length === 0;
  const label = !draft ? 'Tell me your week' : questions.length > 0 ? questions[0] : 'Change anything? Just say it.';
  const submit = !draft ? 'Set it up' : questions.length > 0 ? 'Answer' : 'Update';
  return page(
    'Set up',
    html`${coachNav('schedule')}
      <h1>${draft ? "Here's your week" : 'Tell me your week'}</h1>
      ${notice ? html`<p class="error">${notice}</p>` : raw('')}
      ${draft
        ? renderSetupPreview(draft.plan, coach)
        : html`<p class="muted">Tap the mic on your keyboard and talk. Say what you coach, how long, how many athletes, the price, and your days and times.</p>`}
      ${questions.length > 0
        ? html`<ul class="setup-questions">${questions.map((q) => html`<li>${q}</li>`)}</ul>`
        : raw('')}
      ${ready
        ? html`<form method="post" action="/app/setup/publish">
            <input type="hidden" name="id" value="${draft.id}" />
            <button type="submit">Publish</button>
          </form>`
        : raw('')}
      <form method="post" action="/app/setup">
        <label for="setup-text">${label}</label>
        <textarea id="setup-text" name="text" rows="6" required placeholder="${SETUP_EXAMPLE}">${startText}</textarea>
        <button type="submit"${ready ? raw(' class="ghost"') : raw('')}>${submit}</button>
      </form>
      ${draft
        ? html`<form method="post" action="/app/setup/discard">
            <input type="hidden" name="id" value="${draft.id}" />
            <button type="submit" class="ghost">Start over</button>
          </form>`
        : raw('')}
      <p class="muted">
        ${hasSchedule
          ? html`<a href="/app/schedule">Back to the schedule</a>`
          : html`Rather use forms? <a href="/app/session-types">Set up with a form instead</a>.`}
      </p>`,
  );
}

// Copies the page link and says "Copied" only once it is copied. Where the
// clipboard API is missing or refused, the older copy command is tried on
// the selected box; if that fails too, the link is left selected to copy.
const COPY_LINK_SCRIPT =
  "var b=this,i=document.getElementById('page-link');i.focus();i.select();" +
  "function done(){b.textContent='Copied'}" +
  "function old(){try{if(document.execCommand('copy'))done()}catch(e){}}" +
  "try{navigator.clipboard.writeText(i.value).then(done,old)}catch(e){old()}";

/** The coach's page link, always in view on Schedule and Money: one box to
 * select or copy, and a way to text it. On Schedule the main action is
 * sharing it, or, until payments work, setting them up. Money has its own. */
function renderPageLinkCard(coach: CoachRow, opts: { main: 'share' | 'payments' | 'none'; justPublished?: boolean }) {
  const link = coachPageUrl(coach.handle);
  const share = `sms:?&body=${encodeURIComponent(`Book with me: ${link}`)}`;
  return html`<div class="card page-link">
    ${opts.justPublished
      ? html`<p><strong>You're live.</strong> Parents book at ${link.replace(/^https?:\/\//, '')}</p>`
      : raw('')}
    <label for="page-link">Your page</label>
    <input id="page-link" type="text" readonly value="${link}" onfocus="this.select()" />
    <div class="btn-row">
      <button type="button" class="ghost" onclick="${COPY_LINK_SCRIPT}">Copy link</button>
      <a class="action${opts.main === 'share' ? '' : ' ghost'}" href="${share}">Share your link</a>
    </div>
    ${opts.main === 'payments'
      ? html`<p class="muted">Parents can't book until payments are set up.</p>
          <a class="action" href="/app/money">Connect payments</a>`
      : raw('')}
  </div>`;
}

coachRouter.get('/app/schedule', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await findCoachById(db, coachId);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const hasSchedule = await coachHasSchedule(db, coachId);
  if (!hasSchedule || req.query.setup === '1') {
    const code = typeof req.query.e === 'string' ? req.query.e : '';
    const notice = Object.hasOwn(SETUP_NOTICES, code) ? SETUP_NOTICES[code] : null;
    const draft = await getOpenDraft(db, coachId, new Date());
    const startText = draft ? '' : readStartText(req.headers.cookie);
    res.status(200).send(renderSetupScreen(coach, draft, notice, hasSchedule, startText));
    return;
  }
  const live = renderPageLinkCard(coach, {
    main: (await paymentsOpen(db, coach)) ? 'share' : 'payments',
    justPublished: req.query.published === '1',
  });
  const askCard = renderAskCard(await pendingAskForCoach(db, coachId));
  const cascadeCards = renderRunningCascades(await runningCascadesForCoach(db, coachId));
  const phoneState = typeof req.query.phone === 'string' ? req.query.phone : '';
  const phoneCard = coach.phone
    ? phoneState === 'done'
      ? html`<p class="muted">Texts about your sessions will go to ${coach.phone}.</p>`
      : (await hasActiveConsent(db, coach.phone))
        ? raw('')
        : renderTextsOnCard(phoneState)
    : renderAddPhoneCard(
        typeof req.query.phone === 'string' ? req.query.phone : '',
        typeof req.query.to === 'string' ? req.query.to : '',
      );
  const emailCard = renderConfirmEmailCard(coach, typeof req.query.email === 'string' ? req.query.email : '');
  const sessions = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
    capacity: number;
    price_cents: number;
    duration_min: number;
    booked: string;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, coalesce(s.capacity_override, st.capacity) as capacity, st.price_cents,
            st.duration_min,
            coalesce((select count(*) from booking b where b.session_id = s.id and b.status = 'booked'), 0)::text as booked
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
     order by s.starts_at_utc
     limit 50`,
    [coachId],
  );

  const assistant = await loadScheduleAssistant(db, coachId);

  res.status(200).send(
    page(
      'Schedule',
      html`<div class="screen-main">
          ${coachNav('schedule')}
          <h1>Coming up</h1>
          ${live}
          ${askCard}
          ${cascadeCards}
          ${phoneCard}
          ${emailCard}
          <p><a class="action ghost" href="/app/schedule?setup=1">Add more by talking</a></p>
          ${assistant.reply
            ? html`<div class="card ask-reply">
                <p>${assistant.reply.body}</p>
                ${assistant.livePendingId
                  ? html`<form class="btn-row" method="post" action="/app/schedule/confirm">
                      <input type="hidden" name="id" value="${assistant.livePendingId}" />
                      <button type="submit" name="answer" value="yes">Yes</button>
                      <button type="submit" name="answer" value="no" class="ghost">No</button>
                    </form>`
                  : raw('')}
              </div>`
            : raw('')}
          ${sessions.rows.length === 0
            ? html`<p class="muted">No sessions yet. Add a session type and its weekly times.</p>
                <a class="action" href="/app/session-types">Session types</a>`
            : sessions.rows.map(
                (s) =>
                  html`<a class="card" href="/app/sessions/${s.id}">
                    <strong>${formatLocal(s.starts_at_utc, s.tz)}</strong>
                    <div class="meta"><span>${formatTimeRange(s.starts_at_utc, s.duration_min, s.tz)} · ${s.name} · ${s.booked} of ${s.capacity} spots booked · ${formatCoachDollars(s.price_cents)}</span></div>
                  </a>`,
              )}
        </div>
        <div class="schedule-ask">
          <form method="post" action="/app/schedule/ask" onsubmit="this.querySelector('button[type=submit]').disabled=true;this.querySelector('button[type=submit]').textContent='Working…';">
            <label for="ask">Tell me what to change</label>
            <input id="ask" name="text" type="text" placeholder="Text the week. &quot;who's at 6pm&quot; or &quot;cancel tomorrow&quot;" />
            <button type="submit">Send</button>
          </form>
        </div>`,
    ),
  );
});

// ---- Screen 2 actions: the overflow question and adding a mobile ----

/** The overflow question (SPEC.md §7.3), the same one the text asks:
 * a second group, a backup coach, or not now. */
function renderAskCard(ask: PendingAsk | null) {
  if (!ask) return raw('');
  return html`<div class="card ask-reply overflow-ask">
    <p><strong>${ask.label} is full</strong> with ${ask.waiting} waiting. Open a second group, or add a backup coach? We'll ask your roster one at a time.</p>
    <form class="btn-row" method="post" action="/app/overflow/${ask.sessionId}">
      <button type="submit" name="answer" value="1">Second group</button>
      <button type="submit" name="answer" value="2" class="ghost">Backup coach</button>
      <button type="submit" name="answer" value="no" class="ghost">Not now</button>
    </form>
  </div>`;
}

const OVERFLOW_JOB: Record<RunningCascade['kind'], string> = {
  second_group: 'a second group',
  backup: 'a backup coach',
};

/** Where each cascade under way has got to. */
function renderRunningCascades(cascades: RunningCascade[]) {
  if (cascades.length === 0) return raw('');
  return html`${cascades.map(
    (c) => html`<div class="card overflow-running">
      <p>Asking your roster for ${OVERFLOW_JOB[c.kind]} for <strong>${c.label}</strong>.
        ${c.offeredTo ? `Offered to ${c.offeredTo.name} until ${clockInZone(c.offeredTo.expiresAt, c.tz)}.` : ''}</p>
      ${c.unreachable.length > 0
        ? html`<p class="muted">Not asked, because they can't get texts yet. Send each their link to opt in:</p>
            <ul class="unreachable">
              ${c.unreachable.map((u) => html`<li>${u.name} · <a href="${u.link}">${u.link}</a></li>`)}
            </ul>`
        : raw('')}
    </div>`,
  )}`;
}

/** "6:20 PM" in the session's zone. */
function clockInZone(isoUtc: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(isoUtc));
}

const OVERFLOW_ANSWERS: Record<string, OverflowAnswer> = { '1': 'second_group', '2': 'backup', no: 'no' };

const PHONE_NOTICES: Record<string, string> = {
  bad: 'Enter a US or Canadian mobile number.',
  capped: 'Too many codes for that number today. Try again tomorrow.',
  wrong: 'That code did not match. Try again.',
  used: 'That code had too many wrong tries. Ask for a new one.',
  slow: TOO_MANY_TRIES,
  wait: TOO_MANY_CODE_REQUESTS,
  busy: "We can't send texts right now. Try again in a few minutes.",
  failed: SEND_FAILED,
  taken: 'That number is already on another Coachatron account.',
  consent: 'Check the box to get texts from Coachatron.',
};

function phoneNotice(state: string): string | null {
  if (state === 'stopped') return optedOutNotice('first');
  return Object.hasOwn(PHONE_NOTICES, state) ? PHONE_NOTICES[state] : null;
}

/** For a coach who signed in with a mobile but left the box unchecked: the
 * same box, to turn on texts when a session fills. Until then those go by
 * email when there is one, and always wait on this screen. */
function renderTextsOnCard(state: string) {
  const notice = state === 'consent' ? PHONE_NOTICES.consent : null;
  return html`<div class="card">
    <p class="muted">Get a text when a session fills, and run your week by text.</p>
    <form method="post" action="/app/phone/consent">
      ${smsConsentCheckbox()}
      <button type="submit" class="ghost">Turn on texts</button>
    </form>
    ${notice ? html`<p class="error">${notice}</p>` : raw('')}
  </div>`;
}

/** For a coach who joined by email: add a mobile to get texts when a
 * session fills, and to run the week by text. Verified with a text code. */
function renderAddPhoneCard(state: string, to: string) {
  const notice = phoneNotice(state);
  const parsed = to ? normalizePhone(to) : null;
  if ((state === 'sent' || state === 'wrong' || state === 'slow') && parsed) {
    return html`<div class="card">
      <p>We texted a code to ${parsed}.</p>
      <form method="post" action="/app/phone/verify">
        <input type="hidden" name="phone" value="${parsed}" />
        <label for="phone-code">Code</label>
        <input id="phone-code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
        <button type="submit" class="ghost">Add this mobile</button>
      </form>
      ${notice ? html`<p class="error">${notice}</p>` : raw('')}
    </div>`;
  }
  return html`<div class="card">
    <p class="muted">Get a text when a session fills, and run your week by text.</p>
    <form method="post" action="/app/phone">
      <label for="add-phone">Your mobile (US or Canada)</label>
      <input id="add-phone" name="phone" type="tel" autocomplete="tel" placeholder="(555) 555-0100" required />
      ${smsConsentCheckbox()}
      <button type="submit" class="ghost">Send code</button>
    </form>
    ${notice ? html`<p class="error">${notice}</p>` : raw('')}
  </div>`;
}

const EMAIL_NOTICES: Record<string, string> = {
  wrong: 'That code did not match. Try again.',
  used: 'That code had too many wrong tries. Ask for a new one.',
  slow: TOO_MANY_TRIES,
  wait: TOO_MANY_CODE_REQUESTS,
  capped: 'Too many codes for that email today. Try again tomorrow.',
  busy: "We can't send email right now. Try again in a few minutes.",
  failed: SEND_FAILED,
};

/** For a coach whose email was typed, not proved: a code by email makes
 * it a way to sign in. Until then only the mobile signs in. */
function renderConfirmEmailCard(coach: CoachRow, state: string) {
  if (state === 'done' && coach.email_verified) {
    return html`<p class="muted">You can sign in with ${coach.email} too.</p>`;
  }
  if (!coach.email || coach.email_verified) return raw('');
  const notice = Object.hasOwn(EMAIL_NOTICES, state) ? EMAIL_NOTICES[state] : null;
  if (state === 'sent' || state === 'wrong' || state === 'slow') {
    return html`<div class="card">
      <p>We emailed a code to ${coach.email}.</p>
      <form method="post" action="/app/email/verify">
        <label for="email-code">Code</label>
        <input id="email-code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
        <button type="submit" class="ghost">Confirm email</button>
      </form>
      ${notice ? html`<p class="error">${notice}</p>` : raw('')}
    </div>`;
  }
  return html`<div class="card">
    <p class="muted">Confirm ${coach.email} to sign in with it too.</p>
    <form method="post" action="/app/email">
      <button type="submit" class="ghost">Email me a code</button>
    </form>
    ${notice ? html`<p class="error">${notice}</p>` : raw('')}
  </div>`;
}

coachRouter.post('/app/email', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach?.email || coach.email_verified) {
    res.redirect(303, '/app/schedule');
    return;
  }
  if (!(await takeRequest(db, SIGNIN_CODE_LIMITS, clientKey(req)))) {
    res.redirect(303, '/app/schedule?email=wait');
    return;
  }
  const outcome = await sendCode(db, { kind: 'email', email: coach.email }, { coachId: coach.id, smsConsent: false });
  res.redirect(303, `/app/schedule?email=${outcome === 'refused' ? 'failed' : outcome}`);
});

coachRouter.post('/app/email/verify', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach?.email || coach.email_verified) {
    res.redirect(303, '/app/schedule');
    return;
  }
  const contact: Contact = { kind: 'email', email: coach.email };
  if (!(await takeCodeCheck(db, req, contact))) {
    res.redirect(303, '/app/schedule?email=slow');
    return;
  }
  const check = await checkOtp(db, contact, field(req.body, 'code'));
  if (!check.ok) {
    res.redirect(303, `/app/schedule?email=${check.reason === 'used-up' ? 'used' : 'wrong'}`);
    return;
  }
  if (!(await consumeOtp(db, check.id))) {
    res.redirect(303, '/app/schedule?email=wrong');
    return;
  }
  await markEmailVerified(db, coach.id, coach.email);
  res.redirect(303, '/app/schedule?email=done');
});

coachRouter.post('/app/overflow/:sessionId', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const answer = field(req.body, 'answer');
  const sessionId = Number(req.params.sessionId);
  if (Object.hasOwn(OVERFLOW_ANSWERS, answer) && Number.isInteger(sessionId)) {
    await answerAsk(db, coachId, OVERFLOW_ANSWERS[answer], sessionId);
  }
  res.redirect(303, '/app/schedule');
});

coachRouter.post('/app/phone', requireAuth, async (req, res) => {
  const db = getDb();
  const phone = normalizePhone(field(req.body, 'phone'));
  if (!phone || !canText(phone)) {
    res.redirect(303, '/app/schedule?phone=bad');
    return;
  }
  if (!smsConsentChecked(req.body)) {
    res.redirect(303, '/app/schedule?phone=consent');
    return;
  }
  if (!(await takeRequest(db, SIGNIN_CODE_LIMITS, clientKey(req)))) {
    res.redirect(303, '/app/schedule?phone=wait');
    return;
  }
  if (await isOptedOut(db, phone)) {
    res.redirect(303, '/app/schedule?phone=stopped');
    return;
  }
  // The ticked box is recorded once the code proves the number.
  const outcome = await sendCode(db, { kind: 'phone', phone }, {
    coachId: res.locals.coachId as number,
    smsConsent: true,
    text: (code) => `Coachatron: your code to add this mobile is ${code}. Expires in 10 minutes.`,
  });
  if (outcome !== 'sent') {
    res.redirect(303, `/app/schedule?phone=${outcome === 'refused' ? 'stopped' : outcome}`);
    return;
  }
  res.redirect(303, `/app/schedule?phone=sent&to=${encodeURIComponent(phone)}`);
});

coachRouter.post('/app/phone/consent', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach?.phone) {
    res.redirect(303, '/app/schedule');
    return;
  }
  if (!smsConsentChecked(req.body)) {
    res.redirect(303, '/app/schedule?phone=consent');
    return;
  }
  // The coach's own number, proved when it was added to the account.
  await recordConsent(db, coach.phone, '/app/phone/consent', { ...consentMeta(req), numberVerified: true });
  res.redirect(303, '/app/schedule?phone=done');
});

coachRouter.post('/app/phone/verify', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const phone = normalizePhone(field(req.body, 'phone'));
  if (!phone) {
    res.redirect(303, '/app/schedule?phone=bad');
    return;
  }
  const contact: Contact = { kind: 'phone', phone };
  if (!(await takeCodeCheck(db, req, contact))) {
    res.redirect(303, `/app/schedule?phone=slow&to=${encodeURIComponent(phone)}`);
    return;
  }
  const check = await checkOtp(db, contact, field(req.body, 'code'));
  if (!check.ok) {
    res.redirect(303, check.reason === 'used-up' ? '/app/schedule?phone=used' : `/app/schedule?phone=wrong&to=${encodeURIComponent(phone)}`);
    return;
  }
  if (!(await consumeOtp(db, check.id))) {
    res.redirect(303, `/app/schedule?phone=wrong&to=${encodeURIComponent(phone)}`);
    return;
  }
  const result = await setCoachPhone(db, coachId, phone);
  if (result === 'taken') {
    res.redirect(303, '/app/schedule?phone=taken');
    return;
  }
  if (check.smsConsent) await recordCodeConsent(db, req, phone, '/app/phone');
  res.redirect(303, '/app/schedule?phone=done');
});

coachRouter.post('/app/setup', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const text = field(req.body, 'text');
  if (!text) {
    res.redirect(303, '/app/schedule?setup=1');
    return;
  }
  const result = await handleSetupMessage(db, coach, text, 'web');
  const error = result.kind === 'cap' ? '&e=cap' : result.kind === 'error' ? '&e=read' : '';
  res.redirect(303, `/app/schedule?setup=1${error}`);
});

coachRouter.post('/app/setup/publish', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const counts = await publishSetupPlan(db, coach, rowId(field(req.body, 'id')) ?? 0);
  if (counts) await notePublished(db, (await findCoachById(db, coach.id)) ?? coach);
  res.redirect(303, counts ? '/app/schedule?published=1' : '/app/schedule?setup=1&e=stale');
});

coachRouter.post('/app/setup/discard', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  await discardDraft(db, coachId, rowId(field(req.body, 'id')) ?? 0);
  res.redirect(303, '/app/schedule?setup=1');
});

coachRouter.post('/app/schedule/ask', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await findCoachById(db, coachId);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const text = field(req.body, 'text');
  if (text) {
    await handleCoachMessage(db, coach, text, 'web');
  }
  res.redirect(303, '/app/schedule');
});

coachRouter.post('/app/schedule/confirm', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await findCoachById(db, coachId);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const pendingId = rowId(field(req.body, 'id')) ?? 0;
  const yes = field(req.body, 'answer') === 'yes';
  if (Number.isInteger(pendingId) && pendingId > 0) {
    await resolvePendingForCoach(db, coach, pendingId, yes);
  }
  res.redirect(303, '/app/schedule');
});

// ---- Screen 3: session detail (M5 session management) ----

async function loadSessionForCoach(db: DbClient, coachId: number, sessionId: number): Promise<{
  id: number;
  starts_at_utc: string;
  tz: string;
  name: string;
  status: string;
} | null> {
  const result = await db.query<{ id: number; starts_at_utc: string; tz: string; name: string; status: string }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, s.status
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2`,
    [sessionId, coachId],
  );
  return result.rows[0] ?? null;
}

coachRouter.get('/app/sessions/:id', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);
  
  const session = await loadSessionForCoach(db, coachId, sessionId);
  if (!session) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  
  // The session's bookings. A pending one is a parent at checkout: it is
  // listed while its hold on the spot stands, and left out once the hold
  // has run out, or when it has no hold time (made before holds existed).
  const bookings = await db.query<SessionBooking>(
    `select b.id, b.athlete_name, b.status, b.manage_token, b.late_cancel, b.waived_at, b.payment_source, b.gross_cents, b.charge_id,
            b.credit_id, b.hold_expires_at, ${CREDIT_WITHDRAWN_SQL}
     from booking b
     where b.session_id = $1 and (b.status <> 'pending' or b.hold_expires_at > now())
     order by b.id`,
    [sessionId],
  );
  const booked = bookings.rows.filter((b) => SOLD_STATUSES.has(b.status)).length;
  const holding = bookings.rows.filter((b) => b.status === 'pending').length;
  const moves = await sessionMoves(db, sessionId);
  const refunds = await refundsByPayment(
    db,
    bookings.rows.flatMap((b) => (b.charge_id ? [b.charge_id] : [])),
  );
  const refundable = new Map<number, Refundability>();
  for (const b of bookings.rows) {
    if ((b.charge_id && (b.gross_cents ?? 0) > 0) || b.credit_id !== null) {
      refundable.set(b.id, await checkRefund(db, coachId, { bookingId: b.id }));
    }
  }
  
  const reach = session.status === 'cancelled' ? await cancelReach(db, sessionId) : null;
  const confirmId = Number(typeof req.query.refund === 'string' ? req.query.refund : '');
  const confirm =
    Number.isInteger(confirmId) && confirmId > 0 && bookings.rows.some((b) => b.id === confirmId)
      ? await checkRefund(db, coachId, { bookingId: confirmId })
      : null;
  const notice = refundNotice(req.query.notice);

  res.status(200).send(
    page(
      session.name,
      html`${coachNav('schedule')}
        <h1>${session.name}</h1>
        <p class="muted">${formatLocal(session.starts_at_utc, session.tz)}</p>
        ${notice ? html`<div class="card"><p>${notice}</p></div>` : raw('')}
        ${confirm
          ? renderRefundConfirm(confirm, {
              action: `/app/sessions/${sessionId}/bookings/${confirmId}/refund`,
              keepHref: `/app/sessions/${sessionId}`,
            })
          : raw('')}
        ${reach ? renderCancelReach(reach) : raw('')}
        
        <h2>Booked (${booked})${holding > 0 ? ` · Holding (${holding})` : ''}</h2>
        ${bookings.rows.length === 0 && moves.out.length === 0
          ? html`<p class="muted">No bookings yet.</p>`
          : html`<ul>
              ${bookings.rows.map((b) => {
                return html`<li class="card">
                  <strong>${b.athlete_name}</strong> — 
                  ${bookingStatusLabel(b, session.tz)}
                  ${movedHereNote(moves.into.get(b.id))}
                  ${b.waived_at
                    ? html`<p class="muted">Credit given back.</p>`
                    : canWaive(b)
                      ? html`<form method="post" action="/app/sessions/${sessionId}/bookings/${b.id}/waive">
                          <p class="muted">The credit was used${b.status === 'noshow' ? ' (no-show)' : ' (cancelled inside your window)'}.</p>
                          <button type="submit" class="ghost">Give the credit back</button>
                        </form>`
                      : raw('')}
                  ${b.status === 'booked' ? html`
                    <form method="post" action="/app/sessions/${sessionId}/bookings/${b.id}/attendance">
                      <label><input type="radio" name="status" value="attended" checked /> Attended</label>
                      <label><input type="radio" name="status" value="noshow" /> No-show</label>
                      <button type="submit">Mark attendance</button>
                    </form>
                  ` : raw('')}
                  ${renderBookingPayment(b, refunds, refundable.get(b.id) ?? null, `/app/sessions/${sessionId}?refund=${b.id}#refund`)}
                </li>`;
              })}
              ${moves.out.map(
                (m) => html`<li class="card">
                  <strong>${m.athlete_name}</strong> — <span class="muted">Moved to ${formatLocal(m.starts_at_utc, m.tz)}</span>
                </li>`,
              )}
            </ul>`}
        
        <h2>Action</h2>
        ${session.status === 'scheduled' && new Date(session.starts_at_utc) >= new Date()
          ? html`<a class="action" href="/app/sessions/${sessionId}/cancel">Cancel session</a>`
          : raw('')}
        
        <a class="action" href="/app/schedule">Back to schedule</a>`,
    ),
  );
});

interface MoveRow {
  booking_id: number;
  athlete_name: string;
  starts_at_utc: string;
  tz: string;
}

/** Bookings a parent moved out of this session from their manage page and
 * that are not back in it, each once with the time of the session it is in
 * now, and where each booking moved into it last came from (SPEC.md §7.2).
 * Screen 3 lists them the way it lists a parent's cancel. */
async function sessionMoves(db: DbClient, sessionId: number): Promise<{ out: MoveRow[]; into: Map<number, MoveRow> }> {
  const out = await db.query<MoveRow>(
    `select booking_id, athlete_name, starts_at_utc, tz from (
       select distinct on (m.booking_id) m.id, m.booking_id, b.athlete_name, t.starts_at_utc, t.tz
       from booking_move m join booking b on b.id = m.booking_id join session t on t.id = b.session_id
       where m.from_session_id = $1 and b.session_id <> $1
       order by m.booking_id, m.id desc
     ) latest
     order by id`,
    [sessionId],
  );
  const into = await db.query<MoveRow>(
    `select distinct on (m.booking_id) m.booking_id, b.athlete_name, f.starts_at_utc, f.tz
     from booking_move m join booking b on b.id = m.booking_id join session f on f.id = m.from_session_id
     where m.to_session_id = $1
     order by m.booking_id, m.id desc`,
    [sessionId],
  );
  return { out: out.rows, into: new Map(into.rows.map((r) => [r.booking_id, r])) };
}

function movedHereNote(from: MoveRow | undefined) {
  return from ? html`<p class="muted">Moved here by the parent from ${formatLocal(from.starts_at_utc, from.tz)}.</p>` : raw('');
}

/** Bookings that were sold and still hold their spot: "Booked (N)" on
 * screen 3. */
const SOLD_STATUSES = new Set(['booked', 'attended', 'noshow']);

/** What screen 3 says of a booking, in words, never its raw status. A
 * pending booking is listed only while its hold stands. */
function bookingStatusLabel(b: Pick<SessionBooking, 'status' | 'late_cancel' | 'hold_expires_at'>, tz: string): SafeHtml {
  switch (b.status) {
    case 'booked':
      return html`<span>Ready to mark</span>`;
    case 'attended':
      return html`<span class="good">Attended</span>`;
    case 'noshow':
      return html`<span class="alert">No-show</span>`;
    case 'cancelled':
      return html`<span class="muted">${b.late_cancel ? 'Cancelled late' : 'Cancelled'}</span>`;
    case 'refunded':
      return html`<span class="muted">Refunded</span>`;
    case 'pending':
      return b.hold_expires_at
        ? html`<span class="muted">Holding — not paid yet (until ${formatClockLocal(b.hold_expires_at, tz)})</span>`
        : raw('');
    default:
      return raw('');
  }
}

interface SessionBooking {
  id: number;
  athlete_name: string;
  status: string;
  /** While a pending booking holds its spot. */
  hold_expires_at: string | Date | null;
  manage_token: string;
  late_cancel: boolean;
  waived_at: string | null;
  credit_withdrawn: boolean;
  payment_source: string | null;
  gross_cents: number | null;
  charge_id: string | null;
  credit_id: number | null;
}

/** A paid booking's payment on screen 3: what was paid, and its refund,
 * the Refund link, or why it cannot be refunded here. A booking paid with a
 * session credit points to the payment the credit came from. */
function renderBookingPayment(
  b: Pick<SessionBooking, 'payment_source' | 'gross_cents' | 'charge_id'>,
  refunds: Map<string, RefundRow>,
  check: Refundability | null,
  refundHref: string,
) {
  if (!b.charge_id || (b.gross_cents ?? 0) <= 0) {
    if (check && !check.ok && check.block.kind === 'paid_with_credit') {
      return html`<p class="muted">${describeRefundBlock(check.block)}</p>
        ${creditPurchaseLink(check.block)}`;
    }
    return raw('');
  }
  const paid = `Paid ${formatCoachDollars(b.gross_cents ?? 0)} · ${purchaseLabel(b.payment_source)}`;
  const refund = refunds.get(b.charge_id);
  if (refund && !canTryAgain(refund)) {
    return html`<p class="muted">${paid} · ${refundLabel(refund)}</p>`;
  }
  if (check && !check.ok) {
    return html`<p class="muted">${paid}${refund ? ` · ${refundLabel(refund)}` : ''}. ${describeRefundBlock(check.block)}</p>`;
  }
  return html`<p class="muted">${paid}${refund ? ` · ${refundLabel(refund)}` : ''}</p>
    <a class="action ghost" href="${refundHref}">${refund ? 'Try the refund again' : 'Refund'}</a>`;
}

/** A link to the payment a session credit came from, on Money (screen 7). */
function creditPurchaseLink(block: Extract<RefundBlock, { kind: 'paid_with_credit' }>) {
  return block.purchaseBookingId === null
    ? raw('')
    : html`<a class="action ghost" href="/app/money?refund=b${block.purchaseBookingId}#refund">See the payment the credit came from</a>`;
}

const PLAN_KIND: Record<string, string> = {
  'drop-in': 'drop-in',
  package: 'package',
  pack: 'one-time pack',
  'kept-payment': 'payment',
};

/** The step before a refund is sent (screens 3 and 7): what it refunds and
 * what else it changes, or why this payment cannot be refunded here. */
function renderRefundConfirm(check: Refundability, opts: { action: string; keepHref: string; hidden?: Record<string, string> }) {
  if (!check.ok) {
    return html`<div class="card" id="refund">
      <p><strong>Refund</strong></p>
      <p>${describeRefundBlock(check.block)}</p>
      ${check.block.kind === 'paid_with_credit' ? creditPurchaseLink(check.block) : raw('')}
      <a class="action ghost" href="${opts.keepHref}">Back</a>
    </div>`;
  }
  const plan = check.plan;
  const amount = plan.amountCents === null ? 'this payment' : formatCoachDollars(plan.amountCents);
  const who = plan.athleteName ?? 'the parent';
  const what =
    plan.sessionName && plan.startsAtUtc && plan.tz
      ? `${who} · ${PLAN_KIND[plan.kind]} · ${plan.sessionName}, ${formatLocal(plan.startsAtUtc, plan.tz)}`
      : `${who} · ${PLAN_KIND[plan.kind]}`;
  const effects: string[] = [];
  if (plan.releasesBooking) {
    // A payment for several children ends each of their bookings that stands.
    const whose = plan.endsFor.length > 0 ? namesList(plan.endsFor) : who;
    const several = plan.endsFor.length > 1;
    const bookings = several ? 'bookings are' : 'booking is';
    effects.push(
      plan.sessionStarted
        ? `${whose}'s ${bookings} marked refunded.`
        : `${whose}'s ${bookings} cancelled and the ${several ? 'spots are' : 'spot is'} free again.`,
    );
  } else if (plan.bookingStatus === 'cancelled' && plan.creditsWithdrawn === 0) {
    effects.push(`${who}'s booking was already cancelled, so nothing else changes.`);
  }
  if (plan.creditsWithdrawn > 0) {
    effects.push(`The ${plan.creditsWithdrawn} unused session ${plan.creditsWithdrawn === 1 ? 'credit' : 'credits'} it bought ${plan.creditsWithdrawn === 1 ? 'is' : 'are'} withdrawn.`);
  }
  if (plan.kind === 'kept-payment') effects.push('This payment booked nothing, so nothing else changes.');
  effects.push(`The whole ${amount} goes back to the card it came from. Coachatron's ${APP_FEE_BPS / 100}% fee is returned with it; Stripe keeps its card processing fee.`);
  effects.push(
    plan.reachable
      ? 'The parent is told by text if they chose texts, and by email if they gave one.'
      : 'We have no way to reach this parent, so please tell them yourself.',
  );
  return html`<div class="card" id="refund">
    <p><strong>Refund ${amount}?</strong></p>
    <p class="muted">${what}</p>
    <ul class="muted">
      ${effects.map((e) => html`<li>${e}</li>`)}
    </ul>
    <form method="post" action="${opts.action}">
      ${Object.entries(opts.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`)}
      <div class="btn-row">
        <button type="submit" class="action danger">Confirm refund</button>
        <a class="action ghost" href="${opts.keepHref}">Keep payment</a>
      </div>
    </form>
  </div>`;
}

const REFUND_NOTICES: Record<string, string> = {
  'refund-refunded': 'Refunded.',
  'refund-pending': 'Refund sent. Stripe confirms it shortly.',
  'refund-failed': 'The refund did not go through. See the payment below.',
  'refund-unavailable': 'Payments did not answer. Try again in a minute: the refund will not be made twice.',
  'refund-blocked': 'This payment cannot be refunded again here.',
};

function refundNotice(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(REFUND_NOTICES, value) ? REFUND_NOTICES[value] : null;
}

function refundOutcomeNotice(outcome: RefundRequestOutcome): string {
  return `refund-${outcome.kind}`;
}

const UNREACHED_REASON: Record<CancelReach['unreached'][number]['reason'], string> = {
  'no-texts': 'has not opted in to texts',
  'not-sent': 'text not sent (daily limit)',
  failed: 'text failed to send',
};

/** The cancel's confirmation on screen 3: how many parents were texted or
 * emailed, and who still needs to be told by the coach. */
function renderCancelReach(reach: CancelReach) {
  const parents = reach.athletesTotal === 1 ? 'parent' : 'parents';
  const credits = reach.creditsReturned === 1 ? 'credit' : 'credits';
  if (reach.athletesTotal === 0) return html`<div class="card cancel-reach"><p><strong>Cancelled.</strong></p></div>`;
  return html`<div class="card cancel-reach">
    <p><strong>Cancelled.</strong> Texted ${reach.athletesNotified}${reach.athletesEmailed > 0 ? ` and emailed ${reach.athletesEmailed}` : ''} of ${reach.athletesTotal} ${parents}. ${reach.creditsReturned} ${credits} returned${dropInCreditNote(reach)}.</p>
    ${reach.unreached.length > 0
      ? html`<p class="error">Not reached — please contact them yourself:</p>
          <ul class="unreached">
            ${reach.unreached.map(
              (u) => html`<li>${u.athleteName} · <a href="tel:${u.contactPhone}">${u.contactPhone}</a> · ${UNREACHED_REASON[u.reason]}</li>`,
            )}
          </ul>`
      : raw('')}
  </div>`;
}

coachRouter.post('/app/sessions/:id/bookings/:bookingId/refund', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  const sessionId = Number(req.params.id);
  const bookingId = Number(req.params.bookingId);
  const session = coach ? await loadSessionForCoach(db, coach.id, sessionId) : null;
  const inSession = session
    ? await db.query<{ id: number }>('select id from booking where id = $1 and session_id = $2', [bookingId, sessionId])
    : null;
  if (!coach || !session || !inSession || inSession.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const outcome = await requestRefund(db, coach, { bookingId });
  if (outcome.kind === 'blocked') {
    res.redirect(303, `/app/sessions/${sessionId}?refund=${bookingId}#refund`);
    return;
  }
  res.redirect(303, `/app/sessions/${sessionId}?notice=${refundOutcomeNotice(outcome)}`);
});

coachRouter.post('/app/sessions/:id/bookings/:bookingId/attendance', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);
  const bookingId = Number(req.params.bookingId);
  
  // Verify session belongs to this coach
  const session = await loadSessionForCoach(db, coachId, sessionId);
  if (!session) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  
  const status = field(req.body, 'status');
  if (status !== 'attended' && status !== 'noshow') {
    res.status(422).send(page('Error', html`<h1>Invalid status</h1>`));
    return;
  }

  await db.query(
    `update booking set status = $1 where id = $2 and session_id = $3 and status = 'booked'`,
    [status, bookingId, sessionId],
  );

  res.redirect(303, `/app/sessions/${sessionId}`);
});

// A no-show or a late cancel uses the booking's credit (SPEC.md §9.5); the
// coach can give it back, once.
coachRouter.post('/app/sessions/:id/bookings/:bookingId/waive', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(sessionId) || !Number.isInteger(bookingId) || !(await loadSessionForCoach(db, coachId, sessionId))) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  await waiveBooking(db, coachId, sessionId, bookingId);
  res.redirect(303, `/app/sessions/${sessionId}`);
});

coachRouter.get('/app/sessions/:id/cancel', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);

  const session = await loadSessionForCoach(db, coachId, sessionId);
  if (!session) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  if (session.status === 'cancelled') {
    res.redirect(303, '/app/schedule');
    return;
  }
  if (new Date(session.starts_at_utc) < new Date()) {
    res.status(409).send(
      page('Cannot cancel', html`<h1>Session already started</h1>
        <p class="error">This session has already passed and cannot be cancelled.</p>
        <a class="action" href="/app/sessions/${sessionId}">Back to session detail</a>`),
    );
    return;
  }

  const preview = await previewSessionCancel(db, sessionId);
  const when = formatLocal(session.starts_at_utc, session.tz);
  const untextable = preview.total - preview.textable;
  res.status(200).send(
    page(
      'Cancel session',
      html`${coachNav('schedule')}
        <h1>Cancel session</h1>
        <p>Cancel ${when}? ${preview.textable} ${preview.textable === 1 ? 'athlete' : 'athletes'} will get a text.</p>
        ${untextable > 0
          ? html`<p class="muted">${untextable} ${untextable === 1 ? 'parent has' : 'parents have'} not opted in to texts${preview.emailable > 0
              ? `; ${preview.emailable} will get an email instead`
              : ''}. You'll see who to contact after you cancel.</p>`
          : raw('')}
        <form method="post" action="/app/sessions/${sessionId}/cancel">
          <div class="btn-row">
            <button type="submit" class="action danger">Confirm cancel</button>
            <a class="action ghost" href="/app/sessions/${sessionId}">Keep session</a>
          </div>
        </form>`,
    ),
  );
});

coachRouter.post('/app/sessions/:id/cancel', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);

  const session = await loadSessionForCoach(db, coachId, sessionId);
  if (!session) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }

  const result = await cancelScheduledSession(db, coachId, sessionId);
  if (result.kind === 'not_found') {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  if (result.kind === 'already_started') {
    res.status(409).send(
      page('Cannot cancel', html`<h1>Session already started</h1>
        <p class="error">This session has already passed and cannot be cancelled.</p>
        <a class="action" href="/app/sessions/${sessionId}">Back to session detail</a>`),
    );
    return;
  }

  // The session screen shows who was texted and who was not reached.
  res.redirect(303, `/app/sessions/${sessionId}`);
});

// ---- Screen 5: pricing (packages and plans) ----

/** The booking policy on the Pricing screen (SPEC.md §9.5): what each
 * rule does now, and a form to change the two numbers. */
function renderPolicySection(policy: BookingPolicy, error?: string) {
  const hours = policy.cancelWindowHours;
  const window = hours === 0 ? 'up to the start' : `more than ${hours} ${hours === 1 ? 'hour' : 'hours'} before a session`;
  const children = policy.childrenPerBooking;
  return html`<h2 id="policy">Booking policy</h2>
    <div class="card policy">
      <p><strong>No-show:</strong> the booking's credit is used. You can give it back on the session's screen.</p>
      <p><strong>Cancelling:</strong> a parent who cancels ${window} gets their credit back (a paid drop-in becomes a session credit).${hours === 0
        ? ''
        : ` Inside ${hours} ${hours === 1 ? 'hour' : 'hours'} it counts as a no-show, and you can give it back.`}</p>
      <p><strong>Children:</strong> a parent can book up to ${children} ${children === 1 ? 'child' : 'children'} at once. Each takes a spot and uses a credit or a drop-in.</p>
      <p class="muted">Card refunds are separate: they go through Coachatron support.</p>
    </div>
    <details${error ? raw(' open') : raw('')}>
      <summary>Change the policy</summary>
      <form method="post" action="/app/pricing/policy">
        <label for="cancel_window_hours">Cancellation window (hours before a session)</label>
        <input id="cancel_window_hours" name="cancel_window_hours" type="number" min="0" max="${MAX_CANCEL_WINDOW_HOURS}" required value="${hours}" />
        <label for="children_per_booking">Children per booking</label>
        <input id="children_per_booking" name="children_per_booking" type="number" min="1" max="${MAX_CHILDREN_PER_BOOKING}" required value="${children}" />
        <button type="submit">Save policy</button>
      </form>
      ${error ? html`<p class="error">${error}</p>` : raw('')}
    </details>`;
}

coachRouter.get('/app/pricing', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const packagesList = await getPackagesForCoach(db, coachId);
  const plansList = await getPlansForCoach(db, coachId);
  const policy = await getBookingPolicy(db, coachId);

  res.status(200).send(
    page(
      'Pricing',
      html`${coachNav('pricing')}
        <h1>Pricing & credits</h1>
        <h2>Session packages</h2>
        ${packagesList.length === 0
          ? html`<p class="muted">No packages yet.</p>`
          : packagesList.map((p) => {
              const expiry = p.expires_days ? ` · Expires after ${p.expires_days} days` : '';
              return html`<div class="card">${p.name} · ${formatCoachDollars(p.price_cents)}${expiry}</div>`;
            })}
        <details>
          <summary>+ New package</summary>
          <form method="post" action="/app/pricing/package">
            <label for="pkg_name">Package name</label>
            <input id="pkg_name" name="name" required placeholder="e.g. 10-session pack" />
            <label for="pkg_credits">Number of sessions</label>
            <input id="pkg_credits" name="credits" type="number" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 10" />
            <label for="pkg_price_dollars">Price (dollars)</label>
            <input id="pkg_price_dollars" name="price_dollars" type="number" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 150" />
            <label for="pkg_expires_days">Expires after days (optional)</label>
            <input id="pkg_expires_days" name="expires_days" type="number" min="${LIMITS.expiresDays.min}" max="${LIMITS.expiresDays.max}" placeholder="e.g. 60" />
            <button type="submit">Create package</button>
          </form>
        </details>

        <h2>One-time packs</h2>
        <p class="muted">Charged once. The sessions do not expire.</p>
        ${plansList.length === 0
          ? html`<p class="muted">No one-time packs yet.</p>`
          : plansList.map(
              (p) =>
                html`<div class="card">${p.name} · ${formatCoachDollars(p.price_cents)} · ${p.credits_per_month} ${p.credits_per_month === 1 ? 'session' : 'sessions'}, one-time</div>`,
            )}
        <details>
          <summary>+ New one-time pack</summary>
          <form method="post" action="/app/pricing/plan">
            <label for="plan_name">Pack name</label>
            <input id="plan_name" name="name" required placeholder="e.g. 4-session pack" />
            <label for="plan_price_dollars">Price (dollars)</label>
            <input id="plan_price_dollars" name="price_dollars" type="number" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 120" />
            <label for="plan_credits">Sessions in the pack</label>
            <input id="plan_credits" name="credits_per_month" type="number" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 4" />
            <button type="submit">Create pack</button>
          </form>
        </details>
        ${renderPolicySection(policy)}`,
    ),
  );
});

coachRouter.post('/app/pricing/policy', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const policy = parseBookingPolicy(field(req.body, 'cancel_window_hours'), field(req.body, 'children_per_booking'));
  if (!policy) {
    res.status(422).send(
      page(
        'Pricing',
        html`${coachNav('pricing')}
          <h1>Pricing & credits</h1>
          ${renderPolicySection(
            await getBookingPolicy(db, coachId),
            `Use a window of 0 to ${MAX_CANCEL_WINDOW_HOURS} hours and 1 to ${MAX_CHILDREN_PER_BOOKING} children.`,
          )}
          <a class="action ghost" href="/app/pricing">Back</a>`,
      ),
    );
    return;
  }
  await setBookingPolicy(db, coachId, policy);
  res.redirect(303, '/app/pricing#policy');
});

coachRouter.post('/app/pricing/package', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const name = field(req.body, 'name');
  const credits = wholeNumber(field(req.body, 'credits'), LIMITS.credits);
  const priceCents = dollarsToCents(field(req.body, 'price_dollars'), LIMITS.priceCents);
  const expiresDaysRaw = field(req.body, 'expires_days');
  const expiresDays = expiresDaysRaw ? wholeNumber(expiresDaysRaw, LIMITS.expiresDays) : undefined;

  if (!name || credits === null || priceCents === null || expiresDays === null) {
    res.status(422).send(
      page(
        'Pricing',
        html`<h1>Pricing & credits</h1>
          <p class="error">Fill in the package: ${LIMITS.credits.min}–${LIMITS.credits.max} sessions, a price up to ${formatCoachDollars(LIMITS.priceCents.max)}, and, if it expires, ${LIMITS.expiresDays.min}–${LIMITS.expiresDays.max} days.</p>
          <a class="action" href="/app/pricing">Back</a>`,
      ),
    );
    return;
  }

  await createPackage(db, coachId, name, credits, priceCents, expiresDays);
  res.redirect(303, '/app/pricing');
});

coachRouter.post('/app/pricing/plan', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const name = field(req.body, 'name');
  const priceCents = dollarsToCents(field(req.body, 'price_dollars'), LIMITS.priceCents);
  const creditsPerMonth = wholeNumber(field(req.body, 'credits_per_month'), LIMITS.credits);

  if (!name || creditsPerMonth === null || priceCents === null) {
    res.status(422).send(
      page(
        'Pricing',
        html`<h1>Pricing & credits</h1>
          <p class="error">Fill in the pack: a price up to ${formatCoachDollars(LIMITS.priceCents.max)} and ${LIMITS.credits.min}–${LIMITS.credits.max} sessions.</p>
          <a class="action" href="/app/pricing">Back</a>`,
      ),
    );
    return;
  }

  await createPlan(db, coachId, name, priceCents, creditsPerMonth);
  res.redirect(303, '/app/pricing');
});

// ---- Screen 6: roster (M4 overflow cascade) ----

coachRouter.get('/app/roster', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const members = await listRosterMembers(db, coachId);
  const consented = new Set<string>();
  const optInLinks = new Map<number, string>();
  for (const m of members) {
    if (await hasActiveConsent(db, m.phone)) consented.add(m.phone);
    else optInLinks.set(m.id, await rosterOptInLink(db, m.id));
  }

  res.status(200).send(
    page(
      'Roster',
      html`${coachNav('roster')}
        <h1>Overflow roster</h1>
        ${members.length === 0
          ? html`<p class="muted">No roster members yet.</p>`
          : html`<ul class="roster-list">
              ${members.map(
                (m) =>
                  html`<li class="card">
                    <div class="row"><span>${m.name}</span><span class="muted">${m.phone}</span></div>
                    ${consented.has(m.phone)
                      ? html`<p class="muted">Texts on</p>`
                      : html`<p class="muted">Not opted in yet: no offers until they do. Send them their link to opt in:</p>
                          <p class="optin-link"><a href="${optInLinks.get(m.id) ?? ''}">${optInLinks.get(m.id) ?? ''}</a></p>`}
                    <form class="roster-priority-form" method="post" action="/app/roster/${m.id}/priority">
                      <input type="number" name="priority" value="${m.priority}" min="${LIMITS.rosterPriority.min}" max="${LIMITS.rosterPriority.max}" required aria-label="Priority for ${m.name}" />
                      <button type="submit">Update priority</button>
                    </form>
                  </li>`,
              )}
            </ul>`}
        <h2>Add member</h2>
        <form method="post" action="/app/roster">
          <label for="name">Name</label>
          <input id="name" name="name" required />
          <label for="phone">Phone</label>
          <input id="phone" name="phone" type="tel" required />
          <button type="submit">Add to roster</button>
        </form>
        <p class="muted">We don't text the people you add. Send each one their opt-in link. Offers go only to people who have opted in.</p>`,
    ),
  );
});

coachRouter.post('/app/roster', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const name = field(_req.body, 'name');
  const phone = normalizePhone(field(_req.body, 'phone'));

  if (!name || !phone) {
    res.status(422).send(
      page(
        'Roster',
        html`<h1>Overflow roster</h1>
          <p class="error">Enter name and a valid phone.</p>
          <a class="action" href="/app/roster">Back</a>`,
      ),
    );
    return;
  }

  await addRosterMember(db, coachId, name, phone);
  res.redirect(303, '/app/roster');
});

coachRouter.post('/app/roster/:id/priority', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const id = Number(req.params.id);
  const newPriority = wholeNumber(field(req.body, 'priority'), LIMITS.rosterPriority);

  if (newPriority === null) {
    res.status(422).send(
      page('Error', html`<h1>Invalid priority</h1><p class="error">Use a whole number from ${LIMITS.rosterPriority.min} to ${LIMITS.rosterPriority.max}.</p>`),
    );
    return;
  }

  const success = await updateRosterPriority(db, coachId, id, newPriority);
  if (!success) {
    res.status(404).send(page('Not found', html`<h1>Member not found</h1>`));
    return;
  }

  res.redirect(303, '/app/roster');
});

// ---- Screen 7: money (read-only summary + connecting payments) ----

type PaymentsState =
  /** testOnly: a test account where only a live one takes payments (production). */
  | { kind: 'connected'; payoutsEnabled: boolean; testOnly: boolean }
  | { kind: 'finish' }
  | { kind: 'start' }
  | { kind: 'unavailable' };

/** Asks the relay, and saves the answer: this is where a coach lands back
 * from onboarding (?seller=connected|pending|failed). */
async function loadPaymentsState(db: DbClient, coach: CoachRow): Promise<PaymentsState> {
  try {
    const status = await getSellerStatus(getConnectRecipientKey(coach));
    await recordSellerStatus(db, coach, status);
    if (status?.chargesEnabled) {
      return { kind: 'connected', payoutsEnabled: status.payoutsEnabled, testOnly: !testPaymentsAllowed() && status.mode !== 'live' };
    }
    if (status?.agreementVersion === SELLER_AGREEMENT_VERSION) return { kind: 'finish' };
    return { kind: 'start' };
  } catch {
    return { kind: 'unavailable' };
  }
}

const RETURN_NOTICES: Record<string, string> = {
  connected: 'Payments are connected.',
  pending: 'Your payment account is still being reviewed. Athletes can pay you once it is approved.',
  failed: 'Payments were not connected. Try again.',
};

function renderPaymentsCard(state: PaymentsState, notice: string | null, error: string | null) {
  const feePercent = `${APP_FEE_BPS / 100}%`;
  const body =
    state.kind === 'connected'
      ? html`<p><strong>Payments connected.</strong></p>
          ${state.testOnly
            ? html`<p class="error">This payment account takes test payments only, so parents cannot book paid sessions yet.</p>`
            : raw('')}
          <p class="muted">Athletes pay you directly. Coachatron keeps ${feePercent} of each payment.</p>
          <p class="muted">
            ${state.payoutsEnabled
              ? 'Payouts go to your bank account.'
              : 'Payouts are paused until your bank details are complete.'}
          </p>
          <form method="post" action="/app/money/payments">
            <button type="submit">Update payout details</button>
          </form>`
      : state.kind === 'unavailable'
        ? html`<p class="muted">Payments status is unavailable right now. Try again in a minute.</p>`
        : state.kind === 'finish'
          ? html`<p class="muted">Finish setting up your payment account so athletes can pay you.</p>
              <form method="post" action="/app/money/payments">
                <button type="submit">Finish connecting payments</button>
              </form>`
          : html`<p class="muted">Connect a payment account so athletes can pay you when they book.</p>
              <ul class="muted">
                <li>You are the merchant. Payments settle to your own account; Coachatron never holds them.</li>
                <li>Coachatron keeps ${feePercent} of each payment, on top of card processing.</li>
                <li>You refund a payment here or on its session; Coachatron's fee is returned with the refund. A card dispute is charged to your payment account.</li>
              </ul>
              <form method="post" action="/app/money/payments">
                <label><input type="checkbox" name="agree" value="1" /> I accept the Coachatron marketplace terms (${SELLER_AGREEMENT_VERSION}).</label>
                <button type="submit">Connect payments</button>
              </form>`;
  return html`<h2>Payments</h2>
    <div class="card">
      ${notice ? html`<p>${notice}</p>` : raw('')}
      ${body}
      ${error ? html`<p class="error">${error}</p>` : raw('')}
    </div>`;
}

/** Payments that did not simply become a booking, and refunds that did not
 * go through, for the coach to sort out with the parent. Each kept payment
 * can be refunded with one tap (and a confirmation). */
function renderPaymentAttention(items: AttentionItem[], refunds: Map<string, RefundRow>, needing: RefundItem[]) {
  if (items.length === 0 && needing.length === 0) return raw('');
  return html`<h2>Payments to resolve</h2>
    <p class="muted">These payments reached you but did not book as they stood, or a refund did not go through. Contact the parent to sort each one out, or refund it.</p>
    ${items.map((item) => {
      const refund = item.payment_ref ? refunds.get(item.payment_ref) : undefined;
      const amount = item.amount_cents === null ? 'amount unknown' : formatCoachDollars(item.amount_cents);
      return html`<div class="card payment-attention">
        <p><strong>${item.athlete_name ?? 'Unknown athlete'}</strong>${item.contact_phone ? html` · <a href="tel:${item.contact_phone}">${item.contact_phone}</a>` : raw('')}
          · ${amount}</p>
        ${item.session_name && item.starts_at_utc && item.tz
          ? html`<p class="muted">${item.session_name} — ${formatLocal(item.starts_at_utc, item.tz)}</p>`
          : raw('')}
        <p>${describeAttention(item)}</p>
        ${refund ? html`<p class="muted">${describeRefund(refund)}</p>` : raw('')}
        ${item.payment_ref && (!refund || canTryAgain(refund))
          ? html`<a class="action ghost" href="/app/money?refund=a${item.id}#refund">${refund ? 'Try the refund again' : `Refund ${amount}`}</a>`
          : raw('')}
      </div>`;
    })}
    ${needing.map(
      (r) => html`<div class="card refund-attention">
        <p><strong>${r.athlete_name ?? 'Unknown athlete'}</strong>${r.contact_phone ? html` · <a href="tel:${r.contact_phone}">${r.contact_phone}</a>` : raw('')}
          · ${r.amount_cents === null ? 'amount unknown' : formatCoachDollars(r.amount_cents)}</p>
        ${r.session_name && r.starts_at_utc && r.tz ? html`<p class="muted">${r.session_name} — ${formatLocal(r.starts_at_utc, r.tz)}</p>` : raw('')}
        <p>${describeRefund(r)}</p>
        ${canTryAgain(r) && r.booking_id !== null
          ? html`<a class="action ghost" href="/app/money?refund=b${r.booking_id}#refund">Try the refund again</a>`
          : raw('')}
      </div>`,
    )}`;
}

const DISPUTE_STATE: Record<string, string> = { open: 'Open', won: 'Decided for you', lost: 'Decided for the cardholder' };

/** Card disputes on the coach's payments, as Stripe reports them. */
function renderDisputes(items: DisputeItem[]) {
  if (items.length === 0) return raw('');
  return html`<h2>Card disputes</h2>
    <p class="muted">Stripe handles card disputes between a parent's bank and your payment account. Coachatron holds no funds and does not decide them.</p>
    ${items.map(
      (d) => html`<div class="card payment-dispute">
        <p><strong>${d.athlete_name ?? 'Unknown athlete'}</strong>${d.contact_phone ? html` · <a href="tel:${d.contact_phone}">${d.contact_phone}</a>` : raw('')}
          · ${d.amount_cents === null ? 'amount unknown' : formatCoachDollars(d.amount_cents)} · ${DISPUTE_STATE[d.state] ?? d.state}</p>
        ${d.session_name && d.starts_at_utc && d.tz ? html`<p class="muted">${d.session_name} — ${formatLocal(d.starts_at_utc, d.tz)}</p>` : raw('')}
        <p>${describeDispute(d)}</p>
      </div>`,
    )}`;
}

/** Refunds on their way or done, newest first. */
function renderRefunds(items: RefundItem[]) {
  if (items.length === 0) return raw('');
  return html`<h2>Refunds</h2>
    ${items.map(
      (r) => html`<div class="card refund-item">
        <p><strong>${r.athlete_name ?? 'Unknown athlete'}</strong> · ${r.amount_cents === null ? 'amount unknown' : formatCoachDollars(r.amount_cents)} · ${refundLabel(r)}</p>
        ${r.session_name && r.starts_at_utc && r.tz ? html`<p class="muted">${r.session_name} — ${formatLocal(r.starts_at_utc, r.tz)}</p>` : raw('')}
        <p class="muted">${describeRefund(r)}</p>
      </div>`,
    )}`;
}

/** The latest card payments that bought a booking, each with its Refund. */
function renderRecentPayments(items: PaymentItem[], refunds: Map<string, RefundRow>, checks: Map<number, Refundability>) {
  if (items.length === 0) return raw('');
  return html`<h2>Recent payments</h2>
    ${items.map(
      (p) => html`<div class="card recent-payment">
        <p><strong>${p.athlete_name}</strong> · ${formatCoachDollars(p.gross_cents)}</p>
        <p class="muted">${p.session_name} — ${formatLocal(p.starts_at_utc, p.tz)}</p>
        ${renderBookingPayment(p, refunds, checks.get(p.booking_id) ?? null, `/app/money?refund=b${p.booking_id}#refund`)}
      </div>`,
    )}`;
}

/** `b12` is booking 12's payment, `a5` the kept payment 5. */
function parseRefundTarget(value: unknown): RefundTarget | null {
  const match = typeof value === 'string' ? /^([ab])(\d{1,9})$/.exec(value) : null;
  if (!match) return null;
  const id = Number(match[2]);
  return match[1] === 'b' ? { bookingId: id } : { attentionId: id };
}

async function renderMoney(
  res: Response,
  coach: CoachRow,
  opts: { status?: number; notice?: string | null; error?: string | null; refund?: RefundTarget | null } = {},
) {
  const db = getDb();
  const summary = await summarizeMoney(db, coach.id, new Date());
  const payments = await loadPaymentsState(db, coach);
  const attention = await listPaymentAttention(db, coach.id);
  const refundList = await listRefunds(db, coach.id);
  const disputes = await listDisputes(db, coach.id);
  const recent = await listRecentPayments(db, coach.id);
  const refunds = await refundsByPayment(db, [
    ...attention.flatMap((a) => (a.payment_ref ? [a.payment_ref] : [])),
    ...recent.map((p) => p.charge_id),
  ]);
  const checks = new Map<number, Refundability>();
  for (const p of recent) checks.set(p.booking_id, await checkRefund(db, coach.id, { bookingId: p.booking_id }));
  const attentionRefs = new Set(attention.flatMap((a) => (a.payment_ref ? [a.payment_ref] : [])));
  const needing = refundList.filter((r) => needsAttention(r) && !attentionRefs.has(r.payment_ref));
  const confirm = opts.refund ? await checkRefund(db, coach.id, opts.refund) : null;
  const confirmTarget = opts.refund ? ('bookingId' in opts.refund ? `b${opts.refund.bookingId}` : `a${opts.refund.attentionId}`) : '';

  // Format dollars for display
  const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  res.status(opts.status ?? 200).send(
    page(
      'Money',
      html`${coachNav('money')}
        <h1>Money</h1>
        ${confirm ? renderRefundConfirm(confirm, { action: '/app/money/refund', keepHref: '/app/money', hidden: { target: confirmTarget } }) : raw('')}
        ${renderPaymentsCard(payments, opts.notice ?? null, opts.error ?? null)}
        ${renderPaymentAttention(attention, refunds, needing)}
        ${renderDisputes(disputes)}
        ${renderPageLinkCard(coach, { main: 'none' })}
        <h2>This week</h2>
        <p class="money-figure">${formatDollars(summary.collectedThisWeekCents)}</p>
        <p class="muted">Collected (gross): ${formatDollars(summary.collectedThisWeekCents)}</p>
        <p class="muted"><strong>${summary.bookedThisWeekCount} sessions booked</strong> — Value: ${formatDollars(summary.bookedThisWeekCents)}</p>
        ${summary.refundedThisWeekCount > 0
          ? html`<p class="muted">Refunded: ${formatDollars(summary.refundedThisWeekCents)} (${summary.refundedThisWeekCount} ${summary.refundedThisWeekCount === 1 ? 'payment' : 'payments'}). Refunded bookings are not counted above.</p>`
          : raw('')}
        <h2>Credits</h2>
        <div class="card">
          <p><strong>${summary.outstandingCreditCount} credits outstanding</strong></p>
        </div>
        <h2>Next week</h2>
        <div class="card">
          <p><strong>${summary.nextWeekCount} sessions projected</strong></p>
          <p class="muted">Value: ${formatDollars(summary.nextWeekCents)}</p>
        </div>
        ${renderRecentPayments(recent, refunds, checks)}
        ${renderRefunds(refundList.filter((r) => !needsAttention(r)))}
        <a class="action" href="/app/schedule">Back to schedule</a>
        <form method="post" action="/signout">
          <button type="submit" class="ghost">Sign out</button>
        </form>`,
    ),
  );
}

coachRouter.get('/app/money', requireAuth, async (req, res) => {
  const coach = await findCoachById(getDb(), res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const returned = typeof req.query.seller === 'string' ? req.query.seller : '';
  await renderMoney(res, coach, {
    notice: Object.hasOwn(RETURN_NOTICES, returned) ? RETURN_NOTICES[returned] : refundNotice(req.query.notice),
    refund: parseRefundTarget(req.query.refund),
  });
});

/** The confirmed refund of a booking's payment or of a kept payment. */
coachRouter.post('/app/money/refund', requireAuth, async (req, res) => {
  const db = getDb();
  const coach = await findCoachById(db, res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const target = parseRefundTarget(field(req.body, 'target'));
  if (!target) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const outcome = await requestRefund(db, coach, target);
  if (outcome.kind === 'blocked') {
    res.redirect(303, `/app/money?refund=${field(req.body, 'target')}#refund`);
    return;
  }
  res.redirect(303, `/app/money?notice=${refundOutcomeNotice(outcome)}`);
});

coachRouter.post('/app/money/payments', requireAuth, async (req, res) => {
  const coach = await findCoachById(getDb(), res.locals.coachId as number);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const db = getDb();
  const sellerKey = getConnectRecipientKey(coach);
  try {
    const status = await getSellerStatus(sellerKey);
    await recordSellerStatus(db, coach, status);
    if (status?.agreementVersion !== SELLER_AGREEMENT_VERSION) {
      if (field(req.body, 'agree') !== '1') {
        await renderMoney(res, coach, { status: 422, error: 'Check the box to accept the marketplace terms.' });
        return;
      }
      await acceptSellerAgreement(sellerKey, SELLER_AGREEMENT_VERSION);
    }
    await markPaymentsStarted(db, coach.id);
    // What the app already knows, so the provider's form asks for less.
    const url = await startSellerOnboarding(sellerKey, {
      returnUrl: `${appBaseUrl()}/app/money`,
      email: coach.email,
      profile: {
        phone: coach.phone,
        entityType: 'individual',
        businessUrl: coachPageUrl(coach.handle),
        productDescription: SELLER_PRODUCT_DESCRIPTION,
      },
    });
    res.redirect(303, url);
  } catch {
    await renderMoney(res, coach, { status: 502, error: 'Payments could not start. Try again in a minute.' });
  }
});

export { requireAuth, formatLocal };
