import type { DbClient } from '../db/client.js';

/** Keeps when a payment was made, as the store's paid event says, once per
 * payment (`payment_receipt`). The first time kept stays: a second event for
 * the same payment changes nothing. The payments download reads it.
 *
 * It never throws: the time is for the coach's records, and failing to keep
 * it must not stop the payment from booking. A payment with no time kept is
 * listed at the time its booking was made. */
export async function recordPaidAt(db: DbClient, paymentRef: string, paidAt: Date): Promise<void> {
  try {
    await db.query('insert into payment_receipt (payment_ref, paid_at) values ($1, $2) on conflict (payment_ref) do nothing', [
      paymentRef,
      paidAt.toISOString(),
    ]);
  } catch (err) {
    console.error('payment-receipt: the paid time was not kept:', err instanceof Error ? err.message : err);
  }
}
