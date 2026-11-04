import type { DbClient } from '../db/client.js';
import { APP_BASE_URL, MOVED_CONFIRMATIONS_DAILY_MAX_PER_CONTACT } from '../config.js';
import { escapeHtml } from '../lib/html.js';
import { formatCoachDollars, formatConfirmWhen } from '../lib/time.js';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../relay/buy-link.js';
import { normalizeEmail } from './auth.js';
import { OPT_OUT_LINE, canText, sendEmailMessage, sendText, toOneSegment, type OutboundText, type SendOutcome } from './outbound.js';
import { hasActiveConsent } from './sms-consent.js';

/** What a parent is told about their own booking: that it is booked or
 * moved, that a payment for a cancelled session became credit, or that a
 * payment was refunded. Texts go only to a phone with SMS consent, and email
 * only to an address the parent typed. A failed send is logged and never
 * undoes the booking. */

export type MessageOutcome = SendOutcome | 'skipped' | 'failed';

export interface ParentMessageResult {
  text: MessageOutcome;
  email: MessageOutcome;
}

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? APP_BASE_URL).replace(/\/$/, '');
}

/** The parent's manage page (screen 11). */
export function manageUrl(token: string): string {
  return `${appBaseUrl()}/booking/${token}`;
}

/** An address the parent typed, never the stand-in a payment link uses for
 * a parent who gave none. */
export function deliverableEmail(email: string | null): string | null {
  const normalized = email ? normalizeEmail(email) : null;
  if (!normalized || normalized.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)) return null;
  return normalized;
}

/** "Mia", "Mia and Leo", "Mia, Leo and Sam". */
export function namesList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Plain letters only, so a name with an accent keeps the text in GSM-7. */
export function plain(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One segment that always ends with the whole link: the words before it
 * are shortened instead, leaving room for the opt-out line the send path
 * adds. */
export function textWithLink(words: string, link: string): string {
  const tail = ` ${link}`;
  return `${toOneSegment(plain(words), tail.length + OPT_OUT_LINE.length + 1)}${tail}`;
}

/** "Wed Nov 4 6pm" or "Wed Nov 4 6:30pm": the compact form a text has room for. */
function shortWhen(when: string): string {
  return when.replace(',', '').replace(':00', '');
}

interface BookingDetails {
  /** Set when the booking was paid for: a payment ref. */
  charge_id: string | null;
  athlete_name: string;
  contact_phone: string;
  contact_email: string | null;
  manage_token: string;
  starts_at_utc: string;
  tz: string;
  location_text: string | null;
  session_name: string;
  coach_id: number;
  coach_name: string;
}

async function loadDetails(db: DbClient, bookingId: number): Promise<BookingDetails | null> {
  const result = await db.query<BookingDetails>(
    `select b.charge_id, b.athlete_name, b.contact_phone, b.contact_email, b.manage_token, s.starts_at_utc, s.tz, s.location_text,
            st.name as session_name, c.id as coach_id, c.name as coach_name
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where b.id = $1`,
    [bookingId],
  );
  return result.rows[0] ?? null;
}

function describe(d: BookingDetails): { when: string; place: string; athlete: string } {
  return {
    when: formatConfirmWhen(new Date(d.starts_at_utc).toISOString(), d.tz),
    place: d.location_text ? `, ${d.location_text}` : '',
    athlete: plain(d.athlete_name) || 'Your athlete',
  };
}

async function textParent(
  db: DbClient,
  d: BookingDetails,
  body: string,
  template: string,
  visitor?: OutboundText['visitor'],
  perRecipientDailyMax?: number,
): Promise<MessageOutcome> {
  if (!canText(d.contact_phone) || !(await hasActiveConsent(db, d.contact_phone))) return 'skipped';
  try {
    return await sendText(db, {
      to: d.contact_phone,
      body,
      coachId: d.coach_id,
      template,
      ...(visitor ? { visitor } : {}),
      ...(perRecipientDailyMax === undefined ? {} : { perRecipientDailyMax }),
    });
  } catch (err) {
    console.error(`booking-message: ${template} text failed:`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

async function emailParent(
  db: DbClient,
  d: BookingDetails,
  message: { subject: string; text: string; html: string },
  template: string,
  perRecipientDailyMax?: number,
): Promise<MessageOutcome> {
  const to = deliverableEmail(d.contact_email);
  if (!to) return 'skipped';
  try {
    return await sendEmailMessage(db, {
      to,
      ...message,
      coachId: d.coach_id,
      template,
      ...(perRecipientDailyMax === undefined ? {} : { perRecipientDailyMax }),
    });
  } catch (err) {
    console.error(`booking-message: ${template} email failed:`, err instanceof Error ? err.message : err);
    return 'failed';
  }
}

function emailHtml(paragraphs: string[], link: string, linkLabel: string): string {
  const p = (text: string) => `<p style="font-family:system-ui,sans-serif;font-size:16px">${escapeHtml(text)}</p>`;
  return `${paragraphs.map(p).join('\n')}
<p style="font-family:system-ui,sans-serif;font-size:16px"><a href="${escapeHtml(link)}">${escapeHtml(linkLabel)}</a></p>`;
}

/** Sent when a booking becomes booked, by any way of paying, or when the
 * parent moves it to another session (`movedFrom`, the time it left): what,
 * when, where, and the manage link. A booking nobody paid for (a free
 * session) was set off by a form anyone can fill in, so its text to a
 * number never texted before counts against the app-wide visitor ceiling. */
export async function sendBookingConfirmation(
  db: DbClient,
  bookingId: number,
  opts: { movedFrom?: string | Date } = {},
): Promise<ParentMessageResult> {
  const d = await loadDetails(db, bookingId);
  if (!d) return { text: 'skipped', email: 'skipped' };
  const { when, place, athlete } = describe(d);
  const link = manageUrl(d.manage_token);
  const moved = opts.movedFrom === undefined ? null : formatConfirmWhen(new Date(opts.movedFrom).toISOString(), d.tz);
  const template = moved ? 'booking-moved' : 'booking-confirmation';
  // Moving back and forth is capped per number and address, so it never
  // uses up the coach's daily text ceiling that every family shares.
  const cap = moved ? MOVED_CONFIRMATIONS_DAILY_MAX_PER_CONTACT : undefined;
  const text = await textParent(
    db,
    d,
    textWithLink(`Coachatron: ${athlete} ${moved ? 'moved to' : 'is booked:'} ${d.session_name} ${shortWhen(when)}${place}.`, link),
    template,
    d.charge_id ? undefined : 'new-number',
    cap,
  );
  const line = moved
    ? `${d.athlete_name}'s ${d.session_name} with ${d.coach_name} moved from ${moved} to ${when}${place}.`
    : `${d.athlete_name} is booked for ${d.session_name} with ${d.coach_name}: ${when}${place}.`;
  const email = await emailParent(
    db,
    d,
    {
      subject: `${moved ? 'Moved' : 'Booked'}: ${d.session_name}, ${when}`,
      text: `${line}\n\nSee, move or cancel this booking: ${link}\n\nCoachatron`,
      html: emailHtml([line, 'See, move or cancel this booking here:'], link, 'Manage this booking'),
    },
    template,
    cap,
  );
  return { text, email };
}

/** Sent when the coach cancels a session, to a parent the cancel's text did
 * not reach (they chose no texts, opted out, or the text did not go out)
 * who gave an email: what was cancelled and, when there is one, the session
 * credit they now hold. 'skipped' when there is no address to send to. */
export async function sendSessionCancelledEmail(
  db: DbClient,
  bookingId: number,
  credit: 'drop-in' | 'credit-back' | null,
): Promise<MessageOutcome> {
  const d = await loadDetails(db, bookingId);
  if (!d) return 'skipped';
  const { when } = describe(d);
  const lines = [`${d.coach_name} cancelled ${d.athlete_name}'s ${d.session_name} on ${when}.`];
  if (credit === 'drop-in') lines.push(`Your payment is now 1 session credit with ${d.coach_name}, for another session.`);
  if (credit === 'credit-back') lines.push(`Your session credit with ${d.coach_name} is back, for another session.`);
  const link = manageUrl(d.manage_token);
  return emailParent(
    db,
    d,
    {
      subject: `Cancelled: ${d.session_name}, ${when}`,
      text: `${lines.join(' ')}\n\nYour booking: ${link}\n\nCoachatron`,
      html: emailHtml(lines, link, 'See your booking'),
    },
    'session-cancelled',
  );
}

function refundAmount(cents: number | null): string {
  return cents === null ? 'your payment' : formatCoachDollars(cents);
}

/** Sent once when a payment is refunded: how much went back to the card,
 * what it was for, and what the refund ended (the booking it paid for, or
 * the session credits it bought). A booking for a session still to come is
 * cancelled; one for a session that already happened is marked refunded.
 * A payment for several children (one booking pass) names each of them. */
export async function sendRefundNotice(
  db: DbClient,
  bookingId: number,
  refund: {
    amountCents: number | null;
    bookingEnded: boolean;
    bookingReleased: boolean;
    creditsRemoved: number;
    /** Every child the payment was for, when it was for more than one. */
    athleteNames?: string[];
    /** How many bookings the refund ended; one unless the payment was for several children. */
    bookingsEnded?: number;
  },
): Promise<ParentMessageResult> {
  const d = await loadDetails(db, bookingId);
  if (!d) return { text: 'skipped', email: 'skipped' };
  const names = refund.athleteNames && refund.athleteNames.length > 0 ? namesList(refund.athleteNames) : d.athlete_name;
  const { when } = describe(d);
  const athlete = plain(names) || 'Your athlete';
  const day = when.split(',')[0];
  const link = manageUrl(d.manage_token);
  const amount = refundAmount(refund.amountCents);
  const text = await textParent(
    db,
    d,
    textWithLink(`Coachatron: ${d.coach_name} refunded ${amount} for ${athlete}'s ${d.session_name} ${day}.`, link),
    'refund-notice',
  );
  const lines = [`${d.coach_name} refunded ${amount} to the card you paid with, for ${names}'s ${d.session_name} on ${when}.`];
  const several = (refund.bookingsEnded ?? 1) > 1;
  if (refund.bookingReleased) lines.push(several ? 'Those bookings are cancelled.' : 'That booking is cancelled.');
  else if (refund.bookingEnded) lines.push(several ? 'Those bookings are marked refunded.' : 'That booking is marked refunded.');
  if (refund.creditsRemoved > 0) {
    lines.push(
      `The ${refund.creditsRemoved} unused session ${refund.creditsRemoved === 1 ? 'credit' : 'credits'} from this payment ${refund.creditsRemoved === 1 ? 'was' : 'were'} removed.`,
    );
  }
  lines.push('Your bank may take a few days to show the refund.');
  const email = await emailParent(
    db,
    d,
    {
      subject: `Refund from ${d.coach_name}: ${amount}`,
      text: `${lines.join(' ')}\n\nYour booking: ${link}\n\nCoachatron`,
      html: emailHtml(lines, link, 'See your booking'),
    },
    'refund-notice',
  );
  return { text, email };
}

/** Sent when a payment arrives for a session the coach has cancelled: the
 * payment is now credit with that coach. */
export async function sendPaymentCredited(db: DbClient, bookingId: number, credits: number): Promise<ParentMessageResult> {
  const d = await loadDetails(db, bookingId);
  if (!d) return { text: 'skipped', email: 'skipped' };
  const { when } = describe(d);
  const day = when.split(',')[0];
  const link = manageUrl(d.manage_token);
  const amount = `${credits} session ${credits === 1 ? 'credit' : 'credits'}`;
  const text = await textParent(
    db,
    d,
    textWithLink(`Coachatron: your payment is now ${amount} with ${d.coach_name}. ${d.session_name} ${day} was cancelled.`, link),
    'payment-credited',
  );
  const line = `${d.session_name} on ${when} was cancelled by ${d.coach_name} before your payment came through, so it is now ${amount} with ${d.coach_name} for another session.`;
  const email = await emailParent(
    db,
    d,
    {
      subject: `Your payment is now ${amount} with ${d.coach_name}`,
      text: `${line}\n\nYour booking: ${link}\n\nCoachatron`,
      html: emailHtml([line], link, 'See your booking'),
    },
    'payment-credited',
  );
  return { text, email };
}
