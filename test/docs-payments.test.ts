import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { APP_FEE_BPS, SELLER_AGREEMENT_VERSION } from '../src/config.js';
import { withServer } from './helpers/server.js';

/** The docs say how payments really run: Stripe Connect behind the relay,
 * the coach as merchant, the configured platform fee, the monthly plan
 * charged once, and refunds not built yet. The drafts in docs/legal are
 * marked as drafts and are not served by the app. */

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

const BANNER = '**DRAFT for attorney review. Not in effect. Not legal advice.**';
const LEGAL_DRAFTS = ['marketplace-terms.md', 'parent-terms.md', 'privacy-payments.md'];

/** Payment flows the docs used to describe, none of which exist. */
const RETIRED_PAYMENT_CLAIMS = [
  /\(Square OAuth, one redirect\)/,
  /Square OAuth connect/,
  /Square hosted (checkout|payment)/,
  /coach's Square account/,
  /own Square dashboard/,
  /issued through Square/,
  /Square Connect with/,
  /Square marketplace\s+payments/,
  /connects their Square/,
  /Square\/Twilio-shaped/,
  /Square billing/,
  /"squareEnv"/,
  /NOCTUSOFT_SQUARE_CLIENT_SECRET/,
];

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const next = text.indexOf('\n#', start + heading.length);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

test('payment docs describe Stripe Connect, not a Square payment flow', () => {
  for (const doc of ['SPEC.md', 'docs/PLATFORM.md', 'README.md', 'ROADMAP.md', 'AGENTS.md']) {
    const text = read(doc);
    assert.match(text, /Stripe/, `${doc} names Stripe`);
    for (const claim of RETIRED_PAYMENT_CLAIMS) {
      assert.doesNotMatch(text, claim, `${doc} still says ${claim}`);
    }
  }
  for (const doc of ['SPEC.md', 'docs/PLATFORM.md', 'README.md']) {
    assert.match(read(doc), /Stripe Connect/, `${doc} names Stripe Connect`);
  }
  const architecture = section(read('SPEC.md'), '### 9.1 Architecture');
  assert.match(architecture, /dashboard: "none"/);
  assert.match(architecture, /fees_collector: "stripe", losses_collector: "stripe"/);
  assert.match(architecture, /merchant of record/);
});

test('docs and the coach terms draft state the platform fee the app is configured with', () => {
  const percent = `${APP_FEE_BPS / 100}%`;
  assert.match(section(read('SPEC.md'), '### 9.1 Architecture'), new RegExp(`${APP_FEE_BPS} bps \\(${percent}\\)`));
  assert.match(read('docs/PLATFORM.md'), new RegExp(`"appFeeBps": ${APP_FEE_BPS}`));
  assert.match(read('docs/legal/marketplace-terms.md'), new RegExp(`${percent} \\(${APP_FEE_BPS} basis points\\)`));
});

test('docs say refunds are not built yet and name the relay refund route', () => {
  const refunds = section(read('SPEC.md'), '### 9.4 Refunds');
  assert.match(refunds, /Not built yet/);
  assert.match(refunds, /recipients\/:seller\/refunds/);
  assert.match(read('README.md'), /Refunds are not built/);
  assert.match(read('docs/PLATFORM.md'), /recipients\/:seller\/refunds/);
});

test('docs say the monthly plan is charged once', () => {
  assert.match(read('SPEC.md'), /plan is charged once/);
  assert.match(read('README.md'), /monthly plan is charged once/);
  assert.match(read('docs/legal/parent-terms.md'), /charged once/);
});

test('each legal draft starts with the review banner and marks open questions', () => {
  const drafts = readdirSync(new URL('docs/legal/', root)).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(drafts, [...LEGAL_DRAFTS].sort());
  for (const draft of drafts) {
    const text = read(`docs/legal/${draft}`);
    assert.equal(text.split('\n')[0], BANNER, `${draft} opens with the banner`);
    assert.match(text, /\[Attorney: /, `${draft} marks its open questions`);
  }
});

test('the coach terms draft is the version the Money screen asks coaches to accept', () => {
  const heading = read('docs/legal/marketplace-terms.md')
    .split('\n')
    .find((line) => line.startsWith('# '));
  assert.ok(heading, 'marketplace terms draft has a title');
  assert.ok(heading.includes(`(${SELLER_AGREEMENT_VERSION})`), `title names ${SELLER_AGREEMENT_VERSION}: ${heading}`);
});

test('the README points to the legal drafts', () => {
  assert.match(read('README.md'), /\[docs\/legal\/\]\(docs\/legal\/\)/);
});

test('the terms and privacy pages do not serve the drafts', async () => {
  await withServer(async (base) => {
    for (const path of ['/terms', '/privacy']) {
      const html = await (await fetch(`${base}${path}`)).text();
      assert.doesNotMatch(html, /DRAFT for attorney review/, `${path} shows a draft banner`);
      assert.doesNotMatch(html, /\[Attorney:/, `${path} shows a review note`);
    }
  });
});
