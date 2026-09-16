#!/usr/bin/env bash
# Ensure Turbo's exact pull-request comparison commit exists after a bounded
# actions/checkout fetch. Never substitute a moving branch tip or HEAD parent.
set -euo pipefail

base_sha="${1:-}"
if [[ ! "${base_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: expected an exact 40-character lowercase base commit SHA" >&2
  exit 2
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "${base_sha}"
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "ERROR: exact pull-request base commit is unavailable: ${base_sha}" >&2
  exit 1
fi
