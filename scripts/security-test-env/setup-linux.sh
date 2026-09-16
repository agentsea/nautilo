#!/usr/bin/env bash
#
# setup-linux.sh — Provision the Lima Ubuntu 24.04 VM for security smoke testing.
#
# Sequence:
#   1. Verify `limactl` is installed.
#   2. Tear down any existing nautilo-smoke-linux VM (idempotent).
#   3. Start a fresh VM using lima-config.yaml.
#   4. Stream the Nautilo repo into the VM (excluding node_modules, .turbo,
#      .git/objects, logs — we reinstall deps in-VM).
#   5. Run `bun install` inside the VM.
#   6. Plant honeypot fixtures via honeypot.sh.
#   7. Take baseline snapshot.
#
# D063 Phase 1 tasks 1.2 and 1.4.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAUTILO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

VM_NAME="nautilo-smoke-linux"
CONFIG="$SCRIPT_DIR/lima-config.yaml"
SNAPSHOT_NAME="baseline"

usage() {
  cat <<EOF
Usage: setup-linux.sh [--help]

Provision the Lima Ubuntu 24.04 VM named "$VM_NAME" with Nautilo
installed, honeypot fixtures planted, and a baseline snapshot taken.

Idempotent: re-running destroys and rebuilds the VM.

EOF
}

case "${1:-}" in
  -h|--help)  usage; exit 0 ;;
  "")         ;;
  *)          echo "setup-linux.sh: unknown option: $1" >&2; usage >&2; exit 64 ;;
esac

# --- 1. Prerequisites -------------------------------------------------------

if ! command -v limactl >/dev/null 2>&1; then
  cat >&2 <<EOF
setup-linux.sh: limactl not found.

Install Lima with:
  brew install lima

Docs: https://lima-vm.io/
EOF
  exit 2
fi

echo "==> Using limactl $(limactl --version | awk '{print $NF}')"

# --- 2. Tear down existing VM (idempotent) ----------------------------------

# D063 PR-001 M-2: the previous check used `jq -e ".name == \"$VM_NAME\""`
# which works for the first line of ndjson output but returns false for
# subsequent lines. If the user had multiple Lima VMs, the existing-VM
# detection would miss our VM when it wasn't the first entry listed.
# Slurping with `-s` turns the newline-delimited stream into a single
# array that we can match with an exact-name filter.
if limactl list --format=json 2>/dev/null | jq -se "map(select(.name == \"$VM_NAME\")) | length > 0" >/dev/null 2>&1; then
  echo "==> Removing existing VM: $VM_NAME"
  limactl stop --force "$VM_NAME" 2>/dev/null || true
  limactl delete --force "$VM_NAME" 2>/dev/null || true
fi

# --- 3. Start fresh VM ------------------------------------------------------

echo "==> Creating VM from $CONFIG (this may take a few minutes on first run)..."
limactl create --name="$VM_NAME" --tty=false "$CONFIG"

echo "==> Starting VM..."
limactl start --tty=false "$VM_NAME"

# Wait for SSH readiness (provision scripts must complete)
echo "==> Waiting for VM to be ready..."
for attempt in $(seq 1 60); do
  if limactl shell "$VM_NAME" -- true 2>/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "!!  VM never became ready after 60 attempts" >&2
    exit 1
  fi
  sleep 2
done

# --- 4. Push Nautilo source into VM -----------------------------------------

echo "==> Pushing Nautilo source into VM..."
# Stream a tarball of tracked+untracked files (excluding heavy caches)
# so we preserve uncommitted local changes but skip 1GB+ of node_modules.
# Source is placed at /home/nautilotest/nautilo.

limactl shell "$VM_NAME" -- bash -c "sudo -u nautilotest mkdir -p /home/nautilotest/nautilo"

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
  .) | limactl shell "$VM_NAME" -- bash -c \
    "sudo -u nautilotest tar -xf - -C /home/nautilotest/nautilo"
# NOTE: '._*' excludes macOS AppleDouble resource forks. bun treats them
# as executable JS on Linux and the tests fail with parse errors. This
# is a bug we caught on the first smoke run of @nautilo/security tests
# (see D063 Phase 1 task 1.9). Invisible on macOS, loud on Linux.

# --- 5. bun install inside VM -----------------------------------------------

echo "==> Running bun install inside VM (this takes a couple of minutes)..."

# Ensure bun is installed for nautilotest (the provision block should have
# done this, but this is cheap+idempotent).
limactl shell "$VM_NAME" -- sudo -u nautilotest bash -lc \
  'test -x "$HOME/.bun/bin/bun" || curl -fsSL https://bun.sh/install | bash'

# Run bun install as nautilotest, using its own shell init.
# IMPORTANT: sudo -u is the FIRST thing — you can't cd into nautilotest's
# home as the default lima user.
# --ignore-scripts skips the repo's postinstall (`lefthook install`),
# which is a dev-machine git-hooks tool that isn't useful inside a
# disposable test VM. Omitting saves ~15s and avoids git-worktree edge cases.
limactl shell "$VM_NAME" -- sudo -u nautilotest bash -lc \
  'cd /home/nautilotest/nautilo && ~/.bun/bin/bun install --ignore-scripts'

# --- 6. Plant honeypot fixtures ---------------------------------------------

echo "==> Planting honeypot fixtures..."
# honeypot.sh is the real 307-line POSIX-sh implementation (D063 Phase 1
# task 1.4 complete). A failure here means plant actually broke — fail
# hard rather than silently continuing with an empty VM that would let
# smoke tests falsely pass. The outer `set -euo pipefail` does the work.
limactl shell "$VM_NAME" -- sudo -u nautilotest bash -lc \
  "sh /home/nautilotest/nautilo/scripts/security-test-env/honeypot.sh plant"

# --- 6b. Install bubblewrap (D060 Phase 1 SANDBOX-LINUX-* harness) ----------

echo "==> Installing bubblewrap for SANDBOX-LINUX-* containment tests..."
# D060 Phase 1 — the SANDBOX-LINUX-* smoke rows wrap run_shell in bwrap.
# Ubuntu 24.04 ships a recent bwrap in universe; apt is idempotent so
# re-runs are no-ops. D103 isolated-network rows also need bwrap to
# configure loopback inside a new network namespace; Ubuntu's package is
# not setuid by default, so the disposable VM grants setuid on bwrap
# explicitly. This is VM-only test harness setup, not a product default.
limactl shell "$VM_NAME" -- sudo -n bash -lc \
  "DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap && chmod u+s /usr/bin/bwrap"

# --- 6c. Generate smoke token + systemd service (D063 Phase 6 follow-up) -----

echo "==> Generating smoke token + registering nautilo-test.service..."
# The SANDBOX-LINUX-* matrix drives run_shell via the in-VM Nautilo
# server's /api/test/tool-invoke endpoint (D063 Phase 6). The server
# runs under NAUTILO_TEST_MODE_ONLY=1 which skips DB bootstrap + seed
# — we don't need Postgres or Docker inside the VM. The bearer token
# lives at /etc/nautilo/smoke-token (readable by nautilotest).
SMOKE_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | cut -c1-32)"

limactl shell "$VM_NAME" -- sudo -n bash -lc "
set -e
install -d -m 0755 /etc/nautilo
printf '%s' '${SMOKE_TOKEN}' > /etc/nautilo/smoke-token
chown nautilotest:nautilotest /etc/nautilo/smoke-token
# 0644 (world-readable) because the Runner's VmToolInvocationClient
# reads the token via driver.execShell, which runs as the default
# Lima user — not nautilotest. The token only gates /api/test/*
# (already gated by NAUTILO_TEST_MODE), and the VM is an isolated
# ephemeral test environment with no other users.
chmod 0644 /etc/nautilo/smoke-token

# Re-runs must repair stale masked units from older disposable
# baselines. If /etc/systemd/system/nautilo-test.service is a mask
# symlink to /dev/null, a plain write redirects to /dev/null and
# leaves the unit masked. Remove first, then write the owned unit file.
rm -f /etc/systemd/system/nautilo-test.service
cat > /etc/systemd/system/nautilo-test.service <<SERVICE
[Unit]
Description=Nautilo server (test-mode-only, D063 SANDBOX-LINUX-* harness)
After=network.target

[Service]
Type=simple
User=nautilotest
Group=nautilotest
WorkingDirectory=/home/nautilotest/nautilo
Environment=NAUTILO_TEST_MODE_ONLY=1
Environment=NAUTILO_TEST_MODE=1
# NO leading '-' — we REQUIRE the token file. If it's missing,
# systemd refuses to start the service (loud fail). With the dash,
# the service would boot without NAUTILO_TEST_TOKEN and silently
# generate its own random token into ~nautilotest/.nautilo/smoke-token,
# which wouldn't match /etc/nautilo/smoke-token — every test would
# 401/404 for what looks like a wiring bug.
EnvironmentFile=/etc/nautilo/service-env
Environment=NAUTILO_PORT=3001
Environment=NAUTILO_MDNS=false
Environment=NAUTILO_HOST=127.0.0.1
ExecStart=/home/nautilotest/.bun/bin/bun run /home/nautilotest/nautilo/bin/nautilo-server/src/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

# EnvironmentFile= loads \${SMOKE_TOKEN} for NAUTILO_TEST_TOKEN at
# runtime — keeps the token out of the \`systemctl cat\` output.
printf 'NAUTILO_TEST_TOKEN=%s\n' '${SMOKE_TOKEN}' > /etc/nautilo/service-env
chmod 0600 /etc/nautilo/service-env
chown root:root /etc/nautilo/service-env

test -s /etc/systemd/system/nautilo-test.service
systemctl daemon-reload
systemctl enable --now nautilo-test.service
"

# --- 6c.5. Register headless relay service (D060 Sprint 2 G2) ---------------
#
# The SANDBOX-LINUX-* matrix exercises the full production protocol:
# test client -> server /api/test/tool-invoke -> server Policy Resolver ->
# envelope -> in-VM headless relay -> @nautilo/sandbox -> bwrap -> kernel.
# Without the relay running alongside the server, the server's
# relayRegistry is empty + relay-routed tools (run_shell) fail with
# "no relay connected".
#
# NODE_ENV is intentionally UNSET (default = development). The test-mode
# server skips the policy resolver (TEST_MODE_ONLY=1 path) + doesn't yet
# build envelopes for /api/test/tool-invoke dispatches, so the relay's
# release-build "refuse without envelope" check would 403 every call.
# Development mode falls through to the legacy execAsync path, which is
# enough to validate the WIRING (relay connects, WS handshake, dispatch
# arrives). Full envelope-through-test-mode wiring lands in a follow-up
# commit alongside the SANDBOX-LINUX-* row definitions.
echo "==> Registering nautilo-relay.service (headless, co-located with server)..."
limactl shell "$VM_NAME" -- sudo -n bash -lc "
set -e

# Relay workspace — the 'what can the sandboxed subprocess read/write'
# root the relay reports as allowedRoots[0]. For the smoke harness
# we use the honeypot workspace (planted post-snapshot by the
# Runner's beforeToolInvocation hook), so the relay's guard unions
# with it at dispatch time. Until that hook fires, an empty dir is
# fine — relay starts + registers + waits for dispatches.
install -d -m 0755 -o nautilotest -g nautilotest /home/nautilotest/workspace

rm -f /etc/systemd/system/nautilo-relay.service
cat > /etc/systemd/system/nautilo-relay.service <<SERVICE
[Unit]
Description=Nautilo headless relay (D060 Sprint 2 G2 — SANDBOX-LINUX-* harness)
Documentation=https://github.com/agentsea/nautilo-public/blob/main/scripts/security-test-env/README.md
After=network.target nautilo-test.service
# Not 'Requires=' on purpose: if the server is restarting, we want
# the relay to stay up + reconnect automatically (RelayClient has
# exponential reconnect backoff built in).

[Service]
# NODE_ENV=production — the relay\u0027s release-build guard (G5.4.c)
# REFUSES any dispatch without a well-formed sandboxProfile envelope.
# In this VM, the test-mode server\u0027s /api/test/tool-invoke endpoint
# builds envelopes via buildRelaySandboxProfile(resolveServerPosture(),
# relayCaps) before dispatching, so every smoke call exercises the
# full production path: test client -> server -> policy resolver ->
# envelope -> relay -> @nautilo/sandbox -> bwrap -> kernel.
#
# If a future refactor accidentally un-wires the envelope side, the
# relay\u0027s production-mode guard will 403 every dispatch + the
# SANDBOX-LINUX-* rows will fail LOUDLY — no silent regression to a
# passthrough path.
Type=simple
User=nautilotest
Group=nautilotest
WorkingDirectory=/home/nautilotest/nautilo
Environment=NODE_ENV=production
Environment=NAUTILO_SERVER_URL=http://127.0.0.1:3001
Environment=NAUTILO_USER_ID=@owner@nautilo.local
Environment=NAUTILO_WORKSPACE=/home/nautilotest/workspace
# NAUTILO_TOOLS_BIN is a filesystem-layout hint (not policy). Points
# at where bun lives so the sandbox can bind-mount it. Same taxonomy
# category as NAUTILO_HOST / NAUTILO_PORT per G5.6 classification.
Environment=NAUTILO_TOOLS_BIN=/home/nautilotest/.bun/bin
# SANDBOX-LINUX-04 CANARY: LD_PRELOAD is set on the relay (parent)
# so SANDBOX-LINUX-04 actually EXERCISES the DANGEROUS_ENV_VARS
# filter — if the filter is intact, the spawned child sees
# LD_PRELOAD EMPTY (filter stripped the parent's value before exec).
# If the filter ever regresses, the child sees this canary path +
# the smoke row fails loudly. The file doesn\u0027t exist so even a
# regression doesn\u0027t actually LOAD the library — safe.
Environment=LD_PRELOAD=/tmp/nautilo-smoke-canary-should-not-reach-child.so
ExecStart=/home/nautilotest/.bun/bin/bun run /home/nautilotest/nautilo/bin/nautilo-relay/src/index.ts
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

test -s /etc/systemd/system/nautilo-relay.service
systemctl daemon-reload
systemctl enable --now nautilo-relay.service
"

# --- 6d. Health-gate: wait for /api/test/ping ------------------------------

echo "==> Waiting for nautilo-test.service to be healthy..."
# Poll /api/test/ping until 200 or timeout at 60s. Without this,
# snapshot would capture a booting service and the first test run
# would flake on cold-start latency.
HEALTH_OK=0
for attempt in $(seq 1 30); do
  if limactl shell "$VM_NAME" -- bash -lc "
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
  echo "!!  nautilo-test.service never became healthy within 60s" >&2
  echo "!!  journalctl from the VM:" >&2
  limactl shell "$VM_NAME" -- sudo -n bash -lc "journalctl -u nautilo-test --no-pager -n 80" >&2 || true
  exit 1
fi

# --- 6e. Health-gate: wait for nautilo-relay.service to register ----------
#
# The relay boots + connects to the server's WS /api/relay endpoint.
# We poll the relay's systemd journal for the "Connected as <relayId>"
# line the client emits on successful registration (see
# bin/nautilo-relay/src/index.ts). Timeout at 60s — a failure here
# usually means the WS endpoint rejected the registration or the
# relay can't reach the server.
echo "==> Waiting for nautilo-relay.service to register with server..."
RELAY_OK=0
for attempt in $(seq 1 30); do
  if limactl shell "$VM_NAME" -- sudo -n bash -lc \
    "journalctl -u nautilo-relay --no-pager -n 50 2>/dev/null | grep -q 'Connected as '"; then
    RELAY_OK=1
    echo "    relay connected after ${attempt} attempt(s)"
    break
  fi
  sleep 2
done
if [ "$RELAY_OK" -eq 0 ]; then
  echo "!!  nautilo-relay.service never connected within 60s" >&2
  echo "!!  relay journalctl:" >&2
  limactl shell "$VM_NAME" -- sudo -n bash -lc "journalctl -u nautilo-relay --no-pager -n 80" >&2 || true
  echo "!!  server journalctl (relay endpoint):" >&2
  limactl shell "$VM_NAME" -- sudo -n bash -lc "journalctl -u nautilo-test --no-pager -n 80 | grep -i relay" >&2 || true
  exit 1
fi

# --- 6f. Plant execute_artifact test scripts (D060 Sprint 2 G5/EXEC-*) -----
#
# `execute_artifact` runs scripts FROM the home/scratch artifact zones.
# Pre-plant a small set of canonical scripts so the EXEC-LINUX-* matrix
# rows can drive the tool through /api/test/tool-invoke without
# multi-step (write-then-execute) flows. Scripts live under
# ~/.nautilo/home/exec/ which is the home-zone root for the nautilotest
# user (resolveNautiloRuntimePaths uses \$HOME/.nautilo).
#
# Scripts MUST be world-readable + nautilotest-executable so that bwrap
# (running as nautilotest) can read them through the workspace bind.
# bun-detected runtimes don't need +x because the interpreter reads the
# file directly; we set it anyway for consistency with sh-style runs.
#
# Snapshot captures the planted state — every per-test restore returns
# to scripts-present so EXEC-* rows are deterministic.
echo "==> Planting execute_artifact test scripts in ~nautilotest/.nautilo/home/exec/..."
limactl shell "$VM_NAME" -- sudo -u nautilotest bash -lc "
set -e
mkdir -p \$HOME/.nautilo/home/exec

cat > \$HOME/.nautilo/home/exec/print-stdout.py <<'PY'
print('EXEC-LINUX-01-OK')
PY

cat > \$HOME/.nautilo/home/exec/write-workspace.sh <<'SH'
#!/bin/sh
# Workspace cwd is the zone root (~/.nautilo/home). Touching a file
# RELATIVE here lands in the bwrap RW bind. Followed by ls so a silent
# touch failure is visible in stdout.
touch ./exec-linux-02-marker && ls ./exec-linux-02-marker
SH
chmod 0755 \$HOME/.nautilo/home/exec/write-workspace.sh

cat > \$HOME/.nautilo/home/exec/escape-write.sh <<'SH'
#!/bin/sh
# /home/nautilotest is NOT bind-mounted into the bwrap namespace
# (only the workspace, /etc, /usr, /tmp tmpfs are). Touch should
# fail with ENOENT or EROFS; the explicit ESCAPE-BLOCKED marker is
# how the matrix asserts containment fired without depending on
# the exact errno text.
touch /home/nautilotest/exec-linux-03-escape 2>/dev/null
ls /home/nautilotest/exec-linux-03-escape 2>/dev/null \
  || echo ESCAPE-BLOCKED
SH
chmod 0755 \$HOME/.nautilo/home/exec/escape-write.sh

cat > \$HOME/.nautilo/home/exec/sleep-long.sh <<'SH'
#!/bin/sh
# Sleeps longer than the EXEC-LINUX-04 timeout. Sandbox should kill
# the process tree; the matrix asserts a 'timed out' / non-zero exit
# in the response.
echo SLEEP-START
sleep 30
echo SLEEP-END-SHOULD-NEVER-REACH
SH
chmod 0755 \$HOME/.nautilo/home/exec/sleep-long.sh
"

# Stop BOTH services BEFORE snapshot so the baseline captures the VM in
# a known cold state — per-test `snapshot restore` returns to services-
# stopped and the Runner starts them fresh for each test (avoids
# in-memory state accumulation across restores).
echo "==> Stopping services so baseline captures cold state..."
limactl shell "$VM_NAME" -- sudo -n bash -lc "
  systemctl stop nautilo-relay.service
  systemctl stop nautilo-test.service
  test -s /etc/systemd/system/nautilo-test.service
  test -s /etc/systemd/system/nautilo-relay.service
  sync
"

# --- 7. Take baseline snapshot ----------------------------------------------

echo "==> Taking baseline snapshot: $SNAPSHOT_NAME"
# Lima snapshot uses --tag (flag) not positional. -y disables interactive TTY.
limactl snapshot create "$VM_NAME" --tag "$SNAPSHOT_NAME" -y

# --- 8. Summary -------------------------------------------------------------

cat <<EOF

================================================================
  Nautilo smoke Linux VM ready: $VM_NAME
================================================================

Enter:        limactl shell $VM_NAME
Restore:      limactl snapshot apply $VM_NAME --tag $SNAPSHOT_NAME -y
Teardown:     $SCRIPT_DIR/teardown.sh --linux

Nautilo:      /home/nautilotest/nautilo
Start both:   limactl shell $VM_NAME -- sudo bash -c \\
              'systemctl start nautilo-test.service && systemctl start nautilo-relay.service'
Smoke token:  /etc/nautilo/smoke-token (inside VM, 0644, readable by lima user)
Tool-invoke:  curl -H "Authorization: Bearer \$(cat /etc/nautilo/smoke-token)" \\
              http://127.0.0.1:3001/api/test/ping
Relay status: limactl shell $VM_NAME -- sudo journalctl -u nautilo-relay -n 20

Start OSS:    limactl shell $VM_NAME -- sudo -u nautilotest bash -lc \\
              'cd /home/nautilotest/nautilo && ~/.bun/bin/bun run oss'

EOF
