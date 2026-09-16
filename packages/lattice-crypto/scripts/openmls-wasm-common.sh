#!/usr/bin/env bash

# Shared, source-only helpers for the OpenMLS WASM verification/update scripts.
# Do not execute this file directly.

export LC_ALL=C

OPENMLS_RUSTC_VERSION="rustc 1.96.1 (31fca3adb 2026-06-26)"
OPENMLS_CARGO_VERSION="cargo 1.96.1 (356927216 2026-06-26)"
OPENMLS_WASM_PACK_VERSION="wasm-pack 0.13.1"
OPENMLS_WASM_BINDGEN_VERSION="wasm-bindgen 0.2.126"
OPENMLS_WASM_OPT_VERSION="wasm-opt version 117 (version_117)"
OPENMLS_RUST_TOOLCHAIN="1.96.1"
OPENMLS_RUST_TARGET="wasm32-unknown-unknown"
OPENMLS_BUILDER_IMAGE="rust@sha256:d99f7b31f49909348dc59b51f3c95d1efded1701ffb222f095aaab7de3c4abd8"
OPENMLS_WASM_PACK_SHA256="c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539"
OPENMLS_WASM_BINDGEN_SHA256="064948d58e2d6c0a745216477a639ba696216d6309aaa902939d1b865b1d869d"
OPENMLS_BINARYEN_SHA256="3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212"

OPENMLS_ARTIFACTS=(
  "openmls_wasm.d.ts"
  "openmls_wasm.js"
  "openmls_wasm_bg.wasm"
  "openmls_wasm_bg.wasm.d.ts"
)

openmls_die() {
  printf 'error: %s\n' "$*" >&2
  return 1
}

openmls_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    openmls_die "neither sha256sum nor shasum is available"
  fi
}

openmls_is_artifact() {
  local candidate="$1"
  local artifact
  for artifact in "${OPENMLS_ARTIFACTS[@]}"; do
    if [[ "$candidate" == "$artifact" ]]; then
      return 0
    fi
  done
  return 1
}

openmls_assert_artifact_set() {
  local artifact_dir="$1"
  local allow_manifest="${2:-false}"
  local entry basename
  local count=0

  [[ -d "$artifact_dir" ]] || {
    openmls_die "artifact directory does not exist: $artifact_dir"
    return 1
  }

  shopt -s nullglob dotglob
  for entry in "$artifact_dir"/*; do
    basename="${entry##*/}"
    if [[ "$allow_manifest" == "true" && "$basename" == "SHA256SUMS" ]]; then
      [[ -f "$entry" && ! -L "$entry" ]] || {
        openmls_die "SHA256SUMS must be a regular, non-symlink file"
        return 1
      }
      continue
    fi
    openmls_is_artifact "$basename" || {
      openmls_die "unexpected vendored artifact entry: $basename"
      return 1
    }
    [[ -f "$entry" && ! -L "$entry" ]] || {
      openmls_die "artifact must be a regular, non-symlink file: $basename"
      return 1
    }
    count=$((count + 1))
  done
  shopt -u nullglob dotglob

  [[ "$count" -eq "${#OPENMLS_ARTIFACTS[@]}" ]] || {
    openmls_die "expected ${#OPENMLS_ARTIFACTS[@]} artifacts, found $count"
    return 1
  }

  for basename in "${OPENMLS_ARTIFACTS[@]}"; do
    [[ -f "$artifact_dir/$basename" && ! -L "$artifact_dir/$basename" ]] || {
      openmls_die "missing regular artifact: $basename"
      return 1
    }
  done
}

openmls_assert_manifest_policy() {
  local manifest="$1"

  [[ -f "$manifest" && ! -L "$manifest" ]] || {
    openmls_die "Cargo manifest must be a regular, non-symlink file: $manifest"
    return 1
  }
  if grep -Eq \
    '^[[:space:]]*\[dependencies\.web-sys\][[:space:]]*(#.*)?$' \
    "$manifest"; then
    openmls_die \
      "web-sys must not be a direct dependency; retain only target-reachable transitive timing features"
    return 1
  fi
  if grep -Eq \
    '^[[:space:]]*"?web-sys"?[[:space:]]*=' \
    "$manifest"; then
    openmls_die \
      "web-sys must not be a direct dependency; retain only target-reachable transitive timing features"
    return 1
  fi
  if grep -Eq \
    'package[[:space:]]*=[[:space:]]*"web-sys"' \
    "$manifest"; then
    openmls_die \
      "web-sys must not be introduced through a renamed direct dependency"
    return 1
  fi
}

openmls_verify_artifact_surface() {
  local package_dir="$1"
  local artifact_dir="$2"

  command -v bun >/dev/null 2>&1 || {
    openmls_die "bun is required to verify the OpenMLS WASM host surface"
    return 1
  }
  bun run \
    "$package_dir/scripts/verify-openmls-wasm-surface.ts" \
    "$artifact_dir"
}

openmls_verify_sha256sums() {
  local artifact_dir="$1"
  local manifest="$2"
  local line digest basename actual
  local seen="|"
  local count=0

  [[ -f "$manifest" && ! -L "$manifest" ]] || {
    openmls_die "checksum manifest must be a regular, non-symlink file: $manifest"
    return 1
  }
  openmls_assert_artifact_set \
    "$artifact_dir" \
    "$([[ "$manifest" == "$artifact_dir/SHA256SUMS" ]] && printf true || printf false)" ||
    return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._-]+)$ ]] || {
      openmls_die "malformed SHA256SUMS line: $line"
      return 1
    }
    digest="${BASH_REMATCH[1]}"
    basename="${BASH_REMATCH[2]}"
    openmls_is_artifact "$basename" || {
      openmls_die "checksum manifest contains unexpected path: $basename"
      return 1
    }
    [[ "$seen" != *"|$basename|"* ]] || {
      openmls_die "checksum manifest contains duplicate artifact: $basename"
      return 1
    }
    seen="${seen}${basename}|"
    actual="$(openmls_sha256 "$artifact_dir/$basename")" || return 1
    [[ "$actual" == "$digest" ]] || {
      openmls_die "checksum mismatch for $basename (expected $digest, got $actual)"
      return 1
    }
    count=$((count + 1))
  done < "$manifest"

  [[ "$count" -eq "${#OPENMLS_ARTIFACTS[@]}" ]] || {
    openmls_die "checksum manifest expected ${#OPENMLS_ARTIFACTS[@]} entries, found $count"
    return 1
  }
  for basename in "${OPENMLS_ARTIFACTS[@]}"; do
    [[ "$seen" == *"|$basename|"* ]] || {
      openmls_die "checksum manifest is missing: $basename"
      return 1
    }
  done
}

openmls_write_sha256sums() {
  local artifact_dir="$1"
  local manifest="$2"
  local temp_manifest="${manifest}.tmp.$$"
  local basename digest

  : > "$temp_manifest"
  for basename in "${OPENMLS_ARTIFACTS[@]}"; do
    digest="$(openmls_sha256 "$artifact_dir/$basename")" || return 1
    printf '%s  %s\n' "$digest" "$basename" >> "$temp_manifest"
  done
  LC_ALL=C sort -k2,2 "$temp_manifest" -o "$temp_manifest"
  mv "$temp_manifest" "$manifest"
}

openmls_resolve_tool() {
  local env_name="$1"
  local command_name="$2"
  local configured="${!env_name:-}"
  local resolved

  if [[ -n "$configured" ]]; then
    [[ -x "$configured" ]] || {
      openmls_die "$env_name is not executable: $configured"
      return 1
    }
    resolved="$configured"
  else
    resolved="$(command -v "$command_name" || true)"
    [[ -n "$resolved" ]] || {
      openmls_die "$command_name is required; see openmls-wasm/README.md"
      return 1
    }
  fi
  (
    cd "$(dirname "$resolved")"
    printf '%s/%s\n' "$PWD" "$(basename "$resolved")"
  )
}

openmls_assert_version() {
  local binary="$1"
  local expected="$2"
  local actual
  actual="$("$binary" --version 2>&1 | head -n 1)"
  [[ "$actual" == "$expected" ]] ||
    openmls_die "wrong $(basename "$binary") version: expected '$expected', got '$actual'"
}

openmls_prepare_tools() {
  local tools_dir="$1"
  local rustc_bin cargo_bin wasm_pack_bin wasm_bindgen_bin wasm_opt_bin

  rustc_bin="$(openmls_resolve_tool RUSTC_BIN rustc)" || return 1
  cargo_bin="$(openmls_resolve_tool CARGO_BIN cargo)" || return 1
  wasm_pack_bin="$(openmls_resolve_tool WASM_PACK_BIN wasm-pack)" || return 1
  wasm_bindgen_bin="$(openmls_resolve_tool WASM_BINDGEN_BIN wasm-bindgen)" || return 1
  wasm_opt_bin="$(openmls_resolve_tool WASM_OPT_BIN wasm-opt)" || return 1

  openmls_assert_version "$rustc_bin" "$OPENMLS_RUSTC_VERSION" || return 1
  openmls_assert_version "$cargo_bin" "$OPENMLS_CARGO_VERSION" || return 1
  openmls_assert_version "$wasm_pack_bin" "$OPENMLS_WASM_PACK_VERSION" || return 1
  openmls_assert_version "$wasm_bindgen_bin" "$OPENMLS_WASM_BINDGEN_VERSION" || return 1
  openmls_assert_version "$wasm_opt_bin" "$OPENMLS_WASM_OPT_VERSION" || return 1

  command -v rustup >/dev/null 2>&1 || {
    openmls_die "rustup is required to verify the installed WASM target"
    return 1
  }
  rustup target list --installed --toolchain "$OPENMLS_RUST_TOOLCHAIN" |
    grep -Fx "$OPENMLS_RUST_TARGET" >/dev/null || {
      openmls_die "$OPENMLS_RUST_TARGET is not installed for Rust $OPENMLS_RUST_TOOLCHAIN"
      return 1
    }

  mkdir -p "$tools_dir" || return 1
  ln -s "$rustc_bin" "$tools_dir/rustc" || return 1
  ln -s "$cargo_bin" "$tools_dir/cargo" || return 1
  ln -s "$wasm_pack_bin" "$tools_dir/wasm-pack" || return 1
  ln -s "$wasm_bindgen_bin" "$tools_dir/wasm-bindgen" || return 1
  ln -s "$wasm_opt_bin" "$tools_dir/wasm-opt" || return 1
}

openmls_build_to_temp_native() {
  local package_dir="$1"
  local work_dir="$2"
  local out_dir="$work_dir/out"
  local tools_dir="$work_dir/tools"
  local cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  local rustflags

  cargo_home="$(cd "$cargo_home" && pwd -P)" || {
    openmls_die "cannot resolve Cargo home: $cargo_home"
    return 1
  }
  rustflags="--remap-path-prefix=$cargo_home=/cargo-home"
  rustflags="$rustflags --remap-path-prefix=$package_dir=/nautilo/lattice-crypto"

  openmls_prepare_tools "$tools_dir" || return 1
  mkdir -p "$out_dir"
  (
    cd "$package_dir/openmls-wasm"
    unset CARGO_ENCODED_RUSTFLAGS
    PATH="$tools_dir:$PATH" \
      CARGO_TARGET_DIR="$work_dir/target" \
      RUSTFLAGS="$rustflags" \
      "$tools_dir/wasm-pack" build \
        --mode no-install \
        --release \
        --target web \
        --out-dir "$out_dir" \
        --out-name openmls_wasm \
        -- \
        --locked
  ) || return 1

  # wasm-pack emits npm-publishing scaffolding that Nautilo does not vendor.
  rm -f \
    "$out_dir/package.json" \
    "$out_dir/.gitignore" \
    "$out_dir/README.md" \
    "$out_dir/LICENSE"
  openmls_assert_artifact_set "$out_dir" false || return 1
  if grep -aFq "$cargo_home" "$out_dir/openmls_wasm_bg.wasm"; then
    openmls_die "rebuilt WASM leaks the local Cargo home path" || return 1
  fi
  if grep -aFq "$package_dir" "$out_dir/openmls_wasm_bg.wasm"; then
    openmls_die "rebuilt WASM leaks the local package path" || return 1
  fi
  printf '%s\n' "$out_dir"
}

openmls_build_to_temp() {
  local package_dir="$1"
  local work_dir="$2"
  local out_dir="$work_dir/out"
  local host_uid host_gid

  command -v docker >/dev/null 2>&1 || {
    openmls_die \
      "Docker is required for the canonical linux/amd64 OpenMLS WASM build"
    return 1
  }
  docker info >/dev/null 2>&1 || {
    openmls_die "Docker is installed but its daemon is unavailable"
    return 1
  }

  host_uid="$(id -u)"
  host_gid="$(id -g)"
  mkdir -p "$work_dir"
  work_dir="$(cd "$work_dir" && pwd -P)"
  out_dir="$work_dir/out"

  docker run --rm --interactive \
    --platform linux/amd64 \
    --mount "type=bind,source=$package_dir,target=/nautilo/lattice-crypto,readonly" \
    --mount "type=bind,source=$work_dir,target=/work" \
    --env "HOST_UID=$host_uid" \
    --env "HOST_GID=$host_gid" \
    --env "WASM_PACK_SHA256=$OPENMLS_WASM_PACK_SHA256" \
    --env "WASM_BINDGEN_SHA256=$OPENMLS_WASM_BINDGEN_SHA256" \
    --env "BINARYEN_SHA256=$OPENMLS_BINARYEN_SHA256" \
    "$OPENMLS_BUILDER_IMAGE" \
    bash -s <<'OPENMLS_CONTAINER' >&2 || return 1
set -euo pipefail

downloads="/work/downloads"
wasm_pack="$downloads/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz"
wasm_bindgen="$downloads/wasm-bindgen-0.2.126-x86_64-unknown-linux-musl.tar.gz"
binaryen="$downloads/binaryen-version_117-x86_64-linux.tar.gz"
restore_host_ownership() {
  chown -R "$HOST_UID:$HOST_GID" /work 2>/dev/null || true
}
trap restore_host_ownership EXIT

mkdir -p "$downloads"
rustup target add --toolchain 1.96.1 wasm32-unknown-unknown
curl --fail --location --silent --show-error --output "$wasm_pack" \
  https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.13.1/wasm-pack-v0.13.1-x86_64-unknown-linux-musl.tar.gz
curl --fail --location --silent --show-error --output "$wasm_bindgen" \
  https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.126/wasm-bindgen-0.2.126-x86_64-unknown-linux-musl.tar.gz
curl --fail --location --silent --show-error --output "$binaryen" \
  https://github.com/WebAssembly/binaryen/releases/download/version_117/binaryen-version_117-x86_64-linux.tar.gz
printf '%s  %s\n' "$WASM_PACK_SHA256" "$wasm_pack" |
  sha256sum --check --strict
printf '%s  %s\n' "$WASM_BINDGEN_SHA256" "$wasm_bindgen" |
  sha256sum --check --strict
printf '%s  %s\n' "$BINARYEN_SHA256" "$binaryen" |
  sha256sum --check --strict

tar -xzf "$wasm_pack" -C "$downloads"
tar -xzf "$wasm_bindgen" -C "$downloads"
tar -xzf "$binaryen" -C "$downloads"

export WASM_PACK_BIN="$downloads/wasm-pack-v0.13.1-x86_64-unknown-linux-musl/wasm-pack"
export WASM_BINDGEN_BIN="$downloads/wasm-bindgen-0.2.126-x86_64-unknown-linux-musl/wasm-bindgen"
export WASM_OPT_BIN="$downloads/binaryen-version_117/bin/wasm-opt"

source /nautilo/lattice-crypto/scripts/openmls-wasm-common.sh
openmls_build_to_temp_native /nautilo/lattice-crypto /work
OPENMLS_CONTAINER

  openmls_assert_artifact_set "$out_dir" false || return 1
  printf '%s\n' "$out_dir"
}

openmls_smoke_artifacts() {
  local package_dir="$1"
  local artifact_dir="$2"
  command -v bun >/dev/null 2>&1 || {
    openmls_die "bun is required to smoke-test the rebuilt artifact"
    return 1
  }
  (
    cd "$package_dir"
    bun run - "$artifact_dir" <<'OPENMLS_SMOKE'
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

function invariant(condition, message) {
  if (!condition) throw new Error(`OpenMLS WASM smoke: ${message}`);
}

function equalBytes(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function withTrailingByte(bytes) {
  const output = new Uint8Array(bytes.length + 1);
  output.set(bytes);
  output[bytes.length] = 0xa5;
  return output;
}

function invariantThrows(action, message) {
  let threw = false;
  try {
    action();
  } catch {
    threw = true;
  }
  invariant(threw, message);
}

const artifactDir = process.argv[2];
invariant(artifactDir, "artifact directory argument is required");

const glueUrl = pathToFileURL(join(artifactDir, "openmls_wasm.js"));
glueUrl.searchParams.set("verification", crypto.randomUUID());
const wasmBytes = await readFile(join(artifactDir, "openmls_wasm_bg.wasm"));
const openmls = await import(glueUrl.href);
await openmls.default({ module_or_path: wasmBytes });

const aliceProvider = new openmls.Provider();
const aliceIdentity = new openmls.Identity(aliceProvider, "alice-device");
const aliceGroup = openmls.Group.create_new(
  aliceProvider,
  aliceIdentity,
  "provenance-smoke",
);
const context = new Uint8Array([1, 2, 3, 4]);
const initialKey = aliceGroup.export_key(
  aliceProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(initialKey.length === 32, "exporter returned the wrong key length");

const bobProvider = new openmls.Provider();
const bobIdentity = new openmls.Identity(bobProvider, "bob-device");
const bobKeyPackage = bobIdentity.key_package(bobProvider);
invariantThrows(
  () => openmls.KeyPackage.from_bytes(
    withTrailingByte(bobKeyPackage.to_bytes()),
  ),
  "KeyPackage accepted trailing bytes",
);
const add = aliceGroup.propose_and_commit_add(
  aliceProvider,
  aliceIdentity,
  bobKeyPackage,
);
aliceGroup.merge_pending_commit(aliceProvider);
const ratchetTree = aliceGroup.export_ratchet_tree();
invariantThrows(
  () => openmls.RatchetTree.from_bytes(
    withTrailingByte(ratchetTree.to_bytes()),
  ),
  "RatchetTree accepted trailing bytes",
);
invariantThrows(
  () => openmls.Group.join(
    bobProvider,
    withTrailingByte(add.welcome),
    ratchetTree,
  ),
  "Welcome accepted trailing bytes",
);
const bobGroup = openmls.Group.join(
  bobProvider,
  add.welcome,
  ratchetTree,
);
const alicePostAddKey = aliceGroup.export_key(
  aliceProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
const bobPostAddKey = bobGroup.export_key(
  bobProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(
  equalBytes(alicePostAddKey, bobPostAddKey),
  "joined member did not derive the same exporter key",
);

const update = aliceGroup.propose_and_commit_update(
  aliceProvider,
  aliceIdentity,
);
invariant(update.commit.length > 0, "self-update produced no commit");
const aliceStagedUpdateKey = aliceGroup.export_key(
  aliceProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(
  equalBytes(alicePostAddKey, aliceStagedUpdateKey),
  "staging a self-update mutated the active exporter key",
);
aliceGroup.merge_pending_commit(aliceProvider);
invariantThrows(
  () => bobGroup.process_message(
    bobProvider,
    withTrailingByte(update.commit),
  ),
  "ProtocolMessage accepted trailing bytes",
);
bobGroup.process_message(bobProvider, update.commit);
const alicePostUpdateKey = aliceGroup.export_key(
  aliceProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
const bobPostUpdateKey = bobGroup.export_key(
  bobProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(
  equalBytes(alicePostUpdateKey, bobPostUpdateKey),
  "self-update did not converge exporter keys",
);
invariant(
  !equalBytes(alicePostAddKey, alicePostUpdateKey),
  "self-update did not advance the exporter key",
);

const serialized = aliceProvider.serialize_device_state();
const restoredProvider = openmls.Provider.deserialize_device_state(serialized);
const restoredGroup = openmls.Group.load_device_state(
  restoredProvider,
  "provenance-smoke",
);
const restoredIdentity = openmls.Identity.load(restoredProvider, restoredGroup);
const restoredKey = restoredGroup.export_key(
  restoredProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(
  equalBytes(alicePostUpdateKey, restoredKey),
  "serialized/restored state changed the exporter key",
);

const remove = restoredGroup.propose_and_commit_remove(
  restoredProvider,
  restoredIdentity,
  bobGroup.own_leaf_index(),
);
invariant(remove.commit.length > 0, "remove operation produced no commit");
restoredGroup.merge_pending_commit(restoredProvider);
const postRemoveKey = restoredGroup.export_key(
  restoredProvider,
  "nautilo-provenance-smoke",
  context,
  32,
);
invariant(
  !equalBytes(restoredKey, postRemoveKey),
  "member removal did not advance the exporter key",
);

remove.free();
update.free();
restoredIdentity.free();
restoredGroup.free();
restoredProvider.free();
ratchetTree.free();
add.free();
bobKeyPackage.free();
bobGroup.free();
bobIdentity.free();
bobProvider.free();
aliceGroup.free();
aliceIdentity.free();
aliceProvider.free();

console.log("OpenMLS WASM temporary-artifact smoke passed.");
OPENMLS_SMOKE
  ) || return 1
}

openmls_compare_artifacts() {
  local expected_dir="$1"
  local actual_dir="$2"
  local basename
  local failed=0

  openmls_assert_artifact_set "$expected_dir" true || return 1
  openmls_assert_artifact_set "$actual_dir" false || return 1
  for basename in "${OPENMLS_ARTIFACTS[@]}"; do
    if ! cmp -s "$expected_dir/$basename" "$actual_dir/$basename"; then
      printf 'error: rebuilt artifact differs byte-for-byte: %s\n' "$basename" >&2
      printf '  committed sha256: %s\n' "$(openmls_sha256 "$expected_dir/$basename")" >&2
      printf '  rebuilt   sha256: %s\n' "$(openmls_sha256 "$actual_dir/$basename")" >&2
      if [[ "$basename" == "openmls_wasm_bg.wasm" ]]; then
        printf '  WASM differences, including code-section differences, are never normalized.\n' >&2
      fi
      failed=1
    fi
  done
  [[ "$failed" -eq 0 ]] || return 1
}
