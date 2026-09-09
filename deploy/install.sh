#!/usr/bin/env bash
# One-shot install on a fresh Ubuntu 24.04 VPS with port 25 open. Run as root.
#   curl -fsSL https://raw.githubusercontent.com/andrewchmr/mxprobe/main/deploy/install.sh | bash
# Re-running it updates the checkout and restarts the service.
# Without GitHub: deploy/push.sh user@host rsyncs this tree and runs it with MXPROBE_LOCAL=1.
set -euo pipefail

REPO="${MXPROBE_REPO:-https://github.com/andrewchmr/mxprobe.git}"
BRANCH="${MXPROBE_BRANCH:-main}"
APP=/opt/mxprobe
DATA=/var/lib/mxprobe
ENV_FILE=/etc/mxprobe/env

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null

if ! command -v caddy >/dev/null; then
  echo "== caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "== node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm i -g corepack >/dev/null
corepack prepare pnpm@9.11.0 --activate >/dev/null

id -u mxprobe >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin mxprobe
mkdir -p "$DATA" /etc/mxprobe
chown mxprobe:mxprobe "$DATA"

echo "== code"
if [ "${MXPROBE_LOCAL:-}" = "1" ] && [ -f "$APP/package.json" ]; then
  echo "using the tree synced by deploy/push.sh"
elif [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
# Dev dependencies stay: the TypeScript build runs here, on every deploy.
# CI=1 answers pnpm's "reinstall from scratch?" prompt (the first deploy was
# --prod); NODE_ENV=development keeps devDependencies whatever the shell says.
CI=1 NODE_ENV=development pnpm install --frozen-lockfile --reporter=append-only
test -x node_modules/.bin/tsc || { echo "!! typescript did not install; no build possible"; exit 1; }
pnpm build
chown -R mxprobe:mxprobe "$APP"

if [ ! -f "$ENV_FILE" ]; then
  cp server/.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "!! wrote $ENV_FILE from the example. Fill in Stripe, Resend and Telegram, then: systemctl restart mxprobe-api"
fi

echo "== services"
cp deploy/mxprobe-api.service deploy/mxprobe-health.service deploy/mxprobe-health.timer /etc/systemd/system/
cp deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable -q --now mxprobe-api mxprobe-health.timer
systemctl restart mxprobe-api
systemctl reload caddy || systemctl restart caddy

echo "== checks"
sleep 1
curl -fsS http://127.0.0.1:8787/v1/health && echo
echo -n "port 25 to Google: "; (nc -z -w 5 aspmx.l.google.com 25 && echo open) || echo "BLOCKED (ask the provider)"
echo -n "reverse DNS of this box: "; dig +short -x "$(curl -fsS https://api.ipify.org)" || true
echo "done. Logs: journalctl -u mxprobe-api -f"
