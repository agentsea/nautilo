#!/usr/bin/env bash
#
# Verify the committed OpenMLS WASM artifact without modifying it.
#
# Normal mode checks committed SHA-256 evidence, rebuilds into a temporary
# directory with the exact pinned toolchain, and requires byte equality for all
# four outputs. The private --checksums-only mode is used by the focused
# fail-closed verifier tests and intentionally performs no build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=openmls-wasm-common.sh
source "$SCRIPT_DIR/openmls-wasm-common.sh"

if [[ "${1:-}" == "--checksums-only" ]]; then
  [[ "$#" -eq 3 ]] ||
    openmls_die "usage: $0 --checksums-only <artifact-dir> <manifest>"
  openmls_verify_sha256sums "$2" "$3"
  exit 0
fi
if [[ "${1:-}" == "--policy-only" ]]; then
  [[ "$#" -eq 2 ]] ||
    openmls_die "usage: $0 --policy-only <Cargo.toml>"
  openmls_assert_manifest_policy "$2"
  exit 0
fi
if [[ "${1:-}" == "--surface-only" ]]; then
  [[ "$#" -eq 2 ]] ||
    openmls_die "usage: $0 --surface-only <artifact-dir>"
  openmls_verify_artifact_surface "$PACKAGE_DIR" "$2"
  exit 0
fi
[[ "$#" -eq 0 ]] || openmls_die "usage: $0"

VENDOR_DIR="$PACKAGE_DIR/vendor/openmls-wasm"
MANIFEST="$VENDOR_DIR/SHA256SUMS"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nautilo-openmls-verify.XXXXXX")"
cleanup() {
  find "$WORK_DIR" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

printf '%s\n' "==> Verifying the OpenMLS dependency policy"
openmls_assert_manifest_policy "$PACKAGE_DIR/openmls-wasm/Cargo.toml"

printf '%s\n' "==> Verifying committed OpenMLS WASM checksums"
openmls_verify_sha256sums "$VENDOR_DIR" "$MANIFEST"

printf '%s\n' "==> Verifying committed OpenMLS WASM host capabilities"
openmls_verify_artifact_surface "$PACKAGE_DIR" "$VENDOR_DIR"

printf '%s\n' "==> Rebuilding OpenMLS WASM in an isolated temporary directory"
REBUILT_DIR="$(openmls_build_to_temp "$PACKAGE_DIR" "$WORK_DIR")" || exit 1

printf '%s\n' "==> Verifying rebuilt OpenMLS WASM host capabilities"
openmls_verify_artifact_surface "$PACKAGE_DIR" "$REBUILT_DIR"

printf '%s\n' "==> Exercising the temporary build (create/join/update/export/restore/remove)"
openmls_smoke_artifacts "$PACKAGE_DIR" "$REBUILT_DIR"

printf '%s\n' "==> Requiring exact bytes for JS, TypeScript, and WASM outputs"
openmls_compare_artifacts "$VENDOR_DIR" "$REBUILT_DIR"

printf '%s\n' "OpenMLS WASM verification passed: committed artifacts are byte-reproducible."
