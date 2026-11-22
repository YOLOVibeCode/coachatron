import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { postSignedSms } from './helpers/sms-webhook.js';
import { zoneAt } from './helpers/clock.js';
import { seedCoachWithSession, seedRosterMember, type SeededSession } from './helpers/fixtures.js';
import { acceptOffer, startCascade, type OverflowKind } from '../src/domain/cascade.js';
import { cancelScheduledSession } from '../src/domain/cancelSession.js';
import { createCoachSession } from '../src/domain/auth.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  listAssistantPay,
  markAllPaid,
  markPaid,
  owedToAssistantsCents,
  setPayAmount,
  summarizeAssistantPay,
  undoPaid,
} from '../src/domain/assistantPay.js';
import type { DbClient } from '../src/db/client.js';

/** Assistant coach pay (SPEC.md §8.2): a record of what the coach owes the
 * people on their roster, kept from each acceptance. Nothing here depends
 * on the day or the hour it runs: sessions are placed relative to now. */

interface PayRow {
  id: number;
  coach_id: number;
  roster_member_id: number;
  offer_id: number;
  session_id: number;
  kind: string;
  amount_cents: number | null;
  paid_at: string | Date | null;
  paid_note: string | null;
}

async function payRows(db: DbClient, coachId: number): Promise<PayRow[]> {
  const r = await db.query<PayRow>(
    'select id, coach_id, roster_member_id, offer_id, session_id, kind, amount_cents, paid_at, paid_note from assistant_pay where coach_id = $1 order by id',
    [coachId],
  );
  return r.rows;
}

/** A coach with one session a day from now, whose type pays `payCents` to
 * whoever takes an overflow job. Midday for the coach, and a short type
 * name, so nothing about the texts depends on when the test runs. */
async function coachWithPay(db: DbClient, payCents: number | null): Promise<SeededSession> {
  const seed = await seedCoachWithSession(db, { capacity: 4 });
  await db.query('update coach set tz = $2 where id = $1', [seed.coach.id, zoneAt(12)]);
  await db.query("update session_type set name = 'Skills', backup_pay_cents = $2 where id = $1", [seed.sessionTypeId, payCents]);
  return seed;
}

/** Another session of the same type, `hoursAhead` from now. */
async function anotherSession(db: DbClient, seed: SeededSession, hoursAhead: number): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into session (session_type_id, starts_at_utc, tz, status)
     values ($1, now() + make_interval(hours => $2::int), 'America/Chicago', 'scheduled') returning id`,
    [seed.sessionTypeId, hoursAhead],
  );
  return r.rows[0].id;
}

/** The coach asks the roster for `kind` on the session and the first
 * person offered accepts. Returns the offer and the session they coach. */
async function acceptedJob(db: DbClient, sessionId: number, kind: OverflowKind): Promise<{ offerId: number; coachedSessionId: number }> {
  await startCascade(db, sessionId, kind);
  const offer = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'sent'", [sessionId]);
  assert.equal(offer.rows.length, 1, 'one offer is out');
  assert.equal(await acceptOffer(db, offer.rows[0].id), true, 'the offer was accepted');
  const pay = await db.query<{ session_id: number }>('select session_id from assistant_pay where offer_id = $1', [offer.rows[0].id]);
  assert.equal(pay.rows.length, 1, 'the acceptance wrote one pay row');
  return { offerId: offer.rows[0].id, coachedSessionId: pay.rows[0].session_id };
}

/** Moves a session's start into the past: it has happened. */
async function happened(db: DbClient, sessionId: number, hoursAgo = 2): Promise<void> {
  await db.query('update session set starts_at_utc = now() - make_interval(hours => $2::int) where id = $1', [sessionId, hoursAgo]);
}

async function signIn(db: DbClient, coachId: number): Promise<string> {
  return `cx_session=${await createCoachSession(db, coachId)}`;
}

function post(base: string, path: string, cookie: string, body: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
}

async function rosterPage(base: string, cookie: string, query = ''): Promise<string> {
  const res = await fetch(`${base}/app/roster${query}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  return res.text();
}

/** The pay section of the roster page, without the rest of the screen. */
function paySection(page: string): string {
  const start = page.indexOf('<h2 id="pay">');
  return start === -1 ? '' : page.slice(start, page.indexOf('<h2>Add member</h2>'));
}

test("accepting an offer records what it said the job pays, and a later change to the type's pay does not alter it", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const { offerId } = await acceptedJob(db, seed.sessionId, 'backup');

    assert.match(relay.sms.find((m) => m.to === sam.phone)!.body, /pays \$80\. Reply Y to claim/);
    const [row] = await payRows(db, seed.coach.id);
    assert.deepEqual(
      { member: row.roster_member_id, offer: row.offer_id, session: row.session_id, kind: row.kind, amount: row.amount_cents, paid: row.paid_at },
      { member: sam.id, offer: offerId, session: seed.sessionId, kind: 'backup', amount: 8000, paid: null },
    );

    await db.query('update session_type set backup_pay_cents = 5000 where id = $1', [seed.sessionTypeId]);
    assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 8000, 'what was accepted stays');
    await db.query('update session_type set backup_pay_cents = null where id = $1', [seed.sessionTypeId]);
    assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 8000);
  });
});

test("the amount is the one the offer showed, even when the type's pay changed before the assistant accepted", async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await startCascade(db, seed.sessionId, 'second_group');
    assert.match(relay.sms.find((m) => m.to === sam.phone)!.body, /pays \$80\./);
    // The coach changes the type's pay while the offer is out.
    await db.query('update session_type set backup_pay_cents = 5000 where id = $1', [seed.sessionTypeId]);
    const offer = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]);
    assert.equal(await acceptOffer(db, offer.rows[0].id), true);
    assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 8000);
  });
});

test('an offer that carries no pay of its own takes the type\'s pay at acceptance, and an accept that loses records nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 6500);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const kim = await seedRosterMember(db, seed.coach.id, 'Kim Park', 1);
    // Offers as they were made before offers kept their pay.
    const offers = await db.query<{ id: number }>(
      `insert into offer (session_id, roster_member_id, expires_at, state, token, kind)
       values ($1, $2, now() + interval '20 minutes', 'sent', 'tokenaaaaaaaaaaaaaaaa', 'backup'),
              ($1, $3, now() + interval '20 minutes', 'sent', 'tokenbbbbbbbbbbbbbbbb', 'backup')
       returning id`,
      [seed.sessionId, sam.id, kim.id],
    );
    assert.equal(await acceptOffer(db, offers.rows[0].id), true);
    assert.equal(await acceptOffer(db, offers.rows[1].id), false, 'the job is taken');
    assert.equal(await acceptOffer(db, offers.rows[0].id), false, 'and is taken once');
    const rows = await payRows(db, seed.coach.id);
    assert.deepEqual(
      rows.map((r) => [r.roster_member_id, r.amount_cents]),
      [[sam.id, 6500]],
    );
  });
});

test('a second group is recorded on its own session and a backup coach on the session they join, and both count', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const second = await acceptedJob(db, seed.sessionId, 'second_group');
    const other = await anotherSession(db, seed, 48);
    const backup = await acceptedJob(db, other, 'backup');

    assert.notEqual(second.coachedSessionId, seed.sessionId, 'the second group is a session of its own');
    const group = await db.query<{ overflow_of: number; assigned_roster_member_id: number }>(
      'select overflow_of, assigned_roster_member_id from session where id = $1',
      [second.coachedSessionId],
    );
    assert.deepEqual(group.rows[0], { overflow_of: seed.sessionId, assigned_roster_member_id: sam.id });
    assert.equal(backup.coachedSessionId, other);
    assert.deepEqual(
      (await payRows(db, seed.coach.id)).map((r) => [r.kind, r.session_id, r.amount_cents]),
      [
        ['second_group', second.coachedSessionId, 8000],
        ['backup', other, 8000],
      ],
    );

    await happened(db, second.coachedSessionId);
    await happened(db, other);
    const [summary] = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual(
      { coached: summary.coached, owed: summary.owedCents, paid: summary.paidCents },
      { coached: 2, owed: 16000, paid: 0 },
    );

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /Skills · Second group/);
      assert.match(open, /Skills · Backup coach/);
      assert.match(open, /2 sessions coached/);
      assert.match(open, /Owed \$160/);
    });
  });
});

test('a job is upcoming until its session starts, then owed, and a cancelled session owes nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    const cancelledSession = await anotherSession(db, seed, 48);
    await acceptedJob(db, cancelledSession, 'backup');
    const secondGroupOf = await anotherSession(db, seed, 72);
    const group = await acceptedJob(db, secondGroupOf, 'second_group');

    const states = async () => (await listAssistantPay(db, seed.coach.id, sam.id)).map((r) => r.state).sort();
    assert.deepEqual(await states(), ['upcoming', 'upcoming', 'upcoming']);
    assert.equal(await owedToAssistantsCents(db, seed.coach.id), 0, 'an upcoming session is not owed');
    let [summary] = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual(
      { coached: summary.coached, upcoming: summary.upcoming, owed: summary.owedCents },
      { coached: 0, upcoming: 3, owed: 0 },
    );

    // The coach cancels one session, and the second group on its own: the
    // session it was opened for still stands.
    assert.equal((await cancelScheduledSession(db, seed.coach.id, cancelledSession)).kind, 'cancelled');
    assert.equal((await cancelScheduledSession(db, seed.coach.id, group.coachedSessionId)).kind, 'cancelled');
    await happened(db, seed.sessionId);
    // A cancelled session whose time has passed still owes nothing.
    await happened(db, cancelledSession);

    assert.deepEqual(await states(), ['cancelled', 'cancelled', 'owed']);
    [summary] = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual(
      { coached: summary.coached, upcoming: summary.upcoming, cancelled: summary.cancelled, owedCount: summary.owedCount, owed: summary.owedCents },
      { coached: 1, upcoming: 0, cancelled: 2, owedCount: 1, owed: 8000 },
    );
    assert.equal(await owedToAssistantsCents(db, seed.coach.id), 8000);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const closed = paySection(await rosterPage(base, cookie));
      assert.match(closed, /1 session coached · 2 cancelled/);
      assert.match(closed, /Owed \$80/);
      assert.match(closed, /Paid \$0/);
      assert.doesNotMatch(closed, /Mark paid/, 'the sessions are listed only once the assistant is opened');
      const open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.equal((open.match(/<strong>Cancelled<\/strong>/g) ?? []).length, 2);
      assert.equal((open.match(/Nothing owed/g) ?? []).length, 2);
      assert.equal((open.match(/<strong>Owed<\/strong>/g) ?? []).length, 1);
      // A cancelled session cannot be marked paid or given an amount.
      const cancelledRow = (await payRows(db, seed.coach.id)).find((r) => r.session_id === cancelledSession)!;
      for (const [path, body] of [
        [`/app/roster/pay/${cancelledRow.id}/paid`, {}],
        [`/app/roster/pay/${cancelledRow.id}/amount`, { amount_dollars: '20' }],
      ] as Array<[string, Record<string, string>]>) {
        const res = await post(base, path, cookie, body);
        assert.equal(res.status, 409, path);
        assert.match(await res.text(), /was cancelled, so nothing is owed/);
      }
      const after = (await payRows(db, seed.coach.id)).find((r) => r.id === cancelledRow.id)!;
      assert.deepEqual([after.paid_at, after.amount_cents], [null, 8000]);
    });
  });
});

test('marking a session paid records the date and the note and moves it from owed to paid, and undo brings it back', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    const upcoming = await anotherSession(db, seed, 48);
    await acceptedJob(db, upcoming, 'backup');
    await happened(db, seed.sessionId);
    const [owedRow, upcomingRow] = await payRows(db, seed.coach.id);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);

      // Nothing is owed yet for a session that has not happened.
      const early = await post(base, `/app/roster/pay/${upcomingRow.id}/paid`, cookie);
      assert.equal(early.status, 409);
      assert.match(await early.text(), /has not happened yet/);

      const before = Date.now();
      const paid = await post(base, `/app/roster/pay/${owedRow.id}/paid`, cookie, { note: '  Venmo,   Friday ' });
      assert.equal(paid.status, 303);
      assert.equal(paid.headers.get('location'), `/app/roster?pay=${sam.id}#pay-${sam.id}`);
      let row = (await payRows(db, seed.coach.id))[0];
      assert.equal(row.paid_note, 'Venmo, Friday');
      assert.ok(row.paid_at !== null && Math.abs(new Date(row.paid_at).getTime() - before) < 60_000, 'the date is now');

      let [summary] = await summarizeAssistantPay(db, seed.coach.id);
      assert.deepEqual(
        { coached: summary.coached, owed: summary.owedCents, paid: summary.paidCents, upcoming: summary.upcoming },
        { coached: 1, owed: 0, paid: 8000, upcoming: 1 },
      );
      let open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /<strong>Paid<\/strong>/);
      assert.match(open, /Marked paid \w{3} \d{1,2} · Venmo, Friday/);
      assert.match(open, /Owed \$0/);
      assert.match(open, /Paid \$80/);

      // Marking it again changes nothing: the first date and note stand.
      const again = await post(base, `/app/roster/pay/${owedRow.id}/paid`, cookie, { note: 'Cash' });
      assert.equal(again.status, 303);
      assert.equal((await payRows(db, seed.coach.id))[0].paid_note, 'Venmo, Friday');

      const undone = await post(base, `/app/roster/pay/${owedRow.id}/unpaid`, cookie);
      assert.equal(undone.status, 303);
      row = (await payRows(db, seed.coach.id))[0];
      assert.deepEqual([row.paid_at, row.paid_note, row.amount_cents], [null, null, 8000]);
      [summary] = await summarizeAssistantPay(db, seed.coach.id);
      assert.deepEqual({ owed: summary.owedCents, paid: summary.paidCents }, { owed: 8000, paid: 0 });
      open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /<strong>Owed<\/strong>/);
      assert.doesNotMatch(open, /Marked paid/);
      // Undoing twice is the same as once.
      assert.equal((await post(base, `/app/roster/pay/${owedRow.id}/unpaid`, cookie)).status, 303);
    });
  });
});

test("marking all of an assistant's owed sessions paid leaves upcoming, cancelled and other assistants' sessions alone", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const first = seed.sessionId;
    const second = await anotherSession(db, seed, 30);
    const cancelled = await anotherSession(db, seed, 40);
    const upcoming = await anotherSession(db, seed, 50);
    for (const sessionId of [first, second, cancelled, upcoming]) await acceptedJob(db, sessionId, 'backup');
    // Kim is asked first from here on, and takes one job.
    const kim = await seedRosterMember(db, seed.coach.id, 'Kim Park', 0);
    await db.query('update roster_member set priority = 5 where id = $1', [sam.id]);
    const kims = await anotherSession(db, seed, 60);
    await acceptedJob(db, kims, 'backup');
    assert.equal((await payRows(db, seed.coach.id)).filter((r) => r.roster_member_id === kim.id).length, 1);

    await cancelScheduledSession(db, seed.coach.id, cancelled);
    for (const sessionId of [first, second, kims]) await happened(db, sessionId);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /Mark all 2 owed sessions paid \(\$160\)/);

      const res = await post(base, `/app/roster/${sam.id}/pay-all`, cookie, { note: 'Check 1042' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), `/app/roster?pay=${sam.id}#pay-${sam.id}`);
    });

    const rows = await payRows(db, seed.coach.id);
    const bySession = new Map(rows.map((r) => [r.session_id, r]));
    for (const sessionId of [first, second]) {
      assert.notEqual(bySession.get(sessionId)!.paid_at, null);
      assert.equal(bySession.get(sessionId)!.paid_note, 'Check 1042');
    }
    for (const sessionId of [cancelled, upcoming, kims]) {
      assert.equal(bySession.get(sessionId)!.paid_at, null, `session ${sessionId} was left alone`);
    }
    const summaries = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual(
      summaries.map((s) => [s.name, s.owedCents, s.paidCents]),
      [
        ['Kim Park', 8000, 0],
        ['Sam Lee', 0, 16000],
      ],
    );
    // With nothing owed, there is nothing more to mark.
    assert.equal(await markAllPaid(db, seed.coach.id, sam.id, null), 0);
  });
});

test('a type with no pay records no amount set, and the coach sets one and can change it until the session is marked paid', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await coachWithPay(db, null);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    assert.doesNotMatch(relay.sms.find((m) => m.to === sam.phone)!.body, /pays/);
    const [row] = await payRows(db, seed.coach.id);
    assert.equal(row.amount_cents, null);
    // Setting the type's pay afterwards does not reach what was accepted.
    await db.query('update session_type set backup_pay_cents = 9000 where id = $1', [seed.sessionTypeId]);
    assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, null);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      // Upcoming: the amount can already be set.
      let open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /No amount set/);
      assert.match(open, /<summary>Set the amount<\/summary>/);
      const set = await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '45.50' });
      assert.equal(set.status, 303);
      assert.equal(set.headers.get('location'), `/app/roster?pay=${sam.id}#pay-${sam.id}`);
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 4550);

      await happened(db, seed.sessionId);
      open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /Owed \$45\.50/);
      assert.match(open, /<summary>Change the amount<\/summary>/);
      assert.match(open, /name="amount_dollars"[^>]* value="45\.5"/);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '60' })).status, 303);
      assert.equal(await owedToAssistantsCents(db, seed.coach.id), 6000);

      // Once paid, the amount stands until the payment is undone.
      assert.equal((await post(base, `/app/roster/pay/${row.id}/paid`, cookie)).status, 303);
      const late = await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '75' });
      assert.equal(late.status, 409);
      assert.match(await late.text(), /marked paid\. Undo that first/);
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 6000);
      open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.doesNotMatch(open, /name="amount_dollars"/, 'a paid session has no amount form');

      assert.equal((await post(base, `/app/roster/pay/${row.id}/unpaid`, cookie)).status, 303);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '75' })).status, 303);
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 7500);
    });
  });
});

test('an owed session with no amount is listed as owed, stays out of the totals, and can still be marked paid', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, null);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    await happened(db, seed.sessionId);
    const [summary] = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual(
      { coached: summary.coached, owedCount: summary.owedCount, owedUnset: summary.owedUnset, owed: summary.owedCents },
      { coached: 1, owedCount: 1, owedUnset: 1, owed: 0 },
    );
    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /1 owed session has no amount set, so it is not in the total/);
      assert.match(open, /Mark the owed session paid</, 'no dollar figure when none is set');
      const money = await (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
      assert.doesNotMatch(money, /You owe assistants/);
    });
    const [row] = await payRows(db, seed.coach.id);
    assert.equal((await markPaid(db, seed.coach.id, row.id, null)).kind, 'ok');
    const [after] = await summarizeAssistantPay(db, seed.coach.id);
    assert.deepEqual({ owedCount: after.owedCount, paid: after.paidCents, coached: after.coached }, { owedCount: 0, paid: 0, coached: 1 });
  });
});

test('amounts outside $0 to $25,000 and notes over 80 characters get the form message and change nothing', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    await happened(db, seed.sessionId);
    const [row] = await payRows(db, seed.coach.id);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      for (const amount of ['', '-1', '-0.01', '25000.01', '25001', '1e3', '12.345', 'abc', '99999999999', '$']) {
        const res = await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: amount });
        assert.equal(res.status, 422, `amount "${amount}" answered ${res.status}`);
        const message = await res.text();
        assert.match(message, /Enter an amount from \$0 to \$25,000\./);
        assert.ok(message.includes(`href="/app/roster?pay=${sam.id}#pay-${sam.id}"`), "the way back is to the assistant's sessions");
      }
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 8000);
      for (const [amount, cents] of [
        ['0', 0],
        ['25000', 2_500_000],
        ['$82.50', 8250],
      ] as Array<[string, number]>) {
        assert.equal((await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: amount })).status, 303, amount);
        assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, cents);
      }

      const tooLong = 'x'.repeat(81);
      for (const path of [`/app/roster/pay/${row.id}/paid`, `/app/roster/${sam.id}/pay-all`]) {
        const res = await post(base, path, cookie, { note: tooLong });
        assert.equal(res.status, 422, path);
        assert.match(await res.text(), /Keep the note to 80 characters or fewer\./);
      }
      assert.equal((await payRows(db, seed.coach.id))[0].paid_at, null, 'nothing was marked paid');

      // 80 characters is kept whole, counted as characters, not bytes.
      const eighty = 'é'.repeat(80);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/paid`, cookie, { note: eighty })).status, 303);
      assert.equal((await payRows(db, seed.coach.id))[0].paid_note, eighty);
      // A note is shown as text, never as markup.
      await undoPaid(db, seed.coach.id, row.id);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/paid`, cookie, { note: '<b>Venmo</b>' })).status, 303);
      const open = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(open, /&lt;b&gt;Venmo&lt;\/b&gt;/);
      assert.doesNotMatch(open, /<b>Venmo<\/b>/);
    });
  });
});

test('another coach cannot see or change these rows', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    await happened(db, seed.sessionId);
    const [row] = await payRows(db, seed.coach.id);
    const other = await coachWithPay(db, 7000);

    await withServer(async (base) => {
      const cookie = await signIn(db, other.coach.id);
      for (const query of ['', `?pay=${sam.id}`]) {
        const page = await rosterPage(base, cookie, query);
        assert.doesNotMatch(page, /Sam Lee/);
        assert.doesNotMatch(page, /Assistant pay/);
      }
      const money = await (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
      assert.doesNotMatch(money, /You owe assistants/);

      for (const [path, body] of [
        [`/app/roster/pay/${row.id}/amount`, { amount_dollars: '1' }],
        [`/app/roster/pay/${row.id}/paid`, { note: 'mine now' }],
        [`/app/roster/pay/${row.id}/unpaid`, {}],
        [`/app/roster/${sam.id}/pay-all`, {}],
      ] as Array<[string, Record<string, string>]>) {
        const res = await post(base, path, cookie, body);
        assert.equal(res.status, 404, `${path} answered ${res.status}`);
      }
    });
    assert.equal(await summarizeAssistantPay(db, other.coach.id).then((s) => s.length), 0);
    assert.deepEqual(await listAssistantPay(db, other.coach.id, sam.id), []);
    assert.equal((await setPayAmount(db, other.coach.id, row.id, 100)).kind, 'not_found');
    assert.equal((await markPaid(db, other.coach.id, row.id, null)).kind, 'not_found');
    assert.equal(await markAllPaid(db, other.coach.id, sam.id, null), null);

    const [after] = await payRows(db, seed.coach.id);
    assert.deepEqual([after.amount_cents, after.paid_at, after.paid_note], [8000, null, null]);

    // The owner's own undo of a paid row is likewise closed to the other coach.
    await markPaid(db, seed.coach.id, row.id, 'Venmo');
    assert.equal((await undoPaid(db, other.coach.id, row.id)).kind, 'not_found');
    assert.notEqual((await payRows(db, seed.coach.id))[0].paid_at, null);
  });
});

test('Money shows one line for what assistants are owed, only above zero, and it is not part of collected or booked', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    const [row] = await payRows(db, seed.coach.id);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const money = async () => (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
      const figures = (page: string) => [
        /Paid by parents:<\/strong> \$[\d.]+/.exec(page)?.[0],
        /Sessions booked:<\/strong> \d+ — \$[\d.]+/.exec(page)?.[0],
      ];

      const upcoming = await money();
      assert.doesNotMatch(upcoming, /You owe assistants/, 'nothing is owed for an upcoming session');
      const before = figures(upcoming);
      assert.deepEqual(before, ['Paid by parents:</strong> $0.00', 'Sessions booked:</strong> 0 — $0.00']);

      await happened(db, seed.sessionId);
      const owed = await money();
      assert.match(owed, /<a href="\/app\/roster#pay">You owe assistants \$80<\/a>/);
      assert.equal((owed.match(/You owe assistants/g) ?? []).length, 1);
      assert.deepEqual(figures(owed), before, 'collected and booked are as they were');

      await post(base, `/app/roster/pay/${row.id}/paid`, cookie);
      assert.doesNotMatch(await money(), /You owe assistants/, 'paid in full: the line is gone');
      await post(base, `/app/roster/pay/${row.id}/unpaid`, cookie);
      await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '0' });
      assert.doesNotMatch(await money(), /You owe assistants/, 'an owed session of $0 shows no line');
    });
  });
});

test('an assistant taken off the roster keeps their history, and what they are owed stays on the roster until paid', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    await happened(db, seed.sessionId);
    await db.query('update roster_member set active = false where id = $1', [sam.id]);

    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const page = await rosterPage(base, cookie, `?pay=${sam.id}`);
      assert.match(page, /No roster members yet\./, 'they are off the roster');
      const section = paySection(page);
      assert.match(section, /Sam Lee/);
      assert.match(section, /No longer on your roster/);
      assert.match(section, /Owed \$80/);
      assert.match((await (await fetch(`${base}/app/money`, { headers: { cookie } })).text()), /You owe assistants \$80/);

      const [row] = await payRows(db, seed.coach.id);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/paid`, cookie, { note: 'Final' })).status, 303);
      const after = paySection(await rosterPage(base, cookie, `?pay=${sam.id}`));
      assert.match(after, /Sam Lee/, 'the history stays');
      assert.match(after, /Paid \$80/);
      assert.match(after, /Undo paid/);
    });
  });
});

test('the roster says nothing about pay until someone has accepted a job, and then says it is only a record', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      assert.equal(paySection(await rosterPage(base, cookie)), '');
      // An offer that is only out is not a job yet.
      await startCascade(db, seed.sessionId, 'backup');
      assert.equal(paySection(await rosterPage(base, cookie, `?pay=${sam.id}`)), '');

      const offer = await db.query<{ id: number }>('select id from offer where session_id = $1', [seed.sessionId]);
      await acceptOffer(db, offer.rows[0].id);
      const section = paySection(await rosterPage(base, cookie));
      assert.match(section, /Coachatron doesn't pay assistants; this is your record\./);
      assert.match(section, /0 sessions coached · 1 upcoming/);
      assert.ok(section.includes(`<a href="/app/roster?pay=${sam.id}#pay-${sam.id}">See Sam Lee's sessions</a>`));
      // A value that is not an assistant's id opens nothing and breaks nothing.
      for (const query of ['?pay=abc', '?pay=0', '?pay=99999999999', '?pay=1&pay=2', '?pay[x]=1']) {
        const page = paySection(await rosterPage(base, cookie, query));
        assert.match(page, /See Sam Lee/);
        assert.doesNotMatch(page, /Hide Sam Lee/);
      }
    });
  });
});

test('keeping the record sends no text or email, and the offer text, the claim text and the offer page read as before', async () => {
  await withRelay(async (relay) => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await startCascade(db, seed.sessionId, 'backup');
    const offer = await db.query<{ id: number; token: string }>('select id, token from offer where session_id = $1', [seed.sessionId]);

    await withServer(async (base) => {
      const offerPage = await (await fetch(`${base}/offer/${offer.rows[0].token}`)).text();
      assert.match(offerPage, /Backup coach needed/);
      assert.match(offerPage, /Pays \$80\./);
      // Sam accepts by text, and hears it is theirs, with the pay.
      assert.equal((await postSignedSms(base, { From: sam.phone, Body: 'Y' })).status, 200);
      const toSam = relay.sms.filter((m) => m.to === sam.phone).map((m) => m.body);
      assert.equal(toSam.length, 2);
      assert.match(toSam[0], /^Coachatron: Backup coach for Skills .*, 0 athletes, pays \$80\. Reply Y to claim \(20 min\)\./);
      assert.match(toSam[1], /^Coachatron: it's yours\. Backup coach for Skills .*, 0 athletes, pays \$80\./);
      assert.equal((await payRows(db, seed.coach.id)).length, 1, 'the text reply wrote the pay row');

      await happened(db, seed.sessionId);
      const [row] = await payRows(db, seed.coach.id);
      const sms = relay.sms.length;
      const emails = relay.emails.length;
      const logged = async () => Number((await db.query<{ n: string }>('select count(*)::text as n from message_log')).rows[0].n);
      const before = await logged();
      const cookie = await signIn(db, seed.coach.id);
      await rosterPage(base, cookie, `?pay=${sam.id}`);
      await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '90' });
      await post(base, `/app/roster/pay/${row.id}/paid`, cookie, { note: 'Venmo' });
      await post(base, `/app/roster/pay/${row.id}/unpaid`, cookie);
      await post(base, `/app/roster/${sam.id}/pay-all`, cookie, { note: 'Venmo' });
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 9000);
      assert.notEqual((await payRows(db, seed.coach.id))[0].paid_at, null);
      assert.equal(relay.sms.length, sms, 'no text went out');
      assert.equal(relay.emails.length, emails, 'no email went out');
      assert.equal(await logged(), before, 'nothing was logged as sent');
    });
  });
});

test('offers accepted before the pay record existed get a row with no amount set, once', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    const backup = await acceptedJob(db, seed.sessionId, 'backup');
    const other = await anotherSession(db, seed, 48);
    const group = await acceptedJob(db, other, 'second_group');
    const open = await anotherSession(db, seed, 72);
    await startCascade(db, open, 'backup');
    // As a database from before the migration held them: accepted offers,
    // the second group's session, and no pay rows.
    await db.query('delete from assistant_pay');
    await db.query("delete from schema_migrations where name = '0036_assistant_pay.sql'");

    await runMigrations(db);
    const rows = await payRows(db, seed.coach.id);
    assert.deepEqual(
      rows.map((r) => [r.offer_id, r.roster_member_id, r.session_id, r.kind, r.amount_cents, r.paid_at]).sort(),
      [
        [backup.offerId, sam.id, seed.sessionId, 'backup', null, null],
        [group.offerId, sam.id, group.coachedSessionId, 'second_group', null, null],
      ].sort(),
      'one row per accepted offer, on the session coached, and none for the offer still out',
    );

    // Running it again adds nothing, and leaves what the coach did since.
    await setPayAmount(db, seed.coach.id, rows[0].id, 7000);
    await db.query("delete from schema_migrations where name = '0036_assistant_pay.sql'");
    await runMigrations(db);
    const again = await payRows(db, seed.coach.id);
    assert.equal(again.length, 2);
    assert.equal(again.find((r) => r.id === rows[0].id)!.amount_cents, 7000);
  });
});

test('ids that are not row ids are a 404, a row that does not exist is a 404, and a signed-out request goes to sign-in', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    const [row] = await payRows(db, seed.coach.id);
    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      for (const path of [
        '/app/roster/pay/abc/paid',
        '/app/roster/pay/1.5/amount',
        '/app/roster/pay/0/unpaid',
        '/app/roster/pay/99999999999/paid',
        '/app/roster/abc/pay-all',
        '/app/roster/pay/999999/paid',
        '/app/roster/pay/999999/amount',
        '/app/roster/pay/999999/unpaid',
        '/app/roster/999999/pay-all',
      ]) {
        const res = await post(base, path, cookie, { amount_dollars: '5' });
        assert.equal(res.status, 404, `${path} answered ${res.status}`);
      }
      for (const path of [`/app/roster/pay/${row.id}/paid`, `/app/roster/pay/${row.id}/amount`, `/app/roster/${row.roster_member_id}/pay-all`]) {
        const res = await post(base, path, '', { amount_dollars: '5' });
        assert.equal(res.status, 303, path);
        assert.equal(res.headers.get('location'), '/signin');
      }
      assert.deepEqual([(await payRows(db, seed.coach.id))[0].amount_cents, (await payRows(db, seed.coach.id))[0].paid_at], [8000, null]);
    });
  });
});

test("an assistant with more sessions than the list shows gets the first hundred, and the totals still count them all", async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    // 105 past sessions Sam coached as a backup, written directly.
    await db.query(
      `insert into session (session_type_id, starts_at_utc, tz, status)
       select $1, now() - make_interval(days => g), 'America/Chicago', 'scheduled' from generate_series(1, 105) g`,
      [seed.sessionTypeId],
    );
    await db.query(
      `insert into offer (session_id, roster_member_id, expires_at, state, kind, accepted_at)
       select s.id, $2, now(), 'accepted', 'backup', now() from session s where s.session_type_id = $1 and s.starts_at_utc < now()`,
      [seed.sessionTypeId, sam.id],
    );
    await db.query(
      `insert into assistant_pay (coach_id, roster_member_id, offer_id, session_id, kind, amount_cents)
       select $1, o.roster_member_id, o.id, o.session_id, 'backup', 1000 from offer o where o.roster_member_id = $2`,
      [seed.coach.id, sam.id],
    );
    const rows = await listAssistantPay(db, seed.coach.id, sam.id);
    assert.equal(rows.length, 100);
    assert.ok(rows.every((r) => r.state === 'owed'));
    assert.ok(new Date(rows[0].startsAtUtc) < new Date(rows[1].startsAtUtc), 'what has been owed longest comes first');
    await withServer(async (base) => {
      const open = paySection(await rosterPage(base, await signIn(db, seed.coach.id), `?pay=${sam.id}`));
      assert.match(open, /105 sessions coached/);
      assert.match(open, /Owed \$1050/);
      assert.match(open, /Mark all 105 owed sessions paid \(\$1050\)/);
      assert.match(open, /Showing 100 of 105 sessions\. The totals count them all\./);
    });
    assert.equal(await markAllPaid(db, seed.coach.id, sam.id, 'Year end'), 105, 'marking all reaches the ones not shown too');
  });
});

test('an offer made while the type had no pay records no amount, even if the type is given a pay before the accept', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, null);
    await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await startCascade(db, seed.sessionId, 'backup');
    await db.query('update session_type set backup_pay_cents = 7000 where id = $1', [seed.sessionTypeId]);
    const offer = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'sent'", [seed.sessionId]);
    assert.equal(await acceptOffer(db, offer.rows[0].id), true);
    assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, null, 'the assistant never saw $70');
  });
});

test('a problem writing the pay record never fails the acceptance', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 8000);
    const sam = await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await db.query(`create function assistant_pay_refuses() returns trigger as $$ begin raise exception 'refused'; end; $$ language plpgsql`);
    await db.query('create trigger assistant_pay_refuses before insert on assistant_pay for each row execute function assistant_pay_refuses()');
    await startCascade(db, seed.sessionId, 'backup');
    const offer = await db.query<{ id: number }>("select id from offer where session_id = $1 and state = 'sent'", [seed.sessionId]);
    assert.equal(await acceptOffer(db, offer.rows[0].id), true, 'the job was taken');
    assert.equal((await payRows(db, seed.coach.id)).length, 0);
    const session = await db.query<{ assigned_roster_member_id: number }>('select assigned_roster_member_id from session where id = $1', [seed.sessionId]);
    assert.equal(session.rows[0].assigned_roster_member_id, sam.id, 'the assistant is assigned');
    const state = await db.query<{ state: string }>('select state from offer where id = $1', [offer.rows[0].id]);
    assert.equal(state.rows[0].state, 'accepted');
  });
});

test('Money writes the owed total as the roster does, and an amount above $10,000 can be saved again', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const seed = await coachWithPay(db, 1_200_000);
    await seedRosterMember(db, seed.coach.id, 'Sam Lee', 0);
    await acceptedJob(db, seed.sessionId, 'backup');
    await happened(db, seed.sessionId);
    const [row] = await payRows(db, seed.coach.id);
    assert.equal(row.amount_cents, 1_200_000);
    await withServer(async (base) => {
      const cookie = await signIn(db, seed.coach.id);
      const money = await (await fetch(`${base}/app/money`, { headers: { cookie } })).text();
      assert.match(money, /You owe assistants \$12000<\/a>/);
      assert.doesNotMatch(money, /\$12000\.00/);
      assert.equal((await post(base, `/app/roster/pay/${row.id}/amount`, cookie, { amount_dollars: '12000' })).status, 303);
      assert.equal((await payRows(db, seed.coach.id))[0].amount_cents, 1_200_000);
    });
  });
});
