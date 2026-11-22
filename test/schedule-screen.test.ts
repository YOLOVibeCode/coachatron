import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { createCoachSession } from '../src/domain/auth.js';
import { fakeComplete } from './fakes/llm.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import type { ChatMessage } from '../src/llm/schema.js';
import { weekWindowUtc } from '../src/lib/week.js';

const JAM_TUTOR_WEEK = {
  coach_timezone: null,
  session_types: [
    {
      key: 'elem',
      name: 'Elementary Group',
      duration_min: 60,
      capacity: 5,
      price_cents: 600,
      backup_pay_cents: null,
    },
    {
      key: 'hs',
      name: 'High School One-on-One',
      duration_min: 60,
      capacity: 1,
      price_cents: 1000,
      backup_pay_cents: null,
    },
  ],
  weekly: [
    { type_key: 'elem', weekday: 2, time_local: '16:00', location: null },
    { type_key: 'elem', weekday: 4, time_local: '16:00', location: null },
    { type_key: 'hs', weekday: 6, time_local: '09:00', location: null },
    { type_key: 'hs', weekday: 6, time_local: '10:00', location: null },
    { type_key: 'hs', weekday: 6, time_local: '11:00', location: null },
  ],
  packages: [{ name: '10-session package', credits: 10, price_cents: 8500, expires_days: null }],
  plans: [],
};

const JAM_TUTOR_TEXT =
  'I tutor elementary students on Tuesdays and Thursdays at 4 PM. We work on multiplication, fractions, and word problems. Each group has up to 5 students, and sessions are 1 hour at $6 per student. I offer one-on-one high school tutoring on Saturdays at 9 AM, 10 AM, and 11 AM for algebra and geometry. Each session is 1 hour and costs $10, or $85 for a 10-session package.';

test('Schedule: grouped list, week nav, edit panel, account sign-out, session row markup', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const now = new Date();
    const { from, to } = weekWindowUtc(now, seed.coach.tz, 0);
    const at = new Date(Math.min(now.getTime() + 45 * 60 * 1000, to.getTime() - 1000));
    await db.query('update session set starts_at_utc = $2, tz = $3 where id = $1', [seed.sessionId, at.toISOString(), seed.coach.tz]);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /<h1>This week<\/h1>/);
      assert.match(schedule, /schedule-day-heading/);
      assert.match(schedule, /class="card session-card"/);
      assert.match(schedule, /<strong>Goalkeeper Group<\/strong>/);
      assert.match(schedule, /class="spots">0 of 1 spot booked</);
      assert.match(schedule, /Show next week/);
      assert.match(schedule, /<details class="schedule-edit">/);
      assert.doesNotMatch(schedule, /schedule-ask/);
      assert.match(schedule, /<form method="post" action="\/signout">/);

      const types = await (await fetch(`${base}/app/session-types`, { headers: { cookie } })).text();
      assert.match(types, /1 athlete/);
      assert.match(types, /<form method="post" action="\/signout">/);
    });
  });
});

test('Schedule: payments banner blocks share until payments are ready', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { paymentsReady: false });
    const now = new Date();
    const { from, to } = weekWindowUtc(now, seed.coach.tz, 0);
    const at = new Date(Math.min(now.getTime() + 45 * 60 * 1000, to.getTime() - 1000));
    await db.query('update session set starts_at_utc = $2, tz = $3 where id = $1', [seed.sessionId, at.toISOString(), seed.coach.tz]);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    await withServer(async (base) => {
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /payments-banner/);
      assert.match(schedule, /Parents can(&#39;|')t book until payments are set up/);
      assert.match(schedule, /Copy link<\/button>/);
      assert.match(schedule, /<button type="button" class="ghost" disabled>Copy link<\/button>/);
      assert.match(schedule, /<span class="action ghost" aria-disabled="true">Share your link<\/span>/);
    });
  });
});

test('Jam tutoring week extracts to preview with both types and package', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    const llm = fakeComplete((req: { messages: ChatMessage[] }) =>
      req.messages.some((m) => m.role === 'user' && m.content.includes('elementary')) ? JAM_TUTOR_WEEK : null,
    );
    setComplete(llm);
  try {
    await withServer(async (base) => {
      const post = await fetch(`${base}/app/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ text: JAM_TUTOR_TEXT }),
        redirect: 'manual',
      });
      assert.equal(post.status, 303);
      const page = await (await fetch(`${base}/app/schedule?setup=1`, { headers: { cookie } })).text();
      assert.match(page, /Elementary Group/);
      assert.match(page, /High School One-on-One/);
      assert.match(page, /10-session package/);
      assert.match(page, /Publish/);
    });
  } finally {
    resetComplete();
  }
  });
});

test('setup POST keeps typed text when the model fails', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
    setComplete(fakeComplete(new Error('timeout')));
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/app/setup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ text: JAM_TUTOR_TEXT }),
        });
        assert.equal(res.status, 422);
        const body = await res.text();
        assert.match(body, /couldn&#39;t read that/);
        assert.match(body, /elementary students on Tuesdays/);
      });
    } finally {
      resetComplete();
    }
  });
});