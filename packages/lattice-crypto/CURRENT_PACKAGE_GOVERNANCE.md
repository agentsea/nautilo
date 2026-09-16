# Current lattice-crypto package governance

`PROVENANCE.json` is the immutable M221 import receipt for the reviewed
`agentsea/lattice-lab` snapshot. Its destination hashes describe the bytes at
that historical import checkpoint; they are not an allowlist for every future
Nautilo revision of this package. Do not regenerate or edit the receipt when
developing the v2 core.

Current package evolution is governed semantically by
`dev/tests/repo-invariants/lattice-crypto-import.test.ts`. That invariant keeps
the package dormant and isolated, rejects Nautilo product dependencies and
consumers, rejects stale pre-Nautilo cryptographic domains, constrains public
export and package-root boundaries, preserves honest unit/integration/scenario
lanes, and pins the main-only exact-WASM verification contract. Reviewed source
and test modules may otherwise be added or changed through ordinary Nautilo
history.

`bun run --cwd packages/lattice-crypto provenance:verify` verifies the complete
historical receipt plus its immutable license, notice, and preserved source-lock
evidence. `bun run test:invariants` verifies the current package governance
boundary.

Mutation assurance is governed by the exact 58-target, 15-scope inventory in
`scripts/mutation-scopes.json`. Every scope independently requires at least 80%
of generated mutants to be killed. Every remaining generated mutant must have
one exact, source-stale fingerprinted disposition in
`scripts/mutation-residuals.json`; unexplained survivors, no-coverage results,
timeouts, ignored mutants, or runner errors fail the gate. The two provider
implementation scopes are evaluated separately from the 13 critical scopes,
and no percentage can excuse a behavioral authorization, canonical-decoding,
rollback/replay, CAS, limit, secret-custody, or cleanup mutation.
Inline Stryker suppression, excluded mutator classes, ignore plugins, static
ignores, and incremental result reuse are forbidden. Mutants must be generated
before the residual ledger can account for them.

The full mutation runner executes all scopes sequentially with one global
four-worker ceiling, retains per-scope JSON, and writes a deterministic
aggregate summary. A local `LATTICE_MUTATION_SCOPE_ONLY=<scope>` run is
explicitly partial and is rejected under `CI=true`. A dirty full run cannot
serve as release evidence. The same `test:mutation` command and manifest are
used locally and by the nightly/manual hosted workflow. Ordinary main pushes
retain the faster integration, scenario, property, fuzz, soak, and WASM lanes
without starting the multi-hour mutation gate. Each mutant receives the normal
test duration plus a fixed 15-second busy-runner cushion; the report records
that exact policy so a nightly run cannot silently use a flakier timeout.

For a fast local TDD loop, select one governed file and optionally one Stryker
source range:

```text
LATTICE_MUTATION_TARGET_ONLY=src/crypto/index.ts \
  LATTICE_MUTATION_RANGE_ONLY=130-190 \
  bun run --cwd packages/lattice-crypto test:mutation:target
```

Target/range runs reuse the owning scope's real tests but are development
feedback only. CI rejects them, and they never produce full-gate evidence.
