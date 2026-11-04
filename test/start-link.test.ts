import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { createCoach } from '../src/domain/auth.js';
import { createStartLink } from '../src/domain/startLink.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';

const WEEK = {
  coach_timezone: null,
  session_types: [{ key: 'g', name: 'Evening group', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: null }],
  weekly: [{ type_key: 'g', weekday: 2, time_local: '18:00', location: 'Field 3' }],
  packages: [],
  plans: [],
};

function post(base: string, path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

test('a start link with an email another coach uses asks for a different one, and the link still works', async () => {
  setComplete(fakeComplete(WEEK));
  try {
    await withRelay(async () => {
      const db = await freshDb();
      await createCoach(db, { phone: null, email: 'taken@example.com', name: 'Taken', tz: 'America/Chicago' });
      const token = await createStartLink(db, '+15553334444', 'Tuesdays at 6, 60 min, 8 kids, $35');
      await withServer(async (base) => {
        const taken = await post(base, `/start/${token}`, { name: 'New Coach', email: 'Taken@Example.com' });
        assert.equal(taken.status, 422);
        const form = await taken.text();
        assert.match(form, /That email already has an account/);
        assert.match(form, /value="New Coach"/, 'what they typed is kept');
        assert.equal((await db.query('select id from coach where phone = $1', ['+15553334444'])).rows.length, 0);

        assert.equal((await fetch(`${base}/start/${token}`)).status, 200, 'the link still opens');

        const fixed = await post(base, `/start/${token}`, { name: 'New Coach', email: 'new@example.com' });
        assert.equal(fixed.status, 303);
        assert.equal(fixed.headers.get('location'), '/app/schedule?setup=1');
        const coach = await db.query<{ email: string }>('select email from coach where phone = $1', ['+15553334444']);
        assert.equal(coach.rows[0].email, 'new@example.com');

        assert.equal((await post(base, `/start/${token}`, { name: 'New Coach' })).status, 410, 'and then it is used up');
      });
    });
  } finally {
    resetComplete();
  }
});
