import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import {
  normalizePhone,
  createOtp,
  checkOtp,
  consumeOtp,
  createCoachSession,
  getCoachBySessionToken,
  findCoachByPhone,
  findCoachById,
  createCoach,
  type CoachRow,
} from '../domain/auth.js';
import { generateWeekSessions, type WeeklySlot } from '../domain/scheduling.js';
import { html, page, raw } from '../lib/html.js';
import { formatLocal } from '../lib/time.js';
import {
  getPackagesForCoach,
  getPlansForCoach,
  createPackage,
  createPlan,
  setPlanStripePriceId,
} from '../domain/pricing.js';
import { getConnectRecipientKey } from '../domain/auth.js';
import { isChargesReady, loadCoachConnect, setConnectPending } from '../domain/connect.js';
import { postAgreement, postOnboard, createPlanPrice } from '../relay/connectHub.js';
import { appBaseUrl } from '../config.js';
import { summarizeMoney } from '../domain/money.js';
import { handleCoachMessage, loadScheduleAssistant, resolvePendingForCoach } from '../domain/assistant.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';

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

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
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

coachRouter.get('/signin', (_req, res) => {
  res.status(200).send(
    page(
      'Sign in',
      html`<h1>Coachatron</h1>
        <p class="muted">Enter your phone number to sign in or sign up.</p>
        <form method="post" action="/signin/otp">
          <label for="phone">Phone</label>
          <input id="phone" name="phone" type="tel" placeholder="(555) 555-0100" required />
          <button type="submit">Send code</button>
        </form>`,
    ),
  );
});

coachRouter.post('/signin/otp', async (req, res) => {
  const raw_phone = field(req.body, 'phone');
  const phone = normalizePhone(raw_phone);
  if (!phone) {
    res.status(422).send(
      page(
        'Sign in',
        html`<h1>Coachatron</h1>
          <form method="post" action="/signin/otp">
            <label for="phone">Phone</label>
            <input id="phone" name="phone" type="tel" value="${raw_phone}" required />
            <button type="submit">Send code</button>
          </form>
          <p class="error">Enter a valid phone number.</p>`,
      ),
    );
    return;
  }
  const db = getDb();
  const code = await createOtp(db, phone);
  await sendSms({ to: phone, body: `Coachatron: your sign-in code is ${code}. Expires in 10 minutes.` });
  res.redirect(303, `/signin/verify?phone=${encodeURIComponent(phone)}`);
});

coachRouter.get('/signin/verify', (req, res) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : '';
  res.status(200).send(renderVerifyForm(phone, {}));
});

function renderVerifyForm(
  phone: string,
  values: { code?: string; name?: string; email?: string; tz?: string },
  error?: string,
) {
  return page(
    'Verify',
    html`<h1>Enter your code</h1>
      <p class="muted">We texted a 6-digit code to ${phone}.</p>
      <form method="post" action="/signin/verify">
        <input type="hidden" name="phone" value="${phone}" />
        <label for="code">Code</label>
        <input id="code" name="code" inputmode="numeric" value="${values.code ?? ''}" required />

        <p class="muted">First time here? Tell us about your business.</p>
        <label for="name">Your name</label>
        <input id="name" name="name" value="${values.name ?? ''}" />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" value="${values.email ?? ''}" />
        <label for="tz">Timezone (IANA, e.g. America/Chicago)</label>
        <input id="tz" name="tz" value="${values.tz ?? 'America/Chicago'}" />

        <button type="submit">Continue</button>
      </form>
      ${error ? raw(`<p class="error">${error}</p>`) : raw('')}`,
  );
}

coachRouter.post('/signin/verify', async (req, res) => {
  const phone = field(req.body, 'phone');
  const code = field(req.body, 'code');
  const name = field(req.body, 'name');
  const email = field(req.body, 'email');
  const tz = field(req.body, 'tz');

  const db = getDb();
  const otpId = await checkOtp(db, phone, code);
  if (!otpId) {
    res.status(401).send(renderVerifyForm(phone, { code, name, email, tz }, 'Invalid or expired code.'));
    return;
  }

  let coach: CoachRow | null = await findCoachByPhone(db, phone);
  if (!coach) {
    if (!name || !email || !tz || !tz.includes('/')) {
      res
        .status(422)
        .send(
          renderVerifyForm(phone, { code, name, email, tz }, 'Enter your name, email, and a timezone like America/Chicago.'),
        );
      return;
    }
    await consumeOtp(db, otpId);
    coach = await createCoach(db, { phone, name, email, tz });
  } else {
    await consumeOtp(db, otpId);
  }

  const token = await createCoachSession(db, coach.id);
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, 30 * 24 * 60 * 60));
  res.redirect(303, '/app/schedule');
});

// ---- Screen 4: session types ----

coachRouter.get('/app/session-types', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const types = await db.query<{ id: number; name: string; duration_min: number; capacity: number; price_cents: number }>(
    'select id, name, duration_min, capacity, price_cents from session_type where coach_id = $1 order by id',
    [coachId],
  );
  res.status(200).send(
    page(
      'Session types',
      html`<h1>Session types</h1>
        ${types.rows.map(
          (t) =>
            html`<div class="card">
              <strong>${t.name}</strong> — ${t.duration_min} min, capacity ${t.capacity}, $${(t.price_cents / 100).toFixed(2)}
              <div><a class="action" href="/app/session-types/${t.id}/generate-week">Generate this week</a></div>
            </div>`,
        )}
        <form method="post" action="/app/session-types">
          <label for="name">Name</label>
          <input id="name" name="name" required />
          <label for="duration_min">Duration (minutes)</label>
          <input id="duration_min" name="duration_min" type="number" min="1" required />
          <label for="capacity">Capacity</label>
          <input id="capacity" name="capacity" type="number" min="1" required />
          <label for="price_cents">Price (dollars)</label>
          <input id="price_dollars" name="price_dollars" type="number" min="0" step="0.01" required />
          <button type="submit">Create session type</button>
        </form>`,
    ),
  );
});

coachRouter.post('/app/session-types', requireAuth, async (req, res) => {
  const coachId = res.locals.coachId as number;
  const name = field(req.body, 'name');
  const durationMin = Number(field(req.body, 'duration_min'));
  const capacity = Number(field(req.body, 'capacity'));
  const priceDollars = Number(field(req.body, 'price_dollars'));
  const priceCents = Math.round(priceDollars * 100);

  if (!name || !Number.isInteger(durationMin) || durationMin <= 0 || !Number.isInteger(capacity) || capacity <= 0 || !Number.isFinite(priceCents) || priceCents <= 0) {
    res.status(422).send(
      page(
        'Session types',
        html`<h1>Session types</h1>
          <p class="error">Fill in every field with a positive number.</p>
          <a class="action" href="/app/session-types">Back</a>`,
      ),
    );
    return;
  }

  const db = getDb();
  await db.query(
    'insert into session_type (coach_id, name, duration_min, capacity, price_cents, active) values ($1, $2, $3, $4, $5, true)',
    [coachId, name, durationMin, capacity, priceCents],
  );
  res.redirect(303, '/app/session-types');
});

coachRouter.get('/app/session-types/:id/generate-week', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);
  const typeRows = await db.query<{ id: number }>('select id from session_type where id = $1 and coach_id = $2', [
    typeId,
    coachId,
  ]);
  if (typeRows.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  res.status(200).send(
    page(
      'Generate this week',
      html`<h1>Weekly times</h1>
        <p class="muted">Check the days this session runs and set a start time for each.</p>
        <form method="post" action="/app/session-types/${typeId}/generate-week">
          ${WEEKDAY_LABELS.map(
            (label, i) =>
              html`<label><input type="checkbox" name="day_${i}" value="1" /> ${label}
                <input type="time" name="time_${i}" /></label>`,
          )}
          <button type="submit">Generate</button>
        </form>`,
    ),
  );
});

coachRouter.post('/app/session-types/:id/generate-week', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const typeId = Number(req.params.id);

  const typeRows = await db.query<{
    id: number;
    coach_id: number;
    name: string;
    duration_min: number;
    capacity: number;
    price_cents: number;
  }>('select id, coach_id, name, duration_min, capacity, price_cents from session_type where id = $1 and coach_id = $2', [
    typeId,
    coachId,
  ]);
  if (typeRows.rows.length === 0) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }
  const coachRows = await db.query<{ tz: string }>('select tz from coach where id = $1', [coachId]);
  const tz = coachRows.rows[0]?.tz ?? 'America/Chicago';

  const body = req.body as Record<string, unknown>;
  const slots: WeeklySlot[] = [];
  for (let i = 0; i < 7; i += 1) {
    const checked = field(body, `day_${i}`) === '1';
    const timeLocal = field(body, `time_${i}`);
    if (checked && /^\d{2}:\d{2}$/.test(timeLocal)) {
      slots.push({ weekday: i, timeLocal });
    }
  }

  if (slots.length === 0) {
    res.status(422).send(
      page(
        'Weekly times',
        html`<h1>Weekly times</h1>
          <p class="error">Pick at least one day and time.</p>`,
      ),
    );
    return;
  }

  await generateWeekSessions(db, typeRows.rows[0], tz, slots, new Date());
  res.redirect(303, '/app/schedule');
});

// ---- Screen 2: schedule ----

coachRouter.get('/app/schedule', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessions = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
    capacity: number;
    price_cents: number;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, st.capacity, st.price_cents
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
          <h1>This week</h1>
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
            ? html`<p class="muted">No sessions yet. Create a session type and generate a week.</p>`
            : sessions.rows.map(
                (s) =>
                  html`<div class="card">
                    <strong>${formatLocal(s.starts_at_utc, s.tz)}</strong>
                    <div class="meta"><span>${s.name}</span><span>$${(s.price_cents / 100).toFixed(2)}</span></div>
                  </div>`,
              )}
          <a class="action" href="/app/session-types">Session types</a>
        </div>
        <div class="schedule-ask">
          <form method="post" action="/app/schedule/ask">
            <label for="ask">Text the week</label>
            <input id="ask" name="text" type="text" placeholder="Text the week. &quot;who's at 6pm&quot; or &quot;cancel tomorrow&quot;" />
            <button type="submit">Send</button>
          </form>
        </div>`,
    ),
  );
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
  const pendingId = Number(field(req.body, 'id'));
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
} | null> {
  const result = await db.query<{ id: number; starts_at_utc: string; tz: string; name: string }>(
    `select s.id, s.starts_at_utc, s.tz, st.name
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
  
  // Get bookings for this session
  const bookings = await db.query<{
    id: number;
    athlete_name: string;
    status: string;
    manage_token: string;
  }>(
    `select id, athlete_name, status, manage_token 
     from booking 
     where session_id = $1 
     order by id`,
    [sessionId],
  );
  
  res.status(200).send(
    page(
      session.name,
      html`<h1>${session.name}</h1>
        <p class="muted">${formatLocal(session.starts_at_utc, session.tz)}</p>
        
        <h2>Roster (${bookings.rows.length} attendees)</h2>
        ${bookings.rows.length === 0
          ? html`<p class="muted">No bookings yet.</p>`
          : html`<ul>
              ${bookings.rows.map((b) => {
                const statusClass = b.status === 'attended' ? 'good' : b.status === 'noshow' ? 'alert' : '';
                return html`<li class="card">
                  <strong>${b.athlete_name}</strong> — 
                  ${b.status === 'booked' ? html`<span>Ready to mark</span>` : 
                    b.status === 'cancelled' ? html`<span class="muted">Cancelled</span>` :
                    html`<span class="${statusClass}">${b.status}</span>`}
                  ${b.status === 'booked' ? html`
                    <form method="post" action="/app/sessions/${sessionId}/bookings/${b.id}/attendance">
                      <label><input type="radio" name="status" value="attended" checked /> Attended</label>
                      <label><input type="radio" name="status" value="noshow" /> No-show</label>
                      <button type="submit">Mark attendance</button>
                    </form>
                  ` : raw('')}
                </li>`;
              })}
            </ul>`}
        
        <h2>Action</h2>
        <form method="post" action="/app/sessions/${sessionId}/cancel">
          <button type="submit" class="action">Cancel session</button>
        </form>
        
        <a class="action" href="/app/schedule">Back to schedule</a>`,
    ),
  );
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

coachRouter.post('/app/sessions/:id/cancel', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const sessionId = Number(req.params.id);

  // Verify session belongs to this coach
  const session = await loadSessionForCoach(db, coachId, sessionId);
  if (!session) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1>`));
    return;
  }

  // starts_at_utc is already an absolute instant (timestamptz); compare it
  // directly against "now" - no per-connection SET timezone dance needed
  // (and `SET timezone TO $1` is not even valid SQL: SET does not accept a
  // bind parameter).
  if (new Date(session.starts_at_utc) < new Date()) {
    res.status(409).send(
      page('Cannot cancel', html`<h1>Session already started</h1>
        <p class="error">This session has already passed and cannot be cancelled.</p>
        <a class="action" href="/app/sessions/${sessionId}">Back to session detail</a>`),
    );
    return;
  }

  // Idempotent: a double-submitted cancel must not re-send cancellation
  // texts to everyone a second time.
  const cancelled = await db.query<{ contact_phone: string; athlete_name: string }>(
    `update booking set status = 'cancelled'
     where session_id = $1 and status in ('booked', 'attended', 'noshow')
     returning contact_phone, athlete_name`,
    [sessionId],
  );

  for (const athlete of cancelled.rows) {
    await sendSms({
      to: athlete.contact_phone,
      body: `${athlete.athlete_name}'s ${session.name} on ${formatLocal(session.starts_at_utc, session.tz)} has been cancelled.`,
    });
  }

  await db.query("update session set status = 'cancelled' where id = $1", [sessionId]);

  res.redirect(303, '/app/schedule');
});

function renderConnectStatus(coach: { connect_status: string }): ReturnType<typeof html> {
  if (coach.connect_status === 'ready') {
    return html`<p class="muted">Stripe payouts: connected.</p>`;
  }
  if (coach.connect_status === 'pending') {
    return html`<p class="muted">Stripe payouts: setup in progress.</p>
      <form method="post" action="/app/connect/onboard"><button type="submit">Continue Stripe setup</button></form>`;
  }
  return html`<p class="muted">Connect Stripe to accept card payments.</p>
    <form method="post" action="/app/connect/onboard"><button type="submit">Connect Stripe</button></form>`;
}

coachRouter.post('/app/connect/onboard', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await findCoachById(db, coachId);
  if (!coach) {
    res.redirect(303, '/signin');
    return;
  }
  const recipientKey = getConnectRecipientKey(coach);
  const base = appBaseUrl();
  await postAgreement(recipientKey);
  const { url, stripeAccountId } = await postOnboard(recipientKey, {
    email: coach.email,
    refreshUrl: `${base}/app/connect/return`,
    returnUrl: `${base}/app/connect/return`,
  });
  await setConnectPending(db, coachId, stripeAccountId || null);
  res.redirect(303, url);
});

coachRouter.get('/app/connect/return', requireAuth, async (_req, res) => {
  res.redirect(303, '/app/money');
});

// ---- Screen 5: pricing (packages and plans) ----

coachRouter.get('/app/pricing', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await loadCoachConnect(db, coachId);
  const packagesList = await getPackagesForCoach(db, coachId);
  const plansList = await getPlansForCoach(db, coachId);

  res.status(200).send(
    page(
      'Pricing',
      html`<h1>Pricing & credits</h1>
        ${coach ? renderConnectStatus(coach) : raw('')}
        <h2>Session packages</h2>
        ${packagesList.length === 0
          ? html`<p class="muted">No packages yet.</p>`
          : packagesList.map(
              (p) =>
                html`<div class="card">
                  <strong>${p.name}</strong><br />
                  ${p.credits} sessions — $${(p.price_cents / 100).toFixed(2)}
                  ${p.expires_days ? html`<br /><span class="muted">Expires in ${p.expires_days} days</span>` : raw('')}
                </div>`,
            )}
        <form method="post" action="/app/pricing/package">
          <label for="pkg_name">Package name</label>
          <input id="pkg_name" name="name" required />
          <label for="pkg_credits">Number of sessions</label>
          <input id="pkg_credits" name="credits" type="number" min="1" required />
          <label for="pkg_price_dollars">Price (dollars)</label>
          <input id="pkg_price_dollars" name="price_dollars" type="number" min="0" step="0.01" required />
          <label for="pkg_expires_days">Expires after days (optional)</label>
          <input id="pkg_expires_days" name="expires_days" type="number" min="1" />
          <button type="submit">Create package</button>
        </form>

        <h2>Monthly plans</h2>
        ${plansList.length === 0
          ? html`<p class="muted">No monthly plans yet.</p>`
          : plansList.map(
              (p) =>
                html`<div class="card">
                  <strong>${p.name}</strong><br />
                  $${(p.price_cents / 100).toFixed(2)} / month — ${p.credits_per_month} sessions
                </div>`,
            )}
        <form method="post" action="/app/pricing/plan">
          <label for="plan_name">Plan name</label>
          <input id="plan_name" name="name" required />
          <label for="plan_price_dollars">Price (dollars)</label>
          <input id="plan_price_dollars" name="price_dollars" type="number" min="0" step="0.01" required />
          <label for="plan_credits">Sessions per month</label>
          <input id="plan_credits" name="credits_per_month" type="number" min="1" required />
          <button type="submit">Create plan</button>
        </form>`,
    ),
  );
});

coachRouter.post('/app/pricing/package', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const name = field(req.body, 'name');
  const credits = Number(field(req.body, 'credits'));
  const priceDollars = Number(field(req.body, 'price_dollars'));
  const expiresDaysRaw = field(req.body, 'expires_days');
  const expiresDays = expiresDaysRaw ? Number(expiresDaysRaw) : undefined;

  if (!name || !Number.isInteger(credits) || credits <= 0 || priceDollars <= 0 || (expiresDays !== undefined && !Number.isInteger(expiresDays))) {
    res.status(422).send(
      page(
        'Pricing',
        html`<h1>Pricing & credits</h1>
          <p class="error">Fill in package details correctly.</p>
          <a class="action" href="/app/pricing">Back</a>`,
      ),
    );
    return;
  }

  const priceCents = Math.round(priceDollars * 100);
  await createPackage(db, coachId, name, credits, priceCents, expiresDays);
  res.redirect(303, '/app/pricing');
});

coachRouter.post('/app/pricing/plan', requireAuth, async (req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const name = field(req.body, 'name');
  const priceDollars = Number(field(req.body, 'price_dollars'));
  const creditsPerMonth = Number(field(req.body, 'credits_per_month'));

  if (!name || !Number.isInteger(creditsPerMonth) || creditsPerMonth <= 0 || priceDollars <= 0) {
    res.status(422).send(
      page(
        'Pricing',
        html`<h1>Pricing & credits</h1>
          <p class="error">Fill in plan details correctly.</p>
          <a class="action" href="/app/pricing">Back</a>`,
      ),
    );
    return;
  }

  const priceCents = Math.round(priceDollars * 100);
  const coach = await findCoachById(db, coachId);
  let stripePriceId: string | null = null;
  if (coach && isChargesReady(coach)) {
    stripePriceId = await createPlanPrice({
      recipientKey: getConnectRecipientKey(coach),
      name,
      priceCents,
      idempotencyKey: `plan:${coachId}:${name}:${priceCents}`,
    });
  }
  const planId = await createPlan(db, coachId, name, priceCents, creditsPerMonth, stripePriceId);
  if (stripePriceId) {
    await setPlanStripePriceId(db, planId, stripePriceId);
  }
  res.redirect(303, '/app/pricing');
});

// ---- Screen 6: roster (M4 overflow cascade) ----

coachRouter.get('/app/roster', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const members = await listRosterMembers(db, coachId);

  res.status(200).send(
    page(
      'Roster',
      html`<h1>Overflow roster</h1>
        ${members.length === 0
          ? html`<p class="muted">No roster members yet.</p>`
          : html`<ul class="roster-list">
              ${members.map(
                (m) =>
                  html`<li class="card">
                    <div class="row"><span>${m.name}</span><span class="muted">${m.phone}</span></div>
                    <form class="roster-priority-form" method="post" action="/app/roster/${m.id}/priority">
                      <input type="number" name="priority" value="${m.priority}" min="0" required aria-label="Priority for ${m.name}" />
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
        </form>`,
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
  const newPriority = Number(field(req.body, 'priority'));

  if (!Number.isInteger(newPriority) || newPriority < 0) {
    res.status(422).send(page('Error', html`<h1>Invalid priority</h1>`));
    return;
  }

  const success = await updateRosterPriority(db, coachId, id, newPriority);
  if (!success) {
    res.status(404).send(page('Not found', html`<h1>Member not found</h1>`));
    return;
  }

  res.redirect(303, '/app/roster');
});

// ---- Screen 7: money (read-only summary) ----

coachRouter.get('/app/money', requireAuth, async (_req, res) => {
  const db = getDb();
  const coachId = res.locals.coachId as number;
  const coach = await loadCoachConnect(db, coachId);
  const now = new Date();

  const summary = await summarizeMoney(db, coachId, now);

  // Format dollars for display
  const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  res.status(200).send(
    page(
      'Money',
      html`<h1>Money</h1>
        ${coach ? renderConnectStatus(coach) : raw('')}
        <h2>This week</h2>
        <p class="money-figure">${formatDollars(summary.collectedThisWeekCents)}</p>
        <p class="muted">Collected (gross): ${formatDollars(summary.collectedThisWeekCents)}</p>
        <p class="muted"><strong>${summary.bookedThisWeekCount} sessions booked</strong> — Value: ${formatDollars(summary.bookedThisWeekCents)}</p>
        <h2>Credits</h2>
        <div class="card">
          <p><strong>${summary.outstandingCreditCount} credits outstanding</strong></p>
        </div>
        <h2>Next week</h2>
        <div class="card">
          <p><strong>${summary.nextWeekCount} sessions projected</strong></p>
          <p class="muted">Value: ${formatDollars(summary.nextWeekCents)}</p>
        </div>
        <a class="action" href="/app/schedule">Back to schedule</a>`,
    ),
  );
});

export { requireAuth, formatLocal };
