---
name: verify-quality-gate
description: Run all quality-bar commands to confirm Slice 1 is ready for release
source: auto-skill
extracted_at: '2026-09-22T09:06:30.066Z'
---

## When to use this skill

When you need to verify that Coachatron Slice 1 passes all quality-bar criteria before considering it release-ready.

## Procedure

1. **Fresh clone verification**
   - In a temporary directory, clone the repo from the local checkout
   - Run `npm ci` and ensure no security violations (no live Square/Twilio/SendGrid/LiteLLM calls)

2. **Run all quality-bar commands**
   - `npm run lint` — passes with no errors
   - `npm run typecheck` — passes with no errors  
   - `npm test` — 38/38 tests pass, no secrets required
   - `npm run build` — compiles without errors

3. **Start and verify health endpoint**
   - Run `npm start`
   - `curl http://localhost:3000/` returns HTTP 200

4. **Verify core user flows** (from SPEC.md)
   - Coach sign-in, session type creation, weekly schedule generation
   - Parent booking with drop-in/payment via fake Connect Hub relay
   - Full session overflow cascade → coach Y/Roster.Y flow

5. **Review non-goals**
   - CONFIRM: No SQLite, no fresh funds holding, fee is 4%
   - CONFIRM: No Square/Twilio/SendGrid/Anthropic/OpenAI SDKs
   - CONFIRM: Exactly 12 screens or fewer, per SPEC.md §8.1

## What success looks like

- All commands exit 0 with no output to stderr (except expected warnings)
- `npm test` exits with 38 passed, 0 failed
- Server responds 200 to `/`
- README has: install, run, test sections and known gaps

## Common failures and fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tamper] package.json changed` | Scripts differ from blueprint commit | Restore `test`, `lint`, `typecheck`, `build` scripts to match original |
| `27974 not found` | Server listens on 3000, test expected 27974 | Use correct port (3000) for health checks |
