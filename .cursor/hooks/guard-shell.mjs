#!/usr/bin/env node
/**
 * Hook: block the handful of shell commands an autonomous agent should never
 * run in a repo, regardless of what the prompt says. Hooks are enforced by the
 * runtime, not the model, so they hold even when the prompt is wrong.
 *
 * Input arrives on stdin as JSON ({ command, cwd, ... }); output is JSON with
 * { continue, permission: "allow" | "deny" | "ask", user_message?, agent_message? }.
 * See https://cursor.com/docs/hooks for the full schema. Cloud agents run this
 * from .cursor/hooks.json in the repo; hooks do not run during the read-only
 * exploratory turns, only once the agent has a writable environment.
 */
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const command = String(input.command ?? "");

const denied = [
  { re: /\bgit\s+push\b.*--force\b/, why: "force-push is never allowed for agents" },
  { re: /\bgit\s+push\b.*\b(main|master|develop)\b/, why: "agents push feature branches, never the integration branch (main/master/develop)" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "destructive reset" },
  { re: /\brm\s+-rf\s+(\/|~|\.)\s*$/, why: "destructive delete of a root" },
  { re: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/, why: "publishing requires a human" },
  { re: /\b(vercel|railway|fly|kubectl|terraform|aws|gcloud)\s+(deploy|apply|up|rollout)\b/, why: "deploys require a human" },
  { re: /--no-verify\b/, why: "hooks must not be skipped" },
];

for (const { re, why } of denied) {
  if (re.test(command)) {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        permission: "deny",
        user_message: `Blocked by .cursor/hooks: ${why}`,
        agent_message: `That command is blocked in this repository (${why}). Choose a non-destructive alternative or report that a human must do it.`,
      }),
    );
    process.exit(0);
  }
}

process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
