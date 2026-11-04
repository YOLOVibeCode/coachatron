import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { APP_FEE_BPS, BOOKING_HOLD_MINUTES, OTP_MAX_ATTEMPTS, SELLER_AGREEMENT_VERSION } from '../src/config.js';
import { withServer } from './helpers/server.js';

/** The docs say how payments really run: Stripe Connect behind the relay,
 * the coach as merchant, the configured platform fee, a plan sold as a
 * one-time pack, booking that opens once the coach can take charges, spot
 * holds, payments kept for the coach when they cannot book, a credit for
 * every paid booking a coach cancels, and refunds not built yet. The drafts
 * in docs/legal are marked as drafts and are not served by the app. */

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
  /api\.square\.noctusoft\.com/,
  /connect after the change/,
  /zero-rated without a deploy/,
  /configurable per-coach and per-transaction-type from day one/,
];

/** What the legal drafts said before plans became one-time packs and a
 * coach's cancel credited paid drop-ins. */
const RETIRED_LEGAL_CLAIMS = [
  /monthly plans?/i,
  /Plan credits are meant to expire/,
  /nothing is returned automatically/,
  /gets nothing back\s+automatically/,
  /credits returned when a coach\s+cancels, do not expire/,
  /These credits do not\s+expire/,
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

test('docs say the fee is one rate per environment and a per-coach rate needs a relay change', () => {
  const cut = section(read('SPEC.md'), '### 9.3 Our cut');
  assert.match(cut, /one number per environment/);
  assert.match(cut, /every coach in that environment at once/);
  assert.match(cut, /per-coach or per-transaction-type fee needs a relay change/);
  const platform = section(read('docs/PLATFORM.md'), '### 1.1 Adding Coachatron as a product');
  assert.match(platform, /one rate per environment/);
  assert.match(platform, /every coach in that environment at\s+once/);
  assert.match(platform, /per-coach\s+rate[^.]*needs a relay change/);
  assert.match(read('docs/legal/marketplace-terms.md'), /needs a relay change\s+before it can be offered/);
});

test('docs say refunds are not built yet and name the relay refund route and event', () => {
  const refunds = section(read('SPEC.md'), '### 9.4 Refunds');
  assert.match(refunds, /Not built yet/);
  assert.match(refunds, /recipients\/:seller\/refunds/);
  assert.match(read('README.md'), /Refunds are not built/);
  assert.match(read('docs/PLATFORM.md'), /recipients\/:seller\/refunds/);
  for (const doc of ['SPEC.md', 'docs/PLATFORM.md', 'README.md']) {
    const text = read(doc);
    assert.match(text, /`marketplace\.purchase\.refunded`/, `${doc} names the seller refund event`);
    assert.doesNotMatch(text, /`purchase\.refunded`/, `${doc} names the refund event without its marketplace prefix`);
  }
});

test('the README lists the store settings the buy links and store events use', () => {
  const readme = read('README.md');
  for (const name of ['RELAY_BASE_URL', 'RELAY_CONNECT_PRODUCT', 'RELAY_WEBHOOK_SECRET', 'STORE_BASE_URL', 'STORE_WEBHOOK_URL']) {
    assert.match(readme, new RegExp(`^\\| \`${name}\` \\|`, 'm'), `README documents ${name}`);
  }
});

test('docs say a plan is a one-time pack, charged once', () => {
  for (const doc of ['SPEC.md', 'README.md']) {
    assert.match(read(doc), /plan is charged once/, `${doc} says a plan is charged once`);
    assert.match(read(doc), /one-time pack/, `${doc} names the one-time pack`);
  }
  assert.match(read('docs/PLATFORM.md'), /one-time pack,\s+charged once/);
  assert.match(read('docs/legal/parent-terms.md'), /one-time pack/);
  assert.match(read('docs/legal/parent-terms.md'), /charged once/);
  for (const draft of ['marketplace-terms.md', 'parent-terms.md', 'privacy-payments.md']) {
    for (const claim of RETIRED_LEGAL_CLAIMS) {
      assert.doesNotMatch(read(`docs/legal/${draft}`), claim, `${draft} still says ${claim}`);
    }
  }
});

test('docs give the spot hold and the sign-in code rules the app uses', () => {
  const hold = new RegExp(`for ${BOOKING_HOLD_MINUTES} minutes`);
  assert.match(section(read('SPEC.md'), '### 7.2 Athlete books and pays'), hold);
  assert.match(section(read('docs/PLATFORM.md'), '### 2.2 From publish to a paid booking'), hold);
  assert.match(read('README.md'), hold);
  assert.match(read('docs/legal/parent-terms.md'), hold);
  const tries = new RegExp(`after ${OTP_MAX_ATTEMPTS}\\s+wrong tries`);
  for (const doc of ['SPEC.md', 'README.md', 'docs/PLATFORM.md']) {
    assert.match(read(doc), tries, `${doc} says when a code stops working`);
    assert.match(read(doc), /works once/, `${doc} says a code works once`);
  }
});

test('docs use the words the app shows while booking is closed and for payments kept for the coach', () => {
  const closed = /Booking\s+opens\s+soon/;
  const kept = /Payments\s+to\s+resolve/;
  assert.match(read('src/routes/public.ts'), closed, 'the public page still says it');
  assert.match(read('src/routes/coach.ts'), kept, 'the Money screen still says it');
  for (const doc of ['SPEC.md', 'README.md', 'docs/PLATFORM.md', 'docs/legal/marketplace-terms.md', 'docs/legal/parent-terms.md']) {
    assert.match(read(doc), closed, `${doc} says booking opens once the coach can take payments`);
  }
  for (const doc of ['SPEC.md', 'README.md', 'docs/PLATFORM.md', 'docs/legal/marketplace-terms.md']) {
    assert.match(read(doc), kept, `${doc} names the list of payments kept for the coach`);
  }
});

test("docs say a coach's cancel gives every paid booking a credit, drop-ins included", () => {
  for (const doc of ['README.md', 'docs/PLATFORM.md', 'docs/legal/marketplace-terms.md', 'docs/legal/parent-terms.md']) {
    assert.match(read(doc), /becomes\s+one\s+session\s+credit/, `${doc} says a paid drop-in becomes a credit`);
  }
  assert.match(section(read('SPEC.md'), '### 7.4 Coach gets paid'), /drop-in for it gets one session credit/);
});

test("docs say a package credit a coach's cancel returns keeps its package's expiry", () => {
  // The cancel puts the credit back on the row it came from, expiry and all;
  // only the credit a paid drop-in becomes is new, and it has none.
  assert.match(read('src/domain/cancelSession.ts'), /update credit set remaining = remaining \+ 1 where id = \$1/);
  assert.match(read('src/domain/cancelSession.ts'), /cancelledSessionCreditSource\(sessionId\), 1, null\)/);
  for (const doc of ['docs/legal/marketplace-terms.md', 'docs/legal/parent-terms.md']) {
    assert.match(read(doc), /package credit that comes back\s+keeps that package's\s+expiry/, `${doc} says a returned package credit keeps its expiry`);
  }
  assert.match(section(read('SPEC.md'), '### 7.4 Coach gets paid'), /keeps that credit's expiry/);
  assert.match(read('README.md'), /keeping the expiry it had/);
});

test('docs say an inbound text is acted on only when the relay confirms Twilio sent it', () => {
  for (const doc of ['README.md', 'docs/PLATFORM.md']) {
    assert.match(read(doc), /`x-relay-twilio-verified/, `${doc} names the relay's header`);
  }
});

test('the README screen table names the checkout token route and the payments link', () => {
  const readme = read('README.md');
  assert.match(readme, /`\/c\/:handle\/checkout\/:token`/);
  assert.doesNotMatch(readme, /checkout\/:bookingId/);
  assert.match(readme, /`\/p\/:token`/);
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
