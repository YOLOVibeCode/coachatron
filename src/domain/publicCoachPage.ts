import type { DbClient } from '../db/client.js';
import { html, raw, type SafeHtml } from '../lib/html.js';
import { formatCoachDollars } from '../lib/time.js';
import type { BookingPolicy } from './policy.js';
import type { PackageRow, PlanRow } from './pricing.js';

export async function minDropInPriceCents(db: DbClient, coachId: number): Promise<number | null> {
  const result = await db.query<{ min: number | null }>(
    'select min(price_cents)::int as min from session_type where coach_id = $1 and active = true and price_cents > 0',
    [coachId],
  );
  const min = result.rows[0]?.min;
  return min !== null && min !== undefined && min > 0 ? min : null;
}

export function perSessionCents(priceCents: number, credits: number): number {
  return Math.floor(priceCents / Math.max(1, credits));
}

/** Whole dollars saved per session when a pack beats drop-in, or null. */
export function packSavingsCents(perSession: number, dropInCents: number | null): number | null {
  if (dropInCents === null || perSession >= dropInCents) return null;
  return dropInCents - perSession;
}

export function publicCancelSentence(windowHours: number): string {
  if (windowHours === 0) return 'Cancel free any time before the session starts.';
  return `Cancel free up to ${windowHours} ${windowHours === 1 ? 'hour' : 'hours'} before.`;
}

export function publicChildrenLine(childrenPerBooking: number): string | null {
  if (childrenPerBooking <= 1) return null;
  return `Up to ${childrenPerBooking} people per booking.`;
}

export function packSaveLabel(savingsCents: number | null): SafeHtml {
  if (savingsCents === null || savingsCents <= 0) return raw('');
  return html` <span class="save">Save ${formatCoachDollars(savingsCents)} per session</span>`;
}

export function renderSessionPackSection(
  packages: PackageRow[],
  plans: PlanRow[],
  dropInCents: number | null,
): SafeHtml {
  if (packages.length === 0 && plans.length === 0) return raw('');
  const rows = [
    ...packages.map((p) => {
      const per = perSessionCents(p.price_cents, p.credits);
      const expiry = p.expires_days
        ? ` · Use within ${p.expires_days} days`
        : ' · Credits do not expire';
      return html`<div class="pack-card">
        <strong>${p.name}</strong>
        <p class="muted">${p.credits} ${p.credits === 1 ? 'session' : 'sessions'} · ${formatCoachDollars(p.price_cents)}${expiry}${packSaveLabel(packSavingsCents(per, dropInCents))}</p>
      </div>`;
    }),
    ...plans.map((pl) => {
      const per = perSessionCents(pl.price_cents, pl.credits_per_month);
      return html`<div class="pack-card">
        <strong>${pl.name}</strong>
        <p class="muted">${pl.credits_per_month} ${pl.credits_per_month === 1 ? 'session' : 'sessions'} · ${formatCoachDollars(pl.price_cents)} · Credits do not expire${packSaveLabel(packSavingsCents(per, dropInCents))}</p>
      </div>`;
    }),
  ];
  return html`<h2>Session packs</h2>
    <p class="muted">Pay once, book them one at a time.</p>
    ${rows}`;
}

export function renderPublicPolicyLines(
  policy: BookingPolicy,
  showCancel: boolean,
): SafeHtml {
  const lines: SafeHtml[] = [];
  if (showCancel) {
    lines.push(html`<p class="muted policy-line">${publicCancelSentence(policy.cancelWindowHours)}</p>`);
  }
  const children = publicChildrenLine(policy.childrenPerBooking);
  if (children) {
    lines.push(html`<p class="muted policy-line">${children}</p>`);
  }
  if (lines.length === 0) return raw('');
  return html`${lines}`;
}

export function coachMessageHead(handle: string, name: string) {
  return { coachMessage: { handle, name } };
}