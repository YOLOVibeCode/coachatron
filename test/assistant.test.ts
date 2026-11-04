import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import { handleCoachMessage } from '../src/domain/assistant.js';
import { createCoachSession } from '../src/domain/auth.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '../src/domain/scheduling.js';
import { checkOverflow } from '../src/domain/cascade.js';
import { APP_BASE_URL } from '../src/config.js';
import type { ClassifiedIntent } from '../src/llm/schema.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { composeText, segmentCount } from '../src/domain/outbound.js';

async function smsTo(base: string, from: string, body: string): Promise<Response> {
  return postSignedSms(base, { From: from, Body: body });
}

function cookieFor(token: string): string {
  return `cx_session=${token}`;
}

function tomorrowAt(tz: string, hour: number, minute = 0): Date {
  const now = new Date();
  const p = zonedParts(now, tz);
  const d = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedTimeToUtc(d.year, d.month, d.day, hour, minute, tz);
}

async function pinSession(db: Awaited<ReturnType<typeof freshDb>>, sessionId: number, starts: Date): Promise<void> {
  await db.query('update session set starts_at_utc = $1 where id = $2', [starts.toISOString(), sessionId]);
}

test('pattern WHO returns the roster without calling the model', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');
    await seedBookedSession(db, seed.sessionId, 'Mia Ortiz', '+15550000002');

    const llm = fakeComplete(new Error('model must not run'));
    setComplete(llm);
    try {
      const reply = await handleCoachMessage(db, seed.coach, "who's at 6pm", 'sms');
      assert.equal(llm.calls.length, 0);
      assert.equal(reply.kind, 'answer');
      assert.match(reply.text, /Sam Reyes/);
      assert.match(reply.text, /Mia Ortiz/);
      assert.match(reply.text, /2 at/);
    } finally {
      resetComplete();
    }
  });
});

test('pattern cancel confirms, Y texts athletes and returns credits', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));

    const pack = await db.query<{ id: number }>(
      `insert into package (coach_id, name, credits, price_cents, active) values ($1, '10-pack', 10, 30000, true) returning id`,
      [seed.coach.id],
    );
    const credit = await db.query<{ id: number }>(
      `insert into credit (coach_id, contact_phone, package_id, remaining, source) values ($1, $2, $3, 4, 'package') returning id`,
      [seed.coach.id, '+15550000011', pack.rows[0].id],
    );
    await db.query(
      `insert into booking (session_id, athlete_name, contact_phone, payment_source, credit_id, status)
       values ($1, 'Credit Kid', $2, 'PackageCredit', $3, 'booked')`,
      [seed.sessionId, '+15550000011', credit.rows[0].id],
    );
    const { grantSmsConsent } = await import('../src/domain/sms-consent.js');
    await grantSmsConsent(db, '+15550000011');
    await seedBookedSession(db, seed.sessionId, 'Drop In', '+15550000012');

    setComplete(fakeComplete(new Error('model must not run')));
    try {
      await withServer(async (base) => {
        const ask = await smsTo(base, seed.coach.phone, "cancel tomorrow's 6pm, field's flooded");
        assert.equal(ask.status, 200);
        assert.match(await ask.text(), /<Response/);
        const confirm = relay.sms.filter((m) => m.to === seed.coach.phone).at(-1);
        assert.ok(confirm);
        assert.match(confirm!.body, /Cancel /);
        assert.match(confirm!.body, /Reply Y/);
        assert.match(confirm!.body, /2 athletes/);

        const yes = await smsTo(base, seed.coach.phone, 'Y');
        assert.equal(yes.status, 200);
        assert.match(await yes.text(), /<Response/);
      });
    } finally {
      resetComplete();
    }

    const session = await db.query<{ status: string }>('select status from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].status, 'cancelled');
    assert.ok(relay.sms.some((m) => m.to === '+15550000011' && /cancelled/i.test(m.body)));
    assert.ok(relay.sms.some((m) => m.to === '+15550000012' && /cancelled/i.test(m.body)));
    const remaining = await db.query<{ remaining: number }>('select remaining from credit where id = $1', [credit.rows[0].id]);
    assert.equal(remaining.rows[0].remaining, 5);
  });
});

test('model path: fake intent confirms then Yes on the schedule screen', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');

    const intent: ClassifiedIntent = {
      intent: 'session.cancel',
      confidence: 0.91,
      session_id: seed.sessionId,
      session_type_id: seed.sessionTypeId,
      session_type: 'Goalkeeper Group',
      when: null,
      new_when: null,
      location: null,
      reason: 'field flooded',
      source: 'model',
    };
    const llm = fakeComplete(intent);
    setComplete(llm);
    try {
      const token = await createCoachSession(db, seed.coach.id);
      await withServer(async (base) => {
        const ask = await fetch(`${base}/app/schedule/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieFor(token) },
          body: JSON.stringify({ text: 'please drop the evening group, field is underwater' }),
          redirect: 'manual',
        });
        assert.equal(ask.status, 303);
        assert.equal(llm.calls.length, 1);

        const page = await fetch(`${base}/app/schedule`, { headers: { cookie: cookieFor(token) } });
        const html = await page.text();
        assert.match(html, /Text the week/);
        assert.match(html, /placeholder="Text the week/);
        assert.match(html, /Send/);
        assert.match(html, /Cancel /);
        assert.match(html, /name="answer" value="yes"/);
        assert.doesNotMatch(html, /class="bubble"/);

        const pending = await db.query<{ id: number }>('select id from assistant_pending where coach_id = $1 and consumed_at is null', [
          seed.coach.id,
        ]);
        const confirm = await fetch(`${base}/app/schedule/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieFor(token) },
          body: JSON.stringify({ id: String(pending.rows[0].id), answer: 'yes' }),
          redirect: 'manual',
        });
        assert.equal(confirm.status, 303);
      });
    } finally {
      resetComplete();
    }

    const session = await db.query<{ status: string }>('select status from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].status, 'cancelled');
  });
});

test('confidence under 0.75 and two sessions at the same time never guess a cancel', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    const six = tomorrowAt(seed.coach.tz, 18, 0);
    await pinSession(db, seed.sessionId, six);
    await db.query(
      `insert into session (session_type_id, starts_at_utc, tz, status) values ($1, $2, $3, 'scheduled')`,
      [seed.sessionTypeId, six.toISOString(), seed.coach.tz],
    );

    setComplete(fakeComplete({ intent: 'session.cancel', confidence: 0.5, session_id: seed.sessionId }));
    try {
      const low = await handleCoachMessage(db, seed.coach, 'scrub the later one maybe', 'sms');
      assert.equal(low.kind, 'unknown');
      assert.match(low.text, /didn't catch that/i);

      resetComplete();
      setComplete(fakeComplete(new Error('must not run when two sessions match')));
      const amb = await handleCoachMessage(db, seed.coach, 'cancel tomorrow 6pm', 'sms');
      assert.equal(amb.kind, 'unknown');
    } finally {
      resetComplete();
    }
  });
});

test('cancel everything next week is unknown and does not call the model', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const llm = fakeComplete({ intent: 'session.cancel', confidence: 0.99, session_id: seed.sessionId });
    setComplete(llm);
    try {
      const reply = await handleCoachMessage(db, seed.coach, 'cancel everything next week', 'sms');
      assert.equal(llm.calls.length, 0);
      assert.equal(reply.kind, 'unknown');
    } finally {
      resetComplete();
    }
  });
});

test('STOP and HELP are case-insensitive single tokens; original text reaches the model', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));

    const llm = fakeComplete({
      intent: 'money.summary',
      confidence: 0.9,
    });
    setComplete(llm);
    try {
      await withServer(async (base) => {
        const stop = await smsTo(base, '+15559876543', 'stop');
        assert.equal(stop.status, 200);
        assert.match(await stop.text(), /<Response><\/Response>/);

        const help = await smsTo(base, '+15559990000', 'HeLp');
        assert.equal(help.status, 200);
        assert.match(await help.text(), /<Message>/);

        const english = await smsTo(base, seed.coach.phone, 'What did I collect this week actually');
        assert.equal(english.status, 200);
        assert.equal(llm.calls.length, 1);
        const req = llm.calls[0] as { messages: Array<{ content: string }> };
        assert.equal(req.messages.at(-1)?.content, 'What did I collect this week actually');
      });
    } finally {
      resetComplete();
    }
    assert.equal(relay.sms.some((m) => /opted out/i.test(m.body)), false);
  });
});

test('roster live offer Y never reaches the model; other text gets one link a day', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    const member = await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');
    await checkOverflow(db, seed.sessionId);

    const llm = fakeComplete({ intent: 'session.cancel', confidence: 0.99, session_id: seed.sessionId });
    setComplete(llm);
    try {
      await withServer(async (base) => {
        await smsTo(base, seed.coach.phone, '2');
        const banana = await smsTo(base, member.phone, 'cancel tomorrow');
        assert.equal(banana.status, 200);
        assert.match(await banana.text(), /<Response/);
        await smsTo(base, member.phone, 'cancel tomorrow again');
        const yes = await smsTo(base, member.phone, 'Y');
        assert.equal(yes.status, 200);
        assert.match(await yes.text(), /<Response/);
      });
    } finally {
      resetComplete();
    }
    assert.equal(llm.calls.length, 0);
    const auto = relay.sms.filter((m) => m.to === member.phone && /reply Y or/i.test(m.body));
    assert.equal(auto.length, 1);
  });
});

test('second sentence re-asks then replaces the pending confirm', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');

    setComplete(fakeComplete(new Error('pattern only')));
    try {
      const first = await handleCoachMessage(db, seed.coach, 'cancel tomorrow 6pm', 'sms');
      assert.equal(first.kind, 'confirm');
      const reask = await handleCoachMessage(db, seed.coach, "who's at 6pm", 'sms');
      assert.equal(reask.kind, 'reask');
      assert.equal(reask.text, first.text);
      const replaced = await handleCoachMessage(db, seed.coach, "who's at 6pm", 'sms');
      assert.equal(replaced.kind, 'answer');
      assert.match(replaced.text, /Sam Reyes/);
    } finally {
      resetComplete();
    }
  });
});

test('overflow ask retires a waiting cancel; the coach answering 2 starts the cascade', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000001');
    await seedWaitlistEntry(db, seed.sessionId, 'Athlete Two', '+15550000002');

    setComplete(fakeComplete(new Error('pattern only')));
    try {
      const confirm = await handleCoachMessage(db, seed.coach, 'cancel tomorrow 6pm', 'sms');
      assert.equal(confirm.kind, 'confirm');
      await checkOverflow(db, seed.sessionId);

      await withServer(async (base) => {
        const yes = await smsTo(base, seed.coach.phone, '2');
        assert.equal(yes.status, 200);
        assert.match(await yes.text(), /<Response/);
      });
    } finally {
      resetComplete();
    }

    const session = await db.query<{ status: string }>('select status from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].status, 'scheduled');
    const offers = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]);
    assert.equal(offers.rows.length, 1);
  });
});

test('unknown numbers get one booking-link reply per day', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { grantSmsConsent } = await import('../src/domain/sms-consent.js');
    await grantSmsConsent(db, '+15559990000');
    await withServer(async (base) => {
      const first = await smsTo(base, '+15559990000', 'banana');
      assert.equal(first.status, 200);
      assert.match(await first.text(), /<Response/);
      const second = await smsTo(base, '+15559990000', 'banana');
      assert.equal(second.status, 200);
      assert.match(await second.text(), /<Response/);
    });
    const toThem = relay.sms.filter((m) => m.to === '+15559990000');
    assert.equal(toThem.length, 1);
    assert.match(toThem[0].body, /\/start\//);
    assert.match(toThem[0].body, new RegExp(APP_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('money.summary and schedule.query answer without a Y', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    setComplete(fakeComplete(new Error('pattern only')));
    try {
      const money = await handleCoachMessage(db, seed.coach, 'what did I collect', 'sms');
      assert.equal(money.kind, 'answer');
      assert.match(money.text, /This week/);
      const sched = await handleCoachMessage(db, seed.coach, "what's tomorrow", 'sms');
      assert.equal(sched.kind, 'answer');
    } finally {
      resetComplete();
    }
  });
});

test('N drops a pending confirm without writing the database', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    setComplete(fakeComplete(new Error('pattern only')));
    try {
      await handleCoachMessage(db, seed.coach, 'cancel tomorrow 6pm', 'sms');
      const dropped = await handleCoachMessage(db, seed.coach, 'n', 'sms');
      assert.equal(dropped.kind, 'dropped');
    } finally {
      resetComplete();
    }
    const session = await db.query<{ status: string }>('select status from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].status, 'scheduled');
  });
});

test('session.add, session.move, and broadcast.send confirm then execute', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');
    const newWhen = tomorrowAt(seed.coach.tz, 19, 0);

    setComplete(
      fakeComplete({
        intent: 'session.add',
        confidence: 0.95,
        session_id: null,
        session_type_id: seed.sessionTypeId,
        session_type: null,
        when: newWhen.toISOString(),
        new_when: null,
        location: 'South field',
        reason: null,
        source: 'model',
      }),
    );
    try {
      const add = await handleCoachMessage(db, seed.coach, 'add a group at 7pm on the south field', 'sms');
      assert.equal(add.kind, 'confirm');
      const added = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.equal(added.kind, 'done');
      assert.match(added.text, /Added /);
    } finally {
      resetComplete();
    }

    setComplete(
      fakeComplete({
        intent: 'session.move',
        confidence: 0.95,
        session_id: seed.sessionId,
        session_type_id: seed.sessionTypeId,
        session_type: null,
        when: null,
        new_when: tomorrowAt(seed.coach.tz, 20, 0).toISOString(),
        location: null,
        reason: null,
        source: 'model',
      }),
    );
    try {
      const move = await handleCoachMessage(db, seed.coach, 'move the 6pm to 8pm', 'sms');
      assert.equal(move.kind, 'confirm');
      const moved = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.equal(moved.kind, 'done');
      assert.match(moved.text, /Moved /);
    } finally {
      resetComplete();
    }

    setComplete(
      fakeComplete({
        intent: 'broadcast.send',
        confidence: 0.95,
        session_id: seed.sessionId,
        session_type_id: seed.sessionTypeId,
        session_type: null,
        when: null,
        new_when: null,
        location: null,
        reason: 'bring indoor shoes',
        source: 'model',
      }),
    );
    try {
      const ask = await handleCoachMessage(db, seed.coach, 'tell the 8pm group to bring indoor shoes', 'sms');
      assert.equal(ask.kind, 'confirm');
      assert.match(ask.text, /bring indoor shoes/);
      const sent = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.equal(sent.kind, 'done');
      assert.ok(relay.sms.some((m) => m.to === '+15550000001' && /bring indoor shoes/.test(m.body)));
    } finally {
      resetComplete();
    }
  });
});

test('model daily cap skips LiteLLM and fails closed', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const llm = fakeComplete({ intent: 'money.summary', confidence: 0.99 });
    setComplete(llm);
    try {
      for (let i = 0; i < 30; i += 1) {
        await db.query('insert into assistant_model_call (coach_id, called_at) values ($1, now())', [seed.coach.id]);
      }
      const reply = await handleCoachMessage(db, seed.coach, 'please tell me in a novel sentence how the till looks', 'sms');
      assert.equal(llm.calls.length, 0);
      assert.equal(reply.kind, 'unknown');
    } finally {
      resetComplete();
    }
  });
});

// ---- the time the model gives for an add or a move ---------------------

function addIntent(sessionTypeId: number, when: string, over: Partial<ClassifiedIntent> = {}) {
  return {
    intent: 'session.add',
    confidence: 0.95,
    session_id: null,
    session_type_id: sessionTypeId,
    session_type: null,
    when,
    new_when: null,
    location: null,
    reason: null,
    source: 'model',
    ...over,
  };
}

async function countSessions(db: Awaited<ReturnType<typeof freshDb>>, typeId: number): Promise<number> {
  const r = await db.query<{ n: string }>("select count(*)::text as n from session where session_type_id = $1 and status = 'scheduled'", [typeId]);
  return Number(r.rows[0].n);
}

async function pendingCount(db: Awaited<ReturnType<typeof freshDb>>, coachId: number): Promise<number> {
  const r = await db.query<{ n: string }>('select count(*)::text as n from assistant_pending where coach_id = $1 and consumed_at is null', [coachId]);
  return Number(r.rows[0].n);
}

test('a model time that is not a date gets the usual "didn\'t catch that", by text too', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    try {
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, 'banana')));
      const add = await handleCoachMessage(db, seed.coach, 'add a session some time soon', 'sms');
      assert.equal(add.kind, 'unknown');
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, '', { intent: 'session.move', session_id: seed.sessionId, new_when: 'soonish' })));
      const move = await handleCoachMessage(db, seed.coach, 'move it to soonish', 'sms');
      assert.equal(move.kind, 'unknown');
      await withServer(async (base) => {
        setComplete(fakeComplete(addIntent(seed.sessionTypeId, 'banana')));
        const res = await smsTo(base, seed.coach.phone as string, 'add a session some time soon');
        assert.equal(res.status, 200);
      });
    } finally {
      resetComplete();
    }
    assert.ok(relay.sms.some((m) => m.to === seed.coach.phone && /didn't catch that/.test(m.body)));
    assert.equal(await pendingCount(db, seed.coach.id), 0);
  });
});

test('an add in the past, past eight weeks, or on top of the same session is answered, not asked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const now = new Date();
    const existing = tomorrowAt(seed.coach.tz, 18, 0);
    await pinSession(db, seed.sessionId, existing);
    const cases: Array<[string, RegExp]> = [
      ['2020-01-07T18:00:00-06:00', /That time has already passed\./],
      [new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(), /I can schedule up to 8 weeks ahead\./],
      [existing.toISOString(), /You already have Goalkeeper Group /],
    ];
    try {
      for (const [when, reply] of cases) {
        const llm = fakeComplete(addIntent(seed.sessionTypeId, when));
        setComplete(llm);
        const answer = await handleCoachMessage(db, seed.coach, 'add the group then', 'sms', now);
        assert.equal(answer.kind, 'answer', when);
        assert.match(answer.text, reply);
        const system = JSON.stringify(llm.calls[0]);
        assert.ok(system.includes(`Now: `) && system.includes(now.toISOString()), 'the model is told the current time');
      }
    } finally {
      resetComplete();
    }
    assert.equal(await pendingCount(db, seed.coach.id), 0);
    assert.equal(await countSessions(db, seed.sessionTypeId), 1);
  });
});

test('an add that overlaps another session says so in the question, and a Y after its time has passed adds nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const existing = tomorrowAt(seed.coach.tz, 18, 0);
    await pinSession(db, seed.sessionId, existing);
    try {
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, new Date(existing.getTime() + 30 * 60_000).toISOString())));
      const ask = await handleCoachMessage(db, seed.coach, 'add a group at 6:30', 'sms');
      assert.equal(ask.kind, 'confirm');
      assert.match(ask.text, /Overlaps Goalkeeper Group at 6:00pm\. Reply Y\.$/);
      const yes = await handleCoachMessage(db, seed.coach, 'Y', 'sms');
      assert.equal(yes.kind, 'done');
      assert.equal(await countSessions(db, seed.sessionTypeId), 2);

      // Asked five minutes before the time, answered six minutes later.
      const t0 = new Date();
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, new Date(t0.getTime() + 5 * 60_000).toISOString())));
      const soon = await handleCoachMessage(db, seed.coach, 'add one in five minutes', 'sms', t0);
      assert.equal(soon.kind, 'confirm');
      const late = await handleCoachMessage(db, seed.coach, 'Y', 'sms', new Date(t0.getTime() + 6 * 60_000));
      assert.equal(late.kind, 'done');
      assert.equal(late.text, 'That time has already passed.');
      assert.equal(await countSessions(db, seed.sessionTypeId), 2);
    } finally {
      resetComplete();
    }
  });
});

test('a long add question still ends "Reply Y." once the brand is put in front and it is fitted to one text', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const existing = tomorrowAt(seed.coach.tz, 18, 0);
    await pinSession(db, seed.sessionId, existing);
    const overlapping = new Date(existing.getTime() + 30 * 60_000).toISOString();
    const clear = tomorrowAt(seed.coach.tz, 9, 0).toISOString();
    try {
      // Places from short to long, so the question passes every length near
      // one segment, with and without the overlap note.
      for (const when of [clear, overlapping]) {
        for (let n = 30; n <= 130; n += 2) {
          // Each question is one model call; keep under the daily cap.
          await db.query('delete from assistant_model_call');
          const location = `the far field by the ${'l'.repeat(n - 26)}ake path`;
          setComplete(fakeComplete(addIntent(seed.sessionTypeId, when, { location })));
          const ask = await handleCoachMessage(db, seed.coach, 'add a group there', 'sms');
          assert.equal(ask.kind, 'confirm', `${n}`);
          const sent = composeText(ask.text, 'assistant');
          assert.equal(segmentCount(sent), 1, `${n}: ${sent.length} characters`);
          assert.match(sent, /^Coachatron: Add 60-min Goalkeeper Group /);
          assert.match(sent, / Reply Y\.$/, `${n}: ${sent}`);
          if (when === overlapping) assert.match(sent, /Overlaps (Goalkeeper Group at 6:00pm|another session)\. Reply Y\.$/);
          assert.equal((await handleCoachMessage(db, seed.coach, 'N', 'sms')).kind, 'dropped');
        }
      }

      // A place written in letters outside GSM-7 makes the text UCS-2, 70
      // characters; the question still ends "Reply Y."
      await db.query('delete from assistant_model_call');
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, clear, { location: '体育场 north field, the one past the gate' })));
      const wide = await handleCoachMessage(db, seed.coach, 'add a group there', 'sms');
      const wideSent = composeText(wide.text, 'assistant');
      assert.equal(segmentCount(wideSent), 1, wideSent);
      assert.match(wideSent, / Reply Y\.$/);
      await handleCoachMessage(db, seed.coach, 'N', 'sms');

      // The same, end to end: the text the coach gets.
      await db.query('delete from assistant_model_call');
      setComplete(fakeComplete(addIntent(seed.sessionTypeId, overlapping, { location: `the far field by the ${'l'.repeat(100)}ake` })));
      await withServer(async (base) => {
        const res = await smsTo(base, seed.coach.phone as string, 'add a group there');
        assert.equal(res.status, 200);
      });
      const reply = relay.sms.filter((m) => m.to === seed.coach.phone).pop();
      assert.ok(reply, 'the question was texted');
      assert.equal(segmentCount(reply.body), 1);
      assert.match(reply.body, /^Coachatron: Add .*Overlaps another session\. Reply Y\.$/);
    } finally {
      resetComplete();
    }
  });
});

test('the assistant counts spots as Schedule does; WHO and a broadcast still mean the athletes still booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 6 });
    await pinSession(db, seed.sessionId, tomorrowAt(seed.coach.tz, 18, 0));
    await seedBookedSession(db, seed.sessionId, 'Ada Booked', '+15550007401');
    // The attendance route has no time check, so a session still ahead can
    // already have athletes marked attended or no-show.
    const attended = await seedBookedSession(db, seed.sessionId, 'Ben Attended', '+15550007402');
    await db.query("update booking set status = 'attended' where id = $1", [attended]);
    const noshow = await seedBookedSession(db, seed.sessionId, 'Cal Noshow', '+15550007403');
    await db.query("update booking set status = 'noshow' where id = $1", [noshow]);
    const cancelled = await seedBookedSession(db, seed.sessionId, 'Dee Cancelled', '+15550007404');
    await db.query("update booking set status = 'cancelled' where id = $1", [cancelled]);

    const cookie = cookieFor(await createCoachSession(db, seed.coach.id));
    await withServer(async (base) => {
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, / · 3 of 6 spots booked · /, 'Schedule counts Ada, Ben and Cal');
    });

    setComplete(fakeComplete(new Error('pattern only')));
    try {
      const sched = await handleCoachMessage(db, seed.coach, "what's tomorrow", 'sms');
      assert.equal(sched.kind, 'answer');
      assert.match(sched.text, /\(3\/6\)/, 'the same count as Schedule');
      const who = await handleCoachMessage(db, seed.coach, "who's at 6pm", 'sms');
      assert.match(who.text, /\b1 at /, 'WHO counts the names it lists');
      assert.match(who.text, /Ada Booked/);
      assert.doesNotMatch(who.text, /Ben Attended|Cal Noshow|Dee Cancelled/);
    } finally {
      resetComplete();
    }

    const llm = fakeComplete({
      intent: 'broadcast.send',
      confidence: 0.95,
      session_id: seed.sessionId,
      session_type_id: seed.sessionTypeId,
      session_type: null,
      when: null,
      new_when: null,
      location: null,
      reason: 'bring indoor shoes',
      source: 'model',
    });
    setComplete(llm);
    try {
      const ask = await handleCoachMessage(db, seed.coach, 'tell the 6pm group to bring indoor shoes', 'sms');
      assert.equal(llm.calls.length, 1);
      const system = (llm.calls[0] as { messages: Array<{ role: string; content: string }> }).messages[0].content;
      assert.match(system, new RegExp(`id=${seed.sessionId} .* spots=3/6`), 'the model sees the same count');
      assert.equal(ask.kind, 'confirm');
      assert.match(ask.text, /Text 1 athletes/, 'a broadcast texts only Ada, who is still booked');
    } finally {
      resetComplete();
    }
  });
});
