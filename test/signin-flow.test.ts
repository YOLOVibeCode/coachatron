import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { createCoach } from '../src/domain/auth.js';
import { postVerify } from './helpers/signin.js';

function post(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

test('sign-in pages show Back to home and code-step exits', async () => {
  await withRelay(async (relay) => {
    await freshDb();
    await withServer(async (base) => {
      const entry = await (await fetch(`${base}/signin`)).text();
      assert.match(entry, /Sign in or sign up/);
      assert.match(entry, /Email or phone/);
      assert.match(entry, /Back to home[\s\S]*Back to home/);

      await post(base, '/signin/otp', { contact: '5559001001', sms_consent: '1' });
      const code = /code is (\d{6})/.exec(relay.sms[0].body)![1];
      const verifyPage = await (await fetch(`${base}/signin/verify?to=%2B15559001001`)).text();
      assert.match(verifyPage, /Send a new code/);
      assert.match(verifyPage, /Use a different email or phone/);
      assert.match(verifyPage, /Back to home[\s\S]*Back to home/);

      const verify = await postVerify(base, '+15559001001', code);
      const profilePage = await (
        await fetch(`${base}/signin/profile`, { headers: { cookie: verify.headers.getSetCookie?.()[0]?.split(';')[0] ?? '' } })
      ).text();
      assert.match(profilePage, /Almost done/);
      assert.match(profilePage, /Skip for now/);
      assert.match(profilePage, /Back/);
    });
  });
});

test('linking a verified email attaches a new phone to the existing coach', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'link@example.com', name: 'Linker', tz: 'America/Chicago' });
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: '5558009001', sms_consent: '1' });
      const code = /code is (\d{6})/.exec(relay.sms.at(-1)!.body)![1];
      const verify = await postVerify(base, '+15558009001', code);
      const jar = verify.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? '';
      const profile = await post(base, '/signin/profile', {
        name: 'Other',
        extra: 'link@example.com',
        tz: 'America/Chicago',
      }, jar);
      assert.match(profile.headers.get('location') ?? '', /\/signin\/link/);
      const flow = [jar, ...profile.headers.getSetCookie?.().map((c) => c.split(';')[0]) ?? []].join('; ');
      await post(base, '/signin/link', {}, flow);
      const linkCode = /(\d{6})/.exec(relay.emails.at(-1)!.subject)![1];
      const done = await post(base, '/signin/link/verify', { code: linkCode }, flow);
      assert.equal(done.status, 303);
      assert.match(done.headers.get('location') ?? '', /linked=1/);
      assert.equal((await db.query<{ phone: string | null }>("select phone from coach where email = 'link@example.com'")).rows[0].phone, '+15558009001');
    });
  });
});

test('returning coaches still land on schedule after code entry', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    await createCoach(db, { phone: null, email: 'back@example.com', name: 'Back', tz: 'America/Chicago' });
    await withServer(async (base) => {
      await post(base, '/signin/otp', { contact: 'back@example.com' });
      const code = /(\d{6})/.exec(relay.emails[0].subject)![1];
      const verify = await postVerify(base, 'back@example.com', code);
      assert.equal(verify.status, 303);
      assert.equal(verify.headers.get('location'), '/app/schedule');
    });
  });
});