# MX Probe

Email verification for AI agents. One call returns `send`, `hold` or `kill`
for an address, with the reason. Signup and credits happen by API too, so an
outreach agent can provision itself. No form, no CAPTCHA, no dashboard.

- Site and docs: https://mxprobe.dev
- API: https://api.mxprobe.dev (it describes itself on `GET /`)
- npm: [`mxprobe`](https://www.npmjs.com/package/mxprobe) (CLI + MCP server), [`mxprobe-core`](https://www.npmjs.com/package/mxprobe-core) (the engine)

```bash
npx mxprobe check hello@example.com          # free DNS tier, local, no key
npx mxprobe check --hosted hello@example.com # survivors go to the hosted SMTP probe
claude mcp add mxprobe -- npx -y mxprobe mcp # the MCP server
```

```json
{
  "email": "hello@example.com",
  "action": "send",
  "verdict": "OK",
  "reason": "mailbox accepted by aspmx.l.google.com",
  "checks": { "syntax": true, "mx": "aspmx.l.google.com", "smtp": "accepted", "catch_all": false }
}
```

`action` is `send`, `hold` or `kill`; `verdict` is `OK`, `WEAK` or `DEAD`. A
`hold` never becomes a `kill` on a refusal, a greylist or a catch-all. Only a
5xx that names the mailbox kills.

## Layout

| Path | What |
|---|---|
| `packages/core` | The engine: DNS tier, SMTP probe, the verdict contract. Zero dependencies. |
| `packages/cli` | `npx mxprobe check | signup | balance | buy | mcp`. Also exports `createClient`. |
| `server` | The hosted API: `node:http` + `node:sqlite`, Stripe Checkout, Resend, Telegram. |
| `site` | The landing page, static. |
| `deploy` | Caddyfile, systemd units, the install script and the runbook. |

## Develop

```bash
pnpm install
pnpm test                       # offline: fake resolver, fake SMTP server, in-memory SQLite
pnpm test:live                  # the DNS tier against the real network
node packages/cli/bin/mxprobe.mjs check a@b.com
cp server/.env.example server/.env && pnpm --filter mxprobe-server dev
```

Node 22.13 or newer for the server (`node:sqlite`); the engine and CLI run on
Node 20.

## Pricing

100 checks free at signup, then 9 USD per 10,000, one payment, credits never
expire. Addresses are logged for 24 hours for debugging and then deleted.

MIT.
