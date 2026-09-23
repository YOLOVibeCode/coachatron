import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession, seedRosterMember, seedBookedSession, seedWaitlistEntry } from './helpers/fixtures.js';
import { checkOverflow } from '../src/domain/cascade.js';

/**
 * End-to-end smoke test for the three journeys named in the idea's "I will
 * judge it by" section. Each individual behavior already has focused unit
 * coverage elsewhere (test/coach-onboarding.test.ts, test/booking-payment.test.ts,
 * test/overflow-cascade.test.ts); this file proves the three journeys work
 * strung together end to end against the fakes, in one place, matching the
 * exact wording of the idea:
 *   1. coach signs in, creates a session type, generates a week, gets /c/<handle>
 *   2. parent books and pays a drop-in via the fake relay
 *   3. a full session with a waiter triggers the one-SMS overflow ask,
 *      coach Y, one roster member Y, offer accepted
 */

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const match = setCookie.map((c) => /^cx_session=([^;]+)/.exec(c)).find(Boolean);
  assert.ok(match, `expected a cx_session cookie in Set-Cookie headers: ${JSON.stringify(setCookie)}`);
  return `cx_session=${match![1]}`;
}

async function smsTo(base: string, from: string, body: string): Promise<Response> {
  return fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, body }),
  });
}

test('journey 1: coach signs in, creates a session type, generates a week, gets /c/<handle>', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();

    await withServer(async (base) => {
      const otpRes = await fetch(`${base}/signin/otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '5551110001' }),
        redirect: 'manual',
      });
      assert.equal(otpRes.status, 303);
      const phone = decodeURIComponent(new URL(otpRes.headers.get('location') ?? '', base).searchParams.get('phone') ?? '');

      const sentSms = relay.sms.find((m) => m.to === phone);
      assert.ok(sentSms, 'coach should have received an OTP by SMS');
      const code = /code is (\d{6})/.exec(sentSms!.body)?.[1];
      assert.ok(code);

      const verifyRes = await fetch(`${base}/signin/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, code, name: 'Journey Coach', email: 'journey@example.com', tz: 'America/Chicago' }),
        redirect: 'manual',
      });
      assert.equal(verifyRes.status, 303, 'sign-in should redirect to /app/schedule');
      const cookie = extractSessionCookie(verifyRes as unknown as Response);

      const createTypeRes = await fetch(`${base}/app/session-types`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Goalkeeper Group', duration_min: '60', capacity: '8', price_dollars: '35' }),
        redirect: 'manual',
      });
      assert.equal(createTypeRes.status, 303);

      const typeRows = await db.query<{ id: number }>("select id from session_type where name = 'Goalkeeper Group'");
      const typeId = typeRows.rows[0].id;

      const genBody: Record<string, string> = {};
      for (let i = 0; i < 7; i += 1) {
        genBody[`day_${i}`] = '1';
        genBody[`time_${i}`] = '18:00';
      }
      const genRes = await fetch(`${base}/app/session-types/${typeId}/generate-week`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(genBody),
        redirect: 'manual',
      });
      assert.equal(genRes.status, 303);

      const coachRows = await db.query<{ handle: string }>('select handle from coach where phone = $1', [phone]);
      const handle = coachRows.rows[0].handle;

      const publicRes = await fetch(`${base}/c/${handle}`);
      assert.equal(publicRes.status, 200);
      const publicHtml = await publicRes.text();
      assert.match(publicHtml, /Goalkeeper Group/);
      assert.match(publicHtml, /\$35\.00/);
    });
  });
});

test('journey 2: parent books and pays a drop-in via the fake relay', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2, priceCents: 3500 });

    await withServer(async (base) => {
      const bookRes = await fetch(`${base}/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_name: 'Parent Journey Athlete', contact_phone: '5552220001' }),
        redirect: 'manual',
      });
      assert.equal(bookRes.status, 303);
      const bookingId = Number(/\/checkout\/(\d+)/.exec(bookRes.headers.get('location') ?? '')?.[1]);
      assert.ok(bookingId);

      const checkoutRes = await fetch(`${base}/c/${seed.coach.handle}/checkout/${bookingId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'dropin', source_id: 'cnon:test-nonce' }),
        redirect: 'manual',
      });
      assert.equal(checkoutRes.status, 303, 'a successful drop-in payment redirects to the confirmation view');

      // The charge went through the fake Connect Hub relay, not a real
      // Square account, with the locked 5% application fee.
      assert.equal(relay.charges.length, 1);
      assert.equal(relay.charges[0].amountCents, 3500);
      assert.equal(relay.charges[0].appFeeBps, 500);

      const bookingRows = await db.query<{ status: string; payment_source: string }>(
        'select status, payment_source from booking where id = $1',
        [bookingId],
      );
      assert.equal(bookingRows.rows[0].status, 'booked');
      assert.equal(bookingRows.rows[0].payment_source, 'DropIn');

      // The coach's Money screen reflects the collection (SPEC.md example).
      const token = await (await import('../src/domain/auth.js')).createCoachSession(db, seed.coach.id);
      const moneyRes = await fetch(`${base}/app/money`, { headers: { cookie: `cx_session=${token}` } });
      assert.equal(moneyRes.status, 200);
      const moneyHtml = await moneyRes.text();
      assert.match(moneyHtml, /\$35\.00/);
    });
  });
});

test('journey 3: full session + a waiter triggers the overflow ask, coach Y, roster Y, offer accepted', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const backup = await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);

    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15553330001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15553330002');
    await checkOverflow(db, seed.sessionId);

    // Exactly one SMS to the coach, no offer yet - the system proposes,
    // the coach disposes (SPEC.md §7.3).
    const askToCoach = relay.sms.filter((m) => m.to === seed.coach.phone);
    assert.equal(askToCoach.length, 1);
    const offersBeforeYes = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]);
    assert.equal(offersBeforeYes.rows.length, 0);

    await withServer(async (base) => {
      const yesRes = await smsTo(base, seed.coach.phone, 'Y');
      assert.equal(yesRes.status, 200);

      const offers = await db.query<{ id: number; roster_member_id: number; state: string; token: string }>(
        'select id, roster_member_id, state, token from offer where session_id = $1',
        [seed.sessionId],
      );
      assert.equal(offers.rows.length, 1, 'exactly one offer, to the highest-priority roster member');
      assert.equal(offers.rows[0].roster_member_id, backup.id);
      assert.equal(relay.sms.filter((m) => m.to === backup.phone).length, 1);

      const memberYesRes = await smsTo(base, backup.phone, 'Y');
      assert.equal(memberYesRes.status, 200);

      const acceptedOffer = await db.query<{ state: string }>('select state from offer where id = $1', [offers.rows[0].id]);
      assert.equal(acceptedOffer.rows[0].state, 'accepted');

      const sessionRows = await db.query<{ assigned_roster_member_id: number }>(
        'select assigned_roster_member_id from session where id = $1',
        [seed.sessionId],
      );
      assert.equal(sessionRows.rows[0].assigned_roster_member_id, backup.id);
    });
  });
});
