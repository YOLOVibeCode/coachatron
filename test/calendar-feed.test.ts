import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { coachCookie, getPage, postForm } from './helpers/refunds.js';
import { seedBookedSession, seedCoachWithSession, seedRosterMember, seedWaitlistEntry } from './helpers/fixtures.js';
import { assertFolded, contentLines, eventFor, parseCalendar, physicalLines, unescapeText, utcInstant } from './helpers/ical.js';
import {
  buildCalendarFeed,
  CALENDAR_ADDRESS_LIMITS,
  CALENDAR_FEED_LIMITS,
  calendarFeedKey,
  FEED_MAX_EVENTS,
  findFeedCoach,
  getCalendarToken,
  replaceCalendarToken,
  turnOffCalendarFeed,
  turnOnCalendarFeed,
} from '../src/domain/calendarFeed.js';
import { createPendingBooking } from '../src/domain/pricing.js';
import { zonedTimeToUtc } from '../src/domain/scheduling.js';
import { pathForLog } from '../src/lib/headers.js';
import { setDb, type DbClient } from '../src/db/client.js';
import type { LimitRule } from '../src/domain/requestLimits.js';

/** The coach's calendar link (SPEC.md §8.2): the "Add to your calendar"
 * block on Schedule, and the calendar file at /cal/<token>.ics. */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A request as if from this address: the app trusts one proxy hop, as on
 * Railway, so this is what it takes the client's address to be. */
const from = (address: string) => ({ 'x-forwarded-for': address });

/** The link the Schedule screen shows, or null when it shows none. */
async function linkOnSchedule(base: string, cookie: string, query = ''): Promise<string | null> {
  const page = await getPage(base, `/app/schedule${query}`, cookie);
  const match = /<input id="calendar-link" type="text" readonly value="https:\/\/coachatron\.com\/cal\/([^"]+)\.ics"/.exec(page);
  return match ? match[1] : null;
}

/** First use, as the coach does it: the block's one button. */
async function turnOnFromSchedule(base: string, cookie: string): Promise<string> {
  const res = await postForm(base, '/app/schedule/calendar', cookie, { action: 'on' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/app/schedule#calendar');
  const token = await linkOnSchedule(base, cookie);
  assert.ok(token, 'Schedule shows the link');
  assert.match(token, TOKEN, 'at least 32 random bytes, URL-safe');
  return token;
}

async function sessionAt(db: DbClient, typeId: number, startsAt: Date, extra: { location?: string; status?: string } = {}): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, location_text, status)
     values ($1, $2, 'America/Chicago', $3, $4) returning id`,
    [typeId, startsAt.toISOString(), extra.location ?? null, extra.status ?? 'scheduled'],
  );
  return r.rows[0].id;
}

/** Sets a limit's counter for this hour and the next, so a test reads the
 * same whether or not the hour turns over while it runs. */
async function setHits(db: DbClient, rules: LimitRule[], key: string, hits: number): Promise<void> {
  for (const rule of rules) {
    const start = Math.floor(Date.now() / rule.windowMs) * rule.windowMs;
    for (const windowStart of [start, start + rule.windowMs]) {
      await db.query(
        `insert into request_limit (bucket, key, window_start, hits) values ($1, $2, $3, $4)
         on conflict (bucket, key, window_start) do update set hits = excluded.hits`,
        [rule.bucket, key, new Date(windowStart).toISOString(), hits],
      );
    }
  }
}

/** Asks for the file again with the tag from last time, the way a calendar
 * app does. Not fetch: given If-None-Match, fetch adds Cache-Control:
 * no-cache of its own, which asks for the whole file whatever the tag. */
function askAgain(url: string, etag: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers: { 'if-none-match': etag, connection: 'close' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('Schedule offers the calendar link, and first use makes one and shows how to add it', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = await coachCookie(db, seed.coach.id);
    await withServer(async (base) => {
      const before = await getPage(base, '/app/schedule', cookie);
      assert.match(before, /<h2 id="calendar">Add to your calendar<\/h2>/);
      assert.match(before, /<button type="submit" name="action" value="on" class="ghost">Get your calendar link<\/button>/);
      assert.doesNotMatch(before, /webcal:/, 'no link until the coach asks for one');
      assert.equal(await getCalendarToken(db, seed.coach.id), null);

      const token = await turnOnFromSchedule(base, cookie);
      assert.equal(await getCalendarToken(db, seed.coach.id), token);
      const page = await getPage(base, '/app/schedule', cookie);
      assert.ok(page.includes(`<a class="action ghost" href="webcal://coachatron.com/cal/${token}.ics">Add to calendar</a>`), 'a webcal link to tap');
      assert.ok(page.includes(`value="https://coachatron.com/cal/${token}.ics"`), 'the https link to copy');
      assert.match(page, /<label for="calendar-link">Or copy the link<\/label>/);
      assert.match(page, /<p class="muted">Apple \(iPhone, iPad or Mac\): [^<]+<\/p>/, 'one line for Apple');
      assert.match(page, /<p class="muted">Google: [^<]+<\/p>/, 'one line for Google');
      assert.match(page, /<a class="action ghost" href="\/app\/schedule\?calendar=new#calendar">Get a new link<\/a>/);
      assert.match(page, /<a class="action ghost" href="\/app\/schedule\?calendar=off#calendar">Turn off<\/a>/);

      // Sending the form again keeps the link a calendar may already use.
      assert.equal(await turnOnFromSchedule(base, cookie), token);
      // A value the form does not send changes nothing.
      const odd = await postForm(base, '/app/schedule/calendar', cookie, { action: 'everything' });
      assert.equal(odd.status, 303);
      assert.equal(await getCalendarToken(db, seed.coach.id), token);
    });
  });
});

test('the link answers a calendar file with what a calendar app needs, with no sign-in and no cookie', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 8 });
    await db.query("update session_type set name = 'Skills Group' where id = $1", [seed.sessionTypeId]);
    await db.query("update session set location_text = 'Field 3' where id = $1", [seed.sessionId]);
    for (let i = 1; i <= 6; i += 1) await seedBookedSession(db, seed.sessionId, `Athlete ${i}`, `+1555000100${i}`);
    await seedWaitlistEntry(db, seed.sessionId, 'Waiting One', '+15550002001');
    await seedWaitlistEntry(db, seed.sessionId, 'Waiting Two', '+15550002002');
    // The fixture's session starts at some millisecond; a calendar time is
    // to the second.
    const startsAt = (await db.query<{ starts_at_utc: string | Date }>('select starts_at_utc from session where id = $1', [seed.sessionId])).rows[0]
      .starts_at_utc;
    const start = new Date(Math.floor(new Date(startsAt).getTime() / 1000) * 1000);
    const cookie = await coachCookie(db, seed.coach.id);
    await withServer(async (base) => {
      const token = await turnOnFromSchedule(base, cookie);
      const earlier = new Date(Math.floor(Date.now() / 1000) * 1000);
      const env = process.env.APP_ENV;
      // In production, where pages may be indexed, the file still says not to.
      process.env.APP_ENV = 'production';
      let res: Response;
      try {
        res = await fetch(`${base}/cal/${token}.ics`);
      } finally {
        if (env === undefined) delete process.env.APP_ENV;
        else process.env.APP_ENV = env;
      }
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/calendar; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'private, max-age=300');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex');
      assert.equal(res.headers.get('set-cookie'), null);
      assert.match(res.headers.get('etag') ?? '', /^W\/"[A-Za-z0-9_-]{32}"$/);
      const body = await res.text();
      assertFolded(body);
      const calendar = parseCalendar(body);
      assert.equal(calendar.props.get('VERSION'), '2.0');
      assert.equal(calendar.props.get('PRODID'), '-//Coachatron//Schedule//EN');
      assert.equal(calendar.props.get('CALSCALE'), 'GREGORIAN');
      assert.equal(calendar.props.get('X-WR-CALNAME'), 'Coachatron: Jamie Coach');
      assert.equal(calendar.props.get('REFRESH-INTERVAL;VALUE=DURATION'), 'PT1H');
      assert.equal(calendar.props.get('X-PUBLISHED-TTL'), 'PT1H');
      assert.equal(calendar.events.length, 1);
      const event = eventFor(calendar, seed.sessionId);
      assert.deepEqual([...event.keys()], ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'DESCRIPTION', 'URL', 'STATUS']);
      const stamp = utcInstant(event.get('DTSTAMP')).getTime();
      assert.ok(stamp >= earlier.getTime() && stamp <= Date.now(), 'stamped when it was written');
      assert.equal(utcInstant(event.get('DTSTART')).getTime(), start.getTime());
      assert.equal(utcInstant(event.get('DTEND')).getTime(), start.getTime() + 60 * 60_000, 'the type runs 60 minutes');
      assert.equal(event.get('SUMMARY'), 'Skills Group (6 of 8)');
      assert.equal(event.get('LOCATION'), 'Field 3');
      assert.equal(
        unescapeText(event.get('DESCRIPTION') ?? ''),
        `6 of 8 booked, 2 waiting\nSession detail (sign in to open): https://coachatron.com/app/sessions/${seed.sessionId}`,
      );
      assert.equal(event.get('URL'), `https://coachatron.com/app/sessions/${seed.sessionId}`);
      assert.equal(event.get('STATUS'), 'CONFIRMED');

      // The link in the description is Session detail, which asks for sign-in.
      const detail = await fetch(`${base}/app/sessions/${seed.sessionId}`, { redirect: 'manual' });
      assert.equal(detail.status, 303);
      assert.equal(detail.headers.get('location'), '/signin');
    });
  });
});

test('times are UTC instants on both sides of a daylight-saving change', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const tz = 'America/Chicago';
  // Tuesdays at 6pm in Chicago. The clocks go back on Sun Nov 1 2026 and
  // forward on Sun Mar 14 2027, so the same clock time is a different UTC hour.
  const beforeFall = await sessionAt(db, seed.sessionTypeId, zonedTimeToUtc(2026, 10, 27, 18, 0, tz));
  const afterFall = await sessionAt(db, seed.sessionTypeId, zonedTimeToUtc(2026, 11, 3, 18, 0, tz));
  const beforeSpring = await sessionAt(db, seed.sessionTypeId, zonedTimeToUtc(2027, 3, 9, 18, 0, tz));
  const afterSpring = await sessionAt(db, seed.sessionTypeId, zonedTimeToUtc(2027, 3, 16, 18, 0, tz));
  const feed = await buildCalendarFeed(db, seed.coach, new Date('2026-10-20T12:00:00Z'));
  const calendar = parseCalendar(feed.body);
  const times = (id: number) => [eventFor(calendar, id).get('DTSTART'), eventFor(calendar, id).get('DTEND')];
  assert.deepEqual(times(beforeFall), ['20261027T230000Z', '20261028T000000Z'], '6pm CDT is 23:00 UTC');
  assert.deepEqual(times(afterFall), ['20261104T000000Z', '20261104T010000Z'], '6pm CST is 00:00 UTC the next day');
  assert.deepEqual(times(beforeSpring), ['20270310T000000Z', '20270310T010000Z']);
  assert.deepEqual(times(afterSpring), ['20270316T230000Z', '20270317T000000Z']);
  for (const event of calendar.events) {
    for (const name of ['DTSTAMP', 'DTSTART', 'DTEND']) assert.match(event.get(name) ?? '', /^\d{8}T\d{6}Z$/, name);
  }
  assert.equal(eventFor(calendar, beforeFall).get('DTSTAMP'), '20261020T120000Z');
});

test('a long name in another script is folded whole, and commas, semicolons, backslashes and line breaks are escaped', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const name = 'Entraînement technique – séance avancée, niveau 2; groupe « élite » 日本語のクラス 🏃🏃🏃 back\\slash';
  const place = 'Field 3, north gate; behind the lot\nBring water';
  await db.query('update session_type set name = $2 where id = $1', [seed.sessionTypeId, name]);
  await db.query('update session set location_text = $2 where id = $1', [seed.sessionId, place]);
  await db.query('update coach set name = $2 where id = $1', [seed.coach.id, "O'Neil, Pat; Jr."]);
  const member = await seedRosterMember(db, seed.coach.id, 'Lee, Sam; Jr.', 0);
  await db.query('update session set assigned_roster_member_id = $2 where id = $1', [seed.sessionId, member.id]);
  const coach = await findFeedCoach(db, await turnOnCalendarFeed(db, seed.coach.id));
  assert.ok(coach);
  const feed = await buildCalendarFeed(db, coach);
  assertFolded(feed.body);
  assert.ok(physicalLines(feed.body).length > contentLines(feed.body).length, 'the long lines were folded');
  const calendar = parseCalendar(feed.body);
  const event = eventFor(calendar, seed.sessionId);
  assert.equal(unescapeText(event.get('SUMMARY') ?? ''), `${name} (0 of 2)`);
  assert.equal(unescapeText(event.get('LOCATION') ?? ''), place);
  assert.equal(unescapeText(calendar.props.get('X-WR-CALNAME') ?? ''), "Coachatron: O'Neil, Pat; Jr.");
  assert.ok(unescapeText(event.get('DESCRIPTION') ?? '').includes('\nBackup coach: Lee, Sam; Jr.\n'));
  // As written: each special character has its backslash, and the line
  // break in the place is the two characters \n.
  const written = contentLines(feed.body);
  assert.ok(written.includes(String.raw`LOCATION:Field 3\, north gate\; behind the lot\nBring water`));
  const summary = written.find((l) => l.startsWith('SUMMARY:')) ?? '';
  assert.ok(summary.includes(String.raw`avancée\, niveau 2\; groupe`), summary);
  assert.ok(summary.includes(String.raw`back\\slash`), summary);
});

test('the file names no athlete or parent and carries no phone or email, with bookings present', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 4 });
    const booked = await seedBookedSession(db, seed.sessionId, 'Zelda Quartermain', '+15558675309');
    await db.query("update booking set contact_email = 'zelda.parent@example.org' where id = $1", [booked]);
    const gone = await seedBookedSession(db, seed.sessionId, 'Corwin Cancelled', '+15558675310');
    await db.query("update booking set status = 'cancelled', contact_email = 'corwin@example.org' where id = $1", [gone]);
    const hold = await createPendingBooking(db, {
      sessionId: seed.sessionId,
      capacity: 4,
      athleteName: 'Holden Paying',
      contactPhone: '+15558675311',
      contactEmail: 'holden@example.org',
    });
    assert.ok(hold);
    await seedWaitlistEntry(db, seed.sessionId, 'Ignatius Waiting', '+15558675312');
    await db.query("update waitlist set contact_email = 'ignatius@example.org' where session_id = $1", [seed.sessionId]);
    const past = await sessionAt(db, seed.sessionTypeId, new Date(Date.now() - 3 * DAY_MS));
    const attended = await seedBookedSession(db, past, 'Priya Attended', '+15558675313');
    await db.query("update booking set status = 'attended' where id = $1", [attended]);
    const cookie = await coachCookie(db, seed.coach.id);
    await withServer(async (base) => {
      const token = await turnOnFromSchedule(base, cookie);
      const body = await (await fetch(`${base}/cal/${token}.ics`)).text();
      const calendar = parseCalendar(body);
      assert.equal(eventFor(calendar, seed.sessionId).get('SUMMARY'), 'Goalkeeper Group (1 of 4)', 'the booking is counted');
      assert.equal(eventFor(calendar, past).get('SUMMARY'), 'Goalkeeper Group (1 of 4)', 'so is one who attended');
      const text = contentLines(body).join('\n');
      for (const secret of [
        'Zelda', 'Quartermain', 'Corwin', 'Holden', 'Ignatius', 'Priya',
        '8675309', '8675310', '8675311', '8675312', '8675313', '867-53', '867 53',
        'example.org', 'zelda.parent', 'corwin@', 'holden@', 'ignatius@',
        // The coach's own number and address stay out too.
        seed.coach.phone ?? 'no phone', seed.coach.phone?.slice(-7) ?? 'no phone', seed.coach.email,
      ]) {
        assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `the file does not carry ${secret}`);
      }
      // The only @ is in each event's id, and nothing looks like a phone number.
      const besidesIds = contentLines(body).filter((l) => !l.startsWith('UID:')).join('\n');
      assert.ok(!besidesIds.includes('@'), 'no address anywhere');
      assert.doesNotMatch(besidesIds, /\+1\d{10}|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b|\b\d{10,11}\b/);
      assert.doesNotMatch(text, /^(ATTENDEE|ORGANIZER|CONTACT)[;:]/m, 'no people properties');
    });
  });
});

test('a cancelled session stays with STATUS:CANCELLED, and a second group and a backup coach name the assistant', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db, { capacity: 2 });
    await db.query("update session_type set name = 'Skills Group' where id = $1", [seed.sessionTypeId]);
    const start = new Date(Date.now() + 3 * DAY_MS);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const ana = await seedRosterMember(db, seed.coach.id, 'Ana Ruiz', 1);

    // Full, with two waiting, and a second group opened for it and run by Sam.
    const full = await sessionAt(db, seed.sessionTypeId, start, { location: 'Field 3' });
    await seedBookedSession(db, full, 'One', '+15550003001');
    await seedBookedSession(db, full, 'Two', '+15550003002');
    await seedWaitlistEntry(db, full, 'Three', '+15550003003');
    await seedWaitlistEntry(db, full, 'Four', '+15550003004');
    const second = (
      await db.query<{ id: number }>(
        `insert into session (session_type_id, starts_at_utc, tz, location_text, assigned_roster_member_id, overflow_of, status)
         values ($1, $2, 'America/Chicago', 'Field 3', $3, $4, 'scheduled') returning id`,
        [seed.sessionTypeId, start.toISOString(), sam.id, full],
      )
    ).rows[0].id;
    await seedBookedSession(db, second, 'Five', '+15550003005');

    // A backup coach joined this one, and its spots grew from 2 to 4.
    const backed = await sessionAt(db, seed.sessionTypeId, new Date(start.getTime() + DAY_MS));
    await db.query('update session set assigned_roster_member_id = $2, capacity_override = 4 where id = $1', [backed, ana.id]);
    for (let i = 1; i <= 3; i += 1) await seedBookedSession(db, backed, `Backed ${i}`, `+1555000400${i}`);

    // Cancelled by the coach: its bookings went with it.
    const cancelled = await sessionAt(db, seed.sessionTypeId, new Date(start.getTime() + 2 * DAY_MS), { location: 'Field 3' });
    const lost = await seedBookedSession(db, cancelled, 'Six', '+15550003006');
    await db.query("update session set status = 'cancelled' where id = $1", [cancelled]);
    await db.query("update booking set status = 'cancelled' where id = $1", [lost]);

    const cookie = await coachCookie(db, seed.coach.id);
    await withServer(async (base) => {
      const token = await turnOnFromSchedule(base, cookie);
      const calendar = parseCalendar(await (await fetch(`${base}/cal/${token}.ics`)).text());
      const describe = (id: number) => unescapeText(eventFor(calendar, id).get('DESCRIPTION') ?? '').split('\n');

      assert.equal(eventFor(calendar, full).get('SUMMARY'), 'Skills Group (2 of 2)');
      assert.deepEqual(describe(full), ['2 of 2 booked, 2 waiting', `Session detail (sign in to open): https://coachatron.com/app/sessions/${full}`]);

      const group = eventFor(calendar, second);
      assert.equal(group.get('SUMMARY'), 'Skills Group (1 of 2)', 'the second group is its own event with its own count');
      assert.equal(group.get('DTSTART'), eventFor(calendar, full).get('DTSTART'));
      assert.equal(group.get('LOCATION'), 'Field 3');
      assert.equal(group.get('STATUS'), 'CONFIRMED');
      assert.deepEqual(describe(second), [
        '1 of 2 booked, 0 waiting',
        'Second group, coached by Sam Lee',
        `Session detail (sign in to open): https://coachatron.com/app/sessions/${second}`,
      ]);

      assert.equal(eventFor(calendar, backed).get('SUMMARY'), 'Skills Group (3 of 4)');
      assert.equal(describe(backed)[1], 'Backup coach: Ana Ruiz');

      const off = eventFor(calendar, cancelled);
      assert.equal(off.get('STATUS'), 'CANCELLED');
      assert.equal(off.get('SUMMARY'), 'Cancelled: Skills Group');
      assert.equal(off.get('UID'), `session-${cancelled}@coachatron.com`, 'the same id as before, so a calendar finds the event to remove');
      assert.equal(describe(cancelled)[0], 'Cancelled.');
      assert.equal(off.get('LOCATION'), 'Field 3');

      // The seeded session, plus these four, in the order they start.
      assert.deepEqual(
        calendar.events.map((e) => e.get('UID')),
        [seed.sessionId, full, second, backed, cancelled].map((id) => `session-${id}@coachatron.com`),
      );
      // An assistant's phone is not in the file; their name is.
      const body = await (await fetch(`${base}/cal/${token}.ics`)).text();
      assert.ok(!body.includes(sam.phone.slice(-7)) && !body.includes(ana.phone.slice(-7)));
    });
  });
});

test('a link shows only its own coach\'s sessions', async () => {
  const db = await freshDb();
  const mine = await seedCoachWithSession(db);
  const theirs = await seedCoachWithSession(db);
  const myToken = await turnOnCalendarFeed(db, mine.coach.id);
  const theirToken = await turnOnCalendarFeed(db, theirs.coach.id);
  assert.notEqual(myToken, theirToken);
  await withServer(async (base) => {
    const read = async (token: string) => parseCalendar(await (await fetch(`${base}/cal/${token}.ics`)).text()).events.map((e) => e.get('UID'));
    assert.deepEqual(await read(myToken), [`session-${mine.sessionId}@coachatron.com`]);
    assert.deepEqual(await read(theirToken), [`session-${theirs.sessionId}@coachatron.com`]);
  });
});

test('a new link replaces the old one at once, and turning it off leaves none: each old address is the same 404 as any other', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const cookie = await coachCookie(db, seed.coach.id);
    await withServer(async (base) => {
      const first = await turnOnFromSchedule(base, cookie);
      assert.equal((await fetch(`${base}/cal/${first}.ics`)).status, 200);

      const unknown = await fetch(`${base}/no-such-page`);
      assert.equal(unknown.status, 404);
      const unknownPage = await unknown.text();
      const assertGone = async (path: string) => {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 404, path);
        assert.equal(res.headers.get('content-type'), unknown.headers.get('content-type'), path);
        assert.equal(res.headers.get('cache-control'), unknown.headers.get('cache-control'), path);
        assert.equal(res.headers.get('etag'), unknown.headers.get('etag'), path);
        assert.equal(await res.text(), unknownPage, `${path} is the page any unknown address gets`);
      };
      // Never made, or not shaped like a link at all.
      await assertGone(`/cal/${'A'.repeat(43)}.ics`);
      await assertGone('/cal/short.ics');
      await assertGone(`/cal/${first}`);
      await assertGone(`/cal/${first}.txt`);
      await assertGone(`/cal/${first}.ics/more`);

      // The coach is asked before the link they use stops working.
      const asking = await getPage(base, '/app/schedule?calendar=new', cookie);
      assert.match(asking, /<strong>Get a new link\?<\/strong>/);
      assert.match(asking, /stops working at once/);
      assert.match(asking, /<button type="submit" name="action" value="new" class="action danger">Get a new link<\/button>/);
      assert.match(asking, /<a class="action ghost" href="\/app\/schedule#calendar">Keep this link<\/a>/);
      assert.equal(await getCalendarToken(db, seed.coach.id), first, 'asking changes nothing');

      const replaced = await postForm(base, '/app/schedule/calendar', cookie, { action: 'new' });
      assert.equal(replaced.status, 303);
      assert.equal(replaced.headers.get('location'), '/app/schedule?calendar=replaced#calendar');
      const second = await linkOnSchedule(base, cookie, '?calendar=replaced');
      assert.ok(second);
      assert.match(second, TOKEN);
      assert.notEqual(second, first);
      assert.match(await getPage(base, '/app/schedule?calendar=replaced', cookie), /This is your new link\. The one before no longer works/);
      await assertGone(`/cal/${first}.ics`);
      assert.equal((await fetch(`${base}/cal/${second}.ics`)).status, 200);

      const askingOff = await getPage(base, '/app/schedule?calendar=off', cookie);
      assert.match(askingOff, /<strong>Turn off your calendar link\?<\/strong>/);
      assert.match(askingOff, /<button type="submit" name="action" value="off" class="action danger">Turn off<\/button>/);
      assert.equal((await fetch(`${base}/cal/${second}.ics`)).status, 200, 'asking changes nothing');

      const off = await postForm(base, '/app/schedule/calendar', cookie, { action: 'off' });
      assert.equal(off.status, 303);
      assert.equal(off.headers.get('location'), '/app/schedule?calendar=turned-off#calendar');
      await assertGone(`/cal/${second}.ics`);
      await assertGone(`/cal/${first}.ics`);
      assert.equal(await getCalendarToken(db, seed.coach.id), null);
      const after = await getPage(base, '/app/schedule?calendar=turned-off', cookie);
      assert.match(after, /Your calendar link is off\./);
      assert.match(after, /Get your calendar link/);
      assert.doesNotMatch(after, /webcal:/);

      // Turning it on again is a new link, never an old one back.
      const third = await turnOnFromSchedule(base, cookie);
      assert.ok(third !== first && third !== second);
    });
  });
});

test('only the signed-in coach changes their own link', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const other = await seedCoachWithSession(db);
    const token = await turnOnCalendarFeed(db, seed.coach.id);
    await withServer(async (base) => {
      for (const action of ['on', 'new', 'off']) {
        const res = await postForm(base, '/app/schedule/calendar', '', { action });
        assert.equal(res.status, 303, action);
        assert.equal(res.headers.get('location'), '/signin', action);
      }
      const otherCookie = await coachCookie(db, other.coach.id);
      for (const action of ['new', 'off']) {
        assert.equal((await postForm(base, '/app/schedule/calendar', otherCookie, { action })).status, 303);
      }
      assert.equal(await getCalendarToken(db, seed.coach.id), token, 'another coach changes only their own link');
      assert.equal((await fetch(`${base}/cal/${token}.ics`)).status, 200);
      const otherPage = await getPage(base, '/app/schedule', otherCookie);
      assert.ok(!otherPage.includes(token), "another coach's screen never shows this link");
    });
  });
});

test('the file goes 30 days back, and holds at most 500 sessions: the ones to come first, then the latest that have started', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await db.query('delete from session where id = $1', [seed.sessionId]);
  const now = new Date('2026-06-15T12:00:00Z');
  const add = async (firstHour: number, count: number, stepHours: number) => {
    await db.query(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       select $1, $2::timestamptz + make_interval(hours => $3::int + g * $4::int), 'America/Chicago', 'scheduled'
       from generate_series(0, $5::int - 1) g`,
      [seed.sessionTypeId, now.toISOString(), firstHour, stepHours, count],
    );
  };
  const starts = async () => parseCalendar((await buildCalendarFeed(db, seed.coach, now)).body).events.map((e) => utcInstant(e.get('DTSTART')).getTime());
  const hoursFromNow = (ms: number) => (ms - now.getTime()) / HOUR_MS;

  // 40 that started in the last 30 days (12, 24, … 480 hours ago), three
  // from before that, and one right at the edge.
  await add(-480, 40, 12);
  await sessionAt(db, seed.sessionTypeId, new Date(now.getTime() - 31 * DAY_MS));
  await sessionAt(db, seed.sessionTypeId, new Date(now.getTime() - 45 * DAY_MS));
  await sessionAt(db, seed.sessionTypeId, new Date(now.getTime() - 400 * DAY_MS));
  await sessionAt(db, seed.sessionTypeId, new Date(now.getTime() - 30 * DAY_MS));
  // 450 to come, one an hour.
  await add(1, 450, 1);

  let got = await starts();
  assert.equal(got.length, 491, 'everything from 30 days back on, and nothing older');
  assert.equal(hoursFromNow(got[0]), -30 * 24, 'a session that started exactly 30 days ago is in');
  assert.deepEqual(got, [...got].sort((a, b) => a - b), 'in the order they start');
  assert.equal(hoursFromNow(got[got.length - 1]), 450);

  // 20 more to come: 511 in all, so the 11 oldest are left out.
  await add(451, 20, 1);
  got = await starts();
  assert.equal(got.length, FEED_MAX_EVENTS);
  assert.equal(FEED_MAX_EVENTS, 500);
  assert.equal(got.filter((t) => t > now.getTime()).length, 470, 'every session to come is kept');
  assert.equal(hoursFromNow(got[0]), -30 * 12, 'the latest 30 of the past ones stay');
  assert.equal(hoursFromNow(got[got.length - 1]), 470);

  // 50 more: more to come than fit, so the soonest 500 are kept.
  await add(471, 50, 1);
  got = await starts();
  assert.equal(got.length, 500);
  assert.deepEqual([hoursFromNow(got[0]), hoursFromNow(got[499])], [1, 500], 'the next 500, none of the past');
});

test('a calendar app that asks again is told nothing changed until something a calendar shows does', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const token = await turnOnCalendarFeed(db, seed.coach.id);

    // The moment it was written is in the file and not in the tag.
    const at = new Date('2026-06-15T12:00:00Z');
    const one = await buildCalendarFeed(db, seed.coach, at);
    const two = await buildCalendarFeed(db, seed.coach, new Date(at.getTime() + HOUR_MS));
    assert.notEqual(one.body, two.body);
    assert.equal(one.etag, two.etag);

    await withServer(async (base) => {
      const first = await fetch(`${base}/cal/${token}.ics`);
      const etag = first.headers.get('etag');
      assert.ok(etag);
      await first.text();
      const again = await askAgain(`${base}/cal/${token}.ics`, etag);
      assert.equal(again.status, 304);
      assert.equal(again.body, '');
      assert.equal(again.headers.etag, etag);
      assert.equal(again.headers['cache-control'], 'private, max-age=300');

      await seedBookedSession(db, seed.sessionId, 'New Athlete', '+15550005001');
      const changed = await askAgain(`${base}/cal/${token}.ics`, etag);
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, etag);
      assert.equal(eventFor(parseCalendar(changed.body), seed.sessionId).get('SUMMARY'), 'Goalkeeper Group (1 of 2)');
    });
  });
});

test('reads are limited for one calendar and for one address, and answer 429 beyond that', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await seedCoachWithSession(db);
    const other = await seedCoachWithSession(db);
    const token = await turnOnCalendarFeed(db, seed.coach.id);
    const otherToken = await turnOnCalendarFeed(db, other.coach.id);
    assert.deepEqual(
      [CALENDAR_FEED_LIMITS, CALENDAR_ADDRESS_LIMITS].map((rules) => rules.map((r) => [r.windowMs, r.max])),
      [[[HOUR_MS, 60]], [[HOUR_MS, 120]]],
      '60 an hour for one calendar, 120 an hour from one address',
    );
    await withServer(async (base) => {
      const read = (t: string, address: string) => fetch(`${base}/cal/${t}.ics`, { headers: from(address) });

      // Each count is set for this hour and the next before every read, so
      // the hour turning over mid-test changes nothing.
      const feedKey = calendarFeedKey(seed.coach.id);

      // One calendar, read from many addresses: the 60th read this hour is
      // answered and the 61st is not, whichever address it comes from.
      await setHits(db, CALENDAR_FEED_LIMITS, feedKey, 59);
      assert.equal((await read(token, '203.0.113.10')).status, 200);
      await setHits(db, CALENDAR_FEED_LIMITS, feedKey, 60);
      const over = await read(token, '203.0.113.11');
      assert.equal(over.status, 429);
      const wait = Number(over.headers.get('retry-after'));
      assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 3600, `Retry-After within the hour: ${wait}`);
      assert.doesNotMatch(await over.text(), /BEGIN:VCALENDAR/);
      assert.equal(over.headers.get('set-cookie'), null);
      assert.equal((await read(otherToken, '203.0.113.11')).status, 200, "another coach's calendar is not held back");
      // A new link counts with the one it replaced.
      const replaced = await replaceCalendarToken(db, seed.coach.id);
      await setHits(db, CALENDAR_FEED_LIMITS, feedKey, 60);
      assert.equal((await read(replaced, '203.0.113.12')).status, 429);

      // One address, whatever it asks for: the 120th read is answered, and
      // after that every link gets 429, known or not.
      await setHits(db, CALENDAR_ADDRESS_LIMITS, '198.51.100.7', 119);
      assert.equal((await read(otherToken, '198.51.100.7')).status, 200);
      await setHits(db, CALENDAR_ADDRESS_LIMITS, '198.51.100.7', 120);
      assert.equal((await read(otherToken, '198.51.100.7')).status, 429);
      await setHits(db, CALENDAR_ADDRESS_LIMITS, '198.51.100.7', 120);
      assert.equal((await read('B'.repeat(43), '198.51.100.7')).status, 429, 'a link nobody made gets the same answer');
      assert.equal((await read(otherToken, '198.51.100.8')).status, 200, 'another address still reads it');

      // A link nobody made counts against the address that asks for it,
      // and against no calendar.
      assert.equal((await read('C'.repeat(43), '198.51.100.9')).status, 404);
      assert.equal((await read('D'.repeat(43), '198.51.100.9')).status, 404);
      const counted = await db.query<{ hits: number }>(
        "select coalesce(sum(hits), 0)::int as hits from request_limit where bucket = 'cal-ip-hour' and key = '198.51.100.9'",
      );
      assert.equal(counted.rows[0].hits, 2);
      // A link that is not shaped like one is not looked up or counted.
      assert.equal((await read('short', '198.51.100.20')).status, 404);
      const uncounted = await db.query<{ n: number }>("select count(*)::int as n from request_limit where key = '198.51.100.20'");
      assert.equal(uncounted.rows[0].n, 0);
    });

    // The counters are kept by the coach and the address, never by the link.
    const keys = await db.query<{ key: string }>("select key from request_limit where bucket in ('cal-feed-hour', 'cal-ip-hour')");
    assert.ok(keys.rows.length > 0);
    for (const { key } of keys.rows) assert.match(key, /^(calendar:\d+|[\d.]+)$/);
  });
});

test('a real calendar app\'s pace is never limited: a read every five minutes for a day', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  await turnOnCalendarFeed(db, seed.coach.id);
  const { takeRequest } = await import('../src/domain/requestLimits.js');
  const start = new Date('2026-06-15T00:00:00Z').getTime();
  for (let i = 0; i < 24 * 12; i += 1) {
    const now = new Date(start + i * 5 * 60_000);
    assert.equal(await takeRequest(db, CALENDAR_ADDRESS_LIMITS, '203.0.113.50', now), true);
    assert.equal(await takeRequest(db, CALENDAR_FEED_LIMITS, calendarFeedKey(seed.coach.id), now), true);
  }
});

test('the link is never written to a log line', async () => {
  const token = 'k'.repeat(43);
  assert.equal(pathForLog(`/cal/${token}.ics`), '/cal/:token');
  assert.equal(pathForLog(`/CAL/${token}.ics`), '/CAL/:token');
  assert.equal(pathForLog('/calendar'), '/calendar', 'only the feed address is rewritten');

  // With the database down, the error line names the route and not the link.
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const real = await turnOnCalendarFeed(db, seed.coach.id);
  const lines: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    setDb({ query: () => Promise.reject(new Error('the database is away')) });
    await withServer(async (base) => {
      const res = await fetch(`${base}/cal/${real}.ics`);
      assert.equal(res.status, 500);
      assert.ok(!(await res.text()).includes(real));
    });
  } finally {
    console.error = error;
    setDb(db);
  }
  assert.ok(lines.some((line) => /^500 GET \/cal\/:token: /.test(line)), 'the error line names the route');
  assert.ok(!lines.join('\n').includes(real), 'the link is not in the log');
});

test('turning the link off and on by the domain functions matches what the address answers', async () => {
  const db = await freshDb();
  const seed = await seedCoachWithSession(db);
  const first = await turnOnCalendarFeed(db, seed.coach.id);
  assert.equal(await turnOnCalendarFeed(db, seed.coach.id), first, 'first use twice is one link');
  assert.deepEqual(await findFeedCoach(db, first), { id: seed.coach.id, name: 'Jamie Coach' });
  const second = await replaceCalendarToken(db, seed.coach.id);
  assert.equal(await findFeedCoach(db, first), null);
  assert.deepEqual(await findFeedCoach(db, second), { id: seed.coach.id, name: 'Jamie Coach' });
  await turnOffCalendarFeed(db, seed.coach.id);
  assert.equal(await findFeedCoach(db, second), null);
  assert.equal(await findFeedCoach(db, 'not a link'), null);
  const stored = await db.query<{ n: number }>('select count(*)::int as n from calendar_feed');
  assert.equal(stored.rows[0].n, 0);
});
