#!/usr/bin/env bash
# Keep shell expansion inside Bash: Windows Lefthook does not reliably execute
# inline environment assignments or quoted multiline commands.
set -euo pipefail

gate="${1:-}"
case "$gate" in
  install-check)
    if [ ! -d node_modules ] || [ ! -e node_modules/.bin ] || [ bun.lock -nt node_modules/.bin ]; then
      echo "[pre-push] restoring the frozen dependency graph..."
      bun install --frozen-lockfile
    fi
    ;;
  lint-eslint|typecheck|unit)
    export TURBO_SCM_BASE="${TURBO_SCM_BASE:-$(git merge-base origin/main HEAD)}"
    export TURBO_SCM_HEAD="${TURBO_SCM_HEAD:-HEAD}"
    if [ "$gate" = unit ]; then
      export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-4}"
      case "$(uname -s)" in
        MINGW*|MSYS*)
          bun dev/scripts/windows-unit-gate.ts
          exit "$?"
          ;;
      esac
    fi
    bash dev/scripts/ci-gates.sh "$gate"
    ;;
  *)
    echo "ERROR: unsupported pre-push gate: $gate" >&2
    exit 2
    ;;
esac
