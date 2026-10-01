/**
 * Voice-setup extraction against the real model on litellm-vm.
 *
 * Not part of `npm test`: it calls the live model and spends from the
 * Coachatron LiteLLM key. Run it on purpose, with the key in the shell:
 *
 *   LITELLM_API_KEY=... npm run eval:setup
 *   LITELLM_API_KEY=... npm run eval:setup -- --case keeper-basic
 *
 * Cases live in eval/setup-utterances.json. Each case runs the same prompt,
 * schema, and validation as production (src/domain/setup.ts), then checks
 * the facts the case expects. Exit code 1 if any case misses.
 */
import { readFileSync } from 'node:fs';
import { productionComplete } from '../src/llm/complete.js';
import { SETUP_JSON_SCHEMA } from '../src/llm/setupSchema.js';
import {
  SETUP_MODEL_TIMEOUT_MS,
  setupSystemPrompt,
  validateSetupPlan,
  type SetupPlan,
  type SetupType,
} from '../src/domain/setup.js';
import type { CoachRow } from '../src/domain/auth.js';

interface ExpectType {
  name_includes?: string;
  duration_min?: number;
  capacity?: number;
  price_cents?: number | null;
  backup_pay_cents?: number;
}
interface ExpectSlot {
  type_name_includes?: string;
  weekday: number;
  time_local: string;
}
interface Case {
  id: string;
  text: string;
  draft_text?: string;
  expect: {
    coach_timezone?: string;
    types?: ExpectType[];
    weekly?: ExpectSlot[];
    forbid_weekly?: ExpectSlot[];
    packages?: Array<{ credits: number; price_cents: number }>;
    plans?: Array<{ price_cents: number; credits_per_month: number }>;
    questions_include?: string[];
    forbid_in_output?: string[];
  };
}

const COACH: CoachRow = {
  id: 0,
  handle: 'eval-coach',
  name: 'Eval Coach',
  email: '',
  phone: '+15550000000',
  tz: 'America/Chicago',
  connect_recipient_key: null,
};
const NOW = new Date('2026-10-20T15:00:00Z');

async function extract(text: string, draft: { plan: SetupPlan; questions: string[] } | null): Promise<unknown> {
  return productionComplete({
    messages: [
      { role: 'system', content: setupSystemPrompt(COACH, [], draft, NOW) },
      { role: 'user', content: text },
    ],
    schema: SETUP_JSON_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'setup',
    timeoutMs: SETUP_MODEL_TIMEOUT_MS,
  });
}

function typeMatches(t: SetupType, e: ExpectType): boolean {
  if (e.name_includes && !t.name.toLowerCase().includes(e.name_includes.toLowerCase())) return false;
  for (const k of ['duration_min', 'capacity', 'price_cents', 'backup_pay_cents'] as const) {
    if (e[k] !== undefined && t[k] !== e[k]) return false;
  }
  return true;
}

function slotMatches(plan: SetupPlan, e: ExpectSlot): boolean {
  return plan.weekly.some((w) => {
    if (w.weekday !== e.weekday || w.time_local !== e.time_local) return false;
    if (!e.type_name_includes) return true;
    const type = plan.session_types.find((t) => t.key === w.type_key);
    return Boolean(type?.name.toLowerCase().includes(e.type_name_includes.toLowerCase()));
  });
}

function check(c: Case, raw: unknown, plan: SetupPlan, questions: string[]): string[] {
  const misses: string[] = [];
  const x = c.expect;
  if (x.coach_timezone !== undefined && plan.coach_timezone !== x.coach_timezone) {
    misses.push(`timezone ${plan.coach_timezone} != ${x.coach_timezone}`);
  }
  for (const e of x.types ?? []) {
    if (!plan.session_types.some((t) => typeMatches(t, e))) misses.push(`no type like ${JSON.stringify(e)}`);
  }
  for (const e of x.weekly ?? []) {
    if (!slotMatches(plan, e)) misses.push(`no weekly ${JSON.stringify(e)}`);
  }
  for (const e of x.forbid_weekly ?? []) {
    if (slotMatches(plan, e)) misses.push(`unexpected weekly ${JSON.stringify(e)}`);
  }
  for (const e of x.packages ?? []) {
    if (!plan.packages.some((p) => p.credits === e.credits && p.price_cents === e.price_cents)) {
      misses.push(`no package ${JSON.stringify(e)}`);
    }
  }
  for (const e of x.plans ?? []) {
    if (!plan.plans.some((p) => p.price_cents === e.price_cents && p.credits_per_month === e.credits_per_month)) {
      misses.push(`no plan ${JSON.stringify(e)}`);
    }
  }
  for (const q of x.questions_include ?? []) {
    if (!questions.some((have) => have.includes(q))) misses.push(`no question containing "${q}"`);
  }
  const rawText = JSON.stringify(raw);
  for (const s of x.forbid_in_output ?? []) {
    if (rawText.includes(s)) misses.push(`model output contains "${s}"`);
  }
  return misses;
}

async function main(): Promise<void> {
  if (!process.env.LITELLM_API_KEY) {
    console.error('LITELLM_API_KEY is not set. This eval calls the live model on purpose; set the key to run it.');
    process.exit(2);
  }
  const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;
  const file = JSON.parse(readFileSync(new URL('../eval/setup-utterances.json', import.meta.url), 'utf8')) as { cases: Case[] };
  const cases = file.cases.filter((c) => !only || c.id === only);

  let passed = 0;
  let calls = 0;
  for (const c of cases) {
    const started = Date.now();
    try {
      let draft: { plan: SetupPlan; questions: string[] } | null = null;
      if (c.draft_text) {
        draft = validateSetupPlan(await extract(c.draft_text, null), []);
        calls += 1;
      }
      const raw = await extract(c.text, draft);
      calls += 1;
      const { plan, questions } = validateSetupPlan(raw, []);
      const misses = check(c, raw, plan, questions);
      const ms = Date.now() - started;
      if (misses.length === 0) {
        passed += 1;
        console.log(`PASS ${c.id} (${ms} ms)`);
      } else {
        console.log(`MISS ${c.id} (${ms} ms)\n  ${misses.join('\n  ')}\n  plan: ${JSON.stringify(plan)}`);
      }
    } catch (err) {
      console.log(`FAIL ${c.id}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${passed}/${cases.length} cases passed, ${calls} model calls (model: ${process.env.LITELLM_MODEL ?? 'coachatron'}).`);
  process.exit(passed === cases.length ? 0 : 1);
}

await main();
