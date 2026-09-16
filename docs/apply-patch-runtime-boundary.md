# Apply-patch Runtime Boundary

## Decision

Nautilo will ship a narrowly maintained extraction of the Codex patch grammar
and matching logic, not the upstream `apply_patch` standalone.  The model-facing
tool is the provider-compatible structured object `{ patch: string }`; the value
is the preserved Codex UTF-8 patch envelope.  Trusted authority (root, actor,
relay, turn, revisions, grants) is never model authored and is not part of the
patch string.

The machine-readable pin is
[`native/apply-patch/UPSTREAM.toml`](../native/apply-patch/UPSTREAM.toml). It
is the build/update authority for source, fixture, license, and protocol
provenance.

The runtime exposes the validated provenance through `--version-json`: its
`provenance` object has format `nautilo.apply_patch.provenance/v1` and carries
the reviewed upstream revision plus the byte-exact `LICENSE` and `NOTICE`
SHA-256 values. `build.rs` checks the manifest revision, handshake format, and
both legal-file hashes against review anchors before compilation; a source-pin
change or absent/mismatched legal file fails deterministically. This is a
build-time source provenance guard and handshake, not a claim that a deployed
binary re-reads mutable source-tree legal files at invocation time.

## Verified facts

- The reviewed upstream checkout is OpenAI Codex
  `3389fa554e953d07a12a34f5681aae46f17958f8` from
  `https://github.com/openai/codex.git`; its `codex-apply-patch` crate is under
  `codex-rs/apply-patch` and declares Apache-2.0.
- The reusable source boundary is `parser.rs:1-465`,
  `seek_sequence.rs:1-110`, and three explicit `lib.rs` segments:
  `667-681` (newline normalization), `691-778`
  (`compute_replacements`), and `783-806` (`apply_replacements`). The complete
  file and selected-segment hashes are pinned in `UPSTREAM.toml`.
- The upstream scenario tree is Git tree
  `5ce1d30cb1ebbce5c7d001b56b8f8fdb78a2fba6`; its deterministic Git archive
  hash is `26d465b5e65864e488fa40decc8fc86b54c62104fe59bccc680b6ca99faecf4a`,
  measured with `git archive --format=tar REV
  codex-rs/apply-patch/tests/fixtures/scenarios | shasum -a 256` from the
  pinned checkout. All 23 fixture directories are individually classified
  there.
- The upstream crate depends directly on `codex-exec-server`, and the measured
  standalone closure reaches 20 internal Codex crates and 86 direct external
  dependency names. This measurement is a declared non-dev build/target
  dependency traversal, not a feature-resolved compiled graph. The standalone
  source also has no Nautilo JSON version
  handshake, invokes local filesystem work at an unsandboxed boundary, and
  loses structured partial-delta detail when it reports failure.
- Upstream fixture `015_failure_after_partial_success_leaves_changes` proves
  a sequential execution can leave a committed prefix. It is retained as
  boundary evidence, not accepted as Nautilo execution behaviour.

## Inference and product consequence

The measured closure and failure surface mean the upstream standalone is not a
safe or supportable shipping boundary. This is an engineering conclusion from
the verified facts above, not a claim that upstream is defective. Nautilo must
instead provide a narrow synchronous filesystem-neutral engine, plan all
ordinary parse/context failures before mutation, run it inside the existing
server/relay sandbox, and truthfully surface an I/O-failed committed prefix as
`partial` with per-path status.

Nautilo will not import the upstream invocation, standalone, streaming parser,
execution-server, protocol, sandbox, PTY, network, WebSocket, or TLS layers.
The v1 binary is a fixed-cwd, stdin/stdout JSON runtime with
`nautilo.apply_patch/v1` and a `--version-json` handshake. It has no ambient
`PATH`, installed Codex, Homebrew, Cargo, or dynamic-download fallback.

### Current extraction result boundary

Task 0.1.2 emits a lower-level native engine report: planned operations,
per-operation `applied`/`not_applied`/`unknown` state, an applied destination
prefix, an explicit partial flag, and a closed `parse`/`context`/`execution`
failure kind whenever the operation is rejected. The free-form native error
remains diagnostic-only; the failure kind is the authoritative input to safe,
stable host error classification. A move remains one operation carrying
its source and destination; it is not represented as a delete plus write.
This is not yet the locked `ApplyPatchChildExecutionReport` or public result
contract. Phase 1.3 owns the constrained process wrapper; Phase 3.1/3.2 own
trusted preflight, pre/post reconciliation, operation counts, per-path result
translation, byte accounting, bounded diffs, revisions, and public-result
normalization. The extraction therefore does not yet claim caps, sandboxing,
canonical identity/TOCTOU protection, conflict/overwrite-byte preflight, or
revision/event behavior.

## Apache-2.0 obligations

The local byte-exact Apache license and upstream notice are stored alongside
the runtime. `THIRD_PARTY_NOTICES.md` identifies the derived source. Every
modified extracted Rust file carries a prominent Nautilo modification notice
and retains relevant upstream notices. The first extraction uses only the
locked JSON-protocol dependency set recorded in `UPSTREAM.toml`: `serde`
1.0.229, `serde_json` 1.0.151, and their exact lockfile transitive closure.
No Codex crate enters the artifact. The committed lock and isolated Rust 1.95.0
toolchain pin the resolved dependency set and integrity. `cargo test --locked
--offline` is verified after the exact crate cache is populated; a clean
designated builder may use Cargo to fetch those exact locked crate sources.
Neither path fetches Codex. Production ships a built artifact and never builds
Rust or fetches dependencies at runtime.

## Reproducibility and update policy

The first extraction build pins Rust `1.95.0`, edition 2024, committed source
and lock hashes, and copied portable fixtures. A designated clean builder may
fetch only the exact locked Cargo sources; an offline build is valid once that
exact cache is available. Production must never compile Rust or fetch at
runtime. Upgrading the upstream revision is a deliberate review: re-measure the
standalone boundary, re-pin every source/segment/scenario/license hash, review
fixture and protocol compatibility, update the dependency-license inventory,
and deliberately update the build-guard review anchors before accepting the
change. Native guard tests use disposable copied manifests/legal files for the
positive and tampered cases, so they never modify repository attribution files.
