import { APP_FEE_BPS } from '../config.js';
import { relayFetch } from './http.js';

const PRODUCT = 'coachatron';

function recipientPath(recipientKey: string, suffix: string): string {
  return `/connect/${PRODUCT}/recipients/${encodeURIComponent(recipientKey)}${suffix}`;
}

export interface FrontendConfig {
  applicationId: string;
  locationId: string;
  scriptUrl: string;
}

export async function getFrontendConfig(recipientKey: string): Promise<FrontendConfig> {
  const res = await relayFetch(recipientPath(recipientKey, '/frontend-config'));
  if (!res.ok) throw new Error(`connect hub frontend-config failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const applicationId = String(body.application_id ?? body.applicationId ?? '');
  const locationId = String(body.location_id ?? body.locationId ?? '');
  const scriptUrl = String(
    body.script_url ?? body.scriptUrl ?? 'https://sandbox.web.squarecdn.com/v1/square.js',
  );
  if (!applicationId || !locationId) {
    throw new Error('connect hub frontend-config missing application or location id');
  }
  return { applicationId, locationId, scriptUrl };
}

export interface ChargeRequest {
  recipientKey: string;
  idempotencyKey: string;
  amountCents: number;
  sourceId: string;
  note: string;
}

export interface ChargeResult {
  id: string;
  status: 'COMPLETED' | 'FAILED';
  amountCents: number;
  appFeeCents: number;
}

function mapChargeResult(body: Record<string, unknown>): ChargeResult {
  return {
    id: String(body.id ?? body.charge_id ?? ''),
    status: (body.status === 'FAILED' ? 'FAILED' : 'COMPLETED') as ChargeResult['status'],
    amountCents: Number(body.amount_cents ?? body.amountCents ?? 0),
    appFeeCents: Number(body.app_fee_cents ?? body.appFeeCents ?? 0),
  };
}

export async function charge(req: ChargeRequest): Promise<ChargeResult> {
  const res = await relayFetch(recipientPath(req.recipientKey, '/charge'), {
    method: 'POST',
    body: JSON.stringify({
      source_id: req.sourceId,
      amount_cents: req.amountCents,
      idempotency_key: req.idempotencyKey,
      note: req.note,
      app_fee_bps: APP_FEE_BPS,
    }),
  });
  if (!res.ok) throw new Error(`connect hub charge failed: ${res.status}`);
  return mapChargeResult((await res.json()) as Record<string, unknown>);
}

interface CatalogPlanResult {
  planVariationId: string;
}

async function ensureCatalogPlan(
  recipientKey: string,
  planName: string,
  priceCents: number,
  idempotencyKey: string,
): Promise<CatalogPlanResult> {
  const res = await relayFetch(recipientPath(recipientKey, '/plans'), {
    method: 'POST',
    body: JSON.stringify({
      name: planName,
      price_cents: priceCents,
      cadence: 'MONTHLY',
      idempotency_key: idempotencyKey,
    }),
  });
  if (!res.ok) throw new Error(`connect hub plan failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const planVariationId = String(
    body.plan_variation_id ?? body.planVariationId ?? body.variation_id ?? body.id ?? '',
  );
  if (!planVariationId) throw new Error('connect hub plan missing variation id');
  return { planVariationId };
}

async function createCustomer(
  recipientKey: string,
  contactPhone: string,
  idempotencyKey: string,
): Promise<string> {
  const res = await relayFetch(recipientPath(recipientKey, '/customers'), {
    method: 'POST',
    body: JSON.stringify({
      phone: contactPhone,
      idempotency_key: `${idempotencyKey}:customer`,
    }),
  });
  if (!res.ok) throw new Error(`connect hub customer failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const customerId = String(body.customer_id ?? body.customerId ?? body.id ?? '');
  if (!customerId) throw new Error('connect hub customer missing id');
  return customerId;
}

async function storeCardOnFile(
  recipientKey: string,
  customerId: string,
  sourceId: string,
  idempotencyKey: string,
): Promise<string> {
  const res = await relayFetch(
    recipientPath(recipientKey, `/customers/${encodeURIComponent(customerId)}/cards`),
    {
      method: 'POST',
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: `${idempotencyKey}:card`,
      }),
    },
  );
  if (!res.ok) throw new Error(`connect hub card failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const cardId = String(body.card_id ?? body.cardId ?? body.id ?? '');
  if (!cardId) throw new Error('connect hub card missing id');
  return cardId;
}

export interface SubscribeRequest {
  recipientKey: string;
  idempotencyKey: string;
  priceCents: number;
  contactPhone: string;
  planName: string;
  sourceId: string;
}

export interface SubscribeResult {
  id: string;
  status: 'ACTIVE' | 'FAILED';
}

export async function subscribe(req: SubscribeRequest): Promise<SubscribeResult> {
  const { planVariationId } = await ensureCatalogPlan(
    req.recipientKey,
    req.planName,
    req.priceCents,
    req.idempotencyKey,
  );
  const customerId = await createCustomer(req.recipientKey, req.contactPhone, req.idempotencyKey);
  const cardId = await storeCardOnFile(req.recipientKey, customerId, req.sourceId, req.idempotencyKey);

  const res = await relayFetch(recipientPath(req.recipientKey, '/subscriptions'), {
    method: 'POST',
    body: JSON.stringify({
      plan_variation_id: planVariationId,
      customer_id: customerId,
      card_id: cardId,
      idempotency_key: req.idempotencyKey,
      app_fee_bps: APP_FEE_BPS,
    }),
  });
  if (!res.ok) throw new Error(`connect hub subscribe failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    id: String(body.id ?? body.subscription_id ?? ''),
    status: body.status === 'FAILED' ? 'FAILED' : 'ACTIVE',
  };
}
