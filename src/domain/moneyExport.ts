import type { DbClient } from '../db/client.js';
import { csvDollars, csvFile, isoInZone } from '../lib/csv.js';
import { namesList } from './bookingMessages.js';
import { purchaseKind } from './refunds.js';
import type { LimitRule } from './requestLimits.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from './scheduling.js';

/**
 * The two downloads on Money, for a coach's bookkeeping and taxes: the
 * payments that reached their account, and their bookings. Both are read
 * for a range of days in the coach's timezone, and every time in a file is
 * the coach's local time with its offset.
 *
 * Payments are listed by the day they were paid; bookings by the day their
 * session starts. A payment is one row however many children it paid for,
 * and it is there whether or not it booked: a payment kept for the coach to
 * resolve reached their account too. Coachatron's fee is not in the file:
 * the app keeps no record of the fee taken from each payment, and a figure
 * worked out from a rate would not be one.
 */

// ---- The range ----

const DAY_MS = 24 * 60 * 60 * 1000;

/** A custom range covers at most this many days: a whole leap year. */
export const MAX_CUSTOM_DAYS = 366;

/** A file holds at most this many rows. A range with more is refused, never
 * cut short. */
export const MAX_EXPORT_ROWS = 50_000;

/** Downloads by one coach, both files together. */
export const DOWNLOAD_LIMITS: LimitRule[] = [{ bucket: 'money-download-coach-hour', windowMs: 60 * 60 * 1000, max: 20 }];

/** The counter key for one coach's downloads. */
export function downloadLimitKey(coachId: number): string {
  return `coach:${coachId}`;
}

export const RANGE_PRESETS = ['this-month', 'last-month', 'this-year', 'last-year'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const CUSTOM_RANGE = 'custom';

export interface ExportRange {
  /** The first instant in the range: midnight in the coach's timezone. */
  from: Date;
  /** The first instant after it: midnight after its last day. */
  until: Date;
  /** For the file's name: "2026-11", "2026", "2026-11-01-to-2026-11-15". */
  label: string;
  /** For the screen: "November 2026", "2026". */
  words: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const two = (n: number) => String(n).padStart(2, '0');

/** A day's first moment in the zone. Where midnight happens twice (the
 * clocks go back at midnight, as in Havana), the day begins at the first. */
const midnight = (year: number, month: number, day: number, tz: string): Date => zonedTimeToUtc(year, month, day, 0, 0, tz, 'earlier');

function monthRange(year: number, month: number, tz: string): ExportRange {
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    from: midnight(year, month, 1, tz),
    until: midnight(next.year, next.month, 1, tz),
    label: `${year}-${two(month)}`,
    words: `${MONTHS[month - 1]} ${year}`,
  };
}

function yearRange(year: number, tz: string): ExportRange {
  return {
    from: midnight(year, 1, 1, tz),
    until: midnight(year + 1, 1, 1, tz),
    label: String(year),
    words: String(year),
  };
}

/** This month, last month, this year or last year, as the calendar reads in
 * the coach's timezone at `now`. Each edge is that zone's own midnight on
 * that day, so a month with a clock change in it is still whole. */
export function presetRange(preset: RangePreset, tz: string, now: Date): ExportRange {
  const today = zonedParts(now, tz);
  switch (preset) {
    case 'this-month':
      return monthRange(today.year, today.month, tz);
    case 'last-month':
      return today.month === 1 ? monthRange(today.year - 1, 12, tz) : monthRange(today.year, today.month - 1, tz);
    case 'this-year':
      return yearRange(today.year, tz);
    case 'last-year':
      return yearRange(today.year - 1, tz);
  }
}

interface Day {
  year: number;
  month: number;
  day: number;
}

/** "2026-11-15" → that day, when it is a real date in a year the product
 * could hold records for; anything else → null. */
function parseDay(raw: unknown): Day | null {
  const match = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return null;
  const real = new Date(Date.UTC(year, month - 1, day));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  return { year, month, day };
}

const dayNumber = (d: Day) => Date.UTC(d.year, d.month - 1, d.day) / DAY_MS;
const dayText = (d: Day) => `${d.year}-${two(d.month)}-${two(d.day)}`;

/** From one day to another, both included, read in the coach's timezone:
 * at most MAX_CUSTOM_DAYS days, the first no later than the last. */
export function customRange(fromRaw: unknown, toRaw: unknown, tz: string): ExportRange | null {
  const first = parseDay(fromRaw);
  const last = parseDay(toRaw);
  if (!first || !last) return null;
  const days = dayNumber(last) - dayNumber(first) + 1;
  if (days < 1 || days > MAX_CUSTOM_DAYS) return null;
  const after = addCalendarDays(last.year, last.month, last.day, 1);
  return {
    from: midnight(first.year, first.month, first.day, tz),
    until: midnight(after.year, after.month, after.day, tz),
    label: `${dayText(first)}-to-${dayText(last)}`,
    words: `${dayText(first)} to ${dayText(last)}`,
  };
}

const isGiven = (v: unknown): boolean => v !== undefined && v !== '';

/** The range a download's query string names, or null when it names none
 * that the product takes. Dates given with a named range are refused, not ignored. */
export function resolveRange(query: { range?: unknown; from?: unknown; to?: unknown }, tz: string, now: Date): ExportRange | null {
  const { range } = query;
  if (range === CUSTOM_RANGE) return customRange(query.from, query.to, tz);
  // Dates typed beside a named range would be ignored: refuse instead.
  if (isGiven(query.from) && isGiven(query.to)) return null;
  const preset = RANGE_PRESETS.find((p) => p === range);
  return preset ? presetRange(preset, tz, now) : null;
}

// ---- The files ----

export type ExportFile = { ok: true; csv: string; rows: number } | { ok: false; reason: 'too_many_rows' };

type Instant = string | Date;

function file(header: readonly string[], rows: string[][], maxRows: number): ExportFile {
  if (rows.length > maxRows) return { ok: false, reason: 'too_many_rows' };
  return { ok: true, csv: csvFile(header, rows), rows: rows.length };
}

const cents = (value: string | number | null): number | null => (value === null ? null : Number(value));

// ---- Payments ----

export const PAYMENTS_HEADER = [
  'Paid at',
  'Parent phone',
  'Parent email',
  'Athletes',
  'Bought',
  'Session',
  'Session start',
  'Amount',
  'Refunded amount',
  'Refunded at',
  'Status',
  'Payment reference',
] as const;

interface PaymentRow {
  payment_ref: string | null;
  paid_at: Instant;
  contact_phone: string | null;
  contact_email: string | null;
  names: string[] | null;
  amount_cents: string | null;
  /** Null for a payment that did not book and is kept for the coach. */
  payment_source: string | null;
  /** The package's or pack's name, when it bought one. */
  item_name: string | null;
  /** The payment booked the session it was made for. */
  booked: boolean;
  session_name: string | null;
  starts_at_utc: Instant | null;
  refund_status: string | null;
  refund_error: string | null;
  refunded_cents: number | null;
  refunded_at: Instant | null;
  refund_reported_at: Instant | null;
  dispute_state: string | null;
}

const REFUND_AND_DISPUTE_COLUMNS = `r.status as refund_status, r.error_code as refund_error, r.amount_cents as refunded_cents, r.refunded_at,
  r.requested_at as refund_reported_at, d.state as dispute_state`;

/** Joins a payment's refund row and its latest dispute. `ref` is the SQL
 * for the payment ref, and $1 the coach. */
function refundAndDisputeJoins(ref: string): string {
  return `left join refund r on r.payment_ref = ${ref}
  left join lateral (
    select pd.state from payment_dispute pd
    where pd.coach_id = $1 and pd.payment_ref = ${ref}
    order by pd.opened_at desc, pd.id desc limit 1
  ) d on true`;
}

/** The coach's bookings, with their sessions: `b`, `s` and `st`, for $1. */
const COACH_BOOKINGS = `booking b
  join session s on s.id = b.session_id
  join session_type st on st.id = s.session_type_id and st.coach_id = $1`;

/** Payments that are on a booking: one row per payment, on the first
 * booking that carries an amount, with the whole amount and every child it
 * paid for. Only bookings of the coach's own sessions are read. A payment
 * whose session was cancelled while the parent paid is on its (cancelled)
 * booking too, and booked nothing. */
async function bookedPayments(db: DbClient, coachId: number, range: ExportRange, limit: number): Promise<PaymentRow[]> {
  const result = await db.query<PaymentRow>(
    `with paid as (
       select b.charge_id as payment_ref,
              min(b.id) filter (where b.gross_cents > 0) as first_id,
              sum(b.gross_cents)::text as amount_cents,
              array_agg(b.athlete_name order by b.id) as names
       from ${COACH_BOOKINGS}
       where b.charge_id is not null
       group by b.charge_id
     )
     select p.payment_ref, coalesce(pr.paid_at, b.created_at) as paid_at, b.contact_phone, b.contact_email, p.names, p.amount_cents,
            coalesce(b.payment_source, 'DropIn') as payment_source, coalesce(pk.name, pl.name) as item_name,
            not exists (
              select 1 from payment_attention pa
              where pa.coach_id = $1 and pa.payment_ref = p.payment_ref and pa.reason = 'session_cancelled'
            ) as booked,
            st.name as session_name, s.starts_at_utc, ${REFUND_AND_DISPUTE_COLUMNS}
     from paid p
     join booking b on b.id = p.first_id
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     left join payment_receipt pr on pr.payment_ref = p.payment_ref
     left join credit c on c.id = b.credit_id and b.payment_source is distinct from 'DropIn'
     left join package pk on pk.id = c.package_id
     left join plan pl on pl.id = case when c.source ~ '^plan:[0-9]{1,9}$' then substring(c.source from 6)::int end
     ${refundAndDisputeJoins('p.payment_ref')}
     where coalesce(pr.paid_at, b.created_at) >= $2 and coalesce(pr.paid_at, b.created_at) < $3
     order by 2, 1
     limit $4`,
    [coachId, range.from.toISOString(), range.until.toISOString(), limit],
  );
  return result.rows;
}

/** Payments that reached the coach's account and did not book: the ones
 * Money lists under "Payments to resolve", and the same ones once they are
 * refunded. One row per payment, however many events reported it. A
 * payment that is on a booking is left to bookedPayments. */
async function keptPayments(db: DbClient, coachId: number, range: ExportRange, limit: number): Promise<PaymentRow[]> {
  const key = `coalesce(pa.payment_ref, 'attention:' || pa.id::text)`;
  const result = await db.query<PaymentRow>(
    `with on_a_booking as (
       select distinct b.charge_id from ${COACH_BOOKINGS} where b.charge_id is not null and b.gross_cents > 0
     )
     select distinct on (${key})
            pa.payment_ref, coalesce(pr.paid_at, pa.created_at) as paid_at,
            coalesce(pa.contact_phone, b.contact_phone) as contact_phone, b.contact_email,
            case when b.id is null then (case when pa.athlete_name is null then null else array[pa.athlete_name] end)
                 else (select array_agg(o.athlete_name order by o.id) from booking o
                       where o.id = b.id or (b.pass_id is not null and o.pass_id = b.pass_id)) end as names,
            pa.amount_cents::text as amount_cents, null::text as payment_source, null::text as item_name, false as booked,
            null::text as session_name, null::timestamptz as starts_at_utc, ${REFUND_AND_DISPUTE_COLUMNS}
     from payment_attention pa
     left join on_a_booking ob on ob.charge_id = pa.payment_ref
     left join booking b on b.id = pa.booking_id
     left join payment_receipt pr on pr.payment_ref = pa.payment_ref
     ${refundAndDisputeJoins('pa.payment_ref')}
     where pa.coach_id = $1 and ob.charge_id is null
       and coalesce(pr.paid_at, pa.created_at) >= $2 and coalesce(pr.paid_at, pa.created_at) < $3
     order by ${key}, pa.id
     limit $4`,
    [coachId, range.from.toISOString(), range.until.toISOString(), limit],
  );
  return result.rows;
}

/** What the payment bought: a drop-in, or the package or pack by name. */
function boughtWords(row: PaymentRow): string {
  if (row.payment_source === null) return 'not booked';
  const kind = purchaseKind(row.payment_source);
  if (kind === 'drop-in') return 'drop-in';
  return row.item_name ? `${kind}: ${row.item_name}` : kind;
}

const REFUND_WORDS: Record<string, string> = {
  pending: 'refund on its way',
  refunded: 'refunded',
  failed: 'refund failed',
  partial: 'partly refunded',
};

const DISPUTE_WORDS: Record<string, string> = { open: 'disputed', won: 'dispute won', lost: 'dispute lost' };

/** Where the payment stands, in plain words: paid, or its refund, or its
 * card dispute; both when it has both. A refund whose request got no
 * answer has not gone through, and the coach is asked to try it again, so
 * it reads as failed. */
export function paymentStatusWords(row: { refund_status: string | null; refund_error: string | null; dispute_state: string | null }): string {
  const refund =
    row.refund_status === 'requested'
      ? row.refund_error === null
        ? 'refund on its way'
        : 'refund failed'
      : row.refund_status === null
        ? null
        : (REFUND_WORDS[row.refund_status] ?? null);
  const dispute = row.dispute_state === null ? null : (DISPUTE_WORDS[row.dispute_state] ?? null);
  return [refund, dispute].filter((w): w is string => w !== null).join('; ') || 'paid';
}

/** What went back to the card and when: the whole payment once its refund
 * went through, or the part the store reported refunded outside Coachatron. */
function refundedColumns(row: PaymentRow, tz: string): [string, string] {
  if (row.refund_status === 'refunded') return [csvDollars(row.refunded_cents), isoInZone(row.refunded_at, tz)];
  if (row.refund_status === 'partial') return [csvDollars(row.refunded_cents), isoInZone(row.refund_reported_at, tz)];
  return ['', ''];
}

/** The payments file for a range: every payment paid in it, oldest first. */
export async function paymentsCsv(
  db: DbClient,
  coachId: number,
  tz: string,
  range: ExportRange,
  maxRows: number = MAX_EXPORT_ROWS,
): Promise<ExportFile> {
  const booked = await bookedPayments(db, coachId, range, maxRows + 1);
  const kept = await keptPayments(db, coachId, range, maxRows + 1);
  const all = [...booked, ...kept]
    .map((row) => ({ row, at: new Date(row.paid_at).getTime() }))
    .sort((a, b) => a.at - b.at || (a.row.payment_ref ?? '').localeCompare(b.row.payment_ref ?? ''));
  const rows = all.map(({ row }) => {
    const session = row.booked && row.payment_source !== null;
    return [
      isoInZone(row.paid_at, tz),
      row.contact_phone ?? '',
      row.contact_email ?? '',
      namesList(row.names ?? []),
      boughtWords(row),
      session ? (row.session_name ?? '') : '',
      session ? isoInZone(row.starts_at_utc, tz) : '',
      csvDollars(cents(row.amount_cents)),
      ...refundedColumns(row, tz),
      paymentStatusWords(row),
      row.payment_ref ?? '',
    ];
  });
  return file(PAYMENTS_HEADER, rows, maxRows);
}

// ---- Bookings ----

export const BOOKINGS_HEADER = [
  'Session start',
  'Session',
  'Location',
  'Athlete',
  'Parent phone',
  'Parent email',
  'Status',
  'Paid with',
  'Price',
] as const;

interface BookingRow {
  starts_at_utc: Instant;
  session_name: string;
  location_text: string | null;
  athlete_name: string;
  contact_phone: string;
  contact_email: string | null;
  status: string;
  late_cancel: boolean;
  payment_source: string | null;
  charge_id: string | null;
  gross_cents: number | null;
  credit_source: string | null;
  credit_package_id: number | null;
  price_cents: number | null;
}

const BOOKING_STATUS_WORDS: Record<string, string> = {
  booked: 'booked',
  attended: 'attended',
  noshow: 'no-show',
  cancelled: 'cancelled',
  refunded: 'refunded',
  pending: 'holding',
};

export function bookingStatusWords(row: { status: string; late_cancel: boolean }): string {
  if (row.status === 'cancelled' && row.late_cancel) return 'late cancel';
  return BOOKING_STATUS_WORDS[row.status] ?? row.status;
}

/** What paid for the booking: a card, a credit from a package or from a
 * one-time pack, a session credit a cancelled drop-in became, or nothing
 * (a free session). A booking still at checkout has not been paid for.
 *
 * A package or pack bought with the booking paid for it out of its own
 * sessions, so that booking reads as its credit; the purchase itself is in
 * the payments file. A booking paid with a credit names where the credit
 * came from. */
export function paidWithWords(row: Pick<BookingRow, 'status' | 'payment_source' | 'charge_id' | 'gross_cents' | 'credit_source' | 'credit_package_id'>): string {
  if (row.status === 'pending' || row.payment_source === null) return '';
  const kind = purchaseKind(row.payment_source);
  if (kind === 'drop-in') return (row.gross_cents ?? 0) > 0 ? 'card' : 'free';
  if (kind === 'pack') return 'pack credit';
  if (row.charge_id !== null) return 'package credit';
  const source = row.credit_source ?? '';
  if (source.startsWith('plan:')) return 'pack credit';
  if (row.credit_package_id !== null || source.startsWith('package:')) return 'package credit';
  // A drop-in that became a credit: its session was cancelled, the parent
  // cancelled in time, or the coach gave the session back.
  return /^(cancelled-session|cancelled-booking|waived-booking):/.test(source) ? 'session credit' : 'package credit';
}

/** The bookings file for a range: every booking whose session starts in
 * it, in session order. A parent still at checkout is listed while their
 * hold on the spot stands, as on Session detail. The price is the session's
 * price when the booking was made. */
export async function bookingsCsv(
  db: DbClient,
  coachId: number,
  tz: string,
  range: ExportRange,
  maxRows: number = MAX_EXPORT_ROWS,
): Promise<ExportFile> {
  const result = await db.query<BookingRow>(
    `select s.starts_at_utc, st.name as session_name, s.location_text, b.athlete_name, b.contact_phone, b.contact_email,
            b.status, b.late_cancel, b.payment_source, b.charge_id, b.gross_cents,
            c.source as credit_source, c.package_id as credit_package_id,
            coalesce(b.price_cents, case when b.payment_source = 'DropIn' then b.gross_cents end, st.price_cents) as price_cents
     from ${COACH_BOOKINGS}
     left join credit c on c.id = b.credit_id
     where s.starts_at_utc >= $2 and s.starts_at_utc < $3
       and (b.status <> 'pending' or b.hold_expires_at > now())
     order by s.starts_at_utc, s.id, b.id
     limit $4`,
    [coachId, range.from.toISOString(), range.until.toISOString(), maxRows + 1],
  );
  const rows = result.rows.map((row) => [
    isoInZone(row.starts_at_utc, tz),
    row.session_name,
    row.location_text ?? '',
    row.athlete_name,
    row.contact_phone,
    row.contact_email ?? '',
    bookingStatusWords(row),
    paidWithWords(row),
    csvDollars(row.price_cents),
  ]);
  return file(BOOKINGS_HEADER, rows, maxRows);
}
