import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb } from '../db/client.js';
import { sendSms } from '../relay/sms.js';
import {
  normalizePhone,
  createOtp,
  checkOtp,
  consumeOtp,
  createCoachSession,
  getCoachBySessionToken,
  findCoachByPhone,
  createCoach,
  type CoachRow,
} from '../domain/auth.js';
import { generateWeekSessions, type WeeklySlot } from '../domain/scheduling.js';
import { html, page, raw } from '../lib/html.js';
import { parseCookies, serializeCookie } from '../lib/cookies.js';

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

  res.status(200).send(
    page(
      'Schedule',
      html`<h1>This week</h1>
        ${sessions.rows.length === 0
          ? html`<p class="muted">No sessions yet. Create a session type and generate a week.</p>`
          : sessions.rows.map(
              (s) =>
                html`<div class="card">
                  ${formatLocal(s.starts_at_utc, s.tz)} — ${s.name} — $${(s.price_cents / 100).toFixed(2)}
                </div>`,
            )}
        <a class="action" href="/app/session-types">Session types</a>`,
    ),
  );
});

export function formatLocal(isoUtc: string, tz: string): string {
  const date = new Date(isoUtc);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export { requireAuth };
