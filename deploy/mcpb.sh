#!/usr/bin/env bash
# Build the MCPB bundle for Smithery from the npm package, then publish it:
#   deploy/mcpb.sh 0.2.4            -> /tmp/mxprobe-0.2.4.mcpb
#   npx -y @smithery/cli mcp publish /tmp/mxprobe-0.2.4.mcpb -n andrzej-chem/mxprobe
# The bundle is a zip with manifest.json at the root plus node_modules. We zip
# it by hand because `mcpb pack` rejects the tools[].inputSchema fields that
# Smithery needs (its API returns "expected object, received undefined" per
# tool without them). `smithery auth login` first (browser approval).
set -euo pipefail
VERSION="${1:?usage: deploy/mcpb.sh <npm version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
OUT="${2:-/tmp/mxprobe-$VERSION.mcpb}"
cd "$WORK"
npm init -y >/dev/null
npm install --omit=dev --no-audit --no-fund "mxprobe@$VERSION" >/dev/null
sed "s/\"VERSION\"/\"$VERSION\"/" "$ROOT/packages/cli/mcpb/manifest.json" > manifest.json
rm -f "$OUT"
zip -qr "$OUT" manifest.json node_modules -x 'node_modules/.package-lock.json'
echo "$OUT"
