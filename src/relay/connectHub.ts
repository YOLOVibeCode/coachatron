import { APP_FEE_BPS } from '../config.js';

export interface ChargeRequest {
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

export async function charge(req: ChargeRequest): Promise<ChargeResult> {
  const base = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
  const res = await fetch(`${base}/connect/coachatron/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': req.idempotencyKey,
    },
    body: JSON.stringify({
      amountCents: req.amountCents,
      sourceId: req.sourceId,
      note: req.note,
      appFeeBps: APP_FEE_BPS,
    }),
  });
  if (!res.ok) throw new Error(`connect hub charge failed: ${res.status}`);
  return (await res.json()) as ChargeResult;
}

export interface SubscribeRequest {
  idempotencyKey: string;
  priceCents: number;
  contactPhone: string;
  planName: string;
}

export interface SubscribeResult {
  id: string;
  status: 'ACTIVE' | 'FAILED';
}

export async function subscribe(req: SubscribeRequest): Promise<SubscribeResult> {
  const base = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
  const res = await fetch(`${base}/connect/coachatron/subscriptions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': req.idempotencyKey,
    },
    body: JSON.stringify({
      priceCents: req.priceCents,
      contactPhone: req.contactPhone,
      planName: req.planName,
      appFeeBps: APP_FEE_BPS,
    }),
  });
  if (!res.ok) throw new Error(`connect hub subscribe failed: ${res.status}`);
  return (await res.json()) as SubscribeResult;
}
