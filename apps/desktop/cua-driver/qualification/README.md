# Qualified, pinned Cua source input

Desktop builds the exact released Cua source plus `setup-controls.patch` for
both updater-disabled qualification and normal production packaging. The
reviewed manifest explicitly approves production packaging after signed live
browser qualification. This is a Nautilo-maintained patch, not an upstream
release, and does not introduce a runtime driver updater. The `qualification`
directory and manifest kind retain their original provenance naming.

The exact [upstream MIT license](LICENSE.md) from the pinned base revision is
retained beside the derivative patch. Its SHA-256 and immutable upstream source
are recorded in `manifest.json`.

`manifest.json` pins the base revision, patch SHA-256, complete resulting Git
tree, Rust toolchain and contribution provenance. The builder verifies all
source identities, runs the macOS tests, builds both architectures and stages
the resulting driver with a pre-signing hash. Electron's existing protected
signing/notarization pipeline signs that staged executable under Nautilo's
identity. The package carries the patch and provenance inside its signed seal.

A missing dependency, patch mismatch, source-tree mismatch, build failure or
architecture mismatch aborts packaging. There is no fallback to stock Cua.
Production packaging requires `productionPackaging: true` in the reviewed
manifest; an unpromoted patch still refuses production versions. This flag
does not publish a release, bypass protected signing/notarization, or change
Desktop's tag-derived version and updater eligibility checks.
Remove this directory when replacing the temporary patch with a qualified
upstream release, preserving the normal immutable release-archive contract.

The checkbox reader includes Zane Chee's upstream PR3404 at
`ad79aa13eb06a52c13cc21a0a87c8cc80d389dd1`; its attribution is recorded in the
manifest. The native identity repair and exact numeric-state tightening are
additional changes. Tests are not a claim of signed live browser acceptance.
