import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { seedBookedSession, seedCoachWithSession, type SeededSession } from './helpers/fixtures.js';
import { proveEmail, proveMobile, sessionsPage, visible } from './helpers/my-sessions.js';
import { sendBookingConfirmation } from '../src/domain/bookingMessages.js';
import { createCredit, createPendingBooking } from '../src/domain/pricing.js';
import { recordPaymentAttention } from '../src/domain/paymentAttention.js';
import { formatClockLocal } from '../src/lib/time.js';
import type { DbClient } from '../src/db/client.js';

/** What the My sessions page shows once a contact is proven: that parent's
 * sessions and credits across coaches, and nobody else's. */

const DAY = 24 * 60 * 60 * 1000;

async function manageToken(db: DbClient, bookingId: number): Promise<string> {
  return (await db.query<{ manage_token: string }>('select manage_token from booking where id = $1', [bookingId])).rows[0].manage_token;
}

/** A coach with their own name, so two coaches read apart on one page. */
async function coachNamed(db: DbClient, name: string, opts: { capacity?: number } = {}): Promise<SeededSession> {
  const seed = await seedCoachWithSession(db, { capacity: opts.capacity ?? 6 });
  await db.query('update coach set name = $2 where id = $1', [seed.coach.id, name]);
  return { ...seed, coach: { ...seed.coach, name } };
}

/** Another session of the coach's type, `days` from now (negative: ago). */
async function sessionIn(db: DbClient, seed: SeededSession, days: number, opts: { location?: string; status?: string } = {}): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status, location_text)
     values ($1, $2, 'America/Chicago', $3, $4) returning id`,
    [seed.sessionTypeId, new Date(Date.now() + days * DAY).toISOString(), opts.status ?? 'scheduled', opts.location ?? null],
  );
  return r.rows[0].id;
}

async function book(db: DbClient, sessionId: number, athlete: string, phone: string, opts: { email?: string; status?: string } = {}): Promise<number> {
  const id = await seedBookedSession(db, sessionId, athlete, phone);
  await db.query('update booking set contact_email = $2, status = $3 where id = $1', [id, opts.email ?? null, opts.status ?? 'booked']);
  return id;
}

/** The three parts of the page, as a reader sees them. */
function parts(html: string): { comingUp: string; past: string; credits: string } {
  const text = visible(html);
  const match = /Coming up (.*?) Past The last 90 days\. (.*?) Session credits (.*) Sign out/.exec(text);
  assert.ok(match, `the page has its three parts: ${text.slice(0, 200)}`);
  return { comingUp: match[1], past: match[2], credits: match[3] };
}

test('each parent sees their own sessions across coaches, and nothing of another parent', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const lee = await coachNamed(db, 'Lee Park');
    const ana = '+15551230001';
    const ben = '+15551230002';
    const anaMia = await manageToken(db, await book(db, dana.sessionId, 'Mia Ana', ana));
    const anaLeo = await manageToken(db, await book(db, lee.sessionId, 'Leo Ana', ana));
    const benZoe = await manageToken(db, await book(db, dana.sessionId, 'Zoe Ben', ben, { email: 'ben@example.com' }));
    await book(db, await sessionIn(db, dana, -3), 'Mia Ana', ana, { status: 'attended' });
    await book(db, await sessionIn(db, lee, -3), 'Zoe Ben', ben, { status: 'attended' });
    await createCredit(db, dana.coach.id, ana, null, 'test', 4, null);
    await createCredit(db, lee.coach.id, ben, null, 'test', 7, null);

    await withServer(async (base) => {
      const anaHtml = await (await sessionsPage(base, await proveMobile(base, relay, ana))).text();
      const benHtml = await (await sessionsPage(base, await proveMobile(base, relay, ben))).text();
      const anaPage = parts(anaHtml);
      const benPage = parts(benHtml);

      assert.match(anaPage.comingUp, /Mia Ana · Goalkeeper Group Dana Rivera/);
      assert.match(anaPage.comingUp, /Leo Ana · Goalkeeper Group Lee Park/);
      assert.match(anaPage.past, /Mia Ana · Goalkeeper Group · Dana Rivera Attended/);
      assert.match(anaPage.credits, /Dana Rivera 4 sessions left/);
      assert.ok(anaHtml.includes(`href="/booking/${anaMia}"`) && anaHtml.includes(`href="/booking/${anaLeo}"`), 'each booking links to its manage page');
      for (const others of ['Zoe', 'Ben', benZoe, 'ben@example.com', ben, '123-0002', '7 sessions']) {
        assert.ok(!anaHtml.includes(others), `Ana's page shows nothing of Ben's: ${others}`);
      }

      assert.match(benPage.comingUp, /Zoe Ben · Goalkeeper Group Dana Rivera/);
      assert.match(benPage.past, /Zoe Ben · Goalkeeper Group · Lee Park Attended/);
      assert.match(benPage.credits, /Lee Park 7 sessions left/);
      for (const others of ['Mia', 'Leo', 'Ana', anaMia, anaLeo, ana, '123-0001', '4 sessions']) {
        assert.ok(!benHtml.includes(others), `Ben's page shows nothing of Ana's: ${others}`);
      }

      // Nothing of the coach beyond their name and public page.
      for (const html of [anaHtml, benHtml]) {
        for (const coach of [dana.coach, lee.coach]) {
          assert.ok(coach.phone && !html.includes(coach.phone), "no coach's phone");
          assert.ok(!html.includes(`${coach.phone.slice(5, 8)}-${coach.phone.slice(8)}`), "no coach's phone, written for reading");
          assert.ok(!html.includes(coach.email), "no coach's email");
        }
      }
      assert.ok(anaHtml.includes(`href="/c/${dana.coach.handle}"`), "the coach's public page");
    });
  });
});

test('an email proof shows the bookings made with that email, whatever its case, and never credits', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const phone = '+15551230010';
    await book(db, dana.sessionId, 'Mia', phone, { email: 'Pat.Lee@Example.com' });
    // The same mobile, booked with another address: not this email's.
    await book(db, dana.sessionId, 'Leo', phone, { email: 'other@example.com' });
    // The same address on another mobile's booking: this email's.
    await book(db, dana.sessionId, 'Sam', '+15551230011', { email: 'pat.lee@example.com' });
    await createCredit(db, dana.coach.id, phone, null, 'test', 5, null);

    await withServer(async (base) => {
      const html = await (await sessionsPage(base, await proveEmail(base, relay, 'pat.lee@EXAMPLE.com'))).text();
      const page = parts(html);
      assert.match(visible(html), /Booked with pat\.lee@example\.com\./);
      assert.match(page.comingUp, /Mia · Goalkeeper Group/);
      assert.match(page.comingUp, /Sam · Goalkeeper Group/);
      assert.doesNotMatch(page.comingUp, /Leo/, 'a booking made with another address is not shown');

      assert.equal(page.credits, 'Verify your mobile to see credits. They are kept under the mobile number you booked with. Mobile number Text me a code');
      assert.doesNotMatch(html, /5 sessions|sessions left/, 'an email never shows credits');
      assert.ok(!html.includes(phone) && !html.includes('123-0010'), "the booking's mobile is not shown to someone who proved only the email");
      // The way to do it: the same request, with a mobile.
      assert.match(html, /<form method="post" action="\/my">\s*<label for="mobile">Mobile number<\/label>/);

      // The mobile shows the credits, and its own bookings whatever email they carry.
      const byMobile = await (await sessionsPage(base, await proveMobile(base, relay, phone))).text();
      const mobilePage = parts(byMobile);
      assert.match(mobilePage.credits, /Dana Rivera 5 sessions left/);
      assert.match(mobilePage.comingUp, /Mia/);
      assert.match(mobilePage.comingUp, /Leo/);
      assert.doesNotMatch(mobilePage.comingUp, /Sam/, "another mobile's booking is not shown, even with a shared email");
      assert.doesNotMatch(byMobile, /Verify your mobile/);
    });
  });
});

test('coming up: each booking with its athlete, session, time in the session\'s zone, place and coach; a hold reads as held', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const phone = '+15551230020';
    const far = await sessionIn(db, dana, 5, { location: 'Field 3' });
    await db.query("update session set tz = 'America/Los_Angeles' where id = $1", [far]);
    const farToken = await manageToken(db, await book(db, far, 'Mia', phone));
    const soonToken = await manageToken(db, await book(db, dana.sessionId, 'Leo', phone));

    // A spot held at checkout, not paid yet.
    const heldSession = await sessionIn(db, dana, 2);
    const held = await createPendingBooking(db, { sessionId: heldSession, capacity: 6, athleteName: 'Sam', contactPhone: phone, contactEmail: null });
    assert.ok(held);
    const holdUntil = (await db.query<{ hold_expires_at: string }>('select hold_expires_at from booking where id = $1', [held.id])).rows[0].hold_expires_at;
    // A hold that ran out, and one whose payment arrived but could not book.
    const lapsed = await createPendingBooking(db, { sessionId: await sessionIn(db, dana, 3), capacity: 6, athleteName: 'Lapsed', contactPhone: phone, contactEmail: null });
    assert.ok(lapsed);
    await db.query("update booking set hold_expires_at = now() - interval '1 minute' where id = $1", [lapsed.id]);
    const kept = await createPendingBooking(db, { sessionId: await sessionIn(db, dana, 4), capacity: 6, athleteName: 'Kay', contactPhone: phone, contactEmail: null });
    assert.ok(kept);
    await db.query("update booking set hold_expires_at = now() - interval '1 minute' where id = $1", [kept.id]);
    await recordPaymentAttention(db, {
      eventId: 'evt_kept',
      reason: 'session_full',
      coachId: dana.coach.id,
      bookingId: kept.id,
      amountCents: 3500,
      paymentRef: 'pay_kept',
    });
    // Cancelled before it happens: not coming up.
    await book(db, await sessionIn(db, dana, 6), 'Cancelled Kid', phone, { status: 'cancelled' });

    await withServer(async (base) => {
      const html = await (await sessionsPage(base, await proveMobile(base, relay, phone))).text();
      const { comingUp, past } = parts(html);

      // Soonest first.
      const order = ['Leo', 'Sam', 'Kay', 'Mia'].map((name) => comingUp.indexOf(`${name} · Goalkeeper Group`));
      assert.ok(order.every((at) => at >= 0), comingUp);
      assert.deepEqual([...order].sort((a, b) => a - b), order, 'soonest first');

      // The session's own zone, named.
      const farStart = (await db.query<{ starts_at_utc: string }>('select starts_at_utc from session where id = $1', [far])).rows[0].starts_at_utc;
      const inZone = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(farStart));
      assert.match(inZone, /P[SD]T$/);
      assert.ok(comingUp.includes(`${inZone} Mia · Goalkeeper Group Dana Rivera Field 3 Manage this booking`), comingUp);
      assert.match(comingUp, /C[SD]T Leo · Goalkeeper Group Dana Rivera Manage this booking/);
      assert.ok(html.includes(`<a href="/booking/${farToken}">Manage this booking</a>`));
      assert.ok(html.includes(`<a href="/booking/${soonToken}">Manage this booking</a>`));

      assert.ok(
        comingUp.includes(`Sam · Goalkeeper Group Dana Rivera Held until ${formatClockLocal(holdUntil, 'America/Chicago')}. Not paid yet. Manage this booking`),
        comingUp,
      );
      assert.match(comingUp, /Kay · Goalkeeper Group Dana Rivera Payment received, not booked\. Dana Rivera will be in touch\./);
      assert.doesNotMatch(html, /Lapsed/, 'a hold that ran out is not a booking');
      assert.doesNotMatch(comingUp, /Cancelled Kid/);
      assert.match(past, /Cancelled Kid · Goalkeeper Group · Dana Rivera Cancelled/);
    });
  });
});

test('past: the last 90 days, in a parent\'s words', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const phone = '+15551230030';
    await book(db, await sessionIn(db, dana, -2), 'Went', phone, { status: 'attended' });
    await book(db, await sessionIn(db, dana, -4), 'Skipped', phone, { status: 'noshow' });
    await book(db, await sessionIn(db, dana, -6), 'Called Off', phone, { status: 'cancelled' });
    await book(db, await sessionIn(db, dana, -8), 'Money Back', phone, { status: 'refunded' });
    await book(db, await sessionIn(db, dana, -10), 'Unmarked', phone);
    await book(db, await sessionIn(db, dana, -12, { status: 'cancelled' }), 'Coach Cancelled', phone, { status: 'cancelled' });
    await book(db, await sessionIn(db, dana, -89), 'Edge', phone, { status: 'attended' });
    await book(db, await sessionIn(db, dana, -91), 'Too Old', phone, { status: 'attended' });

    await withServer(async (base) => {
      const html = await (await sessionsPage(base, await proveMobile(base, relay, phone))).text();
      const { comingUp, past } = parts(html);
      assert.equal(comingUp, 'Nothing coming up.');
      for (const [name, word] of [
        ['Went', 'Attended'],
        ['Skipped', 'Missed'],
        ['Called Off', 'Cancelled'],
        ['Money Back', 'Refunded'],
        ['Unmarked', 'Booked'],
        ['Coach Cancelled', 'Cancelled'],
        ['Edge', 'Attended'],
      ]) {
        assert.ok(past.includes(`${name} · Goalkeeper Group · Dana Rivera ${word}`), `${name}: ${past}`);
      }
      assert.doesNotMatch(html, /Too Old/, 'older than 90 days is not shown');
      // Most recent first.
      assert.ok(past.indexOf('Went') < past.indexOf('Skipped') && past.indexOf('Skipped') < past.indexOf('Edge'));
      // The coach's words for a booking never appear.
      assert.doesNotMatch(visible(html), /noshow|No-show|Ready to mark/);
    });
  });
});

test('credits: per coach, how many remain, any expiry, and what a refund on its way holds', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const lee = await coachNamed(db, 'Lee Park');
    const kim = await coachNamed(db, 'Kim Ortiz');
    const phone = '+15551230040';
    const expires = new Date(Date.now() + 40 * DAY);
    const sooner = new Date(Date.now() + 10 * DAY);
    await createCredit(db, dana.coach.id, phone, null, 'test', 2, expires);
    await createCredit(db, dana.coach.id, phone, null, 'test', 1, sooner);
    await createCredit(db, dana.coach.id, phone, null, 'test', 3, null);
    // Not usable, so not counted: used up, expired, and withdrawn by a refund.
    await createCredit(db, dana.coach.id, phone, null, 'test', 0, null);
    await createCredit(db, dana.coach.id, phone, null, 'test', 9, new Date(Date.now() - DAY));
    const withdrawn = await createCredit(db, dana.coach.id, phone, null, 'test', 0, null);
    await db.query('update credit set withdrawn_at = now() where id = $1', [withdrawn]);
    // Held while a refund of the payment that bought it is on its way.
    const refund = await db.query<{ id: number }>(
      "insert into refund (coach_id, payment_ref, status) values ($1, 'pay_held', 'pending') returning id",
      [dana.coach.id],
    );
    const heldCredit = await createCredit(db, dana.coach.id, phone, null, 'test', 2, null);
    await db.query('update credit set refund_id = $2 where id = $1', [heldCredit, refund.rows[0].id]);
    // A coach where only held credit is left, one with plain credit, and another parent's credit.
    const leeRefund = await db.query<{ id: number }>(
      "insert into refund (coach_id, payment_ref, status) values ($1, 'pay_held_2', 'requested') returning id",
      [lee.coach.id],
    );
    const leeHeld = await createCredit(db, lee.coach.id, phone, null, 'test', 1, null);
    await db.query('update credit set refund_id = $2 where id = $1', [leeHeld, leeRefund.rows[0].id]);
    await createCredit(db, kim.coach.id, phone, null, 'test', 1, null);
    await createCredit(db, kim.coach.id, '+15551230041', null, 'test', 8, null);

    await withServer(async (base) => {
      const html = await (await sessionsPage(base, await proveMobile(base, relay, phone))).text();
      const { credits } = parts(html);
      const date = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
      assert.ok(
        credits.includes(
          `Dana Rivera 6 sessions left 1 expires ${date(sooner)} · 2 expire ${date(expires)} · 3 with no expiry 2 sessions on hold while a refund is on its way. See Dana Rivera's sessions`,
        ),
        credits,
      );
      assert.ok(credits.includes("Lee Park No sessions to use right now 1 session on hold while a refund is on its way. See Lee Park's sessions"), credits);
      assert.ok(credits.includes("Kim Ortiz 1 session left See Kim Ortiz's sessions"), credits);
      assert.doesNotMatch(credits, /8 sessions|9 sessions/);

      // A mobile with none.
      const none = parts(await (await sessionsPage(base, await proveMobile(base, relay, '+15551230042'))).text());
      assert.equal(none.comingUp, 'Nothing coming up.');
      assert.equal(none.past, 'Nothing in the last 90 days.');
      assert.equal(none.credits, 'No session credits on this number.');
    });
  });
});

test('nothing is changed from this page: it has links, and no cancel or move', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const phone = '+15551230050';
    await book(db, dana.sessionId, 'Mia', phone, { email: 'pat@example.com' });
    await withServer(async (base) => {
      const forms = (html: string) => [...html.matchAll(/<form[^>]*action="([^"]*)"/g)].map((m) => m[1]);
      const byMobile = await (await sessionsPage(base, await proveMobile(base, relay, phone))).text();
      assert.deepEqual(forms(byMobile), ['/my/signout'], 'signing out is the only form');
      assert.doesNotMatch(byMobile, /Cancel this booking|Move to /);
      const byEmail = await (await sessionsPage(base, await proveEmail(base, relay, 'pat@example.com'))).text();
      assert.deepEqual(forms(byEmail), ['/my', '/my/signout'], 'plus the mobile form after an email proof');

      // The page takes no posts, and a booking is still booked.
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await fetch(`${base}/my/sessions`, { method, redirect: 'manual' });
        assert.equal(res.status, 404, method);
      }
      assert.equal((await db.query("select 1 from booking where status = 'booked'")).rows.length, 1);
    });
  });
});

test('ways in: the manage page, the coach\'s public page and the confirmation email link to /my, and no text changes', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const dana = await coachNamed(db, 'Dana Rivera');
    const bookingId = await book(db, dana.sessionId, 'Mia', '+15551230060', { email: 'pat@example.com' });
    const token = await manageToken(db, bookingId);
    const prev = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'https://coachatron.test';
    try {
      await withServer(async (base) => {
        const link = /<a href="\/my">See all your sessions<\/a>/;
        assert.match(await (await fetch(`${base}/booking/${token}`)).text(), link, 'the manage page');
        assert.match(await (await fetch(`${base}/c/${dana.coach.handle}`)).text(), link, "the coach's public page");
        assert.match(await (await fetch(`${base}/c/${dana.coach.handle}?from=${token}`)).text(), link);
      });
      const sent = await sendBookingConfirmation(db, bookingId);
      assert.deepEqual(sent, { text: 'sent', email: 'sent' });
      const email = relay.emails.at(-1);
      assert.ok(email);
      assert.ok(email.text.includes('\n\nSee all your sessions: https://coachatron.test/my\n\nCoachatron'), email.text);
      assert.ok((email.html ?? '').includes('<a href="https://coachatron.test/my">See all your sessions</a>'), email.html ?? '');
      assert.ok(email.text.includes(`https://coachatron.test/booking/${token}`), 'the manage link is still there');
      // The address is the same for everyone: nothing of the booking rides on it.
      assert.doesNotMatch(email.text, /\/my[/?]/);

      // The confirmation text is what it was.
      const text = relay.sms.at(-1);
      assert.ok(text);
      assert.match(text.body, /^Coachatron: Mia is booked: Goalkeeper\S* /);
      assert.ok(text.body.endsWith(` https://coachatron.test/booking/${token} Reply STOP to opt out.`), text.body);
      assert.ok(!text.body.includes('/my'));
    } finally {
      if (prev === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prev;
    }
  });
});
