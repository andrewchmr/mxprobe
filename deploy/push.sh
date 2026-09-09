#!/usr/bin/env bash
# Deploy from this checkout to the VPS over SSH, no GitHub needed.
#   deploy/push.sh ubuntu@145.239.86.59
# Syncs the tree to /opt/mxprobe (no node_modules, no .git, no data), installs
# the env file from server/.env.production when it exists, then runs
# deploy/install.sh as root, which installs Caddy + Node on first run and
# restarts the service on every run.
set -euo pipefail
HOST="${1:?usage: deploy/push.sh user@host}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -o StrictHostKeyChecking=accept-new $HOST"

echo "== sync $ROOT -> $HOST:/opt/mxprobe"
# install.sh hands the tree to the mxprobe user; take it back for the sync.
$SSH 'sudo mkdir -p /opt/mxprobe /etc/mxprobe && sudo chown -R "$USER" /opt/mxprobe'
rsync -az --delete \
  --include '.env.example' --exclude '.env' --exclude '.env.*' \
  --exclude node_modules --exclude .git --exclude 'server/data' --exclude '.claude' --exclude '*.sqlite*' \
  --exclude dist --exclude '*.tsbuildinfo' \
  "$ROOT/" "$HOST:/opt/mxprobe/"

if [ -f "$ROOT/server/.env.production" ]; then
  echo "== env file"
  scp -q "$ROOT/server/.env.production" "$HOST:/tmp/mxprobe.env"
  $SSH 'sudo install -m 600 -o root -g root /tmp/mxprobe.env /etc/mxprobe/env && rm /tmp/mxprobe.env'
fi

echo "== install"
$SSH 'sudo MXPROBE_LOCAL=1 bash /opt/mxprobe/deploy/install.sh'
