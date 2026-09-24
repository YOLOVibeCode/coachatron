import type { DbClient } from '../../src/db/client.js';
import { createCoach, type CoachRow } from '../../src/domain/auth.js';
import crypto from 'node:crypto';

export interface SeededSession {
  coach: CoachRow;
  sessionTypeId: number;
  sessionId: number;
  priceCents: number;
  capacity: number;
}

/** Seeds a coach, one session type, and one future session directly (no
 * HTTP round trip) so payment tests can focus on checkout, not sign-in. */
export async function seedCoachWithSession(
  db: DbClient,
  opts: { capacity?: number; priceCents?: number } = {},
): Promise<SeededSession> {
  const capacity = opts.capacity ?? 2;
  const priceCents = opts.priceCents ?? 3500;

  const coach = await createCoach(db, {
    phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
    name: 'Jamie Coach',
    email: 'jamie@example.com',
    tz: 'America/Chicago',
  });
  await db.query("update coach set connect_status = 'ready' where id = $1", [coach.id]);
  coach.connect_status = 'ready';

  const typeResult = await db.query<{ id: number }>(
    `insert into session_type (coach_id, name, duration_min, capacity, price_cents, active)
     values ($1, 'Goalkeeper Group', 60, $2, $3, true)
     returning id`,
    [coach.id, capacity, priceCents],
  );
  const sessionTypeId = typeResult.rows[0].id;

  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sessionResult = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, $2, 'America/Chicago', 'scheduled')
     returning id`,
    [sessionTypeId, startsAt],
  );

  return { coach, sessionTypeId, sessionId: sessionResult.rows[0].id, priceCents, capacity };
}

export async function seedPackage(db: DbClient, coachId: number, credits: number, priceCents: number): Promise<number> {
  const result = await db.query<{ id: number }>(
    `insert into package (coach_id, name, credits, price_cents, active)
     values ($1, '10-pack', $2, $3, true)
     returning id`,
    [coachId, credits, priceCents],
  );
  return result.rows[0].id;
}

export async function seedPlan(db: DbClient, coachId: number, creditsPerMonth: number, priceCents: number): Promise<number> {
  const stripePriceId = `price_test_${coachId}_${priceCents}`;
  const result = await db.query<{ id: number }>(
    `insert into plan (coach_id, name, price_cents, credits_per_month, stripe_price_id, active)
     values ($1, 'Monthly', $2, $3, $4, true)
     returning id`,
    [coachId, priceCents, creditsPerMonth, stripePriceId],
  );
  return result.rows[0].id;
}

export interface SeededRosterMember {
  id: number;
  phone: string;
}

export async function seedRosterMember(
  db: DbClient,
  coachId: number,
  name: string,
  priority: number,
): Promise<SeededRosterMember> {
  const phone = `+1777${Math.floor(1000000 + Math.random() * 8999999)}`;
  const result = await db.query<{ id: number }>(
    `insert into roster_member (coach_id, name, phone, priority, active)
     values ($1, $2, $3, $4, true)
     returning id`,
    [coachId, name, phone, priority],
  );
  return { id: result.rows[0].id, phone };
}

/** Books a session directly (bypassing checkout) so cascade tests can set
 * up a full session without exercising the whole M3 payment flow. */
export async function seedBookedSession(db: DbClient, sessionId: number, athleteName: string, contactPhone: string): Promise<number> {
  const manageToken = crypto.randomBytes(32).toString('hex');
  const result = await db.query<{ id: number }>(
    `insert into booking (session_id, athlete_name, contact_phone, payment_source, gross_cents, status, manage_token)
     values ($1, $2, $3, 'DropIn', 0, 'booked', $4)
     returning id`,
    [sessionId, athleteName, contactPhone, manageToken],
  );
  return result.rows[0].id;
}

export async function seedWaitlistEntry(db: DbClient, sessionId: number, athleteName: string, contactPhone: string): Promise<void> {
  await db.query('insert into waitlist (session_id, contact_phone, athlete_name) values ($1, $2, $3)', [
    sessionId,
    contactPhone,
    athleteName,
  ]);
}
