import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { postStorePaid, TEST_STORE_SECRET } from './helpers/store-event.js';
import { fakeComplete } from './fakes/llm.js';
import { APP_BASE_URL } from '../src/config.js';
import { segmentCount } from '../src/domain/outbound.js';
import { signConnectBuyLink } from '../src/lib/store-client.js';
import { resetComplete, setComplete } from '../src/llm/complete.js';
import type { CompleteRequest } from '../src/llm/schema.js';

/**
 * End-to-end: one coach, from a texted week to a parent's paid booking.
 *
 * Every step goes through the real routes in the order a coach and a parent
 * use them, against the in-process fake relay (test/fakes/relay.ts) and a
 * fake model. Nothing leaves the machine. The steps share one database and
 * one server, so each is a named subtest that builds on the one before; if
 * one fails, the rest are skipped and name the step that broke.
 *
 *   1. The coach texts their week; one branded, one-segment text comes back
 *      with a /start/<token> link.
 *   2. The link takes a name; the model reads the week; the preview shows it.
 *   3. Publish; the coach page /c/<handle> lists the sessions.
 *   4. The coach accepts the marketplace terms on /app/money and onboards
 *      with the relay; the seller becomes charges-enabled.
 *   5. A parent books, follows the signed buy link, the relay reports the
 *      payment at /webhooks/store, and /booking/:token shows the booking.
 *
 * Later work (paying by text, booking confirmations) can add its assertions
 * to the step it changes.
 */

const COACH_PHONE = '+15125550111';
const COACHATRON_NUMBER = '+15551230000';
const WEEK_TEXT = 'Privates Tue and Thu 6pm, $60, group Saturday 9am $25';
const GROUP_SIZE_ANSWER = 'Up to 8 in the group';
const PARENT_PHONE = '+15125550142';
const PARENT_EMAIL = 'pat@example.com';
const PAYMENT_ID = 'pay_north_star_1';

/** What a model returns for WEEK_TEXT: only what the coach said. No length
 * was given (the product uses 60 minutes), and no group size, so the
 * preview asks for it rather than guessing. */
function weekAsRead(groupCapacity: number | null) {
  return {
    coach_timezone: null,
    session_types: [
      { key: 'private', name: 'Private', duration_min: null, capacity: null, price_cents: 6000, backup_pay_cents: null },
      { key: 'group', name: 'Group', duration_min: null, capacity: groupCapacity, price_cents: 2500, backup_pay_cents: null },
    ],
    weekly: [
      { type_key: 'private', weekday: 2, time_local: '18:00', location: null },
      { type_key: 'private', weekday: 4, time_local: '18:00', location: null },
      { type_key: 'group', weekday: 6, time_local: '09:00', location: null },
    ],
    packages: [],
    plans: [],
  };
}

function fakeModel(req: CompleteRequest): unknown {
  const said = req.messages[req.messages.length - 1]?.content ?? '';
  if (req.schemaName === 'setup' && said === WEEK_TEXT) return weekAsRead(null);
  if (req.schemaName === 'setup' && said === GROUP_SIZE_ANSWER) return weekAsRead(8);
  throw new Error(`unexpected model call (${req.schemaName ?? 'intent'}): ${said}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The page's text as a person reads it: no tags, entities decoded, and all
 * whitespace (including the narrow space Intl puts before AM/PM) as one space. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SessionCard {
  when: string;
  name: string;
  detail: string;
  book: string | null;
}

/** The session cards on a coach's public page, as a parent sees them. */
function sessionCards(html: string): SessionCard[] {
  return html
    .split('<div class="card">')
    .slice(1)
    .map((chunk) => {
      const spans = [...chunk.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => visible(m[1]));
      return {
        when: visible(/<strong>([\s\S]*?)<\/strong>/.exec(chunk)?.[1] ?? ''),
        name: spans[0] ?? '',
        detail: spans[1] ?? '',
        book: /href="([^"]+\/book)"/.exec(chunk)?.[1] ?? null,
      };
    });
}

function sessionCookie(res: Response): string {
  const setCookie = res.headers.getSetCookie();
  const match = setCookie.map((c) => /^cx_session=([^;]+)/.exec(c)).find(Boolean);
  assert.ok(match, `expected a cx_session cookie, got ${JSON.stringify(setCookie)}`);
  return `cx_session=${match[1]}`;
}

test('north star: a coach texts their week in, and a parent books and pays', async (t) => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const llm = fakeComplete(fakeModel);
    setComplete(llm);
    try {
      await withServer(async (base) => {
        const appBase = process.env.APP_BASE_URL ?? APP_BASE_URL;

        const get = (path: string, cookie?: string) =>
          fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
        const postForm = (path: string, form: Record<string, string>, cookie?: string) =>
          fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
            body: new URLSearchParams(form).toString(),
            redirect: 'manual',
          });
        const count = async (sql: string, params: unknown[] = []) =>
          Number((await db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params)).rows[0].n);

        let failedStep: string | null = null;
        const step = (name: string, fn: () => Promise<void>) =>
          t.test(name, { skip: failedStep ? `needs "${failedStep}", which failed` : false }, async () => {
            try {
              await fn();
            } catch (err) {
              failedStep = name;
              throw err;
            }
          });

        // What each step hands to the next.
        let startPath = '';
        let coachCookie = '';
        let handle = '';

        await step("1. a signed text from the coach's phone gets one branded, one-segment text with a start link", async () => {
          // Signed with the relay's secret, and marked by the relay as sent
          // by Twilio (x-relay-twilio-verified: 1), as a real inbound text is.
          const res = await postSignedSms(
            base,
            {
              MessageSid: 'SMnorthstar0001',
              From: COACH_PHONE,
              To: COACHATRON_NUMBER,
              Body: WEEK_TEXT,
              NumMedia: '0',
            },
            { twilioVerified: '1' },
          );
          assert.equal(res.status, 200, 'a signed inbound text is accepted');
          assert.equal(
            await res.text(),
            '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
            'the reply goes out as a sent text, not TwiML',
          );

          assert.equal(relay.sms.length, 1, 'one text goes out in total');
          const toCoach = relay.sms.filter((m) => m.to === COACH_PHONE);
          assert.equal(toCoach.length, 1, 'the coach gets exactly one text');
          const body = toCoach[0].body;
          const shape = new RegExp(
            `^Coachatron: Got it\\. Tap to see your week and go live: ${escapeRegExp(APP_BASE_URL)}(/start/[a-f0-9]{32}) Reply STOP to opt out\\.$`,
          );
          const match = shape.exec(body);
          assert.ok(match, `the text is branded, carries the start link, and ends with the opt-out line: ${JSON.stringify(body)}`);
          assert.ok(body.length <= 160, `one GSM-7 segment is at most 160 characters; this is ${body.length}`);
          assert.match(body, /^[ -~]+$/, 'plain ASCII, so it stays GSM-7 and never becomes UCS-2');
          assert.equal(segmentCount(body), 1, 'the text is one segment');
          startPath = match[1];

          assert.equal(llm.calls.length, 0, 'the model does not run for a number with no account');
          assert.equal(await count('coach'), 0, 'a text alone creates no account');
          assert.equal(
            await count("message_log where to_phone = $1 and template = 'auto-reply' and status = 'sent'", [COACH_PHONE]),
            1,
            'the reply went through the one send path and was logged',
          );
        });

        await step('2. the start link takes a name, the model reads the week, and the preview shows the sessions', async () => {
          const form = await get(startPath);
          assert.equal(form.status, 200, 'the texted link opens');
          const formHtml = await form.text();
          assert.match(visible(formHtml), /We already have your phone from the text\./);
          assert.match(formHtml, new RegExp(`<form method="post" action="${escapeRegExp(startPath)}">`), 'the name form posts back to the link');

          const named = await postForm(startPath, { name: 'Dana Rivera', email: 'dana@example.com', tz: 'America/Chicago' });
          assert.equal(named.status, 303, 'a name is all the link needs');
          assert.equal(named.headers.get('location'), '/app/schedule?setup=1', 'straight to the preview');
          coachCookie = sessionCookie(named);

          assert.equal(llm.calls.length, 1, 'the model reads the week once the link proves the phone');
          const call = llm.calls[0] as CompleteRequest;
          assert.equal(call.schemaName, 'setup');
          assert.equal(call.messages[call.messages.length - 1].content, WEEK_TEXT, 'the model reads what the coach texted');
          assert.doesNotMatch(call.messages[0].content, /Current setup:/, 'the first read starts from no draft');

          const coach = await db.query<{ phone: string; name: string; tz: string }>('select phone, name, tz from coach');
          assert.deepEqual(coach.rows, [{ phone: COACH_PHONE, name: 'Dana Rivera', tz: 'America/Chicago' }]);
          assert.deepEqual(
            (await db.query('select email, email_verified_at is not null as verified from coach')).rows,
            [{ email: 'dana@example.com', verified: false }],
            'the email typed on the link is kept but not proved, so only a code sent to it lets it sign in',
          );
          assert.equal((await get(startPath)).status, 410, 'the start link works once');

          const preview = visible(await (await get('/app/schedule?setup=1', coachCookie)).text());
          assert.match(preview, /Here's your week/);
          assert.match(preview, /Private 60 min · 1 athlete · \$60 Tue & Thu 6:00pm/, 'privates: Tuesday and Thursday at 6pm, $60');
          assert.match(preview, /Group 60 min · how many\? · \$25 Sat 9:00am/, 'the group: Saturday at 9am, $25');
          assert.match(preview, /How many athletes fit in Group\?/, 'the group size was not said, so the preview asks');
          assert.doesNotMatch(preview, /Publish/, 'no Publish while a question is open');
          assert.equal(await count('session'), 0, 'a preview writes nothing to the schedule');

          const answered = await postForm('/app/setup', { text: GROUP_SIZE_ANSWER }, coachCookie);
          assert.equal(answered.status, 303);
          assert.equal(llm.calls.length, 2, 'the answer is one more model call');
          const followUp = llm.calls[1] as CompleteRequest;
          assert.equal(followUp.schemaName, 'setup');
          assert.equal(followUp.messages[followUp.messages.length - 1].content, GROUP_SIZE_ANSWER, 'the model reads the answer');
          const followUpPrompt = followUp.messages[0].content;
          assert.match(followUpPrompt, /Current setup: \{/, 'the answer is read against the open draft');
          assert.match(followUpPrompt, /"price_cents":6000/, 'the draft it carries is the week read in step 2');
          assert.match(followUpPrompt, /How many athletes fit in Group\?/, 'with the question being answered');
          const ready = visible(await (await get('/app/schedule?setup=1', coachCookie)).text());
          assert.match(ready, /Group 60 min · 8 athletes · \$25 Sat 9:00am/);
          assert.doesNotMatch(ready, /How many athletes/);
          assert.match(ready, /Publish/, 'with nothing left to ask, the preview offers Publish');
        });

        await step('3. publishing puts the sessions on the coach page', async () => {
          const draft = await db.query<{ id: number }>('select id from setup_draft where published_at is null');
          assert.equal(draft.rows.length, 1, 'one open draft to publish');
          const published = await postForm('/app/setup/publish', { id: String(draft.rows[0].id) }, coachCookie);
          assert.equal(published.status, 303);
          assert.equal(published.headers.get('location'), '/app/schedule?published=1');

          const live = visible(await (await get('/app/schedule?published=1', coachCookie)).text());
          const link = new RegExp(`You're live\\. Parents book at ${escapeRegExp(appBase.replace(/^https?:\/\//, ''))}/c/([a-z0-9-]+)`).exec(live);
          assert.ok(link, `the schedule shows the coach's public link: ${live.slice(0, 300)}`);
          handle = link[1];
          assert.equal(handle, 'dana-rivera', 'the handle comes from the name');
          assert.match(live, /They can't pay you until payments are connected\./);

          assert.equal(await count('session_type'), 2);
          assert.equal(await count('weekly_slot where active = true'), 3, 'Tue and Thu privates, Saturday group');

          const pub = await get(`/c/${handle}`);
          assert.equal(pub.status, 200, 'the coach page is public');
          const pubHtml = await pub.text();
          assert.match(visible(pubHtml), /^Dana Rivera/);
          const cards = sessionCards(pubHtml);
          const privates = cards.filter((c) => c.name === 'Private');
          const groups = cards.filter((c) => c.name === 'Group');
          assert.ok(privates.length >= 2 && groups.length >= 1, `both kinds of session are listed: ${JSON.stringify(cards.slice(0, 4))}`);
          for (const c of privates) {
            assert.match(c.when, /^(Tue|Thu), \w{3} \d{1,2}, 6:00 PM$/, `privates are Tue/Thu 6pm: ${c.when}`);
            assert.equal(c.detail, '1 spot left · $60.00');
          }
          for (const c of groups) {
            assert.match(c.when, /^Sat, \w{3} \d{1,2}, 9:00 AM$/, `the group is Saturday 9am: ${c.when}`);
            assert.equal(c.detail, '8 spots left · $25.00');
          }
          assert.ok(cards.every((c) => c.book), 'every open session has a Book link');
        });

        await step('4. the coach accepts the terms, onboards with the relay, and payments connect', async () => {
          const before = visible(await (await get('/app/money', coachCookie)).text());
          assert.match(before, /Connect a payment account so athletes can pay you when they book\./);
          assert.match(before, /Coachatron keeps 5% of each payment/);
          assert.match(before, /I accept the Coachatron marketplace terms \(v1\)\./);

          const connect = await postForm('/app/money/payments', { agree: '1' }, coachCookie);
          assert.equal(connect.status, 303, 'accepting the terms starts onboarding');
          assert.equal(
            connect.headers.get('location'),
            `${relay.url}/connect/coachatron/onboard?state=fake-${handle}`,
            "the coach is sent to the relay's onboarding link",
          );
          const seller = relay.seller('coachatron', handle);
          assert.equal(seller?.agreementVersion, 'v1', 'the relay recorded the accepted terms');
          assert.equal(seller?.chargesEnabled, false, 'not chargeable until onboarding is finished');
          assert.deepEqual(relay.onboards, [
            { product: 'coachatron', sellerKey: handle, returnUrl: `${appBase}/app/money`, email: 'dana@example.com' },
          ]);
          assert.match(
            visible(await (await get('/app/money', coachCookie)).text()),
            /Finish setting up your payment account/,
            'between accepting and finishing, Money asks the coach to finish',
          );

          // What the provider's onboarding does once the coach finishes it.
          relay.enableCharges('coachatron', handle);

          const after = visible(await (await get('/app/money?seller=connected', coachCookie)).text());
          assert.match(after, /Payments are connected\./, 'the return notice');
          assert.match(after, /Payments connected\. Athletes pay you directly\. Coachatron keeps 5% of each payment\./);
          assert.match(after, /Payouts go to your bank account\./);
          assert.doesNotMatch(after, /marketplace terms/, 'the terms are not asked again');

          const live = visible(await (await get('/app/schedule?published=1', coachCookie)).text());
          assert.doesNotMatch(live, /can't pay you/, 'the schedule no longer warns about payments');
        });

        await step('5. a parent books, pays on the signed buy link, and the manage page shows the booking', async () => {
          const pubHtml = await (await get(`/c/${handle}`)).text();
          const group = sessionCards(pubHtml).find((c) => c.name === 'Group');
          assert.ok(group?.book, 'the parent taps Book on a group session');
          const bookPath = group.book;
          const sessionId = Number(/\/sessions\/(\d+)\/book$/.exec(bookPath)?.[1]);

          const bookForm = await get(bookPath);
          assert.equal(bookForm.status, 200);
          const bookHtml = await bookForm.text();
          assert.match(visible(bookHtml), /^Book a session — Coachatron Group Sat, \w{3} \d{1,2}, 9:00 AM — \$25\.00/);
          for (const name of ['athlete_name', 'contact_phone', 'sms_consent', 'contact_email']) {
            assert.match(bookHtml, new RegExp(`name="${name}"`), `the booking form asks for ${name}`);
          }

          const booked = await postForm(bookPath, {
            athlete_name: 'Sam Lee',
            contact_phone: '(512) 555-0142',
            contact_email: PARENT_EMAIL,
            sms_consent: '1',
          });
          assert.equal(booked.status, 303, 'the booking form goes on to checkout');
          const checkoutPath = booked.headers.get('location') ?? '';
          const bookingId = Number(new RegExp(`^/c/${handle}/checkout/(\\d+)$`).exec(checkoutPath)?.[1]);
          assert.ok(bookingId > 0, `checkout is /c/<handle>/checkout/<booking>: ${checkoutPath}`);
          const pending = await db.query<{ status: string; contact_phone: string; session_id: number }>(
            'select status, contact_phone, session_id from booking where id = $1',
            [bookingId],
          );
          assert.deepEqual(pending.rows[0], { status: 'pending', contact_phone: PARENT_PHONE, session_id: sessionId });

          const checkout = visible(await (await get(checkoutPath)).text());
          assert.match(checkout, /this app never sees a card/);
          assert.match(checkout, /Pay \$25\.00 — this session only/);

          const pay = await postForm(checkoutPath, { mode: 'dropin' });
          assert.equal(pay.status, 303, 'paying sends the parent to the hosted page');
          const location = pay.headers.get('location') ?? '';
          const buy = new URL(location);
          assert.equal(buy.origin, new URL(relay.url).origin, 'the buy link goes to the relay');
          assert.equal(buy.pathname, `/buy/connect/coachatron/${handle}`, "it pays this coach's seller");
          const q = Object.fromEntries(buy.searchParams);
          assert.deepEqual(Object.keys(q), ['amount', 'currency', 'user', 'email', 'return', 'desc', 'exp', 'nonce', 'sig']);
          assert.equal(q.amount, '2500', 'the amount is the session price in cents');
          assert.equal(q.currency, 'USD');
          assert.equal(q.user, `booking:${bookingId}:dropin`, 'the buyer ref names the booking and the drop-in');
          assert.equal(q.email, PARENT_EMAIL);
          assert.equal(q.return, `${appBase}${checkoutPath}`, 'the hosted page returns to this checkout');
          assert.match(q.desc, /^Group — Sat, \w{3} \d{1,2}, 9:00\sAM$/, 'the hosted page says what is being paid for');
          const nowS = Math.floor(Date.now() / 1000);
          assert.ok(Number(q.exp) > nowS && Number(q.exp) <= nowS + 86_400 + 60, `the link expires within a day: ${q.exp}`);
          assert.match(q.nonce, /^[a-f0-9]{24}$/);
          assert.match(q.sig, /^[a-f0-9]{64}$/);
          const sign = (change: Partial<Parameters<typeof signConnectBuyLink>[0]> = {}) =>
            signConnectBuyLink({
              secret: TEST_STORE_SECRET,
              product: 'coachatron',
              seller: handle,
              amountCents: 2500,
              currency: 'USD',
              user: q.user,
              email: q.email,
              returnUrl: q.return,
              description: q.desc,
              exp: Number(q.exp),
              nonce: q.nonce,
              baseUrl: relay.url,
              ...change,
            });
          const resigned = sign();
          assert.equal(resigned.sig, q.sig, 'the link is what the store client signs for these params under the signing key');
          assert.equal(resigned.url, location, 'the link is exactly what the store client signs');
          for (const [field, change] of [
            ['amount', { amountCents: 2501 }],
            ['buyer', { user: `booking:${bookingId + 1}:dropin` }],
            ['return', { returnUrl: `${appBase}/c/${handle}` }],
            ['description', { description: 'Private' }],
          ] as const) {
            assert.notEqual(sign(change).sig, q.sig, `a different ${field} gives a different signature`);
          }

          const hosted = await fetch(location, { redirect: 'manual' });
          assert.equal(hosted.status, 303, 'the hosted page sends the parent back');
          assert.equal(hosted.headers.get('location'), q.return);
          assert.deepEqual(relay.buyLinks, [{ product: 'coachatron', seller: handle, amountCents: 2500, user: q.user }]);

          const paid = await postStorePaid(base, {
            userId: q.user,
            amountCents: Number(q.amount),
            paymentId: PAYMENT_ID,
            sellerKey: handle,
          });
          assert.equal(paid.status, 200, 'a signed purchase.paid event is accepted');
          assert.deepEqual(await paid.json(), { ok: true, handled: true });

          const row = await db.query<{ status: string; payment_source: string; gross_cents: number; charge_id: string; manage_token: string }>(
            'select status, payment_source, gross_cents, charge_id, manage_token from booking where id = $1',
            [bookingId],
          );
          const b = row.rows[0];
          assert.equal(b.status, 'booked', 'the payment books the session');
          assert.equal(b.payment_source, 'DropIn');
          assert.equal(b.gross_cents, 2500);
          assert.equal(b.charge_id, PAYMENT_ID, 'the payment ref is kept for refunds');
          assert.match(b.manage_token, /^[a-f0-9]{64}$/);

          const back = visible(await (await get(checkoutPath)).text());
          assert.match(back, /You're booked Group — Sat, \w{3} \d{1,2}, 9:00 AM/, 'the return page confirms the booking');
          const after = sessionCards(await (await get(`/c/${handle}`)).text()).find((c) => c.book === bookPath);
          assert.equal(after?.detail, '7 spots left · $25.00', 'the coach page counts the paid spot');

          // The manage link is read from the booking row; a booking
          // confirmation that carries it can assert it here.
          const manage = await get(`/booking/${b.manage_token}`);
          assert.equal(manage.status, 200, 'the manage page opens from its link');
          const manageText = visible(await manage.text());
          assert.match(manageText, /Group Sat, \w{3} \d{1,2}, 9:00 AM/);
          assert.match(manageText, /Athlete: Sam Lee Status: Confirmed/);
          assert.match(manageText, /Cancel this booking/);
          assert.match(manageText, new RegExp(`Back to ${handle}'s page`));
        });
      });
    } finally {
      resetComplete();
    }
  });
});
