#!/usr/bin/env bash
#
# setup-macos.sh — Provision the Tart macOS Sonoma VMs for security smoke testing.
#
# Architecture:
#   - Persistent baseline VM (nautilo-smoke-macos-baseline) — macOS
#     Sonoma with Nautilo + honeypot fixtures installed. Never runs
#     after initial provisioning; serves as the clone source.
#   - Working VM (nautilo-smoke-macos) — sparse clone of baseline.
#     Re-created on every snapshot restore.
#
# Uses `tart exec` (via Tart Guest Agent) instead of SSH — avoids the
# admin/admin password + sshpass dance. Cirrus Labs' macOS base images
# ship with the guest agent pre-installed.
#
# D063 Phase 1 tasks 1.3 and 1.4.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAUTILO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASELINE_VM="nautilo-smoke-macos-baseline"
WORKING_VM="nautilo-smoke-macos"

# D060 Sprint 2 G2.1 — pre-built Nautilo baseline image. Bakes
# bun + Xcode CLT + Nautilo source + deps so the Sonoma-NAT-slow
# `bun install` step is SKIPPED at setup time. Published by
# the official release channel; see README.md for baseline updates.
#
# Pin by digest, not by tag, so every developer + CI runner
# exercises the same baseline. Update this pin only after the replacement
# image has been qualified and its exact digest verified.
#
# Set BASE_IMAGE_PREBUILT to empty only while bootstrapping the first
# pre-built image. Raw Cirrus bootstrap is not reliable enough for
# ordinary Phase F runs on Sonoma shared-NAT hosts; it requires the
# explicit NAUTILO_TART_ALLOW_RAW_BOOTSTRAP=1 override below.
BASE_IMAGE_PREBUILT="ghcr.io/agentsea/nautilo-tart-baseline@sha256:20d8ba319f9f4e985ce46b39c532095af1fc40faaaace54eb8a6374d34758587"

# Pinned cirruslabs macOS base digest — used ONLY when the pre-built
# image is unavailable (bootstrap path OR operator explicitly cleared
# BASE_IMAGE_PREBUILT to rebuild the baseline from scratch).
#
# To upgrade: run `tart pull ghcr.io/cirruslabs/macos-sonoma-base:latest`
# once, then copy the new digest from `tart list` (OCI row) into this
# variable. Re-run setup.sh --macos. Validate the @nautilo/security
# smoke suite still passes. Commit the digest bump separately.
BASE_IMAGE_CIRRUS="ghcr.io/cirruslabs/macos-sonoma-base@sha256:b13fb27eceb75fe1db7a698d16265df7dd0c6e11b70c56d010861d799011ac31"

# Pick the image + remember whether we took the fast path. The later
# provisioning steps conditionally skip bun install + source push when
# we\u0027re on the pre-built path (those are already baked in).
if [[ -n "$BASE_IMAGE_PREBUILT" ]]; then
  BASE_IMAGE="$BASE_IMAGE_PREBUILT"
  USING_PREBUILT=1
else
  BASE_IMAGE="$BASE_IMAGE_CIRRUS"
  USING_PREBUILT=0
fi

usage() {
  cat <<EOF
Usage: setup-macos.sh [--help]

Provision the Tart macOS Sonoma VMs for Nautilo security smoke testing.

Creates:
  $BASELINE_VM  — persistent baseline with Nautilo + honeypot installed
  $WORKING_VM   — working clone of baseline

First run downloads the macOS base image (~30-45 min, one-time).
Subsequent runs are fast.

Idempotent: re-running destroys and rebuilds both VMs.
EOF
}

tart_exec_ready() {
  local vm="$1"
  local pid

  tart exec "$vm" true >/dev/null 2>&1 &
  pid=$!

  # Tart Guest Agent can occasionally wedge a `tart exec` call instead of
  # failing fast. Bound each probe so setup loops can retry and eventually
  # fail with our timeout message instead of hanging forever.
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    sleep 1
  done

  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 124
}

case "${1:-}" in
  -h|--help)  usage; exit 0 ;;
  "")         ;;
  *)          echo "setup-macos.sh: unknown option: $1" >&2; usage >&2; exit 64 ;;
esac

if [[ "$USING_PREBUILT" -eq 0 && "${NAUTILO_TART_ALLOW_RAW_BOOTSTRAP:-0}" != "1" ]]; then
  cat >&2 <<EOF
setup-macos.sh: BASE_IMAGE_PREBUILT is empty.

macOS smoke setup now requires a pre-built Tart baseline by default.
The raw cirruslabs Sonoma image relies on guest DNS + package registry
access for bun.sh and bun install, which has proven flaky on Sonoma's
shared-NAT path and can hang the Tart Guest Agent.

Preferred fix:
  1. Obtain a qualified baseline image from the official release channel
  2. Paste the digest into BASE_IMAGE_PREBUILT in setup-macos.sh
  3. Re-run ./scripts/security-test-env/setup.sh --macos

Maintainer-only escape hatch:
  NAUTILO_TART_ALLOW_RAW_BOOTSTRAP=1 ./scripts/security-test-env/setup.sh --macos

Do not use the raw path for normal D103 Phase F validation.
EOF
  exit 2
fi

# --- 1. Prerequisites -------------------------------------------------------

if ! command -v tart >/dev/null 2>&1; then
  OS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
  cat >&2 <<EOF
setup-macos.sh: tart not found.

Install Tart with:
EOF
  case "$OS_VERSION" in
    15.*|16.*|17.*)
      echo "  brew install cirruslabs/cli/tart" >&2
      ;;
    14.*)
      echo "  brew install --ignore-dependencies cirruslabs/cli/tart" >&2
      echo "  (--ignore-dependencies because Tart's 'softnet' dep requires Sequoia)" >&2
      ;;
    *)
      echo "  brew install cirruslabs/cli/tart" >&2
      ;;
  esac
  echo "" >&2
  echo "Docs: https://tart.run/" >&2
  exit 2
fi

echo "==> Using tart $(tart --version 2>&1 | head -1)"

# --- 2. Tear down existing VMs (idempotent) --------------------------------

remove_vm_if_exists() {
  local vm="$1"
  if tart list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$vm"; then
    echo "==> Removing existing Tart VM: $vm"
    tart stop "$vm" 2>/dev/null || true
    tart delete "$vm"
  fi
}

# Remove any lingering snapshot clones from previous runs
for snap_vm in $(tart list 2>/dev/null | awk 'NR>1 {print $2}' | grep "^${WORKING_VM}-snap-" || true); do
  [ -z "$snap_vm" ] && continue
  echo "==> Removing stale snapshot VM: $snap_vm"
  tart delete "$snap_vm" 2>/dev/null || true
done

remove_vm_if_exists "$WORKING_VM"
remove_vm_if_exists "$BASELINE_VM"

# --- 3. Pull + clone baseline ----------------------------------------------

echo "==> Cloning macOS base image ($BASE_IMAGE) into $BASELINE_VM"
echo "    First run: ~30-45 min for IPSW download; subsequent runs: seconds."
tart clone "$BASE_IMAGE" "$BASELINE_VM"

# --- 4. Boot baseline for provisioning -------------------------------------

echo "==> Starting baseline VM (headless)"
nohup tart run "$BASELINE_VM" --no-graphics >/dev/null 2>&1 &

# Wait for the guest agent to respond (not just IP — tart exec needs the agent)
echo "==> Waiting for Tart Guest Agent to respond..."
for attempt in $(seq 1 120); do
  if tart_exec_ready "$BASELINE_VM"; then
    break
  fi
  sleep 3
  if [ "$attempt" -eq 120 ]; then
    echo "!! Baseline VM's Tart Guest Agent never responded (timeout after 360s)" >&2
    exit 1
  fi
done
echo "==> Baseline VM ready"

# tart exec runs as 'admin' by default. Cirrus Labs base images ship with
# admin/admin + passwordless sudo pre-configured.
TEXEC() { tart exec "$BASELINE_VM" "$@"; }

# --- 5. Install dependencies inside baseline -------------------------------
#
# D060 Sprint 2 G2.1: when we pulled a pre-built image, bun + Xcode CLT +
# Nautilo source + deps are already baked in. We overlay the operator\u0027s
# CURRENT local source on top (their HEAD may differ from the commit
# the image was built against) and run a quick bun install to resolve
# any drift. When the pre-built image is unavailable, we do the full
# install dance inline — slower but self-contained.

if [[ "$USING_PREBUILT" -eq 1 ]]; then
  echo "==> Pre-built baseline detected — skipping bun installer + xcode checks"
  # Source refresh: the baked source is whatever commit the image was
  # built against; the operator\u0027s HEAD may be newer. Overlay on top.
  echo "==> Overlaying current Nautilo source onto baked baseline"
  (cd "$NAUTILO_ROOT" && tar -cf - \
    --exclude='./node_modules' \
    --exclude='*/node_modules' \
    --exclude='.turbo' \
    --exclude='*/.turbo' \
    --exclude='.git/objects' \
    --exclude='logs' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    --exclude='dist' \
    --exclude='*/dist' \
    .) | tart exec -i "$BASELINE_VM" bash -c '
      # Preserve baked node_modules — just refresh code + configs.
      mkdir -p "$HOME/nautilo"
      tar -xf - -C "$HOME/nautilo" --keep-newer-files
    '
  # Fast follow-up install to catch lockfile drift. bun caches heavily
  # so this is seconds, not minutes, even on Sonoma NAT.
  #
  # Self-review BUG-1 fix: guest bash doesn\u0027t inherit the host\u0027s
  # `set -o pipefail`, so `bun install … | tail | bun install …`
  # would ALWAYS take the success branch (tail always exits 0). We
  # either set pipefail explicitly inside the guest shell OR avoid
  # the pipeline. Chose the latter: the frozen-lockfile attempt\u0027s
  # output is usually tiny (5-10 lines), and dropping `| tail` means
  # the operator sees the real bun error when frozen fails — more
  # debuggable than truncated output.
  echo "==> Refreshing bun deps (idempotent if lockfile unchanged)"
  TEXEC bash -c '
    set -o pipefail
    export PATH="$HOME/.bun/bin:$PATH"
    cd "$HOME/nautilo"
    if ! bun install --ignore-scripts --frozen-lockfile 2>&1; then
      echo "==> frozen-lockfile install failed — retrying without --frozen-lockfile"
      bun install --ignore-scripts
    fi
  '
else
  echo "==> Installing bun via official installer (first-boot path; slow on Sonoma NAT)..."
  # Cirrus Labs base image has Homebrew but not a current formula index;
  # `brew install bun` doesn't resolve cleanly. The bun.sh installer is
  # a single curl | bash and is what we use on Lima too — consistency is
  # worth more than the Homebrew route.
  TEXEC bash -c '
    set -o pipefail
    if ! test -x "$HOME/.bun/bin/bun"; then
      curl -fsSL https://bun.sh/install | bash
    fi
  '

  # Git should already be present via Xcode CLT on cirruslabs macOS images;
  # verify and fall back to brew if not.
  TEXEC bash -c '
    if ! command -v git >/dev/null 2>&1; then
      echo "git not present — attempting brew install"
      /opt/homebrew/bin/brew install git 2>&1 | tail -3 || true
    fi
  '

  echo "==> Pushing Nautilo source into baseline VM..."
  (cd "$NAUTILO_ROOT" && tar -cf - \
    --exclude='./node_modules' \
    --exclude='*/node_modules' \
    --exclude='.turbo' \
    --exclude='*/.turbo' \
    --exclude='.git/objects' \
    --exclude='logs' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    --exclude='dist' \
    --exclude='*/dist' \
    .) | tart exec -i "$BASELINE_VM" bash -c 'mkdir -p "$HOME/nautilo" && tar -xf - -C "$HOME/nautilo"'

  echo "==> Running bun install inside baseline VM (full fetch; Sonoma NAT bottleneck)..."
  TEXEC bash -c '
    export PATH="$HOME/.bun/bin:$PATH"
    cd $HOME/nautilo && bun install --ignore-scripts
  '
fi

# Source archives omit generated Office exports, and installs above deliberately
# skip lifecycle scripts. Prepare the server's Writer dependency before boot.
echo "==> Preparing Writer runtime exports"
TEXEC bash -c '
  set -e
  export PATH="$HOME/.bun/bin:$PATH"
  cd "$HOME/nautilo"
  bun run writer:prepare
  bun -e "await import(\"@nautilo/office-docs/node\")"
'

# --- 8. Stop baseline VM (ready to clone from) ----------------------------

# Flush guest writes before stopping: newly generated exports can otherwise
# be lost across the power cycle, even before a clone is created.
# Honeypots are planted on the working VM after this initial clone.

echo "==> Stopping baseline VM (this is the restore source)..."
TEXEC /bin/sync
tart stop "$BASELINE_VM"

# --- 9. Clone working VM from baseline -------------------------------------

echo "==> Cloning working VM: $WORKING_VM"
tart clone "$BASELINE_VM" "$WORKING_VM"

echo "==> Starting working VM..."
nohup tart run "$WORKING_VM" --no-graphics >/dev/null 2>&1 &

echo "==> Waiting for working VM's Guest Agent to respond..."
for attempt in $(seq 1 120); do
  if tart_exec_ready "$WORKING_VM"; then
    break
  fi
  sleep 3
  if [ "$attempt" -eq 120 ]; then
    echo "!! Working VM's Tart Guest Agent never responded (timeout after 360s)" >&2
    exit 1
  fi
done

# --- 10. Plant honeypot on working VM (not baseline — see note above) -----

# Verify the generated dependency survived the stop/clone boundary before
# proceeding with service provisioning.
tart exec "$WORKING_VM" bash -c '
  set -e
  export PATH="$HOME/.bun/bin:$PATH"
  cd "$HOME/nautilo"
  bun -e "await import(\"@nautilo/office-docs/node\")"
'

echo "==> Planting honeypot fixtures on working VM..."
tart exec "$WORKING_VM" bash -c 'sh $HOME/nautilo/scripts/security-test-env/honeypot.sh plant'

# --- 10b. Generate smoke token + install nautilo-test LaunchDaemon ---------
#
# Mirrors setup-linux.sh's step 6c/6d — the SANDBOX-MACOS-* / FILE-*
# matrix drives run_shell + file tool through the in-VM server's
# /api/test/tool-invoke endpoint (D063 Phase 6). Server runs under
# NAUTILO_TEST_MODE_ONLY=1 which skips DB + identity seed + policy
# resolver.
#
# macOS differences from the Lima path:
#   - launchd LaunchDaemon (not systemd unit).
#   - Plist is XML, not INI.
#   - launchctl load -w (not systemctl enable --now).
#   - KeepAlive { SuccessfulExit = false } is the launchd equivalent
#     of 'Restart=on-failure'.
#   - Generate the test bearer inside the guest and let an owner-only file
#     supply the server process. No bearer is embedded in host argv or the plist.

echo "==> Generating smoke token + registering com.nautilo.test-server LaunchDaemon..."
tart exec -i "$WORKING_VM" sudo bash <<'GUEST_SERVER_SETUP'
set -euo pipefail
install -d -m 0755 /etc/nautilo
umask 077
SMOKE_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$SMOKE_TOKEN" > /etc/nautilo/smoke-token
unset SMOKE_TOKEN
chown admin:staff /etc/nautilo/smoke-token
chmod 0600 /etc/nautilo/smoke-token

cat > /etc/nautilo/start-smoke-server.sh <<'SERVER_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
export NAUTILO_TEST_TOKEN="$(cat /etc/nautilo/smoke-token)"
exec /Users/admin/.bun/bin/bun run /Users/admin/nautilo/bin/nautilo-server/src/index.ts
SERVER_WRAPPER
chown root:wheel /etc/nautilo/start-smoke-server.sh
chmod 0755 /etc/nautilo/start-smoke-server.sh

mkdir -p /var/log
touch /var/log/nautilo-test.log /var/log/nautilo-test.err
chown admin:staff /var/log/nautilo-test.log /var/log/nautilo-test.err

cat > /Library/LaunchDaemons/com.nautilo.test-server.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nautilo.test-server</string>
  <key>UserName</key>
  <string>admin</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>WorkingDirectory</key>
  <string>/Users/admin/nautilo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/etc/nautilo/start-smoke-server.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NAUTILO_TEST_MODE_ONLY</key><string>1</string>
    <key>NAUTILO_TEST_MODE</key><string>1</string>
    <key>NAUTILO_PORT</key><string>3001</string>
    <key>NAUTILO_MDNS</key><string>false</string>
    <key>NAUTILO_HOST</key><string>127.0.0.1</string>
    <key>HOME</key><string>/Users/admin</string>
    <key>PATH</key><string>/Users/admin/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/nautilo-test.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/nautilo-test.err</string>
</dict>
</plist>
PLIST

chown root:wheel /Library/LaunchDaemons/com.nautilo.test-server.plist
chmod 0644 /Library/LaunchDaemons/com.nautilo.test-server.plist

# launchctl load -w enables the daemon at boot AND starts it now
# (RunAtLoad=true). The -w flag flips the 'disabled' key so the
# daemon survives a reboot of the VM.
launchctl load -w /Library/LaunchDaemons/com.nautilo.test-server.plist
GUEST_SERVER_SETUP

# --- 10c. Health-gate: wait for /api/test/ping ------------------------------
#
# Identical to setup-linux.sh step 6d (curl with bearer token, 30 × 2s).
# launchd's RunAtLoad is synchronous with the load call but the server's
# bun startup + port-bind is not — so we poll until /api/test/ping is
# healthy rather than assuming the service is up.

echo "==> Waiting for com.nautilo.test-server to be healthy..."
HEALTH_OK=0
for attempt in $(seq 1 30); do
  if tart exec "$WORKING_VM" bash -lc "
    curl --silent --fail --max-time 2 \
      -H \"Authorization: Bearer \$(cat /etc/nautilo/smoke-token)\" \
      http://127.0.0.1:3001/api/test/ping >/dev/null 2>&1
  "; then
    HEALTH_OK=1
    echo "    ready after ${attempt} attempt(s)"
    break
  fi
  sleep 2
done
if [ "$HEALTH_OK" -eq 0 ]; then
  echo "!!  com.nautilo.test-server never became healthy within 60s" >&2
  echo "!!  Recent server log lines:" >&2
  tart exec "$WORKING_VM" sudo bash -c "tail -n 80 /var/log/nautilo-test.err /var/log/nautilo-test.log 2>/dev/null" >&2 || true
  exit 1
fi

# --- 10d. Register headless relay LaunchDaemon (D060 Sprint 2 G2 — macOS) --
#
# Mirrors setup-linux.sh's nautilo-relay.service for the Tart side.
# SANDBOX-MACOS-* matrix exercises the full production protocol:
# test client -> server /api/test/tool-invoke -> Policy Resolver ->
# envelope -> in-VM relay -> @nautilo/sandbox -> sandbox-exec -> kernel.
#
# Mac-specific details (vs. the Linux systemd unit):
#   - Plist instead of unit file.
#   - No After= ordering — `nautilo-test-server` MUST be loaded first;
#     we sequence the load calls in this script. The relay's
#     RelayClient does exponential reconnect-backoff so a brief
#     server-down window doesn't matter.
#   - Do NOT set DYLD_INSERT_LIBRARIES on this LaunchDaemon. dyld
#     applies a missing inserted dylib to the relay's own Bun process
#     before Nautilo's sandbox env scrub can run, so the relay never
#     registers. DANGEROUS_ENV_VARS coverage belongs in unit/integration
#     tests that control the spawned child, not in the parent daemon.
echo "==> Verifying the admin GUI session for login-keychain access..."
tart exec "$WORKING_VM" bash -c 'set -e; test "$(id -un)" = admin; launchctl print "gui/$(id -u)" >/dev/null'
echo "==> Provisioning the authenticated smoke Relay pairing credential..."
tart exec "$WORKING_VM" env NODE_ENV=test NAUTILO_TEST_MODE=1 NAUTILO_TEST_MODE_ONLY=1 \
  HOME=/Users/admin /Users/admin/.bun/bin/bun run \
  /Users/admin/nautilo/scripts/security-test-env/provision-relay-pairing.ts \
  /etc/nautilo/smoke-token

# Each actual Relay process owns fresh logs and emits its PID before exec.
# The Runner can then distinguish this restart from a historical connection.
tart exec -i "$WORKING_VM" sudo bash <<'RELAY_WRAPPER'
set -e
cat > /etc/nautilo/start-smoke-relay.sh <<'SH'
#!/bin/bash
set -eu
exec > /var/log/nautilo-relay.log 2> /var/log/nautilo-relay.err
printf 'smoke-relay-pid=%s\n' "$$"
exec /Users/admin/.bun/bin/bun run /Users/admin/nautilo/bin/nautilo-relay/src/index.ts
SH
chown root:wheel /etc/nautilo/start-smoke-relay.sh
chmod 0755 /etc/nautilo/start-smoke-relay.sh
RELAY_WRAPPER

echo "==> Registering com.nautilo.relay user LaunchAgent..."
tart exec "$WORKING_VM" sudo bash -c "
set -e

# Relay workspace — same convention as Lima.
install -d -m 0755 /Users/admin/workspace
chown admin:staff /Users/admin/workspace

mkdir -p /var/log
touch /var/log/nautilo-relay.log /var/log/nautilo-relay.err
chown admin:staff /var/log/nautilo-relay.log /var/log/nautilo-relay.err

install -d -m 0755 -o admin -g staff /Users/admin/Library/LaunchAgents
cat > /Users/admin/Library/LaunchAgents/com.nautilo.relay.plist <<'PLIST'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>com.nautilo.relay</string>
  <key>WorkingDirectory</key>
  <string>/Users/admin/nautilo</string>
  <key>ProgramArguments</key>
  <array>
    <string>/etc/nautilo/start-smoke-relay.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- NODE_ENV=production: same release-build refusal contract as
         the Linux unit. Relay rejects dispatches without a
         well-formed sandboxProfile envelope. The test-mode server's
         /api/test/tool-invoke builds envelopes via
         buildRelaySandboxProfile(resolveServerPosture(), relayCaps)
         so every dispatch exercises sandbox-exec, not the dev-mode
         fallback. -->
    <key>NODE_ENV</key><string>production</string>
    <key>NAUTILO_SERVER_URL</key><string>http://127.0.0.1:3001</string>
    <key>NAUTILO_WORKSPACE</key><string>/Users/admin/workspace</string>
    <!-- Filesystem-layout hint, not policy. Same G5.6 taxonomy
         classification as NAUTILO_HOST / NAUTILO_PORT. -->
    <key>NAUTILO_TOOLS_BIN</key><string>/Users/admin/.bun/bin</string>
    <key>HOME</key><string>/Users/admin</string>
    <key>PATH</key><string>/Users/admin/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <!-- The smoke harness starts Relay explicitly after server readiness. -->
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/var/log/nautilo-relay.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/nautilo-relay.err</string>
</dict>
</plist>
PLIST

chown admin:staff /Users/admin/Library/LaunchAgents/com.nautilo.relay.plist
chmod 0644 /Users/admin/Library/LaunchAgents/com.nautilo.relay.plist

"
# Relay uses the logged-in user's keychain security context. A system daemon
# with UserName=admin has the same UID but cannot read this login-keychain item.
tart exec "$WORKING_VM" bash -c 'launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nautilo.relay.plist"'
# Explicit demand avoids an early login launch racing the restored server.
RELAY_PID="$(tart exec "$WORKING_VM" bash -c 'launchctl kickstart -kp "gui/$(id -u)/com.nautilo.relay"')"
case "$RELAY_PID" in
  ''|0*|*[!0-9]*)
    echo "!!  Relay kickstart did not return a valid process PID" >&2
    exit 1
    ;;
esac

# --- 10e. Health-gate: wait for nautilo-relay to register ------------------
#
# launchd doesn't surface a unit-scoped journal like systemd — we
# poll the relay's stdout log file for the "Connected as <relayId>"
# line bin/nautilo-relay/src/index.ts emits on successful WS
# handshake, together with the exact PID marker from the new wrapper process.
# 60s budget is generous for a loopback registration
# (30 attempts × 2s). No sudo needed: we explicitly chown'd the log
# file admin:staff at 0644 above (line 438) and the agent runs in
# the existing admin GUI session, so launchd appends as admin
# without changing ownership.
echo "==> Waiting for com.nautilo.relay to register with server..."
RELAY_OK=0
for attempt in $(seq 1 30); do
  if tart exec "$WORKING_VM" bash -c \
    'grep -Fqx "smoke-relay-pid=$1" /var/log/nautilo-relay.log 2>/dev/null && grep -q "Connected as " /var/log/nautilo-relay.log /var/log/nautilo-relay.err 2>/dev/null' \
    smoke-relay-readiness "$RELAY_PID"; then
    RELAY_OK=1
    echo "    relay connected after ${attempt} attempt(s)"
    break
  fi
  sleep 2
done
if [ "$RELAY_OK" -eq 0 ]; then
  echo "!!  com.nautilo.relay never connected within 60s" >&2
  echo "!!  Recent relay log lines:" >&2
  tart exec "$WORKING_VM" bash -c \
    "tail -n 80 /var/log/nautilo-relay.err /var/log/nautilo-relay.log 2>/dev/null" >&2 || true
  exit 1
fi

# Prove the paired Relay can execute through the production sandbox path,
# rather than accepting a historical connection log as complete readiness.
echo "==> Verifying authenticated Relay sandbox dispatch..."
tart exec -i "$WORKING_VM" /Users/admin/.bun/bin/bun run - <<'RELAY_DISPATCH_PROOF'
import { readFileSync } from "node:fs";
const marker = `NAUTILO_TART_RELAY_${crypto.randomUUID()}`;
const response = await fetch("http://127.0.0.1:3001/api/test/tool-invoke", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${readFileSync("/etc/nautilo/smoke-token", "utf8")}`,
  },
  body: JSON.stringify({ tool: "run_shell", args: { command: `/bin/echo ${marker}` } }),
});
const result = await response.json();
if (!response.ok || result.blocked !== false || typeof result.result !== "string") {
  throw new Error("Authenticated Relay sandbox dispatch failed");
}
const output = JSON.parse(result.result);
if (output.stdout !== marker) throw new Error("Relay sandbox output did not match the fresh probe");
console.log("Authenticated Relay sandbox dispatch passed");
RELAY_DISPATCH_PROOF

# --- 10f. Plant execute_artifact test scripts (D060 Sprint 2 G5/EXEC-*) ----
#
# Mirrors setup-linux.sh §6f. Pre-plants canonical scripts under
# ~admin/.nautilo/home/exec/ so the EXEC-MACOS-* matrix rows can drive
# execute_artifact through /api/test/tool-invoke without multi-step
# (write-then-execute) flows. Snapshot captures the planted state.
#
# macOS deltas from Linux:
#   - User is `admin` (Cirrus base image convention) vs `nautilotest`.
#   - Escape target is /Users/admin/... (deny-write under sandbox-exec
#     desktop-permissive: home is read-allow, write-deny by default).
#   - python3 lives at /usr/bin/python3 (Xcode CLT). Same shebang on
#     both platforms because execute_artifact uses /usr/bin/env-style
#     dispatch via the runtime allowlist.
echo "==> Planting execute_artifact test scripts in ~admin/.nautilo/home/exec/..."
tart exec "$WORKING_VM" bash -lc "
set -e
mkdir -p \$HOME/.nautilo/home/exec

cat > \$HOME/.nautilo/home/exec/print-stdout.py <<'PY'
print('EXEC-MACOS-01-OK')
PY

cat > \$HOME/.nautilo/home/exec/write-workspace.sh <<'SH'
#!/bin/sh
# Workspace cwd is the zone root (~/.nautilo/home). Touching a file
# RELATIVE here lands in the sandbox-exec workspace allow-write
# subpath. Followed by ls so a silent touch failure is visible in
# stdout.
touch ./exec-macos-02-marker && ls ./exec-macos-02-marker
SH
chmod 0755 \$HOME/.nautilo/home/exec/write-workspace.sh

cat > \$HOME/.nautilo/home/exec/escape-write.sh <<'SH'
#!/bin/sh
# /Users/admin is read-allow, write-deny under the desktop-permissive
# SBPL profile (only the workspace + /tmp tmpfs are RW). Touch should
# fail with EPERM; the explicit ESCAPE-BLOCKED marker is how the
# matrix asserts containment fired without depending on the exact
# errno text.
touch /Users/admin/exec-macos-03-escape 2>/dev/null
ls /Users/admin/exec-macos-03-escape 2>/dev/null \
  || echo ESCAPE-BLOCKED
SH
chmod 0755 \$HOME/.nautilo/home/exec/escape-write.sh

cat > \$HOME/.nautilo/home/exec/sleep-long.sh <<'SH'
#!/bin/sh
# Sleeps longer than the EXEC-MACOS-04 timeout. Sandbox should kill
# the process tree; the matrix asserts a 'timed out' / non-zero exit
# in the response.
echo SLEEP-START
sleep 30
echo SLEEP-END-SHOULD-NEVER-REACH
SH
chmod 0755 \$HOME/.nautilo/home/exec/sleep-long.sh
"

# Stop both services before the VM is cloned / snapshotted — per-test
# restore returns to daemon-stopped and the Runner starts them fresh
# (avoids in-memory state accumulation).
echo "==> Unloading services so baseline clone captures stopped state..."
tart exec "$WORKING_VM" bash -c 'launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nautilo.relay.plist"'
tart exec "$WORKING_VM" sudo bash -c "
  launchctl unload /Library/LaunchDaemons/com.nautilo.test-server.plist
"

# The Runner restores macOS tests by re-cloning $BASELINE_VM. Service
# plists, smoke token, honeypots, and exec fixtures were installed on
# the working VM after the initial raw-image clone, so refresh the
# baseline from this validated, service-stopped working VM. Without
# this, per-test restores boot a VM that has Nautilo source but no
# LaunchDaemons or smoke token to restart.
echo "==> Refreshing baseline VM from fully provisioned working VM..."
tart exec "$WORKING_VM" /bin/sync
tart stop "$WORKING_VM"
tart delete "$BASELINE_VM"
tart clone "$WORKING_VM" "$BASELINE_VM"

# --- 11. Summary ------------------------------------------------------------

WORKING_IP="stopped (runner restore starts a fresh clone)"

cat <<EOF

================================================================
  Nautilo smoke macOS VMs ready
================================================================

Baseline:     $BASELINE_VM (stopped — clone source)
Working:      $WORKING_VM (stopped after baseline refresh)
Working IP:   $WORKING_IP

Enter:        tart exec $WORKING_VM bash -l
Restore:      $SCRIPT_DIR/snapshot.sh restore macos baseline
Teardown:     $SCRIPT_DIR/teardown.sh --macos

Nautilo:      /Users/admin/nautilo
Start server: tart exec $WORKING_VM sudo launchctl load -w \\
              /Library/LaunchDaemons/com.nautilo.test-server.plist
Smoke token:  /etc/nautilo/smoke-token (inside VM, 0600, admin-owned)
Tool-invoke:  curl -H "Authorization: Bearer \$(cat /etc/nautilo/smoke-token)" \\
              http://127.0.0.1:3001/api/test/ping

Start OSS:    tart exec -t $WORKING_VM bash -lc 'cd \$HOME/nautilo && bun run oss'

EOF
