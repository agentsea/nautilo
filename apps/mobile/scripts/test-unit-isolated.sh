#!/usr/bin/env bash
set -euo pipefail

# Bun's module mocks are process-global. Mobile tests intentionally mock native
# and auth modules with different export surfaces, so combining every file in
# one Bun process makes later files observe an earlier file's partial mock.
# Run each file in a fresh process and keep Turbo's package gate authoritative.
test_count=0
while IFS= read -r test_file; do
  test_count=$((test_count + 1))
  bun test "$test_file" --timeout 30000
done < <(find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | LC_ALL=C sort)

if [[ "$test_count" -eq 0 ]]; then
  echo "ERROR: no Mobile unit tests discovered" >&2
  exit 1
fi

echo "Mobile unit files passed: $test_count"
