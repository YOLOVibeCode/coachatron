import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedCoachWithSession } from './helpers/fixtures.js';
import { recordConsent, revokeConsent } from '../src/domain/sms-consent.js';
import type { DbClient } from '../src/db/client.js';

/** A number's consent record says where, from which browser and when the
 * person opted in. A form anyone can fill in (booking, waitlist) adds a
 * record for a number that has none, but never rewrites one that exists or
 * undoes a revoked consent. Proving the number (a code texted to it) does. */

const PHONE = '+15553334444';

interface ConsentRow {
  source: string;
  ip: string | null;
  user_agent: string | null;
  consented_at: string;
  revoked_at: string | null;
}

async function consentRow(db: DbClient, phone: string): Promise<ConsentRow | null> {
  const r = await db.query<ConsentRow>('select source, ip, user_agent, consented_at, revoked_at from sms_consent where phone = $1', [phone]);
  return r.rows[0] ?? null;
}

function post(base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

const OTHER_BROWSER = { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'someone-else/1.0' };

test('the booking and waitlist forms leave an existing consent record as it was', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const open = await seedCoachWithSession(db, { capacity: 4 });
    const full = await seedCoachWithSession(db, { capacity: 1 });
    await recordConsent(db, PHONE, '/signin/verify', { ip: '203.0.113.5', userAgent: 'owner-phone/1.0', numberVerified: true });
    const before = await consentRow(db, PHONE);
    await withServer(async (base) => {
      const book = await post(
        base,
        `/c/${open.coach.handle}/sessions/${open.sessionId}/book`,
        { athlete_name: 'Sam', contact_phone: '5553334444', sms_consent: '1' },
        OTHER_BROWSER,
      );
      assert.equal(book.status, 303);
      await post(base, `/c/${full.coach.handle}/sessions/${full.sessionId}/book`, { athlete_name: 'Ana', contact_phone: '5550001212' });
      const join = await post(
        base,
        `/c/${full.coach.handle}/sessions/${full.sessionId}/waitlist`,
        { athlete_name: 'Sam', contact_phone: '5553334444', sms_consent: '1' },
        OTHER_BROWSER,
      );
      assert.equal(join.status, 200);
    });
    assert.deepEqual(await consentRow(db, PHONE), before);
  });
});

test('a ticked box on the booking or waitlist form does not undo a revoked consent', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    // One spot: the booking form's hold fills it, so the waitlist form joins.
    const seed = await seedCoachWithSession(db, { capacity: 1 });
    await recordConsent(db, PHONE, '/signin/verify', { ip: '203.0.113.5', userAgent: 'owner-phone/1.0', numberVerified: true });
    await revokeConsent(db, PHONE);
    const before = await consentRow(db, PHONE);
    assert.ok(before?.revoked_at);
    await withServer(async (base) => {
      for (const path of ['book', 'waitlist']) {
        await post(
          base,
          `/c/${seed.coach.handle}/sessions/${seed.sessionId}/${path}`,
          { athlete_name: 'Sam', contact_phone: '5553334444', sms_consent: '1' },
          OTHER_BROWSER,
        );
      }
    });
    assert.deepEqual(await consentRow(db, PHONE), before);
  });
});

test('a number with no record is recorded from the form, and proving the number replaces the record', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    await withServer(async (base) => {
      await post(
        base,
        `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`,
        { athlete_name: 'Sam', contact_phone: '5553334444', sms_consent: '1' },
        OTHER_BROWSER,
      );
    });
    const first = await consentRow(db, PHONE);
    assert.equal(first?.source, `/c/${seed.coach.handle}/sessions/${seed.sessionId}/book`);
    assert.equal(first?.ip, '198.51.100.9');
    assert.equal(first?.user_agent, 'someone-else/1.0');

    await recordConsent(db, PHONE, '/signin/verify', { ip: '203.0.113.5', userAgent: 'owner-phone/1.0', numberVerified: true });
    const proved = await consentRow(db, PHONE);
    assert.deepEqual([proved?.source, proved?.ip, proved?.user_agent], ['/signin/verify', '203.0.113.5', 'owner-phone/1.0']);
  });
});
