import type { DbClient } from '../db/client.js';
import type { Contact } from './auth.js';

/** What the My sessions page (/my/sessions) shows one proven contact: their
 * bookings across every coach, and, for a proven mobile, their session
 * credits. A booking belongs to the contact when its contact mobile is the
 * proven mobile, or its contact email is the proven email whatever its
 * case. Credits are kept per mobile (SPEC.md §9.2), so an email never shows
 * them. Nothing here changes anything: cancelling and moving stay on each
 * booking's manage page. */

/** How far back the Past part goes. */
export const PAST_DAYS = 90;
/** The most rows either part shows. */
const MAX_ROWS = 100;

export type UpcomingState =
  | { kind: 'booked' }
  /** A spot held while the parent pays, until this moment. */
  | { kind: 'held'; until: string }
  /** A payment arrived but could not book the spot; the coach has it. */
  | { kind: 'payment-kept' };

export interface UpcomingBooking {
  athleteName: string;
  sessionName: string;
  startsAtUtc: string;
  tz: string;
  location: string | null;
  coachName: string;
  coachHandle: string;
  /** Null only for a booking from before manage links. */
  manageToken: string | null;
  state: UpcomingState;
}

/** A past booking in a parent's words. 'booked' is a session that took
 * place and that the coach has not marked either way. */
export type PastWord = 'attended' | 'missed' | 'cancelled' | 'refunded' | 'booked' | 'payment-kept';

export interface PastBooking {
  athleteName: string;
  sessionName: string;
  startsAtUtc: string;
  tz: string;
  coachName: string;
  word: PastWord;
}

export interface CoachCredits {
  coachName: string;
  coachHandle: string;
  /** The coach's zone, for an expiry date. */
  tz: string;
  /** Sessions that can be booked with now. */
  usable: number;
  /** Sessions held while a refund of the payment that bought them is on
   * its way (SPEC.md §9.4): not usable until it fails, gone once it lands. */
  onHold: number;
  /** The usable sessions by when they expire, soonest first; null never does. */
  expiring: Array<{ count: number; expiresAt: string | null }>;
}

export interface MySessions {
  upcoming: UpcomingBooking[];
  past: PastBooking[];
  /** Null for a proven email: credits show only for a proven mobile. */
  credits: CoachCredits[] | null;
}

interface BookingListRow {
  id: number;
  athlete_name: string;
  status: string;
  manage_token: string | null;
  hold_expires_at: string | Date | null;
  payment_kept: boolean;
  starts_at_utc: string | Date;
  tz: string;
  location_text: string | null;
  session_status: string;
  session_name: string;
  coach_name: string;
  coach_handle: string;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

/** The contact's bookings whose session starts after the Past part's
 * cutoff, newest first. */
async function bookingsOf(db: DbClient, contact: Contact, now: Date): Promise<BookingListRow[]> {
  const belongs = contact.kind === 'email' ? 'lower(b.contact_email) = $1' : 'b.contact_phone = $1';
  const result = await db.query<BookingListRow>(
    `select b.id, b.athlete_name, b.status, b.manage_token, b.hold_expires_at,
            exists (select 1 from payment_attention pa where pa.booking_id = b.id) as payment_kept,
            s.starts_at_utc, s.tz, s.location_text, s.status as session_status,
            st.name as session_name, c.name as coach_name, c.handle as coach_handle
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where ${belongs} and s.starts_at_utc > $2
     order by s.starts_at_utc desc, b.id desc
     limit ${4 * MAX_ROWS}`,
    [contact.kind === 'email' ? contact.email : contact.phone, new Date(now.getTime() - PAST_DAYS * 24 * 60 * 60 * 1000).toISOString()],
  );
  return result.rows;
}

/** A booking for a session still to come that is, or may yet be, the
 * parent's: booked, a live hold, or a payment the coach is holding. */
function upcomingState(row: BookingListRow, now: Date): UpcomingState | null {
  if (row.session_status !== 'scheduled' || new Date(row.starts_at_utc) <= now) return null;
  if (row.status === 'booked') return { kind: 'booked' };
  if (row.status !== 'pending') return null;
  if (row.payment_kept) return { kind: 'payment-kept' };
  return row.hold_expires_at !== null && new Date(row.hold_expires_at) > now ? { kind: 'held', until: iso(row.hold_expires_at) } : null;
}

/** What became of a booking that is not coming up. Null for a hold that
 * ran out unpaid: it was never a booking. */
function pastWord(row: BookingListRow): PastWord | null {
  switch (row.status) {
    case 'attended':
      return 'attended';
    case 'noshow':
      return 'missed';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
    case 'booked':
      return row.session_status === 'cancelled' ? 'cancelled' : 'booked';
    case 'pending':
      return row.payment_kept ? 'payment-kept' : null;
    default:
      return null;
  }
}

interface CreditListRow {
  coach_id: number;
  coach_name: string;
  coach_handle: string;
  coach_tz: string;
  remaining: number;
  expires_at: string | Date | null;
  held: boolean;
}

/** The mobile's unspent, unexpired credits, coach by coach. A credit a
 * refund withdrew is gone and is not listed. */
async function creditsOf(db: DbClient, phone: string, now: Date): Promise<CoachCredits[]> {
  const result = await db.query<CreditListRow>(
    `select c.id as coach_id, c.name as coach_name, c.handle as coach_handle, c.tz as coach_tz,
            cr.remaining, cr.expires_at, (cr.refund_id is not null) as held
     from credit cr
     join coach c on c.id = cr.coach_id
     where cr.contact_phone = $1 and cr.remaining > 0 and cr.withdrawn_at is null
       and (cr.expires_at is null or cr.expires_at > $2)
     order by c.name, c.id, cr.expires_at asc nulls last, cr.id`,
    [phone, now.toISOString()],
  );
  const byCoach = new Map<number, CoachCredits>();
  for (const row of result.rows) {
    let coach = byCoach.get(row.coach_id);
    if (!coach) {
      coach = { coachName: row.coach_name, coachHandle: row.coach_handle, tz: row.coach_tz, usable: 0, onHold: 0, expiring: [] };
      byCoach.set(row.coach_id, coach);
    }
    const count = Number(row.remaining);
    if (row.held) {
      coach.onHold += count;
      continue;
    }
    coach.usable += count;
    const expiresAt = row.expires_at === null ? null : iso(row.expires_at);
    const same = coach.expiring.find((e) => e.expiresAt === expiresAt);
    if (same) same.count += count;
    else coach.expiring.push({ count, expiresAt });
  }
  return [...byCoach.values()];
}

export async function loadMySessions(db: DbClient, contact: Contact, now: Date = new Date()): Promise<MySessions> {
  const upcoming: UpcomingBooking[] = [];
  const past: PastBooking[] = [];
  for (const row of await bookingsOf(db, contact, now)) {
    const about = {
      athleteName: row.athlete_name,
      sessionName: row.session_name,
      startsAtUtc: iso(row.starts_at_utc),
      tz: row.tz,
      coachName: row.coach_name,
    };
    const state = upcomingState(row, now);
    if (state) {
      upcoming.push({ ...about, location: row.location_text, coachHandle: row.coach_handle, manageToken: row.manage_token, state });
      continue;
    }
    const word = pastWord(row);
    if (word) past.push({ ...about, word });
  }
  return {
    // Rows arrive newest first: the next session leads Coming up, the most
    // recent leads Past.
    upcoming: upcoming.reverse().slice(0, MAX_ROWS),
    past: past.slice(0, MAX_ROWS),
    credits: contact.kind === 'phone' ? await creditsOf(db, contact.phone, now) : null,
  };
}
