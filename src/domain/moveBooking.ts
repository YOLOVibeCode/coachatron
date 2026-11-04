import { inTransaction, type DbClient } from '../db/client.js';
import { CREDIT_HELD_SQL, cancelCutoff } from './policy.js';
import { countKeptForWaitlist, countTakenSpots, lockSession, takesSpotSql } from './pricing.js';

/** A parent moves a booking from its manage link (SPEC.md §7.2) to another
 * upcoming session of the same session type that has room, until the
 * coach's cancellation window closes (§9.5). The booking keeps its row, its
 * manage link and its payment or credit: nothing is charged, refunded or
 * drawn. The bookings one payment bought (the children of a pass paid
 * together) move together, so a refund of that payment still finds every
 * one of them in one session (§9.4). */

/** Whether the booking can move now, or why not:
 * - open: it can;
 * - too-late: the coach's window has closed (or the session started);
 * - not-booked: it is pending, cancelled, refunded, or its session is not scheduled;
 * - refund-pending: a refund of its payment is on its way;
 * - paid-together: a booking its payment also bought is no longer booked here. */
export type MoveState = 'open' | 'too-late' | 'not-booked' | 'refund-pending' | 'paid-together';

interface MovingBooking {
  id: number;
  session_id: number;
  session_type_id: number;
  status: string;
  athlete_name: string;
  contact_phone: string;
  charge_id: string | null;
  starts_at_utc: string | Date;
  session_status: string;
  cancel_window_hours: number;
  refund_on_way: boolean;
  credit_held: boolean;
}

const MOVING_SQL = `select b.id, b.session_id, s.session_type_id, b.status, b.athlete_name, b.contact_phone, b.charge_id,
    s.starts_at_utc, s.status as session_status, c.cancel_window_hours,
    exists (select 1 from refund r where r.payment_ref = b.charge_id and r.status in ('requested', 'pending')) as refund_on_way,
    ${CREDIT_HELD_SQL}
  from booking b
  join session s on s.id = b.session_id
  join session_type st on st.id = s.session_type_id
  join coach c on c.id = st.coach_id
  where b.manage_token = $1`;

interface Together {
  id: number;
  status: string;
  athlete_name: string;
}

/** The bookings that move with this one: those carrying its payment in its
 * session (the same set a refund of that payment covers), or it alone.
 * `lock` locks them in id order, the order a refund of the payment takes
 * them (refunds.ts locks the payment's first booking, then the set), so a
 * move and a refund of one payment wait for each other instead of each
 * holding a row the other needs. */
async function paidTogether(db: DbClient, b: MovingBooking, lock: boolean): Promise<Together[]> {
  const forUpdate = lock ? ' for update' : '';
  if (b.charge_id === null) {
    if (!lock) return [b];
    return (await db.query<Together>(`select id, status, athlete_name from booking where id = $1${forUpdate}`, [b.id])).rows;
  }
  const result = await db.query<Together>(
    `select id, status, athlete_name from booking where charge_id = $1 and session_id = $2 order by id${forUpdate}`,
    [b.charge_id, b.session_id],
  );
  return result.rows.length > 0 || lock ? result.rows : [b];
}

function moveState(b: MovingBooking, together: Together[], now: Date): MoveState {
  if (b.status !== 'booked' || b.session_status !== 'scheduled') return 'not-booked';
  if (now >= cancelCutoff(b.starts_at_utc, b.cancel_window_hours) || now >= new Date(b.starts_at_utc)) return 'too-late';
  if (b.refund_on_way || b.credit_held) return 'refund-pending';
  if (together.some((x) => x.status !== 'booked')) return 'paid-together';
  return 'open';
}

export interface MoveTarget {
  id: number;
  starts_at_utc: string;
  tz: string;
  location_text: string | null;
  /** Spots a booking could take there. */
  room: number;
}

export interface MoveChoice {
  state: MoveState;
  /** The children who move together: this booking's, and any its payment also bought. */
  together: string[];
  /** Upcoming sessions of the same type with room for all of them, soonest first. */
  sessions: MoveTarget[];
}

/** What the manage page offers: where this booking can move, or why it
 * cannot. A session has room when, after its live bookings and holds and
 * the people waiting for a spot in it (other than this parent's own), who
 * have first claim, a spot is left for each child who moves. */
export async function moveChoice(db: DbClient, manageToken: string, now: Date = new Date()): Promise<MoveChoice | null> {
  const b = (await db.query<MovingBooking>(MOVING_SQL, [manageToken])).rows[0];
  if (!b) return null;
  const together = await paidTogether(db, b, false);
  const state = moveState(b, together, now);
  const names = together.map((x) => x.athlete_name);
  if (state !== 'open') return { state, together: names, sessions: [] };
  const sessions = await db.query<MoveTarget>(
    `select s.id, s.starts_at_utc, s.tz, s.location_text,
            (coalesce(s.capacity_override, st.capacity)
             - (select count(*) from booking o where o.session_id = s.id and ${takesSpotSql('o')})
             - (select count(*) from waitlist w
                where w.state = 'waiting' and w.contact_phone <> $3 and w.session_id = coalesce(s.overflow_of, s.id)))::int as room
     from session s
     join session_type st on st.id = s.session_type_id
     where s.session_type_id = $1 and s.id <> $2 and s.status = 'scheduled' and s.starts_at_utc > $4
     order by s.starts_at_utc
     limit 50`,
    [b.session_type_id, b.session_id, b.contact_phone, now.toISOString()],
  );
  return {
    state,
    together: names,
    sessions: sessions.rows.filter((s) => s.room >= together.length),
  };
}

export type MoveResult =
  | { kind: 'moved'; fromSessionId: number; toSessionId: number; bookingIds: number[] }
  /** It is in that session already (a second tap), or moved elsewhere meanwhile. */
  | { kind: 'already' }
  | { kind: 'cannot'; state: Exclude<MoveState, 'open'>; together: string[] }
  /** Not another upcoming, scheduled session of the same type. */
  | { kind: 'no-session' }
  | { kind: 'full' }
  | { kind: 'not-found' };

/** Moves the booking behind this manage link, with any booking its payment
 * also bought, to another session. Both sessions are locked first, as a
 * booking locks its session, and in id order, so two moves between the
 * same sessions cannot wait on each other; then every booking the payment
 * bought, in id order whichever child's link this is, as a refund of that
 * payment locks them, and only then is the booking's state checked. The
 * room is counted and taken under those locks, so two parents moving (or
 * booking) into the last spot cannot both have it. Nothing about the
 * payment changes. The 24-hour reminder is due again, for the new time,
 * and a child now booked in the session leaves its waitlist. */
export async function moveByParent(db: DbClient, manageToken: string, toSessionId: number, now: Date = new Date()): Promise<MoveResult> {
  const found = await db.query<{ session_id: number }>('select session_id from booking where manage_token = $1', [manageToken]);
  const fromSessionId = found.rows[0]?.session_id;
  if (fromSessionId === undefined) return { kind: 'not-found' };
  if (fromSessionId === toSessionId) return { kind: 'already' };
  return inTransaction(db, async (tx): Promise<MoveResult> => {
    const status = new Map<number, string | null>();
    for (const id of [fromSessionId, toSessionId].sort((x, y) => x - y)) status.set(id, await lockSession(tx, id));
    // Read without a row lock: the rows are locked next, in id order.
    const seen = (await tx.query<MovingBooking>(MOVING_SQL, [manageToken])).rows[0];
    if (!seen) return { kind: 'not-found' };
    if (seen.session_id !== fromSessionId) return { kind: 'already' };
    const together = await paidTogether(tx, seen, true);
    // Read again now that its row is locked: a refund or cancel that held
    // the rows first has finished, and what it changed shows here.
    const b = (await tx.query<MovingBooking>(MOVING_SQL, [manageToken])).rows[0];
    if (!b) return { kind: 'not-found' };
    if (b.session_id !== fromSessionId || !together.some((x) => x.id === b.id)) return { kind: 'already' };
    const state = moveState(b, together, now);
    if (state !== 'open') return { kind: 'cannot', state, together: together.map((x) => x.athlete_name) };

    const target = (
      await tx.query<{ session_type_id: number; starts_at_utc: string | Date; capacity: number }>(
        `select s.session_type_id, s.starts_at_utc, coalesce(s.capacity_override, st.capacity) as capacity
         from session s join session_type st on st.id = s.session_type_id
         where s.id = $1`,
        [toSessionId],
      )
    ).rows[0];
    if (
      !target ||
      status.get(toSessionId) !== 'scheduled' ||
      target.session_type_id !== b.session_type_id ||
      new Date(target.starts_at_utc) <= now
    ) {
      return { kind: 'no-session' };
    }
    // The people waiting for a spot there have first claim on it (§7.3).
    const taken = await countTakenSpots(tx, toSessionId);
    const kept = await countKeptForWaitlist(tx, toSessionId, b.contact_phone);
    if (taken + kept + together.length > target.capacity) return { kind: 'full' };

    const ids = together.map((x) => x.id);
    await tx.query("update booking set session_id = $2 where id = any($1::int[]) and status = 'booked'", [ids, toSessionId]);
    await tx.query('insert into booking_move (booking_id, from_session_id, to_session_id) select unnest($1::int[]), $2, $3', [
      ids,
      fromSessionId,
      toSessionId,
    ]);
    await tx.query('delete from reminder_sent where booking_id = any($1::int[])', [ids]);
    await tx.query(
      `update waitlist w set state = 'booked'
       where w.state = 'waiting' and w.contact_phone = $2
         and w.session_id = (select coalesce(s.overflow_of, s.id) from session s where s.id = $1)
         and lower(btrim(w.athlete_name)) in (select lower(btrim(b.athlete_name)) from booking b where b.id = any($3::int[]))`,
      [toSessionId, b.contact_phone, ids],
    );
    return { kind: 'moved', fromSessionId, toSessionId, bookingIds: ids };
  });
}
