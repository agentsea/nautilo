#!/usr/bin/env bash
#
# install.sh — deploy the db-migration-safety bundle.
#
# Thin wrapper. All discovery / dedup / stamp-and-copy logic lives in
# dev/tools/_lib/deploy.sh.
#
# What this bundle ships (cursor-only):
#   cursor/skills/drizzle-migration-safety/SKILL.md  -> <dst>/.cursor/skills/...
#   cursor/hooks.json                                -> <dst>/.cursor/hooks.json
#   cursor/hooks/guard-drizzle.sh                    -> <dst>/.cursor/hooks/...
#
# NOT deployed (called in-repo by lefthook):
#   guard-staged-migrations.sh   (pre-commit guard; lefthook.yml references it)
#
# Edit the canonicals here, then run install.sh (or dev/tools/install-all.sh)
# to propagate to the containing .cursor/ workspace root.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../_lib/deploy.sh"
deploy_bundle "$HERE" "db-migration-safety"
