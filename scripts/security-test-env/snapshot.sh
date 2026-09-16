#!/usr/bin/env bash
#
# snapshot.sh — Uniform snapshot interface over Lima and Tart.
#
# Hides the per-platform mechanism:
#   - Lima: limactl snapshot create/apply/list (live qcow2 snapshots)
#   - Tart: clone-from-current pattern (destroy working clone, re-clone
#     baseline or a named snapshot VM)
#
# Each snapshot operation should complete in <5 seconds on both platforms.
#
# D063 Phase 1 task 1.5.

set -euo pipefail

LINUX_VM="nautilo-smoke-linux"
MACOS_VM="nautilo-smoke-macos"

usage() {
  cat <<EOF
Usage: snapshot.sh <command> <platform> [<name>]

Commands:
  take     <linux|macos> <name>  Create a named snapshot
  restore  <linux|macos> <name>  Restore from a named snapshot
  list     <linux|macos>         List snapshots

Options:
  -h, --help  Print this message.

Snapshots:
  Linux: live qcow2 snapshots via limactl snapshot create --tag <name>
  macOS: Tart clones named <vm>-snap-<name>; restore destroys and re-clones
EOF
}

die() {
  echo "snapshot.sh: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Lima operations
# ---------------------------------------------------------------------------

lima_take() {
  local name="$1"
  command -v limactl >/dev/null || die "limactl not installed"
  limactl snapshot create "$LINUX_VM" --tag "$name" -y
  echo "snapshot.sh: Lima snapshot '$name' created for $LINUX_VM"
}

lima_restore() {
  local name="$1"
  command -v limactl >/dev/null || die "limactl not installed"

  # Lima's snapshot apply (QEMU `loadvm`) restores disk + RAM state,
  # but the SSH usernet forwarder gets into an inconsistent state
  # afterward (known limitation). We work around it by stop+start
  # post-apply — the VM boots fresh from the restored disk, SSH
  # re-establishes cleanly. ~20s total vs ~2s for apply alone; the
  # correctness guarantee is worth the extra time.
  echo "snapshot.sh: applying Lima snapshot '$name' (takes ~20s)..."
  limactl snapshot apply "$LINUX_VM" --tag "$name" -y

  # Kill any stuck ssh multiplex connections
  pkill -f "ssh.*$LINUX_VM" 2>/dev/null || true
  rm -f "$HOME/.lima/$LINUX_VM/ssh.sock"* 2>/dev/null || true

  # Cleanly stop and start
  limactl stop "$LINUX_VM" >/dev/null 2>&1 || true
  limactl start "$LINUX_VM" >/dev/null 2>&1

  # Wait for SSH to be ready
  for attempt in $(seq 1 60); do
    if limactl shell "$LINUX_VM" -- true 2>/dev/null; then
      echo "snapshot.sh: Lima VM $LINUX_VM restored to '$name' and ready"
      return 0
    fi
    sleep 1
  done
  die "VM did not return to SSH-ready state after snapshot restore cycle"
}

lima_list() {
  command -v limactl >/dev/null || die "limactl not installed"
  limactl snapshot list "$LINUX_VM"
}

# ---------------------------------------------------------------------------
# Tart operations
# ---------------------------------------------------------------------------

tart_take() {
  local name="$1"
  command -v tart >/dev/null || die "tart not installed"
  local snap_vm="${MACOS_VM}-snap-${name}"
  # Stop working VM, clone it to the snapshot name, restart working VM
  tart stop "$MACOS_VM" 2>/dev/null || true
  # If a previous snapshot with this name exists, remove it
  tart list --format=json 2>/dev/null | grep -q "\"$snap_vm\"" && tart delete "$snap_vm" || true
  tart clone "$MACOS_VM" "$snap_vm"
  # Restart the working VM in the background (no --graphics for headless)
  nohup tart run "$MACOS_VM" --no-graphics >/dev/null 2>&1 &
  # Wait for the working VM to be reachable
  for attempt in $(seq 1 60); do
    if tart ip "$MACOS_VM" >/dev/null 2>&1; then
      echo "snapshot.sh: Tart snapshot '$name' created (as VM $snap_vm), working VM back online"
      return 0
    fi
    sleep 2
  done
  die "Working Tart VM did not come back online after snapshot take"
}

tart_restore() {
  local name="$1"
  command -v tart >/dev/null || die "tart not installed"

  # For the special snapshot name "baseline", we restore by destroying
  # the working VM and cloning fresh from the baseline VM (which has
  # the provisioned services stopped — see setup-macos.sh).
  # Any other name restores from a named snapshot VM.
  local source_vm
  if [ "$name" = "baseline" ]; then
    source_vm="nautilo-smoke-macos-baseline"
  else
    source_vm="${MACOS_VM}-snap-${name}"
  fi

  tart list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$source_vm" \
    || die "snapshot source '$source_vm' not found"

  tart stop "$MACOS_VM" 2>/dev/null || true
  tart delete "$MACOS_VM" 2>/dev/null || true
  tart clone "$source_vm" "$MACOS_VM"
  nohup tart run "$MACOS_VM" --no-graphics >/dev/null 2>&1 &

  # Wait for the guest agent (not just IP — we need to exec honeypot plant).
  for attempt in $(seq 1 60); do
    if tart exec "$MACOS_VM" true 2>/dev/null; then
      break
    fi
    sleep 2
    if [ "$attempt" -eq 60 ]; then
      die "VM did not come online after restore"
    fi
  done

  # Re-plant honeypot fixtures to reset the destructive-test fixture state.
  # The Runner then starts the server daemon and user Relay agent fresh.
  tart exec "$MACOS_VM" bash -c 'sh $HOME/nautilo/scripts/security-test-env/honeypot.sh plant' >/dev/null 2>&1 || true

  echo "snapshot.sh: Tart VM $MACOS_VM restored from '$source_vm' (honeypot re-planted)"
}

tart_list() {
  command -v tart >/dev/null || die "tart not installed"
  tart list --format=json 2>/dev/null | jq -r ".[] | select(.Name | startswith(\"${MACOS_VM}-snap-\")) | .Name" 2>/dev/null \
    || tart list | grep "${MACOS_VM}-snap-" || echo "(no snapshots found)"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

CMD="${1:-}"
PLATFORM="${2:-}"
NAME="${3:-}"

case "$CMD" in
  -h|--help)  usage; exit 0 ;;
  take|restore)
    [ -z "$PLATFORM" ] && die "$CMD: platform required (linux or macos)"
    [ -z "$NAME" ] && die "$CMD: name required"
    case "$PLATFORM" in
      linux) [ "$CMD" = "take" ] && lima_take "$NAME" || lima_restore "$NAME" ;;
      macos) [ "$CMD" = "take" ] && tart_take "$NAME" || tart_restore "$NAME" ;;
      *) die "unknown platform: $PLATFORM (expected 'linux' or 'macos')" ;;
    esac
    ;;
  list)
    [ -z "$PLATFORM" ] && die "list: platform required (linux or macos)"
    case "$PLATFORM" in
      linux) lima_list ;;
      macos) tart_list ;;
      *) die "unknown platform: $PLATFORM" ;;
    esac
    ;;
  "")         usage >&2; exit 64 ;;
  *)          echo "snapshot.sh: unknown command: $CMD" >&2; usage >&2; exit 64 ;;
esac
