import type { DbClient } from '../db/client.js';
import { APP_BASE_URL } from '../config.js';
import { escapeHtml } from '../lib/html.js';
import { formatConfirmWhen } from '../lib/time.js';
import { PLACEHOLDER_EMAIL_DOMAIN } from '../relay/buy-link.js';
import { normalizeEmail } from './auth.js';
import { OPT_OUT_LINE, canText, sendEmailMessage, sendText, toOneSegment, type SendOutcome } from './outbound.js';
import { hasActiveConsent } from './sms-consent.js';

/** What a parent is told about their own booking: that it is booked, or
 * that a payment for a cancelled session became credit. Texts go only to a
 * phone with SMS consent, and email only to an address the parent typed.
 * A failed send is logged and never undoes the booking. */

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

/** Plain letters only, so a name with an accent keeps the text in GSM-7. */
function plain(text: string): string {
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
    `select b.athlete_name, b.contact_phone, b.contact_email, b.manage_token, s.starts_at_utc, s.tz, s.location_text,
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

async function textParent(db: DbClient, d: BookingDetails, body: string, template: string): Promise<MessageOutcome> {
  if (!canText(d.contact_phone) || !(await hasActiveConsent(db, d.contact_phone))) return 'skipped';
  try {
    return await sendText(db, { to: d.contact_phone, body, coachId: d.coach_id, template });
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
): Promise<MessageOutcome> {
  const to = deliverableEmail(d.contact_email);
  if (!to) return 'skipped';
  try {
    return await sendEmailMessage(db, { to, ...message, coachId: d.coach_id, template });
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

/** Sent when a booking becomes booked, by any way of paying: what, when,
 * where, and the manage link. */
export async function sendBookingConfirmation(db: DbClient, bookingId: number): Promise<ParentMessageResult> {
  const d = await loadDetails(db, bookingId);
  if (!d) return { text: 'skipped', email: 'skipped' };
  const { when, place, athlete } = describe(d);
  const link = manageUrl(d.manage_token);
  const text = await textParent(
    db,
    d,
    textWithLink(`Coachatron: ${athlete} is booked: ${d.session_name} ${shortWhen(when)}${place}.`, link),
    'booking-confirmation',
  );
  const line = `${d.athlete_name} is booked for ${d.session_name} with ${d.coach_name}: ${when}${place}.`;
  const email = await emailParent(
    db,
    d,
    {
      subject: `Booked: ${d.session_name}, ${when}`,
      text: `${line}\n\nSee or cancel this booking: ${link}\n\nCoachatron`,
      html: emailHtml([line, 'See or cancel this booking here:'], link, 'Manage this booking'),
    },
    'booking-confirmation',
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
