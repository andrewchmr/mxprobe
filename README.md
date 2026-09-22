# MX Probe

Email verification for AI agents. One call returns `send`, `hold` or `kill`
for an address, with the reason. Signup and credits happen by API too, so an
outreach agent can provision itself. No form, no CAPTCHA, no dashboard.

- Site and docs: https://mxprobe.dev
- API: https://api.mxprobe.dev (it describes itself on `GET /`). OpenAPI: https://mxprobe.dev/openapi.json. For agents: https://mxprobe.dev/llms.txt
- npm: [`mxprobe`](https://www.npmjs.com/package/mxprobe) (CLI + MCP server), [`mxprobe-core`](https://www.npmjs.com/package/mxprobe-core) (the engine)

```bash
npx mxprobe check hello@example.com          # free DNS tier, local, no key
npx mxprobe check --hosted hello@example.com # survivors go to the hosted SMTP probe
claude mcp add mxprobe -- npx -y mxprobe mcp # the MCP server
```

One click: [Cursor](https://cursor.com/install-mcp?name=mxprobe&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm14cHJvYmUiLCJtY3AiXX0%3D) · [VS Code](https://vscode.dev/redirect/mcp/install?name=mxprobe&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mxprobe%22%2C%22mcp%22%5D%7D) ·
[LM Studio](https://lmstudio.ai/install-mcp?name=mxprobe&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm14cHJvYmUiLCJtY3AiXX0%3D). In Claude Code the same server also comes as a plugin:
`/plugin marketplace add andrewchmr/mxprobe`, then `/plugin install mxprobe@mxprobe`.

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
| `packages/core` | The engine: DNS tier, SMTP probe, the verdict contract and the API's wire types. Zero dependencies. |
| `packages/cli` | `npx mxprobe check | signup | balance | buy | mcp`. Also exports `createClient`. |
| `server` | The hosted API: `node:http` + `node:sqlite`, Stripe Checkout, Resend, Telegram. |
| `site` | The landing page, static. |
| `deploy` | Caddyfile, systemd units, the install script and the runbook. |

## Develop

Everything is TypeScript (strict, ESM). Each package compiles its `src/` to
`dist/` with `tsc -b`; the published packages ship `dist/` only. `mxprobe` and
the server import `mxprobe-core` through the workspace link to its `dist/`,
so `pnpm build` at the root (which runs the packages in dependency order) must
come before a single package's `test` or `typecheck`. Tests are `.ts` files
that Node runs directly with its built-in type stripping.

```bash
pnpm install
pnpm build                      # tsc -b in each package, core first
pnpm test                       # builds, then: fake resolver, fake SMTP server, in-memory SQLite. No network.
pnpm typecheck                  # the sources and the tests, without emitting
pnpm test:live                  # the DNS tier against the real network
pnpm check a@b.com              # the CLI from this checkout
cp server/.env.example server/.env && pnpm dev:server
```

Node 22.18 or newer (24 recommended) to develop and to run the tests; the
compiled engine and CLI run on Node 20, the server on 22.13 or newer
(`node:sqlite`).

## Pricing

100 checks free at signup, then 9 USD per 10,000, one payment, credits never
expire. Addresses are logged for 24 hours for debugging and then deleted.

MIT.
