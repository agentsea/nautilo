#!/usr/bin/env bash
set -euo pipefail
bun test --timeout 60000 tests/integration/
