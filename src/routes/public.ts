import { Router } from 'express';
import { getDb, type DbClient } from '../db/client.js';
import { findCoachByHandle, getConnectRecipientKey, normalizePhone, type CoachRow } from '../domain/auth.js';
import { html, page, raw } from '../lib/html.js';
import { formatLocal } from '../lib/time.js';
import {
  getPackagesForCoach,
  getPackageById,
  getPlansForCoach,
  getPlanById,
  getCreditBalance,
  decrementCredit,
  createPendingBooking,
  getBooking,
  markBookingBooked,
  countBookedForSession,
} from '../domain/pricing.js';
import { checkOverflow, acceptOffer, declineOffer, getOfferByToken } from '../domain/cascade.js';
import { buyerEmail, connectBuyUrl } from '../relay/buy-link.js';

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
                <strong>${formatLocal(s.starts_at_utc, s.tz)}</strong>
                <div class="meta">
                  <span>${s.name}</span>
                  <span>${spotsLeft > 0 ? `${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left · $${(s.price_cents / 100).toFixed(2)}` : 'Full'}</span>
                </div>
                ${spotsLeft > 0
                  ? html`<a class="action" href="/c/${coach.handle}/sessions/${s.id}/book">Book</a>`
                  : raw('')}
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
          <p class="muted">Someone booked the last spot, but you can wait for one to open.</p>
          <form method="post" action="/c/${coach.handle}/sessions/${session.id}/waitlist">
            <input type="hidden" name="athlete_name" value="${athleteName}" />
            <input type="hidden" name="contact_phone" value="${rawPhone}" />
            <input type="hidden" name="contact_email" value="${contactEmail ?? ''}" />
            <button type="submit">Join the waitlist</button>
          </form>
          <a class="action" href="/c/${coach.handle}">See other times</a>`,
      ),
    );
    return;
  }

  const bookingId = await createPendingBooking(db, session.id, athleteName, contactPhone, contactEmail);
  res.redirect(303, `/c/${coach.handle}/checkout/${bookingId}`);
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

  await db.query(
    'insert into waitlist (session_id, contact_phone, athlete_name) values ($1, $2, $3)',
    [session.id, contactPhone, athleteName],
  );

  await checkOverflow(db, session.id);

  res.status(200).send(
    page(
      'On the waitlist',
      html`<h1>You're on the waitlist</h1>
        <p class="muted">${session.name} — ${formatLocal(session.starts_at_utc, session.tz)}. We'll text ${contactPhone} if a spot opens.</p>
        <a class="action" href="/c/${coach.handle}">Back to ${coach.name}'s sessions</a>`,
    ),
  );
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

type CheckoutOptions = {
  packages: Array<{ id: number; name: string; credits: number; price_cents: number }>;
  plans: Array<{ id: number; name: string; price_cents: number; credits_per_month: number }>;
  credit: { remaining: number } | null;
};

function renderCheckout(
  coach: CoachRow,
  session: SessionForBooking,
  bookingId: number,
  options: CheckoutOptions,
  error?: string,
) {
  const action = `/c/${coach.handle}/checkout/${bookingId}`;

  return page(
    'Checkout',
    html`<h1>${session.name}</h1>
      <p class="muted">${formatLocal(session.starts_at_utc, session.tz)}</p>
      <p class="muted">Pay on the Noctusoft hosted page. Apple Pay and cards are there — this app never sees a card.</p>

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

  if (ctx.booking.status !== 'pending') {
    res.status(200).send(renderAlreadyBooked(coach, ctx.session));
    return;
  }

  const mode = field(req.body, 'mode');
  const phone = ctx.booking.contact_phone;
  const recipientKey = getConnectRecipientKey(coach);
  const email = buyerEmail(phone, ctx.booking.contact_email, bookingId);

  try {
    if (mode === 'credit') {
      const credit = await getCreditBalance(db, coach.id, phone);
      if (!credit || !(await decrementCredit(db, credit.id))) {
        const packages = await getPackagesForCoach(db, coach.id);
        const plans = await getPlansForCoach(db, coach.id);
        res
          .status(409)
          .send(
            renderCheckout(
              coach,
              ctx.session,
              bookingId,
              { packages, plans, credit: null },
              'That credit is no longer available.',
            ),
          );
        return;
      }
      await markBookingBooked(db, bookingId, {
        paymentSource: 'PackageCredit',
        creditId: credit.id,
        chargeId: null,
        grossCents: null,
      });
      void checkOverflow(db, ctx.session.id);
      res.redirect(303, `/c/${coach.handle}/checkout/${bookingId}`);
      return;
    }

    if (mode === 'dropin') {
      const url = connectBuyUrl({
        seller: recipientKey,
        amountCents: ctx.session.price_cents,
        bookingId,
        mode: 'dropin',
        email,
        handle: coach.handle,
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
        mode: 'package',
        itemId: pkg.id,
        email,
        handle: coach.handle,
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
        mode: 'plan',
        itemId: plan.id,
        email,
        handle: coach.handle,
      });
      res.redirect(303, url);
      return;
    }

    res.status(422).send(notFound());
  } catch {
    const packages = await getPackagesForCoach(db, coach.id);
    const plans = await getPlansForCoach(db, coach.id);
    const credit = await getCreditBalance(db, coach.id, phone);
    res
      .status(502)
      .send(
        renderCheckout(
          coach,
          ctx.session,
          bookingId,
          { packages, plans, credit },
          'Checkout is not available right now. Please try again.',
        ),
      );
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
  res.status(200).send(renderOfferPage(offer.state));
});

function renderOfferPage(state: string, message?: string) {
  const resolved = state !== 'sent';
  return page(
    'Overflow offer',
    html`<h1>Backup coach needed</h1>
      ${resolved
        ? html`<p class="muted">This offer is no longer open (${state}).</p>`
        : html`<form method="post">
            <button type="submit" name="action" value="accept">Accept</button>
          </form>
          <form method="post">
            <button type="submit" name="action" value="decline">Decline</button>
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
  if (offer.state !== 'sent') {
    res.status(200).send(renderOfferPage(offer.state));
    return;
  }

  if (action === 'accept') {
    const accepted = await acceptOffer(db, offer.id);
    res
      .status(200)
      .send(renderOfferPage(accepted ? 'accepted' : offer.state, accepted ? undefined : 'Too late — someone else already claimed it.'));
    return;
  }
  if (action === 'decline') {
    await declineOffer(db, offer.id);
    res.status(200).send(renderOfferPage('declined'));
    return;
  }
  res.status(422).send(renderOfferPage(offer.state, 'Choose accept or decline.'));
});

// ---- Screen 11: manage booking (M5 self-service) ----

interface BookingWithSession {
  id: number;
  session_id: number;
  athlete_name: string;
  contact_phone: string;
  status: string;
  credit_id: number | null;
  starts_at_utc: string;
  tz: string;
  session_type_name: string;
  coach_handle: string;
}

async function loadBookingByToken(db: DbClient, token: string): Promise<BookingWithSession | null> {
  const result = await db.query<BookingWithSession>(
    `select b.id, b.session_id, b.athlete_name, b.contact_phone, b.status, b.credit_id,
            s.starts_at_utc, s.tz, st.name as session_type_name, c.handle as coach_handle
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

  res.status(200).send(
    page(
      'Manage booking',
      html`<h1>${booking.session_type_name}</h1>
        <p class="muted">${formatLocal(booking.starts_at_utc, booking.tz)}</p>

        <p class="card">
          <strong>Athlete:</strong> ${booking.athlete_name}<br />
          <strong>Status:</strong>
          ${booking.status === 'booked'
            ? html`<span class="good">Confirmed</span>`
            : booking.status === 'cancelled'
              ? html`<span class="muted">Cancelled</span>`
              : html`<span>${booking.status}</span>`}
        </p>

        <h2>Action</h2>
        ${booking.status !== 'cancelled' && cancellationAllowed(booking)
          ? html`<form method="post" action="/booking/${req.params.token}/cancel">
              <button type="submit" class="action">Cancel this booking</button>
            </form>`
          : booking.status === 'cancelled'
            ? raw('')
            : html`<p class="muted">Cancellations are not accepted after the session starts.</p>`}

        <a class="action" href="/c/${booking.coach_handle}">Back to ${booking.coach_handle}'s page</a>`,
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
    await db.query('update credit set remaining = remaining + 1 where id = $1', [booking.credit_id]);
  }

  res.redirect(303, `/booking/${req.params.token}`);
});
