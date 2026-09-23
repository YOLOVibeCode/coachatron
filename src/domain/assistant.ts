import type { DbClient } from '../db/client.js';
import type { CoachRow } from './auth.js';
import { startCascade, isOptedOut } from './cascade.js';
import { summarizeMoney } from './money.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from './scheduling.js';
import {
  APP_BASE_URL,
  ASSISTANT_MODEL_DAILY_CAP,
  ASSISTANT_MODEL_MONTHLY_CAP,
} from '../config.js';
import { complete } from '../llm/complete.js';
import {
  INTENT_JSON_SCHEMA,
  INTENT_NAMES,
  WRITE_INTENTS,
  type ClassifiedIntent,
  type IntentName,
} from '../llm/schema.js';
import { clipSms, formatConfirmWhen, formatLocal } from '../lib/time.js';
import { sendSms } from '../relay/sms.js';
import {
  consumePending,
  createPending,
  getLastReply,
  getLivePending,
  getPendingById,
  logAssistant,
  markReasked,
  setLastReply,
  type LastReply,
  type PendingRow,
} from './assistantPending.js';

export type { ClassifiedIntent } from '../llm/schema.js';

export interface AssistantReply {
  text: string;
  pendingId: number | null;
  kind: 'answer' | 'confirm' | 'unknown' | 'done' | 'dropped' | 'reask';
}

export interface SessionBrief {
  id: number;
  name: string;
  startsAtUtc: string;
  tz: string;
  durationMin: number;
  locationText: string | null;
  capacity: number;
  booked: number;
  sessionTypeId: number;
}

export type AssistantChannel = 'sms' | 'web';

const EIGHT_WEEKS_MS = 56 * 24 * 60 * 60 * 1000;
const CONFIDENCE_FLOOR = 0.75;
const WEEKDAYS_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function unknownIntent(source: ClassifiedIntent['source'] = 'pattern'): ClassifiedIntent {
  return {
    intent: 'unknown',
    confidence: 0,
    session_id: null,
    session_type_id: null,
    session_type: null,
    when: null,
    new_when: null,
    location: null,
    reason: null,
    source,
  };
}

export function keywordToken(body: string): 'STOP' | 'HELP' | 'Y' | 'N' | null {
  const t = body.trim();
  if (/^stop$/i.test(t)) return 'STOP';
  if (/^help$/i.test(t)) return 'HELP';
  if (/^(y|yes)$/i.test(t)) return 'Y';
  if (/^(n|no)$/i.test(t)) return 'N';
  return null;
}

function catchThat(): AssistantReply {
  return {
    text: clipSms(`I didn't catch that. ${APP_BASE_URL}/app/schedule`),
    pendingId: null,
    kind: 'unknown',
  };
}

export async function listUpcomingSessions(db: DbClient, coachId: number, now: Date): Promise<SessionBrief[]> {
  const until = new Date(now.getTime() + EIGHT_WEEKS_MS);
  const result = await db.query<{
    id: number;
    name: string;
    starts_at_utc: string;
    tz: string;
    duration_min: number;
    location_text: string | null;
    capacity: number;
    booked: string;
    session_type_id: number;
  }>(
    `select s.id, st.name, s.starts_at_utc, s.tz, st.duration_min, s.location_text,
            coalesce(s.capacity_override, st.capacity) as capacity,
            st.id as session_type_id,
            coalesce((select count(*) from booking b where b.session_id = s.id and b.status = 'booked'), 0)::text as booked
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1
       and s.status = 'scheduled'
       and s.starts_at_utc > $2
       and s.starts_at_utc < $3
     order by s.starts_at_utc`,
    [coachId, now.toISOString(), until.toISOString()],
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    startsAtUtc: iso(r.starts_at_utc),
    tz: r.tz,
    durationMin: r.duration_min,
    locationText: r.location_text,
    capacity: r.capacity,
    booked: Number(r.booked),
    sessionTypeId: r.session_type_id,
  }));
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface TimeHint {
  ymd?: { year: number; month: number; day: number };
  weekday?: number;
  hour?: number;
  minute?: number;
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (!Number.isInteger(hour) || hour > 23 || minute > 59) return null;
  const ap = (m[3] ?? '').toLowerCase().replace(/\./g, '');
  if (ap.startsWith('p') && hour < 12) hour += 12;
  if (ap.startsWith('a') && hour === 12) hour = 0;
  if (!ap && hour >= 1 && hour <= 11) hour += 12;
  return { hour, minute };
}

export function parseTimeHint(text: string, tz: string, now: Date): TimeHint {
  const lower = text.toLowerCase().replace(/['’]/g, '');
  const parts = zonedParts(now, tz);
  const hint: TimeHint = {};
  if (/\btomorrow\b/.test(lower)) {
    hint.ymd = addCalendarDays(parts.year, parts.month, parts.day, 1);
  } else if (/\btoday\b/.test(lower)) {
    hint.ymd = { year: parts.year, month: parts.month, day: parts.day };
  } else {
    for (let i = 0; i < 7; i += 1) {
      const re = new RegExp(`\\b(?:${WEEKDAYS_LONG[i]}|${WEEKDAYS_SHORT[i]})\\b`);
      if (re.test(lower)) {
        hint.weekday = i;
        break;
      }
    }
  }
  const clock = parseClock(lower);
  if (clock) {
    hint.hour = clock.hour;
    hint.minute = clock.minute;
  }
  return hint;
}

function hintHasAnchor(hint: TimeHint): boolean {
  return Boolean(hint.ymd || hint.weekday !== undefined || hint.hour !== undefined);
}

export function matchSessions(sessions: SessionBrief[], hint: TimeHint): SessionBrief[] {
  if (!hintHasAnchor(hint)) return [];
  return sessions.filter((s) => {
    const p = zonedParts(new Date(s.startsAtUtc), s.tz);
    if (hint.ymd && (p.year !== hint.ymd.year || p.month !== hint.ymd.month || p.day !== hint.ymd.day)) return false;
    if (hint.weekday !== undefined && p.weekday !== hint.weekday) return false;
    if (hint.hour !== undefined && p.hour !== hint.hour) return false;
    if (hint.minute !== undefined && p.minute !== hint.minute) return false;
    return true;
  });
}

function withSession(base: ClassifiedIntent, session: SessionBrief): ClassifiedIntent {
  return {
    ...base,
    session_id: session.id,
    session_type_id: session.sessionTypeId,
    session_type: session.name,
    when: session.startsAtUtc,
  };
}

type PatternResult = ClassifiedIntent | 'ambiguous' | null;

function patternClassify(text: string, sessions: SessionBrief[], tz: string, now: Date): PatternResult {
  const normalized = text.trim().toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ');

  if (/cancel.+\b(everything|all sessions|whole week|next week)\b/.test(normalized) || /^cancel everything\b/.test(normalized)) {
    return 'ambiguous';
  }

  const who = /^(?:who(?:s)?|who is)(?:\s+at)?\s+(.+)$/.exec(normalized);
  if (who) {
    const matches = matchSessions(sessions, parseTimeHint(who[1], tz, now));
    if (matches.length === 1) {
      return withSession({ ...unknownIntent('pattern'), intent: 'session.roster', confidence: 1 }, matches[0]);
    }
    return 'ambiguous';
  }

  const cancel = /^cancel\s+(.+)$/.exec(normalized);
  if (cancel) {
    const matches = matchSessions(sessions, parseTimeHint(cancel[1], tz, now));
    if (matches.length === 1) return withSession({ ...unknownIntent('pattern'), intent: 'session.cancel', confidence: 1 }, matches[0]);
    return 'ambiguous';
  }

  if (/^(?:what did i collect|how much (?:did i |have i )?(?:collect|make)|money(?: summary)?)\??$/.test(normalized)) {
    return { ...unknownIntent('pattern'), intent: 'money.summary', confidence: 1 };
  }

  const sched = /^(?:what(?:s| is)(?:\s+on)?\s+(today|tomorrow)|what(?:s| is) (?:my |the )?(?:week|schedule))\??$/.exec(normalized);
  if (sched) {
    const hit: ClassifiedIntent = { ...unknownIntent('pattern'), intent: 'schedule.query', confidence: 1 };
    if (sched[1] === 'today' || sched[1] === 'tomorrow') {
      const hint = parseTimeHint(sched[1], tz, now);
      const matches = matchSessions(sessions, hint);
      if (matches.length === 1) return withSession(hit, matches[0]);
      if (hint.ymd) hit.when = zonedTimeToUtc(hint.ymd.year, hint.ymd.month, hint.ymd.day, 0, 0, tz).toISOString();
    }
    return hit;
  }

  return null;
}

function asIntentName(value: unknown): IntentName {
  if (typeof value === 'string' && (INTENT_NAMES as readonly string[]).includes(value)) {
    return value as IntentName;
  }
  return 'unknown';
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function classifiedFromModel(raw: unknown): ClassifiedIntent {
  if (!raw || typeof raw !== 'object') return unknownIntent('model');
  const o = raw as Record<string, unknown>;
  const args = o.args && typeof o.args === 'object' ? (o.args as Record<string, unknown>) : o;
  return {
    intent: asIntentName(o.intent),
    confidence: typeof o.confidence === 'number' ? o.confidence : 0,
    session_id: asInt(args.session_id),
    session_type_id: asInt(args.session_type_id),
    session_type: asStr(args.session_type),
    when: asStr(args.when),
    new_when: asStr(args.new_when),
    location: asStr(args.location),
    reason: asStr(args.reason),
    source: 'model',
  };
}

async function modelCallCount(db: DbClient, coachId: number, sinceIso: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    'select count(*)::text as n from assistant_model_call where coach_id = $1 and called_at >= $2',
    [coachId, sinceIso],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function underModelCap(db: DbClient, coach: CoachRow, now: Date): Promise<boolean> {
  const local = zonedParts(now, coach.tz);
  const dayStart = zonedTimeToUtc(local.year, local.month, local.day, 0, 0, coach.tz);
  const monthStart = zonedTimeToUtc(local.year, local.month, 1, 0, 0, coach.tz);
  const [dayCount, monthCount] = await Promise.all([
    modelCallCount(db, coach.id, dayStart.toISOString()),
    modelCallCount(db, coach.id, monthStart.toISOString()),
  ]);
  return dayCount < ASSISTANT_MODEL_DAILY_CAP && monthCount < ASSISTANT_MODEL_MONTHLY_CAP;
}

function sessionCatalog(sessions: SessionBrief[]): string {
  return sessions
    .map((s) => {
      const local = formatConfirmWhen(s.startsAtUtc, s.tz);
      return `- id=${s.id} name="${s.name}" start=${s.startsAtUtc} local="${local}" spots=${s.booked}/${s.capacity}`;
    })
    .join('\n');
}

async function llmClassify(
  db: DbClient,
  coach: CoachRow,
  text: string,
  sessions: SessionBrief[],
  types: Array<{ id: number; name: string }>,
  now: Date,
  channel: AssistantChannel,
): Promise<ClassifiedIntent> {
  if (!(await underModelCap(db, coach, now))) {
    await logAssistant(db, {
      coachId: coach.id,
      phone: coach.phone,
      channel,
      rawMessage: text,
      layer: 'model',
      intent: 'unknown',
      outcome: 'cap',
    });
    return unknownIntent('model');
  }

  await db.query('insert into assistant_model_call (coach_id, called_at) values ($1, $2)', [coach.id, now.toISOString()]);

  const typeLines = types.map((t) => `- id=${t.id} name="${t.name}"`).join('\n');
  const system = [
    'Classify one message from a coach into a single intent object. JSON only.',
    `Closed intents: ${INTENT_NAMES.join(', ')}.`,
    `Coach timezone: ${coach.tz}.`,
    'One intent, one session, or one broadcast. Multi-session commands are unknown.',
    'Never invent a session id. confidence is 0..1. Below 0.75 is unknown.',
    'Do not include phone numbers, emails, or card data.',
    `Session types:\n${typeLines || '(none)'}`,
    `Upcoming sessions:\n${sessionCatalog(sessions) || '(none)'}`,
  ].join('\n');

  try {
    const raw = await complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      schema: INTENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    });
    return classifiedFromModel(raw);
  } catch {
    return unknownIntent('model');
  }
}

async function loadSessionTypes(db: DbClient, coachId: number): Promise<Array<{ id: number; name: string; duration_min: number }>> {
  const result = await db.query<{ id: number; name: string; duration_min: number }>(
    'select id, name, duration_min from session_type where coach_id = $1 and active = true order by id',
    [coachId],
  );
  return result.rows;
}

function resolveAgainstSessions(
  classified: ClassifiedIntent,
  sessions: SessionBrief[],
  types: Array<{ id: number; name: string }>,
): ClassifiedIntent {
  if (classified.intent === 'unknown') return classified;
  if (classified.confidence < CONFIDENCE_FLOOR) return unknownIntent(classified.source);

  let session: SessionBrief | undefined;
  if (classified.session_id != null) {
    session = sessions.find((s) => s.id === classified.session_id);
    if (!session) return unknownIntent(classified.source);
  } else if (classified.when) {
    const whenDate = new Date(classified.when);
    if (!Number.isNaN(whenDate.getTime())) {
      const matches = sessions.filter((s) => {
        const a = zonedParts(new Date(s.startsAtUtc), s.tz);
        const b = zonedParts(whenDate, s.tz);
        return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
      });
      if (matches.length > 1) return unknownIntent(classified.source);
      session = matches[0];
    }
  }

  if (classified.session_type && classified.session_type_id == null) {
    const needle = classified.session_type.toLowerCase();
    const hits = types.filter((t) => t.name.toLowerCase() === needle);
    if (hits.length === 1) classified = { ...classified, session_type_id: hits[0].id };
  }

  if (session) classified = withSession(classified, session);

  const needsSession =
    classified.intent === 'session.cancel' ||
    classified.intent === 'session.roster' ||
    classified.intent === 'session.move' ||
    classified.intent === 'broadcast.send' ||
    classified.intent === 'roster.offer';
  if (needsSession && classified.session_id == null) return unknownIntent(classified.source);
  if (classified.intent === 'session.add' && classified.session_type_id == null) return unknownIntent(classified.source);
  if (classified.intent === 'session.add' && !classified.when) return unknownIntent(classified.source);
  if (classified.intent === 'session.move' && !classified.new_when) return unknownIntent(classified.source);
  return classified;
}

function sessionById(sessions: SessionBrief[], id: number | null): SessionBrief | undefined {
  return id == null ? undefined : sessions.find((s) => s.id === id);
}

async function renderRead(
  db: DbClient,
  coach: CoachRow,
  classified: ClassifiedIntent,
  sessions: SessionBrief[],
  now: Date,
): Promise<string> {
  if (classified.intent === 'money.summary') {
    const summary = await summarizeMoney(db, coach.id, now);
    const collected = (summary.collectedThisWeekCents / 100).toFixed(0);
    return clipSms(
      `This week: ${summary.bookedThisWeekCount} booked, $${collected} collected. ${summary.outstandingCreditCount} credits out. Next week: ${summary.nextWeekCount} sessions.`,
    );
  }

  if (classified.intent === 'session.roster') {
    const session = sessionById(sessions, classified.session_id);
    if (!session) return catchThat().text;
    const names = await db.query<{ athlete_name: string }>(
      "select athlete_name from booking where session_id = $1 and status = 'booked' order by id",
      [session.id],
    );
    const list = names.rows.map((r) => r.athlete_name).join(', ');
    const when = formatConfirmWhen(session.startsAtUtc, session.tz);
    return clipSms(`${session.booked} at ${when}: ${list || 'nobody yet'}`);
  }

  const hintWhen = classified.when ? new Date(classified.when) : null;
  const daySessions = hintWhen && !Number.isNaN(hintWhen.getTime())
    ? sessions.filter((s) => {
        const a = zonedParts(new Date(s.startsAtUtc), s.tz);
        const b = zonedParts(hintWhen, s.tz);
        return a.year === b.year && a.month === b.month && a.day === b.day;
      })
    : sessions.slice(0, 6);
  if (daySessions.length === 0) return clipSms('No sessions in that window.');
  const bits = daySessions.map((s) => {
    const when = formatConfirmWhen(s.startsAtUtc, s.tz);
    return `${when} ${s.name} (${s.booked}/${s.capacity})`;
  });
  return clipSms(bits.join('; '));
}

function athleteBroadcastBody(session: SessionBrief, classified: ClassifiedIntent): string {
  const when = formatConfirmWhen(session.startsAtUtc, session.tz);
  if (classified.reason) return clipSms(`Coachatron: ${session.name} ${when}. ${classified.reason}`);
  return clipSms(`Coachatron: ${session.name} on ${when} has an update from your coach.`);
}

async function renderConfirm(
  classified: ClassifiedIntent,
  sessions: SessionBrief[],
  types: Array<{ id: number; name: string; duration_min: number }>,
  tz: string,
): Promise<string | null> {
  if (classified.intent === 'session.cancel') {
    const session = sessionById(sessions, classified.session_id);
    if (!session) return null;
    const when = formatConfirmWhen(session.startsAtUtc, session.tz);
    return clipSms(
      `Cancel ${when}, ${session.durationMin}-min ${session.name}? ${session.booked} athletes. They'll be texted and credits returned. Reply Y.`,
    );
  }
  if (classified.intent === 'session.add') {
    const type = types.find((t) => t.id === classified.session_type_id);
    if (!type || !classified.when) return null;
    const when = formatConfirmWhen(classified.when, tz);
    const place = classified.location ? ` at ${classified.location}` : '';
    return clipSms(`Add ${type.duration_min}-min ${type.name} ${when}${place}? Reply Y.`);
  }
  if (classified.intent === 'session.move') {
    const session = sessionById(sessions, classified.session_id);
    if (!session || !classified.new_when) return null;
    const from = formatConfirmWhen(session.startsAtUtc, session.tz);
    const to = formatConfirmWhen(classified.new_when, session.tz);
    return clipSms(`Move ${session.name} from ${from} to ${to}? Reply Y.`);
  }
  if (classified.intent === 'broadcast.send') {
    const session = sessionById(sessions, classified.session_id);
    if (!session) return null;
    const body = athleteBroadcastBody(session, classified);
    return clipSms(`Text ${session.booked} athletes: "${body}" Reply Y.`);
  }
  if (classified.intent === 'roster.offer') {
    const session = sessionById(sessions, classified.session_id);
    if (!session) return null;
    const when = formatConfirmWhen(session.startsAtUtc, session.tz);
    return clipSms(`Ask your roster to cover ${when} ${session.name}? Reply Y.`);
  }
  return null;
}

async function executeWrite(
  db: DbClient,
  coach: CoachRow,
  classified: ClassifiedIntent,
): Promise<string> {
  if (classified.intent === 'session.cancel' && classified.session_id != null) {
    return executeCancel(db, coach, classified.session_id);
  }
  if (classified.intent === 'session.add') {
    return executeAdd(db, coach, classified);
  }
  if (classified.intent === 'session.move' && classified.session_id != null && classified.new_when) {
    return executeMove(db, coach, classified.session_id, classified.new_when, classified.location);
  }
  if (classified.intent === 'broadcast.send' && classified.session_id != null) {
    return executeBroadcast(db, coach, classified);
  }
  if (classified.intent === 'roster.offer' && classified.session_id != null) {
    await startCascade(db, classified.session_id);
    return 'Asked the next person on your roster.';
  }
  return catchThat().text;
}

async function executeCancel(db: DbClient, coach: CoachRow, sessionId: number): Promise<string> {
  const session = await db.query<{
    id: number;
    starts_at_utc: string;
    tz: string;
    name: string;
  }>(
    `select s.id, s.starts_at_utc, s.tz, st.name
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2 and s.status = 'scheduled'`,
    [sessionId, coach.id],
  );
  const row = session.rows[0];
  if (!row) return 'That session is gone.';
  if (new Date(row.starts_at_utc) < new Date()) return 'Session already started.';

  const cancelled = await db.query<{ contact_phone: string; athlete_name: string; credit_id: number | null }>(
    `update booking set status = 'cancelled'
     where session_id = $1 and status in ('booked', 'attended', 'noshow')
     returning contact_phone, athlete_name, credit_id`,
    [sessionId],
  );

  let credits = 0;
  for (const athlete of cancelled.rows) {
    if (athlete.credit_id) {
      await db.query('update credit set remaining = remaining + 1 where id = $1', [athlete.credit_id]);
      credits += 1;
    }
    if (!(await isOptedOut(db, athlete.contact_phone))) {
      await sendSms({
        to: athlete.contact_phone,
        body: `${athlete.athlete_name}'s ${row.name} on ${formatLocal(row.starts_at_utc, row.tz)} has been cancelled.`,
      });
    }
  }

  await db.query("update session set status = 'cancelled' where id = $1", [sessionId]);
  const n = cancelled.rows.length;
  return clipSms(`Cancelled. ${n} athletes notified, ${credits} credits returned.`);
}

async function executeAdd(db: DbClient, coach: CoachRow, classified: ClassifiedIntent): Promise<string> {
  if (classified.session_type_id == null || !classified.when) return catchThat().text;
  const type = await db.query<{ id: number; name: string }>(
    'select id, name from session_type where id = $1 and coach_id = $2 and active = true',
    [classified.session_type_id, coach.id],
  );
  if (!type.rows[0]) return catchThat().text;
  const starts = new Date(classified.when);
  if (Number.isNaN(starts.getTime())) return catchThat().text;
  await db.query(
    `insert into session (session_type_id, starts_at_utc, tz, location_text, status)
     values ($1, $2, $3, $4, 'scheduled')`,
    [type.rows[0].id, starts.toISOString(), coach.tz, classified.location],
  );
  return clipSms(`Added ${type.rows[0].name} ${formatConfirmWhen(starts.toISOString(), coach.tz)}.`);
}

async function executeMove(
  db: DbClient,
  coach: CoachRow,
  sessionId: number,
  newWhen: string,
  location: string | null,
): Promise<string> {
  const starts = new Date(newWhen);
  if (Number.isNaN(starts.getTime())) return catchThat().text;
  const owned = await db.query<{ id: number; name: string; tz: string }>(
    `select s.id, st.name, s.tz
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2 and s.status = 'scheduled'`,
    [sessionId, coach.id],
  );
  const row = owned.rows[0];
  if (!row) return 'That session is gone.';
  await db.query(
    `update session set starts_at_utc = $1, location_text = coalesce($2, location_text) where id = $3`,
    [starts.toISOString(), location, sessionId],
  );
  return clipSms(`Moved ${row.name} to ${formatConfirmWhen(starts.toISOString(), row.tz)}.`);
}

async function executeBroadcast(db: DbClient, coach: CoachRow, classified: ClassifiedIntent): Promise<string> {
  const sessionId = classified.session_id;
  if (sessionId == null) return catchThat().text;
  const session = await db.query<{ starts_at_utc: string; tz: string; name: string }>(
    `select s.starts_at_utc, s.tz, st.name
     from session s
     join session_type st on st.id = s.session_type_id
     where s.id = $1 and st.coach_id = $2`,
    [sessionId, coach.id],
  );
  const row = session.rows[0];
  if (!row) return catchThat().text;
  const brief: SessionBrief = {
    id: sessionId,
    name: row.name,
    startsAtUtc: row.starts_at_utc,
    tz: row.tz,
    durationMin: 0,
    locationText: null,
    capacity: 0,
    booked: 0,
    sessionTypeId: 0,
  };
  const body = athleteBroadcastBody(brief, classified);
  const athletes = await db.query<{ contact_phone: string }>(
    "select distinct contact_phone from booking where session_id = $1 and status = 'booked'",
    [sessionId],
  );
  let sent = 0;
  for (const athlete of athletes.rows) {
    if (await isOptedOut(db, athlete.contact_phone)) continue;
    await sendSms({ to: athlete.contact_phone, body });
    sent += 1;
  }
  return clipSms(`Sent to ${sent} athletes.`);
}

async function classifyUtterance(
  db: DbClient,
  coach: CoachRow,
  text: string,
  sessions: SessionBrief[],
  types: Array<{ id: number; name: string; duration_min: number }>,
  now: Date,
  channel: AssistantChannel,
): Promise<ClassifiedIntent> {
  const patterned = patternClassify(text, sessions, coach.tz, now);
  if (patterned === 'ambiguous') {
    await logAssistant(db, {
      coachId: coach.id,
      phone: coach.phone,
      channel,
      rawMessage: text,
      layer: 'pattern',
      intent: 'unknown',
      outcome: 'ambiguous',
    });
    return unknownIntent('pattern');
  }
  if (patterned) {
    await logAssistant(db, {
      coachId: coach.id,
      phone: coach.phone,
      channel,
      rawMessage: text,
      layer: 'pattern',
      intent: patterned.intent,
      payload: patterned,
      outcome: 'classified',
    });
    return patterned;
  }

  const modeled = await llmClassify(db, coach, text, sessions, types, now, channel);
  await logAssistant(db, {
    coachId: coach.id,
    phone: coach.phone,
    channel,
    rawMessage: text,
    layer: 'model',
    intent: modeled.intent,
    payload: modeled,
    outcome: 'classified',
  });
  return resolveAgainstSessions(modeled, sessions, types);
}

async function applyClassified(
  db: DbClient,
  coach: CoachRow,
  classified: ClassifiedIntent,
  sessions: SessionBrief[],
  types: Array<{ id: number; name: string; duration_min: number }>,
  now: Date,
): Promise<AssistantReply> {
  if (classified.intent === 'unknown' || classified.confidence < CONFIDENCE_FLOOR) {
    return catchThat();
  }
  if (!WRITE_INTENTS.has(classified.intent)) {
    const text = await renderRead(db, coach, classified, sessions, now);
    return { text, pendingId: null, kind: 'answer' };
  }
  const confirmText = await renderConfirm(classified, sessions, types, coach.tz);
  if (!confirmText) return catchThat();
  const pending = await createPending(db, coach.id, classified, confirmText, now);
  return { text: confirmText, pendingId: pending.id, kind: 'confirm' };
}

async function resolvePendingRow(
  db: DbClient,
  coach: CoachRow,
  pending: PendingRow,
  yes: boolean,
  now: Date,
  channel: AssistantChannel,
): Promise<AssistantReply> {
  const consumed = await consumePending(db, pending.id, now);
  if (!consumed) return catchThat();
  if (!yes) {
    await logAssistant(db, {
      coachId: coach.id,
      phone: coach.phone,
      channel,
      rawMessage: 'N',
      layer: 'confirm',
      intent: pending.intent,
      outcome: 'dropped',
    });
    return { text: 'Dropped.', pendingId: null, kind: 'dropped' };
  }
  const text = await executeWrite(db, coach, pending.payload);
  await logAssistant(db, {
    coachId: coach.id,
    phone: coach.phone,
    channel,
    rawMessage: 'Y',
    layer: 'execute',
    intent: pending.intent,
    payload: pending.payload,
    outcome: text,
  });
  return { text, pendingId: null, kind: 'done' };
}

/** Shared pipe for SMS and the schedule-screen field. */
export async function handleCoachMessage(
  db: DbClient,
  coach: CoachRow,
  text: string,
  channel: AssistantChannel,
  now: Date = new Date(),
): Promise<AssistantReply> {
  const trimmed = text.trim();
  if (!trimmed) return catchThat();

  const kw = keywordToken(trimmed);
  const pending = await getLivePending(db, coach.id, now);

  if ((kw === 'Y' || kw === 'N') && pending) {
    const reply = await resolvePendingRow(db, coach, pending, kw === 'Y', now, channel);
    await setLastReply(db, coach.id, reply.text, reply.pendingId, now);
    return reply;
  }

  if (pending && kw === null) {
    if (!pending.reaskedAt) {
      await markReasked(db, pending.id, now);
      await logAssistant(db, {
        coachId: coach.id,
        phone: coach.phone,
        channel,
        rawMessage: trimmed,
        layer: 'confirm',
        intent: pending.intent,
        outcome: 'reask',
      });
      await setLastReply(db, coach.id, pending.confirmText, pending.id, now);
      return { text: pending.confirmText, pendingId: pending.id, kind: 'reask' };
    }
    await consumePending(db, pending.id, now);
  }

  const sessions = await listUpcomingSessions(db, coach.id, now);
  const types = await loadSessionTypes(db, coach.id);
  const classified = await classifyUtterance(db, coach, trimmed, sessions, types, now, channel);
  const reply = await applyClassified(db, coach, classified, sessions, types, now);
  await setLastReply(db, coach.id, reply.text, reply.pendingId, now);
  return reply;
}

export async function resolvePendingForCoach(
  db: DbClient,
  coach: CoachRow,
  pendingId: number,
  yes: boolean,
  now: Date = new Date(),
  channel: AssistantChannel = 'web',
): Promise<AssistantReply> {
  const pending = await getPendingById(db, coach.id, pendingId, now);
  if (!pending) {
    const reply = { text: 'That question expired.', pendingId: null, kind: 'dropped' as const };
    await setLastReply(db, coach.id, reply.text, null, now);
    return reply;
  }
  const reply = await resolvePendingRow(db, coach, pending, yes, now, channel);
  await setLastReply(db, coach.id, reply.text, reply.pendingId, now);
  return reply;
}

export async function loadScheduleAssistant(
  db: DbClient,
  coachId: number,
  now: Date = new Date(),
): Promise<{ reply: LastReply | null; livePendingId: number | null }> {
  const reply = await getLastReply(db, coachId);
  if (!reply) return { reply: null, livePendingId: null };
  const live = await getLivePending(db, coachId, now);
  const livePendingId = live && reply.pendingId === live.id ? live.id : null;
  return { reply, livePendingId };
}
