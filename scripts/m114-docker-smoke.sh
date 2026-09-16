#!/usr/bin/env bash
# Single-stack docker-smoke. SUPERSEDED for multi-instance use by
# `scripts/m092-local-multi-instance-smoke.sh` (M092). Kept as a single-stack
# regression guard.
#
# M114 docker smoke. Run by hand on a laptop. SAFE against a running dev stack —
# every operation is scoped to compose project `nautilo-deploy`; dev's project
# `nautilo` is not touched.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
TEMPLATE_DIR="$REPO_ROOT/deploy/compose-driver/templates"

cd "$TEMPLATE_DIR"

# ─── M118 cache-budget verifications ─────────────────────────────────────────
# When invoked with one of the M118 verifier subcommands, this script
# measures the cache-warm cost of `docker build` for the Nautilo
# Dockerfile and asserts the wall-clock falls within the M118 budget.
# These are guard rails for ISSUE-M118; only run them when the
# Dockerfile or .dockerignore change.
#
# Usage:
#   bash scripts/m114-docker-smoke.sh verify-cache-warm           # no edit, <10 s
#   bash scripts/m114-docker-smoke.sh verify-cache-source-only    # touch apps/cli/src/index.ts, <90 s
#   bash scripts/m114-docker-smoke.sh verify-cache-workbench-edit # touch apps/workbench/src/main.tsx, <180 s
#
# The verifiers assume the cold build has already been done (warm
# caches present locally). If they are run without a prior cold build
# they will fail the threshold — that is expected; rerun once warm.
m118_verifier_run_build() {
  local tag="$1"
  local context_root="$2"
  local source_sha
  if [ -n "$(git -C "$context_root" status --porcelain=v1 --untracked-files=normal)" ]; then
    echo "[smoke] REFUSING — cache verifier source image requires a clean checkout." >&2
    exit 1
  fi
  source_sha=$(git -C "$context_root" rev-parse HEAD)
  # shellcheck disable=SC2086
  DOCKER_BUILDKIT=1 docker build \
    -f "$context_root/packaging/docker/Dockerfile" \
    --build-arg "NAUTILO_SOURCE_SHA=$source_sha" \
    -t "$tag" \
    "$context_root" > /tmp/m118-build.log 2>&1
}

m118_verifier_main() {
  local verb="$1"
  local repo_root
  repo_root=$(git rev-parse --show-toplevel)
  case "$verb" in
    verify-cache-warm)
      local threshold=10
      local label="no-op rebuild"
      local pre_action=":"
      ;;
    verify-cache-source-only)
      local threshold=90
      local label="source-only edit (apps/cli)"
      local pre_action="touch '$repo_root/apps/cli/src/index.ts'"
      ;;
    verify-cache-workbench-edit)
      local threshold=180
      local label="workbench source edit"
      local pre_action="touch '$repo_root/apps/workbench/src/main.tsx'"
      ;;
    *)
      echo "[smoke] unknown verifier: $verb" >&2
      exit 1
      ;;
  esac
  # Cold-ish baseline (uses whatever caches the host already has).
  echo "[smoke/$verb] priming build (uses any pre-existing layer cache)…"
  m118_verifier_run_build "nautilo-m118:$verb-pre" "$repo_root"
  echo "[smoke/$verb] applying pre-action: $label"
  eval "$pre_action"
  echo "[smoke/$verb] measuring rebuild wall-clock (threshold ${threshold}s)…"
  local t0
  t0=$(date +%s)
  m118_verifier_run_build "nautilo-m118:$verb-post" "$repo_root"
  local t1
  t1=$(date +%s)
  local elapsed=$(( t1 - t0 ))
  if [ "$elapsed" -le "$threshold" ]; then
    echo "[smoke/$verb] PASS — rebuild took ${elapsed}s (≤ ${threshold}s)."
    exit 0
  else
    echo "[smoke/$verb] FAIL — rebuild took ${elapsed}s (> ${threshold}s)."
    echo "[smoke/$verb] Last build log: /tmp/m118-build.log"
    exit 4
  fi
}

case "${1:-}" in
  verify-cache-warm|verify-cache-source-only|verify-cache-workbench-edit)
    m118_verifier_main "$1"
    ;;
esac

# 0. Sanity: .env exists.
if [ ! -f .env ]; then
  echo "[smoke] .env not found in $TEMPLATE_DIR."
  echo "[smoke] Copy .env.local-smoke.example to .env first (not .env.example — that is D120 cloud)."
  exit 1
fi

# 0b. Refuse to run if .env's project name doesn't match the M114 contract.
if ! grep -E "^COMPOSE_PROJECT_NAME=nautilo-deploy" .env > /dev/null; then
  echo "[smoke] REFUSING — .env must set COMPOSE_PROJECT_NAME=nautilo-deploy."
  echo "[smoke] (M114 isolation guarantee — running under a different project name"
  echo "[smoke]  risks touching dev volumes.)"
  exit 1
fi

# Source images carry an auditable Git revision. Refuse dirty bytes instead of
# labeling them with HEAD; developer dirty-tree testing belongs in dev-stack.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=normal)" ]; then
  echo "[smoke] REFUSING — source image builds require a clean checkout." >&2
  exit 1
fi
export NAUTILO_SOURCE_SHA
NAUTILO_SOURCE_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
SOURCE_OVERLAY="$TEMPLATE_DIR/docker-compose.source.yml"

# 1. Clean slate (only the nautilo-deploy project).
echo "[smoke] tearing down any previous deploy stack…"
docker compose -f docker-compose.yml -f "$SOURCE_OVERLAY" --profile auth --profile app down -v || true

# 2. Bring up the full deploy stack.
echo "[smoke] bringing up postgres + logto + logto-seed + nautilo-server…"
docker compose -f docker-compose.yml -f "$SOURCE_OVERLAY" --profile auth --profile app up -d --build

# 3. Wait for /health (max 120 s — first boot runs migrations).
# Server serves TLS with a self-signed cert (LAN-host branch of
# @nautilo/config); `curl -k` skips cert validation.
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -sf http://localhost:4001/health > /tmp/m114-health.json; then
    echo "[smoke] /health responded:"
    cat /tmp/m114-health.json
    break
  fi
  sleep 2
done

if ! curl -sf http://localhost:4001/health > /dev/null; then
  echo "[smoke] /health never came up. Dumping nautilo-server logs:"
  docker compose logs nautilo-server
  exit 2
fi

# 4. Verify shape (status + logtoEndpoint key present, even if blank).
node --eval '
  const j = require("fs").readFileSync("/tmp/m114-health.json","utf8");
  const h = JSON.parse(j);
  for (const k of ["status","logtoEndpoint"]) if (!(k in h)) { console.error("missing key", k); process.exit(3); }
  console.log("[smoke] /health shape OK");
'

# 5. Tear down (only the nautilo-deploy project).
echo "[smoke] success. Tearing down…"
docker compose --profile auth --profile app down -v
echo "[smoke] done."
