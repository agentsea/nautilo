#!/usr/bin/env bash
# Compatibility entrypoint for callers which still invoke this script directly.
exec bun "$(dirname "$0")/run-unit.ts"
