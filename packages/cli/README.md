# mxprobe

Email verification for AI agents. One call returns `send`, `hold` or `kill`
with the reason. The DNS tier is free and runs on your machine; the hosted
SMTP probe is 9 USD per 10,000 checks, 100 free at signup.

```bash
npx mxprobe check hello@example.com ops@example.org   # free, local, no key
npx mxprobe signup you@company.com                    # a key by API, 100 free checks, saved to ~/.config/mxprobe
npx mxprobe check --hosted hello@example.com          # DNS kills stay local; survivors go to the mailbox probe
npx mxprobe balance
npx mxprobe buy                                       # a Stripe link: 9 USD per 10,000, credits never expire
npx mxprobe mcp                                       # the MCP server on stdio
```

## MCP

```bash
claude mcp add mxprobe -- npx -y mxprobe mcp
```

Any client: `{"mcpServers":{"mxprobe":{"command":"npx","args":["-y","mxprobe","mcp"]}}}`

Tools: `verify_email`, `verify_batch`, `signup`, `balance`, `buy_credits`.
With a key configured, `verify_*` probe the mailbox on the hosted tier; without
one they run the free DNS tier. Set `MXPROBE_API_KEY` to use a key from the
environment.

## Verdict

```json
{
  "email": "hello@example.com",
  "action": "send",
  "verdict": "OK",
  "reason": "mailbox accepted by aspmx.l.google.com",
  "checks": { "syntax": true, "mx": "aspmx.l.google.com", "smtp": "accepted", "catch_all": false }
}
```

- `send`: the mail server accepted the mailbox.
- `hold`: send only with a fallback in hand. A catch-all, a forwarder, a
  greylist, or a server that refused the probe rather than the mailbox.
- `kill`: never send. No mail server, or the mailbox does not exist.

## From Node

```ts
import { createClient, checkEmails } from "mxprobe";
const client = createClient({ apiKey: process.env.MXPROBE_API_KEY });
const { results, summary } = await checkEmails(["a@b.com"], { hosted: true, client });
```

Typed: `Client`, `CheckOptions`, `CheckOutput` and the response types come
with the package; `results` is `VerifyResult[]` from `mxprobe-core`.

Docs: https://mxprobe.dev. Source: https://github.com/andrewchmr/mxprobe. MIT.
