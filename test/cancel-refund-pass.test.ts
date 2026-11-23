import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { coachCookie, getPage, postForm } from './helpers/refunds.js';
import {
  cancelBooking,
  cancelBy,
  coachChooses,
  creditOf,
  managePage,
  refundEmails,
  refundOf,
  sessionInHours,
  startsInHours,
} from './helpers/cancel-refund.js';
import { getCreditTotal } from '../src/domain/pricing.js';
import type { DbClient } from '../src/db/client.js';

/** Several children on one payment (a booking pass, SPEC.md §9.5) under the
 * coach's "a refund to their card". A refund is of the whole payment
 * (SPEC.md §9.4), so a child's cancel in time gives one only when it leaves
 * no other child's booking standing on that payment, and nothing the
 * payment bought was used. Otherwise it gives a session credit, as before,
 * and the manage page says so before the parent confirms. */

const PHONE = '+15551115555';
const EMAIL = 'two@example.com';

interface Child {
  id: number;
  athlete_name: string;
  status: string;
  manage_token: string;
}

async function children(db: DbClient, paymentId: string): Promise<Child[]> {
  const r = await db.query<Child>('select id, athlete_name, status, manage_token from booking where charge_id = $1 order by id', [paymentId]);
  return r.rows;
}

/** Mia and Leo, booked in one pass three days out and paid for with one
 * payment, by a coach who chose "a refund to their card". */
async function payForTwo(base: string, db: DbClient, paymentId: string) {
  const seed = await seedCoachWithSession(db, { capacity: 4, priceCents: 3500 });
  await startsInHours(db, seed.sessionId, 72);
  await coachChooses(db, seed.coach.id, 'refund');
  const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', PHONE, { athlete_name_2: 'Leo', contact_email: EMAIL });
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, seed.coach.handle, b.key, { mode: 'dropin' });
  assert.equal(pay.status, 303);
  const paid = await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 7000, paymentId });
  assert.equal(paid.status, 200);
  const [mia, leo] = await children(db, paymentId);
  assert.deepEqual([mia.athlete_name, mia.status, leo.athlete_name, leo.status], ['Mia', 'booked', 'Leo', 'booked']);
  return { seed, mia, leo };
}

function refundTexts(sms: Array<{ to: string; body: string }>) {
  return sms.filter((m) => m.to === PHONE && /refunded/.test(m.body));
}

test('with two children on one payment, the first cancel gives a credit and says so; the last one refunds the whole payment', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, mia, leo } = await payForTwo(base, db, 'ch_two_cancel');
      const by = await cancelBy(db, seed.sessionId);

      // Leo first: Mia still stands on the payment, so this is a credit.
      const leoPage = await managePage(base, leo.manage_token);
      assert.ok(
        leoPage.includes(
          `Cancel by ${by} for a session credit with Jamie Coach. This payment also paid for Mia, who is still booked, and a refund to your card is of the whole payment: it is made if that booking is cancelled in time too, while this credit is unused.`,
        ),
        'the page says a credit, and why, before the parent confirms',
      );
      assert.doesNotMatch(leoPage, /goes back to the card you paid with/);
      assert.equal(await cancelBooking(base, leo.manage_token), 303);
      assert.equal(relay.refundCalls, 0, 'no refund while the other child is booked');
      assert.deepEqual(await creditOf(db, leo.id), { remaining: 1, held: false, withdrawn: false });
      assert.equal(await getCreditTotal(db, seed.coach.id, PHONE), 1);
      assert.match(await managePage(base, leo.manage_token), /Your session credit with Jamie Coach is back\./);
      assert.equal(await refundOf(db, 'ch_two_cancel'), null);

      // Mia last: nothing else stands, so the whole payment goes back, and
      // the credit Leo's cancel left goes with it.
      const miaPage = await managePage(base, mia.manage_token);
      assert.ok(
        miaPage.includes(
          `Cancel by ${by} for a refund to your card: $70, the whole payment for Mia and Leo, goes back to the card you paid with. The session credit from the booking already cancelled is withdrawn with it.`,
        ),
        'the amount, who it was for, and where it goes',
      );
      assert.equal(await cancelBooking(base, mia.manage_token), 303);
      assert.equal(relay.refundCalls, 1);
      assert.equal(relay.refunds[0].paymentRef, 'ch_two_cancel');
      assert.equal(relay.refunds[0].amountCents, null, 'the whole payment');
      assert.deepEqual((await children(db, 'ch_two_cancel')).map((c) => c.status), ['refunded', 'refunded']);
      assert.deepEqual(await creditOf(db, leo.id), { remaining: 0, held: true, withdrawn: true });
      assert.deepEqual(await creditOf(db, mia.id), { remaining: 0, held: true, withdrawn: true });
      assert.equal(await getCreditTotal(db, seed.coach.id, PHONE), 0);
      assert.match(await managePage(base, leo.manage_token), /Refunded\. The payment went back to your card\./);

      const row = await refundOf(db, 'ch_two_cancel');
      assert.deepEqual(
        { status: row?.status, amount: row?.amount_cents, who: row?.athlete_name, withdrawn: row?.credits_withdrawn, by: row?.cancel_booking_id },
        { status: 'refunded', amount: 7000, who: 'Mia and Leo', withdrawn: 1, by: mia.id },
      );
      const money = await getPage(base, '/app/payments', await coachCookie(db, seed.coach.id));
      assert.match(money, /Mia and Leo<\/strong> · \$70 · Refunded \(client cancelled in time\)/);
      assert.match(money, /1 unused session credit was withdrawn\./);
    });
    const texts = refundTexts(relay.sms);
    assert.equal(texts.length, 1, 'one notice for the one payment');
    assert.match(texts[0].body, /refunded \$70 for Mia and Leo's/);
    const mail = refundEmails(relay, EMAIL);
    assert.equal(mail.length, 1);
    assert.match(mail[0].text, /The 1 unused session credit from this payment was removed\./, "the credit Leo's cancel left, which the parent held");
  });
});

test("once the first child's credit was used, the last child's cancel gives a credit too", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, mia, leo } = await payForTwo(base, db, 'ch_two_used');
      assert.equal(await cancelBooking(base, leo.manage_token), 303);

      // The parent books another session with the credit Leo's cancel left.
      const later = await sessionInHours(db, seed.sessionTypeId, 120);
      const b = await bookOnline(base, seed.coach.handle, later, 'Sam', PHONE);
      assert.ok(b.key);
      await db.query('update booking set phone_verified_at = now() where checkout_token = $1', [b.key]);
      assert.equal((await postCheckout(base, seed.coach.handle, b.key, { mode: 'credit' })).status, 303);
      assert.equal((await creditOf(db, leo.id))?.remaining, 0);

      const miaPage = await managePage(base, mia.manage_token);
      assert.match(
        miaPage,
        /Cancel by .+ for a session credit with Jamie Coach\. A session this payment bought was already used, so it cannot go back to your card whole\./,
      );
      assert.equal(await cancelBooking(base, mia.manage_token), 303);
      assert.equal(relay.refundCalls, 0);
      assert.deepEqual((await children(db, 'ch_two_used')).map((c) => c.status), ['cancelled', 'cancelled']);
      assert.deepEqual(await creditOf(db, mia.id), { remaining: 1, held: false, withdrawn: false });
      assert.match(await managePage(base, mia.manage_token), /Your session credit with Jamie Coach is back\./);
      assert.equal(await refundOf(db, 'ch_two_used'), null);
    });
  });
});

test("a child cancelled late used that session, so the other child's cancel in time gives a credit", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { seed, mia, leo } = await payForTwo(base, db, 'ch_two_late');
      // Leo is cancelled inside the coach's window, which the coach shortens afterwards.
      await db.query('update coach set cancel_window_hours = 96 where id = $1', [seed.coach.id]);
      assert.equal(await cancelBooking(base, leo.manage_token), 303);
      const late = await db.query<{ status: string; late_cancel: boolean }>('select status, late_cancel from booking where id = $1', [leo.id]);
      assert.deepEqual(late.rows[0], { status: 'cancelled', late_cancel: true });
      await db.query('update coach set cancel_window_hours = 24 where id = $1', [seed.coach.id]);

      assert.match(await managePage(base, mia.manage_token), /A session this payment bought was already used, so it cannot go back to your card whole\./);
      assert.equal(await cancelBooking(base, mia.manage_token), 303);
      assert.equal(relay.refundCalls, 0, "Leo's share was used, so the payment is not sent back whole");
      assert.deepEqual(await creditOf(db, mia.id), { remaining: 1, held: false, withdrawn: false });

      // The coach can still choose to refund the whole payment (SPEC.md §9.4).
      const cookie = await coachCookie(db, seed.coach.id);
      const done = await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${mia.id}/refund`, cookie);
      assert.equal(done.headers.get('location'), `/app/sessions/${seed.sessionId}?notice=refund-refunded`);
      assert.equal(relay.refunds.length, 1);
      assert.equal((await refundOf(db, 'ch_two_late'))?.cancel_booking_id, null, "the coach's own refund");
    });
  });
});

test('two children cancelled at the same moment never make two refunds, and no credit is left beside a refund', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await withServer(async (base) => {
      const { mia, leo } = await payForTwo(base, db, 'ch_two_quick');
      // Two taps arrive together. Each is decided under the payment's locks:
      // whichever is first gives a credit, and the other refunds the payment
      // or, when it too saw a child standing, gives a credit as well.
      const [a, b] = await Promise.all([cancelBooking(base, mia.manage_token), cancelBooking(base, leo.manage_token)]);
      assert.deepEqual([a, b], [303, 303]);
      assert.ok(relay.refundCalls <= 1, 'never two refunds of one payment');
      const now = (await children(db, 'ch_two_quick')).map((c) => c.status);
      assert.ok(
        JSON.stringify(now) === JSON.stringify(['refunded', 'refunded']) || JSON.stringify(now) === JSON.stringify(['cancelled', 'cancelled']),
        `both refunded, or both a credit: ${now.join(', ')}`,
      );
      const [miaCredit, leoCredit] = [await creditOf(db, mia.id), await creditOf(db, leo.id)];
      if (relay.refundCalls === 1) {
        assert.deepEqual([miaCredit?.withdrawn, leoCredit?.withdrawn], [true, true], 'refunded: no credit is left');
      } else {
        assert.deepEqual([miaCredit, leoCredit], [
          { remaining: 1, held: false, withdrawn: false },
          { remaining: 1, held: false, withdrawn: false },
        ]);
      }
    });
  });
});
