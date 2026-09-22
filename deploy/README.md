# Deploy runbook

One VPS (OVH or Contabo, Ubuntu 24.04, port 25 open), Caddy in front, one
Node process, one SQLite file. Everything below is idempotent.

## 1. DNS, at Vercel (the registrar of mxprobe.dev)

| Record | Name | Value |
|---|---|---|
| A | `@` | VPS IPv4 |
| A | `www` | VPS IPv4 |
| A | `api` | VPS IPv4 |
| A | `probe` | VPS IPv4 |
| TXT | `probe` | `v=spf1 a -all` (some MX check the HELO name) |
| TXT | `@` | Resend's SPF plus `a:probe.mxprobe.dev`, once Resend gives you the include |
| MX, TXT | as Resend says | for `hello@mxprobe.dev` replies and DKIM |

Then set the **reverse DNS** of the VPS IP to `probe.mxprobe.dev` in the
provider panel. Google and Microsoft refuse a probe whose IP has no PTR.

## 2. Install

Without GitHub (how it went live on 2026-09-09):

```bash
deploy/push.sh ubuntu@145.239.86.59
```

It rsyncs this tree to `/opt/mxprobe`, installs `server/.env.production` as
`/etc/mxprobe/env`, and runs `deploy/install.sh` as root. Re-run it to deploy
a change; it restarts the service and reloads Caddy.

With GitHub, on a fresh box:

```bash
ssh root@VPS
curl -fsSL https://raw.githubusercontent.com/andrewchmr/mxprobe/main/deploy/install.sh | bash
```

OVH notes: the VPS 2027 range did not inject the account SSH key on reinstall
(twice); `ssh-copy-id` with the mailed password worked, after one interactive
login to change the expired password. Use the new manager
(manager.eu.ovhcloud.com/beta) for VPS actions; the classic one hides the
reinstall wizard in an iframe. The VPS is on manual renewal: renew before the
expiry date or switch it to automatic in "Zarządzaj usługami".

It installs Caddy, Node 24, pnpm, clones the repo to `/opt/mxprobe`, installs
the dependencies, compiles the TypeScript to `dist/` (`pnpm build`), creates
the `mxprobe` user, writes `/etc/mxprobe/env` from `server/.env.example`,
installs the systemd service and the hourly health timer, and reloads Caddy.

Fill in `/etc/mxprobe/env`:

- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` (the 9 USD price), `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`, `EMAIL_FROM="MX Probe <hello@mxprobe.dev>"`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Then `systemctl restart mxprobe-api`.

## 3. Stripe

1. Product "MX Probe checks", one price: 9.00 USD, one-time. Copy the price id.
2. Webhook endpoint `https://api.mxprobe.dev/v1/stripe/webhook`, event
   `checkout.session.completed`. Copy the signing secret.
3. The checkout pins `payment_method_types=card`: automatic methods reject a
   USD session on a PL account.

## 4. Go-live checks

```bash
# on the box
nc -z -w 5 aspmx.l.google.com 25 && echo port25 ok
dig +short -x $(curl -s https://api.ipify.org)          # must print probe.mxprobe.dev
sudo systemctl start mxprobe-health && journalctl -u mxprobe-health -n 3   # the hourly probe, with the real env file
journalctl -u mxprobe-api -f

# from anywhere
curl https://api.mxprobe.dev/
curl -X POST https://api.mxprobe.dev/v1/signup -H 'content-type: application/json' -d '{"email":"you@yourdomain"}'
curl https://api.mxprobe.dev/v1/verify -H "authorization: Bearer mxp_..." -H 'content-type: application/json' -d '{"emails":["you@yourdomain","nobody-7f3a@gmail.com"]}'
curl -X POST https://api.mxprobe.dev/v1/credits/checkout -H "authorization: Bearer mxp_..."   # pay it: this proves the money path
```

Also check the IP on blocklists before the first probe: mxtoolbox.com/blacklists.aspx.

## 5. Operate

```bash
cd /opt/mxprobe/server
DB_PATH=/var/lib/mxprobe/mxprobe.sqlite node dist/bin/admin.js stats      # the kill-rule numbers
DB_PATH=/var/lib/mxprobe/mxprobe.sqlite node dist/bin/admin.js keys
DB_PATH=/var/lib/mxprobe/mxprobe.sqlite node dist/bin/admin.js revoke someone@example.com
DB_PATH=/var/lib/mxprobe/mxprobe.sqlite node dist/bin/admin.js credits someone@example.com 1000 "goodwill"
```

Update: re-run `install.sh`. Backup: copy the SQLite file (it is in WAL mode;
`sqlite3 mxprobe.sqlite ".backup /root/mxprobe-$(date +%F).sqlite"`).

Kill switch (2026-10-20 rule): `systemctl disable --now mxprobe-api
mxprobe-health.timer`, keep the SQLite backup, cancel the VPS. The CLI's DNS
tier keeps working with no server.

## 6. Listings

What the site serves for crawlers, agents and link previews, all static
files in `site/`: `og.png` (the link-preview card, 1200x630, rendered from
`deploy/og.html` with headless Chromium, the command is in that file), `robots.txt`, `sitemap.xml`,
`llms.txt` and `llms-full.txt`, `openapi.json` (OpenAPI 3.1; `npx
@redocly/cli lint site/openapi.json` checks it), `.well-known/security.txt`
(its `Expires` is a year out; bump it). The API's `GET /` links the OpenAPI
and llms.txt. Bump the `version` in `openapi.json` with the packages.

MCP Registry: `packages/cli/server.json` is the manifest and
`packages/cli/package.json` carries `mcpName: dev.mxprobe/mxprobe`,
which the registry reads from the *published* npm package to prove
ownership. So publish the npm version first (tag `v<version>`), then, with
`server.json`'s two `version` fields at that version:

```bash
brew install mcp-publisher      # or the release tarball, see registry.modelcontextprotocol.io
cd packages/cli
KEY=~/.config/mxprobe/mcp-registry-ed25519.pem   # outside the repo; lose it and regenerate both files
mcp-publisher login http --domain mxprobe.dev --private-key "$(openssl pkey -in $KEY -noout -text | grep -A3 priv: | tail -n +2 | tr -d ' :\n')"
mcp-publisher publish
```

The `dev.mxprobe` namespace is proven by `site/.well-known/mcp-registry-auth`,
which holds the Ed25519 public key of that file (`openssl` must be OpenSSL 3,
`/opt/homebrew/opt/openssl@3/bin/openssl`; the system LibreSSL has no Ed25519).
The GitHub namespace `io.github.andrewchmr/*` would need `mcp-publisher login
github`, an interactive device flow.

Other directories (2026-09-13): Smithery lists the server as
`andrzej-chem/mxprobe` from an MCPB bundle (stdio servers cannot be published
by URL there): `deploy/mcpb.sh <version>` builds it from the npm package and
`packages/cli/mcpb/manifest.json`, then `npx -y @smithery/cli mcp publish
<bundle> -n andrzej-chem/mxprobe` (after `smithery auth login`). Glama indexes
the GitHub repo on its own (https://glama.ai/mcp/servers/andrewchmr/mxprobe);
PulseMCP imports from the official registry; mcp.so only has a paid listing.

The `awesome-mcp-servers` PR (punkpeye/awesome-mcp-servers#14309, Communication
section, with the Glama score badge the bot asks for) was MERGED 2026-09-15.
The lists of wong2 and appcypher do not carry MX Probe yet.

Claude Code plugin: `.claude-plugin/marketplace.json` names this repo as a
marketplace and `plugins/mxprobe/.claude-plugin/plugin.json` wires the MCP
server (`npx -y mxprobe mcp`). A user installs it with `/plugin marketplace add
andrewchmr/mxprobe`, then `/plugin install mxprobe@mxprobe`. Neither file
carries a `version`: Claude Code falls back to the git tag, which keeps the
plugin out of the version-bump list. `claude plugin validate ./plugins/mxprobe`
checks the manifest (it warns about the missing version; that is the choice
above). Test the marketplace itself with `claude plugin marketplace add ./`,
then `claude plugin marketplace remove mxprobe`.

`site/icon-400.png` is the square logo the directories ask for (Cline wants
400x400 PNG); `deploy/icon.html` is its source and holds the Chromium command,
like `og.html`.

One-click install links in both READMEs (Cursor, VS Code, LM Studio) carry the
same stdio config in the query string: base64 for Cursor and LM Studio,
URL-encoded JSON for VS Code, of
`{"command":"npx","args":["-y","mxprobe","mcp"]}`. Rebuild them only if the
command changes.

Submitted 2026-09-22:

- Cline MCP Marketplace: issue cline/mcp-marketplace#2609 (repo URL, the 400x400
  logo, the two test checkboxes). Their agent installs from `llms-install.md`
  in the repo root, which is why that file exists.
- mcpservers.org: the free form (category Marketing, contact
  hello@mxprobe.dev, registry name `dev.mxprobe/mxprobe`). "Review within 2
  weeks". That site is also how the wong2 list takes entries: it accepts no PRs.
- LobeHub: `packages/cli/lhm.plugin.json` is the manifest, made by `npx -y
  @lobehub/market-cli plugin init --stdio "npx -y mxprobe mcp" --dir
  packages/cli` and then edited (display name, icon). Publish with `lhm login`,
  `lhm github connect` (both need a browser) and `lhm plugin publish
  https://github.com/andrewchmr/mxprobe --dir packages/cli`. Its `version`
  field is a publish-time field: bump it only for a new LobeHub release.
- Cursor Directory (cursor.directory/plugins/new) needs a GitHub or Google
  sign-in first.

Dead end: `appcypher/awesome-mcp-servers` is archived (2026-08-01) and takes no
PRs. `modelcontextprotocol/servers` retired its third-party list in favour of
the MCP Registry, where we already are.

GitHub topics set on the repo:
`email-verification`, `email-validation`, `mcp-server`, `ai-agents`, `smtp`.
