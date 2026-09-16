#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../_lib/deploy.sh"
deploy_bundle "$HERE" "limit-preflight"
