import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { createCoach, createCoachSession, type CoachRow } from '../src/domain/auth.js';
import { describeWeekly, renderSetupPreview, validateSetupPlan, type ExistingType } from '../src/domain/setup.js';
import type { ChatMessage } from '../src/llm/schema.js';
import type { DbClient } from '../src/db/client.js';
import { postSignedSms } from './helpers/sms-webhook.js';

const WEEK = {
  coach_timezone: null,
  session_types: [
    { key: 'keeper', name: 'Keeper Group', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: 8000 },
    { key: 'private', name: 'Private Lesson', duration_min: 45, capacity: null, price_cents: 7000, backup_pay_cents: null },
  ],
  weekly: [
    { type_key: 'keeper', weekday: 2, time_local: '18:00', location: 'Field 3' },
    { type_key: 'keeper', weekday: 4, time_local: '18:00', location: 'Field 3' },
    { type_key: 'private', weekday: 6, time_local: '09:00', location: null },
    { type_key: 'private', weekday: 6, time_local: '10:00', location: null },
  ],
  packages: [{ name: '10-pack', credits: 10, price_cents: 30000, expires_days: null }],
  plans: [],
};

function withWeek(overrides: Record<string, unknown>) {
  return { ...structuredClone(WEEK), ...overrides };
}

async function newCoach(db: DbClient, phone = '+15550009999'): Promise<{ coach: CoachRow; cookie: string }> {
  const coach = await createCoach(db, { phone, name: 'Dana Keeper', email: '', tz: 'America/Chicago' });
  const { grantSmsConsent } = await import('../src/domain/sms-consent.js');
  await grantSmsConsent(db, phone);
  return { coach, cookie: `cx_session=${await createCoachSession(db, coach.id)}` };
}

async function post(base: string, path: string, cookie: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function count(db: DbClient, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params);
  return Number(result.rows[0].n);
}

// ---- validateSetupPlan: the product decides what the model's output means ----

test('a full week validates with no questions; a private lesson defaults to 1 athlete', () => {
  const { plan, questions } = validateSetupPlan(WEEK, []);
  assert.deepEqual(questions, []);
  assert.equal(plan.session_types.length, 2);
  assert.equal(plan.session_types[1].capacity, 1);
  assert.equal(plan.session_types[1].duration_min, 45);
  assert.equal(plan.weekly.length, 4);
  assert.equal(plan.packages.length, 1);
});

test('a missing price or headcount becomes a question, never a guess', () => {
  const raw = withWeek({
    session_types: [
      { key: 'keeper', name: 'Keeper Group', duration_min: null, capacity: null, price_cents: null, backup_pay_cents: null },
    ],
    weekly: [{ type_key: 'keeper', weekday: 2, time_local: '18:00', location: null }],
  });
  const { plan, questions } = validateSetupPlan(raw, []);
  assert.deepEqual(questions, ['What do you charge for Keeper Group?', 'How many athletes fit in Keeper Group?']);
  assert.equal(plan.session_types[0].price_cents, null);
  assert.equal(plan.session_types[0].duration_min, 60);
});

test('bad days, bad times, unknown types, and duplicates are dropped; times are normalized', () => {
  const raw = withWeek({
    weekly: [
      { type_key: 'keeper', weekday: 9, time_local: '18:00', location: null },
      { type_key: 'keeper', weekday: 2, time_local: '25:00', location: null },
      { type_key: 'keeper', weekday: 2, time_local: '04:00', location: null },
      { type_key: 'nobody', weekday: 2, time_local: '18:00', location: null },
      { type_key: 'keeper', weekday: 3, time_local: '6:30', location: null },
      { type_key: 'keeper', weekday: 3, time_local: '06:30', location: null },
    ],
  });
  const { plan } = validateSetupPlan(raw, []);
  assert.deepEqual(
    plan.weekly.map((w) => [w.weekday, w.time_local]),
    [[3, '06:30']],
  );
});

test('limits hold, and garbage from the model is survivable', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    key: `t${i}`,
    name: `Type ${i}`,
    duration_min: 60,
    capacity: 4,
    price_cents: 2000,
    backup_pay_cents: null,
  }));
  assert.equal(validateSetupPlan(withWeek({ session_types: many, weekly: [] }), []).plan.session_types.length, 6);
  for (const junk of [null, 'hello', 42, { session_types: 'nope' }]) {
    const { plan, questions } = validateSetupPlan(junk, []);
    assert.equal(plan.session_types.length, 0);
    assert.match(questions[0], /What do you coach/);
  }
  const noTimes = validateSetupPlan(withWeek({ weekly: [] }), []);
  assert.deepEqual(noTimes.questions, ['What days and times do you run each week?']);
});

test('a type the coach already has is reused, not duplicated or re-asked', () => {
  const existing: ExistingType[] = [
    { id: 5, name: 'Keeper Group', duration_min: 90, capacity: 10, price_cents: 4000, backup_pay_cents: null },
  ];
  const raw = withWeek({
    session_types: [
      { key: 'k', name: 'keeper group', duration_min: null, capacity: null, price_cents: null, backup_pay_cents: null },
    ],
    weekly: [{ type_key: 'k', weekday: 5, time_local: '17:00', location: null }],
  });
  const { plan, questions } = validateSetupPlan(raw, existing);
  assert.deepEqual(questions, []);
  assert.equal(plan.session_types[0].existing_id, 5);
  assert.equal(plan.session_types[0].price_cents, 4000);
});

test('a real time zone is kept; a made-up one becomes a question', () => {
  assert.equal(validateSetupPlan(withWeek({ coach_timezone: 'America/Denver' }), []).plan.coach_timezone, 'America/Denver');
  const bad = validateSetupPlan(withWeek({ coach_timezone: 'Mars/Olympus' }), []);
  assert.equal(bad.plan.coach_timezone, null);
  assert.match(bad.questions[0], /time zone/);
});

test('the preview is written by the product from the plan', () => {
  const { plan } = validateSetupPlan(WEEK, []);
  const coach = { id: 1, handle: 'dana-keeper', name: 'Dana', email: '', phone: '+1', tz: 'America/Chicago', connect_recipient_key: null };
  const preview = renderSetupPreview(plan, coach, new Date('2026-10-20T12:00:00Z')).value;
  assert.match(preview, /Keeper Group/);
  assert.match(preview, /60 min · 8 athletes · \$35 · backup pays \$80/);
  assert.match(preview, /Tue &amp; Thu 6:00pm · Field 3/);
  assert.match(preview, /45 min · 1 athlete · \$70/);
  assert.match(preview, /Sat 9:00am/);
  assert.match(preview, /10-pack: 10 sessions for \$300/);
  assert.match(preview, /First session: Tue, Oct 20, 6:00 PM\. Times in Central Time\./);
  assert.match(preview, /\/c\/dana-keeper/);
  assert.deepEqual(describeWeekly(plan.weekly.filter((w) => w.type_key === 'private')), ['Sat 9:00am', 'Sat 10:00am']);
});

// ---- The screen and the SMS ----

test('talk, refine, publish: nothing is written until Publish, and Publish runs once', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { coach, cookie } = await newCoach(db);
    const moved = withWeek({
      weekly: [...WEEK.weekly.slice(0, 1), { type_key: 'keeper', weekday: 4, time_local: '18:30', location: 'Field 3' }, ...WEEK.weekly.slice(2)],
    });
    const llm = fakeComplete((req: { messages: ChatMessage[] }) =>
      req.messages[1].content.includes('6:30') ? moved : WEEK,
    );
    setComplete(llm);
    try {
      await withServer(async (base) => {
        const empty = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
        assert.match(empty, /Tell me your week/);
        assert.match(empty, /<textarea/);

        const said = await post(base, '/app/setup', cookie, { text: 'Keeper group Tuesdays and Thursdays at 6...' });
        assert.equal(said.status, 303);
        assert.equal(said.headers.get('location'), '/app/schedule?setup=1');
        assert.equal(await count(db, 'session'), 0, 'a draft writes nothing to the schedule');

        const preview = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
        assert.match(preview, /Here&#39;s your week/);
        assert.match(preview, /Tue &amp; Thu 6:00pm · Field 3/);
        assert.match(preview, /<button type="submit">Publish<\/button>/);

        await post(base, '/app/setup', cookie, { text: 'make Thursday 6:30' });
        const system = (llm.calls[1] as { messages: ChatMessage[] }).messages[0].content;
        assert.match(system, /Current setup: \{/);
        assert.match(system, /"Keeper Group"/);
        assert.equal(await count(db, 'setup_draft'), 1, 'a refinement updates the same draft');
        const refined = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
        assert.match(refined, /Thu 6:30pm · Field 3/);

        const draftId = String((await db.query<{ id: number }>('select id from setup_draft')).rows[0].id);
        const published = await post(base, '/app/setup/publish', cookie, { id: draftId });
        assert.equal(published.headers.get('location'), '/app/schedule?published=1');
        assert.equal(await count(db, 'session_type where coach_id = $1', [coach.id]), 2);
        assert.equal(await count(db, 'weekly_slot'), 4);
        assert.equal(await count(db, 'package where coach_id = $1', [coach.id]), 1);
        assert.ok(await count(db, 'session') >= 32, 'about 8 weeks of four weekly times');
        const pay = await db.query<{ backup_pay_cents: number }>("select backup_pay_cents from session_type where name = 'Keeper Group'");
        assert.equal(pay.rows[0].backup_pay_cents, 8000);

        const sessionsBefore = await count(db, 'session');
        const again = await post(base, '/app/setup/publish', cookie, { id: draftId });
        assert.equal(again.headers.get('location'), '/app/schedule?setup=1&e=stale');
        assert.equal(await count(db, 'session'), sessionsBefore);
        assert.equal(await count(db, 'session_type'), 2);

        const live = await (await fetch(`${base}/app/schedule?published=1`, { headers: { cookie } })).text();
        assert.match(live, /You're live/);
        assert.match(live, /<a class="action" href="\/app\/money">Connect payments<\/a>/);
        assert.match(live, /href="sms:\?&amp;body=Book%20with%20me/);

        const publicPage = await (await fetch(`${base}/c/${coach.handle}`)).text();
        assert.match(publicPage, /Keeper Group/);
        assert.match(publicPage, /Private Lesson/);
      });
    } finally {
      resetComplete();
    }
  });
});

test('an open question blocks Publish until it is answered', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { cookie } = await newCoach(db);
    const noPrice = withWeek({
      session_types: [{ ...WEEK.session_types[0], price_cents: null }, WEEK.session_types[1]],
    });
    setComplete(fakeComplete(noPrice));
    try {
      await withServer(async (base) => {
        await post(base, '/app/setup', cookie, { text: 'keeper group tues and thurs at 6' });
        const page = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
        assert.match(page, /<label for="setup-text">What do you charge for Keeper Group\?<\/label>/);
        assert.doesNotMatch(page, />Publish</);

        const draftId = String((await db.query<{ id: number }>('select id from setup_draft')).rows[0].id);
        const forced = await post(base, '/app/setup/publish', cookie, { id: draftId });
        assert.equal(forced.headers.get('location'), '/app/schedule?setup=1&e=stale');
        assert.equal(await count(db, 'session'), 0);

        await post(base, '/app/setup/discard', cookie, { id: draftId });
        const fresh = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
        assert.match(fresh, /Tell me your week/);
      });
    } finally {
      resetComplete();
    }
  });
});

test('a model failure or a spent budget falls back to the forms, never a 500', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { coach, cookie } = await newCoach(db);
    const broken = fakeComplete(new Error('timeout'));
    setComplete(broken);
    try {
      await withServer(async (base) => {
        const failed = await post(base, '/app/setup', cookie, { text: 'keeper group' });
        assert.equal(failed.headers.get('location'), '/app/schedule?setup=1&e=read');
        const page = await (await fetch(`${base}/app/schedule?setup=1&e=read`, { headers: { cookie } })).text();
        assert.match(page, /couldn&#39;t read that/);
        assert.match(page, /href="\/app\/session-types">Set it up by hand/);
        assert.equal(await count(db, 'setup_draft'), 0);

        for (let i = 0; i < 30; i += 1) {
          await db.query('insert into assistant_model_call (coach_id, called_at) values ($1, now())', [coach.id]);
        }
        const callsBefore = broken.calls.length;
        const capped = await post(base, '/app/setup', cookie, { text: 'keeper group' });
        assert.equal(capped.headers.get('location'), '/app/schedule?setup=1&e=cap');
        assert.equal(broken.calls.length, callsBefore, 'the model is not called past the cap');
      });
    } finally {
      resetComplete();
    }
  });
});

test('by SMS, a coach with no schedule gets a draft and one short reply; a scheduled coach does not', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await newCoach(db, '+15550008888');
    const llm = fakeComplete(WEEK);
    setComplete(llm);
    try {
      await withServer(async (base) => {
        const sms = (from: string, body: string) => postSignedSms(base, { From: from, Body: body });

        await sms(coach.phone, 'Keeper group Tuesdays and Thursdays at 6 at Field 3, an hour, 8 kids, $35');
        const replies = relay.sms.filter((m) => m.to === coach.phone);
        assert.equal(replies.length, 1);
        assert.match(replies[0].body, /Got it: 2 session types, 4 times a week\. Check it and tap Publish:/);
        assert.ok(replies[0].body.length <= 160);
        assert.equal(await count(db, 'setup_draft where coach_id = $1', [coach.id]), 1);
        assert.equal(await count(db, 'session'), 0);

        const scheduled = await seedCoachWithSession(db);
        const setupCalls = llm.calls.length;
        await sms(scheduled.coach.phone, 'what is my week');
        assert.equal(llm.calls.length, setupCalls, 'a scheduled coach goes to the assistant pattern layer');
        assert.equal(await count(db, 'setup_draft where coach_id = $1', [scheduled.coach.id]), 0);
      });
    } finally {
      resetComplete();
    }
  });
});
