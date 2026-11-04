import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoach, createCoachSession } from '../src/domain/auth.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { keptAsCreditSql } from '../src/domain/money.js';
import type { DbClient } from '../src/db/client.js';

/** The booking policy (SPEC.md §9.5): a no-show uses the credit and the
 * coach can give it back; a parent's cancel before the coach's window gives
 * the credit back, inside it counts as a no-show; the coach changes the
 * defaults on the Pricing screen. */

const PHONE = '+15550007001';

async function sessionIn(db: DbClient, hours: number) {
  const seed = await seedCoachWithSession(db, { capacity: 4 });
  await db.query("update session set starts_at_utc = now() + make_interval(mins => $2::int) where id = $1", [
    seed.sessionId,
    Math.round(hours * 60),
  ]);
  return seed;
}

async function creditBooking(db: DbClient, coachId: number, sessionId: number, remaining = 3) {
  const credit = await db.query<{ id: number }>(
    "insert into credit (coach_id, contact_phone, remaining, source) values ($1, $2, $3, 'test') returning id",
    [coachId, PHONE, remaining],
  );
  const bookingId = await seedBookedSession(db, sessionId, 'Mia Credit', PHONE);
  await db.query("update booking set payment_source = 'PackageCredit', credit_id = $2, gross_cents = null where id = $1", [
    bookingId,
    credit.rows[0].id,
  ]);
  return { bookingId, creditId: credit.rows[0].id, token: await manageToken(db, bookingId) };
}

async function dropInBooking(db: DbClient, sessionId: number, grossCents = 3500) {
  const bookingId = await seedBookedSession(db, sessionId, 'Dee Dropin', PHONE);
  await db.query('update booking set gross_cents = $2 where id = $1', [bookingId, grossCents]);
  return { bookingId, token: await manageToken(db, bookingId) };
}

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

async function remaining(db: DbClient, creditId: number): Promise<number> {
  return (await db.query<{ remaining: number }>('select remaining from credit where id = $1', [creditId])).rows[0].remaining;
}

async function phoneCredits(db: DbClient): Promise<number> {
  const r = await db.query<{ n: string }>('select coalesce(sum(remaining), 0)::text as n from credit where contact_phone = $1', [PHONE]);
  return Number(r.rows[0].n);
}

async function cancel(base: string, token: string): Promise<number> {
  return (await fetch(`${base}/booking/${token}/cancel`, { method: 'POST', redirect: 'manual' })).status;
}

function post(base: string, path: string, fields: Record<string, string>, cookie: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

test('the Pricing screen states the default policy and lets the coach change it', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 72);
  await withServer(async (base) => {
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    const pricing = await (await fetch(`${base}/app/pricing`, { headers: { cookie } })).text();
    assert.match(pricing, /<h2 id="policy">Booking policy<\/h2>/);
    assert.match(pricing, /No-show:<\/strong> the booking(?:'|&#39;)s credit is used/);
    assert.match(pricing, /cancels more than 24 hours before a session gets their credit back/);
    assert.match(pricing, /book up to 2 children at once/);
    assert.match(pricing, /name="cancel_window_hours"[^>]*value="24"/);

    const saved = await post(base, '/app/pricing/policy', { cancel_window_hours: '48', children_per_booking: '3' }, cookie);
    assert.equal(saved.status, 303);
    const after = await (await fetch(`${base}/app/pricing`, { headers: { cookie } })).text();
    assert.match(after, /more than 48 hours before a session/);
    assert.match(after, /book up to 3 children at once/);

    for (const bad of [
      { cancel_window_hours: '-1', children_per_booking: '2' },
      { cancel_window_hours: '1000', children_per_booking: '2' },
      { cancel_window_hours: '24', children_per_booking: '0' },
      { cancel_window_hours: '24', children_per_booking: '11' },
      { cancel_window_hours: '2.5', children_per_booking: '2' },
      { cancel_window_hours: '', children_per_booking: '' },
    ]) {
      assert.equal((await post(base, '/app/pricing/policy', bad, cookie)).status, 422, JSON.stringify(bad));
    }
    const kept = await db.query<{ cancel_window_hours: number; children_per_booking: number }>(
      'select cancel_window_hours, children_per_booking from coach where id = $1',
      [seed.coach.id],
    );
    assert.deepEqual(kept.rows[0], { cancel_window_hours: 48, children_per_booking: 3 });
  });
});

test('before the window, the manage page says the credit comes back, and it does', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 72);
  const b = await creditBooking(db, seed.coach.id, seed.sessionId);
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/booking/${b.token}`)).text();
    assert.match(page, /Cancel by .* and your session credit comes back\./);
    assert.equal(await cancel(base, b.token), 303);
    assert.equal(await remaining(db, b.creditId), 4);
    assert.equal(await cancel(base, b.token), 303, 'a second cancel changes nothing');
    assert.equal(await remaining(db, b.creditId), 4);
    assert.match(await (await fetch(`${base}/booking/${b.token}`)).text(), /Your session credit with Jamie Coach is back\./);
  });
});

test('before the window, a paid drop-in becomes one session credit with the coach', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 72);
  const b = await dropInBooking(db, seed.sessionId);
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/booking/${b.token}`)).text();
    assert.match(page, /your payment becomes a session credit with Jamie Coach/);
    await cancel(base, b.token);
  });
  const credit = await db.query<{ remaining: number; expires_at: string | null; coach_id: number }>(
    'select remaining, expires_at, coach_id from credit where contact_phone = $1',
    [PHONE],
  );
  assert.deepEqual(credit.rows, [{ remaining: 1, expires_at: null, coach_id: seed.coach.id }]);
});

test('inside the window, the page says the credit will be used; the coach can give it back once', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 5);
  const b = await creditBooking(db, seed.coach.id, seed.sessionId);
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/booking/${b.token}`)).text();
    assert.match(page, /less than 24 hours before the session, so cancelling now uses this booking(?:'|&#39;)s session credit/);
    assert.match(page, /Jamie Coach can choose to give it back/);
    await cancel(base, b.token);
    assert.equal(await remaining(db, b.creditId), 3, 'the credit is used');
    assert.match(await (await fetch(`${base}/booking/${b.token}`)).text(), /so the credit was used/);

    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    const screen = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
    assert.match(screen, /Cancelled late/);
    assert.match(screen, new RegExp(`action="/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive"`));

    const outsider = await createCoach(db, { phone: '+15550009999', email: 'out@example.com', name: 'Outsider', tz: 'America/Chicago' });
    const other = `cx_session=${await createCoachSession(db, outsider.id)}`;
    assert.equal((await post(base, `/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive`, {}, other)).status, 404);
    assert.equal(await remaining(db, b.creditId), 3, "another coach cannot give it back");

    assert.equal((await post(base, `/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive`, {}, cookie)).status, 303);
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive`, {}, cookie);
    assert.equal(await remaining(db, b.creditId), 4, 'given back once');
    const again = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
    assert.match(again, /Credit given back\./);
    assert.doesNotMatch(again, /\/waive"/);
  });
});

test('a no-show uses the credit; the coach can give it back; a booking that was attended cannot be', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 5);
  const noShow = await creditBooking(db, seed.coach.id, seed.sessionId);
  const attended = await seedBookedSession(db, seed.sessionId, 'Ada Attended', '+15550007002');
  await withServer(async (base) => {
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${noShow.bookingId}/attendance`, { status: 'noshow' }, cookie);
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${attended}/attendance`, { status: 'attended' }, cookie);
    assert.equal(await remaining(db, noShow.creditId), 3, 'marking a no-show gives nothing back');
    const screen = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
    assert.match(screen, /The credit was used \(no-show\)/);
    assert.doesNotMatch(screen, new RegExp(`bookings/${attended}/waive`));

    await post(base, `/app/sessions/${seed.sessionId}/bookings/${attended}/waive`, {}, cookie);
    assert.equal(await phoneCredits(db), 3);
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${noShow.bookingId}/waive`, {}, cookie);
    assert.equal(await remaining(db, noShow.creditId), 4);
  });
});

test("a late cancel of a paid drop-in keeps the payment with the coach; giving it back makes one credit", async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 5);
  const b = await dropInBooking(db, seed.sessionId);
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/booking/${b.token}`)).text(), /uses this booking(?:'|&#39;)s payment/);
    await cancel(base, b.token);
  });
  assert.equal(await phoneCredits(db), 0);
  // The payment stayed with the coach, so Money counts it as collected.
  const collected = await db.query<{ n: string }>(
    `select coalesce(sum(b.gross_cents), 0)::text as n from booking b where b.id = $1 and ${keptAsCreditSql('b')}`,
    [b.bookingId],
  );
  assert.equal(collected.rows[0].n, '3500');

  await withServer(async (base) => {
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive`, {}, cookie);
    await post(base, `/app/sessions/${seed.sessionId}/bookings/${b.bookingId}/waive`, {}, cookie);
  });
  assert.equal(await phoneCredits(db), 1);
});

test("the coach's own window decides: 0 hours lets a parent cancel up to the start, 48 makes 30 hours late", async () => {
  const db = await freshDb();
  const soon = await sessionIn(db, 1);
  await db.query('update coach set cancel_window_hours = 0 where id = $1', [soon.coach.id]);
  const early = await creditBooking(db, soon.coach.id, soon.sessionId);
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/booking/${early.token}`)).text(), /Cancel before it starts and your session credit comes back/);
    await cancel(base, early.token);
  });
  assert.equal(await remaining(db, early.creditId), 4);

  const db2 = await freshDb();
  const later = await sessionIn(db2, 30);
  await db2.query('update coach set cancel_window_hours = 48 where id = $1', [later.coach.id]);
  const late = await creditBooking(db2, later.coach.id, later.sessionId);
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/booking/${late.token}`)).text(), /less than 48 hours before the session/);
    await cancel(base, late.token);
  });
  assert.equal(await remaining(db2, late.creditId), 3);
});

test('a free booking says nothing about credits and cancels as before', async () => {
  const db = await freshDb();
  const seed = await sessionIn(db, 5);
  const bookingId = await seedBookedSession(db, seed.sessionId, 'Free Fran', PHONE);
  const token = await manageToken(db, bookingId);
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/booking/${token}`)).text();
    assert.doesNotMatch(page, /cancel-terms/);
    await cancel(base, token);
  });
  const row = await db.query<{ status: string; late_cancel: boolean }>('select status, late_cancel from booking where id = $1', [bookingId]);
  assert.deepEqual(row.rows[0], { status: 'cancelled', late_cancel: false });
  assert.equal(await phoneCredits(db), 0);
});

test("when the coach cancels the session, a late cancel's credit comes back, and a credit already given back is not given twice", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await sessionIn(db, 5);
    const late = await creditBooking(db, seed.coach.id, seed.sessionId, 3);
    const noShow = await dropInBooking(db, seed.sessionId);
    await withServer(async (base) => {
      await cancel(base, late.token);
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      await post(base, `/app/sessions/${seed.sessionId}/bookings/${noShow.bookingId}/attendance`, { status: 'noshow' }, cookie);
      await post(base, `/app/sessions/${seed.sessionId}/bookings/${noShow.bookingId}/waive`, {}, cookie);
    });
    assert.equal(await remaining(db, late.creditId), 3);
    assert.equal(await phoneCredits(db), 4, 'the no-show drop-in became one credit');

    assert.equal((await cancelScheduledSession(db, seed.coach.id, seed.sessionId)).kind, 'cancelled');
    assert.equal(await remaining(db, late.creditId), 4, "the late cancel's credit is back");
    assert.equal(await phoneCredits(db), 5, 'the given-back drop-in credit is not added again');
  });
});
