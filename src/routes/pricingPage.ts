import { coachNav, html, page, raw, type SafeHtml } from '../lib/html.js';
import { formatCoachDollars } from '../lib/time.js';
import { dollarsToCents, LIMITS, wholeNumber } from '../lib/input.js';
import type { PackageRow, PlanRow } from '../domain/pricing.js';
import {
  MAX_CANCEL_WINDOW_HOURS,
  MAX_CHILDREN_PER_BOOKING,
  type BookingPolicy,
} from '../domain/policy.js';
import { cancelGivesField, cancelGivesSummary } from './cancelRefund.js';

const PRICE_PER_SESSION_SCRIPT = raw(`<script>(function(){
  document.querySelectorAll('form.pricing-form').forEach(function(f){
    var sessions=f.querySelector('[name=credits], [name=credits_per_month]');
    var price=f.querySelector('[name=price_dollars]');
    var out=f.querySelector('.per-session-live');
    if(!sessions||!price||!out)return;
    function upd(){
      var n=parseFloat(price.value), s=parseInt(sessions.value,10);
      if(!n||!s||s<1){out.textContent='';return;}
      out.textContent=s+' sessions for $'+n.toFixed(2)+' is $'+(n/s).toFixed(2)+' per session';
    }
    sessions.addEventListener('input',upd);
    price.addEventListener('input',upd);
    upd();
  });
})();</script>`);

export interface PricingViewState {
  policySaved?: boolean;
  policyError?: string;
  policyEditing?: boolean;
  packageCreateOpen?: boolean;
  planCreateOpen?: boolean;
  editingPackageId?: number;
  editingPlanId?: number;
  formError?: string;
  duplicatePackage?: boolean;
  duplicatePlan?: boolean;
}

function perSessionWords(credits: number, priceCents: number): string {
  if (credits < 1) return '';
  const dollars = priceCents / 100 / credits;
  return `${formatCoachDollars(priceCents)} · ${dollars.toFixed(2)} per session`;
}

function packageExpiryWords(expiresDays: number | null): string {
  return expiresDays ? `Credits expire after ${expiresDays} days` : 'Credits do not expire unless you set a limit';
}

function policyCancelWindowWords(hours: number): string {
  if (hours === 0) return 'up to the start time';
  return `more than ${hours} ${hours === 1 ? 'hour' : 'hours'} before start`;
}

function policyLateCancelWords(hours: number): string {
  if (hours === 0) return '';
  return `Inside ${hours} ${hours === 1 ? 'hour' : 'hours'}, cancelling uses the credit (same as not showing up). You can still give it back on the session screen.`;
}

function renderPolicyBullets(policy: BookingPolicy): SafeHtml {
  const children = policy.childrenPerBooking;
  return html`<ul class="policy-bullets" style="margin:0;padding-left:1.25rem;">
      <li><strong>Not showing up:</strong> the session credit is used. You can give it back on the session screen.</li>
      <li><strong>Cancelling in time:</strong> if a parent cancels ${policyCancelWindowWords(policy.cancelWindowHours)}, their credit comes back. For a single session paid by card, ${cancelGivesSummary(policy)}.</li>
      ${policyLateCancelWords(policy.cancelWindowHours)
        ? html`<li><strong>Cancelling late:</strong> ${policyLateCancelWords(policy.cancelWindowHours)}</li>`
        : raw('')}
      <li><strong>Children:</strong> up to ${children} ${children === 1 ? 'child' : 'children'} in one booking; each needs a spot and a credit or drop-in payment.</li>
    </ul>`;
}

function renderPolicyForm(policy: BookingPolicy, cancelHref: string): SafeHtml {
  const hours = policy.cancelWindowHours;
  const children = policy.childrenPerBooking;
  return html`<form method="post" action="/app/pricing/policy" class="pricing-form">
      <label for="cancel_window_hours">How many hours before a session can a parent cancel and keep their credit?</label>
      <input id="cancel_window_hours" name="cancel_window_hours" type="number" inputmode="numeric" min="0" max="${MAX_CANCEL_WINDOW_HOURS}" required value="${hours}" />
      <label for="children_per_booking">Children per booking</label>
      <input id="children_per_booking" name="children_per_booking" type="number" inputmode="numeric" min="1" max="${MAX_CHILDREN_PER_BOOKING}" required value="${children}" />
      ${cancelGivesField(policy)}
      <div class="btn-row">
        <button type="submit">Save policy</button>
        <a class="action ghost" href="${cancelHref}">Cancel</a>
      </div>
    </form>
    ${PRICE_PER_SESSION_SCRIPT}`;
}

function renderPolicySection(policy: BookingPolicy, state: PricingViewState): SafeHtml {
  const editing = state.policyEditing || Boolean(state.policyError);
  return html`<h2 id="policy">Booking policy</h2>
    ${state.policySaved
      ? html`<div class="card"><p><strong>Policy saved.</strong></p></div>`
      : raw('')}
    <div class="card policy">
      ${renderPolicyBullets(policy)}
      <div class="btn-row" style="margin-top:0.75rem;">
        <details class="policy-edit"${editing ? raw(' open') : raw('')}>
          <summary class="action ghost">Edit policy</summary>
          ${state.policyError ? html`<p class="error">${state.policyError}</p>` : raw('')}
          ${renderPolicyForm(policy, '/app/pricing#policy')}
        </details>
      </div>
    </div>`;
}

interface PackageFormValues {
  name?: string;
  credits?: number | string;
  priceDollars?: number | string;
  expiresDays?: number | string;
}

function renderPackageForm(
  action: string,
  submitLabel: string,
  opts: { idPrefix: string; values?: PackageFormValues; cancelHref: string; showExpiry: boolean },
): SafeHtml {
  const { idPrefix, values, cancelHref, showExpiry } = opts;
  const priceVal = values?.priceDollars ?? '';
  return html`<form method="post" action="${action}" class="pricing-form">
    <label for="${idPrefix}name">Package name</label>
    <input id="${idPrefix}name" name="name" required placeholder="e.g. 10-session pack" value="${values?.name ?? ''}" />
    <label for="${idPrefix}credits">Number of sessions</label>
    <input id="${idPrefix}credits" name="credits" type="number" inputmode="numeric" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 10" value="${values?.credits ?? ''}" />
    <label for="${idPrefix}price_dollars">Price (dollars, charged once)</label>
    <input id="${idPrefix}price_dollars" name="price_dollars" type="number" inputmode="decimal" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 150" value="${priceVal}" />
    <p class="muted per-session-live"></p>
    ${showExpiry
      ? html`<label for="${idPrefix}expires_days">Expires after days (optional)</label>
        <input id="${idPrefix}expires_days" name="expires_days" type="number" inputmode="numeric" min="${LIMITS.expiresDays.min}" max="${LIMITS.expiresDays.max}" placeholder="Leave blank for no expiry" value="${values?.expiresDays ?? ''}" />`
      : raw('')}
    <div class="btn-row">
      <button type="submit">${submitLabel}</button>
      <a class="action ghost" href="${cancelHref}">Cancel</a>
    </div>
  </form>
  ${PRICE_PER_SESSION_SCRIPT}`;
}

interface PlanFormValues {
  name?: string;
  creditsPerMonth?: number | string;
  priceDollars?: number | string;
}

function renderPlanForm(
  action: string,
  submitLabel: string,
  opts: { idPrefix: string; values?: PlanFormValues; cancelHref: string },
): SafeHtml {
  const { idPrefix, values, cancelHref } = opts;
  const priceVal = values?.priceDollars ?? '';
  return html`<form method="post" action="${action}" class="pricing-form">
    <label for="${idPrefix}name">Pack name</label>
    <input id="${idPrefix}name" name="name" required placeholder="e.g. 4-session pack" value="${values?.name ?? ''}" />
    <label for="${idPrefix}credits_per_month">Number of sessions</label>
    <input id="${idPrefix}credits_per_month" name="credits_per_month" type="number" inputmode="numeric" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 4" value="${values?.creditsPerMonth ?? ''}" />
    <label for="${idPrefix}price_dollars">Price (dollars, charged once)</label>
    <input id="${idPrefix}price_dollars" name="price_dollars" type="number" inputmode="decimal" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 120" value="${priceVal}" />
    <p class="muted per-session-live"></p>
    <div class="btn-row">
      <button type="submit">${submitLabel}</button>
      <a class="action ghost" href="${cancelHref}">Cancel</a>
    </div>
  </form>
  ${PRICE_PER_SESSION_SCRIPT}`;
}

function renderPackageCard(p: PackageRow, state: PricingViewState): SafeHtml {
  const editing = state.editingPackageId === p.id;
  return html`<div class="card">
      <strong>${p.name}</strong>
      <div class="meta">
        <span>${p.credits} ${p.credits === 1 ? 'session' : 'sessions'} · ${perSessionWords(p.credits, p.price_cents)}</span>
      </div>
      <div class="meta"><span>${packageExpiryWords(p.expires_days)}</span></div>
      <div class="btn-row">
        <details class="pkg-edit"${editing ? raw(' open') : raw('')}>
          <summary class="action ghost">Edit</summary>
          ${renderPackageForm(`/app/pricing/package/${p.id}/edit`, 'Save changes', {
            idPrefix: `edit-pkg-${p.id}-`,
            values: {
              name: p.name,
              credits: p.credits,
              priceDollars: (p.price_cents / 100).toFixed(2),
              expiresDays: p.expires_days ?? '',
            },
            cancelHref: '/app/pricing',
            showExpiry: true,
          })}
        </details>
      </div>
      <details>
        <summary class="ghost" style="margin-top:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.9rem;color:var(--alert);cursor:pointer;">Delete</summary>
        <p class="muted">Remove ${p.name}? Parents who already bought it keep their credits.</p>
        <form method="post" action="/app/pricing/package/${p.id}/delete">
          <button type="submit" class="ghost">Yes, remove this package</button>
        </form>
      </details>
    </div>`;
}

function renderPlanCard(p: PlanRow, state: PricingViewState): SafeHtml {
  const editing = state.editingPlanId === p.id;
  return html`<div class="card">
      <strong>${p.name}</strong>
      <div class="meta">
        <span>${p.credits_per_month} ${p.credits_per_month === 1 ? 'session' : 'sessions'} · ${perSessionWords(p.credits_per_month, p.price_cents)}</span>
      </div>
      <div class="meta"><span>Sessions do not expire</span></div>
      <div class="btn-row">
        <details class="plan-edit"${editing ? raw(' open') : raw('')}>
          <summary class="action ghost">Edit</summary>
          ${renderPlanForm(`/app/pricing/plan/${p.id}/edit`, 'Save changes', {
            idPrefix: `edit-plan-${p.id}-`,
            values: {
              name: p.name,
              creditsPerMonth: p.credits_per_month,
              priceDollars: (p.price_cents / 100).toFixed(2),
            },
            cancelHref: '/app/pricing',
          })}
        </details>
      </div>
      <details>
        <summary class="ghost" style="margin-top:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.9rem;color:var(--alert);cursor:pointer;">Delete</summary>
        <p class="muted">Remove ${p.name}? Parents who already bought it keep their credits.</p>
        <form method="post" action="/app/pricing/plan/${p.id}/delete">
          <button type="submit" class="ghost">Yes, remove this pack</button>
        </form>
      </details>
    </div>`;
}

export function renderPricingPage(
  packagesList: PackageRow[],
  plansList: PlanRow[],
  policy: BookingPolicy,
  state: PricingViewState = {},
): string {
  return page(
    'Pricing',
    html`${coachNav('pricing')}
      <h1>Pricing & credits</h1>
      ${state.formError ? html`<p class="error">${state.formError}</p>` : raw('')}
      <h2>Session packages</h2>
      <p class="muted">Prepaid session credits. You can set when unused credits expire.</p>
      ${packagesList.length === 0
        ? html`<p class="muted">No packages yet.</p>`
        : packagesList.map((p) => renderPackageCard(p, state))}
      <details class="pkg-create"${state.packageCreateOpen ? raw(' open') : raw('')}>
        <summary>+ New package</summary>
        ${renderPackageForm('/app/pricing/package', 'Create package', {
          idPrefix: 'pkg-',
          cancelHref: '/app/pricing',
          showExpiry: true,
        })}
      </details>

      <h2>One-time packs</h2>
      <p class="muted">Charged once. The sessions do not expire.</p>
      ${plansList.length === 0
        ? html`<p class="muted">No one-time packs yet.</p>`
        : plansList.map((p) => renderPlanCard(p, state))}
      <details class="plan-create"${state.planCreateOpen ? raw(' open') : raw('')}>
        <summary>+ New one-time pack</summary>
        ${renderPlanForm('/app/pricing/plan', 'Create pack', {
          idPrefix: 'plan-',
          cancelHref: '/app/pricing',
        })}
      </details>
      ${renderPolicySection(policy, state)}`,
  );
}

export function parsePackageFields(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const credits = wholeNumber(String(body.credits ?? ''), LIMITS.credits);
  const priceCents = dollarsToCents(String(body.price_dollars ?? ''), LIMITS.priceCents);
  const expiresRaw = String(body.expires_days ?? '').trim();
  let expiresDays: number | null | undefined;
  if (!expiresRaw) expiresDays = undefined;
  else {
    const n = wholeNumber(expiresRaw, LIMITS.expiresDays);
    expiresDays = n;
  }
  const valid = Boolean(name && credits !== null && priceCents !== null && expiresDays !== null);
  return { name, credits, priceCents, expiresDays, valid };
}

export function parsePlanFields(body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const priceCents = dollarsToCents(String(body.price_dollars ?? ''), LIMITS.priceCents);
  const creditsPerMonth = wholeNumber(String(body.credits_per_month ?? ''), LIMITS.credits);
  const valid = Boolean(name && creditsPerMonth !== null && priceCents !== null);
  return { name, creditsPerMonth, priceCents, valid };
}