import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import type { DbClient } from '../src/db/client.js';

/** Session detail (screen 3) lists a parent who is still paying as holding
 * the spot until their hold runs out, and leaves out a hold that has run out
 * or has no time (a booking from before holds). It says every status in
 * words, and its counts match the rows it lists. */

async function pending(db: DbClient, sessionId: number, name: string, phone: string, hold: string | null): Promise<void> {
  await db.query(
    `insert into booking (session_id, athlete_name, contact_phone, manage_token, status, hold_expires_at)
     values ($1, $2, $3, md5(random()::text), 'pending', ${hold === null ? 'null' : `now() + interval '${hold}'`})`,
    [sessionId, name, phone],
  );
}

test('Session detail shows a live hold as holding the spot until a time, and leaves out lapsed and timeless holds', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await seedBookedSession(db, seed.sessionId, 'Ada Lane', '+15550007001');
    const attended = await seedBookedSession(db, seed.sessionId, 'Ben Ortiz', '+15550007002');
    await db.query("update booking set status = 'attended' where id = $1", [attended]);
    await pending(db, seed.sessionId, 'Cora Paying', '+15550007003', '10 minutes');
    await pending(db, seed.sessionId, 'Dov Lapsed', '+15550007004', '-1 minute');
    await pending(db, seed.sessionId, 'Eve Before Holds', '+15550007005', null);
    const hold = await db.query<{ hold_expires_at: string | Date }>(
      "select hold_expires_at from booking where athlete_name = 'Cora Paying'",
    );
    const until = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(
      new Date(hold.rows[0].hold_expires_at),
    );
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;

    await withServer(async (base) => {
      const res = await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.match(page, /<h2>Booked \(2\) · Holding \(1\)<\/h2>/, 'Ada and Ben were sold; Cora is holding');
      assert.ok(page.includes(`<strong>Cora Paying</strong>`), 'the live hold is listed');
      assert.ok(page.includes(`Holding — not paid yet (until ${until})`), `with the time it runs out (${until})`);
      assert.ok(!page.includes('Dov Lapsed'), 'a hold that ran out is left out');
      assert.ok(!page.includes('Eve Before Holds'), 'a pending booking with no hold time is left out');
      assert.match(page, /<strong>Ben Ortiz<\/strong> —\s*<span class="good">Attended<\/span>/);
      assert.doesNotMatch(page, /<span[^>]*>(pending|booked|attended|noshow|cancelled|refunded)<\/span>/, 'no raw status');
      assert.equal((page.match(/<li class="card">/g) ?? []).length, 3, 'one row per booking counted');
    });
  });
});

test('Session detail with only a lapsed hold says there are no bookings yet', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await pending(db, seed.sessionId, 'Fin Gone', '+15550007101', '-5 minutes');
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/app/sessions/${seed.sessionId}`, { headers: { cookie } })).text();
      assert.match(page, /<h2>Booked \(0\)<\/h2>/);
      assert.match(page, /No bookings yet\./);
      assert.ok(!page.includes('Fin Gone'));
    });
  });
});
