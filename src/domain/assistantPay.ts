import type { DbClient } from '../db/client.js';
import type { Range } from '../lib/input.js';

/** Assistant coach pay (SPEC.md §8.2): what the coach owes the people on
 * their roster for the jobs they accepted. It is the coach's record and
 * nothing else: Coachatron moves no money for it, and nothing here texts or
 * emails anyone.
 *
 * One row per accepted offer (`assistant_pay`), written with the
 * acceptance. The amount is what that offer showed, so a later change to
 * the session type's pay does not reach it. Whether a row is upcoming, owed
 * or cancelled is read from its session each time:
 *   - paid: the coach marked it paid;
 *   - cancelled: the session was cancelled, so nothing is owed;
 *   - owed: the session has started;
 *   - upcoming: it has not. */

/** What the coach can set a session's amount to, in cents: $0 to $10,000. */
export const PAY_AMOUNT_CENTS: Range = { min: 0, max: 1_000_000 };

/** The longest note kept with a payment, in characters. */
export const PAID_NOTE_MAX = 80;

/** The most sessions one assistant's list shows. Totals count them all. */
export const PAY_LIST_LIMIT = 100;

export type AssistantJob = 'second_group' | 'backup';

export type PayState = 'upcoming' | 'owed' | 'paid' | 'cancelled';

/** The state of `assistant_pay ap` joined to its `session s`, as of the
 * instant in parameter `$n`. */
function stateSql(n: number): string {
  return `case when ap.paid_at is not null then 'paid'
               when s.status = 'cancelled' then 'cancelled'
               when s.starts_at_utc <= $${n}::timestamptz then 'owed'
               else 'upcoming' end`;
}

/** Owed: not paid, not cancelled, and the session has started. */
function owedSql(n: number): string {
  return `ap.paid_at is null and s.status <> 'cancelled' and s.starts_at_utc <= $${n}::timestamptz`;
}

/** Writes the pay record of an offer that was just accepted. Call it inside
 * the acceptance's transaction, so the two are kept or dropped together.
 * `sessionId` is the session the assistant coaches: the new second group,
 * or the session a backup coach joins. The amount is the pay the offer was
 * made with; an offer that carries none (one made before offers kept it)
 * takes the session type's pay as it is now. No pay, or a pay of 0, is
 * recorded as no amount set. An offer is recorded once. */
export async function recordAcceptedPay(
  tx: DbClient,
  accepted: { offerId: number; sessionId: number; kind: AssistantJob },
): Promise<void> {
  await tx.query(
    `insert into assistant_pay (coach_id, roster_member_id, offer_id, session_id, kind, amount_cents)
     select st.coach_id, o.roster_member_id, o.id, $2::int, $3::text, nullif(coalesce(o.pay_cents, st.backup_pay_cents), 0)
     from offer o
     join session s on s.id = o.session_id
     join session_type st on st.id = s.session_type_id
     where o.id = $1
     on conflict (offer_id) do nothing`,
    [accepted.offerId, accepted.sessionId, accepted.kind],
  );
}

export interface AssistantPaySummary {
  memberId: number;
  name: string;
  /** False once the assistant was taken off the roster. */
  active: boolean;
  /** Sessions that have happened: owed and paid together. */
  coached: number;
  upcoming: number;
  cancelled: number;
  owedCount: number;
  /** Of the owed sessions, how many have no amount set. */
  owedUnset: number;
  owedCents: number;
  paidCents: number;
}

/** Every assistant with at least one accepted job, on the roster or taken
 * off it, with what they coached, are owed and were paid. People on the
 * roster come first, in priority order. */
export async function summarizeAssistantPay(db: DbClient, coachId: number, now: Date = new Date()): Promise<AssistantPaySummary[]> {
  const result = await db.query<{
    member_id: number;
    name: string;
    active: boolean;
    coached: string;
    upcoming: string;
    cancelled: string;
    owed_count: string;
    owed_unset: string;
    owed_cents: string;
    paid_cents: string;
  }>(
    `select rm.id as member_id, rm.name, rm.active,
            count(*) filter (where p.state in ('owed', 'paid'))::text as coached,
            count(*) filter (where p.state = 'upcoming')::text as upcoming,
            count(*) filter (where p.state = 'cancelled')::text as cancelled,
            count(*) filter (where p.state = 'owed')::text as owed_count,
            count(*) filter (where p.state = 'owed' and p.amount_cents is null)::text as owed_unset,
            coalesce(sum(p.amount_cents) filter (where p.state = 'owed'), 0)::text as owed_cents,
            coalesce(sum(p.amount_cents) filter (where p.state = 'paid'), 0)::text as paid_cents
     from (
       select ap.roster_member_id, ap.amount_cents, ${stateSql(2)} as state
       from assistant_pay ap
       join session s on s.id = ap.session_id
       where ap.coach_id = $1
     ) p
     join roster_member rm on rm.id = p.roster_member_id
     group by rm.id, rm.name, rm.active, rm.priority
     order by rm.active desc, rm.priority asc, rm.id asc`,
    [coachId, now.toISOString()],
  );
  return result.rows.map((r) => ({
    memberId: r.member_id,
    name: r.name,
    active: r.active,
    coached: Number(r.coached),
    upcoming: Number(r.upcoming),
    cancelled: Number(r.cancelled),
    owedCount: Number(r.owed_count),
    owedUnset: Number(r.owed_unset),
    owedCents: Number(r.owed_cents),
    paidCents: Number(r.paid_cents),
  }));
}

export interface AssistantPayRow {
  id: number;
  kind: AssistantJob;
  state: PayState;
  /** Null: no amount set. */
  amountCents: number | null;
  startsAtUtc: string;
  tz: string;
  sessionName: string;
  paidAt: string | null;
  paidNote: string | null;
}

/** One assistant's sessions: what is owed first (oldest first), then what
 * is coming (soonest first), then what was paid and what was cancelled
 * (latest first). At most PAY_LIST_LIMIT of them. Empty for an assistant
 * who is not this coach's. */
export async function listAssistantPay(db: DbClient, coachId: number, memberId: number, now: Date = new Date()): Promise<AssistantPayRow[]> {
  const result = await db.query<{
    id: number;
    kind: AssistantJob;
    state: PayState;
    amount_cents: number | null;
    starts_at_utc: string | Date;
    tz: string;
    session_name: string;
    paid_at: string | Date | null;
    paid_note: string | null;
  }>(
    `select p.*
     from (
       select ap.id, ap.kind, ap.amount_cents, ap.paid_at, ap.paid_note, s.starts_at_utc, s.tz, st.name as session_name,
              ${stateSql(3)} as state
       from assistant_pay ap
       join session s on s.id = ap.session_id
       join session_type st on st.id = s.session_type_id
       where ap.coach_id = $1 and ap.roster_member_id = $2
     ) p
     order by case p.state when 'owed' then 0 when 'upcoming' then 1 when 'paid' then 2 else 3 end,
              case when p.state in ('owed', 'upcoming') then p.starts_at_utc end asc,
              p.starts_at_utc desc,
              p.id desc
     limit $4`,
    [coachId, memberId, now.toISOString(), PAY_LIST_LIMIT],
  );
  return result.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    amountCents: r.amount_cents,
    startsAtUtc: new Date(r.starts_at_utc).toISOString(),
    tz: r.tz,
    sessionName: r.session_name,
    paidAt: r.paid_at === null ? null : new Date(r.paid_at).toISOString(),
    paidNote: r.paid_note,
  }));
}

/** What the coach owes all their assistants together, in cents: the owed
 * sessions that have an amount. */
export async function owedToAssistantsCents(db: DbClient, coachId: number, now: Date = new Date()): Promise<number> {
  const result = await db.query<{ cents: string }>(
    `select coalesce(sum(ap.amount_cents), 0)::text as cents
     from assistant_pay ap
     join session s on s.id = ap.session_id
     where ap.coach_id = $1 and ${owedSql(2)}`,
    [coachId, now.toISOString()],
  );
  return Number(result.rows[0]?.cents ?? '0');
}

/** True for someone on this coach's roster, now or before. */
export async function isAssistantOf(db: DbClient, coachId: number, memberId: number): Promise<boolean> {
  const member = await db.query<{ id: number }>('select id from roster_member where id = $1 and coach_id = $2', [memberId, coachId]);
  return member.rows.length > 0;
}

/** The assistant a pay row belongs to, or null when the row is not this
 * coach's. */
export async function payRowAssistant(db: DbClient, coachId: number, payId: number): Promise<number | null> {
  const result = await db.query<{ roster_member_id: number }>('select roster_member_id from assistant_pay where id = $1 and coach_id = $2', [
    payId,
    coachId,
  ]);
  return result.rows[0]?.roster_member_id ?? null;
}

/** What became of a change the coach asked for on one session's pay. */
export type PayChange =
  /** Done, or it was already so. */
  | { kind: 'ok'; memberId: number }
  /** No such row for this coach. */
  | { kind: 'not_found' }
  /** The row is in a state the change does not apply to. */
  | { kind: 'refused'; memberId: number; state: PayState };

/** The row's assistant and state, for this coach only. */
async function payRowState(
  db: DbClient,
  coachId: number,
  payId: number,
  now: Date,
): Promise<{ memberId: number; state: PayState } | null> {
  const result = await db.query<{ roster_member_id: number; state: PayState }>(
    `select ap.roster_member_id, ${stateSql(3)} as state
     from assistant_pay ap
     join session s on s.id = ap.session_id
     where ap.id = $1 and ap.coach_id = $2`,
    [payId, coachId, now.toISOString()],
  );
  const row = result.rows[0];
  return row ? { memberId: row.roster_member_id, state: row.state } : null;
}

/** Why a guarded update changed nothing: the row is not this coach's, or it
 * is in another state. `fine` names a state in which the change was not
 * needed, which counts as done. */
async function unchanged(db: DbClient, coachId: number, payId: number, now: Date, fine: PayState | null): Promise<PayChange> {
  const row = await payRowState(db, coachId, payId, now);
  if (!row) return { kind: 'not_found' };
  if (row.state === fine) return { kind: 'ok', memberId: row.memberId };
  return { kind: 'refused', memberId: row.memberId, state: row.state };
}

/** Sets or changes a session's amount. Only before it is marked paid, and
 * not for a cancelled session, which owes nothing. The check and the write
 * are one statement, so an amount never changes under a payment that was
 * marked at the same moment. */
export async function setPayAmount(db: DbClient, coachId: number, payId: number, amountCents: number, now: Date = new Date()): Promise<PayChange> {
  const updated = await db.query<{ roster_member_id: number }>(
    `update assistant_pay ap set amount_cents = $3
     from session s
     where ap.id = $1 and ap.coach_id = $2 and s.id = ap.session_id
       and ap.paid_at is null and s.status <> 'cancelled'
     returning ap.roster_member_id`,
    [payId, coachId, amountCents],
  );
  if (updated.rows[0]) return { kind: 'ok', memberId: updated.rows[0].roster_member_id };
  return unchanged(db, coachId, payId, now, null);
}

/** Marks one owed session paid, with the date and the coach's note. A
 * session already marked paid stays as it was marked. */
export async function markPaid(db: DbClient, coachId: number, payId: number, note: string | null, now: Date = new Date()): Promise<PayChange> {
  const updated = await db.query<{ roster_member_id: number }>(
    `update assistant_pay ap set paid_at = $3::timestamptz, paid_note = $4
     from session s
     where ap.id = $1 and ap.coach_id = $2 and s.id = ap.session_id and ${owedSql(3)}
     returning ap.roster_member_id`,
    [payId, coachId, now.toISOString(), note],
  );
  if (updated.rows[0]) return { kind: 'ok', memberId: updated.rows[0].roster_member_id };
  return unchanged(db, coachId, payId, now, 'paid');
}

/** Marks every owed session of one assistant paid, with one date and one
 * note. Returns how many it marked, or null when the assistant is not this
 * coach's. Upcoming and cancelled sessions are left alone. */
export async function markAllPaid(db: DbClient, coachId: number, memberId: number, note: string | null, now: Date = new Date()): Promise<number | null> {
  if (!(await isAssistantOf(db, coachId, memberId))) return null;
  const updated = await db.query<{ id: number }>(
    `update assistant_pay ap set paid_at = $3::timestamptz, paid_note = $4
     from session s
     where ap.coach_id = $1 and ap.roster_member_id = $2 and s.id = ap.session_id and ${owedSql(3)}
     returning ap.id`,
    [coachId, memberId, now.toISOString(), note],
  );
  return updated.rows.length;
}

/** Takes a payment back: the session is owed again, and its date and note
 * are gone. A session that is not marked paid stays as it is. */
export async function undoPaid(db: DbClient, coachId: number, payId: number, now: Date = new Date()): Promise<PayChange> {
  const updated = await db.query<{ roster_member_id: number }>(
    `update assistant_pay set paid_at = null, paid_note = null
     where id = $1 and coach_id = $2 and paid_at is not null
     returning roster_member_id`,
    [payId, coachId],
  );
  if (updated.rows[0]) return { kind: 'ok', memberId: updated.rows[0].roster_member_id };
  const row = await payRowState(db, coachId, payId, now);
  return row ? { kind: 'ok', memberId: row.memberId } : { kind: 'not_found' };
}
