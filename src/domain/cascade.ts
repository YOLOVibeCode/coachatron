import { randomBytes } from 'node:crypto';
import { inTransaction, type DbClient } from '../db/client.js';
import { OPT_OUT_LINE, sendEmailMessage, sendText, toOneSegment } from './outbound.js';
import { APP_BASE_URL } from '../config.js';
import { expireLivePendingForCoach } from './assistantPending.js';
import { formatConfirmWhen } from '../lib/time.js';
import { hasActiveConsent } from './sms-consent.js';
import { plain, textWithLink } from './bookingMessages.js';
import { newBookingToken } from './pricing.js';
import { holdSpotsForWaitlist, offerOpenSpots, sendHeldSpots, spotOffersWaitForMorning, type SpotOffers } from './waitlist.js';

/** The overflow cascade (SPEC.md §7.3). A full session with someone
 * waiting asks the coach one question: open a second group, add a backup
 * coach, or no. On either job the roster is offered it one person at a
 * time, in priority order, each offer open for a short while. The first
 * acceptance takes the job and ends the cascade. Nothing is offered to
 * anyone until the coach has chosen. */

export const OVERFLOW_OFFER_TTL_MINUTES = 20;

/** The two jobs a coach can ask the roster for. */
export type OverflowKind = 'second_group' | 'backup';

/** The coach's answer to an overflow ask. */
export type OverflowAnswer = OverflowKind | 'no';

export async function isOptedOut(db: DbClient, phone: string): Promise<boolean> {
  const result = await db.query<{ phone: string }>('select phone from opt_out where phone = $1', [phone]);
  return result.rows.length > 0;
}

export async function upsertOptOut(db: DbClient, phone: string): Promise<void> {
  await db.query('insert into opt_out (phone) values ($1) on conflict (phone) do nothing', [phone]);
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? APP_BASE_URL).replace(/\/$/, '');
}

/** What the coach is told: a one-segment text, and the email a coach who
 * gets no texts receives instead. */
interface CoachNotice {
  text: string;
  subject: string;
  email: string;
}

/** Tells the coach about their session: a text to their mobile, or, for a
 * coach with no mobile or who has not turned texts on, an email that links
 * to the schedule, where the same question and buttons wait. A failed send
 * is logged and never undoes what happened. */
async function notifyCoach(
  db: DbClient,
  info: Pick<SessionOverflowInfo, 'coachId' | 'coachPhone' | 'coachEmail'>,
  template: string,
  notice: CoachNotice,
): Promise<void> {
  try {
    if (info.coachPhone) {
      const outcome = await sendText(db, { to: info.coachPhone, body: notice.text, coachId: info.coachId, template });
      if (outcome !== 'refused') return;
    }
    if (!info.coachEmail) return;
    await sendEmailMessage(db, {
      to: info.coachEmail,
      subject: notice.subject,
      text: `${notice.email}\n\nYour schedule: ${appBaseUrl()}/app/schedule`,
      coachId: info.coachId,
      template,
    });
  } catch (err) {
    console.error(`overflow: ${template} to the coach failed:`, err instanceof Error ? err.message : err);
  }
}

interface SessionOverflowInfo {
  sessionId: number;
  coachId: number;
  coachPhone: string | null;
  coachEmail: string | null;
  status: string;
  startsAtUtc: string;
  tz: string;
  name: string;
  locationText: string | null;
  /** The session's own capacity: the type's, or what it was set to. */
  capacity: number;
  typeCapacity: number;
  overflowThreshold: number;
  /** "Tue Oct 7, 6:00pm Skills Group", for pages and emails. */
  label: string;
  backupPayCents: number | null;
}

async function loadSessionOverflowInfo(db: DbClient, sessionId: number): Promise<SessionOverflowInfo | null> {
  const result = await db.query<{
    coach_id: number;
    coach_phone: string | null;
    coach_email: string;
    status: string;
    capacity: number;
    capacity_override: number | null;
    overflow_threshold: number;
    starts_at_utc: string | Date;
    tz: string;
    name: string;
    location_text: string | null;
    backup_pay_cents: number | null;
  }>(
    `select c.id as coach_id, c.phone as coach_phone, c.email as coach_email, s.status, st.capacity, s.capacity_override,
            st.overflow_threshold, s.starts_at_utc, s.tz, st.name, s.location_text, st.backup_pay_cents
     from session s
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const capacity = row.capacity_override ?? row.capacity;
  const startsAtUtc = new Date(row.starts_at_utc).toISOString();
  return {
    sessionId,
    coachId: row.coach_id,
    coachPhone: row.coach_phone,
    coachEmail: row.coach_email || null,
    status: row.status,
    startsAtUtc,
    tz: row.tz,
    name: row.name,
    locationText: row.location_text,
    capacity,
    typeCapacity: row.capacity,
    overflowThreshold: row.overflow_threshold >= 0 ? row.overflow_threshold : capacity,
    label: `${formatConfirmWhen(startsAtUtc, row.tz)} ${row.name}`,
    backupPayCents: row.backup_pay_cents,
  };
}

/** Open for overflow: scheduled and not started. */
function sessionOpen(info: Pick<SessionOverflowInfo, 'status' | 'startsAtUtc'>, now: Date = new Date()): boolean {
  return info.status === 'scheduled' && new Date(info.startsAtUtc) > now;
}

/** "Tue Oct 7 6pm" or "Tue Oct 7 6:30pm": the compact time a text has room for. */
function compactWhen(info: Pick<SessionOverflowInfo, 'startsAtUtc' | 'tz'>): string {
  return formatConfirmWhen(info.startsAtUtc, info.tz).replace(',', '').replace(':00', '');
}

/** One segment that always keeps `tail` whole, shortening the words
 * before it instead and leaving room for the opt-out line. */
function keepTail(head: string, tail: string): string {
  return `${toOneSegment(plain(head), tail.length + OPT_OUT_LINE.length + 1)}${tail}`;
}

async function countBooked(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "select count(*)::text as count from booking where session_id = $1 and status in ('booked', 'attended', 'noshow')",
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Athletes on the session's waitlist who have not been offered a spot yet. */
export async function countWaiting(db: DbClient, sessionId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "select count(*)::text as count from waitlist where session_id = $1 and state = 'waiting'",
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function countActiveRoster(db: DbClient, coachId: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    'select count(*)::text as count from roster_member where coach_id = $1 and active = true',
    [coachId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

// ---- the coach's question -------------------------------------------------

/** "Tue Oct 7 6pm Skills Group is full with 3 waiting. Reply 1 to open a
 * second group, 2 to add a backup coach, N for no." The session's name is
 * what gets shortened, never the choices. */
export function overflowAskText(info: Pick<SessionOverflowInfo, 'startsAtUtc' | 'tz' | 'name'>, waiting: number): string {
  return keepTail(
    `Coachatron: ${compactWhen(info)} ${info.name}`,
    ` is full with ${waiting} waiting. Reply 1 to open a second group, 2 to add a backup coach, N for no.`,
  );
}

/** The coach's unanswered question, if any, on a session that is still
 * open. A coach has at most one in front of them at a time. */
async function openAsk(db: DbClient, coachId: number, sessionId: number | null): Promise<{ id: number; sessionId: number } | null> {
  const result = await db.query<{ id: number; session_id: number }>(
    `select oa.id, oa.session_id
     from overflow_ask oa
     join session s on s.id = oa.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and ($2::int is null or oa.session_id = $2)
       and oa.resolved_at is null and oa.closed_at is null
       and s.status = 'scheduled' and s.starts_at_utc > now()
     order by oa.asked_at desc
     limit 1`,
    [coachId, sessionId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, sessionId: row.session_id } : null;
}

/** SPEC.md §7.3 step 1: "the session is full AND a second athlete has
 * joined the waitlist" asks the coach once. A session is asked about once:
 * not again while its roster is being asked, after someone accepted, or
 * after the coach said no. A coach answers one question at a time, so a
 * second full session waits until the first is answered. Call this after a
 * booking and after a waitlist join: either can cross the threshold. */
export async function checkOverflow(db: DbClient, sessionId: number): Promise<void> {
  const info = await loadSessionOverflowInfo(db, sessionId);
  if (!info || !sessionOpen(info)) return;

  const [booked, waiting, rosterCount] = await Promise.all([
    countBooked(db, sessionId),
    countWaiting(db, sessionId),
    countActiveRoster(db, info.coachId),
  ]);
  if (booked < info.overflowThreshold || waiting < 1 || rosterCount < 1) return;

  const asked = await db.query<{ id: number }>('select id from overflow_ask where session_id = $1 limit 1', [sessionId]);
  if (asked.rows.length > 0) return;
  if (await openAsk(db, info.coachId, null)) return;

  const created = await db.query<{ id: number }>(
    `insert into overflow_ask (session_id)
     select $1 where not exists (select 1 from overflow_ask where session_id = $1)
     on conflict do nothing
     returning id`,
    [sessionId],
  );
  if (created.rows.length === 0) return;

  await expireLivePendingForCoach(db, info.coachId);
  await notifyCoach(db, info, 'overflow-ask', {
    text: overflowAskText(info, waiting),
    subject: `${info.label} is full, ${waiting} waiting`,
    email: `${info.label} is full with ${waiting} waiting. On your schedule, choose to open a second group, add a backup coach, or not now. We'll ask your roster one at a time.`,
  });
}

/** After the coach answers, the next full session of theirs, if any, gets
 * its question. */
async function askAboutNextFullSession(db: DbClient, coachId: number): Promise<void> {
  const next = await db.query<{ id: number }>(
    `select s.id
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
       and exists (select 1 from waitlist w where w.session_id = s.id and w.state = 'waiting')
       and not exists (select 1 from overflow_ask oa where oa.session_id = s.id)
     order by s.starts_at_utc
     limit 20`,
    [coachId],
  );
  for (const row of next.rows) {
    await checkOverflow(db, row.id);
    if (await openAsk(db, coachId, null)) return;
  }
}

/** The coach's answer, by text or on the schedule, to their open question
 * (or, with `sessionId`, to the question on that session). Only the coach's
 * own unanswered question on an open session can be answered. Returns the
 * session answered, or null when there was nothing to answer. */
export async function answerAsk(
  db: DbClient,
  coachId: number,
  answer: OverflowAnswer,
  sessionId: number | null = null,
): Promise<number | null> {
  const ask = await openAsk(db, coachId, sessionId);
  if (!ask) return null;
  if (answer === 'no') {
    await db.query(
      `update overflow_ask set resolved_at = now(), closed_at = now(), outcome = 'declined'
       where id = $1 and resolved_at is null and closed_at is null`,
      [ask.id],
    );
  } else {
    await startCascade(db, ask.sessionId, answer);
  }
  await askAboutNextFullSession(db, coachId);
  return ask.sessionId;
}

export interface PendingAsk {
  sessionId: number;
  label: string;
  waiting: number;
}

/** The coach's open overflow question, for the schedule screen: the same
 * question the text asks, answered with the same three choices. */
export async function pendingAskForCoach(db: DbClient, coachId: number): Promise<PendingAsk | null> {
  const ask = await openAsk(db, coachId, null);
  if (!ask) return null;
  const info = await loadSessionOverflowInfo(db, ask.sessionId);
  if (!info) return null;
  return { sessionId: ask.sessionId, label: info.label, waiting: await countWaiting(db, ask.sessionId) };
}

/** Whether the coach has an unanswered question an inbound 1, 2 or N answers. */
export async function hasOpenAsk(db: DbClient, coachId: number): Promise<boolean> {
  return (await openAsk(db, coachId, null)) !== null;
}

// ---- asking the roster -----------------------------------------------------

interface RunningAsk {
  id: number;
  kind: OverflowKind;
  /** True when this call recorded the coach's choice. */
  began?: boolean;
}

/** Records the coach's choice on the session's live ask, or starts one
 * already answered (the text assistant's "ask my roster"). A session someone
 * already took gets no second overflow, and an ask already under way keeps
 * the job it was started with. Without `kind`, only an ask already under
 * way is found. */
async function runningAsk(db: DbClient, sessionId: number, kind: OverflowKind | undefined): Promise<RunningAsk | null> {
  const accepted = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'accepted' limit 1", [
    sessionId,
  ]);
  if (accepted.rows.length > 0) return null;

  const live = await db.query<{ id: number; kind: OverflowKind | null }>(
    'select id, kind from overflow_ask where session_id = $1 and closed_at is null',
    [sessionId],
  );
  const current = live.rows[0];
  if (current?.kind) return { id: current.id, kind: current.kind };
  if (!kind) return null;
  if (current) {
    await db.query('update overflow_ask set kind = $2, resolved_at = coalesce(resolved_at, now()) where id = $1 and kind is null', [
      current.id,
      kind,
    ]);
  } else {
    await db.query(
      `insert into overflow_ask (session_id, kind, resolved_at) values ($1, $2, now())
       on conflict do nothing`,
      [sessionId, kind],
    );
  }
  const now = await db.query<{ id: number; kind: OverflowKind | null }>(
    'select id, kind from overflow_ask where session_id = $1 and closed_at is null',
    [sessionId],
  );
  const row = now.rows[0];
  return row?.kind ? { id: row.id, kind: row.kind, began: true } : null;
}

/** Starts the roster on the coach's chosen job (`kind`), or, without one,
 * moves a cascade already under way to the next person: after an offer
 * expired or was declined. Never reachable except from the coach's choice
 * or an advance of a cascade it started — SPEC.md §7.3: "the coach's YES is
 * always required before any money or commitment moves." */
export async function startCascade(db: DbClient, sessionId: number, kind?: OverflowKind): Promise<void> {
  const info = await loadSessionOverflowInfo(db, sessionId);
  if (!info) return;
  if (!sessionOpen(info)) {
    await endOverflowForSession(db, sessionId, info.status === 'cancelled' ? 'cancelled' : 'ended');
    return;
  }
  const ask = await runningAsk(db, sessionId, kind);
  if (!ask) return;
  if (ask.began) await tellCoachWhoCannotBeAsked(db, info, ask);
  await offerToNextMember(db, info, ask);
}

// ---- roster members who cannot get texts ---------------------------------

export interface UnreachableMember {
  id: number;
  name: string;
  /** Their opt-in link (screen 12, in its opt-in state), to share with them. */
  link: string;
}

/** The link a roster member opens to opt in to texts. Made the first time
 * it is needed and kept. */
export async function rosterOptInLink(db: DbClient, memberId: number): Promise<string> {
  const result = await db.query<{ optin_token: string }>(
    'update roster_member set optin_token = coalesce(optin_token, $2) where id = $1 returning optin_token',
    [memberId, newBookingToken()],
  );
  return `${appBaseUrl()}/offer/${result.rows[0].optin_token}`;
}

/** Active roster members, in priority order, who cannot be texted an offer:
 * they have not opted in, or they replied STOP. */
export async function unreachableRoster(db: DbClient, coachId: number): Promise<{ unreachable: UnreachableMember[]; reachable: number }> {
  const members = await db.query<{ id: number; name: string; phone: string }>(
    'select id, name, phone from roster_member where coach_id = $1 and active = true order by priority asc, id asc',
    [coachId],
  );
  const unreachable: UnreachableMember[] = [];
  let reachable = 0;
  for (const m of members.rows) {
    if (await hasActiveConsent(db, m.phone)) reachable += 1;
    else unreachable.push({ id: m.id, name: m.name, link: await rosterOptInLink(db, m.id) });
  }
  return { unreachable, reachable };
}

/** Says who on the roster was not asked because they cannot get texts,
 * with the link to send them: one person's own link, or for several, the
 * roster screen where each one's link is. */
function unreachableNotice(people: UnreachableMember[], lead: string): { text: string; email: string } {
  const first = plain(people[0].name) || 'One person';
  const text =
    people.length === 1
      ? textWithLink(`${lead} ${first} can't get texts yet, so wasn't asked. Send them this to opt in:`, people[0].link)
      : textWithLink(
          `${lead} ${first} and ${people.length - 1} more on your roster can't get texts yet, so weren't asked. Their opt-in links:`,
          `${appBaseUrl()}/app/roster`,
        );
  const email = `Not asked, because they can't get texts yet. Send each one their link to opt in:\n${people
    .map((p) => `- ${p.name}: ${p.link}`)
    .join('\n')}`;
  return { text, email };
}

/** When the coach's choice starts the roster, the coach hears once who
 * will not be asked because they cannot get texts. When nobody can, the
 * message that nobody was asked says it instead. */
async function tellCoachWhoCannotBeAsked(db: DbClient, info: SessionOverflowInfo, ask: RunningAsk): Promise<void> {
  const { unreachable, reachable } = await unreachableRoster(db, info.coachId);
  if (unreachable.length === 0 || reachable === 0) return;
  const claimed = await db.query<{ id: number }>(
    'update overflow_ask set unreachable_told_at = now() where id = $1 and unreachable_told_at is null returning id',
    [ask.id],
  );
  if (claimed.rows.length === 0) return;
  const notice = unreachableNotice(unreachable, 'Coachatron:');
  await notifyCoach(db, info, 'overflow-unreachable', {
    text: notice.text,
    subject: `Not everyone on your roster could be asked about ${info.label}`,
    email: `We're asking your roster about ${ask.kind === 'second_group' ? 'a second group' : 'a backup coach'} for ${info.label}.\n\n${notice.email}`,
  });
}

type NextStep =
  | { kind: 'offered'; offerId: number; phone: string }
  | { kind: 'waiting' }
  | { kind: 'exhausted'; anyoneAsked: boolean }
  | { kind: 'closed' };

/** Offers the job to the highest-priority active roster member who can get
 * texts and has not been offered it yet. One offer is out at a time: the
 * ask's row is locked while the next one is chosen, so two advances at the
 * same moment cannot both send one. An offer that cannot be sent passes to
 * the next person at once. */
async function offerToNextMember(db: DbClient, info: SessionOverflowInfo, ask: RunningAsk): Promise<void> {
  for (;;) {
    const step = await inTransaction(db, async (tx): Promise<NextStep> => {
      const locked = await tx.query<{ closed_at: string | null }>('select closed_at from overflow_ask where id = $1 for update', [ask.id]);
      if (!locked.rows[0] || locked.rows[0].closed_at) return { kind: 'closed' };
      await tx.query("update offer set state = 'expired' where ask_id = $1 and state = 'sent' and expires_at <= now()", [ask.id]);
      const live = await tx.query<{ id: number }>("select id from offer where ask_id = $1 and state = 'sent'", [ask.id]);
      if (live.rows.length > 0) return { kind: 'waiting' };

      // Anyone already offered this job (whatever became of it) is passed
      // over, so an expired offer moves on instead of coming back to them.
      const candidates = await tx.query<{ id: number; phone: string }>(
        `select rm.id, rm.phone
         from roster_member rm
         where rm.coach_id = $1 and rm.active = true
           and not exists (
             select 1 from offer o
             where o.roster_member_id = rm.id and o.session_id = $2 and (o.ask_id = $3 or o.ask_id is null)
           )
         order by rm.priority asc, rm.id asc`,
        [info.coachId, info.sessionId, ask.id],
      );
      let member: { id: number; phone: string } | null = null;
      for (const row of candidates.rows) {
        if (await hasActiveConsent(tx, row.phone)) {
          member = row;
          break;
        }
      }
      if (!member) {
        await tx.query("update overflow_ask set closed_at = now(), outcome = 'exhausted' where id = $1 and closed_at is null", [
          ask.id,
        ]);
        const asked = await tx.query<{ id: number }>("select id from offer where ask_id = $1 and state <> 'unsent' limit 1", [ask.id]);
        return { kind: 'exhausted', anyoneAsked: asked.rows.length > 0 };
      }
      const inserted = await tx.query<{ id: number }>(
        `insert into offer (session_id, roster_member_id, expires_at, state, token, kind, ask_id)
         values ($1, $2, now() + make_interval(mins => $3::int), 'sent', $4, $5, $6)
         returning id`,
        [info.sessionId, member.id, OVERFLOW_OFFER_TTL_MINUTES, randomBytes(16).toString('hex'), ask.kind, ask.id],
      );
      return { kind: 'offered', offerId: inserted.rows[0].id, phone: member.phone };
    });

    if (step.kind === 'closed' || step.kind === 'waiting') return;
    if (step.kind === 'exhausted') {
      await tellCoachExhausted(db, info, ask, step.anyoneAsked);
      return;
    }
    let outcome: string;
    try {
      outcome = await sendText(db, {
        to: step.phone,
        body: offerText(info, ask.kind, await countBooked(db, info.sessionId)),
        coachId: info.coachId,
        template: 'offer',
      });
    } catch (err) {
      outcome = 'failed';
      console.error('overflow: offer text failed:', err instanceof Error ? err.message : err);
    }
    if (outcome === 'sent') return;
    await db.query("update offer set state = 'unsent' where id = $1 and state = 'sent'", [step.offerId]);
  }
}

/** Told once per ask, when nobody is left to offer the job to. */
async function tellCoachExhausted(db: DbClient, info: SessionOverflowInfo, ask: RunningAsk, anyoneAsked: boolean): Promise<void> {
  const claimed = await db.query<{ id: number }>(
    'update overflow_ask set exhausted_notified_at = now() where id = $1 and exhausted_notified_at is null returning id',
    [ask.id],
  );
  if (claimed.rows.length === 0) return;
  const job = ask.kind === 'second_group' ? 'the second group' : 'the backup spot';
  if (anyoneAsked) {
    await notifyCoach(db, info, 'overflow-exhausted', {
      text: keepTail(`Coachatron: ${compactWhen(info)} ${info.name}`, `: nobody on your roster took ${job}.`),
      subject: `Nobody on your roster took ${job}`,
      email: `Nobody on your roster took ${job} for ${info.label}.`,
    });
    return;
  }
  const { unreachable } = await unreachableRoster(db, info.coachId);
  if (unreachable.length > 0) {
    const notice = unreachableNotice(unreachable, `Coachatron: ${compactWhen(info)}: nobody asked.`);
    await notifyCoach(db, info, 'overflow-exhausted', {
      text: notice.text,
      subject: 'Nobody on your roster could be asked',
      email: `Nobody on your roster could be asked about ${job} for ${info.label}.\n\n${notice.email}`,
    });
    return;
  }
  await notifyCoach(db, info, 'overflow-exhausted', {
    text: keepTail(`Coachatron: ${compactWhen(info)} ${info.name}`, `: nobody on your roster could get the offer.`),
    subject: 'Nobody on your roster could be asked',
    email: `Nobody on your roster could get the offer for ${job} for ${info.label}.`,
  });
}

function formatPay(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function athletes(n: number): string {
  return `${n} ${n === 1 ? 'athlete' : 'athletes'}`;
}

/** SPEC.md §7.3 step 3: which job, when, where, how many, and what it
 * pays, then the reply that claims it. */
function offerText(info: SessionOverflowInfo, kind: OverflowKind, booked: number): string {
  const pay = info.backupPayCents ? `, pays ${formatPay(info.backupPayCents)}` : '';
  const place = info.locationText ? `, ${info.locationText}` : '';
  const what =
    kind === 'second_group'
      ? `Coach a second ${info.name} group ${compactWhen(info)}${place}, up to ${athletes(info.capacity)}${pay}`
      : `Backup coach for ${info.name} ${compactWhen(info)}${place}, ${athletes(booked)}${pay}`;
  return keepTail(`Coachatron: ${what}`, '. Reply Y to claim (20 min).');
}

/** What the offer page (screen 12) shows: the job, and the same facts as the text. */
export async function describeOffer(
  db: DbClient,
  offer: { sessionId: number; kind: OverflowKind },
): Promise<{ heading: string; summary: string } | null> {
  const info = await loadSessionOverflowInfo(db, offer.sessionId);
  if (!info) return null;
  const pay = info.backupPayCents ? ` Pays ${formatPay(info.backupPayCents)}.` : '';
  const place = info.locationText ? ` at ${info.locationText}` : '';
  if (offer.kind === 'second_group') {
    return {
      heading: 'Coach a second group',
      summary: `${info.label}${place}: a second group of up to ${athletes(info.capacity)}, at the same time.${pay}`,
    };
  }
  return {
    heading: 'Backup coach needed',
    summary: `${info.label}${place}, ${athletes(await countBooked(db, info.sessionId))}.${pay}`,
  };
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

interface Claimed {
  sessionId: number;
  /** The session the job adds spots to: the new second group, or the original. */
  targetSessionId: number;
  kind: OverflowKind;
  memberId: number;
  spotsAdded: number;
  /** Spots held for people waiting, to be sent once the transaction ends. */
  held: Awaited<ReturnType<typeof holdSpotsForWaitlist>>;
  waitingForMorning: boolean;
}

/** The first acceptance takes the job, once. Everything is decided inside
 * one transaction holding the ask's row, the offer's row and the session's
 * row (the same lock every booking takes), so of two replies at the same
 * moment only one can win, and an offer that expired, was withdrawn, or
 * belongs to a session that was cancelled or started cannot be accepted.
 * The ask's row is taken first, as the cascade's next step takes it before
 * it touches any offer, so the two wait for each other in the same order.
 * A second group is a new session at the same time and place, with the
 * same type and capacity, run by the member; a backup coach joins the
 * session, and its capacity grows by its type's capacity. Every other offer
 * for the session is withdrawn, without a text. Returns true if this call
 * took the job. */
export async function acceptOffer(db: DbClient, offerId: number): Promise<boolean> {
  const claimed = await inTransaction(db, async (tx): Promise<Claimed | null> => {
    // Which ask the offer belongs to never changes, so it is read before
    // any lock is taken.
    const belongs = await tx.query<{ session_id: number; ask_id: number | null }>('select session_id, ask_id from offer where id = $1', [
      offerId,
    ]);
    if (!belongs.rows[0]) return null;
    const { ask_id: askId, session_id: askSessionId } = belongs.rows[0];
    const asks = await tx.query<{ id: number; closed_at: string | null }>(
      askId !== null
        ? 'select id, closed_at from overflow_ask where id = $1 for update'
        : 'select id, closed_at from overflow_ask where session_id = $1 and closed_at is null for update',
      [askId ?? askSessionId],
    );

    const found = await tx.query<{
      session_id: number;
      roster_member_id: number;
      kind: OverflowKind | null;
      ask_id: number | null;
      state: string;
      live: boolean;
    }>(
      `select session_id, roster_member_id, kind, ask_id, state, expires_at > now() as live
       from offer where id = $1 for update`,
      [offerId],
    );
    const offer = found.rows[0];
    if (!offer || offer.state !== 'sent' || !offer.live) return null;

    const sessions = await tx.query<{
      status: string;
      starts_at_utc: string | Date;
      session_type_id: number;
      tz: string;
      location_text: string | null;
      capacity_override: number | null;
      type_capacity: number;
    }>(
      `select s.status, s.starts_at_utc, s.session_type_id, s.tz, s.location_text, s.capacity_override, st.capacity as type_capacity
       from session s join session_type st on st.id = s.session_type_id
       where s.id = $1
       for update of s`,
      [offer.session_id],
    );
    const session = sessions.rows[0];
    const withdraw = async () => {
      await tx.query("update offer set state = 'withdrawn' where id = $1", [offerId]);
      return null;
    };
    if (!session || session.status !== 'scheduled' || new Date(session.starts_at_utc) <= new Date()) return withdraw();

    const taken = await tx.query<{ id: number }>("select id from offer where session_id = $1 and state = 'accepted' limit 1", [
      offer.session_id,
    ]);
    if (taken.rows.length > 0) return withdraw();
    if (offer.ask_id !== null && (!asks.rows[0] || asks.rows[0].closed_at)) return withdraw();

    await tx.query("update offer set state = 'accepted', accepted_at = now() where id = $1", [offerId]);
    const kind: OverflowKind = offer.kind ?? 'backup';
    let target = offer.session_id;
    let added = session.type_capacity;
    if (kind === 'second_group') {
      added = session.capacity_override ?? session.type_capacity;
      const created = await tx.query<{ id: number }>(
        `insert into session (session_type_id, starts_at_utc, tz, location_text, capacity_override, assigned_roster_member_id, overflow_of, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
         returning id`,
        [
          session.session_type_id,
          new Date(session.starts_at_utc).toISOString(),
          session.tz,
          session.location_text,
          session.capacity_override,
          offer.roster_member_id,
          offer.session_id,
        ],
      );
      target = created.rows[0].id;
    } else {
      await tx.query(
        `update session set assigned_roster_member_id = $2, capacity_override = coalesce(capacity_override, $3) + $3
         where id = $1`,
        [offer.session_id, offer.roster_member_id, session.type_capacity],
      );
    }
    for (const ask of asks.rows) {
      await tx.query(
        `update overflow_ask set closed_at = now(), outcome = 'accepted', resolved_at = coalesce(resolved_at, now()),
                accepted_member_id = $2, extra_session_id = $3
         where id = $1`,
        [ask.id, offer.roster_member_id, kind === 'second_group' ? target : null],
      );
    }
    await tx.query("update offer set state = 'withdrawn' where session_id = $1 and state = 'sent' and id <> $2", [
      offer.session_id,
      offerId,
    ]);
    // The new spots go to the people waiting, in order, before anyone else
    // can book them: held here, under the same lock, and sent after.
    const waitingForMorning = await spotOffersWaitForMorning(tx, target);
    const held = waitingForMorning ? [] : await holdSpotsForWaitlist(tx, target);
    return {
      sessionId: offer.session_id,
      targetSessionId: target,
      kind,
      memberId: offer.roster_member_id,
      spotsAdded: added,
      held,
      waitingForMorning,
    };
  });
  if (!claimed) return false;
  // Spots let go because their person cannot be reached go on down the
  // line; one whose text or email did not go out just now stays theirs, and
  // the tick tries it again.
  const sent = await sendHeldSpots(db, claimed.targetSessionId, claimed.held);
  const offered =
    sent.passedOver > 0 && sent.later === 0
      ? (await offerOpenSpots(db, claimed.targetSessionId, new Date(), sent.told)).offered
      : sent.told.size;
  await tellCoachClaimed(db, claimed, { offered, waitingForMorning: claimed.waitingForMorning });
  return true;
}

/** SPEC.md §7.3 step 4: the coach hears who took it and what it opened. */
async function tellCoachClaimed(db: DbClient, claimed: Claimed, spots: SpotOffers): Promise<void> {
  const info = await loadSessionOverflowInfo(db, claimed.sessionId);
  if (!info) return;
  const member = await db.query<{ name: string }>('select name from roster_member where id = $1', [claimed.memberId]);
  const who = plain(member.rows[0]?.name ?? '') || 'Someone on your roster';
  const job =
    claimed.kind === 'second_group'
      ? `${who} took the second group`
      : `${who} is your backup coach, ${claimed.spotsAdded} more ${claimed.spotsAdded === 1 ? 'spot' : 'spots'}`;
  const offered = spots.waitingForMorning
    ? ' Waitlisted parents are offered the spots from 8am.'
    : ` ${spots.offered} waitlisted ${spots.offered === 1 ? 'parent was' : 'parents were'} offered a spot.`;
  await notifyCoach(db, info, 'overflow-claimed', {
    text: keepTail(`Coachatron: ${compactWhen(info)} ${info.name}`, `: ${job}.${offered}`),
    subject: claimed.kind === 'second_group' ? `${who} took the second group` : `${who} is your backup coach`,
    email: `${info.label}: ${job}.${offered}`,
  });
}

export async function getOfferByToken(
  db: DbClient,
  token: string,
): Promise<{ id: number; sessionId: number; rosterMemberId: number; state: string; expiresAt: string; kind: OverflowKind } | null> {
  const result = await db.query<{
    id: number;
    session_id: number;
    roster_member_id: number;
    state: string;
    expires_at: string;
    kind: OverflowKind | null;
  }>('select id, session_id, roster_member_id, state, expires_at, kind from offer where token = $1', [token]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    rosterMemberId: row.roster_member_id,
    state: row.state,
    expiresAt: row.expires_at,
    kind: row.kind ?? 'backup',
  };
}

/** Ends a session's overflow: its open or running ask closes and any offer
 * still out is withdrawn, with no texts. For a session the coach cancelled
 * or that has started. */
export async function endOverflowForSession(db: DbClient, sessionId: number, outcome: 'cancelled' | 'ended'): Promise<void> {
  await db.query("update offer set state = 'withdrawn' where session_id = $1 and state = 'sent'", [sessionId]);
  await db.query(
    `update overflow_ask set closed_at = now(), outcome = $2, resolved_at = coalesce(resolved_at, now())
     where session_id = $1 and closed_at is null`,
    [sessionId, outcome],
  );
}

/** The tick's step: overflow on sessions that were cancelled or have
 * started ends; offers past their expiry are marked expired and each of
 * those cascades moves to the next roster member. Tests call it with a
 * stubbed clock instead of waiting. */
export async function advanceCascade(db: DbClient, now: Date): Promise<void> {
  const over = await db.query<{ session_id: number; coach_id: number; status: string }>(
    `select distinct oa.session_id, st.coach_id, s.status
     from overflow_ask oa
     join session s on s.id = oa.session_id
     join session_type st on st.id = s.session_type_id
     where oa.closed_at is null and (s.status <> 'scheduled' or s.starts_at_utc <= $1)`,
    [now.toISOString()],
  );
  for (const row of over.rows) {
    await endOverflowForSession(db, row.session_id, row.status === 'cancelled' ? 'cancelled' : 'ended');
    await askAboutNextFullSession(db, row.coach_id);
  }
  // An offer being accepted at this moment is left to that accept, which
  // holds its row: it either takes the job or finds it closed, and a later
  // tick expires it if it is still out.
  const expired = await db.query<{ session_id: number }>(
    `update offer set state = 'expired'
     where id in (select id from offer where state = 'sent' and expires_at <= $1 for update skip locked)
     returning session_id`,
    [now.toISOString()],
  );
  for (const sessionId of new Set(expired.rows.map((r) => r.session_id))) {
    await startCascade(db, sessionId);
  }
}

export interface RunningCascade {
  sessionId: number;
  label: string;
  tz: string;
  kind: OverflowKind;
  /** Who has the offer now, and until when. */
  offeredTo: { name: string; expiresAt: string } | null;
  /** Who is not being asked because they cannot get texts. */
  unreachable: UnreachableMember[];
}

/** Cascades under way for the coach's sessions, for the schedule screen. */
export async function runningCascadesForCoach(db: DbClient, coachId: number): Promise<RunningCascade[]> {
  const rows = await db.query<{ session_id: number; kind: OverflowKind }>(
    `select oa.session_id, oa.kind
     from overflow_ask oa
     join session s on s.id = oa.session_id
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and oa.closed_at is null and oa.kind is not null
       and s.status = 'scheduled' and s.starts_at_utc > now()
     order by s.starts_at_utc`,
    [coachId],
  );
  const out: RunningCascade[] = [];
  const { unreachable } = rows.rows.length > 0 ? await unreachableRoster(db, coachId) : { unreachable: [] };
  for (const row of rows.rows) {
    const info = await loadSessionOverflowInfo(db, row.session_id);
    if (!info) continue;
    const live = await db.query<{ name: string; expires_at: string | Date }>(
      `select rm.name, o.expires_at from offer o join roster_member rm on rm.id = o.roster_member_id
       where o.session_id = $1 and o.state = 'sent' and o.expires_at > now()
       order by o.id desc limit 1`,
      [row.session_id],
    );
    const offer = live.rows[0];
    out.push({
      sessionId: row.session_id,
      label: info.label,
      tz: info.tz,
      kind: row.kind,
      offeredTo: offer ? { name: offer.name, expiresAt: new Date(offer.expires_at).toISOString() } : null,
      unreachable,
    });
  }
  return out;
}

export interface RosterOptIn {
  memberId: number;
  phone: string;
  coachName: string;
}

/** The roster member an opt-in link belongs to. */
export async function rosterMemberByOptInToken(db: DbClient, token: string): Promise<RosterOptIn | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const result = await db.query<{ id: number; phone: string; coach_name: string }>(
    `select rm.id, rm.phone, c.name as coach_name
     from roster_member rm join coach c on c.id = rm.coach_id
     where rm.optin_token = $1 and rm.active = true`,
    [token],
  );
  const row = result.rows[0];
  return row ? { memberId: row.id, phone: row.phone, coachName: row.coach_name } : null;
}
