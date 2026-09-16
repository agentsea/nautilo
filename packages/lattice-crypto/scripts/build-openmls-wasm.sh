#!/usr/bin/env bash
#
# Compatibility entry point for maintainers who used the lattice-lab command.
# Updating committed artifacts is intentionally explicit and is implemented by
# update-openmls-wasm.sh. Ordinary package development consumes the committed
# vendor output and needs no Rust installation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/update-openmls-wasm.sh" "$@"
