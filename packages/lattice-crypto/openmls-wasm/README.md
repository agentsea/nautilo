# openmls-wasm (vendored, never published)

A **thin `wasm-bindgen` wrapper over [OpenMLS](https://github.com/openmls/openmls)**,
exposing only the operations the lattice `GroupKeyProvider` needs. Forked from
`openmls/openmls` → `openmls-wasm/` (MIT) and extended with the high-level
commit operations the upstream wrapper lacks:
**`propose_and_commit_update`** (RFC 9420 self-update / PCS) and
**`propose_and_commit_remove`** (member removal — what bumps the lattice epoch
and voids grants).

## Why this exists

The production MLS provider must be **OpenMLS** (audited: SRLabs, Mar 2026), not
`ts-mls` (unaudited). OpenMLS is Rust; the only way to run audited MLS in a JS
runtime (Bun / browser / Electron) is a wasm build. There is **no maintained,
drop-in npm package** — the published `openmls-wasm@0.1.0` is an experimental
scaffold that can't even remove a member. So we own a small fork.

## Never published

This crate is **not** published to crates.io or npm. Its `wasm-pack` output is
**vendored** (committed) into `../vendor/openmls-wasm/` and imported directly by
`../src/group/openmls.ts`. OpenMLS's MIT license permits vendoring
source + compiled artifact into a proprietary codebase (retain notices). This is
deliberately the opposite of Wire's `core-crypto` (GPL-3.0), which we rejected.

## Building (needs Docker; not required for everyday work)

```
bun run --cwd packages/lattice-crypto wasm:verify
# Explicit maintainer-only artifact update:
bun run --cwd packages/lattice-crypto wasm:update
```

Only the person bumping OpenMLS / editing this crate needs Docker. Both
commands build through one digest-pinned `linux/amd64` Rust 1.96.1 image and
download checksum-pinned `wasm-pack` 0.13.1, `wasm-bindgen-cli` 0.2.126, and
Binaryen `wasm-opt` version 117 (`version_117`) inside that disposable
container. This canonical host is required because Rust's WASM code generation
is not byte-identical between macOS/arm64 and Linux/x86_64 even when every
tool version matches. The scripts reject every wrong tool or download, build
into a temporary directory, remap host-specific source paths, and require exact
bytes. Everyone else (and ordinary typecheck/lint/test work) uses the committed
`../vendor/openmls-wasm/` artifact without Docker or Rust. Rebuild and re-run
the conformance matrix on every OpenMLS upgrade.

Verification also fails closed if the emitted WASM host-import allowlist grows
beyond randomness, time, and JS-global access, or if the standard glue adds a
host capability beyond loading the caller-supplied local WASM URL/bytes. The
wrapper intentionally has no direct `web-sys` dependency; the narrow
`Window`/`EventTarget`/`Performance` timing surface is transitive from OpenMLS.

The package's `test:unit` lane is deliberately binary-free.
`test:integration` and `test:scenarios` exercise the committed WASM without
building it. Dedicated main-only CI runs both binary-backed lanes plus
`wasm:verify`; none requires Nautilo infrastructure, a database, credentials,
or a live service. The canonical rebuild downloads its pinned public build
inputs.

## Surface

`Provider`, `Identity`, `KeyPackage`, `RatchetTree`, and `Group` with
`create_new` / `join` / `export_ratchet_tree` / `own_leaf_index` /
`member_roster` /
**`propose_and_commit_update`** / `propose_and_commit_add` /
**`propose_and_commit_remove`** / `merge_pending_commit` /
`process_message` / `export_key`, plus internal device-backup
`serialize_device_state` / `deserialize_device_state` / `load_device_state`.
Fixed ciphersuite:
`MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`.

The raw backup functions are consumed only by
`OpenMlsGroupProvider.backupDeviceState()` / `restoreDeviceState()`, which wrap
the bytes in `DeviceStateVault` authenticated encryption before persistence.
They are not package exports or server-state APIs. A server/database snapshot
may persist only public Delivery Service material and opaque encrypted device
backups; exporter-capable plaintext member state belongs on the device.

## Status

✅ **Built + green.** Compiles against OpenMLS 0.8.1 → ~1.16 MB wasm; the vendored
artifact drives `OpenMlsGroupProvider`, and the full conformance / adversary /
read-write / grant-cache / batch batteries pass against the `openmls+enumeration`
matrix row (faster than the ts-mls row).

The H5/H6/H7 and M3/M9 hardening is present: public-only server state,
encrypted device-local backup/fully committing restore, authoritative OpenMLS
leaf rosters, device-level membership, and explicit retained-root delivery.
Still TODO for production: M2's durable Delivery Service reconciliation and
confirming the vendored `web`-target glue on real browser/Electron (it already
loads under Bun; consider a bundler/inline build for a single cross-runtime
asset).
