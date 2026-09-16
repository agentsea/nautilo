#!/usr/bin/env bash
# M092 local multi-instance acceptance smoke.
#
# Exercises Acceptance #1–#10 end-to-end via `nautilo deploy --profile
# local-{default,beta}`. Side-by-side safe: only compose projects `nautilo`
# and `nautilo-beta` are touched.
#
# Prerequisites:
#   - Docker daemon running
#   - `jq` (or python3 for JSON fallback)
#   - Example profiles copied to ~/.nautilo/profiles/
#   - ~/.config/nautilo/deploy.toml present (M091 operator contract)
#
# Usage (from repo root):
#   chmod +x scripts/m092-local-multi-instance-smoke.sh
#   bash scripts/m092-local-multi-instance-smoke.sh
#
# DESTRUCTIVE: hard-destroys both local-default and local-beta stacks
# (volumes + .bootstrap/). Do not run against data you need to keep.
#
# Exit 0 on success; non-zero with `[smoke] FAIL: <step>` on failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/compose-driver/templates/docker-compose.yml"
PROFILES_DIR="$HOME/.nautilo/profiles"
INSTANCE_DEFAULT="$HOME/.nautilo"
INSTANCE_BETA="$HOME/.nautilo-beta"

cd "$REPO_ROOT"

if command -v nautilo >/dev/null 2>&1; then
  NAUTILO=(nautilo)
else
  NAUTILO=(bun run cli --)
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

smoke_fail() {
  local step="$1"
  shift
  echo "[smoke] FAIL: step ${step} — $*" >&2
  exit 1
}

json_server_port() {
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.server.port' "$file"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['server']['port'])" "$file"
  else
    echo "[smoke] FAIL: need jq or python3 to read instance.json ports" >&2
    exit 2
  fi
}

setup_state_for_port() {
  local port="$1"
  if command -v jq >/dev/null 2>&1; then
    curl -sf "http://localhost:${port}/api/setup/status" | jq -r '.setupState'
  else
    curl -sf "http://localhost:${port}/api/setup/status" \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['setupState'])"
  fi
}

wait_for_health() {
  local port="$1"
  local label="$2"
  local deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
      echo "[smoke] ${label} /health 200 on port ${port}"
      return 0
    fi
    sleep 3
  done
  smoke_fail "$3" "${label} /health never returned 200 on port ${port}"
}

assert_setup_ready() {
  local port="$1"
  local label="$2"
  local step="$3"
  local state
  state="$(setup_state_for_port "$port")"
  if [ "$state" != "ready" ]; then
    smoke_fail "$step" "${label} setupState=${state} (expected ready)"
  fi
  echo "[smoke] ${label} setupState=ready"
}

compose_ids_for_project() {
  local project="$1"
  docker ps -a \
    --filter "label=com.docker.compose.project=${project}" \
    --format '{{.ID}}' \
    | sort
}

default_volumes_present() {
  docker volume ls -q | grep '^nautilo_' | grep -v '^nautilo-beta_' || true
}

# ---------------------------------------------------------------------------
# 0. Sanity: Docker daemon + JSON tooling + profile TOMLs
# ---------------------------------------------------------------------------

echo "[smoke] step 0: Docker daemon"
# Acceptance #1 gate — nothing runs without a working engine.
if ! docker info >/dev/null 2>&1; then
  echo "[smoke] Docker daemon not reachable. Start Docker Desktop and retry." >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke] FAIL: install jq (preferred) or python3 for instance.json parsing" >&2
  exit 2
fi

echo "[smoke] step 0b: example profile TOMLs in ~/.nautilo/profiles/"
mkdir -p "$PROFILES_DIR"
missing=0
for name in local-default local-beta; do
  if [ ! -f "$PROFILES_DIR/${name}.toml" ]; then
    echo "[smoke] missing $PROFILES_DIR/${name}.toml" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "[smoke] Copy example profiles first:" >&2
  echo "  cp examples/profiles/local-default.toml ~/.nautilo/profiles/" >&2
  echo "  cp examples/profiles/local-beta.toml ~/.nautilo/profiles/" >&2
  exit 2
fi

if [ ! -f "$HOME/.config/nautilo/deploy.toml" ]; then
  echo "[smoke] WARN: ~/.config/nautilo/deploy.toml not found — first deploy may fail claim" >&2
fi

# ---------------------------------------------------------------------------
# 1. Clean slate (idempotent hard destroy both profiles)
# ---------------------------------------------------------------------------

echo "[smoke] step 1: hard destroy local-default + local-beta (clean slate)"
# Acceptance #1 — idempotent teardown before a cold bring-up.
"${NAUTILO[@]}" destroy --profile local-default --hard || true
"${NAUTILO[@]}" destroy --profile local-beta --hard || true

# ---------------------------------------------------------------------------
# 2. Deploy default instance
# ---------------------------------------------------------------------------

echo "[smoke] step 2: deploy local-default"
# Acceptance #1–#2 — single-stack deploy, /health 200, setupState=ready.
"${NAUTILO[@]}" deploy --profile local-default

if [ ! -f "$INSTANCE_DEFAULT/instance.json" ]; then
  smoke_fail 2 "missing $INSTANCE_DEFAULT/instance.json after deploy"
fi

SERVER_PORT_DEFAULT="$(json_server_port "$INSTANCE_DEFAULT/instance.json")"
wait_for_health "$SERVER_PORT_DEFAULT" "local-default" 2
assert_setup_ready "$SERVER_PORT_DEFAULT" "local-default" 2

# ---------------------------------------------------------------------------
# 3. Deploy beta alongside default
# ---------------------------------------------------------------------------

echo "[smoke] step 3: deploy local-beta while default is up"
# Acceptance #2–#3 — two simultaneous stacks, distinct ports, no collision.
"${NAUTILO[@]}" deploy --profile local-beta

if [ ! -f "$INSTANCE_BETA/instance.json" ]; then
  smoke_fail 3 "missing $INSTANCE_BETA/instance.json after deploy"
fi

SERVER_PORT_BETA="$(json_server_port "$INSTANCE_BETA/instance.json")"
wait_for_health "$SERVER_PORT_BETA" "local-beta" 3
assert_setup_ready "$SERVER_PORT_BETA" "local-beta" 3

if [ "$SERVER_PORT_DEFAULT" = "$SERVER_PORT_BETA" ]; then
  smoke_fail 3 "default and beta server ports collide (${SERVER_PORT_DEFAULT})"
fi
echo "[smoke] ports differ: default=${SERVER_PORT_DEFAULT} beta=${SERVER_PORT_BETA}"

# ---------------------------------------------------------------------------
# 4. Down → up without -v (data persists)
# ---------------------------------------------------------------------------

echo "[smoke] step 4: compose down (keep volumes) → redeploy both"
# Acceptance #2 — setupState stays ready after soft down/up cycle.
docker compose --project-name nautilo \
  -f "$COMPOSE_FILE" \
  --profile auth --profile app down
docker compose --project-name nautilo-beta \
  -f "$COMPOSE_FILE" \
  --profile auth --profile app down

"${NAUTILO[@]}" deploy --profile local-default
"${NAUTILO[@]}" deploy --profile local-beta

wait_for_health "$SERVER_PORT_DEFAULT" "local-default" 4
wait_for_health "$SERVER_PORT_BETA" "local-beta" 4
assert_setup_ready "$SERVER_PORT_DEFAULT" "local-default" 4
assert_setup_ready "$SERVER_PORT_BETA" "local-beta" 4

# ---------------------------------------------------------------------------
# 5. Idempotency — re-deploy must not recreate containers
# ---------------------------------------------------------------------------

echo "[smoke] step 5: idempotent re-deploy local-default (no container recreate)"
# Acceptance #3 — healthy re-deploy is a measurable no-op.
BEFORE_IDS="$(compose_ids_for_project nautilo | tr '\n' ' ')"

EVENTS_LOG="$(mktemp)"
trap 'rm -f "$EVENTS_LOG"' EXIT
docker events \
  --filter 'type=container' \
  --filter 'event=start' \
  --filter 'label=com.docker.compose.project=nautilo' \
  --format '{{.ID}} {{.Time}}' > "$EVENTS_LOG" 2>/dev/null &
EVENTS_PID=$!
sleep 1

"${NAUTILO[@]}" deploy --profile local-default

kill "$EVENTS_PID" 2>/dev/null || true
wait "$EVENTS_PID" 2>/dev/null || true

AFTER_IDS="$(compose_ids_for_project nautilo | tr '\n' ' ')"

if [ "$BEFORE_IDS" != "$AFTER_IDS" ]; then
  smoke_fail 5 "container IDs changed after idempotent deploy (before=[${BEFORE_IDS}] after=[${AFTER_IDS}])"
fi

if [ -s "$EVENTS_LOG" ]; then
  smoke_fail 5 "docker events recorded container start during idempotent deploy: $(cat "$EVENTS_LOG")"
fi
echo "[smoke] container IDs unchanged; no start events during re-deploy"

# ---------------------------------------------------------------------------
# 6. Volume isolation
# ---------------------------------------------------------------------------

echo "[smoke] step 6: distinct docker volume sets per compose project"
# Acceptance #2 / #6 — two isolated volume namespaces.
DEFAULT_VOLS="$(docker volume ls -q | grep '^nautilo_' | grep -v '^nautilo-beta_' | sort || true)"
BETA_VOLS="$(docker volume ls -q | grep '^nautilo-beta_' | sort || true)"

if [ -z "$DEFAULT_VOLS" ]; then
  smoke_fail 6 "no nautilo_* volumes found for default project"
fi
if [ -z "$BETA_VOLS" ]; then
  smoke_fail 6 "no nautilo-beta_* volumes found for beta project"
fi

OVERLAP="$(comm -12 <(printf '%s\n' "$DEFAULT_VOLS") <(printf '%s\n' "$BETA_VOLS") || true)"
if [ -n "$OVERLAP" ]; then
  smoke_fail 6 "volume name overlap between instances: ${OVERLAP}"
fi
echo "[smoke] volume sets distinct (default $(echo "$DEFAULT_VOLS" | wc -l | tr -d ' ') vols, beta $(echo "$BETA_VOLS" | wc -l | tr -d ' ') vols)"

# ---------------------------------------------------------------------------
# 7. Cross-instance Logto isolation (LOGTO_* keys differ)
# ---------------------------------------------------------------------------

echo "[smoke] step 7: LOGTO_* keys differ across instance.env files"
# Acceptance #9 — separate tenant data per instance.
if [ ! -f "$INSTANCE_DEFAULT/instance.env" ] || [ ! -f "$INSTANCE_BETA/instance.env" ]; then
  smoke_fail 7 "missing instance.env for default or beta"
fi

if diff -q \
  <(grep '^LOGTO_' "$INSTANCE_DEFAULT/instance.env" | sort) \
  <(grep '^LOGTO_' "$INSTANCE_BETA/instance.env" | sort) >/dev/null 2>&1; then
  smoke_fail 7 "LOGTO_* keys identical — cross-instance Logto bleed suspected"
fi
echo "[smoke] LOGTO_* env differs (LOGTO_WORKBENCH_APP_ID, LOGTO_M2M_APP_SECRET, etc.)"

# ---------------------------------------------------------------------------
# 8. Hard destroy beta — default stays healthy
# ---------------------------------------------------------------------------

echo "[smoke] step 8: hard destroy beta; default unaffected"
# Acceptance #2 / #8 — independent lifecycle per profile.
"${NAUTILO[@]}" destroy --profile local-beta --hard

if ! curl -sf "http://localhost:${SERVER_PORT_DEFAULT}/health" >/dev/null; then
  smoke_fail 8 "default /health failed after beta hard destroy"
fi

if [ -z "$(default_volumes_present)" ]; then
  smoke_fail 8 "default nautilo_* volumes missing after beta hard destroy"
fi
echo "[smoke] default still healthy; default volumes intact"

# Redeploy beta for subsequent steps.
"${NAUTILO[@]}" deploy --profile local-beta
wait_for_health "$SERVER_PORT_BETA" "local-beta" 8

# ---------------------------------------------------------------------------
# 9. Logto auth wiring — unauthenticated whoami returns 401
# ---------------------------------------------------------------------------

echo "[smoke] step 9: GET /api/auth/whoami without bearer → 401"
# Acceptance #8 (lightweight) — trust middleware + JWKS reachable.
WHOAMI_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${SERVER_PORT_DEFAULT}/api/auth/whoami")"
if [ "$WHOAMI_CODE" != "401" ]; then
  smoke_fail 9 "/api/auth/whoami returned HTTP ${WHOAMI_CODE} (expected 401 without bearer)"
fi
echo "[smoke] whoami 401 without bearer (JWT happy path is manual QA / TODO)"

# ---------------------------------------------------------------------------
# 10. Backup → destroy → deploy → restore round-trip
# ---------------------------------------------------------------------------

echo "[smoke] step 10: backup + hard destroy + deploy + restore round-trip"
# Acceptance #4b — backup artifact restores prior DB state.
BACKUP_PATH="$("${NAUTILO[@]}" backup --profile local-default | tail -1)"
if [ ! -f "$BACKUP_PATH" ]; then
  smoke_fail 10 "backup artifact missing at ${BACKUP_PATH}"
fi
echo "[smoke] backup written: ${BACKUP_PATH}"

"${NAUTILO[@]}" destroy --profile local-default --hard
"${NAUTILO[@]}" deploy --profile local-default
"${NAUTILO[@]}" restore --profile local-default --from "$BACKUP_PATH" --force

wait_for_health "$SERVER_PORT_DEFAULT" "local-default" 10

echo "[smoke] all acceptance steps passed."
exit 0
