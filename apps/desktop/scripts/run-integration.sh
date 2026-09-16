#!/usr/bin/env bash
# Integration tests use Electron mocks and real subprocesses; one Bun process
# per file prevents module and process state from leaking between scenarios.
set -euo pipefail

TIMEOUT="${BUN_INTEGRATION_TEST_TIMEOUT_MS:-60000}"

while IFS= read -r -d '' f; do
  bun test --timeout "$TIMEOUT" "$f"
done < <(find tests/integration -name '*.test.ts' -print0 | LC_ALL=C sort -z)
