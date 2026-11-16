import { createHash, randomBytes } from 'node:crypto';
import type { DbClient } from '../db/client.js';
import { writeCalendar, type IcalCalendar, type IcalEvent } from '../lib/ical.js';
import { appBaseUrl } from './payments.js';
import { soldSql } from './pricing.js';
import type { LimitRule } from './requestLimits.js';

/** A coach's schedule as a calendar a calendar app subscribes to (SPEC.md
 * §8.2): one private link, added once to Apple, Google or Outlook
 * calendar, which then reads it again on its own. The link is the only key
 * and is given to calendar providers, who fetch and keep the file, so the
 * file names no athlete or parent and carries no phone or email. */

// ---- The link ----

/** 32 random bytes, URL-safe: 43 characters. */
function newFeedToken(): string {
  return randomBytes(32).toString('base64url');
}

/** True for text shaped like a feed's key. Anything else is never looked up. */
export function isFeedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The address a calendar app reads: https://coachatron.com/cal/<token>.ics. */
export function calendarFeedUrl(token: string): string {
  return `${appBaseUrl()}/cal/${token}.ics`;
}

/** The same address under webcal:, which a phone or a Mac opens in its
 * calendar app as a calendar to subscribe to. */
export function calendarWebcalUrl(token: string): string {
  return calendarFeedUrl(token).replace(/^https?:/i, 'webcal:');
}

/** The coach's link, or null while it is off. */
export async function getCalendarToken(db: DbClient, coachId: number): Promise<string | null> {
  const result = await db.query<{ token: string }>('select token from calendar_feed where coach_id = $1', [coachId]);
  return result.rows[0]?.token ?? null;
}

/** First use: makes the coach's link. A coach who already has one keeps it,
 * so sending the form twice never breaks a calendar that uses it. One
 * statement, so two requests at once end with the same link. */
export async function turnOnCalendarFeed(db: DbClient, coachId: number): Promise<string> {
  const result = await db.query<{ token: string }>(
    `insert into calendar_feed (coach_id, token) values ($1, $2)
     on conflict (coach_id) do update set coach_id = calendar_feed.coach_id
     returning token`,
    [coachId, newFeedToken()],
  );
  return result.rows[0].token;
}

/** "Get a new link": the address before stops working with this statement. */
export async function replaceCalendarToken(db: DbClient, coachId: number): Promise<string> {
  const result = await db.query<{ token: string }>(
    `insert into calendar_feed (coach_id, token) values ($1, $2)
     on conflict (coach_id) do update set token = excluded.token, created_at = now()
     returning token`,
    [coachId, newFeedToken()],
  );
  return result.rows[0].token;
}

/** "Turn off": the address stops working, and no link is left. */
export async function turnOffCalendarFeed(db: DbClient, coachId: number): Promise<void> {
  await db.query('delete from calendar_feed where coach_id = $1', [coachId]);
}

export interface FeedCoach {
  id: number;
  name: string;
}

/** The coach a link belongs to; null for one that was never made, was
 * replaced, or was turned off. */
export async function findFeedCoach(db: DbClient, token: string): Promise<FeedCoach | null> {
  if (!isFeedToken(token)) return null;
  const result = await db.query<FeedCoach>(
    'select c.id, c.name from calendar_feed f join coach c on c.id = f.coach_id where f.token = $1',
    [token],
  );
  return result.rows[0] ?? null;
}

// ---- Limits ----

const HOUR_MS = 60 * 60 * 1000;

/** Reads of one coach's calendar, from every address together. A calendar
 * app that looks every five minutes, the most often any is set to, reads
 * 12 times an hour, so a phone, a laptop and a provider's servers on the
 * same link stay well below this. Counted by takeRequest
 * (requestLimits.ts) like every other limit, in hour windows, which the
 * tick's purge of old counters already covers. */
export const CALENDAR_FEED_LIMITS: LimitRule[] = [{ bucket: 'cal-feed-hour', windowMs: HOUR_MS, max: 60 }];

/** Reads from one address, whatever link each names, known or not. Twice a
 * single calendar's, because a calendar provider reads many coaches'
 * calendars from the same few addresses. */
export const CALENDAR_ADDRESS_LIMITS: LimitRule[] = [{ bucket: 'cal-ip-hour', windowMs: HOUR_MS, max: 120 }];

/** The counter key for one coach's calendar: the coach's id, never the
 * link, so the link is written nowhere but its own row. A new link counts
 * with the one it replaced. */
export function calendarFeedKey(coachId: number): string {
  return `calendar:${coachId}`;
}

/** Seconds until the hour's count starts again, for Retry-After. */
export function calendarRetryAfterSeconds(now: Date): number {
  return Math.max(1, Math.ceil((HOUR_MS - (now.getTime() % HOUR_MS)) / 1000));
}

// ---- The file ----

/** How far back the calendar goes. */
export const FEED_DAYS_BACK = 30;
/** The most sessions one file holds. */
export const FEED_MAX_EVENTS = 500;
/** How often a calendar app is asked to read the file again: an hour. */
const FEED_REFRESH = 'PT1H';
const FEED_PRODUCT_ID = '-//Coachatron//Schedule//EN';

interface FeedSessionRow {
  id: number;
  starts_at_utc: string | Date;
  duration_min: number;
  name: string;
  location_text: string | null;
  status: string;
  overflow_of: number | null;
  capacity: number;
  booked: number;
  waiting: number;
  assistant_name: string | null;
}

/** The coach's sessions from FEED_DAYS_BACK days ago through the last one
 * on the calendar, cancelled ones included, in the order they start. When
 * there are more than FEED_MAX_EVENTS, the ones still to come are kept
 * first, soonest first, and then the latest of the ones that have started.
 * Booked is counted as the Schedule screen counts it. Waiting is the
 * session's own waitlist; a second group has none of its own (its spots go
 * to the full session's), so those people are counted once, there. */
async function loadFeedSessions(db: DbClient, coachId: number, now: Date): Promise<FeedSessionRow[]> {
  const result = await db.query<FeedSessionRow>(
    `select s.id, s.starts_at_utc, st.duration_min, st.name, s.location_text, s.status, s.overflow_of,
            coalesce(s.capacity_override, st.capacity) as capacity,
            (select count(*) from booking b where b.session_id = s.id and ${soldSql('b')})::int as booked,
            (select count(*) from waitlist w where w.session_id = s.id and w.state = 'waiting')::int as waiting,
            rm.name as assistant_name
     from session s
     join session_type st on st.id = s.session_type_id
     left join roster_member rm on rm.id = s.assigned_roster_member_id
     where st.coach_id = $1 and s.starts_at_utc >= $2::timestamptz
     order by (s.starts_at_utc < $3::timestamptz), abs(extract(epoch from (s.starts_at_utc - $3::timestamptz))), s.id
     limit $4`,
    [coachId, new Date(now.getTime() - FEED_DAYS_BACK * 24 * HOUR_MS).toISOString(), now.toISOString(), FEED_MAX_EVENTS],
  );
  return result.rows.sort((a, b) => new Date(a.starts_at_utc).getTime() - new Date(b.starts_at_utc).getTime() || a.id - b.id);
}

/** Session detail (screen 3), which asks the coach to sign in. */
function sessionDetailUrl(sessionId: number): string {
  return `${appBaseUrl()}/app/sessions/${sessionId}`;
}

/** One session as a calendar event. The count is of athletes, never who
 * they are; the only person named is an assistant coach from the roster. */
function feedEvent(s: FeedSessionRow): IcalEvent {
  const start = new Date(s.starts_at_utc);
  const cancelled = s.status === 'cancelled';
  const url = sessionDetailUrl(s.id);
  const description = [cancelled ? 'Cancelled.' : `${s.booked} of ${s.capacity} booked, ${s.waiting} waiting`];
  const assistant = (s.assistant_name ?? '').trim();
  if (assistant) description.push(s.overflow_of !== null ? `Second group, coached by ${assistant}` : `Backup coach: ${assistant}`);
  description.push(`Session detail (sign in to open): ${url}`);
  return {
    // The same domain in every environment: a calendar tells events apart
    // by this, and it is not an address anyone opens.
    uid: `session-${s.id}@coachatron.com`,
    start,
    end: new Date(start.getTime() + s.duration_min * 60_000),
    summary: cancelled ? `Cancelled: ${s.name}` : `${s.name} (${s.booked} of ${s.capacity})`,
    location: s.location_text?.trim() || null,
    description,
    url,
    cancelled,
  };
}

export interface CalendarFile {
  /** The iCalendar text, ready to send. */
  body: string;
  /** Changes only when something a calendar shows changed: every event's
   * DTSTAMP is the moment the file was written and is left out of it. A
   * weak tag for that reason. */
  etag: string;
}

/** The coach's calendar as it stands at `now`. */
export async function buildCalendarFeed(db: DbClient, coach: FeedCoach, now: Date = new Date()): Promise<CalendarFile> {
  const sessions = await loadFeedSessions(db, coach.id, now);
  const calendar: IcalCalendar = {
    prodId: FEED_PRODUCT_ID,
    name: `Coachatron: ${coach.name}`,
    refresh: FEED_REFRESH,
    stamp: now,
    events: sessions.map(feedEvent),
  };
  const unstamped = writeCalendar({ ...calendar, stamp: new Date(0) });
  return {
    body: writeCalendar(calendar),
    etag: `W/"${createHash('sha256').update(unstamped).digest('base64url').slice(0, 32)}"`,
  };
}
