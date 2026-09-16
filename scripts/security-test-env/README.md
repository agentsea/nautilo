# Nautilo Security Testing Environment

Disposable VMs for safely running destructive commands against
Nautilo's security controls (D053 command scanner, path deny, content
scanner; D060 OS sandbox; D103 network egress containment; D061 approval
flow as it lands).

**Status**: Phase 1 scaffolding — scripts are stubs. Filled in over
the course of D063 Phase 1.

## What This Is

Running `rm -rf /etc` or `cat ~/.ssh/id_rsa` on a developer's machine
to test security controls is reckless. This directory ships scripts
that:

1. Provision a Lima Ubuntu 24.04 VM and a Tart macOS Sonoma VM as
   **disposable sandboxes**.
2. Plant **honeypot fixtures** (fake `~/.ssh/id_rsa`, `~/.aws/credentials`,
   etc. with `FAKE_NAUTILO_SMOKE_*` sentinel content) so missed reads
   surface loudly without leaking real secrets.
3. Take **baseline snapshots** so destructive commands that slip past
   the scanners break only the VM, which restores in ~3 seconds.

## Prerequisites

- macOS on Apple Silicon (host)
- [Lima](https://lima-vm.io/) — `brew install lima`
- [Tart](https://tart.run/) — install depends on host macOS:
  - **macOS Sequoia (15+)**: `brew install cirruslabs/cli/tart`
  - **macOS Sonoma (14.x)**: `brew install --ignore-dependencies cirruslabs/cli/tart`
    (Tart's `softnet` dependency requires Sequoia but isn't needed for
    our default shared-NAT networking; Tart itself works on Sonoma)
- Bun ≥ 1.3.5 (already required by Nautilo)

## Resource Cost

| Resource | First run | After cache warm |
|----------|-----------|------------------|
| Disk (Lima Ubuntu image + VM) | ~8 GB | ~8 GB |
| Disk (Tart macOS OCI cache) | ~28 GB | ~28 GB (persistent) |
| Disk (Tart baseline + working VMs) | ~50 GB (2 × 25 GB COW) | ~50 GB |
| **Total on-disk** | **~85 GB** | ~85 GB |
| Network (Tart macOS download) | ~22 GB (one-time) | 0 |
| Wall time — `setup.sh --linux` | ~5 min | ~2 min |
| Wall time — `setup.sh --macos` | ~10–15 min | ~10 min |

Tart caches the macOS base image at `~/.tart/cache/OCIs/...` by its
sha256 digest. Once pulled, subsequent `tart clone` invocations use
the cache (no network). Clearing: `tart prune` (loses cache, forces
re-download) or `rm -rf ~/.tart/cache` (same effect).

The macOS base image is **pinned to a specific sha256 digest** in
`setup-macos.sh` (not `:latest`) for reproducibility. See that file
for the upgrade procedure.

## Usage

```bash
# Provision both VMs (first Tart run: ~45 min IPSW download)
./setup.sh --all

# Or just one
./setup.sh --linux
./setup.sh --macos

# Plant honeypot fixtures inside a VM
limactl shell nautilo-smoke-linux -- /path/to/nautilo/scripts/security-test-env/honeypot.sh plant

# Take / restore snapshots from the host
./snapshot.sh take    linux baseline
./snapshot.sh restore linux baseline

# Remove the VMs
./teardown.sh --all
```

The macOS smoke server uses a system LaunchDaemon. Relay uses the existing
`admin` GUI session and `~/Library/LaunchAgents/com.nautilo.relay.plist` so its
normal login-keychain pairing remains accessible. Setup verifies that session,
provisions the paired credential, and proves an authenticated sandbox dispatch.
Snapshot restores retain stopped services; the smoke Runner restarts the server
and user Relay agent before each tool invocation. Flush guest writes before
capturing a newly provisioned baseline. Teardown removes these jobs with their
owned VM, not from the host computer.

## Files

| File | Purpose | Task |
|------|---------|------|
| `setup.sh` | Top-level dispatcher | 1.1 (done) |
| `setup-linux.sh` | Lima VM provisioning | 1.2 |
| `setup-macos.sh` | Tart VM provisioning | 1.3 |
| `lima-config.yaml` | Lima VM spec | 1.2.1 |
| `tart-config.yaml` | Tart VM spec | 1.3.1 |
| `honeypot.sh` | Plant/restore/verify fake secrets | 1.4 |
| `snapshot.sh` | Uniform snapshot interface | 1.5 |
| `teardown.sh` | Remove VMs | 1.6 |

## Pre-built Tart base image (G2.1)

Bootstrapping the Tart macOS VM on Sonoma hits a reliability wall:
`bun install` inside the VM uses shared-NAT networking, which is
slow + flaky under Apple's vmnet. The fix (ship plan G2.1): pre-bake
bun + Xcode CLT + Nautilo source + `bun install` output into a
published OCI image, so `setup-macos.sh` can `tart pull` + skip the
network-heavy provisioning steps entirely.

### Consuming the pre-built image (typical path)

1. Look up the current published digest — `BASE_IMAGE_PREBUILT` in
   `setup-macos.sh`. If set to a `ghcr.io/agentsea/…@sha256:…` URL,
   the script is on the fast path.
2. Run `./setup.sh --macos`. It pulls the pre-built image, clones
   into a working VM, overlays the operator's current HEAD source
   on top (`tar --keep-newer-files`), runs a fast `bun install
   --frozen-lockfile` to catch drift, then continues with honeypot
   plant + snapshot as usual.
3. Total wall time vs. first-from-scratch path: ~2–3 min vs. 10–15 min.

If `BASE_IMAGE_PREBUILT` is empty, `setup-macos.sh` now fails loud by
default instead of silently falling back to raw Cirrus bootstrap. The raw
Sonoma image depends on guest DNS + registry access for `bun.sh` and
`bun install`, which is exactly the unreliable shared-NAT path we are
trying to remove from normal D103 Phase F runs.

The raw bootstrap path remains available for local VM diagnostics:

```bash
NAUTILO_TART_ALLOW_RAW_BOOTSTRAP=1 ./scripts/security-test-env/setup.sh --macos
```

Normal PR validation uses the qualified baseline supplied through the release
channel. Pin its digest first, then run `./setup.sh --macos`.

### Updating the baseline image pin

The official baseline is supplied through the release channel. This source
tree contains its setup consumer; it does not publish baseline images.

Refresh the pinned digest when the dependency lockfile, required VM tools, or
macOS base changes enough to require a new baseline. Ordinary source changes
are overlaid by `setup-macos.sh` during test provisioning.

Before changing `BASE_IMAGE_PREBUILT`, verify the replacement image's digest,
record its baked Nautilo source SHA, and exercise the macOS smoke consumer.
Commit the exact `@sha256:…` pin with that evidence. A mutable tag or successful
upload alone does not establish which bytes a test will consume.

## Environment Variables

The smoke runner and the test-mode server routes consume a small set
of env vars. Defaults are chosen so a host-side `bun nautilo-smoke run`
works without setting anything; the VM harness + middleware-invocation
mode (D063 Phase 6) layer on a few extras.

| Var | Consumer | Default | Purpose |
|-----|----------|---------|---------|
| `NAUTILO_TEST_MODE` | `packages/server` | unset (routes 404) | Set to `1` at server boot to register `/api/test/security-scan` and `/api/test/tool-invoke`. Both routes are 404-invisible when unset. |
| `NAUTILO_SMOKE_TOKEN` | `packages/server` + `nautilo-smoke` | (required when `NAUTILO_TEST_MODE=1`) | Bearer token for the test-mode routes. Read from `~/.nautilo/smoke-token` by convention. |
| `NAUTILO_SMOKE_WORKSPACE_ROOT` | `packages/server` (tool-invoke route) | unset | Fallback workspace root used when a `tool-invocation` test row omits `workspace_root`. Precedence: request body > this env var > undefined (zone resolution fails). Leading `~` is expanded against `$HOME`. Useful for keeping expected-outcomes rows host-agnostic — set this to the planted honeypot workspace (typically `~/nautilo-smoke-workspace`) before running `nautilo-smoke run --filter=FILE-*`. |

Setting the workspace root for a FILE-* matrix run:

```bash
# Plant the honeypot workspace first (creates ~/nautilo-smoke-workspace
# with hijack-key → ~/.ssh/id_rsa + hijack-dir → ~/.ssh symlinks)
./honeypot.sh plant

# Then start the server with the env vars the tool-invoke route reads
NAUTILO_TEST_MODE=1 \
NAUTILO_SMOKE_TOKEN="$(cat ~/.nautilo/smoke-token)" \
NAUTILO_SMOKE_WORKSPACE_ROOT=~/nautilo-smoke-workspace \
  bun run --cwd packages/server dev
```

## See Also

- [Smoke runner](../../packages/smoke-runner/)
- [Sandbox implementation](../../packages/sandbox/README.md)
- [`expected-outcomes.json`](./expected-outcomes.json) (created in task 1.8)

## D103 network egress matrix (`SANDBOX-NET-*`)

These rows use the **tool-invocation** layer and **test-mode posture overrides**
(`deployment_mode`, `network_policy`) so each case exercises the relay sandbox
envelope without mutating server `posture.json`. Each row sets
`platforms` so the runner only schedules it on the right VM driver.

| Test id | Platform | What it proves |
|---------|------------|----------------|
| `SANDBOX-NET-LINUX-01` | Linux | `networkPolicy.mode=isolated` → `bwrap --unshare-net`; outbound HTTPS fails; shell prints `NETWORK-BLOCKED`. |
| `SANDBOX-NET-MACOS-01` | macOS | Isolated Seatbelt profile denies outbound network; same `NETWORK-BLOCKED` marker. |
| `SANDBOX-NET-MACOS-02` | macOS | `proxy-allowlist` with `example.com:443` → curl via injected proxy succeeds (`NETWORK-ALLOWLIST-OK`). |
| `SANDBOX-NET-MACOS-03` | macOS | Non-allowlisted host denied at proxy (`NETWORK-DENY-OK`). |
| `SANDBOX-NET-MACOS-04` | macOS | Clearing `HTTP(S)_PROXY` in the shell does not bypass Seatbelt; direct egress still blocked (`NETWORK-BYPASS-BLOCKED`). |

Linux **`proxy-allowlist`** OS enforcement is intentionally **not** claimed in
these rows. Verify the current sandbox implementation and platform acceptance
before claiming Linux allowlist enforcement.

Latest D103 Phase F status:

- `SANDBOX-NET-LINUX-01` passes on Lima.
- `SANDBOX-NET-MACOS-01`…`04` pass on Tart using the pinned prebuilt
  baseline `ghcr.io/agentsea/nautilo-smoke-macos-baseline@sha256:98cb2d2baa73c654c9f9529f05f14e2407c271dba7bc458416f6cd2fba3e8032`.

Preview the exact Phase F schedule without starting VMs:

```bash
bun bin/nautilo-smoke/src/index.ts run --only=SANDBOX-NET-* --dry-run
```

Run a subset from the repo root (`--only` is a glob against test ids):

```bash
bun bin/nautilo-smoke/src/index.ts run --platform=linux --only=SANDBOX-NET-LINUX-01
bun bin/nautilo-smoke/src/index.ts run --platform=macos --only=SANDBOX-NET-MACOS-*
```
