import type { DbClient } from '../db/client.js';
import type { CoachRow } from './auth.js';
import { atPlace, placeLine } from './locations.js';
import { takesSpotSql, type PackageRow } from './pricing.js';
import { getBookingPolicy, type BookingPolicy } from './policy.js';
import { html, raw, type SafeHtml } from '../lib/html.js';
import {
  formatCoachDollars,
  formatDurationMin,
  formatPublicDayHeading,
  formatPublicSessionWhen,
  formatTimeZoneShort,
} from '../lib/time.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from './scheduling.js';

export type PublicSessionTypeFilter = 'all' | 'one_on_one' | 'group';

export interface PublicPageQuery {
  week: 0 | 1;
  type: PublicSessionTypeFilter;
}

export function parsePublicPageQuery(query: Record<string, unknown>): PublicPageQuery {
  const weekRaw = query.week;
  const week = weekRaw === '1' || weekRaw === 1 ? 1 : 0;
  const typeRaw = typeof query.type === 'string' ? query.type : 'all';
  const type: PublicSessionTypeFilter =
    typeRaw === 'one_on_one' || typeRaw === 'group' ? typeRaw : 'all';
  return { week, type };
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localDateParts(date: Date, tz: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_NAMES.indexOf(get('weekday')),
  };
}

/** Rolling 7-day windows from today in the coach's zone (week 0 = today through 6 days out). */
export function weekBoundsUtc(coachTz: string, weekIndex: number, now: Date = new Date()): { start: Date; end: Date } {
  const { year, month, day } = localDateParts(now, coachTz);
  const startDay = addCalendarDays(year, month, day, weekIndex * 7);
  const endDay = addCalendarDays(year, month, day, (weekIndex + 1) * 7);
  const start = zonedTimeToUtc(startDay.year, startDay.month, startDay.day, 0, 0, coachTz);
  const end = zonedTimeToUtc(endDay.year, endDay.month, endDay.day, 0, 0, coachTz);
  return { start, end };
}

export interface PublicSessionRow {
  id: number;
  starts_at_utc: string;
  tz: string;
  name: string;
  capacity: number;
  price_cents: number;
  duration_min: number;
  booked: string;
  location_text: string | null;
  location_address: string | null;
  listing_note: string | null;
}

export async function loadPublicSessions(
  db: DbClient,
  coachId: number,
  opts: { week: 0 | 1; type: PublicSessionTypeFilter; coachTz: string; now?: Date },
): Promise<PublicSessionRow[]> {
  const now = opts.now ?? new Date();
  const { start, end } = weekBoundsUtc(opts.coachTz, opts.week, now);
  const capacityClause =
    opts.type === 'one_on_one'
      ? 'and coalesce(s.capacity_override, st.capacity) = 1'
      : opts.type === 'group'
        ? 'and coalesce(s.capacity_override, st.capacity) > 1'
        : '';
  const result = await db.query<PublicSessionRow>(
    `select s.id, s.starts_at_utc, s.tz, st.name, coalesce(s.capacity_override, st.capacity) as capacity, st.price_cents,
            st.duration_min, s.location_text, s.location_address, s.listing_note,
            (coalesce((select count(*) from booking b where b.session_id = s.id and ${takesSpotSql('b')}), 0)
             + coalesce((select count(*) from waitlist w where w.session_id = coalesce(s.overflow_of, s.id) and w.state = 'waiting'), 0))::text as booked
     from session s
     join session_type st on st.id = s.session_type_id
     where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
       and not s.hide_from_public
       and s.starts_at_utc >= $2 and s.starts_at_utc < $3
       ${capacityClause}
     order by s.starts_at_utc
     limit 50`,
  [coachId, start.toISOString(), end.toISOString()],
  );
  return result.rows;
}

export async function coachHasUpcomingPaidSessions(db: DbClient, coachId: number): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1 from session s
       join session_type st on st.id = s.session_type_id
       where st.coach_id = $1 and s.status = 'scheduled' and s.starts_at_utc > now()
         and not s.hide_from_public and st.price_cents > 0
     ) as exists`,
    [coachId],
  );
  return result.rows[0]?.exists === true;
}

export async function coachMinDropInCents(db: DbClient, coachId: number): Promise<number | null> {
  const result = await db.query<{ min: string | null }>(
    `select min(price_cents)::text as min from session_type where coach_id = $1 and active = true and price_cents > 0`,
    [coachId],
  );
  const v = result.rows[0]?.min;
  return v === null || v === undefined ? null : Number(v);
}

export function packageSaveCents(pkg: PackageRow, minDropInCents: number | null): number | null {
  if (minDropInCents === null) return null;
  const full = pkg.credits * minDropInCents;
  const save = full - pkg.price_cents;
  return save > 0 ? save : null;
}

function cancelGivesParentLine(policy: Pick<BookingPolicy, 'cancelGives'>): string {
  return policy.cancelGives === 'refund' ? 'a paid drop-in is refunded to their card' : 'a paid drop-in becomes a session credit';
}

export function publicCancelSummary(policy: BookingPolicy): string {
  const hours = policy.cancelWindowHours;
  const window =
    hours === 0
      ? 'before a session starts'
      : `more than ${hours} ${hours === 1 ? 'hour' : 'hours'} before a session`;
  return `Cancel ${window} and ${cancelGivesParentLine(policy)}. Inside that window, the booking counts as a no-show.`;
}

export function spotLabel(capacity: number, spotsLeft: number): string {
  if (spotsLeft <= 0) return 'Full';
  if (capacity === 1) return 'Available';
  return `${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left`;
}

export function dayKey(startsAtUtc: string, tz: string): string {
  const p = zonedParts(new Date(startsAtUtc), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function publicPageQueryString(week: number, type: PublicSessionTypeFilter, from: string | null): string {
  const parts = new URLSearchParams();
  if (week === 1) parts.set('week', '1');
  if (type !== 'all') parts.set('type', type);
  if (from) parts.set('from', from);
  const q = parts.toString();
  return q ? `?${q}` : '';
}

export interface RenderCoachPublicPageArgs {
  coach: CoachRow;
  sessions: PublicSessionRow[];
  packages: PackageRow[];
  policy: BookingPolicy;
  minDropInCents: number | null;
  paymentsOpen: boolean;
  creditsWork: boolean;
  bookQuery: string;
  pageQuery: PublicPageQuery;
  fromToken: string | null;
  needsPaymentAny: boolean;
  askQuestionHref: string;
}

function priceDetail(session: PublicSessionRow, perPerson: boolean): string {
  const price = formatCoachDollars(session.price_cents);
  return perPerson && session.capacity > 1 ? `${price} per person` : price;
}

export function renderCoachPublicPage(args: RenderCoachPublicPageArgs): SafeHtml {
  const {
    coach,
    sessions,
    packages,
    policy,
    minDropInCents,
    paymentsOpen,
    creditsWork,
    bookQuery,
    pageQuery,
    fromToken,
    needsPaymentAny,
    askQuestionHref,
  } = args;
  const closedPaid = !paymentsOpen && needsPaymentAny;
  const qSuffix = publicPageQueryString(pageQuery.week, pageQuery.type, fromToken);
  const handle = coach.handle;

  const filterLinks = (active: PublicSessionTypeFilter, label: string) => {
    const qs = publicPageQueryString(pageQuery.week, active, fromToken);
    const on = pageQuery.type === active;
    return html`<a class="action ghost${on ? raw(' on') : raw('')}" href="/c/${handle}${qs}"${on ? raw(' aria-current="true"') : raw('')}>${label}</a>`;
  };

  const grouped = new Map<string, PublicSessionRow[]>();
  for (const s of sessions) {
    const key = dayKey(s.starts_at_utc, s.tz);
    const list = grouped.get(key) ?? [];
    list.push(s);
    grouped.set(key, list);
  }

  const sessionBlocks =
    sessions.length === 0
      ? html`<p class="muted">No open sessions in this week.</p>`
      : [...grouped.entries()].map(([_, daySessions]) => {
          const heading = formatPublicDayHeading(daySessions[0]!.starts_at_utc, daySessions[0]!.tz);
          return html`<section class="day-group">
            <h2 class="day-heading">${heading}</h2>
            ${daySessions.map((s) => {
              const spotsLeft = s.capacity - Number(s.booked);
              const paid = s.price_cents > 0;
              const canBook = spotsLeft > 0 && (paymentsOpen || !paid);
              const canBookWithCredits = spotsLeft > 0 && paid && !paymentsOpen && creditsWork;
              const waitlist = spotsLeft <= 0 && (paymentsOpen || !paid || creditsWork);
              const place = s.location_text ? placeLine(s.location_text, s.location_address) : coach.sessions_place;
              const metaLeft = [formatDurationMin(s.duration_min), s.name, place].filter(Boolean).join(' · ');
              return html`<div class="card">
                <strong>${formatPublicSessionWhen(s.starts_at_utc, s.tz)}</strong>
                <div class="meta">
                  <span>${metaLeft}</span>
                  <span>${spotLabel(s.capacity, spotsLeft)} · ${priceDetail(s, s.capacity > 1)}</span>
                </div>
                ${s.listing_note ? html`<p class="muted">${s.listing_note}</p>` : raw('')}
                ${waitlist
                  ? html`<a class="action ghost" href="/c/${handle}/sessions/${s.id}/book${bookQuery}">Join the waitlist</a>`
                  : canBook
                    ? html`<a class="action" href="/c/${handle}/sessions/${s.id}/book${bookQuery}">Book</a>`
                    : canBookWithCredits
                      ? html`<p class="muted"><a href="/c/${handle}/sessions/${s.id}/book${bookQuery}">Have session credits? Book with them</a></p>`
                    : paid && !paymentsOpen
                      ? html`<button type="button" class="action disabled" disabled>Not open</button>`
                      : raw('')}
              </div>`;
            })}
          </section>`;
        });

  const weekNav =
    pageQuery.week === 0
      ? html`<p><a class="action ghost" href="/c/${handle}${publicPageQueryString(1, pageQuery.type, fromToken)}">Show next week</a></p>`
      : html`<p><a class="action ghost" href="/c/${handle}${publicPageQueryString(0, pageQuery.type, fromToken)}">Show this week</a></p>`;

  const tzLabel = formatTimeZoneShort(coach.tz);
  const headerExtras = [
    coach.public_bio ? html`<p>${coach.public_bio}</p>` : raw(''),
    coach.sessions_place ? html`<p class="muted">Sessions: ${coach.sessions_place}</p>` : raw(''),
    html`<p class="muted">Times are in ${tzLabel} (${coach.tz.replace(/_/g, ' ')}).</p>`,
  ];

  const packsSection =
    packages.length === 0
      ? raw('')
      : html`<h2>Session packs</h2>
          <p class="muted">Pay once, book them one at a time.</p>
          ${packages.map((p) => {
            const save = packageSaveCents(p, minDropInCents);
            const expiry = p.expires_days ? ` · Use within ${p.expires_days} days` : '';
            return html`<div class="card">
              <strong>${p.name}</strong>
              <div class="meta">
                <span>${p.credits} sessions</span>
                <span>${formatCoachDollars(p.price_cents)}${save !== null ? ` · Save ${formatCoachDollars(save)}` : ''}${expiry}</span>
              </div>
            </div>`;
          })}`;

  return html`${closedPaid
      ? html`<div class="card booking-closed-banner">
          <p><strong>Booking is not open yet.</strong> This coach has not turned on payments.</p>
          <p class="muted"><a href="${askQuestionHref}">Ask a question</a></p>
        </div>`
      : raw('')}
    <h1>${coach.name}</h1>
    ${headerExtras}
    <nav class="btn-row public-filters" aria-label="Session type">
      ${filterLinks('all', 'All')}
      ${filterLinks('one_on_one', 'One-on-one')}
      ${filterLinks('group', 'Group')}
    </nav>
  <h2 class="eyebrow">Open sessions</h2>
    <p class="muted">No account needed. Book a time, then pay on the secure checkout page.</p>
    ${sessionBlocks}
    ${weekNav}
    ${packsSection}
    <h2>Cancellation</h2>
    <p class="muted">${publicCancelSummary(policy)}</p>
    <p class="muted">Booked before? <a href="/my">See all your sessions</a></p>`;
}

export async function loadPublicPagePolicy(db: DbClient, coachId: number): Promise<BookingPolicy> {
  return getBookingPolicy(db, coachId);
}