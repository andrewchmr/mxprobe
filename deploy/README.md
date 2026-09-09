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
