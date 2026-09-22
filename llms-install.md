# Install MX Probe

For an AI agent that sets up MCP servers (Cline and the like). The server
needs no clone and no build: it runs from npm over stdio, and the free DNS
tier needs no key.

Add this to the MCP settings file (Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "mxprobe": {
      "command": "npx",
      "args": ["-y", "mxprobe", "mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Node 20 or newer is the only requirement. `npx` fetches the `mxprobe` package
on the first start.

## Check it

Call `verify_email` on an address. The answer is `send`, `hold` or `kill` with
the reason. Without a key the tools run the DNS tier on this machine.

## Tools

| Tool | What |
|---|---|
| `verify_email` | One address: send, hold or kill, with the reason. |
| `verify_batch` | Up to 500 addresses in one call. |
| `signup` | Make a hosted key with 100 free checks. |
| `balance` | The credits left on the key. |
| `buy_credits` | A Stripe link: 9 USD per 10,000 checks. |

## The hosted tier (optional)

`signup` takes the operator's email address, creates the key and writes it to
`~/.config/mxprobe/config.json`. The verify tools then probe the mailbox over
SMTP, and a DNS kill stays local. You can also put the key in the `env` block
above as `MXPROBE_API_KEY`.

Docs: https://mxprobe.dev. For agents: https://mxprobe.dev/llms.txt.
