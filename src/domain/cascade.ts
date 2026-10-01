import { randomBytes } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { sendText } from './outbound.js';
import { expireLivePendingForCoach } from './assistantPending.js';
import { clipSms, formatConfirmWhen } from '../lib/time.js';
import { SMS_PURPOSE } from '../config.js';
import { hasActiveConsent, queuePendingConsent } from './sms-consent.js';

export async function sendRosterConsentRequest(
  db: DbClient,
  coachId: number,
  coachName: string,
  phone: string,
): Promise<void> {
  await queuePendingConsent(db, phone, coachId, coachName);
  await sendText(db, {
    to: phone,
    coachId,
    template: 'consent-request',
    body: clipSms(
      `Coachatron: ${coachName} added this number for ${SMS_PURPOSE}. Reply YES to receive these texts. Reply STOP to opt out.`,
    ),
  });
}

export const OVERFLOW_OFFER_TTL_MINUTES = 20;

export async function isOptedOut(db: DbClient, phone: string): Promise<boolean> {
  const result = await db.query<{ phone: string }>('select phone from opt_out where phone = $1', [phone]);
  return result.rows.length > 0;
}

export async function upsertOptOut(db: DbClient, phone: string): Promise<void> {
  await db.query('insert into opt_out (phone) values ($1) on conflict (phone) do nothing', [phone]);
}

/** All cascade-initiated (non-critical) sends go through sendText, which
 * enforces opt-out and consent. */
async function sendUnlessOptedOut(db: DbClient, coachId: number, template: string, to: string, body: string): Promise<void> {
  await sendText(db, { to, body, coachId, template });
}

interface SessionOverflowInfo {
  coachId: number;
  coachPhone: string;
  capacity: number;
  overflowThreshold: number;
  /** "Tue Oct 7, 6:00pm Keeper Group", for the texts. */
  label: string;
  backupPayCents: number | null;
}

async function loadSessionOverflowInfo(db: DbClient, sessionId: number): Promise<SessionOverflowInfo | null> {
  const result = await db.query<{
    coach_id: number;
    coach_phone: string;
    capacity: number;
    capacity_override: number | null;
    overflow_threshold: number;
    starts_at_utc: string | Date;
    tz: string;
    name: string;
    backup_pay_cents: number | null;
  }>(
    `select c.id as coach_id, c.phone as coach_phone, st.capacity, s.capacity_override, st.overflow_threshold,
            s.starts_at_utc, s.tz, st.name, st.backup_pay_cents
     from session s
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const capacity = row.capacity_override ?? row.capacity;
  return {
    coachId: row.coach_id,
    coachPhone: row.coach_phone,
    capacity,
    overflowThreshold: row.overflow_threshold >= 0 ? row.overflow_threshold : capacity,
    label: `${formatConfirmWhen(new Date(row.starts_at_utc).toISOString(), row.tz)} ${row.name}`,
    backupPayCents: row.backup_pay_cents,
  };
}

async function countBooked(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status = 'booked'",
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countWaiting(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>('select count(*)::text as count from waitlist where session_id = $1', [
    sessionId,
  ]);
  return Number(result.rows[0]?.count ?? '0');
}

async function countActiveRoster(db: DbClient, coachId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    'select count(*)::text as count from roster_member where coach_id = $1 and active = true',
    [coachId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** SPEC.md §7.3 step 1: "the session is full AND a second athlete has
 * joined the waitlist" triggers exactly one ask to the coach, never more
 * than one outstanding at a time. Call this after a booking is confirmed
 * AND after a waitlist join — either can be the event that crosses the
 * threshold. */
export async function checkOverflow(db: DbClient, sessionId: number): Promise<void> {
  const info = await loadSessionOverflowInfo(db, sessionId);
  if (!info) return;

  const [booked, waiting, rosterCount] = await Promise.all([
    countBooked(db, sessionId),
    countWaiting(db, sessionId),
    countActiveRoster(db, info.coachId),
  ]);

  if (booked < info.overflowThreshold || waiting < 1 || rosterCount < 1) return;

  const pending = await db.query<{ id: number }>(
    'select id from overflow_ask where session_id = $1 and resolved_at is null',
    [sessionId],
  );
  if (pending.rows.length > 0) return; // already asked, waiting on the coach

  await db.query('insert into overflow_ask (session_id) values ($1)', [sessionId]);
  await expireLivePendingForCoach(db, info.coachId);
  await sendUnlessOptedOut(
    db,
    info.coachId,
    'overflow-ask',
    info.coachPhone,
    clipSms(`Coachatron: ${info.label} is full, ${waiting} waiting. Reply YES and I'll ask your roster.`),
  );
}

/** True once someone has accepted an overflow offer for this session — the
 * cascade is resolved and must not create another offer. */
async function hasAcceptedOffer(db: DbClient, sessionId: number): Promise<boolean> {
  const result = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'accepted'", [
    sessionId,
  ]);
  return result.rows.length > 0;
}

async function resolveAsk(db: DbClient, sessionId: number): Promise<void> {
  await db.query('update overflow_ask set resolved_at = now() where session_id = $1 and resolved_at is null', [
    sessionId,
  ]);
}

/** Coach replied YES (or a prior offer expired/was declined and the
 * cascade needs to move to the next roster member): offers the single
 * highest-priority active, non-opted-out roster member who does not
 * already have a live offer for this session. Never reachable except from
 * a coach YES or an advance of an already-started cascade — SPEC.md §7.3:
 * "the coach's YES is always required before any money or commitment
 * moves." */
export async function startCascade(db: DbClient, sessionId: number): Promise<void> {
  if (await hasAcceptedOffer(db, sessionId)) return;

  await resolveAsk(db, sessionId);

  const info = await loadSessionOverflowInfo(db, sessionId);
  if (!info) return;

  // A roster member who already has ANY offer (sent, accepted, expired, or
  // declined) for this session is excluded, not just one that's currently
  // 'sent' — otherwise an expired offer would make the highest-priority
  // member eligible again and the cascade would loop on them forever
  // instead of advancing to the next person.
  const candidates = await db.query<{ id: number; phone: string }>(
    `select rm.id, rm.phone
     from roster_member rm
     where rm.coach_id = $1
       and rm.active = true
       and not exists (select 1 from opt_out o where o.phone = rm.phone)
       and not exists (
         select 1 from offer o
         where o.roster_member_id = rm.id
           and o.session_id = $2
       )
     order by rm.priority asc, rm.id asc`,
    [info.coachId, sessionId],
  );

  let member: { id: number; phone: string } | null = null;
  for (const row of candidates.rows) {
    if (await hasActiveConsent(db, row.phone)) {
      member = row;
      break;
    }
  }

  if (!member) {
    const alreadyNotified = await db.query<{ id: number }>(
      'select id from overflow_ask where session_id = $1 and exhausted_notified_at is not null',
      [sessionId],
    );
    if (alreadyNotified.rows.length === 0) {
      await db.query(
        'update overflow_ask set exhausted_notified_at = now() where session_id = $1 and exhausted_notified_at is null',
        [sessionId],
      );
      await sendUnlessOptedOut(
        db,
        info.coachId,
        'overflow-exhausted',
        info.coachPhone,
        'Coachatron: nobody on your roster accepted the overflow session.',
      );
    }
    return;
  }

  const expiresAt = new Date(Date.now() + OVERFLOW_OFFER_TTL_MINUTES * 60 * 1000);
  const token = randomBytes(16).toString('hex');

  await db.query(
    "insert into offer (session_id, roster_member_id, expires_at, state, token) values ($1, $2, $3, 'sent', $4)",
    [sessionId, member.id, expiresAt.toISOString(), token],
  );

  await sendUnlessOptedOut(db, info.coachId, 'offer', member.phone, offerText(info, await countBooked(db, sessionId)));
}

function formatPay(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** SPEC.md §7.3 step 3: time, session, headcount, and what it pays. */
function offerText(info: SessionOverflowInfo, booked: number): string {
  const pay = info.backupPayCents ? `, pays ${formatPay(info.backupPayCents)}` : '';
  return clipSms(`Coachatron: ${info.label}, ${booked} athletes${pay}. Reply Y to claim (20 min).`);
}

/** What the offer page (screen 12) shows, the same facts as the text. */
export async function describeOffer(db: DbClient, sessionId: number): Promise<string | null> {
  const info = await loadSessionOverflowInfo(db, sessionId);
  if (!info) return null;
  const booked = await countBooked(db, sessionId);
  const pay = info.backupPayCents ? ` Pays ${formatPay(info.backupPayCents)}.` : '';
  return `${info.label}, ${booked} athletes.${pay}`;
}

/** Declining advances the cascade immediately, without waiting for the
 * offer to expire — SPEC.md §7.3 step 3-4. */
export async function declineOffer(db: DbClient, offerId: number): Promise<void> {
  const result = await db.query<{ session_id: number }>(
    "update offer set state = 'declined' where id = $1 and state = 'sent' returning session_id",
    [offerId],
  );
  if (result.rows.length === 0) return;
  await startCascade(db, result.rows[0].session_id);
}

/** Sets state='accepted' only if the offer is still 'sent', so a race
 * between two YES replies (or a YES arriving after expiry) cannot both
 * succeed. Returns true if this call won the accept. */
export async function acceptOffer(db: DbClient, offerId: number): Promise<boolean> {
  const result = await db.query<{ id: number; session_id: number; roster_member_id: number }>(
    `update offer set state = 'accepted', accepted_at = now()
     where id = $1 and state = 'sent' and expires_at > now()
     returning id, session_id, roster_member_id`,
    [offerId],
  );
  if (result.rows.length === 0) return false;

  const { session_id, roster_member_id } = result.rows[0];
  await db.query('update session set assigned_roster_member_id = $1 where id = $2', [roster_member_id, session_id]);
  await resolveAsk(db, session_id);
  return true;
}

export async function getOfferByToken(
  db: DbClient,
  token: string,
): Promise<{ id: number; sessionId: number; rosterMemberId: number; state: string; expiresAt: string } | null> {
  const result = await db.query<{ id: number; session_id: number; roster_member_id: number; state: string; expires_at: string }>(
    'select id, session_id, roster_member_id, state, expires_at from offer where token = $1',
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, sessionId: row.session_id, rosterMemberId: row.roster_member_id, state: row.state, expiresAt: row.expires_at };
}

/** Marks expired 'sent' offers as 'expired' and advances the cascade for
 * each affected session to the next roster member. Call on a poll/cron
 * tick — tests call it directly with a stubbed clock, no real waiting. */
export async function advanceCascade(db: DbClient, now: Date): Promise<void> {
  const expired = await db.query<{ session_id: number }>(
    "update offer set state = 'expired' where state = 'sent' and expires_at < $1 returning session_id",
    [now.toISOString()],
  );
  const sessionIds = [...new Set(expired.rows.map((r) => r.session_id))];
  for (const sessionId of sessionIds) {
    await startCascade(db, sessionId);
  }
}

/** The coach's YES to the most recent unresolved overflow ask on one of
 * their sessions starts that session's cascade. Coach's NO resolves the ask
 * without starting a cascade, so a later booking surge can ask again. */
export async function findPendingAskSessionForCoach(db: DbClient, coachId: number): Promise<number | null> {
  const result = await db.query<{ session_id: number }>(
    `select oa.session_id
     from overflow_ask oa
     join session s on s.id = oa.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and oa.resolved_at is null
     order by oa.asked_at desc
     limit 1`,
    [coachId],
  );
  return result.rows[0]?.session_id ?? null;
}

export async function resolveAskWithoutCascade(db: DbClient, sessionId: number): Promise<void> {
  await resolveAsk(db, sessionId);
}
