# Railway configuration

`railway.ts` defines Coachatron's `web` service for every environment
(development from `develop`, uat from `staging`, production from `main`). It
replaced `railway.json`, which Railway stops reading on 2026-12-01.

Railway does not read this folder on deploy. Changes take effect only when
someone applies them, one environment at a time, from the repo root on Node 24:

```bash
railway environment development   # then uat, then production
railway config plan               # must say 0 to destroy
railway config apply
```

- **Partial `web`.** The file owns only the web service. Postgres, its volume,
  and slack-cards are not in it and apply never touches them.
- **Variables.** Every value stays in Railway; the file marks each one
  `preserve()`. Never put a secret here. **Add every new web variable to the
  file as `preserve()`**: apply deletes any variable the file leaves out.
  That includes optional ones nobody has set yet (every variable in the
  root README's variable table is listed; `test/health.test.ts` checks it),
  so setting one later in Railway survives the next apply.
- **Stopping.** `drainingSeconds: 15` gives a replaced deployment 15 seconds
  between SIGTERM and SIGKILL. The server needs up to 12 to stop cleanly
  (`gracefulShutdown` in `src/server.ts`); a test keeps the two in step.
- **Node version.** `RAILPACK_NODE_VERSION` comes from `../.nvmrc`. Railpack
  reads that variable before `package.json` engines, so it decides the Node a
  deploy runs. To apply everything except a Node change, set
  `COACHATRON_IAC_PRESERVE_NODE=1`.
- **Railway bug seen before (production).** `railway config apply` with any
  change used to fail in production with "Custom-domain registration is not
  supported" for `coachatron.com` and `www.coachatron.com`, though both exist
  and `plan` showed only the intended change. It did not occur on 2026-11-04,
  when apply worked in production. If it comes back, make the planned change
  directly (for a variable: `railway variable set KEY=VALUE --service web
  --environment production`), then run `railway config plan` to confirm it
  says "already up to date".
- **Production draining.** On 2026-11-04 `railway config apply` worked in
  production and set `deploy.drainingSeconds` to 15, the healthcheck path to
  `/health` and the start command to `node dist/server.js`. Before that, apply
  and `railway environment edit` would not set it there, so production was
  given the variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` instead. That
  variable was removed from Railway and from `railway.ts` later the same day;
  the setting in `railway.ts` is the only one now.