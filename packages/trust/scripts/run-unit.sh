#!/usr/bin/env bash
# tests/unit-isolated/ files use mock.module (process-global, sticky in Bun);
# each must run in its OWN bun test process. Wrapped in a shell script so knip's
# script parser does not trip on chained bun test <file> paths (ENOTDIR).
set -euo pipefail
TIMEOUT="${BUN_TEST_TIMEOUT_MS:-15000}"
# Shared process — deterministic order across macOS and Linux so a local run
# reproduces CI byte-for-byte (Bun's bare-directory walk is OS-order dependent).
# mock.module is BANNED here; tests/unit/mock-module-isolation-guard.test.ts
# enforces it. Array built via read loop for bash 3.2 (macOS) compatibility.
UNIT_FILES=()
while IFS= read -r -d '' f; do
  UNIT_FILES+=("$f")
done < <(find tests/unit -name '*.test.ts' -print0 | LC_ALL=C sort -z)
bun test --timeout "$TIMEOUT" "${UNIT_FILES[@]}"

while IFS= read -r -d '' f; do
  bun test --timeout "$TIMEOUT" "$f"
done < <(find tests/unit-isolated -name '*.test.ts' -print0 | LC_ALL=C sort -z)
