import { readFileSync } from "node:fs";
import { defineRailway, github, preserve, project, service } from "railway/iac";

// Coachatron's web service, in every environment. Replaces railway.json
// (Config as Code), which Railway stops reading on 2026-12-01.
//
// Railway does not read this file on deploy. Preview and apply it per
// environment, from the repo root, with the environment linked:
//   railway environment development   # or uat, production
//   railway config plan
//   railway config apply
//
// "web" is a partial: this file owns only the web service. Postgres, its
// volume, and slack-cards (production) are managed elsewhere and are never
// touched by apply.
export const partial = "web";

// The Node version comes from .nvmrc, the one place the repo names it
// (test/toolchain.test.ts keeps package.json engines in step). Railpack reads
// RAILPACK_NODE_VERSION before engines, so this variable is what decides the
// Node a deploy runs. COACHATRON_IAC_PRESERVE_NODE=1 keeps the live value
// instead, for applying the rest of this file without changing Node.
function nodeVersion() {
  if (process.env.COACHATRON_IAC_PRESERVE_NODE === "1") return preserve();
  return readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
}

const ENVIRONMENTS = {
  development: { branch: "develop", domains: ["dev.coachatron.com"] },
  uat: { branch: "staging", domains: ["uat.coachatron.com"] },
  production: { branch: "main", domains: ["coachatron.com", "www.coachatron.com"] },
} as const;

export default defineRailway((ctx) => {
  const name = (Object.keys(ENVIRONMENTS) as Array<keyof typeof ENVIRONMENTS>).find((env) => ctx.isEnvironment(env));
  if (!name) throw new Error(`No web settings for Railway environment "${ctx.environmentName}"`);
  const env = ENVIRONMENTS[name];

  const web = service("web", {
    source: github("YOLOVibeCode/coachatron", { branch: env.branch, checkSuites: false }),
    build: "npm run build",
    start: "npm start",
    healthcheck: "/",
    healthcheckTimeout: 30,
    replicas: { "us-east4-eqdc4a": 1 },
    domains: env.domains.map((domain) => ({ domain, port: 3000 })),
    // Values live in Railway, never in this file. preserve() keeps each one.
    // Every variable on web must be listed here: apply deletes any it omits.
    env: {
      APP_BASE_URL: preserve(),
      APP_ENV: preserve(),
      DATABASE_URL: preserve(),
      LITELLM_API_KEY: preserve(),
      LITELLM_BASE: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      RAILPACK_NODE_VERSION: nodeVersion(),
      RELAY_API_KEY: preserve(),
      RELAY_BASE_URL: preserve(),
      RELAY_CONNECT_PRODUCT: preserve(),
      RELAY_INBOUND_SECRET: preserve(),
      RELAY_WEBHOOK_SECRET: preserve(),
      SESSION_SECRET: preserve(),
      STORE_BASE_URL: preserve(),
    },
  });

  return project("coachatron", { resources: [web] });
});
