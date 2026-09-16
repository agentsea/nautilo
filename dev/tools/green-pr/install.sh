#!/usr/bin/env bash
#
# install.sh — deploy the green-pr bundle.
#
# Thin wrapper. All discovery / dedup / stamp-and-copy logic lives in
# dev/tools/_lib/deploy.sh.
#
# Bundle source of truth (single file; cursor/ entry is a symlink):
#   dev/tools/green-pr/claude/commands/fb/green-pr.md
#
# Edit that file. Run install.sh (or dev/tools/install-all.sh) to
# propagate to every .claude/ destination + the containing workspace .cursor/.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../_lib/deploy.sh"
deploy_bundle "$HERE" "green-pr"
