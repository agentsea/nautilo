#!/usr/bin/env bash
# Runtime unit tests share one Bun process unless they use mock.module.
# Bun module mocks are process-global and sticky, so every mock-heavy file
# runs in its own process to prevent cross-file production-module pollution.
set -euo pipefail

TIMEOUT="${BUN_TEST_TIMEOUT_MS:-15000}"

UNIT_FILES=()
while IFS= read -r -d '' f; do
  UNIT_FILES+=("$f")
done < <(find tests/unit -name '*.test.ts' -print0 | LC_ALL=C sort -z)
bun test --timeout "$TIMEOUT" "${UNIT_FILES[@]}"

while IFS= read -r -d '' f; do
  bun test --timeout "$TIMEOUT" "$f"
done < <(find tests/unit-isolated -name '*.test.ts' -print0 | LC_ALL=C sort -z)
