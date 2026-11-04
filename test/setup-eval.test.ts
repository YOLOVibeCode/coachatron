import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers/db.js';
import { withServer } from './helpers/server.js';
import { withRelay } from './helpers/relay.js';
import { createCoach, createCoachSession } from '../src/domain/auth.js';
import { validateSetupPlan } from '../src/domain/setup.js';
import { check, EXPECT_KEYS, type Case } from '../scripts/eval-setup.js';

/** The voice-setup examples a coach sees say am or pm for every time, since
 * the setup model reads a bare hour as pm ("Saturday at 9" would be 9pm).
 * The live-model eval checks every fact its cases ask for. None of this
 * calls a model. */

const cases = (JSON.parse(readFileSync(new URL('../eval/setup-utterances.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;

/** The times in a sentence: the number after "at", and any more listed
 * after it ("at 9am, 10am and 11am"), but not a count that follows a time
 * ("at 9am, 45 minutes"). */
function timesIn(text: string): string[] {
  const time = String.raw`\d{1,2}(?::\d\d)?(?:am|pm)?`;
  const more = String.raw`(?:,\s*|\s+and\s+)${time}(?=,|\s+and\b|\.|$)`;
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\bat (${time}(?:${more})*)`, 'gi'))) {
    out.push(...m[1].split(/,\s*|\s+and\s+/));
  }
  return out;
}

function placeholder(page: string, id: string): string {
  const m = new RegExp(`<textarea id="${id}"[^>]*placeholder="([^"]*)"`).exec(page);
  assert.ok(m, `the ${id} box has a placeholder`);
  return m[1];
}

test('the landing and schedule examples say am or pm for every time', async () => {
  await withRelay(async () => {
    const db = await freshDb();
    const coach = await createCoach(db, { phone: '+15550008888', name: 'Dana', email: '', tz: 'America/Chicago' });
    const cookie = `cx_session=${await createCoachSession(db, coach.id)}`;
    await withServer(async (base) => {
      const examples = [
        placeholder(await (await fetch(`${base}/`)).text(), 'week'),
        placeholder(await (await fetch(`${base}/app/schedule`, { headers: { cookie } })).text(), 'setup-text'),
      ];
      for (const example of examples) {
        const times = timesIn(example);
        assert.ok(times.length >= 2, `found the times in: ${example}`);
        for (const time of times) assert.match(time, /(am|pm)$/i, `"${time}" in: ${example}`);
      }
      assert.match(examples[0], /Saturday at 9am/);
      assert.match(examples[1], /Saturday at 9am, 10am and 11am/);
    });
  });
});

test('the eval reads weekly_min: a case that expects weekly times misses when there are none', () => {
  const tutor = cases.find((c) => c.id === 'science-math-tutor-weekdays');
  assert.ok(tutor);
  assert.equal(tutor.expect.weekly_min, 1);
  const base = {
    coach_timezone: null,
    session_types: [{ key: 's', name: 'Science/Math tutor', duration_min: 60, capacity: 5, price_cents: 1500, backup_pay_cents: null }],
    packages: [],
    plans: [],
  };
  const none = validateSetupPlan({ ...base, weekly: [] }, []);
  assert.deepEqual(check(tutor, {}, none.plan, none.questions), ['0 weekly times, expected at least 1']);
  const some = validateSetupPlan({ ...base, weekly: [{ type_key: 's', weekday: 1, time_local: '17:00', location: null }] }, []);
  assert.deepEqual(check(tutor, {}, some.plan, some.questions), []);
});

test('every eval case asks only for facts the eval checks', () => {
  for (const c of cases) {
    for (const key of Object.keys(c.expect)) {
      assert.ok((EXPECT_KEYS as readonly string[]).includes(key), `${c.id}: "${key}" is not checked`);
    }
  }
  assert.ok(cases.some((c) => c.id === 'landing-placeholder') && cases.some((c) => c.id === 'schedule-placeholder'), 'the examples are cases too');
});
