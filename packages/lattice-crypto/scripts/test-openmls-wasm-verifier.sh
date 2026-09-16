#!/usr/bin/env bash
#
# Focused fail-closed tests for artifact inventory and SHA256SUMS parsing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY="$SCRIPT_DIR/verify-openmls-wasm.sh"
SOURCE_DIR="$PACKAGE_DIR/vendor/openmls-wasm"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nautilo-openmls-verifier-test.XXXXXX")"
cleanup() {
  find "$WORK_DIR" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

copy_fixture() {
  local target="$1"
  mkdir -p "$target"
  cp "$SOURCE_DIR"/openmls_wasm.d.ts "$target/"
  cp "$SOURCE_DIR"/openmls_wasm.js "$target/"
  cp "$SOURCE_DIR"/openmls_wasm_bg.wasm "$target/"
  cp "$SOURCE_DIR"/openmls_wasm_bg.wasm.d.ts "$target/"
  cp "$SOURCE_DIR"/SHA256SUMS "$target/"
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"$WORK_DIR/stdout" 2>"$WORK_DIR/stderr"; then
    printf 'error: verifier unexpectedly accepted %s\n' "$label" >&2
    exit 1
  fi
}

valid="$WORK_DIR/valid"
copy_fixture "$valid"
"$VERIFY" --checksums-only "$valid" "$valid/SHA256SUMS"
"$VERIFY" --surface-only "$valid"
"$VERIFY" --policy-only "$PACKAGE_DIR/openmls-wasm/Cargo.toml"

direct_web_sys="$WORK_DIR/direct-web-sys.toml"
cp "$PACKAGE_DIR/openmls-wasm/Cargo.toml" "$direct_web_sys"
printf '\n[dependencies.web-sys]\nversion = "0.3"\nfeatures = ["console"]\n' \
  >> "$direct_web_sys"
expect_failure "a direct web-sys dependency" \
  "$VERIFY" --policy-only "$direct_web_sys"

expanded_host_surface="$WORK_DIR/expanded-host-surface"
copy_fixture "$expanded_host_surface"
printf '\nconst unauthorizedSocket = WebSocket;\n' \
  >> "$expanded_host_surface/openmls_wasm.js"
expect_failure "an expanded JavaScript host capability" \
  "$VERIFY" --surface-only "$expanded_host_surface"

substituted="$WORK_DIR/substituted"
copy_fixture "$substituted"
printf '\0' >> "$substituted/openmls_wasm_bg.wasm"
expect_failure "artifact substitution" \
  "$VERIFY" --checksums-only "$substituted" "$substituted/SHA256SUMS"

missing="$WORK_DIR/missing"
copy_fixture "$missing"
rm "$missing/openmls_wasm.d.ts"
expect_failure "missing artifact" \
  "$VERIFY" --checksums-only "$missing" "$missing/SHA256SUMS"

extra="$WORK_DIR/extra"
copy_fixture "$extra"
touch "$extra/unaccounted.bin"
expect_failure "extra artifact" \
  "$VERIFY" --checksums-only "$extra" "$extra/SHA256SUMS"

duplicate="$WORK_DIR/duplicate"
copy_fixture "$duplicate"
head -n 1 "$duplicate/SHA256SUMS" >> "$duplicate/SHA256SUMS"
expect_failure "duplicate manifest entry" \
  "$VERIFY" --checksums-only "$duplicate" "$duplicate/SHA256SUMS"

traversal="$WORK_DIR/traversal"
copy_fixture "$traversal"
first_digest="$(awk 'NR == 1 { print $1 }' "$traversal/SHA256SUMS")"
printf '%s  ../openmls_wasm.d.ts\n' "$first_digest" > "$traversal/SHA256SUMS"
expect_failure "manifest path traversal" \
  "$VERIFY" --checksums-only "$traversal" "$traversal/SHA256SUMS"

malformed="$WORK_DIR/malformed"
copy_fixture "$malformed"
sed '1s/  / /' "$malformed/SHA256SUMS" > "$malformed/SHA256SUMS.new"
mv "$malformed/SHA256SUMS.new" "$malformed/SHA256SUMS"
expect_failure "malformed manifest spacing" \
  "$VERIFY" --checksums-only "$malformed" "$malformed/SHA256SUMS"

printf '%s\n' "OpenMLS WASM verifier fail-closed tests passed."
