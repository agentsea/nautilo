#!/usr/bin/env bash
#
# install-all.sh — omnibus runner: invokes every dev/tools/<bundle>/install.sh.
#
# Discovery is automatic. Adding a new bundle = creating a new
# dev/tools/<bundle>/install.sh; no edits here required.
#
# Usage:
#   bash dev/tools/install-all.sh                  # all bundles
#   bash dev/tools/install-all.sh phase-end        # just one
#   bash dev/tools/install-all.sh phase-end dispatch-coders
#   NAUTILO_DEPLOY_DRY_RUN=1 bash dev/tools/install-all.sh   # show what would happen
#   NAUTILO_DEPLOY_PRUNE=1 bash dev/tools/install-all.sh    # deploy + remove stale copies
#
# Env vars consumed (passed through to each bundle):
#   NAUTILO_EXTRA_CLAUDE_DIRS  — colon-separated extra .claude destinations
#   NAUTILO_EXTRA_CURSOR_DIRS  — colon-separated extra .cursor destinations
#   NAUTILO_CODEX_HOME         — Codex home to receive prompts (default: $CODEX_HOME or ~/.codex)
#   NAUTILO_EXTRA_CODEX_HOMES  — colon-separated extra Codex homes
#   NAUTILO_DEPLOY_DRY_RUN     — "1" to skip writes
#   NAUTILO_DEPLOY_PRUNE       — "1" to remove deployed command copies with no bundle
#                                canonical (full install-all only; ignored when filtering
#                                to specific bundles)
#
# Skipped:
#   - Any directory in dev/tools/ that doesn't contain an install.sh
#     (e.g. nautilo-db, electron-debug — those are MCP servers, not
#     command bundles, and have a different install path).
#   - Anything starting with "_" (e.g. _lib).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

declare -a only=("$@")

want_bundle() {
  local b="$1"
  [ "${#only[@]}" -eq 0 ] && return 0
  local x
  for x in "${only[@]}"; do
    [ "$x" = "$b" ] && return 0
  done
  return 1
}

found=0
ran=0
for inst in "$HERE"/*/install.sh; do
  [ -e "$inst" ] || continue
  bundle_dir="$(dirname "$inst")"
  bundle="$(basename "$bundle_dir")"
  case "$bundle" in
    _*) continue ;;
  esac
  found=$((found + 1))
  if ! want_bundle "$bundle"; then
    continue
  fi
  printf '\n##### bundle: %s #####\n' "$bundle"
  bash "$inst"
  ran=$((ran + 1))
done

if [ "$found" = "0" ]; then
  printf 'install-all: no bundles found under %s/*/install.sh\n' "$HERE" >&2
  exit 1
fi

if [ "${#only[@]}" -gt 0 ] && [ "$ran" = "0" ]; then
  printf 'install-all: no bundles matched filter:' >&2
  printf ' %s' "${only[@]}" >&2
  printf '\n' >&2
  exit 1
fi

printf '\n##### install-all: ran %d/%d bundle(s) #####\n' "$ran" "$found"

if [ "${NAUTILO_DEPLOY_PRUNE:-0}" = "1" ] && [ "${#only[@]}" -eq 0 ]; then
  . "$HERE/_lib/deploy.sh"
  deploy_prune_stale_commands "$HERE"
fi
