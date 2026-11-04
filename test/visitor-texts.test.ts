import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { seedBookedSession, seedCoachWithSession } from './helpers/fixtures.js';
import { bookOnline, postCheckout } from './helpers/booking.js';
import { zoneAt } from './helpers/clock.js';
import { createCoach, createCoachSession } from '../src/domain/auth.js';
import { createCredit } from '../src/domain/pricing.js';
import { sendText } from '../src/domain/outbound.js';
import { grantSmsConsent } from '../src/domain/sms-consent.js';
import { runTick } from '../src/jobs/tick.js';
import { offerOpenSpots } from '../src/domain/waitlist.js';
import { visitorTextLimits } from '../src/config.js';
import type { DbClient } from '../src/db/client.js';

/** Texts set off by people who are not signed in from a web form (sign-in
 * codes, opt-in confirmations, booking and waitlist texts to numbers never
 * texted before) share an app-wide hourly and daily ceiling, and stop while
 * a reserve of the product's day is left for reminders and replies. A form
 * that hits it says to try again later, or to use email where it can. A
 * signed-in coach's texts are not counted. The start link that answers a
 * text from a number we do not know has a budget of its own, with the same
 * reserve, since it goes only to the number that texted. */

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function form(base: string, path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

const from = (address: string) => ({ 'x-forwarded-for': address });

async function statuses(db: DbClient, phone: string): Promise<string[]> {
  return (await db.query<{ status: string }>('select status from message_log where to_phone = $1 order by id', [phone])).rows.map((r) => r.status);
}

test('at the hourly ceiling a sign-in by text is told to try later or use email; email and a signed-in coach still work', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '2' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const coach = await createCoach(db, { phone: null, email: 'dana@example.com', name: 'Dana', tz: 'America/Chicago' });
      const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
      await withServer(async (base) => {
        assert.equal((await form(base, '/signin/otp', { contact: '2145550101' }, from('203.0.113.1'))).status, 303);
        assert.equal((await form(base, '/signin/otp', { contact: '2145550102' }, from('203.0.113.2'))).status, 303);

        const held = await form(base, '/signin/otp', { contact: '2145550103' }, from('203.0.113.3'));
        assert.equal(held.status, 429);
        assert.match(await held.text(), /We can(&#39;|')t text codes right now\. Try again later, or use your email instead\./);
        assert.deepEqual(await statuses(db, '+12145550103'), ['capped-visitor-hourly']);
        assert.equal((await db.query("select id from otp_code where phone = '+12145550103'")).rows.length, 0, 'no code stored');

        assert.equal((await form(base, '/signin/otp', { contact: 'pat@example.com' }, from('203.0.113.4'))).status, 303, 'email still works');

        // A text from a number we do not know still gets its start link:
        // that reply has a budget of its own.
        assert.equal((await postSignedSms(base, { From: '+12145550104', Body: 'Tuesdays at 6pm, an hour, $35' })).status, 200);
        assert.deepEqual(await statuses(db, '+12145550104'), ['sent']);

        // A signed-in coach adding a mobile is not a visitor.
        const added = await form(base, '/app/phone', { phone: '2145550105', sms_consent: '1' }, { cookie });
        assert.match(added.headers.get('location') ?? '', /phone=sent/);
      });
      assert.equal(relay.sms.filter((m) => m.to === '+12145550105').length, 1);
      assert.equal(relay.sms.filter((m) => /sign-in code/.test(m.body)).length, 2);
    });
  });
});

test('the daily ceiling holds once the hour has room again, and the checkout code form says to try later', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '50', SMS_VISITOR_DAILY_CAP: '1' }, async () => {
    await withRelay(async () => {
      const db = await freshDb();
      const seed = await seedCoachWithSession(db, { capacity: 3 });
      await createCredit(db, seed.coach.id, '+12145550202', null, 'test', 2, null);
      await withServer(async (base) => {
        const first = await form(base, '/sms', { phone: '2145550201', sms_consent: '1' });
        assert.match(await first.text(), /We texted \+12145550201 to confirm/);

        const b = await bookOnline(base, seed.coach.handle, seed.sessionId, 'Alex', '2145550202');
        assert.ok(b.key);
        const code = await postCheckout(base, seed.coach.handle, b.key, { mode: 'send_code' });
        assert.equal(code.status, 429);
        assert.match(await code.text(), /We can(&#39;|')t send codes right now\. Try again later\./);
        assert.deepEqual(await statuses(db, '+12145550202'), ['capped-visitor-daily']);
      });
    });
  });
});

test('booking and waitlist texts count only for a number never texted before, and a paid booking is not counted', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '1' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const free = await seedCoachWithSession(db, { capacity: 6, priceCents: 0 });
      const paid = await seedCoachWithSession(db, { capacity: 6, priceCents: 3500 });
      // A number we have texted before: an earlier reminder.
      await grantSmsConsent(db, '+12145550301');
      assert.equal(await sendText(db, { to: '+12145550301', body: 'Coachatron: earlier reminder', coachId: free.coach.id, template: 'reminder' }), 'sent');
      await withServer(async (base) => {
        // The hour's one visitor text.
        await form(base, '/sms', { phone: '2145550300', sms_consent: '1' });

        const known = await bookOnline(base, free.coach.handle, free.sessionId, 'Kai', '2145550301');
        assert.equal((await postCheckout(base, free.coach.handle, known.key!, { mode: 'dropin' })).status, 303);
        const fresh = await bookOnline(base, free.coach.handle, free.sessionId, 'Nia', '2145550302', { contact_email: 'nia.parent@example.com' });
        const booked = await postCheckout(base, free.coach.handle, fresh.key!, { mode: 'dropin' });
        assert.equal(booked.status, 303, 'the booking itself goes through');

        const payer = await bookOnline(base, paid.coach.handle, paid.sessionId, 'Pia', '2145550303');
        const pay = await postCheckout(base, paid.coach.handle, payer.key!, { mode: 'dropin' });
        const userId = new URL(pay.headers.get('location') ?? '', 'http://relay.test').searchParams.get('user') ?? '';
        const { postStorePaid } = await import('./helpers/store-event.js');
        assert.equal((await postStorePaid(base, { userId, amountCents: 3500, paymentId: 'ch_paid_visitor' })).status, 200);
      });
      assert.ok(relay.sms.some((m) => m.to === '+12145550301' && /Kai is booked/.test(m.body)), 'a number texted before');
      assert.equal(relay.sms.filter((m) => m.to === '+12145550302').length, 0, 'a new number waits');
      assert.deepEqual(await statuses(db, '+12145550302'), ['capped-visitor-hourly']);
      assert.ok(relay.emails.some((e) => e.to === 'nia.parent@example.com' && /^Booked:/.test(e.subject)), 'the email confirmation still goes');
      assert.ok(relay.sms.some((m) => m.to === '+12145550303' && /Pia is booked/.test(m.body)), 'a paid booking is not counted');
    });
  });
});

test('a waitlist spot for a number never texted goes by email while the ceiling is reached', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '0' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const seed = await seedCoachWithSession(db, { capacity: 1 });
      await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
      const taken = await seedBookedSession(db, seed.sessionId, 'First In', '+12145550501');
      await withServer(async (base) => {
        const join = await form(base, `/c/${seed.coach.handle}/sessions/${seed.sessionId}/waitlist`, {
          athlete_name: 'Wren',
          contact_phone: '2145550502',
          contact_email: 'wren.parent@example.com',
          sms_consent: '1',
        });
        assert.equal(join.status, 200);
      });
      await db.query("update booking set status = 'cancelled' where id = $1", [taken]);
      await offerOpenSpots(db, seed.sessionId);
      assert.equal(relay.sms.filter((m) => m.to === '+12145550502').length, 0);
      assert.deepEqual(await statuses(db, '+12145550502'), ['capped-visitor-hourly']);
      assert.ok(relay.emails.some((e) => e.to === 'wren.parent@example.com' && /^A spot opened/.test(e.subject)));
    });
  });
});

test('a reserve of the day is kept: visitor texts stop first, and reminders still go', async () => {
  // The product's day is 500 texts here; keep 499 of them back.
  await withEnv({ SMS_DAILY_RESERVE: '499' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const seed = await seedCoachWithSession(db, { capacity: 3 });
      await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
      await db.query('update session set starts_at_utc = $2 where id = $1', [seed.sessionId, new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString()]);
      await seedBookedSession(db, seed.sessionId, 'Sam Reyes', '+12145550401');
      await grantSmsConsent(db, seed.coach.phone);
      assert.equal(await sendText(db, { to: seed.coach.phone, body: 'Coachatron: a text to the coach', coachId: seed.coach.id, template: 'assistant' }), 'sent');
      await withServer(async (base) => {
        const optIn = await form(base, '/sms', { phone: '2145550402', sms_consent: '1' });
        assert.equal(optIn.status, 200);
        const page = await optIn.text();
        assert.match(page, /opted in/);
        assert.doesNotMatch(page, /We texted/);
      });
      assert.deepEqual(await statuses(db, '+12145550402'), ['capped-visitor-reserve']);
      await runTick(db, new Date());
      assert.equal(relay.sms.filter((m) => m.to === '+12145550401' && /Sam Reyes's Goalkeeper Group is/.test(m.body)).length, 1, 'the reminder went');
    });
  });
});

test('the visitor ceilings have documented defaults and env names', () => {
  assert.deepEqual(visitorTextLimits(), { hourly: 30, daily: 100, reserve: 100 });
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const name of ['SMS_VISITOR_HOURLY_CAP', 'SMS_VISITOR_DAILY_CAP', 'SMS_DAILY_RESERVE', 'ALLOW_TEST_PAYMENTS']) {
    assert.match(readme, new RegExp(`\\| \`${name}\` \\|`), `${name} is in the README's environment table`);
  }
});

test('sign-in codes asked for from many addresses at the same moment send no more than the hourly ceiling', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '3' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      await withServer(async (base) => {
        const answers = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            form(base, '/signin/otp', { contact: `21455507${String(i).padStart(2, '0')}` }, from(`198.51.100.${i + 1}`)),
          ),
        );
        assert.deepEqual(
          answers.map((r) => r.status).sort(),
          [...Array(3).fill(303), ...Array(17).fill(429)],
          'three codes, and the rest are told to try later',
        );
      });
      assert.equal(relay.sms.filter((m) => /sign-in code/.test(m.body)).length, 3);
      const rows = await db.query<{ status: string; n: number }>(
        'select status, count(*)::int as n from message_log where visitor group by status order by status',
      );
      assert.deepEqual(
        rows.rows.map((r) => [r.status, r.n]),
        [
          ['capped-visitor-hourly', 17],
          ['sent', 3],
        ],
        'each sent code ends as sent, with nothing left reserved',
      );
    });
  });
});

test('direct sends at the same moment take their places under the ceiling one at a time', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '2' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          sendText(db, { to: `+1214555078${i}`, body: 'Coachatron: your code is 123456', coachId: null, template: 'otp', visitor: 'always' }),
        ),
      );
      assert.deepEqual(outcomes.sort(), ['busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'sent', 'sent']);
      assert.equal(relay.sms.length, 2);
    });
  });
});

test('a new coach whose start link the inbound-reply ceiling held gets it when they text again after it clears', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '1' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const links = () => relay.sms.filter((m) => m.to === '+12145550602' && /\/start\//.test(m.body)).length;
      await withServer(async (base) => {
        // A sign-in code takes the forms' one text of the hour, and has no
        // say over replies; another new coach's start link takes the
        // replies' one.
        assert.equal((await form(base, '/signin/otp', { contact: '2145550600' }, from('203.0.113.9'))).status, 303);
        await postSignedSms(base, { From: '+12145550601', Body: 'Mondays at 5pm, an hour, $30' });
        await postSignedSms(base, { From: '+12145550602', Body: 'Tuesdays at 6pm, an hour, $35' });
        assert.equal(links(), 0, 'held by the ceiling');
        // The hour clears (here: the ceiling goes up), and they text again.
        process.env.SMS_VISITOR_HOURLY_CAP = '50';
        await postSignedSms(base, { From: '+12145550602', Body: 'Tuesdays at 6pm, an hour, $35' });
        assert.equal(links(), 1, 'the second text gets the link');
        // One link a day still: a third text gets nothing more.
        await postSignedSms(base, { From: '+12145550602', Body: 'Tuesdays at 6pm, an hour, $35' });
        assert.equal(links(), 1);
      });
      assert.deepEqual(await statuses(db, '+12145550601'), ['sent']);
      assert.deepEqual(await statuses(db, '+12145550602'), ['capped-inbound-reply-hourly', 'sent']);
    });
  });
});

test('web forms and inbound replies each keep their own budget, and both stop at the day\'s reserve', async () => {
  await withEnv({ SMS_VISITOR_HOURLY_CAP: '1' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      await withServer(async (base) => {
        // The forms' one text of the hour, then the replies' one: neither
        // holds the other back.
        assert.equal((await form(base, '/signin/otp', { contact: '2145550801' }, from('203.0.113.81'))).status, 303);
        await postSignedSms(base, { From: '+12145550802', Body: 'Tuesdays at 6pm, an hour, $35' });
        assert.equal(relay.sms.filter((m) => m.to === '+12145550802' && /\/start\//.test(m.body)).length, 1);

        // Each budget is now full on its own.
        assert.equal((await form(base, '/signin/otp', { contact: '2145550803' }, from('203.0.113.83'))).status, 429);
        await postSignedSms(base, { From: '+12145550804', Body: 'Tuesdays at 6pm, an hour, $35' });
      });
      const rows = await db.query<{ to_phone: string; status: string; visitor: boolean; inbound_reply: boolean }>(
        'select to_phone, status, visitor, inbound_reply from message_log order by id',
      );
      assert.deepEqual(
        rows.rows.map((r) => [r.to_phone, r.status, r.visitor, r.inbound_reply]),
        [
          ['+12145550801', 'sent', true, false],
          ['+12145550802', 'sent', false, true],
          ['+12145550803', 'capped-visitor-hourly', true, false],
          ['+12145550804', 'capped-inbound-reply-hourly', false, true],
        ],
      );
    });
  });
  // The product's day is 500 texts here; keep 499 back. One text to a coach
  // leaves no room for a start link either.
  await withEnv({ SMS_DAILY_RESERVE: '499' }, async () => {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const coach = await createCoach(db, { phone: '+12145550810', email: 'rae@example.com', name: 'Rae', tz: 'America/Chicago' });
      await grantSmsConsent(db, '+12145550810');
      assert.equal(await sendText(db, { to: '+12145550810', body: 'Coachatron: hello', coachId: coach.id, template: 'assistant' }), 'sent');
      await withServer(async (base) => {
        await postSignedSms(base, { From: '+12145550811', Body: 'Tuesdays at 6pm, an hour, $35' });
      });
      assert.equal(relay.sms.filter((m) => m.to === '+12145550811').length, 0);
      assert.deepEqual(await statuses(db, '+12145550811'), ['capped-inbound-reply-reserve']);
    });
  });
});

test('a start link the relay could not take is sent when the new coach texts again', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const links = () => relay.sms.filter((m) => m.to === '+12145550603' && /\/start\//.test(m.body)).length;
    await withServer(async (base) => {
      relay.failSmsTo.add('+12145550603');
      await postSignedSms(base, { From: '+12145550603', Body: 'Thursdays at 5pm, 90 minutes, $40' });
      assert.equal(links(), 0);
      relay.failSmsTo.delete('+12145550603');
      await postSignedSms(base, { From: '+12145550603', Body: 'Thursdays at 5pm, 90 minutes, $40' });
      assert.equal(links(), 1);
    });
    assert.deepEqual(await statuses(db, '+12145550603'), ['failed', 'sent']);
  });
});
