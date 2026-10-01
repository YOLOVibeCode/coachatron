import type { DbClient } from '../db/client.js';
import type { CoachRow } from './auth.js';
import { reserveModelCall } from './modelBudget.js';
import { logAssistant } from './assistantPending.js';
import { createPackage, createPlan } from './pricing.js';
import { addCalendarDays, createWeeklySlots, zonedParts, zonedTimeToUtc, type WeeklySlot } from './scheduling.js';
import { complete } from '../llm/complete.js';
import { SETUP_JSON_SCHEMA } from '../llm/setupSchema.js';
import { html, raw, type SafeHtml } from '../lib/html.js';
import { formatLocal, isValidTimeZone } from '../lib/time.js';
import { APP_BASE_URL } from '../config.js';

/** Voice setup: the coach says their week, the model extracts it into
 * SETUP_JSON_SCHEMA, and everything after that is product code. Nothing is
 * written to the schedule until the coach taps Publish on a preview this
 * module rendered (PLATFORM.md §4.3 R2, and the R5 exception for additive
 * setup). */

export interface SetupType {
  key: string;
  name: string;
  duration_min: number;
  capacity: number | null;
  price_cents: number | null;
  backup_pay_cents: number | null;
  /** Set when the name matches a session type the coach already has. */
  existing_id: number | null;
}

export interface SetupSlot {
  type_key: string;
  weekday: number;
  time_local: string;
  location: string | null;
}

export interface SetupPackage {
  name: string;
  credits: number;
  price_cents: number;
  expires_days: number | null;
}

export interface SetupPlanOffer {
  name: string;
  price_cents: number;
  credits_per_month: number;
}

export interface SetupPlan {
  coach_timezone: string | null;
  session_types: SetupType[];
  weekly: SetupSlot[];
  packages: SetupPackage[];
  plans: SetupPlanOffer[];
}

export interface ExistingType {
  id: number;
  name: string;
  duration_min: number;
  capacity: number;
  price_cents: number;
  backup_pay_cents: number | null;
}

export const SETUP_LIMITS = { types: 6, weekly: 40, packages: 4, plans: 3 };
export const SETUP_MODEL_TIMEOUT_MS = 8000;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DURATION = 60;
const PRIVATE_NAME = /private|1[- ]?on[- ]?1|one[- ]on[- ]one|lesson/i;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function name(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim().replace(/\s+/g, ' ');
  return t.length >= 1 && t.length <= 60 ? t : null;
}

function timeLocal(value: unknown): string | null {
  const m = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 5 || hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

/** Turns whatever the model returned into a plan the product trusts, plus
 * the questions it must ask before Publish. Pure: no model, no database. */
export function validateSetupPlan(raw: unknown, existing: ExistingType[]): { plan: SetupPlan; questions: string[] } {
  const o = asRecord(raw);
  const questions: string[] = [];

  let coachTimezone: string | null = null;
  if (typeof o.coach_timezone === 'string' && o.coach_timezone.trim()) {
    if (isValidTimeZone(o.coach_timezone.trim())) coachTimezone = o.coach_timezone.trim();
    else questions.push('What city are your sessions in, for the time zone?');
  }

  const types: SetupType[] = [];
  const keyToType = new Map<string, SetupType>();
  for (const item of asArray(o.session_types)) {
    const t = asRecord(item);
    const typeName = name(t.name);
    if (!typeName) continue;
    const key = typeof t.key === 'string' && t.key ? t.key : typeName;
    const same = types.find((x) => x.name.toLowerCase() === typeName.toLowerCase());
    if (same) {
      keyToType.set(key, same);
      continue;
    }
    if (types.length >= SETUP_LIMITS.types) continue;
    const match = existing.find((e) => e.name.toLowerCase() === typeName.toLowerCase());
    const type: SetupType = match
      ? {
          key,
          name: match.name,
          duration_min: match.duration_min,
          capacity: match.capacity,
          price_cents: match.price_cents,
          backup_pay_cents: match.backup_pay_cents,
          existing_id: match.id,
        }
      : {
          key,
          name: typeName,
          duration_min: intIn(t.duration_min, 10, 480) ?? DEFAULT_DURATION,
          capacity: intIn(t.capacity, 1, 100) ?? (PRIVATE_NAME.test(typeName) ? 1 : null),
          price_cents: intIn(t.price_cents, 100, 100000),
          backup_pay_cents: intIn(t.backup_pay_cents, 100, 100000),
          existing_id: null,
        };
    types.push(type);
    keyToType.set(key, type);
  }

  const weekly: SetupSlot[] = [];
  for (const item of asArray(o.weekly)) {
    if (weekly.length >= SETUP_LIMITS.weekly) break;
    const w = asRecord(item);
    const type = typeof w.type_key === 'string' ? keyToType.get(w.type_key) : undefined;
    const weekday = intIn(w.weekday, 0, 6);
    const time = timeLocal(w.time_local);
    if (!type || weekday === null || !time) continue;
    if (weekly.some((x) => x.type_key === type.key && x.weekday === weekday && x.time_local === time)) continue;
    const location = typeof w.location === 'string' && w.location.trim() ? w.location.trim().slice(0, 80) : null;
    weekly.push({ type_key: type.key, weekday, time_local: time, location });
  }

  const packages: SetupPackage[] = [];
  for (const item of asArray(o.packages)) {
    if (packages.length >= SETUP_LIMITS.packages) break;
    const p = asRecord(item);
    const packageName = name(p.name);
    const credits = intIn(p.credits, 1, 100);
    const price = intIn(p.price_cents, 100, 500000);
    if (!packageName || credits === null || price === null) continue;
    packages.push({ name: packageName, credits, price_cents: price, expires_days: intIn(p.expires_days, 1, 730) });
  }

  const plans: SetupPlanOffer[] = [];
  for (const item of asArray(o.plans)) {
    if (plans.length >= SETUP_LIMITS.plans) break;
    const p = asRecord(item);
    const planName = name(p.name);
    const price = intIn(p.price_cents, 100, 100000);
    const credits = intIn(p.credits_per_month, 1, 60);
    if (!planName || price === null || credits === null) continue;
    plans.push({ name: planName, price_cents: price, credits_per_month: credits });
  }

  for (const type of types) {
    if (type.price_cents === null) questions.push(`What do you charge for ${type.name}?`);
    if (type.capacity === null) questions.push(`How many athletes fit in ${type.name}?`);
  }
  if (types.length === 0) {
    questions.push('What do you coach? Say the name, how long, how many athletes, and the price.');
  } else if (weekly.length === 0) {
    questions.push('What days and times do you run each week?');
  }

  return {
    plan: { coach_timezone: coachTimezone, session_types: types, weekly, packages, plans },
    questions,
  };
}

// ---- The model's part: extraction only ----

function localDateLine(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  return `${WEEKDAYS[p.weekday]} ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function setupSystemPrompt(
  coach: CoachRow,
  existing: ExistingType[],
  draft: { plan: SetupPlan; questions: string[] } | null,
  now: Date,
): string {
  const lines = [
    "Extract a coach's weekly schedule into the JSON schema. JSON only.",
    'Only what the coach said. Use null for anything not said. Never invent a price or a capacity.',
    'Prices and pay are integer cents: "$35" is 3500.',
    'Durations are minutes: "an hour" is 60, "an hour and a half" is 90.',
    'weekday: 0 Sunday, 1 Monday, 2 Tuesday, 3 Wednesday, 4 Thursday, 5 Friday, 6 Saturday.',
    'time_local is 24-hour HH:MM. A bare hour from 1 to 11 means pm unless the coach says morning or am.',
    '"Tuesdays and Thursdays at 6" is two weekly entries. "Saturday 9 to noon" in 45-minute slots is 9:00, 9:45, 10:30, 11:15.',
    'Each weekly entry names its session type by key. Give every session type a short unique key.',
    'backup_pay_cents is what a backup coach is paid to run one session, if the coach says so.',
    'coach_timezone is an IANA zone only if the coach names a city or zone; otherwise null.',
    'Packages are prepaid session packs. Plans are monthly subscriptions.',
    'Leave out phone numbers, emails, and card numbers.',
    `Today is ${localDateLine(now, coach.tz)} in ${coach.tz}.`,
    `Session types the coach already has: ${existing.map((e) => e.name).join(', ') || '(none)'}.`,
  ];
  if (draft) {
    lines.push(`Current setup: ${JSON.stringify(draft.plan)}`);
    if (draft.questions.length) lines.push(`Questions the coach is answering: ${draft.questions.join(' ')}`);
    lines.push("Apply the coach's message to the current setup and return the full updated setup.");
  }
  return lines.join('\n');
}

export type ExtractResult = { kind: 'ok'; raw: unknown } | { kind: 'cap' } | { kind: 'error' };

export async function extractSetupPlan(
  db: DbClient,
  coach: CoachRow,
  text: string,
  existing: ExistingType[],
  draft: { plan: SetupPlan; questions: string[] } | null,
  now: Date,
  channel: 'sms' | 'web',
): Promise<ExtractResult> {
  if (!(await reserveModelCall(db, coach, now))) {
    await logAssistant(db, { coachId: coach.id, phone: coach.phone, channel, rawMessage: text, layer: 'setup', outcome: 'cap' });
    return { kind: 'cap' };
  }
  try {
    const raw = await complete({
      messages: [
        { role: 'system', content: setupSystemPrompt(coach, existing, draft, now) },
        { role: 'user', content: text },
      ],
      schema: SETUP_JSON_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'setup',
      timeoutMs: SETUP_MODEL_TIMEOUT_MS,
    });
    await logAssistant(db, {
      coachId: coach.id,
      phone: coach.phone,
      channel,
      rawMessage: text,
      layer: 'setup',
      payload: raw,
      outcome: 'extracted',
    });
    return { kind: 'ok', raw };
  } catch {
    await logAssistant(db, { coachId: coach.id, phone: coach.phone, channel, rawMessage: text, layer: 'setup', outcome: 'error' });
    return { kind: 'error' };
  }
}

// ---- Drafts ----

export interface SetupDraft {
  id: number;
  plan: SetupPlan;
  questions: string[];
}

export async function loadExistingTypes(db: DbClient, coachId: number): Promise<ExistingType[]> {
  const result = await db.query<ExistingType>(
    `select id, name, duration_min, capacity, price_cents, backup_pay_cents
     from session_type where coach_id = $1 and active = true order by id`,
    [coachId],
  );
  return result.rows;
}

export async function getOpenDraft(db: DbClient, coachId: number, now: Date): Promise<SetupDraft | null> {
  const result = await db.query<{ id: number; plan: string; questions: string }>(
    `select id, plan, questions from setup_draft
     where coach_id = $1 and published_at is null and discarded_at is null and updated_at > $2
     order by id desc limit 1`,
    [coachId, new Date(now.getTime() - DRAFT_TTL_MS).toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, plan: JSON.parse(row.plan) as SetupPlan, questions: JSON.parse(row.questions) as string[] };
}

async function saveDraft(
  db: DbClient,
  coachId: number,
  existingDraftId: number | null,
  text: string,
  plan: SetupPlan,
  questions: string[],
  now: Date,
): Promise<number> {
  if (existingDraftId !== null) {
    await db.query(
      `update setup_draft set source_text = source_text || E'\\n' || $2, plan = $3, questions = $4, updated_at = $5
       where id = $1`,
      [existingDraftId, text, JSON.stringify(plan), JSON.stringify(questions), now.toISOString()],
    );
    return existingDraftId;
  }
  const result = await db.query<{ id: number }>(
    `insert into setup_draft (coach_id, source_text, plan, questions, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5) returning id`,
    [coachId, text, JSON.stringify(plan), JSON.stringify(questions), now.toISOString()],
  );
  return result.rows[0].id;
}

export type SetupResult = { kind: 'draft'; draft: SetupDraft } | { kind: 'cap' } | { kind: 'error' };

/** One message from the coach, on the web or by SMS: extract, validate,
 * and save (or update) the open draft. Writes nothing to the schedule. */
export async function handleSetupMessage(
  db: DbClient,
  coach: CoachRow,
  text: string,
  channel: 'sms' | 'web',
  now: Date = new Date(),
): Promise<SetupResult> {
  const existing = await loadExistingTypes(db, coach.id);
  const open = await getOpenDraft(db, coach.id, now);
  const extracted = await extractSetupPlan(db, coach, text, existing, open, now, channel);
  if (extracted.kind !== 'ok') return extracted;
  const { plan, questions } = validateSetupPlan(extracted.raw, existing);
  const id = await saveDraft(db, coach.id, open?.id ?? null, text, plan, questions, now);
  return { kind: 'draft', draft: { id, plan, questions } };
}

export async function discardDraft(db: DbClient, coachId: number, draftId: number): Promise<void> {
  await db.query(
    'update setup_draft set discarded_at = now() where id = $1 and coach_id = $2 and published_at is null',
    [draftId, coachId],
  );
}

/** True once the coach has something on the calendar or a weekly time. */
export async function coachHasSchedule(db: DbClient, coachId: number, now: Date = new Date()): Promise<boolean> {
  const result = await db.query<{ id: number }>(
    `select s.id from session s join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > $2
     union all
     select ws.id from weekly_slot ws join session_type st on st.id = ws.session_type_id
     where st.coach_id = $1 and ws.active = true
     limit 1`,
    [coachId, now.toISOString()],
  );
  return result.rows.length > 0;
}

export interface PublishCounts {
  types: number;
  weekly: number;
  sessions: number;
  packages: number;
  plans: number;
}

/** Writes a question-free draft to the schedule. There is no transaction
 * (the pg Pool does not pin a client), so this is idempotent instead: the
 * draft is claimed first, so a double tap publishes once; types, packages,
 * plans, and weekly times that already exist are reused, not duplicated. */
export async function publishSetupPlan(
  db: DbClient,
  coach: CoachRow,
  draftId: number,
  now: Date = new Date(),
): Promise<PublishCounts | null> {
  const claimed = await db.query<{ plan: string }>(
    `update setup_draft set published_at = $3
     where id = $1 and coach_id = $2 and published_at is null and discarded_at is null and questions = '[]'
     returning plan`,
    [draftId, coach.id, now.toISOString()],
  );
  if (claimed.rows.length === 0) return null;
  const plan = JSON.parse(claimed.rows[0].plan) as SetupPlan;
  const counts: PublishCounts = { types: 0, weekly: 0, sessions: 0, packages: 0, plans: 0 };

  let tz = coach.tz;
  if (plan.coach_timezone && plan.coach_timezone !== coach.tz && !(await coachHasSchedule(db, coach.id, now))) {
    tz = plan.coach_timezone;
    await db.query('update coach set tz = $1 where id = $2', [tz, coach.id]);
  }

  const existing = await loadExistingTypes(db, coach.id);
  const typeIds = new Map<string, number>();
  for (const type of plan.session_types) {
    const match = existing.find((e) => e.id === type.existing_id || e.name.toLowerCase() === type.name.toLowerCase());
    if (match) {
      typeIds.set(type.key, match.id);
      continue;
    }
    const inserted = await db.query<{ id: number }>(
      `insert into session_type (coach_id, name, duration_min, capacity, price_cents, backup_pay_cents, active)
       values ($1, $2, $3, $4, $5, $6, true) returning id`,
      [coach.id, type.name, type.duration_min, type.capacity, type.price_cents, type.backup_pay_cents],
    );
    typeIds.set(type.key, inserted.rows[0].id);
    counts.types += 1;
  }

  const byType = new Map<number, WeeklySlot[]>();
  for (const slot of plan.weekly) {
    const typeId = typeIds.get(slot.type_key);
    if (typeId === undefined) continue;
    const dup = await db.query<{ id: number }>(
      'select id from weekly_slot where session_type_id = $1 and weekday = $2 and time_local = $3 and active = true',
      [typeId, slot.weekday, slot.time_local],
    );
    if (dup.rows.length > 0) continue;
    const list = byType.get(typeId) ?? [];
    list.push({ weekday: slot.weekday, timeLocal: slot.time_local, locationText: slot.location });
    byType.set(typeId, list);
  }
  for (const [typeId, slots] of byType) {
    const created = await createWeeklySlots(db, typeId, tz, slots, now);
    counts.weekly += created.length;
    const n = await db.query<{ n: string }>(
      'select count(*)::text as n from session where weekly_slot_id = any($1::int[])',
      [created.map((c) => c.id)],
    );
    counts.sessions += Number(n.rows[0]?.n ?? '0');
  }

  for (const pack of plan.packages) {
    const dup = await db.query<{ id: number }>(
      'select id from package where coach_id = $1 and lower(name) = lower($2) and active = true',
      [coach.id, pack.name],
    );
    if (dup.rows.length > 0) continue;
    await createPackage(db, coach.id, pack.name, pack.credits, pack.price_cents, pack.expires_days ?? undefined);
    counts.packages += 1;
  }
  for (const offer of plan.plans) {
    const dup = await db.query<{ id: number }>(
      'select id from plan where coach_id = $1 and lower(name) = lower($2) and active = true',
      [coach.id, offer.name],
    );
    if (dup.rows.length > 0) continue;
    await createPlan(db, coach.id, offer.name, offer.price_cents, offer.credits_per_month);
    counts.plans += 1;
  }

  await logAssistant(db, {
    coachId: coach.id,
    phone: coach.phone,
    channel: 'web',
    rawMessage: 'Publish',
    layer: 'setup',
    payload: counts,
    outcome: 'published',
  });
  return counts;
}

// ---- The preview, written by product code ----

export function formatClock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
}

function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "Tue & Thu 6:00pm · Field 3", one line per time and place. */
export function describeWeekly(slots: SetupSlot[]): string[] {
  const groups = new Map<string, { time: string; location: string | null; days: number[] }>();
  for (const slot of [...slots].sort((a, b) => a.time_local.localeCompare(b.time_local) || a.weekday - b.weekday)) {
    const k = `${slot.time_local}|${slot.location ?? ''}`;
    const g = groups.get(k) ?? { time: slot.time_local, location: slot.location, days: [] };
    g.days.push(slot.weekday);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const days = [...g.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(' & ');
    return `${days} ${formatClock(g.time)}${g.location ? ` · ${g.location}` : ''}`;
  });
}

export function describeType(type: SetupType): string {
  const parts = [`${type.duration_min} min`];
  parts.push(type.capacity === null ? 'how many?' : `${type.capacity} ${type.capacity === 1 ? 'athlete' : 'athletes'}`);
  parts.push(type.price_cents === null ? 'price?' : money(type.price_cents));
  if (type.backup_pay_cents) parts.push(`backup pays ${money(type.backup_pay_cents)}`);
  return parts.join(' · ');
}

function firstSession(plan: SetupPlan, tz: string, now: Date): string | null {
  let best: Date | null = null;
  const today = zonedParts(now, tz);
  for (const slot of plan.weekly) {
    const [hour, minute] = slot.time_local.split(':').map(Number);
    for (let offset = 0; offset <= 7; offset += 1) {
      const d = addCalendarDays(today.year, today.month, today.day, offset);
      if (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() !== slot.weekday) continue;
      const at = zonedTimeToUtc(d.year, d.month, d.day, hour, minute, tz);
      if (at > now && (!best || at < best)) best = at;
    }
  }
  return best ? formatLocal(best.toISOString(), tz) : null;
}

function zoneName(tz: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

export function renderSetupPreview(plan: SetupPlan, coach: CoachRow, now: Date = new Date()): SafeHtml {
  const tz = plan.coach_timezone ?? coach.tz;
  const first = firstSession(plan, tz, now);
  return html`<div class="card setup-preview">
    ${plan.session_types.map((type) => {
      const times = describeWeekly(plan.weekly.filter((w) => w.type_key === type.key));
      return html`<div class="setup-type">
        <strong>${type.name}</strong>${type.existing_id ? html` <span class="muted">(already set up)</span>` : raw('')}
        <div class="meta"><span>${describeType(type)}</span></div>
        ${times.map((line) => html`<div class="meta"><span>${line}</span></div>`)}
      </div>`;
    })}
    ${plan.packages.map(
      (p) => html`<div class="meta"><span>${p.name}: ${p.credits} sessions for ${money(p.price_cents)}${p.expires_days ? `, use within ${p.expires_days} days` : ''}</span></div>`,
    )}
    ${plan.plans.map(
      (p) => html`<div class="meta"><span>${p.name}: ${money(p.price_cents)}/mo, ${p.credits_per_month} sessions</span></div>`,
    )}
    ${first ? html`<p class="muted">First session: ${first}. Times in ${zoneName(tz, now)}.</p>` : raw('')}
    <p class="muted">Your link: ${APP_BASE_URL.replace(/^https?:\/\//, '')}/c/${coach.handle}</p>
  </div>`;
}

/** The one-segment SMS answer to a setup message. */
export function setupSmsReply(result: SetupResult): string {
  const link = `${APP_BASE_URL}/app/schedule`;
  if (result.kind !== 'draft') return `I couldn't read that. Set it up here: ${link}`;
  const { plan, questions } = result.draft;
  if (questions.length > 0) return `One question: ${questions[0]} Reply here.`;
  const n = plan.session_types.length;
  const m = plan.weekly.length;
  return `Got it: ${n} session ${n === 1 ? 'type' : 'types'}, ${m} ${m === 1 ? 'time' : 'times'} a week. Check it and tap Publish: ${link}`;
}
