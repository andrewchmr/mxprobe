# mxprobe-server

The hosted API. `node:http` and `node:sqlite`, no framework, one dependency
(`mxprobe-core`). Deploy and operate: see [`../deploy/README.md`](../deploy/README.md).

```bash
cp .env.example .env      # fill in what you have; unset services are silent no-ops
pnpm dev                  # builds, then http://127.0.0.1:8787
pnpm test                 # builds, then: in-memory SQLite, canned verifier, fake Stripe
pnpm admin stats          # the kill-rule numbers (node dist/bin/admin.js)
```

TypeScript in `src/`, compiled to `dist/` by `pnpm build` (`tsc -b`, which
builds `mxprobe-core` first). The systemd units run `dist/index.js` and
`dist/bin/healthcheck.js`.

Routes: `GET /`, `GET /v1/health`, `POST /v1/signup`, `POST /v1/verify`,
`GET /v1/balance`, `POST /v1/credits/checkout`, `POST /v1/stripe/webhook`,
`POST /v1/subscribe`, `POST /v1/feedback`.

Keys are stored as SHA-256 hashes. A check whose mail server could not be
reached is refunded. The verify log is purged after 24 hours.
