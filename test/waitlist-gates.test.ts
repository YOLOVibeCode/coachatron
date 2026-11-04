import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCredit } from '../src/domain/pricing.js';
import type { DbClient } from '../src/db/client.js';

/** Joining a waitlist (the full state of screen 9) passes the same gates as
 * booking: a session that has started takes nobody, a coach who cannot take
 * payments yet has a line only for families holding credits, and a session
 * with a spot for each child sends the parent to book it instead. Each
 * refusal uses the booking form's own page and status. */

function post(base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function line(db: DbClient, sessionId: number): Promise<string[]> {
  const r = await db.query<{ athlete_name: string }>('select athlete_name from waitlist where session_id = $1 order by id', [sessionId]);
  return r.rows.map((x) => x.athlete_name);
}

async function consentSource(db: DbClient, phone: string): Promise<string | null> {
  const r = await db.query<{ source: string }>('select source from sms_consent where phone = $1', [phone]);
  return r.rows[0]?.source ?? null;
}

test('a session that has started takes nobody on its waitlist: the booking form\'s 409 page', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550006001');
    await db.query("update session set starts_at_utc = now() - interval '10 minutes' where id = $1", [seed.sessionId]);
    await withServer(async (base) => {
      const path = `/c/${seed.coach.handle}/sessions/${seed.sessionId}`;
      const book = await post(base, `${path}/book`, { athlete_name: 'Bo', contact_phone: '5550006002' });
      const join = await post(base, `${path}/waitlist`, { athlete_name: 'Bo', contact_phone: '5550006002', sms_consent: '1' });
      assert.equal(join.status, book.status);
      assert.equal(join.status, 409);
      const html = await join.text();
      assert.match(html, /<h1>That session has started<\/h1>/);
      assert.match(html, new RegExp(`href="/c/${seed.coach.handle}">See other times<`));
    });
    assert.deepEqual(await line(db, seed.sessionId), []);
    assert.equal(await consentSource(db, '+15550006002'), null, 'nothing was recorded');
  });
});

test('while the coach cannot take payments, the waitlist is open only to a family holding credits', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1, paymentsReady: false });
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550006101');
    const path = `/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`;
    await withServer(async (base) => {
      const refused = await post(base, path, { athlete_name: 'Cy', contact_phone: '5550006102', sms_consent: '1' });
      assert.equal(refused.status, 409, 'the booking form\'s status');
      const html = await refused.text();
      assert.match(html, /<h1>Booking opens soon<\/h1>/);
      assert.match(html, /is still setting up payments/);
      assert.deepEqual(await line(db, seed.sessionId), []);
      assert.equal(await consentSource(db, '+15550006102'), null, 'nothing was recorded');

      // Once a family holds credits with the coach, there is something to
      // wait for: a spot they can book with them.
      await createCredit(db, seed.coach.id, '+15550006103', null, 'test', 2, null);
      const joined = await post(base, path, { athlete_name: 'Di', contact_phone: '5550006103', sms_consent: '1' });
      assert.equal(joined.status, 200);
      assert.match(await joined.text(), /You(&#39;|')re on the waitlist/);
    });
    assert.deepEqual(await line(db, seed.sessionId), ['Di']);
  });
});

test('a session with a spot for each child sends the parent to book it, with what they typed', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    const path = `/c/${seed.coach.handle}/sessions/${seed.sessionId}`;
    await withServer(async (base) => {
      const open = await post(base, `${path}/waitlist`, {
        athlete_name: 'Eli',
        contact_phone: '(555) 000-6201',
        contact_email: 'eli.parent@example.com',
        sms_consent: '1',
      });
      assert.equal(open.status, 409);
      const html = await open.text();
      assert.match(html, new RegExp(`<form method="post" action="${path}/book">`), 'the booking form');
      assert.match(html, /A spot is open, so there is no need to wait: book it here\./);
      assert.match(html, /Continue to payment/);
      assert.match(html, /name="athlete_name" value="Eli"/);
      assert.match(html, /value="\(555\) 000-6201"/);
      assert.match(html, /value="eli\.parent@example\.com"/);
      assert.deepEqual(await line(db, seed.sessionId), []);
      assert.equal(await consentSource(db, '+15550006201'), null, 'the box counts when they book, not here');

      // One spot left and two children: not enough for both, so the line
      // takes them, as the booking form's "not enough spots" page offers.
      await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550006202');
      const two = await post(base, `${path}/waitlist`, {
        athlete_name: 'Fay',
        athlete_name_2: 'Gus',
        contact_phone: '5550006203',
        contact_email: 'fay.parent@example.com',
      });
      assert.equal(two.status, 200);
      assert.match(await two.text(), /You(&#39;|')re on the waitlist/);
      assert.deepEqual(await line(db, seed.sessionId), ['Fay', 'Gus']);

      // The open spot went to the line at once (Fay holds it, Gus waits),
      // so one more child finds no spot and joins too.
      const one = await post(base, `${path}/waitlist`, { athlete_name: 'Hal', contact_phone: '5550006204', sms_consent: '1' });
      assert.equal(one.status, 200);
    });
    assert.deepEqual(await line(db, seed.sessionId), ['Fay', 'Gus', 'Hal']);
    assert.equal(
      await consentSource(db, '+15550006204'),
      `/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`,
      'a joined number with no record is recorded from the form, as before',
    );
  });
});
