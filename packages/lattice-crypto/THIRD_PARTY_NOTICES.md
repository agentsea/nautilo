# Third-party notices

This file covers the Rust source and compiled dependency closure used to build
`vendor/openmls-wasm/openmls_wasm_bg.wasm`. The authoritative resolution is
`openmls-wasm/Cargo.lock`; the generated package-by-package inventory is
`THIRD_PARTY_NOTICES.cargo.md`.

## OpenMLS

The wrapper is derived from the `openmls-wasm` crate in
[OpenMLS](https://github.com/openmls/openmls) tag `openmls-v0.8.1`, commit
`47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6`, and was subsequently modified by
the lattice-lab and Nautilo projects.

OpenMLS is licensed under the MIT License. Its exact upstream license notice is
preserved in `openmls-wasm/LICENSE`. The imported lattice-lab material retains
its MIT notice in `LICENSE.lattice-lab`.

## hpke-rs MPL-2.0 components

The active `wasm32-unknown-unknown` build includes these crates from
[Cryspen's hpke-rs project](https://github.com/cryspen/hpke-rs), each at
version 0.6.1 and licensed under MPL-2.0:

- `hpke-rs`
- `hpke-rs-crypto`
- `hpke-rs-rust-crypto`

The corresponding source is available from the linked upstream repository and
from the exact crates.io packages identified by `openmls-wasm/Cargo.lock`.
The MPL-2.0 license is available at
<https://www.mozilla.org/MPL/2.0/>. Nautilo keeps the wrapper source and its
modification notice in this package and does not claim relicensing of MPL
covered files.

`hpke-rs-libcrux` 0.6.1 also appears in the complete Cargo resolution, but is
optional and is not present in the selected `wasm32-unknown-unknown` build.
This is checked during the advisory workflow.

## Complete resolved inventory

`THIRD_PARTY_NOTICES.cargo.md` records each registry package, exact version,
license expression, and source URL reported by Cargo metadata for the tracked
lock. Regenerate and review that inventory whenever `Cargo.lock` changes.

No package in the current resolution omits a Cargo license expression.
