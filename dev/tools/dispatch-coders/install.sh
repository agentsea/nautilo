#!/usr/bin/env bash
#
# install.sh — deploy the dispatch-coders bundle.
#
# Thin wrapper. All discovery / dedup / stamp-and-copy logic lives in
# dev/tools/_lib/deploy.sh.
#
# Bundle sources of truth (single file each; cursor/ entries are symlinks):
#   dev/tools/dispatch-coders/claude/commands/fb/dispatch-coders.md
#   dev/tools/dispatch-coders/claude/commands/fb/subagent-rules.md
#
# Edit those files. Run install.sh (or dev/tools/install-all.sh) to
# propagate to every .claude/ destination + the containing workspace .cursor/.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../_lib/deploy.sh"
deploy_bundle "$HERE" "dispatch-coders"
