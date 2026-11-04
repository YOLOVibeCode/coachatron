import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { answerAsk, checkOverflow, declineOffer } from '../src/domain/cascade.js';
import { createCoachSession } from '../src/domain/auth.js';
import { hasActiveConsent, revokeConsent } from '../src/domain/sms-consent.js';
import type { DbClient } from '../src/db/client.js';

/** Roster members who cannot get texts are not offered anything, and the
 * coach is told who they are, with a link to send each one to opt in
 * (screen 12, in its opt-in state). */

async function fullSession(db: DbClient) {
  const seed = await seedCoachWithSession(db, { capacity: 1 });
  await seedBookedSession(db, seed.sessionId, 'Athlete One', '+15550000101');
  await seedWaitlistEntry(db, seed.sessionId, 'Waiting Wendy', '+15550009001');
  return seed;
}

async function optInToken(db: DbClient, memberId: number): Promise<string> {
  const r = await db.query<{ optin_token: string }>('select optin_token from roster_member where id = $1', [memberId]);
  return r.rows[0].optin_token;
}

async function offersFor(db: DbClient, sessionId: number) {
  const r = await db.query<{ roster_member_id: number; state: string }>(
    'select roster_member_id, state from offer where session_id = $1 order by id',
    [sessionId],
  );
  return r.rows;
}

function form(fields: Record<string, string>) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  };
}

test('a member who cannot get texts is passed over, and the coach gets their opt-in link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const silent = await seedRosterMember(db, seed.coach.id, 'Quiet Quinn', 0, { consent: false });
    const reachable = await seedRosterMember(db, seed.coach.id, 'Ready Riley', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');

    assert.deepEqual((await offersFor(db, seed.sessionId)).map((o) => o.roster_member_id), [reachable.id]);
    assert.equal(relay.sms.filter((m) => m.to === silent.phone).length, 0, 'no text to a number that has not opted in');

    const token = await optInToken(db, silent.id);
    const told = relay.sms.filter((m) => m.to === seed.coach.phone && /can't get texts yet/.test(m.body));
    assert.equal(told.length, 1);
    assert.match(told[0].body, /Quiet Quinn can't get texts yet, so wasn't asked\./);
    assert.ok(told[0].body.includes(`/offer/${token}`), 'the whole link is in the text');
    assert.ok(told[0].body.length <= 160);

    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      const schedule = await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text();
      assert.match(schedule, /Not asked, because they can't get texts yet/);
      assert.match(schedule, new RegExp(`Quiet Quinn · <a href="[^"]*/offer/${token}"`));
    });

    // Telling the coach happens once, not on every move of the cascade.
    const [offer] = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]).then((r) => r.rows);
    await declineOffer(db, offer.id);
    assert.equal(relay.sms.filter((m) => m.to === seed.coach.phone && /can't get texts yet/.test(m.body)).length, 1);
  });
});

test('with several who cannot get texts, the text points to the roster screen, which has each link', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const a = await seedRosterMember(db, seed.coach.id, 'Quiet Quinn', 0, { consent: false });
    const b = await seedRosterMember(db, seed.coach.id, 'Silent Sam', 1, { consent: false });
    await seedRosterMember(db, seed.coach.id, 'Ready Riley', 2);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'second_group');

    const told = relay.sms.find((m) => m.to === seed.coach.phone && /can't get texts yet/.test(m.body));
    assert.ok(told);
    assert.match(told.body, /Quiet Quinn and 1 more on your roster can't get texts yet/);
    assert.match(told.body, /\/app\/roster/);

    await withServer(async (base) => {
      const cookie = `cx_session=${await createCoachSession(db, seed.coach.id)}`;
      const roster = await (await fetch(`${base}/app/roster`, { headers: { cookie } })).text();
      for (const member of [a, b]) assert.ok(roster.includes(`/offer/${await optInToken(db, member.id)}`));
      assert.equal((roster.match(/Send them their link to opt in/g) ?? []).length, 2, 'no link for the one who opted in');
    });
  });
});

test('when nobody can get texts, nobody is offered anything and the coach is told why, once', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const silent = await seedRosterMember(db, seed.coach.id, 'Quiet Quinn', 0, { consent: false });
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');

    assert.equal((await offersFor(db, seed.sessionId)).length, 0);
    const toCoach = relay.sms.filter((m) => m.to === seed.coach.phone).map((m) => m.body);
    assert.equal(toCoach.length, 2, 'the ask, then one message');
    assert.match(toCoach[1], /nobody asked\. Quiet Quinn can't get texts yet/);
    assert.ok(toCoach[1].includes(`/offer/${await optInToken(db, silent.id)}`));
    assert.ok(!toCoach.some((b) => /took the/.test(b)), 'never told that someone turned it down');
  });
});

test('the opt-in link shows who is asking and records consent only with the box checked', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Quiet Quinn', 0, { consent: false });
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    const token = await optInToken(db, member.id);

    await withServer(async (base) => {
      const page = await fetch(`${base}/offer/${token}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const body = await page.text();
      assert.match(body, /<h1>Get offers from Jamie Coach<\/h1>/);
      assert.match(body, new RegExp(`••••${member.phone.slice(-4)}`));
      assert.doesNotMatch(body, new RegExp(member.phone.replace('+', '\\+')), 'the full number is not shown');
      assert.match(body, /name="sms_consent"/);
      assert.doesNotMatch(body, /checked/);

      const unchecked = await fetch(`${base}/offer/${token}`, form({ action: 'optin' }));
      assert.equal(unchecked.status, 422);
      assert.equal(await hasActiveConsent(db, member.phone), false);

      const other = await fetch(`${base}/offer/${token}`, form({ action: 'accept', sms_consent: '1' }));
      assert.equal(other.status, 422);
      assert.equal(await hasActiveConsent(db, member.phone), false);

      const checked = await fetch(`${base}/offer/${token}`, form({ action: 'optin', sms_consent: '1' }));
      assert.equal(checked.status, 200);
      assert.match(await checked.text(), /You're opted in/);
    });
    assert.equal(await hasActiveConsent(db, member.phone), true);
    const consent = await db.query<{ source: string }>('select source from sms_consent where phone = $1', [member.phone]);
    assert.equal(consent.rows[0].source, '/offer (roster opt-in)');
    assert.equal(relay.sms.filter((m) => m.to === member.phone).length, 1, 'one confirmation text');
  });
});

test('a member who opts in mid-cascade is offered the job when it next moves', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const late = await seedRosterMember(db, seed.coach.id, 'Quiet Quinn', 0, { consent: false });
    const ready = await seedRosterMember(db, seed.coach.id, 'Ready Riley', 1);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    await withServer(async (base) => {
      await fetch(`${base}/offer/${await optInToken(db, late.id)}`, form({ action: 'optin', sms_consent: '1' }));
      await postSignedSms(base, { From: ready.phone, Body: 'N' });
    });
    assert.deepEqual(
      (await offersFor(db, seed.sessionId)).map((o) => [o.roster_member_id, o.state]),
      [
        [ready.id, 'declined'],
        [late.id, 'sent'],
      ],
    );
    assert.ok(relay.sms.some((m) => m.to === late.phone && /Backup coach for/.test(m.body)));
  });
});

test('a number that replied STOP is not opted back in from the link', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await fullSession(db);
    const member = await seedRosterMember(db, seed.coach.id, 'Stopped Stu', 0);
    await revokeConsent(db, member.phone);
    await checkOverflow(db, seed.sessionId);
    await answerAsk(db, seed.coach.id, 'backup');
    const token = await optInToken(db, member.id);
    await withServer(async (base) => {
      const page = await (await fetch(`${base}/offer/${token}`)).text();
      assert.match(page, /opted out of Coachatron texts\. Reply START/);
      const res = await fetch(`${base}/offer/${token}`, form({ action: 'optin', sms_consent: '1' }));
      assert.equal(res.status, 422);
    });
    assert.equal(await hasActiveConsent(db, member.phone), false);
  });
});

test('an unknown or malformed link is a 404', async () => {
  await withRelay(async () => {
    await freshDb();
    await withServer(async (base) => {
      for (const token of ['A'.repeat(22), 'not a token', '0'.repeat(32)]) {
        assert.equal((await fetch(`${base}/offer/${encodeURIComponent(token)}`)).status, 404);
        assert.equal((await fetch(`${base}/offer/${encodeURIComponent(token)}`, form({ action: 'optin', sms_consent: '1' }))).status, 404);
      }
    });
  });
});
