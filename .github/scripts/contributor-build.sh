#!/usr/bin/env bash
# Called only inside the workflow's fresh, credential-free build container.
set -euo pipefail

test ! -d node_modules
test "$(id -u)" -ne 0
test ! -d "$HOME/.bun/install/cache"
test ! -d .turbo
test ! -e /var/run/docker.sock
test -z "${GITHUB_TOKEN:-}${GH_TOKEN:-}${TURBO_TOKEN:-}${SOCKET_SECURITY_API_KEY:-}${NPM_TOKEN:-}"
git init --quiet
# Lefthook's ordinary postinstall needs a Git repository, not upstream history.
git add --force .
git -c user.name='Contributor build' -c user.email="fixture@example.invalid" \
  commit --quiet -m 'Frozen contributor source'
export CI=true
export TURBO_TELEMETRY_DISABLED=1
export TURBO_CACHE=local:rw
# Typecheck serially with a 6 GiB heap on the 16 GiB hosted build runner.
export TURBO_CONCURRENCY=1
export NODE_OPTIONS="--use-openssl-ca --max-old-space-size=6144"
test -r "$SSL_CERT_FILE"
test -d "$SSL_CERT_DIR"
test -z "$(find "$SSL_CERT_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
# This fresh user config also protects installs started by first-party postinstall.
( set -o noclobber; printf '[install]\ncafile = "%s"\n' "$SSL_CERT_FILE" > "$HOME/.bunfig.toml" )

uname -sm
node --version
bun --version
free -m
df -h .
sha256sum bun.lock > /tmp/contributor-lock.sha256
bun install --frozen-lockfile --cafile="$SSL_CERT_FILE"
sha256sum --check /tmp/contributor-lock.sha256
bun run test:invariants
bun x turbo run build --filter=@nautilo/workbench... --filter=@nautilo/cli...
bun x turbo run test:integration --filter=@nautilo/office-sheets
bun run --cwd packages/server typecheck
find apps/workbench/dist apps/cli/dist -type f -print0 | sort -z | xargs -0 sha256sum
