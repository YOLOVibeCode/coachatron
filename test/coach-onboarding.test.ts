import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { startFakeRelay } from './fakes/relay.js';

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const match = setCookie.map((c) => /^cx_session=([^;]+)/.exec(c)).find(Boolean);
  assert.ok(match, `expected a cx_session cookie in Set-Cookie headers: ${JSON.stringify(setCookie)}`);
  return `cx_session=${match![1]}`;
}

test('coach onboarding: OTP sign-in, session type, weekly schedule, public page', async () => {
  const relay = await startFakeRelay();
  process.env.RELAY_BASE_URL = relay.url;
  const db = await freshDb();

  try {
    await withServer(async (base) => {
      // 1. Request an OTP.
      const otpRes = await fetch(`${base}/signin/otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '5551234567' }),
        redirect: 'manual',
      });
      assert.equal(otpRes.status, 303);
      const location = otpRes.headers.get('location') ?? '';
      const phone = decodeURIComponent(new URL(location, base).searchParams.get('phone') ?? '');
      assert.equal(phone, '+15551234567');

      const sentSms = relay.sms.find((m) => m.to === '+15551234567');
      assert.ok(sentSms, 'expected the coach to have been sent an OTP by SMS');
      const codeMatch = /code is (\d{6})/.exec(sentSms!.body);
      assert.ok(codeMatch, `expected a 6-digit code in the SMS body: ${sentSms!.body}`);
      const code = codeMatch![1];

      // 2. Verify the OTP, completing the first-time profile in the same step.
      const verifyRes = await fetch(`${base}/signin/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone,
          code,
          name: 'Jamie Coach',
          email: 'jamie@example.com',
          tz: 'America/Chicago',
        }),
        redirect: 'manual',
      });
      assert.equal(verifyRes.status, 303, 'expected a redirect to /app/schedule on successful verify');
      const cookie = extractSessionCookie(verifyRes as unknown as Response);

      // 3. Create a session type.
      const createTypeRes = await fetch(`${base}/app/session-types`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'Goalkeeper Group', duration_min: '60', capacity: '8', price_dollars: '35' }),
        redirect: 'manual',
      });
      assert.equal(createTypeRes.status, 303);

      const typeRows = await db.query<{ id: number }>(
        "select id from session_type where name = 'Goalkeeper Group'",
      );
      assert.equal(typeRows.rows.length, 1);
      const typeId = typeRows.rows[0].id;

      // 4. Generate a week of sessions (every day at 18:00 local, so at least
      // today's slot is guaranteed to land within the next 7 days).
      const genBody: Record<string, string> = {};
      for (let i = 0; i < 7; i += 1) {
        genBody[`day_${i}`] = '1';
        genBody[`time_${i}`] = '18:00';
      }
      const genRes = await fetch(`${base}/app/session-types/${typeId}/generate-week`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(genBody),
        redirect: 'manual',
      });
      assert.equal(genRes.status, 303);

      const sessionRows = await db.query<{ id: number }>(
        'select id from session where session_type_id = $1',
        [typeId],
      );
      assert.ok(sessionRows.rows.length >= 1, 'expected at least one generated session');

      // 5. The coach's public page lists the generated sessions.
      const coachRows = await db.query<{ handle: string }>("select handle from coach where phone = $1", [phone]);
      const handle = coachRows.rows[0].handle;

      const publicRes = await fetch(`${base}/c/${handle}`);
      assert.equal(publicRes.status, 200);
      const publicHtml = await publicRes.text();
      assert.match(publicHtml, /Goalkeeper Group/);
      assert.match(publicHtml, /8 spots left/);
      assert.match(publicHtml, /\$35\.00/);
    });
  } finally {
    await relay.close();
    delete process.env.RELAY_BASE_URL;
  }
});

test('GET /c/does-not-exist returns 404', async () => {
  await freshDb();
  await withServer(async (base) => {
    const res = await fetch(`${base}/c/does-not-exist`);
    assert.equal(res.status, 404);
  });
});
