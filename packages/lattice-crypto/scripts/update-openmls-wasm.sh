#!/usr/bin/env bash
#
# Deliberately rebuild and replace the four committed OpenMLS WASM artifacts.
# The build happens in isolation first; the vendor directory is touched only
# after the pinned build succeeds and its exact output set is validated.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=openmls-wasm-common.sh
source "$SCRIPT_DIR/openmls-wasm-common.sh"

[[ "$#" -eq 0 ]] || openmls_die "usage: $0"

VENDOR_DIR="$PACKAGE_DIR/vendor/openmls-wasm"
MANIFEST="$VENDOR_DIR/SHA256SUMS"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nautilo-openmls-update.XXXXXX")"
cleanup() {
  find "$WORK_DIR" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

printf '%s\n' "==> Verifying the OpenMLS dependency policy"
openmls_assert_manifest_policy "$PACKAGE_DIR/openmls-wasm/Cargo.toml"

printf '%s\n' "==> Building replacement OpenMLS WASM artifacts in isolation"
REBUILT_DIR="$(openmls_build_to_temp "$PACKAGE_DIR" "$WORK_DIR")" || exit 1
printf '%s\n' "==> Verifying replacement OpenMLS WASM host capabilities"
openmls_verify_artifact_surface "$PACKAGE_DIR" "$REBUILT_DIR"
printf '%s\n' "==> Exercising the temporary build (create/join/update/export/restore/remove)"
openmls_smoke_artifacts "$PACKAGE_DIR" "$REBUILT_DIR"

mkdir -p "$VENDOR_DIR"
openmls_assert_artifact_set "$REBUILT_DIR" false
for basename in "${OPENMLS_ARTIFACTS[@]}"; do
  cp "$REBUILT_DIR/$basename" "$VENDOR_DIR/$basename"
done
openmls_write_sha256sums "$VENDOR_DIR" "$MANIFEST"
openmls_verify_sha256sums "$VENDOR_DIR" "$MANIFEST"

printf '%s\n' "OpenMLS WASM artifacts updated and checksummed."
printf '%s\n' "Run 'bun run --cwd packages/lattice-crypto wasm:verify' before committing."
