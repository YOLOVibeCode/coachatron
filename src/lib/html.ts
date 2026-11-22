/** Server-rendered HTML helper. No templating engine dependency: a tagged
 * template that escapes interpolated values by default, plus a `raw()`
 * escape hatch for pre-built markup. */

import { SMS_BRAND, SMS_PURPOSE } from '../config.js';
import { canonicalUrl } from './siteHost.js';

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class SafeHtml {
  constructor(public readonly value: string) {}
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    if (Array.isArray(value)) {
      out += value.map((v) => (v instanceof SafeHtml ? v.value : escapeHtml(v))).join('');
    } else if (value instanceof SafeHtml) {
      out += value.value;
    } else {
      out += escapeHtml(value);
    }
    out += strings[i + 1];
  });
  return new SafeHtml(out);
}

/** Postcard design tokens, copied verbatim from design/index.html. Do not
 * invent new colors — see ROADMAP.md "Design tokens". */
export const POSTCARD_TOKENS_CSS = `
  :root {
    --page: #f6e7d8;
    --ink: #2c211c;
    --muted: #6d5348;
    --teal: #0e6b64;
    --teal-ink: #f6fffd;
    --clay: #c46a45;
    --clay-line: #a85634;
    --screen: #fffaf4;
    --screen-ink: #2c211c;
    --screen-muted: #7a655b;
    --card: #fff;
    --line: #eddccb;
    --good: #0e6b64;
    --alert: #b64024;
    --touch-min: 44px;
    --shell-max: 100%;
    --page-pad: max(12px, env(safe-area-inset-left, 0px));
  }
  * { box-sizing: border-box; }
  html {
    overflow-x: hidden;
    scroll-padding-bottom: calc(var(--touch-min) + env(safe-area-inset-bottom, 0px));
  }
  html, body { margin: 0; background: var(--page); color: var(--ink); }
  body {
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    line-height: 1.4;
    padding: 0;
    padding-left: var(--page-pad);
    padding-right: var(--page-pad);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .phone {
    width: 100%;
    max-width: var(--shell-max);
    margin: 0 auto;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
  }
  .screen {
    background: var(--screen);
    color: var(--screen-ink);
    border-radius: 0;
    padding: 20px 16px;
    min-height: 100dvh;
    min-height: 100svh;
    display: flex;
    flex-direction: column;
    max-width: 100%;
  }
  .screen-main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 12px;
  }
  .banner-warn {
    background: color-mix(in srgb, var(--alert) 12%, var(--card));
    border: 1px solid var(--alert);
    border-radius: 12px;
    padding: 10px 12px;
    margin: 10px 0;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--screen-ink);
  }
  .schedule-edit {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    margin: 12px -16px -20px;
    padding: 8px 16px calc(8px + env(safe-area-inset-bottom, 0px));
    background: var(--screen);
    border-top: 1px solid var(--line);
  }
  .schedule-edit-toggle {
    list-style: none;
    cursor: pointer;
    display: block;
    width: 100%;
    text-align: center;
    background: transparent;
    color: var(--teal);
    border: 1px solid var(--teal);
    border-radius: 14px;
    padding: 12px 16px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }
  .schedule-edit-toggle::-webkit-details-marker { display: none; }
  .schedule-edit[open] .schedule-edit-toggle { margin-bottom: 10px; }
  .schedule-edit form { margin: 0; }
  .schedule-edit label { margin-top: 0; }
  .schedule-edit button { margin-top: 10px; }
  .setup-warnings { margin: 8px 0 0; padding-left: 1.2rem; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; }
  .setup-field-error { margin-top: 8px; margin-bottom: 0; }
  .action.disabled, button:disabled.ghost { opacity: 0.45; pointer-events: none; cursor: default; }
  h1 { font-size: 1.5rem; margin: 0 0 6px; }
  h2 { font-size: 1.1rem; margin: 18px 0 8px; font-weight: 600; }
  .muted, p.muted { color: var(--screen-muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.95rem; }
  label { display: block; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; color: var(--screen-muted); margin: 14px 0 4px; }
  input, select, textarea {
    width: 100%;
    max-width: 100%;
    min-height: var(--touch-min);
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
    font: inherit;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 16px;
  }
  button, .action {
    display: inline-block;
    margin-top: 18px;
    width: 100%;
    max-width: 100%;
    min-height: var(--touch-min);
    text-align: center;
    background: var(--teal);
    color: var(--teal-ink);
    border: 0;
    border-radius: 14px;
    padding: 12px 16px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    line-height: 1.2;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 12px 14px;
    margin-bottom: 10px;
    max-width: 100%;
  }
  .card strong { font-size: 1rem; }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    color: var(--screen-muted);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.9rem;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.95rem;
  }
  .row:last-child { border-bottom: 0; }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .stat {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 10px 12px;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .stat b { display: block; font-size: 1.1rem; margin-top: 2px; }
  .stat span { color: var(--screen-muted); font-size: 0.8rem; }
  .money-figure {
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    font-size: clamp(2rem, 8vw, 2.75rem);
    letter-spacing: -0.03em;
    line-height: 1;
    margin: 8px 0 4px;
  }
  .stack { display: flex; flex-direction: column; gap: 8px; }
  .roster-list { list-style: none; margin: 0; padding: 0; }
  .roster-priority-form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
  }
  .roster-priority-form input[type="number"] {
    width: 4.5rem;
    min-height: var(--touch-min);
    flex: 0 0 auto;
  }
  .roster-priority-form button {
    width: auto;
    flex: 1 1 auto;
    min-width: min(100%, 10rem);
    margin-top: 0;
  }
  .error { color: var(--alert); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; margin-top: 8px; }
  .ask-reply p { margin: 0 0 8px; font-family: ui-sans-serif, system-ui, sans-serif; }
  .btn-row { display: flex; gap: 8px; }
  .btn-row button, .btn-row .action { margin-top: 8px; flex: 1; }
  .payments-banner { margin-bottom: 12px; }
  .payments-banner p { margin: 0 0 8px; }
  .payments-banner .action { margin-top: 8px; }
  .page-link-compact { margin-bottom: 10px; }
  .page-link-share-note { margin-top: 6px; font-size: 0.85rem; }
  button[disabled], .action[aria-disabled="true"] {
    opacity: 0.55;
    cursor: not-allowed;
    pointer-events: none;
  }
  .page-link label { margin-top: 0; }
  button.ghost { background: transparent; color: var(--teal); border: 1px solid var(--teal); }
  a.card { display: block; color: inherit; text-decoration: none; }
  textarea { min-height: 9rem; resize: vertical; line-height: 1.4; }
  .setup-type { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .setup-type:last-of-type { border-bottom: 0; }
  .setup-questions { margin: 8px 0 0; padding-left: 1.2rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  a.action.ghost, .action.ghost { background: transparent; color: var(--teal); border: 1px solid var(--teal); }
  button.danger, .action.danger { background: var(--alert); border-color: var(--alert); }
  .coach-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin: 0 0 14px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.9rem;
  }
  .coach-nav a { color: var(--screen-muted); text-decoration: none; padding: 6px 0; }
  .coach-nav a[aria-current="page"] { color: var(--teal); font-weight: 600; }
  .sms-consent {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin: 12px 0;
    font-size: 0.95rem;
    color: var(--screen-muted);
    font-family: ui-sans-serif, system-ui, sans-serif;
    cursor: pointer;
  }
  .sms-consent input[type="checkbox"] {
    width: auto;
    min-width: var(--touch-min);
    min-height: var(--touch-min);
    flex-shrink: 0;
    margin: 0;
    accent-color: var(--teal);
  }
  .sms-consent a { color: var(--teal); }
  @media (min-width: 768px) {
    :root { --shell-max: min(640px, 100%); }
    body {
      padding-top: 24px;
      padding-bottom: 24px;
    }
    .screen {
      border-radius: 18px;
      padding: 28px 24px;
      min-height: auto;
    }
    .schedule-edit {
      margin: 16px -24px -28px;
      padding: 12px 24px 16px;
      border-radius: 0 0 18px 18px;
    }
    .card { padding: 14px 16px; border-radius: 16px; }
  }
  @media (min-width: 1024px) {
    :root { --shell-max: min(720px, 100%); }
    .screen { padding: 32px 28px; }
    .schedule-edit {
      margin: 16px -28px -32px;
      padding: 12px 28px 16px;
    }
  }
`;

export type CoachNavKey = 'schedule' | 'types' | 'pricing' | 'roster' | 'money';

const COACH_NAV: Array<[CoachNavKey, string, string]> = [
  ['schedule', '/app/schedule', 'Schedule'],
  ['types', '/app/session-types', 'Types'],
  ['pricing', '/app/pricing', 'Pricing'],
  ['roster', '/app/roster', 'Roster'],
  ['money', '/app/money', 'Money'],
];

/** Plain links across the coach screens. Muted text, not buttons, so each
 * screen keeps its one teal action. */
export function coachNav(active?: CoachNavKey): SafeHtml {
  return html`<nav class="coach-nav" aria-label="Coach">
    ${COACH_NAV.map(([key, href, label]) =>
      key === active ? html`<a href="${href}" aria-current="page">${label}</a>` : html`<a href="${href}">${label}</a>`,
    )}
  </nav>`;
}

export function smsConsentCheckbox(): SafeHtml {
  return html`<label class="sms-consent">
    <input type="checkbox" name="sms_consent" value="1" />
    Text me booking confirmations, reminders, and session updates from Coachatron. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. See our <a href="/terms#sms">SMS Terms</a> and <a href="/privacy">Privacy Policy</a>.
  </label>`;
}

/** Enables submit on forms that require the consent box first (schedule “Turn on texts”). */
export const SMS_CONSENT_GATED_SUBMIT_SCRIPT =
  "document.querySelectorAll('form.sms-consent-gated').forEach(function(f){var c=f.querySelector('input[name=sms_consent]');var b=f.querySelector('button[type=submit]');if(!c||!b)return;function sync(){b.disabled=!c.checked;}sync();c.addEventListener('change',sync);});";

/** Short disclosure beside the landing-page text option (approved program copy). */
export function landingSmsDisclosure(): SafeHtml {
  return html`<p class="sms-disclosure">
    ${SMS_BRAND} sends SMS for ${SMS_PURPOSE}. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.
    <a href="/terms#sms">SMS Terms</a>
    <span aria-hidden="true"> · </span>
    <a href="/sms">Text messages</a>
    <span aria-hidden="true"> · </span>
    <a href="/privacy">Privacy</a>.
  </p>`;
}

/** Shown by a phone field that sends a code the person asks for. That one
 * text needs no box; the box is only for the texts that keep coming. */
export function oneTimeCodeNote(): SafeHtml {
  return html`<p class="muted sms-once">If you enter a mobile, we'll text a one-time code to it. Message and data rates may apply. Texts after that are optional: check the box below only if you want them.</p>`;
}

/** Who runs Coachatron, in the footer and at the top of the legal pages, so
 * a reviewer can tie the site to the business behind it. */
export function operatorLine(): SafeHtml {
  return html`<p class="operator">Coachatron is operated by Noctusoft, Inc. (<a href="https://noctusoft.com">https://noctusoft.com</a>)</p>`;
}

export function siteFooter(): SafeHtml {
  return html`<footer class="site-footer">
    ${operatorLine()}
    <a href="/privacy">Privacy</a>
    <span aria-hidden="true"> · </span>
    <a href="/terms">Terms</a>
    <span aria-hidden="true"> · </span>
    <a href="/sms">Text messages</a>
  </footer>`;
}

/** In every page's head: the tab icon, served by src/routes/site.ts. */
const FAVICON_LINK = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

/** What a page's head may carry beyond its title. */
export interface PageHead {
  /** The public page's own path, with no query: the landing page, the
   * legal and texting pages, a coach's page. Search engines are pointed at
   * APP_BASE_URL plus this path, so www, a Railway name or a query string
   * is not indexed as a page of its own. Never set on a coach's screen or
   * on a page a private link opens. */
  canonicalPath?: string;
}

/** The <link rel="canonical"> line, or nothing when the page names no path
 * or APP_BASE_URL is unset. */
function canonicalLink(head: PageHead): string {
  const href = head.canonicalPath === undefined ? null : canonicalUrl(head.canonicalPath);
  return href ? `\n<link rel="canonical" href="${escapeHtml(href)}">` : '';
}

export function page(title: string, body: SafeHtml, head: PageHead = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}${canonicalLink(head)}
<title>${escapeHtml(title)} — Coachatron</title>
<style>${POSTCARD_TOKENS_CSS}
  .site-footer { margin-top: 24px; font-size: 0.9rem; }
  .site-footer a { color: var(--teal); }
  .sms-once { font-size: 0.95rem; }
  .operator { font-size: 0.9rem; color: var(--screen-muted); }
</style>
</head>
<body>
<div class="phone"><div class="screen">${body.value}${siteFooter().value}</div></div>
</body>
</html>`;
}

/** Marketing page at `/`. Same Postcard tokens as the app, but no phone-shell
 * wrapper — the healthcheck stays a static 200 with no database. */
export const LANDING_CSS = `
  :root {
    --page: #f6e7d8;
    --ink: #2c211c;
    --muted: #6d5348;
    --teal: #0e6b64;
    --teal-ink: #f6fffd;
    --clay: #c46a45;
    --clay-line: #a85634;
    --screen: #fffaf4;
    --screen-ink: #2c211c;
    --screen-muted: #7a655b;
    --card: #fff;
    --line: #eddccb;
    --good: #0e6b64;
    --touch-min: 44px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { margin: 0; }
  body {
    background: var(--page);
    color: var(--ink);
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    line-height: 1.4;
  }
  .site-header {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--page);
    border-bottom: 1px solid var(--line);
    padding: 10px 16px;
  }
  .site-header-inner {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .site-brand {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 1rem;
    font-weight: 700;
    color: var(--ink);
    text-decoration: none;
    margin-right: auto;
  }
  .site-nav {
    display: none;
    align-items: center;
    gap: 18px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.95rem;
  }
  .site-nav a {
    color: var(--muted);
    text-decoration: none;
    font-weight: 600;
  }
  .site-nav a:hover { color: var(--teal); }
  .site-header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }
  .site-header .header-cta,
  .site-header .btn-outline {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    width: auto;
    min-height: var(--touch-min);
    padding: 10px 16px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.95rem;
    font-weight: 700;
    border-radius: 999px;
    text-decoration: none;
    line-height: 1.2;
    white-space: nowrap;
  }
  .site-header .header-cta {
    display: none;
    background: var(--teal);
    color: var(--teal-ink);
    border: 0;
  }
  .site-header .btn-outline {
    background: transparent;
    color: var(--teal);
    border: 2px solid var(--teal);
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 20px 20px 64px; }
  .kicker {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--teal);
  }
  h1 {
    font-weight: 500;
    font-size: clamp(2rem, 4.5vw, 3.25rem);
    line-height: 1;
    letter-spacing: -0.03em;
    margin: 8px 0 10px;
    max-width: 22ch;
  }
  .lede {
    max-width: 36rem;
    font-size: 1.1rem;
    margin: 0 0 16px;
  }
  .hero {
    display: grid;
    gap: 24px;
    align-items: start;
  }
  #how-it-works, #pricing, #faq { scroll-margin-top: 72px; }
  .box label {
    display: block;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.85rem;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .week-field { margin-bottom: 0; }
  .week-input-row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .week-input-row textarea {
    width: 100%;
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .week-voice {
    align-self: flex-start;
    width: 56px;
    min-width: 56px;
    height: 56px;
    min-height: 56px;
    margin: 0;
    padding: 0;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--teal);
    font-size: 1.35rem;
    line-height: 1;
    cursor: pointer;
  }
  .week-voice[hidden] { display: none; }
  .voice-status {
    margin: 8px 0 0;
    min-height: 1.25em;
    color: var(--muted);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.9rem;
  }
  textarea {
    width: 100%;
    min-height: 7rem;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.4;
    resize: vertical;
  }
  button, .action {
    display: inline-block;
    margin-top: 12px;
    width: 100%;
    min-height: var(--touch-min);
    text-align: center;
    background: var(--teal);
    color: var(--teal-ink);
    border: 0;
    border-radius: 999px;
    padding: 12px 16px;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    text-decoration: none;
    line-height: 1.2;
  }
  .hint, .fine, .faq p, .faq dd, .price p, footer a, .form-alt, .sms-card, .preview-label {
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: 0.9rem; }
  .form-alt {
    margin: 14px 0 0;
    font-size: 1rem;
    text-align: center;
  }
  .form-alt a {
    display: inline-block;
    min-height: var(--touch-min);
    line-height: var(--touch-min);
    color: var(--teal);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .sms-card {
    margin-top: 16px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: var(--card);
  }
  .sms-card strong {
    display: block;
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .sms-number {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--touch-min);
    width: 100%;
    border-radius: 999px;
    background: var(--teal);
    color: var(--teal-ink);
    font-size: 1.1rem;
    font-weight: 700;
    text-decoration: none;
  }
  .sms-number:hover { filter: brightness(1.05); }
  .sms-copy {
    display: none;
    margin-top: 10px;
    width: 100%;
    min-height: var(--touch-min);
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }
  .sms-disclosure {
    margin: 12px 0 0;
    font-size: 0.78rem;
    line-height: 1.35;
    color: var(--muted);
  }
  .sms-disclosure a { color: var(--teal); }
  .sms-number-digits {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    border: 0;
  }
  .preview-label {
    margin: 0 0 12px;
    font-size: 0.9rem;
    color: var(--muted);
    text-align: center;
  }
  .landing-slots {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 11.5rem;
    overflow: hidden;
  }
  button.landing-slot {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  button.landing-slot.on {
    border-color: var(--teal);
    box-shadow: inset 0 0 0 1px var(--teal);
  }
  .landing-pack { margin-top: 4px; }
  .landing-book { pointer-events: none; }
  .steps, .faq, .price { margin-top: 36px; max-width: 36rem; }
  .steps h2, .faq h2, .price h2 {
    font-weight: 500;
    font-size: 1.6rem;
    letter-spacing: -0.03em;
    margin: 0 0 12px;
  }
  .price-lede {
    font-weight: 600;
    color: var(--ink);
    margin: 0 0 8px;
    font-size: 1.05rem;
  }
  .steps ol { margin: 0; padding: 0; list-style: none; counter-reset: step; }
  .steps li {
    counter-increment: step;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 14px 16px 14px 52px;
    margin-bottom: 10px;
    position: relative;
  }
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 14px;
    top: 14px;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    background: var(--teal);
    color: var(--teal-ink);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .steps strong { display: block; font-size: 1.05rem; }
  .steps span {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.95rem;
  }
  .faq dl { margin: 0; }
  .faq dt {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-weight: 700;
    font-size: 1rem;
    margin: 12px 0 4px;
  }
  .faq dt:first-child { margin-top: 0; }
  .faq dd {
    margin: 0 0 8px;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.95rem;
  }
  .faq dd:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }
  .price p { color: var(--muted); margin: 0; }
  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 28px;
  }
  .phone {
    width: min(320px, 100%);
    height: 660px;
    background: var(--clay);
    border: 1px solid var(--clay-line);
    border-radius: 40px;
    padding: 10px;
  }
  .screen {
    height: 100%;
    background: var(--screen);
    color: var(--screen-ink);
    border-radius: 32px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .status {
    display: flex;
    justify-content: space-between;
    padding: 14px 18px 0;
    font-size: 12px;
    font-weight: 650;
  }
  .body {
    padding: 6px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }
  .eyebrow {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--screen-muted);
    margin: 6px 0 0;
  }
  .screen h2 {
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    font-weight: 500;
    font-size: 30px;
    line-height: 1;
    letter-spacing: -0.03em;
    margin: 0;
  }
  .sub { margin: 0; color: var(--screen-muted); font-size: 13px; }
  .card {
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 12px;
    background: var(--card);
  }
  .card strong { display: block; font-size: 15px; }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
    color: var(--screen-muted);
    font-size: 13px;
  }
  .spots { color: var(--good); font-weight: 700; }
  .btn {
    margin-top: auto;
    border: 0;
    background: var(--teal);
    color: var(--teal-ink);
    border-radius: 999px;
    padding: 14px 12px;
    font: inherit;
    font-size: 16px;
    font-weight: 700;
    text-align: center;
  }
  footer.colophon {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid #e4d0bc;
    font-size: 0.95rem;
    color: var(--muted);
  }
  footer.colophon p { margin: 0 0 8px; }
  footer.colophon a { color: var(--teal); }
  @media (min-width: 900px) {
    .site-nav { display: flex; }
    .site-header .header-cta { display: inline-flex; }
    .site-header-actions { margin-left: 0; }
    .site-brand { margin-right: 0; }
    .site-header-inner { flex-wrap: nowrap; gap: 24px; }
    .wrap { padding: 28px 28px 80px; }
    .hero { grid-template-columns: 1fr 320px; gap: 40px; align-items: start; }
    .stage { margin-top: 0; justify-content: center; }
    .preview-label { text-align: left; }
    .sms-copy { display: block; }
    .landing-slots { max-height: none; overflow: visible; }
    .week-input-row {
      flex-direction: row;
      align-items: stretch;
    }
    .week-voice {
      width: 52px;
      min-width: 52px;
      height: auto;
      min-height: var(--touch-min);
      align-self: stretch;
    }
  }
`;

export function landingPage(title: string, description: string, body: SafeHtml, head: PageHead = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}${canonicalLink(head)}
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<style>${LANDING_CSS}
  .site-footer { padding: 0 20px 32px; text-align: center; font-size: 0.9rem; }
  .site-footer a { color: var(--teal); }
</style>
</head>
<body>
${body.value}
${siteFooter().value}
</body>
</html>`;
}
