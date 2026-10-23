# Lattice crypto import provenance

This dormant package was imported mechanically from `agentsea/lattice-lab`
commit `a1fc280cd646fe147427b9feb8a41f121386a138` and source tree
`aeec95b24de2672346652c6a4ed312fc898d84f6`. The byte-identical 57-file
checkpoint is Nautilo commit
`593e64df8b9bb2f62281d65b239a587b132cd93b`.

`PROVENANCE.json` records each source Git blob, mode, type, size, source
SHA-256, pre-adaptation SHA-256, final SHA-256, and approved adaptation.
The manifest deliberately does not hash itself; its reviewed Git blob is its
authentication boundary. Every other owned package file and relevant workspace
adaptation is hash-accounted.

The audited lab root lock is preserved byte-identically at
`provenance/lattice-lab-bun.lock`. It records the intentional dual HPKE
resolution: direct `@hpke/core` 1.9.0 and `@hpke/core` 1.8.0 through
`ts-mls` 1.6.2. Nautilo's active root lock is generated with Bun 1.3.11.

The clean-break adaptation changes the package to
`@nautilo/lattice-crypto` 0.1.0 and changes every owned v1 cryptographic
domain from its former lab prefix to `nautilo/lattice-crypto/...`. There is no
legacy reader or fallback. Exact new fixtures and old-domain rejection tests
cover grant signatures and cache fingerprints, device-capability challenges,
both object AAD purposes, recovery kits, device/history recovery, and all three
provider rows.

The honest unit lane contains only deterministic in-process collaborators and
cannot import the OpenMLS provider, full provider matrix, or vendored WASM.
The integration and scenario lanes consume the committed OpenMLS artifact but
need no Rust, database, service, credential, or live network. Dedicated
main-only CI jobs run those binary-backed lanes and independently rebuild the
WASM in the digest-pinned canonical Linux/amd64 container. The OpenMLS
provenance files pin that builder, tracked Cargo resolution, notices, artifact
hashes, and non-mutating verifier. Artifact updates remain an explicit
maintainer action.

Baseline evidence at the pinned lab commit:

- Bun 1.3.1: 16 test files, 334 tests, 1,667 assertions, zero failures.
- Three provider rows: dummy, `ts-mls`, and OpenMLS.
- Nine named scenarios, 27 provider/scenario runs, and 24 lifecycle
  expectations per provider/scenario row.
- Zero Rust unit tests.

Final M221 evidence: the binary-free unit lane has 3 files, 30 tests, and 106
assertions; the binary-backed integration lane has 13 files, 311 tests, and
1,586 assertions. All 341 tests and 1,692 assertions pass, as do all 27
provider/scenario runs.

Canonical verification uses the repository-pinned Bun 1.3.11:

```text
bun run --cwd packages/lattice-crypto provenance:verify
bun run --cwd packages/lattice-crypto typecheck
bun run --cwd packages/lattice-crypto lint
bun run --cwd packages/lattice-crypto test:unit
bun run --cwd packages/lattice-crypto test:integration
bun run --cwd packages/lattice-crypto test:scenarios
bun run --cwd packages/lattice-crypto wasm:verify
bun run test:invariants
```

The M220 hosted inventory timeout is repaired here by serializing the cold
actual-repository lane and reusing its deterministic DTO inventory. A green
hosted main observation remains required; no M221 package, provenance,
scenario, or repository invariant is waived.

The complete `encryption:assurance` command uses the same four-worker Stryker
configuration locally and in its main-only CI observer. The full 1,164-mutant
corpus remains mandatory; concurrency changes execution time, not scope,
thresholds, retries, or the required 100% mutation score.
