#!/usr/bin/env bash
# Unit runner for @nautilo/cli. Mirrors apps/desktop/scripts/run-unit.sh.
set -euo pipefail

TIMEOUT="${BUN_TEST_TIMEOUT_MS:-5000}"

# Real Windows ACL operations start native helpers for every private path a
# test touches. Keep the runner budget consistent with the Desktop runner
# without changing product deadlines.
if [[ "${OS:-}" == "Windows_NT" ]]; then
  TIMEOUT="${BUN_TEST_TIMEOUT_MS:-60000}"
fi

bun run build
bun test --max-concurrency=1 --timeout "$TIMEOUT" tests/unit tests/lint
