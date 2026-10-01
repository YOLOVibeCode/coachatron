/** Server-rendered HTML helper. No templating engine dependency: a tagged
 * template that escapes interpolated values by default, plus a `raw()`
 * escape hatch for pre-built markup. */

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
  }
  /* Sticky ask block stays above the virtual keyboard on small screens. */
  .schedule-ask {
    flex-shrink: 0;
    position: sticky;
    bottom: 0;
    margin: 12px -16px -20px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
    background: var(--screen);
    border-top: 1px solid var(--line);
  }
  .schedule-ask form { margin: 0; }
  .schedule-ask label { margin-top: 0; }
  .schedule-ask button { margin-top: 10px; }
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
  .btn-row button { margin-top: 8px; flex: 1; }
  button.ghost { background: transparent; color: var(--teal); border: 1px solid var(--teal); }
  a.card { display: block; color: inherit; text-decoration: none; }
  textarea { min-height: 9rem; resize: vertical; line-height: 1.4; }
  .setup-type { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .setup-type:last-of-type { border-bottom: 0; }
  .setup-questions { margin: 8px 0 0; padding-left: 1.2rem; font-family: ui-sans-serif, system-ui, sans-serif; }
  a.action.ghost, .action.ghost { background: transparent; color: var(--teal); border: 1px solid var(--teal); }
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
    .schedule-ask {
      margin: 16px -24px -28px;
      padding: 16px 24px;
      border-radius: 0 0 18px 18px;
    }
    .card { padding: 14px 16px; border-radius: 16px; }
  }
  @media (min-width: 1024px) {
    :root { --shell-max: min(720px, 100%); }
    .screen { padding: 32px 28px; }
    .schedule-ask {
      margin: 16px -28px -32px;
      padding: 16px 28px;
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

export function page(title: string, body: SafeHtml): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Coachatron</title>
<style>${POSTCARD_TOKENS_CSS}</style>
</head>
<body>
<div class="phone"><div class="screen">${body.value}</div></div>
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
  html, body { margin: 0; }
  body {
    background: var(--page);
    color: var(--ink);
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    line-height: 1.4;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 64px; }
  .kicker {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--teal);
  }
  h1 {
    font-weight: 500;
    font-size: clamp(2.4rem, 8vw, 4.6rem);
    line-height: 0.95;
    letter-spacing: -0.03em;
    margin: 12px 0 14px;
    max-width: 14ch;
  }
  .lede {
    max-width: 36rem;
    font-size: 1.2rem;
    margin: 0 0 22px;
  }
  .hero {
    display: grid;
    gap: 32px;
    align-items: start;
  }
  .box label {
    display: block;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.85rem;
    color: var(--muted);
    margin-bottom: 6px;
  }
  textarea {
    width: 100%;
    min-height: 8.5rem;
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
  .hint, .sms, .fine, .skip p, .price p, footer a {
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: 0.9rem; }
  .sms { margin: 14px 0 0; font-size: 1rem; }
  .sms a { color: var(--teal); font-weight: 600; }
  .steps, .skip, .price { margin-top: 36px; max-width: 36rem; }
  .steps h2, .skip h2, .price h2 {
    font-weight: 500;
    font-size: 1.6rem;
    letter-spacing: -0.03em;
    margin: 0 0 12px;
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
  .skip ul { margin: 0; padding: 0; list-style: none; }
  .skip li {
    font-family: ui-sans-serif, system-ui, sans-serif;
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .skip li:last-child { border-bottom: 0; }
  .price p, .skip p { color: var(--muted); margin: 0; }
  .stage { display: none; }
  .phone {
    width: 320px;
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
    .wrap { padding: 40px 28px 80px; }
    .hero { grid-template-columns: 1fr 320px; gap: 48px; }
    .stage { display: flex; justify-content: center; }
  }
`;

export function landingPage(title: string, description: string, body: SafeHtml): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<style>${LANDING_CSS}</style>
</head>
<body>
${body.value}
</body>
</html>`;
}
