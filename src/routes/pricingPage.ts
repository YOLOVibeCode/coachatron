import type { Request, Response, Router } from 'express';
import { getDb } from '../db/client.js';
import { coachHeader, html, page, raw, SESSION_CREDITS_EXPLANATION, type SafeHtml } from '../lib/html.js';
import { formatCoachDollars } from '../lib/time.js';
import { dollarsToCents, LIMITS, rowId, wholeNumber } from '../lib/input.js';
import {
  createPackage,
  createPlan,
  findActivePackageDuplicate,
  findActivePlanDuplicate,
  formatPerSessionDollars,
  getPackageById,
  getPackagesForCoach,
  getPlanById,
  getPlansForCoach,
  retirePackage,
  retirePlan,
  updatePackage,
  updatePlan,
  type PackageRow,
  type PlanRow,
} from '../domain/pricing.js';
import {
  getBookingPolicy,
  MAX_CANCEL_WINDOW_HOURS,
  MAX_CHILDREN_PER_BOOKING,
  parseBookingPolicy,
  setBookingPolicy,
  type BookingPolicy,
} from '../domain/policy.js';
import { cancelGivesField } from './cancelRefund.js';
import {
  getClientContactChannel,
  parseClientContactChannel,
  setClientContactChannel,
  type ClientContactChannel,
} from '../domain/clientContact.js';

const CONTACT_CHANNEL_OPTIONS: Array<[ClientContactChannel, string]> = [
  ['coachatron', 'Coachatron message (we text or email you)'],
  ['email', 'My email'],
  ['phone', 'My text number'],
];

const PACKAGE_EXPIRY_PRESETS = [
  { value: '', label: 'Never' },
  { value: '30', label: 'After 30 days' },
  { value: '60', label: 'After 60 days' },
  { value: '90', label: 'After 90 days' },
] as const;

const DUPLICATE_PACKAGE_MSG =
  'You already have an active package with this name or the same number of sessions and price.';
const DUPLICATE_PLAN_MSG =
  'You already have an active one-time pack with this name or the same number of sessions and price.';

const PRICING_PER_SESSION_SCRIPT = raw(`<script>(function(){
  function bindForm(form){
    if(!form||form.dataset.perSessionBound)return;
    form.dataset.perSessionBound='1';
    var credits=form.querySelector('[name="credits"],[name="credits_per_month"]');
    var price=form.querySelector('[name="price_dollars"]');
    var out=form.querySelector('.pricing-per-session');
    if(!credits||!price||!out)return;
    function update(){
      var n=parseFloat(credits.value),d=parseFloat(price.value);
      if(!n||!d||n<1){out.textContent='';return;}
      var per=(d/n).toFixed(2);
      out.textContent=n+' sessions for $'+d.toFixed(2)+' is $'+per+' per session';
    }
    credits.addEventListener('input',update);
    price.addEventListener('input',update);
    update();
  }
  document.querySelectorAll('form.pricing-offer-form').forEach(bindForm);
})();</script>`);

function bodyField(body: unknown, key: string): string {
  if (body === null || typeof body !== 'object') return '';
  const v = (body as Record<string, unknown>)[key];
  return v === undefined || v === null ? '' : String(v);
}

type OfferFieldErrors = {
  name?: string;
  credits?: string;
  price_dollars?: string;
  expires_days?: string;
  _form?: string;
};

type PackageFormValues = {
  name?: string;
  credits?: number;
  priceDollars?: string;
  expiresDays?: string;
};

type PlanFormValues = {
  name?: string;
  creditsPerMonth?: number;
  priceDollars?: string;
};

export type PricingViewState = {
  policySaved?: boolean;
  policyError?: string;
  openPolicyEdit?: boolean;
  openCreatePackage?: boolean;
  openCreatePlan?: boolean;
  openEditPackageId?: number;
  openEditPlanId?: number;
  packageCreate?: { values: PackageFormValues; errors: OfferFieldErrors };
  planCreate?: { values: PlanFormValues; errors: OfferFieldErrors };
  packageEdit?: { typeId: number; values: PackageFormValues; errors: OfferFieldErrors };
  planEdit?: { typeId: number; values: PlanFormValues; errors: OfferFieldErrors };
};

function fieldErr(errors: OfferFieldErrors | undefined, key: keyof OfferFieldErrors): SafeHtml {
  const msg = errors?.[key];
  return msg ? html`<p class="error">${msg}</p>` : raw('');
}

function parsePackageExpires(raw: string): { expiresDays?: number; error?: string } {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'never') return { expiresDays: undefined };
  if (!/^\d+$/.test(v)) return { error: 'Choose when credits expire, or Never.' };
  const n = wholeNumber(v, LIMITS.expiresDays);
  if (n === null) {
    return { error: `If credits expire, use ${LIMITS.expiresDays.min}–${LIMITS.expiresDays.max} days or a preset.` };
  }
  return { expiresDays: n };
}

function packageExpiryLabel(expiresDays: number | null): string {
  return expiresDays ? `Credits expire after ${expiresDays} days` : 'Credits never expire';
}

function packageExpirySelectValue(expiresDays: number | null | undefined): string {
  if (expiresDays == null) return '';
  const preset = PACKAGE_EXPIRY_PRESETS.find((p) => p.value === String(expiresDays));
  return preset ? preset.value : String(expiresDays);
}

function readPackageBody(body: Record<string, unknown>): {
  fields: { name: string; credits: number; priceCents: number; expiresDays: number | null } | null;
  values: PackageFormValues;
  errors: OfferFieldErrors;
} {
  const errors: OfferFieldErrors = {};
  const name = bodyField(body, 'name').trim();
  const creditsRaw = bodyField(body, 'credits');
  const priceRaw = bodyField(body, 'price_dollars');
  const expiresRaw = bodyField(body, 'expires_days');
  const values: PackageFormValues = {
    name,
    priceDollars: priceRaw,
    expiresDays: expiresRaw,
  };
  if (!name) errors.name = 'Enter a package name.';
  const credits = wholeNumber(creditsRaw, LIMITS.credits);
  if (credits === null) {
    errors.credits = `Use ${LIMITS.credits.min}–${LIMITS.credits.max} sessions.`;
  } else values.credits = credits;
  const priceCents = dollarsToCents(priceRaw, LIMITS.priceCents);
  if (priceCents === null) {
    errors.price_dollars = `Enter a price up to ${formatCoachDollars(LIMITS.priceCents.max)}.`;
  }
  const exp = parsePackageExpires(expiresRaw);
  if (exp.error) errors.expires_days = exp.error;
  if (Object.keys(errors).length > 0) return { fields: null, values, errors };
  return {
    fields: {
      name,
      credits: credits!,
      priceCents: priceCents!,
      expiresDays: exp.expiresDays ?? null,
    },
    values,
    errors,
  };
}

function readPlanBody(body: Record<string, unknown>): {
  fields: { name: string; creditsPerMonth: number; priceCents: number } | null;
  values: PlanFormValues;
  errors: OfferFieldErrors;
} {
  const errors: OfferFieldErrors = {};
  const name = bodyField(body, 'name').trim();
  const creditsRaw = bodyField(body, 'credits_per_month');
  const priceRaw = bodyField(body, 'price_dollars');
  const values: PlanFormValues = { name, priceDollars: priceRaw };
  if (!name) errors.name = 'Enter a pack name.';
  const creditsPerMonth = wholeNumber(creditsRaw, LIMITS.credits);
  if (creditsPerMonth === null) {
    errors.credits = `Use ${LIMITS.credits.min}–${LIMITS.credits.max} sessions.`;
  } else values.creditsPerMonth = creditsPerMonth;
  const priceCents = dollarsToCents(priceRaw, LIMITS.priceCents);
  if (priceCents === null) {
    errors.price_dollars = `Enter a price up to ${formatCoachDollars(LIMITS.priceCents.max)}.`;
  }
  if (Object.keys(errors).length > 0) return { fields: null, values, errors };
  return {
    fields: { name, creditsPerMonth: creditsPerMonth!, priceCents: priceCents! },
    values,
    errors,
  };
}

function renderPackageForm(
  action: string,
  submitLabel: string,
  idPrefix: string,
  values?: PackageFormValues,
  errors?: OfferFieldErrors,
  cancelHref = '/app/pricing',
) {
  const expVal = packageExpirySelectValue(
    values?.expiresDays === '' || values?.expiresDays === undefined
      ? null
      : values.expiresDays
        ? Number(values.expiresDays)
        : null,
  );
  const customExpiry =
    expVal && !PACKAGE_EXPIRY_PRESETS.some((p) => p.value === expVal)
      ? html`<option value="${expVal}" selected>After ${expVal} days</option>`
      : raw('');
  return html`<form class="pricing-offer-form" method="post" action="${action}">
    <label for="${idPrefix}name">Package name</label>
    <input id="${idPrefix}name" name="name" required placeholder="e.g. 10-session pack" value="${values?.name ?? ''}" />
    ${fieldErr(errors, 'name')}
    <label for="${idPrefix}credits">Number of sessions</label>
    <input id="${idPrefix}credits" name="credits" type="number" inputmode="numeric" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 10" value="${values?.credits ?? ''}" />
    ${fieldErr(errors, 'credits')}
    <label for="${idPrefix}price_dollars">Price (in dollars, charged once)</label>
    <input id="${idPrefix}price_dollars" name="price_dollars" type="number" inputmode="decimal" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 150" value="${values?.priceDollars ?? ''}" />
    ${fieldErr(errors, 'price_dollars')}
    <p class="muted pricing-per-session" aria-live="polite"></p>
    <label for="${idPrefix}expires_days">Credits expire</label>
    <select id="${idPrefix}expires_days" name="expires_days">
      ${PACKAGE_EXPIRY_PRESETS.map(
        (p) =>
          p.value === expVal
            ? html`<option value="${p.value}" selected>${p.label}</option>`
            : html`<option value="${p.value}">${p.label}</option>`,
      )}
      ${customExpiry}
    </select>
    ${fieldErr(errors, 'expires_days')}
    ${fieldErr(errors, '_form')}
    <div class="btn-row">
      <button type="submit">${submitLabel}</button>
      <a class="action ghost" href="${cancelHref}">Cancel</a>
    </div>
  </form>`;
}

function renderPlanForm(
  action: string,
  submitLabel: string,
  idPrefix: string,
  values?: PlanFormValues,
  errors?: OfferFieldErrors,
  cancelHref = '/app/pricing',
) {
  return html`<form class="pricing-offer-form" method="post" action="${action}">
    <label for="${idPrefix}name">Pack name</label>
    <input id="${idPrefix}name" name="name" required placeholder="e.g. 4-session pack" value="${values?.name ?? ''}" />
    ${fieldErr(errors, 'name')}
    <label for="${idPrefix}credits">Number of sessions</label>
    <input id="${idPrefix}credits" name="credits_per_month" type="number" inputmode="numeric" min="${LIMITS.credits.min}" max="${LIMITS.credits.max}" required placeholder="e.g. 4" value="${values?.creditsPerMonth ?? ''}" />
    ${fieldErr(errors, 'credits')}
    <label for="${idPrefix}price_dollars">Price (in dollars, charged once)</label>
    <input id="${idPrefix}price_dollars" name="price_dollars" type="number" inputmode="decimal" min="0.01" max="${LIMITS.priceCents.max / 100}" step="0.01" required placeholder="e.g. 120" value="${values?.priceDollars ?? ''}" />
    ${fieldErr(errors, 'price_dollars')}
    <p class="muted pricing-per-session" aria-live="polite"></p>
    ${fieldErr(errors, '_form')}
    <div class="btn-row">
      <button type="submit">${submitLabel}</button>
      <a class="action ghost" href="${cancelHref}">Cancel</a>
    </div>
  </form>`;
}

function packageMetaLine(p: PackageRow): string {
  const sessions = `${p.credits} ${p.credits === 1 ? 'session' : 'sessions'}`;
  const per = formatPerSessionDollars(p.credits, p.price_cents);
  return `${sessions} · ${formatCoachDollars(p.price_cents)} · ${per} per session · ${packageExpiryLabel(p.expires_days)}`;
}

function planMetaLine(p: PlanRow): string {
  const sessions = `${p.credits_per_month} ${p.credits_per_month === 1 ? 'session' : 'sessions'}`;
  const per = formatPerSessionDollars(p.credits_per_month, p.price_cents);
  return `${sessions} · ${formatCoachDollars(p.price_cents)} · ${per} per session · Sessions do not expire`;
}

function renderPolicySection(policy: BookingPolicy, contactChannel: ClientContactChannel, state: PricingViewState): SafeHtml {
  const hours = policy.cancelWindowHours;
  const window =
    hours === 0 ? 'up to the start' : `more than ${hours} ${hours === 1 ? 'hour' : 'hours'} before a session`;
  const children = policy.childrenPerBooking;
  const late =
    hours === 0
      ? ''
      : ` If they cancel inside ${hours} ${hours === 1 ? 'hour' : 'hours'}, it counts as a no-show (you can still give the credit back on the session screen).`;
  const inTimePaid =
    policy.cancelGives === 'refund'
      ? 'A paid drop-in is refunded to their card.'
      : 'A paid drop-in becomes a session credit.';
  const editing = state.openPolicyEdit || Boolean(state.policyError);
  return html`<h2 id="policy">Booking policy</h2>
    ${state.policySaved ? html`<p class="card" style="border-color:var(--ok)"><strong>Policy saved.</strong></p>` : raw('')}
    <div class="card policy">
      <ul>
        <li><strong>If a child does not show up:</strong> the session credit or payment for that booking is used. You can give it back from the session screen.</li>
        <li><strong>If a client cancels in time:</strong> they must cancel ${window}. Their session credit comes back. ${inTimePaid}${late}</li>
        <li><strong>Children per booking:</strong> a client can book up to ${children} ${children === 1 ? 'child' : 'children'} at once. Each child takes a spot and uses one credit or one drop-in payment.</li>
        <li><strong>Refunds to a card:</strong> you can refund a whole payment from Payments or a session's screen.</li>
      </ul>
      <details class="policy-edit"${editing ? raw(' open') : raw('')}>
        <summary class="action ghost">Edit policy</summary>
        <form method="post" action="/app/pricing/policy">
          <label for="cancel_window_hours">Hours before a session (cancellation window)</label>
          <input id="cancel_window_hours" name="cancel_window_hours" type="number" inputmode="numeric" min="0" max="${MAX_CANCEL_WINDOW_HOURS}" required value="${hours}" />
          <label for="children_per_booking">Children per booking</label>
          <input id="children_per_booking" name="children_per_booking" type="number" inputmode="numeric" min="1" max="${MAX_CHILDREN_PER_BOOKING}" required value="${children}" />
          ${cancelGivesField(policy)}
          <label for="client_contact_channel">How clients reach you with a question</label>
          <select id="client_contact_channel" name="client_contact_channel">
            ${CONTACT_CHANNEL_OPTIONS.map(([value, label]) =>
              value === contactChannel
                ? html`<option value="${value}" selected>${label}</option>`
                : html`<option value="${value}">${label}</option>`,
            )}
          </select>
          <p class="muted">Your email and phone stay private until a client sends a message.</p>
          <div class="btn-row">
            <button type="submit">Save policy</button>
            <a class="action ghost" href="/app/pricing#policy">Cancel</a>
          </div>
        </form>
        ${state.policyError ? html`<p class="error">${state.policyError}</p>` : raw('')}
      </details>
    </div>`;
}

async function renderPricingPage(coachId: number, state: PricingViewState = {}): Promise<string> {
  const db = getDb();
  const packagesList = await getPackagesForCoach(db, coachId);
  const plansList = await getPlansForCoach(db, coachId);
  const policy = await getBookingPolicy(db, coachId);
  const contactChannel = await getClientContactChannel(db, coachId);

  const packageCards = packagesList.map((p) => {
    const editing = state.openEditPackageId === p.id;
    const editValues: PackageFormValues =
      editing && state.packageEdit?.typeId === p.id
        ? state.packageEdit.values
        : {
            name: p.name,
            credits: p.credits,
            priceDollars: String(p.price_cents / 100),
            expiresDays: packageExpirySelectValue(p.expires_days),
          };
    const editErrors = editing && state.packageEdit ? state.packageEdit.errors : undefined;
    return html`<div class="card">
      <strong>${p.name}</strong>
      <div class="meta"><span>${packageMetaLine(p)}</span></div>
      <div class="btn-row type-card-actions">
        <details class="pricing-edit"${editing ? raw(' open') : raw('')}>
          <summary class="action ghost">Edit</summary>
          ${renderPackageForm(
            `/app/pricing/package/${p.id}/edit`,
            'Save changes',
            `pkg-edit-${p.id}-`,
            editValues,
            editErrors,
          )}
        </details>
      </div>
      <details>
        <summary class="ghost" style="margin-top:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.9rem;color:var(--alert);cursor:pointer;">Delete</summary>
        <p class="muted">Remove ${p.name}? Clients who already bought it keep their credits.</p>
        <form method="post" action="/app/pricing/package/${p.id}/delete">
          <button type="submit" class="ghost">Yes, remove this package</button>
        </form>
      </details>
    </div>`;
  });

  const planCards = plansList.map((p) => {
    const editing = state.openEditPlanId === p.id;
    const editValues: PlanFormValues =
      editing && state.planEdit?.typeId === p.id
        ? state.planEdit.values
        : {
            name: p.name,
            creditsPerMonth: p.credits_per_month,
            priceDollars: String(p.price_cents / 100),
          };
    const editErrors = editing && state.planEdit ? state.planEdit.errors : undefined;
    return html`<div class="card">
      <strong>${p.name}</strong>
      <div class="meta"><span>${planMetaLine(p)}</span></div>
      <div class="btn-row type-card-actions">
        <details class="pricing-edit"${editing ? raw(' open') : raw('')}>
          <summary class="action ghost">Edit</summary>
          ${renderPlanForm(`/app/pricing/plan/${p.id}/edit`, 'Save changes', `plan-edit-${p.id}-`, editValues, editErrors)}
        </details>
      </div>
      <details>
        <summary class="ghost" style="margin-top:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:0.9rem;color:var(--alert);cursor:pointer;">Delete</summary>
        <p class="muted">Remove ${p.name}? Clients who already bought it keep their credits.</p>
        <form method="post" action="/app/pricing/plan/${p.id}/delete">
          <button type="submit" class="ghost">Yes, remove this pack</button>
        </form>
      </details>
    </div>`;
  });

  return page(
    'Pricing',
    html`${coachHeader('pricing')}
      <h1>Pricing & credits</h1>
      <p class="muted">${SESSION_CREDITS_EXPLANATION}</p>
      <h2>Session packages</h2>
      <p class="muted">Prepaid sessions clients buy up front. You can set credits to expire after a set number of days.</p>
      ${packagesList.length === 0 ? html`<p class="muted">No packages yet.</p>` : packageCards}
      <details class="pricing-create"${state.openCreatePackage ? raw(' open') : raw('')}>
        <summary>+ New package</summary>
        ${renderPackageForm(
          '/app/pricing/package',
          'Create package',
          'pkg-create-',
          state.packageCreate?.values,
          state.packageCreate?.errors,
        )}
      </details>

      <h2>One-time packs</h2>
      <p class="muted">Charged once when a client buys. Session credits from the pack never expire.</p>
      ${plansList.length === 0 ? html`<p class="muted">No one-time packs yet.</p>` : planCards}
      <details class="pricing-create"${state.openCreatePlan ? raw(' open') : raw('')}>
        <summary>+ New one-time pack</summary>
        ${renderPlanForm(
          '/app/pricing/plan',
          'Create pack',
          'plan-create-',
          state.planCreate?.values,
          state.planCreate?.errors,
        )}
      </details>
      ${renderPolicySection(policy, contactChannel, state)}
      ${PRICING_PER_SESSION_SCRIPT}`,
  );
}

async function sendPricing(res: Response, coachId: number, status: number, state: PricingViewState = {}): Promise<void> {
  res.status(status).send(await renderPricingPage(coachId, state));
}

export function registerPricingRoutes(router: Router, requireAuth: (req: Request, res: Response, next: () => void) => void): void {
  router.get('/app/pricing', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const state: PricingViewState = {};
    if (req.query.policy === 'saved') state.policySaved = true;
    if (req.query.edit_policy === '1') state.openPolicyEdit = true;
    await sendPricing(res, coachId, 200, state);
  });

  router.post('/app/pricing/policy', requireAuth, async (req, res) => {
    const db = getDb();
    const coachId = res.locals.coachId as number;
    const parsed = parseBookingPolicy(
      bodyField(req.body, 'cancel_window_hours'),
      bodyField(req.body, 'children_per_booking'),
      bodyField(req.body, 'cancel_gives'),
    );
    const channelRaw = bodyField(req.body, 'client_contact_channel');
    let channel = parseClientContactChannel(channelRaw);
    if (!channel && channelRaw === '') {
      channel = await getClientContactChannel(db, coachId);
    }
    if (!parsed || !channel) {
      await sendPricing(res, coachId, 422, {
        openPolicyEdit: true,
        policyError: `Use a window of 0 to ${MAX_CANCEL_WINDOW_HOURS} hours and 1 to ${MAX_CHILDREN_PER_BOOKING} children.`,
      });
      return;
    }
    await setBookingPolicy(db, coachId, parsed);
    await setClientContactChannel(db, coachId, channel);
    res.redirect(303, '/app/pricing?policy=saved#policy');
  });

  router.post('/app/pricing/package', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const db = getDb();
    const read = readPackageBody(req.body as Record<string, unknown>);
    if (!read.fields) {
      await sendPricing(res, coachId, 422, { openCreatePackage: true, packageCreate: read });
      return;
    }
    const dup = await findActivePackageDuplicate(db, coachId, {
      name: read.fields.name,
      credits: read.fields.credits,
      priceCents: read.fields.priceCents,
    });
    if (dup !== null) {
      await sendPricing(res, coachId, 422, {
        openCreatePackage: true,
        packageCreate: { values: read.values, errors: { _form: DUPLICATE_PACKAGE_MSG } },
      });
      return;
    }
    await createPackage(db, coachId, read.fields.name, read.fields.credits, read.fields.priceCents, read.fields.expiresDays ?? undefined);
    res.redirect(303, '/app/pricing');
  });

  router.post('/app/pricing/plan', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const db = getDb();
    const read = readPlanBody(req.body as Record<string, unknown>);
    if (!read.fields) {
      await sendPricing(res, coachId, 422, { openCreatePlan: true, planCreate: read });
      return;
    }
    const dup = await findActivePlanDuplicate(db, coachId, {
      name: read.fields.name,
      creditsPerMonth: read.fields.creditsPerMonth,
      priceCents: read.fields.priceCents,
    });
    if (dup !== null) {
      await sendPricing(res, coachId, 422, {
        openCreatePlan: true,
        planCreate: { values: read.values, errors: { _form: DUPLICATE_PLAN_MSG } },
      });
      return;
    }
    await createPlan(db, coachId, read.fields.name, read.fields.priceCents, read.fields.creditsPerMonth);
    res.redirect(303, '/app/pricing');
  });

  router.post('/app/pricing/package/:id/edit', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const packageId = rowId(req.params.id);
    if (!packageId) {
      res.status(404).send('Not found');
      return;
    }
    const db = getDb();
    const existing = await getPackageById(db, coachId, packageId);
    if (!existing) {
      res.status(404).send('Not found');
      return;
    }
    const read = readPackageBody(req.body as Record<string, unknown>);
    if (!read.fields) {
      await sendPricing(res, coachId, 422, {
        openEditPackageId: packageId,
        packageEdit: { typeId: packageId, values: read.values, errors: read.errors },
      });
      return;
    }
    const dup = await findActivePackageDuplicate(db, coachId, {
      name: read.fields.name,
      credits: read.fields.credits,
      priceCents: read.fields.priceCents,
      excludeId: packageId,
    });
    if (dup !== null) {
      await sendPricing(res, coachId, 422, {
        openEditPackageId: packageId,
        packageEdit: { typeId: packageId, values: read.values, errors: { _form: DUPLICATE_PACKAGE_MSG } },
      });
      return;
    }
    await updatePackage(db, coachId, packageId, read.fields.name, read.fields.credits, read.fields.priceCents, read.fields.expiresDays);
    res.redirect(303, '/app/pricing');
  });

  router.post('/app/pricing/plan/:id/edit', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const planId = rowId(req.params.id);
    if (!planId) {
      res.status(404).send('Not found');
      return;
    }
    const db = getDb();
    const existing = await getPlanById(db, coachId, planId);
    if (!existing) {
      res.status(404).send('Not found');
      return;
    }
    const read = readPlanBody(req.body as Record<string, unknown>);
    if (!read.fields) {
      await sendPricing(res, coachId, 422, {
        openEditPlanId: planId,
        planEdit: { typeId: planId, values: read.values, errors: read.errors },
      });
      return;
    }
    const dup = await findActivePlanDuplicate(db, coachId, {
      name: read.fields.name,
      creditsPerMonth: read.fields.creditsPerMonth,
      priceCents: read.fields.priceCents,
      excludeId: planId,
    });
    if (dup !== null) {
      await sendPricing(res, coachId, 422, {
        openEditPlanId: planId,
        planEdit: { typeId: planId, values: read.values, errors: { _form: DUPLICATE_PLAN_MSG } },
      });
      return;
    }
    await updatePlan(db, coachId, planId, read.fields.name, read.fields.priceCents, read.fields.creditsPerMonth);
    res.redirect(303, '/app/pricing');
  });

  router.post('/app/pricing/package/:id/delete', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const packageId = rowId(req.params.id);
    if (!packageId || !(await retirePackage(getDb(), coachId, packageId))) {
      res.status(404).send('Not found');
      return;
    }
    res.redirect(303, '/app/pricing');
  });

  router.post('/app/pricing/plan/:id/delete', requireAuth, async (req, res) => {
    const coachId = res.locals.coachId as number;
    const planId = rowId(req.params.id);
    if (!planId || !(await retirePlan(getDb(), coachId, planId))) {
      res.status(404).send('Not found');
      return;
    }
    res.redirect(303, '/app/pricing');
  });
}