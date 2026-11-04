import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { postCheckout } from './helpers/booking.js';
import { segmentCount } from '../src/domain/outbound.js';
import { coachCookie, getPage, payFor, postForm, readable, refundRow, refundTexts } from './helpers/refunds.js';

/** The parent hears about a refund once: by text only with their consent,
 * by email only to an address they typed, in short neutral words. */

test('the parent is told of the refund by text with consent and by email they gave, in one short segment', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const bookingId = await payFor(base, db, {
        handle: seed.coach.handle,
        sessionId: seed.sessionId,
        paymentId: 'ns_pay_told',
        amountCents: 3500,
        extra: { contact_email: 'parent@example.com' },
      });
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, await coachCookie(db, seed.coach.id));
      const token = (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
      const manage = readable(await (await fetch(`${base}/booking/${token}`)).text());
      assert.match(manage, /Refunded\. The payment went back to your card\./);
      assert.doesNotMatch(manage, /Cancel this booking/);
    });
    const [text] = refundTexts(relay);
    assert.ok(text, 'a refund text');
    assert.match(text.body, /^Coachatron: Jamie Coach refunded \$35 for Alex's Goalkeeper Group \w{3} \w{3} \d{1,2}\. https:\/\//);
    assert.ok(segmentCount(text.body) === 1, text.body);
    const mail = relay.emails.filter((e) => e.to === 'parent@example.com' && /^Refund from/.test(e.subject));
    assert.equal(mail.length, 1);
    assert.equal(mail[0].subject, 'Refund from Jamie Coach: $35');
    assert.match(mail[0].text, /That booking is cancelled\. Your bank may take a few days to show the refund\./);
    assert.equal((await refundRow(db, 'ns_pay_told')).parent_told, 'text+email');
  });
});

test('a parent who chose no texts and gave no email is not contacted, and the coach is asked to tell them', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 3, priceCents: 3500 });
    await withServer(async (base) => {
      const b = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Alex', contact_phone: '5551112222' }),
        redirect: 'manual',
      });
      const key = /\/checkout\/([^/?#]+)/.exec(b.headers.get('location') ?? '')?.[1];
      assert.ok(key);
      const pay = await postCheckout(base, seed.coach.handle, key, { mode: 'dropin' });
      await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 3500, paymentId: 'ns_pay_quiet' });
      const bookingId = (await db.query<{ id: number }>("select id from booking where charge_id = 'ns_pay_quiet'")).rows[0].id;
      const cookie = await coachCookie(db, seed.coach.id);
      await postForm(base, `/app/sessions/${seed.sessionId}/bookings/${bookingId}/refund`, cookie);
      assert.match(await getPage(base, '/app/money', cookie), /The parent could not be told: please let them know\./);
    });
    assert.equal(refundTexts(relay).length, 0);
    assert.equal(relay.emails.filter((e) => /^Refund from/.test(e.subject)).length, 0);
    assert.equal((await refundRow(db, 'ns_pay_quiet')).parent_told, 'none');
  });
});

