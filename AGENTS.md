# AGENTS.md

Coachatron sells a coach's session and takes an application fee. The coach is
the merchant. Read `SPEC.md` and `docs/PLATFORM.md` before writing code. Those
files win over a generic stack preference.

## Layout

- `design/index.html` is the Postcard reference. Match it. Do not replace the product with that file.
- Server-rendered HTML. No SPA. Mobile first.
- One service. Postgres in production. Tests may use PGlite so `npm test` needs no daemon.
- Payments go through signed Noctusoft marketplace buy links (`GET /buy/connect/coachatron/:seller`). Do not import a Square SDK or card form.
- SMS and email go through the Noctusoft relay. Do not import Twilio or SendGrid.
- The model is one interface. The production client calls LiteLLM on litellm-vm at `https://ai.noctusoft.com/v1`. No provider SDK. Tests use a fake. The text assistant and voice setup (SMS + the schedule screen) are the only callers.

## Commands

Fill these in as the project gains them, and keep them true:

| Purpose | Command |
| --- | --- |
| Install | `npm ci` |
| Test | `npm test` |
| Typecheck | `npm run typecheck` |
| Dev | `npm run dev` |
| Eval voice setup (calls the live model; run on purpose only) | `LITELLM_API_KEY=... npm run eval:setup` |

## Testing texts end to end

Coachatron's number (`+1 833-364-5083`) cannot text itself, so the round trip needs a
second number. The operator sends from the shared Noctusoft number (`+1 855-573-5222`)
with the `twilio` CLI and reads the replies in Twilio's logs. Never send from another
product's number: the relay would forward Coachatron's reply into that product.

- Only the operator's own session runs it, after saying what will be sent and getting a yes. Never `npm test`, CI, or the Cloud Agent.
- Texts to Coachatron's number land on production (the relay routes it to `coachatron.com`), so they create real test records there. Payments stay on the Stripe sandbox.
- Cover the app's own keywords (`Y`, `N`, `1`, `2`, `HELP`, `STOP`) through the inbound route. Twilio answers STOP/START/HELP at the number level too, so those prove Twilio, not the app. Send START afterwards to undo an opt-out.
- Print dates, statuses and counts, not message bodies beyond the test's own texts. Never print credentials.
- Full steps: `~/.claude/rules/sms-testing.md`.

## Never

- Do not hold funds, store card data, or make Coachatron the merchant of record.
- Do not add a thirteenth screen. Slice 1 is the twelve in SPEC.md §8.1.
- Do not push to `main` or `develop`. Open a PR into `develop`.
- Do not deploy. Do not call live Square, Twilio, or a model provider. The one exception is the text test below, run by the operator from their Mac.
- Do not put goalkeeper-specific words in the product name, schema, or URL structure.
- Do not switch the Cloud Agent to Fast, Opus, or GPT. Do not buy extra Max usage.

## Definition of done

1. Tests cover the change.
2. `npm test` passes from a fresh clone with no secrets.
3. Working tree is clean.
4. Last lines of the job are COST on that engine's own meter.
