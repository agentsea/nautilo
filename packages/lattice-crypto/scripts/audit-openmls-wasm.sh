#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATE_DIR="$PACKAGE_DIR/openmls-wasm"
AUDIT_BIN="${CARGO_AUDIT_BIN:-$(command -v cargo-audit || true)}"
# shellcheck source=openmls-wasm-common.sh
source "$SCRIPT_DIR/openmls-wasm-common.sh"

[[ -n "$AUDIT_BIN" && -x "$AUDIT_BIN" ]] || {
  printf '%s\n' \
    "error: cargo-audit 0.22.2 is required; set CARGO_AUDIT_BIN to its exact path" >&2
  exit 1
}
actual_version="$("$AUDIT_BIN" --version)"
[[ "$actual_version" == "cargo-audit 0.22.2" ]] || {
  printf "error: expected 'cargo-audit 0.22.2', got '%s'\n" "$actual_version" >&2
  exit 1
}

tree_file="$(mktemp "${TMPDIR:-/tmp}/nautilo-openmls-tree.XXXXXX")"
feature_tree_file="$(mktemp "${TMPDIR:-/tmp}/nautilo-openmls-features.XXXXXX")"
cleanup() {
  rm -f "$tree_file" "$feature_tree_file"
}
trap cleanup EXIT

openmls_assert_manifest_policy "$CRATE_DIR/Cargo.toml"

cargo tree \
  --manifest-path "$CRATE_DIR/Cargo.toml" \
  --locked \
  --target wasm32-unknown-unknown \
  -e normal > "$tree_file"
cargo tree \
  --manifest-path "$CRATE_DIR/Cargo.toml" \
  --locked \
  --target wasm32-unknown-unknown \
  -e features > "$feature_tree_file"

for forbidden in hpke-rs-libcrux libcrux-aesgcm libcrux-chacha20poly1305 proc-macro-error2; do
  if grep -F "$forbidden" "$tree_file" >/dev/null; then
    printf 'error: reviewed lock-only dependency became active: %s\n' "$forbidden" >&2
    exit 1
  fi
done
if grep -F 'web-sys feature "console"' "$feature_tree_file" >/dev/null; then
  printf '%s\n' \
    "error: unused web-sys console capability became active" >&2
  exit 1
fi
grep -F "libcrux-sha3 v0.0.8" "$tree_file" >/dev/null
grep -F \
  "Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519" \
  "$CRATE_DIR/src/lib.rs" >/dev/null

"$AUDIT_BIN" audit \
  --file "$CRATE_DIR/Cargo.lock" \
  --ignore RUSTSEC-2026-0209 \
  --ignore RUSTSEC-2026-0211 \
  --ignore RUSTSEC-2026-0124 \
  --ignore RUSTSEC-2026-0212 \
  --ignore RUSTSEC-2026-0207 \
  --ignore RUSTSEC-2026-0208
