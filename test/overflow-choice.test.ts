import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { acceptOffer, answerAsk, checkOverflow, startCascade } from '../src/domain/cascade.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { createCoachSession } from '../src/domain/auth.js';
import { runTick } from '../src/jobs/tick.js';
import { setComplete, resetComplete } from '../src/llm/complete.js';
import { fakeComplete } from './fakes/llm.js';
import type { DbClient } from '../src/db/client.js';
import { zoneAt } from './helpers/clock.js';

/** SPEC.md §7.3 as decided: the coach picks a second group (1) or a backup
 * coach (2) for each full session, by text or on the schedule, and the
 * roster is offered that job one person at a time. */

async function fullSession(db: DbClient, opts: { capacity?: number; location?: string } = {}) {
  const capacity = opts.capacity ?? 1;
  const seed = await seedCoachWithSession(db, { capacity });
  // Midday for the coach, so spots that open are offered at once.
  await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
  if (opts.location) await db.query('update session set location_text = $2 where id = $1', [seed.sessionId, opts.location]);
  for (let i = 0; i < capacity; i += 1) {
    await seedBookedSession(db, seed.sessionId, `Athlete ${i + 1}`, `+1555000010${i}`);
  }
  await seedWaitlistEntry(db, seed.sessionId, 'Waiting Wendy', '+15550009001');
  return seed;
}

async function offers(db: DbClient, sessionId: number) {
  const r = await db.query<{ id: number; roster_member_id: number; state: string; kind: string; token: string }>(
    'select id, roster_member_id, state, kind, token from offer where session_id = $1 order by id',
    [sessionId],
  );
  return r.rows;
}

async function openAsks(db: DbClient, sessionId: number): Promise<number> {
  const r = await db.query<{ n: string }>('select count(*)::text as n from overflow_ask where session_id = $1 and closed_at is null', [
    sessionId,
  ]);
  return Number(r.rows[0].n);
}

function smsTo(base: string, from: string, body: string): Promise<Response> {
  return postSignedSms(base, { From: from, Body: body });
}

test('the ask names the session and the three choices in one text', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    const toCoach = relay.sms.filter((m) => m.to === seed.coach.phone);
    assert.equal(toCoach.length, 1);
    assert.match(
      toCoach[0].body,
      /^Coachatron: \w{3} \w{3} \d+ \d+(:\d\d)?[ap]m Goalkeeper Group is full with 1 waiting\. Reply 1 to open a second group, 2 to add a backup coach, N for no\./,
    );
    assert.ok(toCoach[0].body.length <= 160);
  });
});

test('a long session name is shortened so the choices stay whole', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await db.query('update session_type set name = $2 where id = $1', [seed.sessionTypeId, 'Advanced '.repeat(12).trim()]);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    const ask = relay.sms.find((m) => m.to === seed.coach.phone);
    assert.ok(ask);
    assert.ok(ask.body.length <= 160);
    assert.match(ask.body, /Reply 1 to open a second group, 2 to add a backup coach, N for no\./);
  });
});

test('the schedule asks the same question with three buttons, and 1 there starts a second-group cascade', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /is full<\/strong> with 1 waiting/);
      for (const value of ['1', '2', 'no']) assert.match(schedule, new RegExp(`name="answer" value="${value}"`));

      const res = await fetch(`${base}/app/overflow/${seed.sessionId}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ answer: '1' }),
        redirect: 'manual',
      });
      assert.equal(res.status, 303);
      const after = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.doesNotMatch(after, /name="answer"/);
      assert.match(after, /Asking your roster for a second group/);
      assert.match(after, /Offered to Backup Bailey until/);
    });
    const sent = await offers(db, seed.sessionId);
    assert.deepEqual(sent.map((o) => [o.roster_member_id, o.kind, o.state]), [[member.id, 'second_group', 'sent']]);
    const offerText = relay.sms.find((m) => m.to === member.phone);
    assert.match(offerText!.body, /Coach a second Goalkeeper Group group .*up to 1 athlete\. Reply Y to claim \(20 min\)\./);
  });
});

test('an answer the schedule does not know changes nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      for (const answer of ['yes', '3', '']) {
        await fetch(`${base}/app/overflow/${seed.sessionId}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ answer }),
          redirect: 'manual',
        });
      }
    });
    assert.equal((await offers(db, seed.sessionId)).length, 0);
    assert.equal(await openAsks(db, seed.sessionId), 1);
  });
});

test('texting 1 opens a second group: the first to accept runs a new session at the same time, place and size', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db, { capacity: 2, location: 'Field 3' });
    const first = await seedRosterMember(db, seed.coach.id, 'Sam Second', 0);
    await seedRosterMember(db, seed.coach.id, 'Lee Later', 1);
    await checkOverflow(db, seed.sessionId);

    await withServer(async (base) => {
      assert.equal((await smsTo(base, seed.coach.phone, '1')).status, 200);
      assert.equal((await smsTo(base, first.phone, 'Y')).status, 200);
    });

    const original = await db.query<{ session_type_id: number; starts_at_utc: Date; location_text: string; capacity_override: number | null }>(
      'select session_type_id, starts_at_utc, location_text, capacity_override from session where id = $1',
      [seed.sessionId],
    );
    const groups = await db.query<{
      id: number;
      session_type_id: number;
      starts_at_utc: Date;
      location_text: string;
      capacity_override: number | null;
      assigned_roster_member_id: number;
      status: string;
    }>('select * from session where overflow_of = $1', [seed.sessionId]);
    assert.equal(groups.rows.length, 1);
    const group = groups.rows[0];
    assert.equal(group.session_type_id, original.rows[0].session_type_id);
    assert.equal(new Date(group.starts_at_utc).toISOString(), new Date(original.rows[0].starts_at_utc).toISOString());
    assert.equal(group.location_text, 'Field 3');
    assert.equal(group.capacity_override, null, 'the same capacity as its type');
    assert.equal(group.assigned_roster_member_id, first.id);
    assert.equal(group.status, 'scheduled');
    assert.equal(original.rows[0].capacity_override, null, 'the full session keeps its size');

    const claimed = relay.sms.filter((m) => m.to === seed.coach.phone && /took the second group/.test(m.body));
    assert.equal(claimed.length, 1, 'the coach hears who took it');
    assert.match(claimed[0].body, /Sam Second took the second group/);
  });
});

test('texting 2 adds a backup coach: the session grows by its type capacity', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db, { capacity: 2 });
    const member = await seedRosterMember(db, seed.coach.id, 'Bailey Backup', 0);
    await checkOverflow(db, seed.sessionId);
    await withServer(async (base) => {
      await smsTo(base, seed.coach.phone, '2');
      const offerText = relay.sms.find((m) => m.to === member.phone);
      assert.match(offerText!.body, /Backup coach for Goalkeeper Group .*2 athletes\. Reply Y/);
      await smsTo(base, member.phone, 'yes');
    });
    const session = await db.query<{ capacity_override: number; assigned_roster_member_id: number }>(
      'select capacity_override, assigned_roster_member_id from session where id = $1',
      [seed.sessionId],
    );
    assert.equal(session.rows[0].capacity_override, 4);
    assert.equal(session.rows[0].assigned_roster_member_id, member.id);
    const groups = await db.query('select id from session where overflow_of = $1', [seed.sessionId]);
    assert.equal(groups.rows.length, 0, 'no new session for a backup coach');
    assert.ok(relay.sms.some((m) => m.to === seed.coach.phone && /Bailey Backup is your backup coach, 2 more spots/.test(m.body)));

    await withServer(async (base) => {
      const page = await (await fetch(`${base}/c/${seed.coach.handle}`)).text();
      assert.match(page, /2 spots left/, 'the public page shows the new spots');
    });
  });
});

test('texting N closes the ask; nobody is offered anything and later joins do not ask again', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await withServer(async (base) => {
      await smsTo(base, seed.coach.phone, 'N');
    });
    assert.equal(await openAsks(db, seed.sessionId), 0);
    assert.equal((await offers(db, seed.sessionId)).length, 0);
    await seedWaitlistEntry(db, seed.sessionId, 'Waiting Walt', '+15550009002');
    await checkOverflow(db, seed.sessionId);
    assert.equal(relay.sms.filter((m) => m.to === seed.coach.phone).length, 1, 'one ask, no second one');
  });
});

test('a coach who answers Y is shown the choices again, and nothing starts', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await withServer(async (base) => {
      await smsTo(base, seed.coach.phone, 'Y');
    });
    const replies = relay.sms.filter((m) => m.to === seed.coach.phone);
    assert.equal(replies.length, 2);
    assert.match(replies[1].body, /reply 1 to open a second group, 2 to add a backup coach, or N for no/);
    assert.equal((await offers(db, seed.sessionId)).length, 0);
    assert.equal(await openAsks(db, seed.sessionId), 1);
  });
});

test('1 or 2 from anyone but the coach, or with no ask open, is an ordinary text', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    setComplete(fakeComplete({ intent: 'unknown', confidence: 0.2 }));
    try {
      await withServer(async (base) => {
        // No ask yet: the coach's 1 goes to the assistant.
        await smsTo(base, seed.coach.phone, '1');
        await checkOverflow(db, seed.sessionId);
        // A parent's or a roster member's 2 answers nothing.
        await smsTo(base, '+15550009001', '2');
        await smsTo(base, member.phone, '2');
      });
    } finally {
      resetComplete();
    }
    assert.equal((await offers(db, seed.sessionId)).length, 0);
    assert.equal(await openAsks(db, seed.sessionId), 1, 'still waiting on the coach');
  });
});

test('a coach answers one question at a time; the next full session is asked after the first is answered', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    const later = await db.query<{ id: number }>(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       values ($1, now() + interval '2 days', 'America/Chicago', 'scheduled') returning id`,
      [seed.sessionTypeId],
    );
    const secondId = later.rows[0].id;
    await seedBookedSession(db, secondId, 'Other Athlete', '+15550000200');
    await seedWaitlistEntry(db, secondId, 'Other Waiter', '+15550009100');

    await checkOverflow(db, seed.sessionId);
    await checkOverflow(db, secondId);
    assert.equal(relay.sms.filter((m) => m.to === seed.coach.phone).length, 1, 'one question in front of the coach');

    assert.equal(await answerAsk(db, seed.coach.id, 'no'), seed.sessionId);
    const asks = relay.sms.filter((m) => m.to === seed.coach.phone);
    assert.equal(asks.length, 2, 'the second session is asked about next');
    assert.equal(await openAsks(db, secondId), 1);
  });
});

test('a new waitlist join while an offer is out opens no second ask', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    await seedRosterMember(db, seed.coach.id, 'Second Choice', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    await seedWaitlistEntry(db, seed.sessionId, 'Waiting Walt', '+15550009002');
    await checkOverflow(db, seed.sessionId);
    assert.equal(relay.sms.filter((m) => m.to === seed.coach.phone).length, 1);
    const asks = await db.query<{ n: string }>('select count(*)::text as n from overflow_ask where session_id = $1', [seed.sessionId]);
    assert.equal(asks.rows[0].n, '1');
    assert.equal((await offers(db, seed.sessionId)).filter((o) => o.state === 'sent').length, 1);
  });
});

test('only one acceptance can win, even at the same moment, and later asks for the session start nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const first = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    await seedRosterMember(db, seed.coach.id, 'Second Choice', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'second_group');
    const [offer] = await offers(db, seed.sessionId);
    const results = await Promise.all([acceptOffer(db, offer.id), acceptOffer(db, offer.id), acceptOffer(db, offer.id)]);
    assert.equal(results.filter(Boolean).length, 1);
    const groups = await db.query<{ assigned_roster_member_id: number }>(
      'select assigned_roster_member_id from session where overflow_of = $1',
      [seed.sessionId],
    );
    assert.equal(groups.rows.length, 1, 'one second group');
    assert.equal(groups.rows[0].assigned_roster_member_id, first.id);

    await startCascade(db, seed.sessionId, 'backup');
    await startCascade(db, seed.sessionId, 'second_group');
    assert.deepEqual((await offers(db, seed.sessionId)).map((o) => o.state), ['accepted'], 'no further offers');
  });
});

test('accepting by text and on the page at the same moment gives the job once', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    const [offer] = await offers(db, seed.sessionId);
    await withServer(async (base) => {
      await Promise.all([
        smsTo(base, member.phone, 'Y'),
        fetch(`${base}/offer/${offer.token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: 'accept' }),
        }),
      ]);
    });
    const session = await db.query<{ capacity_override: number }>('select capacity_override from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].capacity_override, 2, 'the session grew once');
  });
});

test("a coach's cancel ends the open question: no card, and a 1 afterwards starts nothing", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    const result = await cancelScheduledSession(db, seed.coach.id, seed.sessionId);
    assert.equal(result.kind, 'cancelled');
    assert.equal(await openAsks(db, seed.sessionId), 0);
    await withServer(async (base) => {
      await smsTo(base, seed.coach.phone, '1');
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.doesNotMatch(schedule, /name="answer"/);
    });
    assert.equal((await offers(db, seed.sessionId)).length, 0);
  });
});

test("a coach's cancel withdraws the live offer: it cannot be claimed and nobody else is texted", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const first = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Second Choice', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    const [offer] = await offers(db, seed.sessionId);
    await cancelScheduledSession(db, seed.coach.id, seed.sessionId);
    assert.equal(await acceptOffer(db, offer.id), false);
    await withServer(async (base) => {
      await smsTo(base, first.phone, 'Y');
      const page = await (await fetch(`${base}/offer/${offer.token}`)).text();
      assert.match(page, /no longer open/);
      assert.doesNotMatch(page, /value="accept"/);
    });
    await runTick(db, new Date(Date.now() + 25 * 60 * 1000));
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 0);
    const session = await db.query<{ assigned_roster_member_id: number | null }>(
      'select assigned_roster_member_id from session where id = $1',
      [seed.sessionId],
    );
    assert.equal(session.rows[0].assigned_roster_member_id, null);
  });
});

test('the tick expires an offer at its time and moves on; a Y after that claims nothing', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const first = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Second Choice', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');

    await runTick(db, new Date(Date.now() + 19 * 60 * 1000));
    assert.deepEqual((await offers(db, seed.sessionId)).map((o) => o.state), ['sent'], 'not before its time');

    await runTick(db, new Date(Date.now() + 21 * 60 * 1000));
    assert.deepEqual(
      (await offers(db, seed.sessionId)).map((o) => [o.roster_member_id, o.state]),
      [
        [first.id, 'expired'],
        [second.id, 'sent'],
      ],
    );
    assert.equal(relay.sms.filter((m) => m.to === second.phone).length, 1);
    const [expired] = await offers(db, seed.sessionId);
    assert.equal(await acceptOffer(db, expired.id), false);
  });
});

test('a Y to an offer that has closed is told so once, and nothing else happens', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const first = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    const second = await seedRosterMember(db, seed.coach.id, 'Second Choice', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    await runTick(db, new Date(Date.now() + 21 * 60 * 1000));
    await withServer(async (base) => {
      assert.equal((await smsTo(base, first.phone, 'Y')).status, 200);
      assert.equal((await smsTo(base, first.phone, 'yes')).status, 200);
    });
    const toFirst = relay.sms.filter((m) => m.to === first.phone).map((m) => m.body);
    assert.equal(toFirst.length, 2, 'the offer, then one answer');
    assert.match(toFirst[1], /^Coachatron: that offer has closed, so nothing changed\./);
    assert.ok(!toFirst.some((b) => /\/start\//.test(b)), 'no sign-up link');
    assert.deepEqual(
      (await offers(db, seed.sessionId)).map((o) => [o.roster_member_id, o.state]),
      [
        [first.id, 'expired'],
        [second.id, 'sent'],
      ],
    );
  });
});

test('a second Y from the member who took the job is told it is theirs', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    await withServer(async (base) => {
      await smsTo(base, member.phone, 'Y');
      await smsTo(base, member.phone, 'Y');
    });
    assert.deepEqual((await offers(db, seed.sessionId)).map((o) => o.state), ['accepted']);
    const answers = relay.sms.filter((m) => m.to === member.phone && /you took this one/.test(m.body));
    assert.equal(answers.length, 1);
    assert.match(answers[0].body, /\/offer\/[0-9a-f]{32}/);
  });
});

test('an offer past its time cannot be accepted even before the tick runs', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'First Choice', 0);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    const [offer] = await offers(db, seed.sessionId);
    await db.query("update offer set expires_at = now() - interval '1 second' where id = $1", [offer.id]);
    assert.equal(await acceptOffer(db, offer.id), false);
  });
});

test('when everyone lets the offer pass, the coach is told once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const only = await seedRosterMember(db, seed.coach.id, 'Only One', 0);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'second_group');
    await withServer(async (base) => {
      await smsTo(base, only.phone, 'N');
    });
    await runTick(db, new Date(Date.now() + 25 * 60 * 1000));
    const told = relay.sms.filter((m) => m.to === seed.coach.phone && /nobody on your roster took the second group/.test(m.body));
    assert.equal(told.length, 1);
    assert.equal(await openAsks(db, seed.sessionId), 0);
  });
});

test('a question about a session that has started is closed by the tick', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await runTick(db, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
    assert.equal(await openAsks(db, seed.sessionId), 0);
  });
});

test('the offer page names the job', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    await seedRosterMember(db, seed.coach.id, 'Backup Bailey', 0);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'second_group');
    const [offer] = await offers(db, seed.sessionId);
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/offer/${offer.token}`)).text();
      assert.match(page, /<h1>Coach a second group<\/h1>/);
      assert.match(page, /a second group of up to 1 athlete, at the same time/);
      const accepted = await (
        await fetch(`${base}/offer/${offer.token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: 'accept' }),
        })
      ).text();
      assert.match(accepted, /no longer open \(accepted\)/);
    });
  });
});
