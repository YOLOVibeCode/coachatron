# AGENTS.md

Coachatron sells a coach's session and takes an application fee. The coach is
the merchant. Read `SPEC.md` and `docs/PLATFORM.md` before writing code. Those
files win over a generic stack preference.

## Layout

- `design/index.html` is the Postcard reference. Match it. Do not replace the product with that file.
- Server-rendered HTML. No SPA. Mobile first.
- One service. Postgres in production. Tests may use PGlite so `npm test` needs no daemon.
- Payments go through the Noctusoft Connect Hub HTTP API (`productKey` `coachatron`, fee 400 bps). Do not import a Square SDK.
- SMS and email go through the Noctusoft relay. Do not import Twilio or SendGrid.
- The model is one interface. The production client calls LiteLLM on litellm-vm at `https://api.noctusoft.com/v1`. No provider SDK. Tests use a fake. Slice 1 does not call the model.

## Commands

Fill these in as the project gains them, and keep them true:

| Purpose | Command |
| --- | --- |
| Install | `npm ci` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Dev | `npm run dev` |

## Never

- Do not hold funds, store card data, or make Coachatron the merchant of record.
- Do not add a thirteenth screen. Slice 1 is the twelve in SPEC.md §8.1.
- Do not push to `main` or `develop`. Open a PR into `develop`.
- Do not deploy. Do not call live Square, Twilio, or a model provider.
- Do not put goalkeeper-specific words in the product name, schema, or URL structure.
- Do not switch the Cloud Agent to Fast, Opus, or GPT. Do not buy extra Max usage.

## Definition of done

1. Tests cover the change.
2. `npm test` passes from a fresh clone with no secrets.
3. Working tree is clean.
4. Last lines of the job are COST on that engine's own meter.
