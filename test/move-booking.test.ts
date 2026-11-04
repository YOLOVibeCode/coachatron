import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { zoneAt } from './helpers/clock.js';
import { seedBookedSession, seedCoachWithSession, seedWaitlistEntry, type SeededSession } from './helpers/fixtures.js';
import { bookOnline, countSold, postCheckout } from './helpers/booking.js';
import { buyerFromLocation, postStorePaid } from './helpers/store-event.js';
import { coachCookie, getPage, postForm, readable } from './helpers/refunds.js';
import { grantSmsConsent, revokeConsent } from '../src/domain/sms-consent.js';
import { newBookingToken } from '../src/domain/pricing.js';
import { sendBookingConfirmation } from '../src/domain/bookingMessages.js';
import { moveByParent } from '../src/domain/moveBooking.js';
import { applyRefunded } from '../src/domain/refunds.js';
import type { DbClient } from '../src/db/client.js';

/** A parent moves a booking from its manage page (SPEC.md §7.2) to another
 * upcoming session of the same session type with room, until the coach's
 * cancellation window closes (§9.5). The payment or credit stays as it is,
 * the waitlist keeps its first claim, a payment's children move together,
 * and the coach sees the move on Session detail. */

const PHONE = '+15550008001';

async function sessionAt(
  db: DbClient,
  sessionTypeId: number,
  hours: number,
  opts: { status?: string; capacity?: number } = {},
): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status, capacity_override)
     values ($1, now() + make_interval(mins => $2::int), 'America/Chicago', $3, $4) returning id`,
    [sessionTypeId, Math.round(hours * 60), opts.status ?? 'scheduled', opts.capacity ?? null],
  );
  return r.rows[0].id;
}

/** A coach with one session three days out (`from`) and another of the
 * same type four days out (`to`). */
async function twoSessions(db: DbClient, opts: { capacity?: number; fromHours?: number } = {}): Promise<{ seed: SeededSession; from: number; to: number }> {
  const seed = await seedCoachWithSession(db, { capacity: opts.capacity ?? 4, priceCents: 3500 });
  await db.query('update session set starts_at_utc = now() + make_interval(mins => $2::int) where id = $1', [
    seed.sessionId,
    Math.round((opts.fromHours ?? 72) * 60),
  ]);
  return { seed, from: seed.sessionId, to: await sessionAt(db, seed.sessionTypeId, 96) };
}

/** A manage link of the length the app makes, so a text has the room it has. */
async function manageToken(db: DbClient, id: number): Promise<string> {
  const token = newBookingToken();
  await db.query('update booking set manage_token = $2 where id = $1', [id, token]);
  return token;
}

/** A paid drop-in for one child, with an email on it. */
async function dropIn(db: DbClient, sessionId: number, name = 'Mia', phone = PHONE, chargeId = `ch_${name.toLowerCase()}`) {
  const id = await seedBookedSession(db, sessionId, name, phone);
  await db.query("update booking set gross_cents = 3500, charge_id = $2, contact_email = 'parent@example.com' where id = $1", [id, chargeId]);
  return { id, token: await manageToken(db, id) };
}

async function creditBooking(db: DbClient, coachId: number, sessionId: number, name = 'Mia', remaining = 3) {
  const credit = await db.query<{ id: number }>(
    "insert into credit (coach_id, contact_phone, remaining, source) values ($1, $2, $3, 'test') returning id",
    [coachId, PHONE, remaining],
  );
  const id = await seedBookedSession(db, sessionId, name, PHONE);
  await db.query(
    "update booking set payment_source = 'PackageCredit', credit_id = $2, gross_cents = null, contact_email = 'parent@example.com' where id = $1",
    [id, credit.rows[0].id],
  );
  return { id, creditId: credit.rows[0].id, token: await manageToken(db, id) };
}

async function payment(db: DbClient, id: number) {
  const r = await db.query<{
    session_id: number;
    status: string;
    payment_source: string | null;
    credit_id: number | null;
    charge_id: string | null;
    gross_cents: number | null;
  }>('select session_id, status, payment_source, credit_id, charge_id, gross_cents from booking where id = $1', [id]);
  return r.rows[0];
}

async function remaining(db: DbClient, creditId: number): Promise<number> {
  return (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId])).rows[0].remaining;
}

function move(base: string, token: string, sessionId: number, address?: string): Promise<Response> {
  return fetch(`${base}/booking/${token}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(address ? { 'x-forwarded-for': address } : {}) },
    body: new URLSearchParams({ session_id: String(sessionId) }),
    redirect: 'manual',
  });
}

async function managePage(base: string, token: string): Promise<string> {
  const res = await fetch(`${base}/booking/${token}`);
  assert.equal(res.status, 200);
  return readable(await res.text());
}

function offers(page: string, sessionId: number): boolean {
  return page.includes(`name="session_id" value="${sessionId}"`);
}

test('a paid drop-in moves to another time of the same session: same payment, a confirmation, and the coach sees it', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    await db.query("update session set location_text = 'Field 3' where id = $1", [to]);
    const otherType = await db.query<{ id: number }>(
      "insert into session_type (coach_id, name, duration_min, capacity, price_cents, active) values ($1, 'Field Players', 60, 8, 3500, true) returning id",
      [seed.coach.id],
    );
    const elsewhere = await sessionAt(db, otherType.rows[0].id, 96);
    const cancelled = await sessionAt(db, seed.sessionTypeId, 120, { status: 'cancelled' });
    const past = await sessionAt(db, seed.sessionTypeId, -24);
    const b = await dropIn(db, from);
    // As if the old time's 24-hour reminder had gone.
    await db.query('insert into reminder_sent (booking_id) values ($1)', [b.id]);
    const before = await payment(db, b.id);

    await withServer(async (base) => {
      const page = await managePage(base, b.token);
      assert.match(page, /You can move this booking to another Goalkeeper Group session until /);
      assert.match(page, /Your payment moves with it: nothing more is charged or refunded\./);
      assert.ok(offers(page, to), 'the other time is offered');
      for (const id of [elsewhere, cancelled, past, from]) assert.ok(!offers(page, id), `session ${id} is not offered`);

      const wrong = await move(base, b.token, elsewhere);
      assert.equal(wrong.status, 409, 'another session type is refused');
      assert.equal((await payment(db, b.id)).session_id, from);

      const res = await move(base, b.token, to);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/booking/${b.token}?moved=1`);
      const after = readable(await (await fetch(`${base}/booking/${b.token}?moved=1`)).text());
      assert.match(after, /Moved\. This is Mia's session now\./);
      assert.match(after, /Field 3/);
      assert.equal((await move(base, b.token, to)).status, 303, 'a second tap changes nothing');

      const cookie = await coachCookie(db, seed.coach.id);
      assert.match(await getPage(base, `/app/sessions/${from}`, cookie), /<strong>Mia<\/strong> — <span class="muted">Moved to \w{3}, \w{3} \d{1,2}/);
      assert.match(await getPage(base, `/app/sessions/${to}`, cookie), /Moved here by the parent from \w{3}, \w{3} \d{1,2}/);
    });

    assert.deepEqual(await payment(db, b.id), { ...before, session_id: to });
    assert.equal((await db.query('select id from credit')).rows.length, 0, 'no credit was made');
    assert.equal(relay.refunds.length, 0, 'nothing was refunded');
    const moves = await db.query<{ from_session_id: number; to_session_id: number }>(
      'select from_session_id, to_session_id from booking_move where booking_id = $1',
      [b.id],
    );
    assert.deepEqual(moves.rows, [{ from_session_id: from, to_session_id: to }], 'moved once');
    assert.equal((await db.query('select 1 from reminder_sent where booking_id = $1', [b.id])).rows.length, 0, 'the new time gets its own reminder');

    const texts = relay.sms.filter((m) => m.to === PHONE);
    assert.equal(texts.length, 1);
    assert.match(texts[0].body, /^Coachatron: Mia moved to Goalkeeper Group \w{3} \w{3} \d{1,2} \d{1,2}(:\d{2})?[ap]m, Field 3\. https:\/\//);
    assert.ok(texts[0].body.includes(`/booking/${b.token} `), texts[0].body);
    assert.equal(relay.emails.length, 1);
    assert.match(relay.emails[0].subject, /^Moved: Goalkeeper Group, /);
    assert.match(relay.emails[0].text, /^Mia's Goalkeeper Group with Jamie Coach moved from .+ to .+, Field 3\./);
  });
});

test('a booking paid with a session credit moves with the same credit; a parent without texts is emailed', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    const b = await creditBooking(db, seed.coach.id, from);
    await revokeConsent(db, PHONE);
    await withServer(async (base) => {
      assert.match(await managePage(base, b.token), /The session credit it used moves with it\./);
      assert.equal((await move(base, b.token, to)).status, 303);
      assert.deepEqual(await payment(db, b.id), {
        session_id: to,
        status: 'booked',
        payment_source: 'PackageCredit',
        credit_id: b.creditId,
        charge_id: null,
        gross_cents: null,
      });
      assert.equal(await remaining(db, b.creditId), 3, 'nothing drawn and nothing given back');

      // The moved booking keeps the policy: cancelled in time, the credit comes back.
      assert.equal((await fetch(`${base}/booking/${b.token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
      assert.equal(await remaining(db, b.creditId), 4);
    });
    assert.equal(relay.sms.filter((m) => m.to === PHONE).length, 0, 'no text without consent');
    assert.equal(relay.emails.length, 1);
    assert.match(relay.emails[0].subject, /^Moved: /);
  });
});

test('a session with no room is not offered, and a move into it is refused', async () => {
  const db = await freshDb();
  const { seed, from } = await twoSessions(db);
  const full = await sessionAt(db, seed.sessionTypeId, 96, { capacity: 1 });
  await seedBookedSession(db, full, 'Ada Other', '+15550008099');
  const b = await dropIn(db, from);
  await withServer(async (base) => {
    const page = await managePage(base, b.token);
    assert.ok(!offers(page, full));
    const res = await move(base, b.token, full);
    assert.equal(res.status, 409);
    assert.match(readable(await res.text()), /That session is full/);
  });
  assert.equal((await payment(db, b.id)).session_id, from);
  assert.equal(await countSold(db, full), 1);
});

test("inside the coach's window the page says why it cannot move, and keeps the late cancel", async () => {
  const db = await freshDb();
  const { seed, from, to } = await twoSessions(db, { fromHours: 5 });
  const b = await creditBooking(db, seed.coach.id, from);
  await withServer(async (base) => {
    const page = await managePage(base, b.token);
    assert.match(page, /Bookings can move until 24 hours before the session, so this one can't move now\./);
    assert.ok(!offers(page, to));
    assert.match(page, /cancelling now uses this booking's session credit/);
    assert.ok(page.includes(`action="/booking/${b.token}/cancel"`), 'the cancel stays');

    const res = await move(base, b.token, to);
    assert.equal(res.status, 409);
    assert.match(readable(await res.text()), /can't move now/);
    assert.equal((await payment(db, b.id)).session_id, from);

    assert.equal((await fetch(`${base}/booking/${b.token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
  });
  const row = await db.query<{ status: string; late_cancel: boolean }>('select status, late_cancel from booking where id = $1', [b.id]);
  assert.deepEqual(row.rows[0], { status: 'cancelled', late_cancel: true });
});

test("the waitlist's first claim: a spot someone waits for is not taken, and the spot a move frees goes to the line", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, from } = await twoSessions(db, { capacity: 1 });
    await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
    const to = await sessionAt(db, seed.sessionTypeId, 96, { capacity: 2 });
    await seedBookedSession(db, to, 'Ada Other', '+15550008099');
    const waiter = '+15550008077';
    await grantSmsConsent(db, waiter);
    await seedWaitlistEntry(db, to, 'Wes Waiting', waiter);
    const b = await dropIn(db, from);
    const lineForFrom = '+15550008066';
    await grantSmsConsent(db, lineForFrom);
    await seedWaitlistEntry(db, from, 'Lia Line', lineForFrom);

    await withServer(async (base) => {
      assert.ok(!offers(await managePage(base, b.token), to), "the one spot left is the waiting parent's");
      assert.equal((await move(base, b.token, to)).status, 409);
      assert.equal((await payment(db, b.id)).session_id, from);

      // The parent's own child waiting there does not stand in their way,
      // and leaves the line once booked.
      await db.query("update waitlist set contact_phone = $1, athlete_name = 'Mia' where session_id = $2", [PHONE, to]);
      assert.ok(offers(await managePage(base, b.token), to));
      assert.equal((await move(base, b.token, to)).status, 303);
    });
    assert.equal((await payment(db, b.id)).session_id, to);
    const own = await db.query<{ state: string }>('select state from waitlist where session_id = $1', [to]);
    assert.deepEqual(own.rows, [{ state: 'booked' }]);

    const spot = relay.sms.filter((m) => m.to === lineForFrom);
    assert.equal(spot.length, 1, 'the freed spot was offered to the line');
    assert.match(spot[0].body, /a spot opened/);
    const held = await db.query<{ status: string }>('select status from booking where session_id = $1 and contact_phone = $2', [from, lineForFrom]);
    assert.deepEqual(held.rows, [{ status: 'pending' }]);
  });
});

const PASS_PHONE = '+15550008044';

async function payForTwo(base: string, handle: string, sessionId: number, paymentId: string): Promise<void> {
  const b = await bookOnline(base, handle, sessionId, 'Mia', PASS_PHONE, { athlete_name_2: 'Leo' });
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, handle, b.key, { mode: 'dropin' });
  assert.equal(pay.status, 303);
  assert.equal((await postStorePaid(base, { userId: buyerFromLocation(pay.headers.get('location')), amountCents: 7000, paymentId })).status, 200);
}

async function passChildren(db: DbClient) {
  const r = await db.query<{ id: number; session_id: number; status: string; manage_token: string }>(
    'select id, session_id, status, manage_token from booking where contact_phone = $1 order by id',
    [PASS_PHONE],
  );
  return r.rows;
}

test('two children paid in one payment move together, and a refund still covers both', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, from, 'ch_two');
      const [mia, leo] = await passChildren(db);
      assert.match(await managePage(base, mia.manage_token), /Mia and Leo were paid for together, so they move together\./);

      assert.equal((await move(base, leo.manage_token, to)).status, 303);
      assert.deepEqual(
        (await passChildren(db)).map((c) => [c.session_id, c.status]),
        [
          [to, 'booked'],
          [to, 'booked'],
        ],
      );
      const moved = relay.sms.filter((m) => m.to === PASS_PHONE && / moved to /.test(m.body));
      assert.equal(moved.length, 2, 'each child gets their own confirmation');
      assert.ok(moved.some((m) => m.body.includes(`/booking/${mia.manage_token} `)));
      assert.ok(moved.some((m) => m.body.includes(`/booking/${leo.manage_token} `)));

      const cookie = await coachCookie(db, seed.coach.id);
      const confirm = await getPage(base, `/app/sessions/${to}?refund=${mia.id}`, cookie);
      assert.match(confirm, /Refund \$70\?/);
      assert.match(confirm, /Mia and Leo's bookings are cancelled and the spots are free again\./);
      assert.equal((await postForm(base, `/app/sessions/${to}/bookings/${mia.id}/refund`, cookie)).status, 303);
    });
    assert.equal(relay.refunds.length, 1);
    assert.deepEqual((await passChildren(db)).map((c) => c.status), ['refunded', 'refunded']);
  });
});

test("a payment's child cannot move alone once a sibling it paid with is cancelled", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, from, 'ch_two');
      const [mia, leo] = await passChildren(db);
      assert.equal((await fetch(`${base}/booking/${leo.manage_token}/cancel`, { method: 'POST', redirect: 'manual' })).status, 303);
      const page = await managePage(base, mia.manage_token);
      assert.match(page, /paid for together with Leo's, and not all of them are still booked for this session, so it can't move\./);
      assert.ok(!offers(page, to));
      assert.equal((await move(base, mia.manage_token, to)).status, 409);
    });
    assert.deepEqual((await passChildren(db)).map((c) => c.session_id), [from, from]);
  });
});

test('children who each used their own credit move one at a time', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    const mia = await creditBooking(db, seed.coach.id, from, 'Mia');
    const leo = await creditBooking(db, seed.coach.id, from, 'Leo');
    await db.query("update booking set pass_id = 'pass-credits' where id = any($1::int[])", [[mia.id, leo.id]]);
    await withServer(async (base) => {
      assert.doesNotMatch(await managePage(base, mia.token), /move together/);
      assert.equal((await move(base, mia.token, to)).status, 303);
    });
    assert.equal((await payment(db, mia.id)).session_id, to);
    assert.equal((await payment(db, leo.id)).session_id, from, "Leo's booking stays where it was");
  });
});

test('a refunded booking, or one whose refund is on its way, cannot move', async () => {
  const db = await freshDb();
  const { from, to } = await twoSessions(db);
  const refunded = await dropIn(db, from, 'Rae');
  await db.query("update booking set status = 'refunded' where id = $1", [refunded.id]);
  const onItsWay = await dropIn(db, from, 'Pat');
  await db.query(
    "insert into refund (coach_id, payment_ref, booking_id, amount_cents, status) select st.coach_id, 'ch_pat', $1, 3500, 'pending' from session s join session_type st on st.id = s.session_type_id where s.id = $2",
    [onItsWay.id, from],
  );
  await withServer(async (base) => {
    const page = await managePage(base, refunded.token);
    assert.ok(!offers(page, to));
    assert.doesNotMatch(page, /move this booking/);
    const res = await move(base, refunded.token, to);
    assert.equal(res.status, 409);
    assert.match(readable(await res.text()), /This booking was refunded, so it can't move\./);

    const pending = await managePage(base, onItsWay.token);
    assert.match(pending, /A refund of this booking's payment is on its way, so it can't move\./);
    assert.ok(!offers(pending, to));
    assert.equal((await move(base, onItsWay.token, to)).status, 409);
  });
  assert.equal((await payment(db, refunded.id)).session_id, from);
  assert.equal((await payment(db, onItsWay.id)).session_id, from);
});

test('two parents moving into the last spot at once: one of them gets it', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { seed, from } = await twoSessions(db);
    const last = await sessionAt(db, seed.sessionTypeId, 96, { capacity: 1 });
    const first = await dropIn(db, from, 'Mia', '+15550008011');
    const second = await dropIn(db, from, 'Leo', '+15550008022');
    await withServer(async (base) => {
      const results = await Promise.all([move(base, first.token, last), move(base, second.token, last)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
    });
    assert.equal(await countSold(db, last), 1);
    assert.equal(await countSold(db, from), 1);
  });
});

async function movesOf(db: DbClient, bookingId: number): Promise<number> {
  return (await db.query<{ n: number }>('select count(*)::int as n from booking_move where booking_id = $1', [bookingId])).rows[0].n;
}

test('one booking moves at most five times a day, from any address', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { from, to } = await twoSessions(db);
    await grantSmsConsent(db, PHONE);
    const b = await dropIn(db, from);
    await withServer(async (base) => {
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await move(base, b.token, i % 2 === 0 ? to : from, `203.0.113.${110 + i}`)).status, 303, `move ${i + 1}`);
      }
      const sixth = await move(base, b.token, from, '203.0.113.120');
      assert.equal(sixth.status, 429);
      assert.match(readable(await sixth.text()), /Too many moves for now/);
    });
    assert.equal((await payment(db, b.id)).session_id, to, 'the sixth move did not happen');
    assert.equal(await movesOf(db, b.id), 5);
    assert.equal(relay.sms.filter((m) => m.to === PHONE && / moved to /.test(m.body)).length, 5);
  });
});

test('one address makes at most ten moves an hour; another address still can', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { from, to } = await twoSessions(db, { capacity: 8 });
    const here = '203.0.113.130';
    const bookings = [];
    for (const [i, name] of ['Mia', 'Leo', 'Ava'].entries()) bookings.push(await dropIn(db, from, name, `+1555000810${i}`));
    const [mia, leo, ava] = bookings;
    await withServer(async (base) => {
      for (const b of [mia, leo]) {
        for (let i = 0; i < 5; i += 1) assert.equal((await move(base, b.token, i % 2 === 0 ? to : from, here)).status, 303);
      }
      assert.equal((await move(base, ava.token, to, here)).status, 429, 'the eleventh move from one address');
      assert.equal((await payment(db, ava.id)).session_id, from);
      assert.equal((await move(base, ava.token, to, '203.0.113.131')).status, 303);
    });
    assert.equal((await payment(db, ava.id)).session_id, to);
  });
});

test("moved confirmations to one number and address are capped, and other families' texts still go", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { from, to } = await twoSessions(db);
    await grantSmsConsent(db, PHONE);
    const b = await dropIn(db, from);
    await db.query('update booking set session_id = $2 where id = $1', [b.id, to]);
    const outcomes = [];
    for (let i = 0; i < 11; i += 1) outcomes.push(await sendBookingConfirmation(db, b.id, { movedFrom: new Date() }));
    assert.deepEqual(
      outcomes.slice(0, 10).map((o) => [o.text, o.email]),
      Array.from({ length: 10 }, () => ['sent', 'sent']),
    );
    assert.deepEqual(outcomes[10], { text: 'capped', email: 'capped' });
    const capped = await db.query<{ channel: string; status: string }>(
      "select channel, status from message_log where template = 'booking-moved' and status like 'capped%' order by channel",
    );
    assert.deepEqual(capped.rows, [
      { channel: 'email', status: 'capped-recipient-daily' },
      { channel: 'sms', status: 'capped-recipient-daily' },
    ]);
    assert.equal(relay.sms.filter((m) => m.to === PHONE).length, 10);

    // Another family of the coach is booked and told as usual.
    const other = '+15550008033';
    await grantSmsConsent(db, other);
    const ola = await dropIn(db, from, 'Ola', other);
    assert.deepEqual(await sendBookingConfirmation(db, ola.id), { text: 'sent', email: 'sent' });
  });
});

/** The booking rows `db`'s callers lock, in the order each is first locked.
 * PGlite runs one transaction at a time, so two that lock the same rows in
 * opposite orders cannot be shown waiting on each other here; on Postgres
 * they can stop each other, so the order is checked instead. */
function bookingLockOrder(db: DbClient): { db: DbClient; order: number[] } {
  const order: number[] = [];
  const watch = (inner: DbClient): DbClient => ({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await inner.query<T>(sql, params);
      if (/\bfor update\b/.test(sql) && /\bfrom booking\b/.test(sql)) {
        for (const row of result.rows as Array<{ id?: number }>) {
          if (typeof row.id === 'number' && !order.includes(row.id)) order.push(row.id);
        }
      }
      return result;
    },
    transaction: <T>(fn: (tx: DbClient) => Promise<T>) => inner.transaction!((tx) => fn(watch(tx))),
  });
  return { db: watch(db), order };
}

test("a move from either child's link locks the payment's bookings in the order a refund of it does", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { seed, from, to } = await twoSessions(db);
    await withServer(async (base) => {
      await payForTwo(base, seed.coach.handle, from, 'ch_two');
    });
    const [mia, leo] = await passChildren(db);

    const moving = bookingLockOrder(db);
    assert.equal((await moveByParent(moving.db, leo.manage_token, to)).kind, 'moved');
    const back = bookingLockOrder(db);
    assert.equal((await moveByParent(back.db, mia.manage_token, from)).kind, 'moved');

    await db.query(
      "insert into refund (coach_id, payment_ref, booking_id, amount_cents, status) values ($1, 'ch_two', $2, 7000, 'pending')",
      [seed.coach.id, mia.id],
    );
    const refunding = bookingLockOrder(db);
    assert.equal(await applyRefunded(refunding.db, { paymentRef: 'ch_two', refundRef: 're_two', amountCents: 7000, sellerKey: null }), 'refunded');

    assert.deepEqual(refunding.order, [mia.id, leo.id]);
    assert.deepEqual(moving.order, refunding.order, "from Leo's link");
    assert.deepEqual(back.order, refunding.order, "from Mia's link");
  });
});
