#!/usr/bin/env bash
# Stack 1 acceptance smoke: real Postgres + cloud-mode daemon + Unix-socket
# + state-survives-restart.
#
# Verifies:
#   1. Server boots in NAUTILO_HOSTING_MODE=cloud against dedicated
#      legacy-postgres (direct PostgreSQL wire protocol on an isolated port).
#   2. The Unix socket at ~/.nautilo<instance>/server.sock serves
#      /api/setup/status (loopback path through the in-process forwarder).
#   3. After SIGTERM and a second boot, the same setup state is reported —
#      i.e. boot did NOT regress to fresh-unclaimed because the bootstrap
#      cache rehydrates from DB on every startup.
#   4. red-team-env-var.sh stays clean against this instance's user-data dir.
#
# What this does NOT cover (deliberately deferred):
#   - End-to-end claim via Logto (covered by redeem-invite-atomic.integration
#     test against real DB; needs full Logto admin path for HTTP claim).
#   - Bootstrap-token-over-TLS remote claim (A6/A7 acceptance, needs Caddy).
#
# Usage:
#   bash scripts/stack-1-real-db-smoke.sh
#
# Exit 0 = Stack 1 substrate gate green; non-zero = failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TS="$(date +%s)"
INSTANCE="smoke-$TS"
INSTANCE_DIR="$HOME/.nautilo-$INSTANCE"
SOCKET="$INSTANCE_DIR/server.sock"
SERVER_LOG_DIR="$REPO_ROOT/.smoke-logs"
mkdir -p "$SERVER_LOG_DIR"
SERVER_LOG_1="$SERVER_LOG_DIR/server-$INSTANCE-boot1.log"
SERVER_LOG_2="$SERVER_LOG_DIR/server-$INSTANCE-boot2.log"

# Per-smoke compose stack for full DB isolation (avoids leftover rows from prior
# integration tests poisoning the shared dev DB). Uses the same compose file
# the dev stack uses (packages/db/docker/docker-compose.yml), parameterised by
# COMPOSE_PROJECT_NAME + non-clashing host ports.
COMPOSE_PROJECT="nautilo-smoke-$TS"
PG_PORT=$((5500 + (TS % 1000)))
COMPOSE_FILE="$REPO_ROOT/packages/db/docker/docker-compose.yml"
SMOKE_DB_URL="postgres://postgres:postgres@localhost:$PG_PORT/nautilo"

PROVIDER_LINE="$(grep -E '^(OPENAI|ANTHROPIC|GOOGLE)_API_KEY=' "$HOME/.config/nautilo/secrets.env" | head -1)"
if [ -z "$PROVIDER_LINE" ]; then
  echo "FAIL: no provider key in ~/.config/nautilo/secrets.env" >&2
  exit 2
fi
PROVIDER_KEY_NAME="${PROVIDER_LINE%%=*}"
PROVIDER_KEY_VALUE="${PROVIDER_LINE#*=}"
BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"

SERVER_PID=""
boot_server() {
  local logfile="$1"
  env \
    NAUTILO_INSTANCE_ID="$INSTANCE" \
    NAUTILO_HOSTING_MODE=cloud \
    NAUTILO_DB_PORT="$PG_PORT" \
    DB_DIRECT_CONNECTION="$SMOKE_DB_URL" \
    DB_CONNECTION_STRING="$SMOKE_DB_URL" \
    NAUTILO_BOOTSTRAP_TOKEN="$BOOTSTRAP_TOKEN" \
    "$PROVIDER_KEY_NAME=$PROVIDER_KEY_VALUE" \
    NAUTILO_MDNS=false \
    bun bin/nautilo-server/src/index.ts >"$logfile" 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 120); do
    if [ -S "$SOCKET" ]; then return 0; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "FAIL: server process exited before socket appeared" >&2
      tail -50 "$logfile" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "FAIL: socket $SOCKET did not appear within 60s" >&2
  tail -50 "$logfile" >&2
  return 1
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID"
    for i in $(seq 1 40); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then return 0; fi
      sleep 0.25
    done
    echo "FAIL: server did not exit within 10s of SIGTERM" >&2
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    return 1
  fi
}

cleanup() {
  set +e
  if [ -n "$SERVER_PID" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${KEEP_SMOKE:-0}" != "1" ]; then
    rm -rf "$INSTANCE_DIR"
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT" \
      NAUTILO_DB_PORT="$PG_PORT" \
      docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
  set -e
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }

curl_socket() {
  # $1 = HTTP path
  curl -sS --unix-socket "$SOCKET" "http://localhost$1"
}

step "1a. spin up dedicated Postgres ($COMPOSE_PROJECT, pg=$PG_PORT)"
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT" \
  NAUTILO_DB_PORT="$PG_PORT" \
  docker compose -f "$COMPOSE_FILE" up -d >/dev/null
# Wait for direct postgres
for i in $(seq 1 60); do
  if docker exec "$COMPOSE_PROJECT-postgres" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 0.5
done
docker exec "$COMPOSE_PROJECT-postgres" pg_isready -U postgres >/dev/null \
  || { echo "FAIL: smoke postgres did not become ready"; exit 1; }
echo "smoke postgres ready"

step "1b. drizzle migrate (so bootstrap-claim-invite sees an empty users table)"
DB_CONNECTION_STRING="postgresql://postgres:postgres@localhost:$PG_PORT/nautilo" \
  DB_DIRECT_CONNECTION="postgresql://postgres:postgres@localhost:$PG_PORT/nautilo" \
  bun run --cwd packages/db db:migrate 2>&1 | tail -3
mkdir -p "$INSTANCE_DIR"

step "1c. mint claim invite BEFORE seedDefaultOwner runs (server boot sequence)"
env \
  NAUTILO_INSTANCE_ID="$INSTANCE" \
  NAUTILO_DB_PORT="$PG_PORT" \
  DB_DIRECT_CONNECTION="$SMOKE_DB_URL" \
  DB_CONNECTION_STRING="$SMOKE_DB_URL" \
  bun -e "
    const { bootstrapClaimInvite } = await import('./bin/nautilo-dev/src/lib/bootstrap-claim-invite.ts');
    const r = await bootstrapClaimInvite();
    console.log(JSON.stringify(r.outcome));
  "
INVITE_TOKEN="$(grep -E '^redeem_input:' "$INSTANCE_DIR/claim-invite.txt" | sed 's/^redeem_input: //')"
[ -n "$INVITE_TOKEN" ] || { echo "FAIL: could not read invite token"; exit 1; }
echo "invite minted: ${INVITE_TOKEN:0:24}..."

step "1d. boot server (cloud mode, foreground)"
boot_server "$SERVER_LOG_1"
echo "boot 1 ready: socket=$SOCKET pid=$SERVER_PID"

json_get() {
  # $1 = JSON, $2 = key
  printf '%s' "$1" | bun -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(j[$(printf %s "'$2'")] ?? ''))"
}

INSTANCE_LOG="$INSTANCE_DIR/logs/nautilo-server.log"

step "2. /api/setup/status via Unix socket — first boot"
STATUS_1="$(curl_socket /api/setup/status)"
echo "$STATUS_1"
SETUP_STATE_1="$(json_get "$STATUS_1" setupState)"
echo "boot 1 setupState: $SETUP_STATE_1"
[ -n "$SETUP_STATE_1" ] || { echo "FAIL: empty setupState"; exit 1; }

step "3. cloud-mode boot log assertions"
grep -q '\[boot\] hosting mode: cloud' "$SERVER_LOG_1" \
  || { echo "FAIL: cloud-mode boot log missing"; exit 1; }
grep -q 'NAUTILO_SERVER_READY' "$SERVER_LOG_1" \
  || { echo "FAIL: server-ready sentinel missing"; exit 1; }
[ -f "$INSTANCE_LOG" ] || { echo "FAIL: instance log file missing at $INSTANCE_LOG"; exit 1; }
grep -q 'unix socket forwarder' "$INSTANCE_LOG" \
  || { echo "FAIL: unix-socket forwarder log missing in $INSTANCE_LOG"; exit 1; }
echo "cloud-mode + ready + socket forwarder present in boot 1 logs"

step "4. claim via Unix socket (loopback path, claim invite without bearer)"
CLAIM_BODY='{"handle":"smoke_admin","displayName":"Smoke Admin","password":"SmokeAdminPwd1234!","pin":"123456","forcePasswordChange":false}'
CLAIM_HTTP="$(curl -sS --unix-socket "$SOCKET" -X POST -H 'Content-Type: application/json' -d "$CLAIM_BODY" -o /tmp/smoke-claim-body.json -w '%{http_code}' "http://localhost/api/invites/$INVITE_TOKEN/redeem")"
echo "claim HTTP: $CLAIM_HTTP"
echo "claim body: $(head -c 400 /tmp/smoke-claim-body.json)"
[ "$CLAIM_HTTP" = "200" ] || { echo "FAIL: claim did not return 200"; exit 1; }

step "5. confirm claimed-* state visible via Unix socket"
CLAIMED_STATUS="$(curl_socket /api/setup/status)"
CLAIMED_STATE="$(json_get "$CLAIMED_STATUS" setupState)"
echo "post-claim setupState: $CLAIMED_STATE"
case "$CLAIMED_STATE" in
  claimed-needs-auth|server-needs-keys|ready) echo "claim took effect (state=$CLAIMED_STATE)";;
  *) echo "FAIL: unexpected post-claim state: $CLAIMED_STATE"; exit 1;;
esac

step "6. confirm claimed owner has credentials row in DB"
CRED_COUNT="$(docker exec "$COMPOSE_PROJECT-postgres" psql -U postgres -d nautilo -tAc "SELECT COUNT(*) FROM credentials c JOIN users u ON u.id=c.user_id WHERE u.handle='smoke_admin';")"
echo "credentials rows for smoke_admin: $CRED_COUNT"
[ "$CRED_COUNT" = "1" ] || { echo "FAIL: expected exactly 1 credentials row for smoke_admin, got $CRED_COUNT"; exit 1; }

step "7. SIGTERM + clean shutdown"
stop_server
[ ! -S "$SOCKET" ] || { echo "FAIL: socket still present after shutdown"; exit 1; }
[ ! -f "$INSTANCE_DIR/server.pid" ] || { echo "FAIL: pid file not unlinked on shutdown"; exit 1; }
echo "clean shutdown confirmed (socket + pid file removed)"

step "8. RESTART (claimed state must survive — DB is source of truth)"
boot_server "$SERVER_LOG_2"
echo "boot 2 ready: socket=$SOCKET pid=$SERVER_PID"

step "9. /api/setup/status via Unix socket — after restart"
STATUS_2="$(curl_socket /api/setup/status)"
echo "$STATUS_2"
SETUP_STATE_2="$(json_get "$STATUS_2" setupState)"
echo "boot 2 setupState: $SETUP_STATE_2"

if [ "$CLAIMED_STATE" != "$SETUP_STATE_2" ]; then
  echo "FAIL: setupState regressed across restart (pre-restart=$CLAIMED_STATE → post-restart=$SETUP_STATE_2)"
  exit 1
fi
echo "claimed state survived restart: setupState=$SETUP_STATE_2 (matches pre-restart $CLAIMED_STATE)"
[ "$SETUP_STATE_2" != "fresh-unclaimed" ] || { echo "FAIL: regressed to fresh-unclaimed"; exit 1; }

step "10. confirm boot 2 is cloud-mode and reached listening (state survival is the actual proof)"
grep -E '\[boot\] hosting mode: cloud' "$SERVER_LOG_2" \
  || { echo "FAIL: boot 2 hosting mode line missing"; exit 1; }
INSTANCE_LOG_2="$INSTANCE_DIR/logs/nautilo-server.log"
grep -q '\[server\] Listening on' "$INSTANCE_LOG_2" \
  || { echo "FAIL: boot 2 did not reach listening state"; tail -40 "$INSTANCE_LOG_2"; exit 1; }
# The "owner resolved from DB" log line only fires when the seeded dummy
# differs from the claimed owner (multi-user post-claim case). With a single
# claimed user, seedDefaultOwner is idempotent and returns the same id, so
# claimedOwnerId === seededOwnerId and the log is suppressed by design.
# The actual DB-as-source-of-truth proof is step 9: setupState came back as
# claimed-needs-auth across the restart with no setup files involved.
echo "boot 2 reached listening with cloud-mode env (claim survived = DB is source of truth)"

step "11. no retired identity vars in user-data dir"
ENV_FILE=""
if [ -f "$INSTANCE_DIR/instance.env" ]; then
  ENV_FILE="$INSTANCE_DIR/instance.env"
elif [ -f "$INSTANCE_DIR/config.env" ]; then
  ENV_FILE="$INSTANCE_DIR/config.env"
fi
if [ -n "$ENV_FILE" ]; then
  if grep -E '^(NAUTILO_OWNER_ID|NAUTILO_DEFAULT_AGENT_ID|NAUTILO_OWNER_ACTOR_ID)=' "$ENV_FILE" >/dev/null; then
    echo "FAIL: retired identity vars present in $ENV_FILE after second boot"
    exit 1
  fi
fi
echo "no retired identity vars in user-data dir"

step "12. red-team-env-var.sh"
bash ops/security/red-team-env-var.sh >/dev/null
echo "red-team scan clean"

step "13. SIGTERM second boot"
stop_server
[ ! -S "$SOCKET" ] || { echo "FAIL: socket still present after second shutdown"; exit 1; }

step "PASS: Stack 1 substrate gate green"
echo "  instance:      $INSTANCE"
echo "  setupState:    $SETUP_STATE_2  (preserved across SIGTERM/restart)"
echo "  boot 1 log:    $SERVER_LOG_1"
echo "  boot 2 log:    $SERVER_LOG_2"
echo "  KEEP_SMOKE=1 to retain ~/.nautilo-$INSTANCE after this returns"
