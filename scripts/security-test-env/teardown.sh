#!/usr/bin/env bash
#
# teardown.sh — Remove the Nautilo security smoke VMs.
#
# Idempotent: safe to run when VMs are already gone (exits 0).
#
# D063 Phase 1 task 1.6.

set -euo pipefail

LINUX_VM="nautilo-smoke-linux"
MACOS_VM="nautilo-smoke-macos"
MACOS_BASELINE="nautilo-smoke-macos-baseline"

usage() {
  cat <<EOF
Usage: teardown.sh [--linux|--macos|--all] [--help]

Remove the Nautilo security smoke VMs.

Options:
  --linux    Remove only the Lima VM ($LINUX_VM).
  --macos    Remove the Tart VMs ($MACOS_VM, $MACOS_BASELINE, any snapshots).
  --all      Remove both (default).
  -h, --help Print this message.
EOF
}

teardown_linux() {
  if ! command -v limactl >/dev/null 2>&1; then
    echo "teardown.sh: limactl not installed; skipping linux teardown."
    return 0
  fi
  # Is the VM actually present?
  if limactl list --format=json 2>/dev/null | grep -q "\"name\":\"$LINUX_VM\""; then
    echo "==> Stopping Lima VM: $LINUX_VM"
    limactl stop --force "$LINUX_VM" 2>/dev/null || true
    echo "==> Deleting Lima VM: $LINUX_VM"
    limactl delete --force "$LINUX_VM"
  else
    echo "teardown.sh: Lima VM $LINUX_VM not present — nothing to do."
  fi
}

teardown_macos() {
  if ! command -v tart >/dev/null 2>&1; then
    echo "teardown.sh: tart not installed; skipping macos teardown."
    return 0
  fi
  # Tart doesn't have a --force flag; stop-then-delete is fine for stopped VMs
  for vm in "$MACOS_VM" "$MACOS_BASELINE"; do
    if tart list 2>/dev/null | awk 'NR>1 {print $2}' | grep -qx "$vm"; then
      echo "==> Removing Tart VM: $vm"
      tart stop "$vm" 2>/dev/null || true
      tart delete "$vm"
    fi
  done
  # Remove any per-test snapshot clones
  local snaps
  snaps="$(tart list 2>/dev/null | awk 'NR>1 {print $2}' | grep "^${MACOS_VM}-snap-" || true)"
  if [ -n "$snaps" ]; then
    echo "==> Removing Tart snapshot VMs:"
    echo "$snaps" | while IFS= read -r snap; do
      [ -z "$snap" ] && continue
      echo "    $snap"
      tart delete "$snap" 2>/dev/null || true
    done
  fi
}

TARGETS=""
case "${1:---all}" in
  -h|--help)  usage; exit 0 ;;
  --linux)    TARGETS="linux" ;;
  --macos)    TARGETS="macos" ;;
  --all)      TARGETS="linux macos" ;;
  *)          echo "teardown.sh: unknown option: $1" >&2; usage >&2; exit 64 ;;
esac

for target in $TARGETS; do
  case "$target" in
    linux) teardown_linux ;;
    macos) teardown_macos ;;
  esac
done

echo "teardown.sh: done."
