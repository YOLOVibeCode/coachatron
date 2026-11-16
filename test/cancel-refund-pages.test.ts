import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedPackage, seedWaitlistEntry } from './helpers/fixtures.js';
import { bookOnline } from './helpers/booking.js';
import { readable } from './helpers/refunds.js';
import { zoneAt } from './helpers/clock.js';
import { cancelBy, coachChooses, madeUnder, startsInHours } from './helpers/cancel-refund.js';
import { offerOpenSpots } from '../src/domain/waitlist.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import type { DbClient } from '../src/db/client.js';

/** Checkout says, before the parent pays, what cancelling in time gives
 * back (SPEC.md §9.5): "a refund to your card" or "a session credit", by
 * the choice in force when the booking was made, whatever the coach chooses
 * afterwards. */

async function checkoutPage(base: string, handle: string, key: string): Promise<string> {
  const res = await fetch(`${base}/c/${handle}/checkout/${key}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'checkout is never cached');
  return readable(await res.text());
}

async function coachWithSession(db: DbClient, gives: 'credit' | 'refund', hours = 72, priceCents = 3500) {
  const seed = await seedCoachWithSession(db, { capacity: 6, priceCents });
  await startsInHours(db, seed.sessionId, hours);
  await coachChooses(db, seed.coach.id, gives);
  return seed;
}

async function bookingByKey(db: DbClient, key: string): Promise<number> {
  return (await db.query<{ id: number }>('select id from booking where checkout_token = $1', [key])).rows[0].id;
}

test('checkout states the choice the booking was made under, and keeps stating it after the coach switches', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await withServer(async (base) => {
      const seed = await coachWithSession(db, 'refund');
      await seedPackage(db, seed.coach.id, 10, 30000);
      const by = await cancelBy(db, seed.sessionId);

      const first = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '5551116001');
      assert.ok(first.key);
      assert.equal(await madeUnder(db, await bookingByKey(db, first.key)), 'refund');
      const promised = await checkoutPage(base, seed.coach.handle, first.key);
      assert.ok(
        promised.includes(
          `<p class="muted cancel-terms">Cancel by ${by} for a refund to your card. A booking made with a session credit, a package or a pack gets its credit back instead.</p>`,
        ),
        'a refund, with the cut-off time, before the parent pays',
      );

      // The coach switches. The booking already made keeps what its page
      // said; a booking made now is promised a session credit.
      await coachChooses(db, seed.coach.id, 'credit');
      assert.ok((await checkoutPage(base, seed.coach.handle, first.key)).includes(`Cancel by ${by} for a refund to your card.`));
      const second = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Bo', '5551116002');
      assert.ok(second.key);
      assert.equal(await madeUnder(db, await bookingByKey(db, second.key)), 'credit');
      const credit = await checkoutPage(base, seed.coach.handle, second.key);
      assert.ok(credit.includes(`<p class="muted cancel-terms">Cancel by ${by} for a session credit.</p>`));
      assert.doesNotMatch(credit, /refund to your card/);

      // And back: the next booking is promised a refund again.
      await coachChooses(db, seed.coach.id, 'refund');
      assert.ok((await checkoutPage(base, seed.coach.handle, second.key)).includes(`Cancel by ${by} for a session credit.`));
    });
  });
});

test('checkout for several children says they are refunded together', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await withServer(async (base) => {
      const seed = await coachWithSession(db, 'refund');
      const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Mia', '5551116003', { athlete_name_2: 'Leo' });
      assert.ok(b.key);
      const page = await checkoutPage(base, seed.coach.handle, b.key);
      assert.match(
        page,
        /Cancel by .+ for a refund to your card\. Children paid for together are refunded together, once each of their bookings is cancelled; until then a cancelled booking gets a session credit\./,
      );
      const each = await db.query<{ cancel_gives: string }>("select cancel_gives from booking where contact_phone = '+15551116003' order by id");
      assert.deepEqual(each.rows.map((r) => r.cancel_gives), ['refund', 'refund'], 'each child keeps the choice');
    });
  });
});

test('checkout says so when the session is already inside the window, and says nothing for a free session', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await withServer(async (base) => {
      const soon = await coachWithSession(db, 'refund', 5);
      const late = await bookOnline(base, soon.coach.handle, soon.sessionId, 'Alex', '5551116004');
      assert.ok(late.key);
      const inside = await checkoutPage(base, soon.coach.handle, late.key);
      assert.match(inside, /It's less than 24 hours before this session, so cancelling uses the payment or session credit, the same as not showing up\./);
      assert.doesNotMatch(inside, /refund to your card/);

      // A coach with no window: the cut-off is the start.
      const open = await coachWithSession(db, 'refund', 5);
      await db.query('update coach set cancel_window_hours = 0 where id = $1', [open.coach.id]);
      const any = await bookOnline(base, open.coach.handle, open.sessionId, 'Alex', '5551116005');
      assert.ok(any.key);
      assert.match(await checkoutPage(base, open.coach.handle, any.key), /Cancel before it starts for a refund to your card\./);

      const free = await coachWithSession(db, 'refund', 72, 0);
      const gratis = await bookOnline(base, free.coach.handle, free.sessionId, 'Alex', '5551116006');
      assert.ok(gratis.key);
      assert.doesNotMatch(await checkoutPage(base, free.coach.handle, gratis.key), /cancel-terms/);
    });
  });
});

test('a spot offered from the waitlist keeps the choice in force when it was offered', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithSession(db, 'refund');
    // Midday for the coach whenever this runs: offers wait out quiet hours.
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
    await seedWaitlistEntry(db, seed.sessionId, 'Wren', '+15551116007');
    await grantSmsConsent(db, '+15551116007');
    await offerOpenSpots(db, seed.sessionId);
    const held = await db.query<{ id: number; checkout_token: string; cancel_gives: string }>(
      "select id, checkout_token, cancel_gives from booking where contact_phone = '+15551116007'",
    );
    assert.equal(held.rows.length, 1, 'the waitlist was offered the spot');
    assert.equal(held.rows[0].cancel_gives, 'refund');
    await coachChooses(db, seed.coach.id, 'credit');
    await withServer(async (base) => {
      assert.match(await checkoutPage(base, seed.coach.handle, held.rows[0].checkout_token), /Cancel by .+ for a refund to your card\./);
    });
  });
});
