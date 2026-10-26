# Rust dependency advisory review

RustSec review: 2026-10-24. Expires: **2026-10-31T00:00:00Z**.

Owner: Nautilo encryption maintainers

Scope: `Cargo.lock` generated from the tracked OpenMLS wrapper manifest, with
the shipped target restricted to `wasm32-unknown-unknown`.

Tool: `cargo-audit 0.22.2`.

Re-run:

```sh
CARGO_AUDIT_BIN=/path/to/cargo-audit-0.22.2 \
  bash ../scripts/audit-openmls-wasm.sh
```

The command rejects a wrong audit-tool version and verifies the selected target
dependency tree. It prints the complete, unmodified whole-lock JSON report with
no ignores or target/severity filters, then evaluates exact dispositions in
`../scripts/openmls-audit-policy.ts`. It fails on new, changed, duplicate or
unused findings, new warnings, changed lock/manifest/wrapper/WASM bytes, expiry,
or changed supported-compatible registry candidates. Network failure is not a
reason to use stale candidate evidence. Every current index SHA256 is retained
in the separate decision output. A metadata request has a 30-second operational
deadline and no automatic retry; failure stops the audit, never permits risk.

This is an explicit temporary release-risk acceptance, not a declaration that
these vulnerabilities are fixed or harmless. The wrapper is used by Nautilo's
encryption runtime. In particular, the active `crypto-bigint` finding is not
waived on target-reachability grounds. The wrapper, dependency lock and shipped
WASM remain unchanged; replacing the crypto stack requires separate protocol,
storage compatibility and reproducibility qualification.

## Vulnerability dispositions

| Advisory | Locked package | Target reachability | Disposition |
| --- | --- | --- | --- |
| [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) | `crypto-bigint 0.5.5` | Active through `p256` / `elliptic-curve`. Secret-dependent branches may leak secret arithmetic values. | Temporary risk acceptance through the expiry above; fixed upstream in `>=0.7.6`, unavailable through the supported dependency line. No claim of WASM immunity. |
| RUSTSEC-2026-0209 | `libcrux-aesgcm 0.0.7` | Not in the normal `wasm32-unknown-unknown` dependency tree; reachable only through optional `hpke-rs-libcrux`, which is disabled. | Temporarily accepted as lock-only, unshipped code. |
| RUSTSEC-2026-0211 | `libcrux-aesgcm 0.0.7` | Same disabled optional path as above. | Temporarily accepted as lock-only, unshipped code. |
| RUSTSEC-2026-0124 | `libcrux-chacha20poly1305 0.0.7` | Same disabled optional path as above. | Temporarily accepted as lock-only, unshipped code. |
| [RUSTSEC-2026-0330](https://rustsec.org/advisories/RUSTSEC-2026-0330.html) | `libcrux-kem 0.0.7` | Optional `hpke-rs-libcrux` is absent from the selected normal tree; whole-lock scan still reports the short-seed panic. | Exact temporary release-risk acceptance, not removal or severity reclassification; upstream fix `>=0.0.10` is incompatible with `^0.0.7`. |
| [RUSTSEC-2026-0331](https://rustsec.org/advisories/RUSTSEC-2026-0331.html) | `libcrux-kem 0.0.7` | Same optional path; malformed hybrid-key decoding can panic. | Same exact temporary release-risk acceptance; preserve the upstream availability impact and fixed range. |
| RUSTSEC-2026-0212 | `libcrux-secrets 0.0.5` | Compiled transitively through `libcrux-sha3`; the advisory affects the AArch64 backend, while the only shipped target is WASM. | Temporarily accepted for the WASM-only artifact. |
| RUSTSEC-2026-0207 | `libcrux-sha3 0.0.8` | Compiled by `hpke-rs`, but the wrapper fixes `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`; it cannot select the ML-KEM/X-Wing SHAKE path. The advisory concerns incremental multi-squeeze use. | Temporarily accepted as unreachable under the fixed suite. |
| RUSTSEC-2026-0208 | `libcrux-sha3 0.0.8` | Same fixed-suite restriction; the advisory concerns an AVX2 x4 implementation unavailable in WASM. | Temporarily accepted as unreachable on the shipped target. |

The earlier six dispositions were re-reviewed against the same unchanged lock,
wrapper, binary and selected target tree. Their original target restrictions
remain mandatory, including the absence of `libcrux-kem`. They share the exact
expiry and byte/candidate guards above. Re-review before any dependency,
ciphersuite, target, wrapper, binary or consumer change.

## Why a compatible patch cannot be installed

The authenticated public [crates.io sparse index](https://index.crates.io/)
was checked on the review date. `openmls 0.8.3`, the newest compatible wrapper
release, still selects `openmls_rust_crypto ^0.5.1`. That backend and the
supported `hpke-rs-rust-crypto 0.6.1` require `p256 ^0.13`; `p256 0.13.2`
requires `elliptic-curve ^0.13.1`, whose latest compatible `0.13.8` requires
`crypto-bigint ^0.5`. The latest supported candidate is `0.5.5`, not the patched
`0.7.6`. Even `openmls_rust_crypto 0.6.0` still requires `p256 ^0.13`.

`hpke-rs-libcrux 0.6.1` requires `libcrux-kem ^0.0.7` and `hpke-rs 0.6.1`
requires `libcrux-sha3 ^0.0.8`. Those pre-1.0 caret ranges do not admit
`libcrux-kem 0.0.10` or `libcrux-sha3 0.0.10`. The old AES-GCM crate was renamed
to `libcrux-aes` for its fixes; changing its name/API is not a lockfile patch.
The other reviewed old Libcrux lines similarly admit only the installed
`0.0.7` / `0.0.5` candidates. Any newly published compatible candidate stops
the audit for patching or renewed review rather than silently extending this
acceptance. Raw RustSec fixed ranges and CVSS vectors are never rewritten.

## Allowed warnings

- RUSTSEC-2024-0384: `instant 0.1.13` is unmaintained. It is active through
  OpenMLS's WASM timer path and has no published vulnerability.
- RUSTSEC-2026-0210: `libcrux-aesgcm 0.0.7` was renamed. It is lock-only and
  absent from the selected target tree.
- RUSTSEC-2026-0173: `proc-macro-error2 2.0.1` is unmaintained. It is absent
  from the selected target tree.

Warnings remain visible in audit output and require re-review with the same
triggers and deadline.

## Historical Socket supply-chain dispositions

The following source inspections were recorded on 2026-07-29 and address
package-capability heuristics rather than published vulnerabilities. They do
not replace the current RustSec review or a fresh Socket check. No dependency,
feature or artifact in those historical inspections changes in this review.

| Socket finding | Locked package | Target reachability and inspection | Disposition |
| --- | --- | --- | --- |
| Supply Chain Security score `12`/`13` (Vulnerability score `100`); package-wide install-script, network, shell, environment, and filesystem capability warnings | `web-sys 0.3.103`, checksum `8622dcb61c0bcc9fffa6938bed81210af2da9a7e4a1a834b2e37a59b6dfb6141` | Active transitively through OpenMLS's WASM timer path. The official `wasm-bindgen` crate is generated from browser WebIDL and exposes the Web API universe behind Cargo features. The published crate declares `build = false`, has no `build.rs`, and contains no process, shell, environment, or filesystem implementation. Nautilo removed its unused direct `console` feature; the target tree retains only `Window`, `EventTarget`, `Performance`, and `PerformanceTiming` plus defaults. The committed artifact's audited host-import allowlist contains randomness, time, and JS-global access only. Its sole glue-level `fetch()` is the standard loader for the caller-supplied local WASM URL/bytes. Source provenance resolves to the signed `wasm-bindgen` `0.2.126` release commit `21ac804a96c0c5c5d6459084686a9a17a8a3c865`. | Accepted as a package-wide static-analysis mismatch. The low score is not a vulnerability score and does not describe the compiled capability surface. |
| High-confidence obfuscated-code heuristic | `zerocopy 0.8.55`, checksum `b5a105cd7b140f6eeec8acff2ea38135d3cab283ada58540f629fe51e46696eb` | Active through `rand_chacha` → `ppv-lite86`. The published archive matches the signed `google/zerocopy` `v0.8.55` release commit `93ea10b10f5756bd94a8206acf326f491ed3e42a`. Its build script reads its own manifest, invokes the configured Rust compiler with `--version`, and emits compiler configuration; it performs no network access, download, shell invocation, environment enumeration, or external filesystem traversal. `zerocopy-derive`, where the substantive `0.8.55` feature landed, is not active in Nautilo's WASM target tree. | Accepted as a heuristic false positive after source and build-script review. |

`verify-openmls-wasm-surface.ts` fails closed if the committed or rebuilt WASM
host-import boundary expands, and the canonical build rejects a direct
`web-sys` dependency. Re-review both dispositions before any locked dependency,
Cargo feature, Rust target, builder toolchain, WASM host import, or glue-loader
change. Their original review deadline was 2026-08-29; the RustSec decisions
above do not silently renew that separate capability review.
