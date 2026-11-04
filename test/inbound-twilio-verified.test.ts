import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { postSignedSms, postSignedSmsStatus } from './helpers/sms-webhook.js';
import { fakeComplete } from './fakes/llm.js';
import { isOptedOut } from '../src/domain/cascade.js';
import { grantSmsConsent, hasActiveConsent } from '../src/domain/sms-consent.js';
import { addCalendarDays, zonedParts, zonedTimeToUtc } from '../src/domain/scheduling.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import type { DbClient } from '../src/db/client.js';

/** The relay says whether Twilio's own signature checked out on each
 * inbound text and status callback. Only one it confirms is acted on. */

function tomorrowAt(tz: string, hour: number): Date {
  const p = zonedParts(new Date(), tz);
  const d = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedTimeToUtc(d.year, d.month, d.day, hour, 0, tz);
}

async function count(db: DbClient, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params)).rows[0].n);
}

async function coachWithSessionTomorrowAtSix(db: DbClient) {
  const seed = await seedCoachWithSession(db);
  await db.query('update session set starts_at_utc = $1 where id = $2', [tomorrowAt(seed.coach.tz, 18).toISOString(), seed.sessionId]);
  await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+15550000001');
  return seed;
}

test('a coach command the relay confirms came from Twilio is acted on', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithSessionTomorrowAtSix(db);
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: seed.coach.phone as string, Body: "cancel tomorrow's 6pm" }, { twilioVerified: '1' });
      assert.equal(res.status, 200);
    });
    assert.equal(await count(db, 'assistant_pending where coach_id = $1', [seed.coach.id]), 1, 'the cancel waits for the coach\'s Y');
  });
});

test('a correctly signed text the relay could not confirm came from Twilio is answered and ignored', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await coachWithSessionTomorrowAtSix(db);
    const parent = '+15551234567';
    await grantSmsConsent(db, parent);
    const llm = fakeComplete(new Error('the model must not run'));
    setComplete(llm);
    try {
      await withServer(async (base) => {
        for (const twilioVerified of ['0', null, 'yes']) {
          const coach = await postSignedSms(base, { From: seed.coach.phone as string, Body: "cancel tomorrow's 6pm" }, { twilioVerified });
          assert.equal(coach.status, 200, `header ${twilioVerified}`);
          assert.match(await coach.text(), /^<\?xml version="1\.0" encoding="UTF-8"\?><Response><\/Response>$/);

          const stop = await postSignedSms(base, { From: parent, Body: 'STOP' }, { twilioVerified });
          assert.equal(stop.status, 200);
          const help = await postSignedSms(base, { From: parent, Body: 'HELP' }, { twilioVerified });
          assert.doesNotMatch(await help.text(), /<Message>/);
          await postSignedSms(base, { From: '+15559990000', Body: 'Keeper group Tuesdays at 6, an hour, 8 kids, $35' }, { twilioVerified });
        }
      });
    } finally {
      resetComplete();
    }
    assert.equal(await count(db, 'assistant_pending where coach_id = $1', [seed.coach.id]), 0, 'nothing waits for a Y');
    assert.equal(await count(db, 'assistant_log'), 0, 'nothing reached the assistant');
    assert.equal(await isOptedOut(db, parent), false, 'the STOP was not recorded');
    assert.equal(await count(db, 'start_link'), 0, 'no start link was made');
    assert.equal(relay.sms.length, 0, 'nothing was texted back');
    assert.equal(llm.calls.length, 0);
  });
});

test('a STOP the relay confirms came from Twilio is recorded', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      assert.equal((await postSignedSms(base, { From: '+15551234567', Body: 'STOP' })).status, 200);
    });
    assert.equal(await isOptedOut(db, '+15551234567'), true);
  });
});

test('a wrong relay signature is still refused before the Twilio check', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      assert.equal((await postSignedSms(base, { From: '+15551234567', Body: 'STOP' }, { secret: 'not-the-secret' })).status, 401);
      assert.equal((await postSignedSms(base, { From: '+15551234567', Body: 'STOP' }, { signature: null })).status, 401);
    });
    assert.equal(await isOptedOut(db, '+15551234567'), false);
  });
});

// ---- delivery status callbacks ------------------------------------------

async function loggedText(db: DbClient, sid: string): Promise<void> {
  await db.query(
    `insert into message_log (to_phone, template, body, provider_id, sent_at, status, coach_id, channel)
     values ('+15551234567', 'reminder', 'Reminder', $1, now(), 'sent', null, 'sms')`,
    [sid],
  );
}

async function statusOf(db: DbClient, sid: string): Promise<string> {
  return (await db.query<{ status: string }>('select status from message_log where provider_id = $1', [sid])).rows[0].status;
}

test('a status callback the relay could not confirm came from Twilio changes nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await loggedText(db, 'SM100');
    await withServer(async (base) => {
      for (const twilioVerified of ['0', null, 'yes']) {
        const res = await postSignedSmsStatus(
          base,
          { MessageSid: 'SM100', MessageStatus: 'failed', ErrorCode: '21610', To: '+15551234567' },
          { twilioVerified },
        );
        assert.equal(res.status, 200, `header ${twilioVerified}`);
        assert.match(await res.text(), /^<\?xml version="1\.0" encoding="UTF-8"\?><Response><\/Response>$/);
      }
    });
    assert.equal(await isOptedOut(db, '+15551234567'), false, 'the number stays opted in');
    assert.equal(await hasActiveConsent(db, '+15551234567'), true);
    assert.equal(await statusOf(db, 'SM100'), 'sent', 'the logged status is unchanged');
  });
});

test('a status callback the relay confirms came from Twilio updates the log and records an opt-out', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await loggedText(db, 'SM101');
    await withServer(async (base) => {
      const res = await postSignedSmsStatus(
        base,
        { MessageSid: 'SM101', MessageStatus: 'failed', ErrorCode: '21610', To: '+15551234567' },
        { twilioVerified: '1' },
      );
      assert.equal(res.status, 200);
    });
    assert.equal(await statusOf(db, 'SM101'), 'failed');
    assert.equal(await isOptedOut(db, '+15551234567'), true);
  });
});

test('a status callback with a wrong relay signature is refused', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    await grantSmsConsent(db, '+15551234567');
    await withServer(async (base) => {
      const fields = { MessageSid: 'SM102', MessageStatus: 'failed', ErrorCode: '21610', To: '+15551234567' };
      assert.equal((await postSignedSmsStatus(base, fields, { secret: 'not-the-secret' })).status, 401);
    });
    assert.equal(await isOptedOut(db, '+15551234567'), false);
  });
});
