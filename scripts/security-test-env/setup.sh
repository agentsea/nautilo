#!/usr/bin/env bash
#
# Nautilo security testing environment — top-level setup dispatcher.
#
# Provisions disposable VMs (Lima + Tart) for safely testing Nautilo's
# security controls against real destructive commands. See
# scripts/security-test-env/README.md for prerequisites and usage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage: setup.sh [--linux|--macos|--all] [--help]

Provision disposable VMs for Nautilo security smoke testing.

Options:
  --linux    Provision only the Lima (Ubuntu 24.04) VM.
  --macos    Provision only the Tart (macOS Sonoma) VM.
  --all      Provision both (default).
  -h, --help Print this message and exit.

Notes:
  First-run Tart IPSW download takes ~30-45 minutes (one-time per base
  image version). Subsequent runs are fast.

See:
  scripts/security-test-env/README.md
EOF
}

TARGETS=""
case "${1:---all}" in
  -h|--help)  usage; exit 0 ;;
  --linux)    TARGETS="linux" ;;
  --macos)    TARGETS="macos" ;;
  --all)      TARGETS="linux macos" ;;
  *)          echo "setup.sh: unknown option: $1" >&2; usage >&2; exit 64 ;;
esac

FAIL=0
for target in $TARGETS; do
  echo "==> Setting up $target VM..."
  if "$SCRIPT_DIR/setup-$target.sh"; then
    echo "==> $target VM ready"
  else
    echo "!!  $target setup failed" >&2
    FAIL=1
  fi
done

if [ $FAIL -ne 0 ]; then
  echo "setup.sh: one or more platform setups failed." >&2
  exit 1
fi

cat <<EOF

Summary:
  VMs ready. Next steps:
    limactl shell nautilo-smoke-linux        # enter Linux VM
    tart ssh nautilo-smoke-macos             # enter macOS VM
    ./snapshot.sh restore <platform> baseline  # restore to clean state

See scripts/security-test-env/README.md for smoke-test usage.
EOF
