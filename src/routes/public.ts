import { Router } from 'express';
import { getDb } from '../db/client.js';
import { findCoachByHandle } from '../domain/auth.js';
import { html, page } from '../lib/html.js';
import { formatLocal } from './coach.js';
import {
  getPackageById,
  getPlanById,
  getCreditBalance,
  applyCredit as applyCreditDomain,
  processCharge as processChargeRemote,
  processSubscription as processSubscriptionRemote,
  createBooking,
  type BookingRow,
  type ChargeResult,
} from '../domain/pricing.js';

export const publicRouter = Router();

// ---- Screen 8: coach's public page (sessions list) ----

publicRouter.get('/c/:handle', async (req, res) => {
  const db = getDb();
  const coach = await findCoachByHandle(db, req.params.handle);
  if (!coach) {
    res.status(404).send(page('Not found', html`<h1>Not found</h1><p class="muted">No coach at this link.</p>`));
    return;
  }

  const sessions = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
    capacity: number;
    price_cents: number;
    booked: number;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name, st.capacity, st.price_cents,
            coalesce((select count(*) from booking b where b.session_id = s.id and b.status = 'booked'), 0) as booked
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
                ${s.name} — ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left — $${(s.price_cents / 100).toFixed(2)}
              </div>`;
            })}`,
    ),
  );
});
