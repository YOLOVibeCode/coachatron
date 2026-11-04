import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { fakeComplete } from './fakes/llm.js';
import type { FakeRelay } from './fakes/relay.js';
import { createCoach, createCoachSession, type CoachRow } from '../src/domain/auth.js';
import { grantSmsConsent, hasActiveConsent } from '../src/domain/sms-consent.js';
import { createStartLink } from '../src/domain/startLink.js';
import { composeText, segmentCount } from '../src/domain/outbound.js';
import {
  createPaymentsLink,
  getPaymentsRow,
  liveText,
  notePublished,
  PAYMENTS_LINK_TTL_MS,
  reminderText,
} from '../src/domain/payments.js';
import { runTick } from '../src/jobs/tick.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import type { DbClient } from '../src/db/client.js';

/** A coach who only texts gets, by text, their page and a way to take
 * payments; the payments link signs them in once; reminders stop once
 * payments work; the page link stays on Schedule and Money. */

const WEEK = {
  coach_timezone: null,
  session_types: [{ key: 'g', name: 'Evening group', duration_min: 60, capacity: 8, price_cents: 3500, backup_pay_cents: null }],
  weekly: [{ type_key: 'g', weekday: 2, time_local: '18:00', location: 'Field 3' }],
  packages: [],
  plans: [],
};

const LINK = /https:\/\/coachatron\.com\/p\/([A-Za-z0-9_-]{22})(?=\s|$)/;
const MORNING = new Date('2026-10-20T15:00:00Z'); // 10am in Chicago
const HOUR = 60 * 60 * 1000;

function form(base: string, path: string, body: Record<string, string>, cookie = ''): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

function sessionCookie(res: Response): string | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('cx_session='));
  return header ? /^([^;]+)/.exec(header)![1] : null;
}

async function textingCoach(db: DbClient, opts: { consent?: boolean } = {}): Promise<{ coach: CoachRow; cookie: string }> {
  const coach = await createCoach(db, { name: 'Pat Keeper', phone: '+15550102030', email: 'pat@example.com', tz: 'America/Chicago' });
  if (opts.consent !== false) await grantSmsConsent(db, coach.phone!);
  return { coach, cookie: `cx_session=${await createCoachSession(db, coach.id)}` };
}

/** Session type, then weekly times: the by-hand way to publish. */
async function publishByHand(base: string, db: DbClient, cookie: string, time = '18:00'): Promise<void> {
  await form(base, '/app/session-types', { name: 'Group training', duration_min: '60', capacity: '8', price_dollars: '35' }, cookie);
  const type = await db.query<{ id: number }>('select id from session_type order by id desc limit 1');
  const res = await form(base, `/app/session-types/${type.rows[0].id}/generate-week`, { day_2: '1', time_2: time }, cookie);
  assert.equal(res.status, 303);
}

function textsTo(relay: FakeRelay, phone: string | null) {
  return relay.sms.filter((m) => m.to === phone);
}

// ---- the text right after publishing ------------------------------------

test('publishing by hand texts the coach once: their page and a link to set up payments', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await textingCoach(db);
    await withServer(async (base) => {
      await publishByHand(base, db, cookie);
      const texts = textsTo(relay, coach.phone);
      assert.equal(texts.length, 1);
      assert.match(texts[0].body, /^Coachatron: You're live at coachatron\.com\/c\/pat-keeper\. To take payments, tap: https:\/\/coachatron\.com\/p\/[A-Za-z0-9_-]{22} Reply STOP to opt out\.$/);
      assert.equal(segmentCount(texts[0].body), 1);
      assert.ok(texts[0].body.length <= 160);

      await publishByHand(base, db, cookie, '19:00');
      assert.equal(textsTo(relay, coach.phone).length, 1, 'more weekly times send nothing more');
    });
  });
});

test('publishing a talked-in week texts the same, once', async () => {
  setComplete(fakeComplete(WEEK));
  try {
    await withRelay(async (relay) => {
      const db = await freshDb();
      const { coach, cookie } = await textingCoach(db);
      await withServer(async (base) => {
        await form(base, '/app/setup', { text: 'Tuesdays at 6, an hour, 8 athletes, $35' }, cookie);
        const draft = await db.query<{ id: number }>('select id from setup_draft');
        const published = await form(base, '/app/setup/publish', { id: String(draft.rows[0].id) }, cookie);
        assert.equal(published.headers.get('location'), '/app/schedule?published=1');
        const texts = textsTo(relay, coach.phone);
        assert.equal(texts.length, 1);
        assert.match(texts[0].body, /You're live at coachatron\.com\/c\/pat-keeper\. To take payments, tap: /);
        assert.match(texts[0].body, LINK);
        const row = await getPaymentsRow(db, coach.id);
        assert.ok(row?.published_at);
        assert.equal(row?.charges_enabled, false, 'publishing also learns that payments are not set up yet');
      });
    });
  } finally {
    resetComplete();
  }
});

test('a coach who texted their week, checked the box, and published gets the text; without the box, nothing', async () => {
  setComplete(fakeComplete(WEEK));
  try {
    await withRelay(async (relay) => {
      const db = await freshDb();
      await withServer(async (base) => {
        for (const [phone, consent] of [
          ['+15553334444', true],
          ['+15553335555', false],
        ] as const) {
          const token = await createStartLink(db, phone, 'Tuesdays at 6, an hour, 8 athletes, $35');
          const startForm = await (await fetch(`${base}/start/${token}`)).text();
          assert.match(startForm, /<input type="checkbox" name="sms_consent" value="1" \/>/, 'the box is there, unchecked');
          const named = await form(base, `/start/${token}`, {
            name: consent ? 'Casey Coach' : 'Robin Coach',
            tz: 'America/Chicago',
            ...(consent ? { sms_consent: '1' } : {}),
          });
          assert.equal(named.status, 303);
          assert.equal(await hasActiveConsent(db, phone), consent);
          const cookie = sessionCookie(named)!;
          const coach = await db.query<{ id: number }>('select id from coach where phone = $1', [phone]);
          const draft = await db.query<{ id: number }>('select id from setup_draft where coach_id = $1', [coach.rows[0].id]);
          await form(base, '/app/setup/publish', { id: String(draft.rows[0].id) }, cookie);
        }
        const yes = textsTo(relay, '+15553334444');
        assert.equal(yes.length, 1);
        assert.match(yes[0].body, /You're live at coachatron\.com\/c\/casey-coach\. To take payments, tap: /);
        assert.equal(textsTo(relay, '+15553335555').length, 0);
        const refused = await db.query("select id from message_log where status like 'refused%'");
        assert.equal(refused.rows.length, 0, 'a coach who cannot be texted is not tried');
      });
    });
  } finally {
    resetComplete();
  }
});

test('a coach who can already take payments is told only that they are live', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await textingCoach(db);
    relay.enableCharges('coachatron', coach.handle);
    await withServer(async (base) => {
      await publishByHand(base, db, cookie);
    });
    const texts = textsTo(relay, coach.phone);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].body, "Coachatron: You're live at coachatron.com/c/pat-keeper. Parents can book and pay now. Reply STOP to opt out.");
    assert.equal((await db.query('select id from payments_link')).rows.length, 0);
  });
});

test('the go-live text keeps the payments link whole when the page link is long', () => {
  const long = 'alexandria-montgomery-wellingt-12';
  const body = liveText(long, 'https://coachatron.com/p/AAAAAAAAAAAAAAAAAAAAAA');
  const sent = composeText(body, 'coach-live');
  assert.match(sent, /https:\/\/coachatron\.com\/p\/AAAAAAAAAAAAAAAAAAAAAA Reply STOP to opt out\.$/);
  assert.ok(sent.length <= 160, sent);
  const reminder = composeText(reminderText('https://coachatron.com/p/AAAAAAAAAAAAAAAAAAAAAA'), 'payments-reminder');
  assert.match(reminder, /AAAAAAAAAAAAAAAAAAAAAA Reply STOP to opt out\.$/);
  assert.ok(reminder.length <= 160, reminder);
});

// ---- the payments link --------------------------------------------------

test('the payments link opens a page, signs the coach in once, and lands on Money with the terms and the button', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, cookie } = await textingCoach(db);
    await withServer(async (base) => {
      await publishByHand(base, db, cookie);
      const token = LINK.exec(textsTo(relay, coach.phone)[0].body)![1];

      for (let i = 0; i < 2; i += 1) {
        const opened = await fetch(`${base}/p/${token}`, { redirect: 'manual' });
        assert.equal(opened.status, 200, 'opening the link, or a preview of it, does not use it up');
        const html = await opened.text();
        assert.match(html, /Set up payments/);
        assert.match(html, /Pat Keeper/);
        assert.equal(opened.headers.getSetCookie().length, 0);
      }

      const signedIn = await form(base, `/p/${token}`, {});
      assert.equal(signedIn.status, 303);
      assert.equal(signedIn.headers.get('location'), '/app/money');
      const fresh = sessionCookie(signedIn);
      assert.ok(fresh);
      const money = await (await fetch(`${base}/app/money`, { headers: { cookie: fresh } })).text();
      assert.match(money, /name="agree"/);
      assert.match(money, /Connect payments/);

      const again = await form(base, `/p/${token}`, {});
      assert.equal(again.status, 410, 'once only');
      assert.equal(sessionCookie(again), null);
      const signedInAgain = await form(base, `/p/${token}`, {}, fresh);
      assert.equal(signedInAgain.status, 303, 'a coach who is still signed in just goes to Money');
      assert.equal(signedInAgain.headers.get('location'), '/app/money');
    });
  });
});

test('a payments link stops working after seven days, and a made-up one never works', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const { coach } = await textingCoach(db);
    const old = await createPaymentsLink(db, coach.id, new Date(Date.now() - PAYMENTS_LINK_TTL_MS - 60_000));
    const recent = await createPaymentsLink(db, coach.id, new Date(Date.now() - PAYMENTS_LINK_TTL_MS + 60 * 60_000));
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/p/${old}`)).status, 410);
      assert.equal((await form(base, `/p/${old}`, {})).status, 410);
      assert.equal((await fetch(`${base}/p/not-a-real-link`)).status, 410);
      assert.equal((await form(base, `/p/${recent}`, {})).status, 303);
    });
  });
});

// ---- reminders ----------------------------------------------------------

async function publishedAt(db: DbClient, relay: FakeRelay, at: Date, opts: { consent?: boolean } = {}) {
  const { coach } = await textingCoach(db, opts);
  await notePublished(db, coach, at);
  return { coach, texts: () => textsTo(relay, coach.phone) };
}

test('a coach who has not set up payments is reminded about a day and three days after publishing, and no more', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { texts } = await publishedAt(db, relay, MORNING);
    assert.equal(texts().length, 1, 'the go-live text');

    await runTick(db, new Date(MORNING.getTime() + 23 * HOUR));
    assert.equal(texts().length, 1);
    await runTick(db, new Date(MORNING.getTime() + 24 * HOUR));
    assert.equal(texts().length, 2);
    assert.match(texts()[1].body, /^Coachatron: Parents can't book until payments are set up\. Tap to finish: https:\/\/coachatron\.com\/p\/[A-Za-z0-9_-]{22} Reply STOP to opt out\.$/);
    assert.notEqual(LINK.exec(texts()[1].body)![1], LINK.exec(texts()[0].body)![1], 'each text has its own link');

    await runTick(db, new Date(MORNING.getTime() + 25 * HOUR));
    await runTick(db, new Date(MORNING.getTime() + 48 * HOUR));
    assert.equal(texts().length, 2);
    await runTick(db, new Date(MORNING.getTime() + 72 * HOUR));
    assert.equal(texts().length, 3);
    for (const hours of [73, 96, 120, 240]) await runTick(db, new Date(MORNING.getTime() + hours * HOUR));
    assert.equal(texts().length, 3, 'two reminders at most');
  });
});

test('a reminder due at night waits for 8am in the coach\'s time zone', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const evening = new Date('2026-10-21T02:30:00Z'); // 9:30pm in Chicago
    const { texts } = await publishedAt(db, relay, evening);
    await runTick(db, new Date(evening.getTime() + 24 * HOUR)); // 9:30pm
    await runTick(db, new Date('2026-10-22T12:59:00Z')); // 7:59am
    assert.equal(texts().length, 1);
    await runTick(db, new Date('2026-10-22T13:00:00Z')); // 8:00am
    assert.equal(texts().length, 2);
    assert.match(texts()[1].body, /Tap to finish/);
  });
});

test('reminders stop once payments work, and the coach is told payments are ready instead', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach, texts } = await publishedAt(db, relay, MORNING);
    relay.enableCharges('coachatron', coach.handle);
    await runTick(db, new Date(MORNING.getTime() + 24 * HOUR));
    await runTick(db, new Date(MORNING.getTime() + 72 * HOUR));
    const bodies = texts().map((m) => m.body);
    assert.equal(bodies.length, 2);
    assert.match(bodies[1], /You can take payments now/);
    assert.ok(!bodies.some((b) => /Tap to finish/.test(b)));
  });
});

test('a coach without the texts box gets no go-live text and no reminders', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const { coach } = await publishedAt(db, relay, MORNING, { consent: false });
    for (const hours of [24, 72, 96]) await runTick(db, new Date(MORNING.getTime() + hours * HOUR));
    assert.equal(textsTo(relay, coach.phone).length, 0);
    assert.equal((await db.query('select id from message_log')).rows.length, 0);
  });
});
