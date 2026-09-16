#!/usr/bin/env bash
# Test isolation contract — see packages/server/scripts/run-unit.sh.
#
#   tests/unit/          → ONE shared bun process. `mock.module` is BANNED here.
#   tests/unit-isolated/ → each file runs in its OWN bun process.
set -euo pipefail

TIMEOUT="${BUN_TEST_TIMEOUT_MS:-10000}"
DURABLE_JOURNAL_TIMEOUT="${BUN_DURABLE_JOURNAL_TEST_TIMEOUT_MS:-30000}"
DURABLE_JOURNAL_FILE="tests/unit/d448-local-file-history-v2.test.ts"

UNIT_FILES=()
while IFS= read -r -d '' f; do
  UNIT_FILES+=("$f")
done < <(
  find tests/unit -name '*.test.ts' ! -path "$DURABLE_JOURNAL_FILE" -print0 \
    | LC_ALL=C sort -z
)
bun test --timeout "$TIMEOUT" "${UNIT_FILES[@]}"

# This deterministic real-filesystem stress suite composes atomic storage,
# restart recovery, retention, and 51 durable mutation records. Run it in an
# isolated process so CI package concurrency cannot consume its ordinary
# 10-second per-test budget; it remains unit coverage with a bounded ceiling.
bun test --timeout "$DURABLE_JOURNAL_TIMEOUT" "$DURABLE_JOURNAL_FILE"

while IFS= read -r -d '' f; do
  bun test --timeout "$TIMEOUT" "$f"
done < <(find tests/unit-isolated -name '*.test.ts' -print0 | LC_ALL=C sort -z)
