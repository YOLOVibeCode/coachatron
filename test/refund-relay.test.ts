import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRelay } from './helpers/relay.js';
import { refundSellerPayment, SellerError } from '../src/relay/seller.js';

/** The relay's seller refund route, as Coachatron calls it: a whole refund
 * names the payment and an idempotency key and sends no amount; the same key
 * is the same refund, and a payment cannot be refunded twice. */

test('the refund call names the payment and a key, and the same key is the same refund', async () => {
  await withRelay(async (relay) => {
    const first = await refundSellerPayment('jamie', { paymentRef: 'ns_pay_one', idempotencyKey: 'k1' });
    const again = await refundSellerPayment('jamie', { paymentRef: 'ns_pay_one', idempotencyKey: 'k1' });
    assert.equal(first.status, 'succeeded');
    assert.ok(first.refundRef);
    assert.equal(again.refundRef, first.refundRef);
    assert.equal(relay.refunds.length, 1);
    assert.deepEqual(
      { product: relay.refunds[0].product, sellerKey: relay.refunds[0].sellerKey, paymentRef: relay.refunds[0].paymentRef, amountCents: relay.refunds[0].amountCents },
      { product: 'coachatron', sellerKey: 'jamie', paymentRef: 'ns_pay_one', amountCents: null },
      'a whole refund sends no amount',
    );
    await assert.rejects(
      refundSellerPayment('jamie', { paymentRef: 'ns_pay_one', idempotencyKey: 'k2' }),
      (err: unknown) => err instanceof SellerError && err.status === 422 && err.code === 'REFUND_EXCEEDS_PAYMENT',
    );
    const part = await refundSellerPayment('jamie', { paymentRef: 'ns_pay_two', idempotencyKey: 'k3', amountCents: 500 });
    assert.equal(part.amountCents, 500, 'the contract also takes an amount');
  });
});

