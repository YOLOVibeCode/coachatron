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
  input, select {
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
