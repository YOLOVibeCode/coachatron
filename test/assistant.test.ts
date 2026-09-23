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

async function smsTo(base: string, from: string, body: string): Promise<Response> {
  return fetch(`${base}/webhooks/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, body }),
  });
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
    await seedBookedSession(db, seed.sessionId, 'Drop In', '+15550000012');

    setComplete(fakeComplete(new Error('model must not run')));
    try {
      await withServer(async (base) => {
        const ask = await smsTo(base, seed.coach.phone, "cancel tomorrow's 6pm, field's flooded");
        assert.equal(ask.status, 200);
        assert.equal(await ask.text(), 'confirm');
        const confirm = relay.sms.filter((m) => m.to === seed.coach.phone).at(-1);
        assert.ok(confirm);
        assert.match(confirm!.body, /Cancel /);
        assert.match(confirm!.body, /Reply Y/);
        assert.match(confirm!.body, /2 athletes/);

        const yes = await smsTo(base, seed.coach.phone, 'Y');
        assert.equal(await yes.text(), 'done');
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
        const stop = await smsTo(base, seed.coach.phone, 'stop');
        assert.equal(await stop.text(), 'opted out');

        const help = await smsTo(base, '+15559990000', 'HeLp');
        assert.equal(await help.text(), 'help sent');

        const english = await smsTo(base, seed.coach.phone, 'What did I collect this week actually');
        assert.equal(english.status, 200);
        assert.equal(llm.calls.length, 1);
        const req = llm.calls[0] as { messages: Array<{ content: string }> };
        assert.equal(req.messages.at(-1)?.content, 'What did I collect this week actually');
      });
    } finally {
      resetComplete();
    }
    assert.ok(relay.sms.some((m) => /opted out/i.test(m.body)));
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
        await smsTo(base, seed.coach.phone, 'Y');
        const banana = await smsTo(base, member.phone, 'cancel tomorrow');
        assert.equal(await banana.text(), 'offer link');
        await smsTo(base, member.phone, 'cancel tomorrow again');
        const yes = await smsTo(base, member.phone, 'Y');
        assert.equal(await yes.text(), 'offer accepted');
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

test('overflow ask retires a waiting cancel; overflow Y still starts the cascade', async () => {
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
        const yes = await smsTo(base, seed.coach.phone, 'Y');
        assert.equal(await yes.text(), 'cascade started');
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
    await freshDb();
    await withServer(async (base) => {
      const first = await smsTo(base, '+15559990000', 'banana');
      assert.equal(await first.text(), 'unrecognized');
      const second = await smsTo(base, '+15559990000', 'banana');
      assert.equal(await second.text(), 'unrecognized');
    });
    const toThem = relay.sms.filter((m) => m.to === '+15559990000');
    assert.equal(toThem.length, 1);
    assert.match(toThem[0].body, /link/i);
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
        new_when: newWhen.toISOString(),
        location: null,
        reason: null,
        source: 'model',
      }),
    );
    try {
      const move = await handleCoachMessage(db, seed.coach, 'move the 6pm to 7pm', 'sms');
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
      const ask = await handleCoachMessage(db, seed.coach, 'tell the 7pm group to bring indoor shoes', 'sms');
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
