import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { raceDb, skipWithoutPostgres, type RaceDb } from './helpers.js';
import { withRelay } from '../helpers/relay.js';
import { withServer } from '../helpers/server.js';
import { seedBookedSession, seedCoachWithSession } from '../helpers/fixtures.js';
import { ask, emailedToken, enterCode, from, myCookie, proveEmail, proveMobile, sessionsPage, textedCode, useLink, visible } from '../helpers/my-sessions.js';
import { consumeMySessionsLink, createMySessionsLink, newMySessionsLinkToken } from '../../src/domain/mySessionsProof.js';
import { createCredit } from '../../src/domain/pricing.js';
import type { DbClient } from '../../src/db/client.js';

/** A proof for the My sessions page works once, also when it arrives many
 * times at the same moment: several connections on real Postgres
 * (TEST_DATABASE_URL; skipped without it), which PGlite cannot show because
 * it runs one statement at a time. */

const RACE = { skip: skipWithoutPostgres, timeout: 60_000 };

let race: RaceDb | null = null;
const db = (): DbClient => {
  assert.ok(race, 'the race database is set up');
  return race.db;
};

before(async () => {
  if (!skipWithoutPostgres) race = await raceDb();
});
after(async () => {
  await race?.close();
});

test('an emailed link used many times at once opens the page once', RACE, async () => {
  const token = newMySessionsLinkToken();
  await createMySessionsLink(db(), 'race@example.com', token);
  const uses = await Promise.all(Array.from({ length: 8 }, () => consumeMySessionsLink(db(), token)));
  assert.deepEqual(
    uses.filter((email) => email !== null),
    ['race@example.com'],
    'one use got the email, the others nothing',
  );

  await withRelay(async (relay) => {
    await withServer(async (base) => {
      await ask(base, 'pat@example.com');
      const emailed = emailedToken(relay, 'pat@example.com');
      const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => useLink(base, emailed, from(`203.0.113.${i + 1}`))));
      assert.deepEqual(responses.map((r) => r.status).sort(), [303, 410, 410, 410, 410, 410]);
      assert.equal(responses.filter((r) => myCookie(r) !== null).length, 1, 'one request got the cookie');
    });
  });
});

test('a texted code entered many times at once opens the page once', RACE, async () => {
  await withRelay(async (relay) => {
    await withServer(async (base) => {
      const phone = '+15558880001';
      await ask(base, phone);
      const code = textedCode(relay, phone);
      const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => enterCode(base, phone, code, from(`203.0.113.${i + 11}`))));
      assert.deepEqual(responses.map((r) => r.status).sort(), [303, 401, 401, 401, 401, 401]);
      assert.equal(responses.filter((r) => myCookie(r) !== null).length, 1, 'one request got the cookie');
    });
  });
});

test('the page reads bookings and credits on Postgres as it does in tests', RACE, async () => {
  await withRelay(async (relay) => {
    const seed = await seedCoachWithSession(db(), { capacity: 4 });
    const phone = '+15558880002';
    const booking = await seedBookedSession(db(), seed.sessionId, 'Mia', phone);
    await db().query("update booking set contact_email = 'Pat.Lee@Example.com' where id = $1", [booking]);
    await seedBookedSession(db(), seed.sessionId, 'Zoe', '+15558880003');
    await createCredit(db(), seed.coach.id, phone, null, 'test', 3, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    await withServer(async (base) => {
      const byMobile = visible(await (await sessionsPage(base, await proveMobile(base, relay, phone, from('203.0.113.21')))).text());
      assert.match(byMobile, /Coming up .*Mia · Goalkeeper Group Jamie Coach/);
      assert.match(byMobile, /Session credits Jamie Coach 3 sessions left 3 expire /);
      assert.doesNotMatch(byMobile, /Zoe/);
      const byEmail = visible(await (await sessionsPage(base, await proveEmail(base, relay, 'pat.lee@example.com', from('203.0.113.22')))).text());
      assert.match(byEmail, /Coming up .*Mia · Goalkeeper Group Jamie Coach/);
      assert.match(byEmail, /Verify your mobile to see credits\./);
      assert.doesNotMatch(byEmail, /Zoe|sessions left/);
    });
  });
});
