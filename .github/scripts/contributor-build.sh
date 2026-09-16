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
git -c user.name='Contributor build' -c user.email='build@localhost.invalid' \
  commit --quiet -m 'Frozen contributor source'
export CI=true
export TURBO_TELEMETRY_DISABLED=1
export TURBO_CACHE=local:rw
# One existing 5 GiB compiler heap fits the hosted runner's 8 GiB floor.
export TURBO_CONCURRENCY=1
export NODE_OPTIONS=--max-old-space-size=5120

uname -sm
node --version
bun --version
free -m
df -h .
sha256sum bun.lock > /tmp/contributor-lock.sha256
bun install --frozen-lockfile
sha256sum --check /tmp/contributor-lock.sha256
bun run test:invariants
bun x turbo run build --filter=@nautilo/workbench... --filter=@nautilo/cli...
bun run --cwd packages/server typecheck
find apps/workbench/dist apps/cli/dist -type f -print0 | sort -z | xargs -0 sha256sum
