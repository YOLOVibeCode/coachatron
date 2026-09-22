import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { findCoachByHandle, normalizePhone, type CoachRow } from '../domain/auth.js';
import { html, page, raw } from '../lib/html.js';
import { formatLocal } from './coach.js';
import {
  getPackagesForCoach,
  getPackageById,
  getPlansForCoach,
  getPlanById,
  getCreditBalance,
  decrementCredit,
  createCredit,
  createSubscriptionRecord,
  createPendingBooking,
  getBooking,
  markBookingBooked,
  countBookedForSession,
  chargeForBooking,
  subscribeForBooking,
} from '../domain/pricing.js';

export const publicRouter = Router();

interface SessionForBooking {
  id: number;
  starts_at_utc: string;
  tz: string;
  session_type_id: number;
  name: string;
  capacity: number;
  price_cents: number;
}

async function loadSessionForCoach(db: DbClient, coach: CoachRow, sessionId: number): Promise<SessionForBooking | null> {
  const result = await db.query<SessionForBooking>(
    `select s.id, s.starts_at_utc, s.tz, st.id as session_type_id, st.name, st.capacity, st.price_cents
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2 and s.status = 'scheduled'`,
    [sessionId, coach.id],
  );
  return result.rows[0] ?? null;
}

function notFound() {
  return page('Not found', html`<h1>Not found</h1><p class="muted">That page does not exist.</p>`);
}

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

// ---- Screen 8: coach's public page (sessions list) ----

publicRouter.get('/c/:handle', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }

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
            coalesce((select count(*) from booking b where b.session_id = s.id and b.status = 'booked'), 0)::text as booked
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
     order by s.starts_at_utc
     limit 50`,
    [coach.id],
  );

  res.status(200).send(
    page(
      coach.name,
      html`<h1>${coach.name}</h1>
        ${sessions.rows.length === 0
          ? html`<p class="muted">No open sessions right now.</p>`
          : sessions.rows.map((s) => {
              const spotsLeft = s.capacity - Number(s.booked);
              return html`<div class="card">
                <strong>${formatLocal(s.starts_at_utc, s.tz)}</strong><br />
                ${s.name} — ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left — $${(s.price_cents / 100).toFixed(2)}<br />
                ${spotsLeft > 0
                  ? html`<a class="action" href="/c/${coach.handle}/sessions/${s.id}/book">Book</a>`
                  : html`<span class="muted">Full</span>`}
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
  res.status(200).send(renderBookingForm(coach, session, {}));
});

function renderBookingForm(
  coach: CoachRow,
  session: SessionForBooking,
  values: { athlete_name?: string; contact_phone?: string; contact_email?: string },
  error?: string,
) {
  return page(
    'Book a session',
    html`<h1>${session.name}</h1>
      <p class="muted">${formatLocal(session.starts_at_utc, session.tz)} — $${(session.price_cents / 100).toFixed(2)}</p>
      <form method="post" action="/c/${coach.handle}/sessions/${session.id}/book">
        <label for="athlete_name">Athlete name</label>
        <input id="athlete_name" name="athlete_name" value="${values.athlete_name ?? ''}" required />
        <label for="contact_phone">Your phone</label>
        <input id="contact_phone" name="contact_phone" type="tel" value="${values.contact_phone ?? ''}" required />
        <label for="contact_email">Your email (optional)</label>
        <input id="contact_email" name="contact_email" type="email" value="${values.contact_email ?? ''}" />
        <button type="submit">Continue to payment</button>
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
          { athlete_name: athleteName, contact_phone: rawPhone, contact_email: contactEmail ?? undefined },
          'Enter the athlete’s name and a valid phone number.',
        ),
      );
    return;
  }

  // Re-check capacity server-side even if the list page the parent saw was
  // stale — SPEC.md §7.2.
  const bookedCount = await countBookedForSession(db, session.id);
  if (bookedCount >= session.capacity) {
    res.status(409).send(
      page(
        'Session full',
        html`<h1>That session just filled up</h1>
          <p class="muted">Someone booked the last spot. <a href="/c/${coach.handle}">See other times</a>.</p>`,
      ),
    );
    return;
  }

  const bookingId = await createPendingBooking(db, session.id, athleteName, contactPhone, contactEmail);
  res.redirect(303, `/c/${coach.handle}/checkout/${bookingId}`);
});

// ---- Screen 10: checkout ----

async function loadCheckoutContext(db: DbClient, coach: CoachRow, bookingId: number) {
  const booking = await getBooking(db, bookingId);
  if (!booking) return null;
  const session = await loadSessionForCoach(db, coach, booking.session_id);
  if (!session) return null;
  return { booking, session };
}

publicRouter.get('/c/:handle/checkout/:bookingId', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const ctx = await loadCheckoutContext(db, coach, Number(req.params.bookingId));
  if (!ctx) {
    res.status(404).send(notFound());
    return;
  }
  if (ctx.booking.status !== 'pending') {
    res.status(200).send(renderAlreadyBooked(coach, ctx.session));
    return;
  }

  const packages = await getPackagesForCoach(db, coach.id);
  const plans = await getPlansForCoach(db, coach.id);
  const credit = await getCreditBalance(db, coach.id, ctx.booking.contact_phone);

  res.status(200).send(renderCheckout(coach, ctx.session, ctx.booking.id, { packages, plans, credit }));
});

function renderAlreadyBooked(coach: CoachRow, session: SessionForBooking) {
  return page(
    'Booked',
    html`<h1>You're booked</h1>
      <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}</p>
      <a class="action" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
  );
}

function renderCheckout(
  coach: CoachRow,
  session: SessionForBooking,
  bookingId: number,
  options: {
    packages: Array<{ id: number; name: string; credits: number; price_cents: number }>;
    plans: Array<{ id: number; name: string; price_cents: number; credits_per_month: number }>;
    credit: { remaining: number } | null;
  },
  error?: string,
) {
  const action = `/c/${coach.handle}/checkout/${bookingId}`;
  return page(
    'Checkout',
    html`<h1>${session.name}</h1>
      <p class="muted">${formatLocal(session.starts_at_utc, session.tz)}</p>

      ${options.credit
        ? html`<form method="post" action="${action}">
            <input type="hidden" name="mode" value="credit" />
            <button type="submit">Use 1 of ${options.credit.remaining} session credits</button>
          </form>`
        : raw('')}

      <form method="post" action="${action}">
        <input type="hidden" name="mode" value="dropin" />
        <button type="submit">Pay $${(session.price_cents / 100).toFixed(2)} — this session only</button>
      </form>

      ${options.packages.map(
        (p) => html`<form method="post" action="${action}">
          <input type="hidden" name="mode" value="package" />
          <input type="hidden" name="package_id" value="${p.id}" />
          <button type="submit">Buy ${p.name} — ${p.credits} sessions for $${(p.price_cents / 100).toFixed(2)}</button>
        </form>`,
      )}

      ${options.plans.map(
        (p) => html`<form method="post" action="${action}">
          <input type="hidden" name="mode" value="plan" />
          <input type="hidden" name="plan_id" value="${p.id}" />
          <button type="submit">Subscribe to ${p.name} — $${(p.price_cents / 100).toFixed(2)}/mo</button>
        </form>`,
      )}
      ${error ? raw(`<p class="error">${error}</p>`) : raw('')}`,
  );
}

publicRouter.post('/c/:handle/checkout/:bookingId', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(notFound());
    return;
  }
  const bookingId = Number(req.params.bookingId);
  const ctx = await loadCheckoutContext(db, coach, bookingId);
  if (!ctx) {
    res.status(404).send(notFound());
    return;
  }

  // Idempotent no-op on a resubmitted checkout: the first submission already
  // resolved this booking, so a retry (double-click, network retry) neither
  // charges again nor creates a second booking.
  if (ctx.booking.status !== 'pending') {
    res.status(200).send(renderAlreadyBooked(coach, ctx.session));
    return;
  }

  const mode = field(req.body, 'mode');
  const phone = ctx.booking.contact_phone;

  try {
    if (mode === 'credit') {
      const credit = await getCreditBalance(db, coach.id, phone);
      if (!credit || !(await decrementCredit(db, credit.id))) {
        const packages = await getPackagesForCoach(db, coach.id);
        const plans = await getPlansForCoach(db, coach.id);
        res
          .status(409)
          .send(renderCheckout(coach, ctx.session, bookingId, { packages, plans, credit: null }, 'That credit is no longer available.'));
        return;
      }
      await markBookingBooked(db, bookingId, {
        paymentSource: 'PackageCredit',
        creditId: credit.id,
        chargeId: null,
        grossCents: null,
      });
    } else if (mode === 'dropin') {
      const result = await chargeForBooking(bookingId, 'dropin', ctx.session.price_cents, `phone:${phone}`, `Drop-in: ${ctx.session.name}`);
      await markBookingBooked(db, bookingId, {
        paymentSource: 'DropIn',
        creditId: null,
        chargeId: result.id,
        grossCents: result.amountCents,
      });
    } else if (mode === 'package') {
      const packageId = Number(field(req.body, 'package_id'));
      const pkg = await getPackageById(db, coach.id, packageId);
      if (!pkg) {
        res.status(404).send(notFound());
        return;
      }
      const result = await chargeForBooking(bookingId, 'package', pkg.price_cents, `phone:${phone}`, `Package: ${pkg.name}`);
      const expiresAt = pkg.expires_days ? new Date(Date.now() + pkg.expires_days * 24 * 60 * 60 * 1000) : null;
      // One credit of this package is consumed immediately by this booking,
      // so the ledger starts at credits - 1.
      const creditId = await createCredit(db, coach.id, phone, pkg.id, `package:${pkg.id}`, pkg.credits - 1, expiresAt);
      await markBookingBooked(db, bookingId, {
        paymentSource: 'PackageCredit',
        creditId,
        chargeId: result.id,
        grossCents: result.amountCents,
      });
    } else if (mode === 'plan') {
      const planId = Number(field(req.body, 'plan_id'));
      const plan = await getPlanById(db, coach.id, planId);
      if (!plan) {
        res.status(404).send(notFound());
        return;
      }
      const result = await subscribeForBooking(bookingId, plan.price_cents, phone, plan.name);
      await createSubscriptionRecord(db, plan.id, phone, result.id);
      // First month's credit, one consumed immediately by this booking.
      // Renewal (granting credits_per_month again each billing cycle) needs
      // a Connect Hub webhook and is explicitly out of scope for Slice 1.
      const creditId = await createCredit(db, coach.id, phone, null, `plan:${plan.id}`, plan.credits_per_month - 1, null);
      await markBookingBooked(db, bookingId, {
        paymentSource: 'Subscription',
        creditId,
        chargeId: result.id,
        grossCents: plan.price_cents,
      });
    } else {
      res.status(422).send(notFound());
      return;
    }
  } catch {
    // Connect Hub call failed (non-2xx or network error): leave the booking
    // pending and let the parent retry, per this milestone's plan — never a
    // 500, never a silently-lost charge.
    const packages = await getPackagesForCoach(db, coach.id);
    const plans = await getPlansForCoach(db, coach.id);
    const credit = await getCreditBalance(db, coach.id, phone);
    res
      .status(502)
      .send(renderCheckout(coach, ctx.session, bookingId, { packages, plans, credit }, 'Payment failed. Please try again.'));
    return;
  }

  res.redirect(303, `/c/${coach.handle}/checkout/${bookingId}`);
});
