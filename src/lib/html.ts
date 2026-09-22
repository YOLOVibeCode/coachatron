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
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--page); color: var(--ink); }
  body {
    font-family: "Iowan Old Style", Palatino, Georgia, serif;
    line-height: 1.4;
    display: flex;
    justify-content: center;
    padding: 24px 12px;
  }
  .phone {
    width: 100%;
    max-width: 360px;
    background: var(--clay);
    border: 1px solid var(--clay-line);
    border-radius: 32px;
    padding: 14px;
  }
  .screen {
    background: var(--screen);
    color: var(--screen-ink);
    border-radius: 22px;
    padding: 24px 20px;
    min-height: 480px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 6px; }
  p.muted { color: var(--screen-muted); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.95rem; }
  label { display: block; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; color: var(--screen-muted); margin: 14px 0 4px; }
  input, select {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
    font: inherit; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 1rem;
  }
  button, .action {
    display: inline-block; margin-top: 18px; width: 100%; text-align: center;
    background: var(--teal); color: var(--teal-ink); border: 0; border-radius: 14px;
    padding: 12px 16px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 1rem;
    font-weight: 600; cursor: pointer; text-decoration: none;
  }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; margin-bottom: 10px; }
  .error { color: var(--alert); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.9rem; margin-top: 8px; }
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
