#!/usr/bin/env bash
# Reproduce the pull-request CI verdict locally before pushing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export TURBO_SCM_BASE="${TURBO_SCM_BASE:-origin/main}"
export TURBO_SCM_HEAD="${TURBO_SCM_HEAD:-HEAD}"

if [[ "${CI_LOCAL_SKIP_FETCH:-0}" != "1" ]]; then
  echo "=== ci:local fetch ==="
  git fetch origin main
fi

if [[ "${CI_LOCAL_SKIP_INSTALL:-0}" != "1" ]]; then
  echo "=== ci:local install ==="
  bun install --frozen-lockfile --ignore-scripts
fi

cat <<EOF
=== ci:local configuration ===
TURBO_SCM_BASE=$TURBO_SCM_BASE
TURBO_SCM_HEAD=$TURBO_SCM_HEAD

Override with:
  TURBO_SCM_BASE=<ref> TURBO_SCM_HEAD=<ref> bun run ci:local
Skip fetch with:
  CI_LOCAL_SKIP_FETCH=1 bun run ci:local
Skip install with:
  CI_LOCAL_SKIP_INSTALL=1 bun run ci:local
EOF

bash dev/scripts/ci-gates.sh all
