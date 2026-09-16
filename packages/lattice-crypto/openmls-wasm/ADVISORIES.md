# Rust dependency advisory review

Reviewed: 2026-07-29

Owner: Nautilo encryption maintainers

Scope: `Cargo.lock` generated from the tracked OpenMLS wrapper manifest, with
the shipped target restricted to `wasm32-unknown-unknown`.

Tool: `cargo-audit 0.22.2`.

Re-run:

```sh
CARGO_AUDIT_BIN=/path/to/cargo-audit-0.22.2 \
  bash ../scripts/audit-openmls-wasm.sh
```

The command rejects a wrong audit-tool version, verifies the selected target
dependency tree, and fails on every newly reported vulnerability. Its six
explicit ignores correspond one-for-one to the reviewed dispositions below.

## Vulnerability dispositions

| Advisory | Locked package | Target reachability | Disposition |
| --- | --- | --- | --- |
| RUSTSEC-2026-0209 | `libcrux-aesgcm 0.0.7` | Not in the normal `wasm32-unknown-unknown` dependency tree; reachable only through optional `hpke-rs-libcrux`, which is disabled. | Temporarily accepted as lock-only, unshipped code. |
| RUSTSEC-2026-0211 | `libcrux-aesgcm 0.0.7` | Same disabled optional path as above. | Temporarily accepted as lock-only, unshipped code. |
| RUSTSEC-2026-0124 | `libcrux-chacha20poly1305 0.0.7` | Same disabled optional path as above. | Temporarily accepted as lock-only, unshipped code. |
| RUSTSEC-2026-0212 | `libcrux-secrets 0.0.5` | Compiled transitively through `libcrux-sha3`; the advisory affects the AArch64 backend, while the only shipped target is WASM. | Temporarily accepted for the WASM-only artifact. |
| RUSTSEC-2026-0207 | `libcrux-sha3 0.0.8` | Compiled by `hpke-rs`, but the wrapper fixes `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`; it cannot select the ML-KEM/X-Wing SHAKE path. The advisory concerns incremental multi-squeeze use. | Temporarily accepted as unreachable under the fixed suite. |
| RUSTSEC-2026-0208 | `libcrux-sha3 0.0.8` | Same fixed-suite restriction; the advisory concerns an AVX2 x4 implementation unavailable in WASM. | Temporarily accepted as unreachable on the shipped target. |

These are scoped risk dispositions, not claims that the packages are generally
safe. The package is dormant and has no Nautilo product consumer in Wave 1.
The encryption maintainers must re-review every disposition before any
dependency, ciphersuite, target, or product-consumption change, and no later
than 2026-08-29.

## Allowed warnings

- RUSTSEC-2024-0384: `instant 0.1.13` is unmaintained. It is active through
  OpenMLS's WASM timer path and has no published vulnerability.
- RUSTSEC-2026-0210: `libcrux-aesgcm 0.0.7` was renamed. It is lock-only and
  absent from the selected target tree.
- RUSTSEC-2026-0173: `proc-macro-error2 2.0.1` is unmaintained. It is absent
  from the selected target tree.

Warnings remain visible in audit output and require re-review with the same
triggers and deadline.

## Socket supply-chain dispositions

These dispositions address package-capability heuristics rather than published
vulnerabilities. They do not replace the RustSec review above.

| Socket finding | Locked package | Target reachability and inspection | Disposition |
| --- | --- | --- | --- |
| Supply Chain Security score `12`/`13` (Vulnerability score `100`); package-wide install-script, network, shell, environment, and filesystem capability warnings | `web-sys 0.3.103`, checksum `8622dcb61c0bcc9fffa6938bed81210af2da9a7e4a1a834b2e37a59b6dfb6141` | Active transitively through OpenMLS's WASM timer path. The official `wasm-bindgen` crate is generated from browser WebIDL and exposes the Web API universe behind Cargo features. The published crate declares `build = false`, has no `build.rs`, and contains no process, shell, environment, or filesystem implementation. Nautilo removed its unused direct `console` feature; the target tree retains only `Window`, `EventTarget`, `Performance`, and `PerformanceTiming` plus defaults. The committed artifact's audited host-import allowlist contains randomness, time, and JS-global access only. Its sole glue-level `fetch()` is the standard loader for the caller-supplied local WASM URL/bytes. Source provenance resolves to the signed `wasm-bindgen` `0.2.126` release commit `21ac804a96c0c5c5d6459084686a9a17a8a3c865`. | Accepted as a package-wide static-analysis mismatch. The low score is not a vulnerability score and does not describe the compiled capability surface. |
| High-confidence obfuscated-code heuristic | `zerocopy 0.8.55`, checksum `b5a105cd7b140f6eeec8acff2ea38135d3cab283ada58540f629fe51e46696eb` | Active through `rand_chacha` → `ppv-lite86`. The published archive matches the signed `google/zerocopy` `v0.8.55` release commit `93ea10b10f5756bd94a8206acf326f491ed3e42a`. Its build script reads its own manifest, invokes the configured Rust compiler with `--version`, and emits compiler configuration; it performs no network access, download, shell invocation, environment enumeration, or external filesystem traversal. `zerocopy-derive`, where the substantive `0.8.55` feature landed, is not active in Nautilo's WASM target tree. | Accepted as a heuristic false positive after source and build-script review. |

`verify-openmls-wasm-surface.ts` fails closed if the committed or rebuilt WASM
host-import boundary expands, and the canonical build rejects a direct
`web-sys` dependency. Re-review both dispositions before any locked dependency,
Cargo feature, Rust target, builder toolchain, WASM host import, or glue-loader
change, and no later than 2026-08-29.
