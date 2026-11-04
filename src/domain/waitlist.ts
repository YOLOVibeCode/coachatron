import { inTransaction, type DbClient } from '../db/client.js';
import { APP_BASE_URL, BOOKING_HOLD_MINUTES } from '../config.js';
import { formatConfirmWhen } from '../lib/time.js';
import { escapeHtml } from '../lib/html.js';
import { lockSession, newBookingToken, takesSpotSql } from './pricing.js';
import { canText, sendEmailMessage, sendText } from './outbound.js';
import { hasActiveConsent } from './sms-consent.js';
import { deliverableEmail, plain, textWithLink } from './bookingMessages.js';
import { inQuietHours, nextQuietHoursEnd } from './scheduling.js';
import { RelayHttpError } from '../relay/http.js';

/** The waitlist (SPEC.md §7.3 step 5). A spot that opens in a session (a
 * backup coach's spots, a second group, a parent's cancel, a hold that ran
 * out) goes to the people waiting, in the order they joined: each is sent a
 * link, by text when they chose texts and by email otherwise, that holds
 * the spot for BOOKING_HOLD_MINUTES. A spot nobody claims in that time goes
 * to the next person. A second group draws from the waitlist of the session
 * it was opened for. Nobody is charged until they book. */

/** Waitlist entries a session's open spots are offered to: its own, or for
 * a second group, the full session's. */
function poolSql(s: string): string {
  return `coalesce(${s}.overflow_of, ${s}.id)`;
}

/** Quiet hours (SPEC.md §10) hold spot offers until 8am in the coach's
 * zone, so a parent asleep does not lose their turn. A session that starts
 * before then is offered now, or never. */
function waitsForMorning(now: Date, coachTz: string, startsAtUtc: string): boolean {
  return inQuietHours(now, coachTz) && new Date(startsAtUtc).getTime() > nextQuietHoursEnd(now, coachTz).getTime();
}

interface HeldSpot {
  waitlistId: number;
  bookingId: number;
  checkoutToken: string;
  athleteName: string;
  contactPhone: string;
  contactEmail: string | null;
  textable: boolean;
}

/** Holds each free spot in the session for the next person waiting who can
 * be told, in the order they joined. Run inside a transaction that holds
 * the session's lock (or that created the session), so nothing else counts
 * or takes its spots meanwhile. Someone with neither texts nor an email
 * cannot be told and is passed over. Someone whose last offer did not go
 * out is still first in line: until their retry time nobody behind them is
 * offered a spot. */
export async function holdSpotsForWaitlist(tx: DbClient, sessionId: number): Promise<HeldSpot[]> {
  const sessions = await tx.query<{ status: string; starts_at_utc: string | Date; pool: number; capacity: number }>(
    `select s.status, s.starts_at_utc, ${poolSql('s')} as pool, coalesce(s.capacity_override, st.capacity) as capacity
     from session s join session_type st on st.id = s.session_type_id
     where s.id = $1`,
    [sessionId],
  );
  const session = sessions.rows[0];
  if (!session || session.status !== 'scheduled' || new Date(session.starts_at_utc) <= new Date()) return [];
  const taken = await tx.query<{ n: string }>(`select count(*)::text as n from booking b where b.session_id = $1 and ${takesSpotSql('b')}`, [
    sessionId,
  ]);
  let free = session.capacity - Number(taken.rows[0]?.n ?? '0');
  if (free <= 0) return [];

  const waiting = await tx.query<{
    id: number;
    athlete_name: string;
    contact_phone: string;
    contact_email: string | null;
    resting: boolean;
  }>(
    `select id, athlete_name, contact_phone, contact_email, coalesce(retry_at > now(), false) as resting from waitlist
     where session_id = $1 and state = 'waiting'
     order by created_at asc, id asc
     for update skip locked`,
    [session.pool],
  );
  const held: HeldSpot[] = [];
  for (const w of waiting.rows) {
    if (free <= 0 || w.resting) break;
    const textable = canText(w.contact_phone) && (await hasActiveConsent(tx, w.contact_phone));
    if (!textable && !deliverableEmail(w.contact_email)) {
      await tx.query("update waitlist set state = 'unreachable' where id = $1", [w.id]);
      continue;
    }
    const checkoutToken = newBookingToken();
    const booking = await tx.query<{ id: number }>(
      `insert into booking (session_id, athlete_name, contact_phone, contact_email, manage_token, checkout_token, hold_expires_at, status)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int), 'pending')
       returning id`,
      [sessionId, w.athlete_name, w.contact_phone, w.contact_email, newBookingToken(), checkoutToken, BOOKING_HOLD_MINUTES],
    );
    await tx.query("update waitlist set state = 'offered', offer_booking_id = $2, offered_at = now() where id = $1", [
      w.id,
      booking.rows[0].id,
    ]);
    held.push({
      waitlistId: w.id,
      bookingId: booking.rows[0].id,
      checkoutToken,
      athleteName: w.athlete_name,
      contactPhone: w.contact_phone,
      contactEmail: w.contact_email,
      textable,
    });
    free -= 1;
  }
  return held;
}

interface SpotContext {
  coachId: number;
  coachName: string;
  coachTz: string;
  handle: string;
  sessionName: string;
  startsAtUtc: string;
  tz: string;
  locationText: string | null;
}

async function loadSpotContext(db: DbClient, sessionId: number): Promise<SpotContext | null> {
  const result = await db.query<{
    coach_id: number;
    coach_name: string;
    coach_tz: string;
    handle: string;
    name: string;
    starts_at_utc: string | Date;
    tz: string;
    location_text: string | null;
  }>(
    `select c.id as coach_id, c.name as coach_name, c.tz as coach_tz, c.handle, st.name, s.starts_at_utc, s.tz, s.location_text
     from session s join session_type st on st.id = s.session_type_id join coach c on c.id = st.coach_id
     where s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    coachId: row.coach_id,
    coachName: row.coach_name,
    coachTz: row.coach_tz,
    handle: row.handle,
    sessionName: row.name,
    startsAtUtc: new Date(row.starts_at_utc).toISOString(),
    tz: row.tz,
    locationText: row.location_text,
  };
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? APP_BASE_URL).replace(/\/$/, '');
}

/** sent: they were told. later: nothing went out just now (the relay was
 * busy or down, or a sending limit was reached), so they keep their place
 * and are tried again. unreachable: their number takes no texts (an
 * opt-out, or no consent) and there is no email that works. */
type TellOutcome = 'sent' | 'later' | 'unreachable';

/** A send the relay refused for this address will not go later either: an
 * HTTP 400, 404 or 422 answer. Anything else (a 5xx, no answer, a key the
 * relay did not take) is the relay's, and may. */
function refusedAddress(err: unknown): boolean {
  return err instanceof RelayHttpError && [400, 404, 422].includes(err.status);
}

/** Tells one person their spot is held: a text when they chose texts, an
 * email otherwise (or when the text could not go). */
async function tellWaitingParent(db: DbClient, ctx: SpotContext, spot: HeldSpot): Promise<TellOutcome> {
  const link = `${appBaseUrl()}/c/${ctx.handle}/checkout/${spot.checkoutToken}`;
  const when = formatConfirmWhen(ctx.startsAtUtc, ctx.tz);
  const athlete = plain(spot.athleteName) || 'your athlete';
  let later = false;
  if (spot.textable) {
    try {
      const outcome = await sendText(db, {
        to: spot.contactPhone,
        // What matters first: a spot, how long it is held, for whom. The
        // session and time are on the page the link opens.
        body: textWithLink(
          `Coachatron: a spot opened, held ${BOOKING_HOLD_MINUTES} min for ${athlete}: ${ctx.sessionName} ${when.replace(',', '').replace(':00', '')}`,
          link,
        ),
        coachId: ctx.coachId,
        template: 'waitlist-spot',
        // Joining the waitlist is a form anyone can fill in.
        visitor: 'new-number',
      });
      if (outcome === 'sent') return 'sent';
      // 'refused' means this number takes no texts now; 'busy' and
      // 'capped' mean not yet.
      if (outcome !== 'refused') later = true;
    } catch (err) {
      if (!refusedAddress(err)) later = true;
      console.error('waitlist: spot text failed:', err instanceof Error ? err.message : err);
    }
  }
  const email = deliverableEmail(spot.contactEmail);
  if (!email) return later ? 'later' : 'unreachable';
  const place = ctx.locationText ? `, ${ctx.locationText}` : '';
  const line = `A spot opened for ${spot.athleteName} in ${ctx.sessionName} with ${ctx.coachName}: ${when}${place}. We're holding it for ${BOOKING_HOLD_MINUTES} minutes. After that it goes to the next person waiting.`;
  try {
    const outcome = await sendEmailMessage(db, {
      to: email,
      subject: `A spot opened: ${ctx.sessionName}, ${when}`,
      text: `${line}\n\nBook it here: ${link}\n\nCoachatron`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:16px">${escapeHtml(line)}</p>
<p style="font-family:system-ui,sans-serif;font-size:16px"><a href="${escapeHtml(link)}">Book the spot</a></p>`,
      coachId: ctx.coachId,
      template: 'waitlist-spot',
    });
    return outcome === 'sent' ? 'sent' : 'later';
  } catch (err) {
    console.error('waitlist: spot email failed:', err instanceof Error ? err.message : err);
    return later || !refusedAddress(err) ? 'later' : 'unreachable';
  }
}

export interface SentSpots {
  /** The parents told, by phone: one each, however many children they put on the waitlist. */
  told: Set<string>;
  /** Spots let go because their person cannot be reached; the next one in line can have them. */
  passedOver: number;
  /** Spots let go because nothing went out just now; their person keeps their place. */
  later: number;
}

/** Sends the held spots' links. A spot whose person could not be told is
 * let go at once. Someone who cannot be reached is passed over; someone
 * whose text or email did not go out just now goes back to waiting, first
 * in line, and is tried again from their retry time. */
export async function sendHeldSpots(db: DbClient, sessionId: number, spots: HeldSpot[]): Promise<SentSpots> {
  const sent: SentSpots = { told: new Set(), passedOver: 0, later: 0 };
  if (spots.length === 0) return sent;
  const ctx = await loadSpotContext(db, sessionId);
  for (const spot of spots) {
    const outcome: TellOutcome = ctx ? await tellWaitingParent(db, ctx, spot) : 'later';
    if (outcome === 'sent') {
      sent.told.add(spot.contactPhone);
      continue;
    }
    await db.query("update booking set hold_expires_at = now() where id = $1 and status = 'pending'", [spot.bookingId]);
    if (outcome === 'unreachable') {
      await db.query("update waitlist set state = 'unreachable' where id = $1 and state = 'offered'", [spot.waitlistId]);
      sent.passedOver += 1;
      continue;
    }
    // Tried again in 5 minutes, then 10, 20, 40, and then every hour.
    await db.query(
      `update waitlist set state = 'waiting', offer_booking_id = null, offered_at = null, send_tries = send_tries + 1,
              retry_at = now() + make_interval(mins => least(60, 5 * power(2, least(send_tries, 4))::int))
       where id = $1 and state = 'offered'`,
      [spot.waitlistId],
    );
    sent.later += 1;
  }
  return sent;
}

export interface SpotOffers {
  /** Parents told a spot is held for them: one each, however many children. */
  offered: number;
  /** True when quiet hours hold the offers until morning. */
  waitingForMorning: boolean;
}

/** Offers a session's open spots to the people waiting, now or, in quiet
 * hours, from 8am. A spot whose person cannot be reached goes on to the
 * next one; one whose text or email did not go out just now stays theirs
 * to be offered again, and the rest of the line waits. Parents already
 * told (by phone) can be passed in `told`, so each is counted once. */
export async function offerOpenSpots(
  db: DbClient,
  sessionId: number,
  now: Date = new Date(),
  told: Set<string> = new Set(),
): Promise<SpotOffers> {
  const ctx = await loadSpotContext(db, sessionId);
  if (!ctx) return { offered: told.size, waitingForMorning: false };
  if (waitsForMorning(now, ctx.coachTz, ctx.startsAtUtc)) return { offered: told.size, waitingForMorning: true };
  for (let round = 0; round < 50; round += 1) {
    const spots = await inTransaction(db, async (tx) => {
      if ((await lockSession(tx, sessionId)) !== 'scheduled') return [];
      return holdSpotsForWaitlist(tx, sessionId);
    });
    if (spots.length === 0) break;
    const sent = await sendHeldSpots(db, sessionId, spots);
    for (const phone of sent.told) told.add(phone);
    if (sent.later > 0 || sent.passedOver === 0) break;
  }
  return { offered: told.size, waitingForMorning: false };
}

/** Whether spots opened now in this session wait for the morning. */
export async function spotOffersWaitForMorning(db: DbClient, sessionId: number, now: Date = new Date()): Promise<boolean> {
  const ctx = await loadSpotContext(db, sessionId);
  return ctx ? waitsForMorning(now, ctx.coachTz, ctx.startsAtUtc) : false;
}

/** The tick's step. Offers that were booked or ran out are settled, then
 * every open session with free spots and people waiting offers them on. */
export async function moveWaitlists(db: DbClient, now: Date): Promise<number> {
  await db.query(
    `update waitlist w set state = 'booked'
     from booking b
     where b.id = w.offer_booking_id and w.state = 'offered' and b.status in ('booked', 'attended', 'noshow')`,
  );
  await db.query(
    `update waitlist w set state = 'lapsed'
     from booking b
     where b.id = w.offer_booking_id and w.state = 'offered'
       and (b.status in ('cancelled', 'refunded') or (b.status = 'pending' and (b.hold_expires_at is null or b.hold_expires_at <= now())))`,
  );
  const sessions = await db.query<{ id: number }>(
    `select s.id
     from session s join session_type st on st.id = s.session_type_id
     where s.status = 'scheduled' and s.starts_at_utc > now()
       and exists (select 1 from waitlist w where w.session_id = ${poolSql('s')} and w.state = 'waiting')
       and (select count(*) from booking b where b.session_id = s.id and ${takesSpotSql('b')}) < coalesce(s.capacity_override, st.capacity)
     order by s.starts_at_utc
     limit 50`,
  );
  let offered = 0;
  for (const row of sessions.rows) {
    offered += (await offerOpenSpots(db, row.id, now)).offered;
  }
  return offered;
}
