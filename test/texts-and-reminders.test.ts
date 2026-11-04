import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { composeText, segmentCount, toGsmLetters } from '../src/domain/outbound.js';
import { helpReplyText } from '../src/routes/webhooks.js';
import { runTick } from '../src/jobs/tick.js';
import { SUPPORT_EMAIL } from '../src/config.js';
import type { DbClient } from '../src/db/client.js';

/** Every text is one segment, whatever the names in it, and a reminder the
 * relay could not send is sent on a later tick. */

const MORNING = new Date('2026-10-20T15:00:00Z'); // 10am in Chicago

async function pinSession(db: DbClient, sessionId: number, startsAt: Date): Promise<void> {
  await db.query('update session set starts_at_utc = $1, location_text = $2 where id = $3', [startsAt.toISOString(), 'Field 3', sessionId]);
}

test('accented letters outside GSM-7 are written plain, so a name keeps the text in one 160-character segment', () => {
  // ñ and Ç are GSM-7 and stay; í, ë, ú, ã, Ł and ğ are not and are written plain.
  assert.equal(toGsmLetters('García Peña, Zoë, Ana Lúcia, João, Łukasz, Çağla'), 'Garcia Peña, Zoe, Ana Lucia, Joao, Lukasz, Çagla');
  const body = "Coachatron: María José García-Núñez's Goalkeeper Group is Wed Oct 21, 9:00am at Field 3.";
  const text = composeText(body, 'reminder');
  assert.equal(segmentCount(text), 1);
  assert.ok(text.length > 70, 'GSM-7, not UCS-2');
  assert.match(text, /Maria José Garcia-Nuñez's Goalkeeper Group is Wed Oct 21, 9:00am at Field 3\. Reply STOP to opt out\.$/);
  // A name with no plain spelling still goes out as one UCS-2 segment.
  const wide = composeText("Coachatron: 李小龍's Goalkeeper Group is Wed Oct 21, 9:00am at Field 3.", 'reminder');
  assert.equal(segmentCount(wide), 1);
  assert.match(wide, /Reply STOP to opt out\.$/);
});

test('the HELP reply is one segment with the brand, the support address and how to stop', async () => {
  const text = helpReplyText();
  assert.equal(segmentCount(text), 1, `${text.length} characters`);
  assert.ok(text.length <= 160);
  assert.match(text, /^Coachatron/);
  assert.ok(text.includes(SUPPORT_EMAIL));
  assert.match(text, /Msg & data rates may apply\. Reply STOP to opt out\.$/);
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const res = await postSignedSms(base, { From: '+15551234567', Body: 'HELP' });
      assert.match(res.headers.get('content-type') ?? '', /xml/);
      const xml = await res.text();
      assert.equal(xml, `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text.replace(/&/g, '&amp;')}</Message></Response>`);
    });
    assert.equal(relay.sms.length, 0, 'the reply is the TwiML, not a second text');
  });
});

test('a reminder for an athlete with an accent in their name still says when and where', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    await pinSession(db, seed.sessionId, new Date(MORNING.getTime() + 23 * 60 * 60 * 1000));
    await seedBookedSession(db, seed.sessionId, 'García', '+15550000001');
    await runTick(db, MORNING);
    const reminder = relay.sms.find((m) => m.to === '+15550000001');
    assert.ok(reminder, 'a reminder was sent');
    assert.equal(reminder.body, "Coachatron: Garcia's Goalkeeper Group is Wed Oct 21, 9:00am at Field 3. Reply STOP to opt out.");
  });
});
