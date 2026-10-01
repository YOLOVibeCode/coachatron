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
  `preserve()`. Never put a secret here.
- **Node version.** `RAILPACK_NODE_VERSION` comes from `../.nvmrc`. Railpack
  reads that variable before `package.json` engines, so it decides the Node a
  deploy runs. To apply everything except a Node change, set
  `COACHATRON_IAC_PRESERVE_NODE=1`.
