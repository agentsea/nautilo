#!/usr/bin/env bash
set +e

# Run each integration test file in its own bun subprocess so cross-file
# process state leakage (Fastify app instances, DB bootstrap globals,
# stub registries, env mutations) can't cascade between files.
# Adds ~10s wall time vs batched-per-dir but eliminates pollution-mode
# flake, including files with process-global mock.module calls.

OVERALL=0
SUITE_DIR="${1:-tests/integration}"

if [[ ! -d "$SUITE_DIR" ]]; then
  echo "Integration suite directory does not exist: $SUITE_DIR" >&2
  exit 2
fi

run_file () {
  local file="$1"
  echo "=== $file ==="
  bun test --timeout 120000 --max-concurrency=1 "$file"
  local rc=$?
  if [ $rc -ne 0 ]; then
    OVERALL=1
  fi
}

# Use find with -print0 / read -d for safety; sort for deterministic order.
while IFS= read -r -d '' f; do
  run_file "$f"
done < <(find "$SUITE_DIR" -maxdepth 2 -type f -name "*.test.ts" -print0 | sort -z)

exit $OVERALL
