# Reflection Wave 1 candidate-policy decision

**Status:** GENERATED — deterministic offline result; no production behavior.

**Corpus:** `2026-08-20.1`

**Policy:** `candidate-policy-v1`

**Candidate bounds:** `2`, `4`, `8`

## Decision

| Mode | Outcome | Reason |
|---|---|---|
| Same Room | Semantic neighbors at bound 4 | Passed every hard gate; selected by lowest contamination, then deterministic work, bound, and policy simplicity (mean contamination 0). |
| Cross Room | Semantic neighbors at bound 2 | Passed every hard gate; selected by lowest contamination, then deterministic work, bound, and policy simplicity (mean contamination 0.1). |

The selection rule is deterministic: reject every policy/bound with an
authority, forbidden-exposure, required-reachability, or repeat-stability
failure; among passing results, minimize contamination, then compared work,
then bound, then implementation simplicity. No aggregate score can rescue a
hard-gate failure.

## Candidate-policy scorecard

Mode | Policy | Bound | Gates | Mean recall | Mean contamination | Selected | Compared
---|---|---:|---|---:|---:|---:|---:
Same Room | semantic_neighbors | 2 | REJECT | 91.7% | 0.0% | 14 | 34
Cross Room | semantic_neighbors | 2 | PASS | 100.0% | 10.0% | 10 | 11
Same Room | semantic_neighbors | 4 | PASS | 100.0% | 0.0% | 19 | 34
Cross Room | semantic_neighbors | 4 | PASS | 100.0% | 10.0% | 10 | 11
Same Room | semantic_neighbors | 8 | PASS | 100.0% | 0.0% | 19 | 34
Cross Room | semantic_neighbors | 8 | PASS | 100.0% | 10.0% | 10 | 11
Same Room | existing_parent | 2 | REJECT | 20.8% | 0.0% | 4 | 34
Cross Room | existing_parent | 2 | REJECT | 0.0% | 0.0% | 0 | 11
Same Room | existing_parent | 4 | REJECT | 37.5% | 0.0% | 7 | 34
Cross Room | existing_parent | 4 | REJECT | 0.0% | 0.0% | 0 | 11
Same Room | existing_parent | 8 | REJECT | 37.5% | 0.0% | 7 | 34
Cross Room | existing_parent | 8 | REJECT | 0.0% | 0.0% | 0 | 11
Same Room | temporal_room_anchor | 2 | REJECT | 52.1% | 43.8% | 16 | 34
Cross Room | temporal_room_anchor | 2 | REJECT | 90.0% | 20.0% | 9 | 11
Same Room | temporal_room_anchor | 4 | REJECT | 83.3% | 45.8% | 28 | 34
Cross Room | temporal_room_anchor | 4 | REJECT | 90.0% | 20.0% | 9 | 11
Same Room | temporal_room_anchor | 8 | PASS | 100.0% | 44.0% | 34 | 34
Cross Room | temporal_room_anchor | 8 | REJECT | 90.0% | 20.0% | 9 | 11

## Current-behavior baselines

These are characterization views, not candidate-policy contenders. Memory
uses the current cosine-similarity ordering shape over eligible authored
Memories; Journal/recent uses authorized Room-local chronological context;
flat combined ranks authorized Memory and Journal items together.

Mode | Baseline | Bound | Gates | Mean recall | Mean contamination | Selected | Compared
---|---|---:|---|---:|---:|---:|---:
Same Room | memory | 4 | REJECT | 41.7% | 0.0% | 5 | 5
Cross Room | memory | 4 | REJECT | 80.0% | 0.0% | 4 | 4
Same Room | journal_recent | 4 | REJECT | 52.1% | 62.5% | 22 | 25
Cross Room | journal_recent | 4 | REJECT | 0.0% | 0.0% | 0 | 0
Same Room | flat_combined | 4 | REJECT | 87.5% | 0.0% | 14 | 14
Cross Room | flat_combined | 4 | PASS | 100.0% | 10.0% | 9 | 9

## Selected-policy fixture evidence

### Same Room

| Fixture | Selected candidates | Recall | Contamination | Gates |
|---|---|---:|---:|---|
| postgres-decision | `postgres-decision.postgres-argument`, `postgres-decision.neon-argument`, `postgres-decision.requirements-memory` | 100.0% | 0.0% | PASS |
| valuable-leaf | — | 100.0% | 0.0% | PASS |
| emergent-depth | `emergent-depth.failure-cluster`, `emergent-depth.latency-cluster`, `emergent-depth.cost-cluster` | 100.0% | 0.0% | PASS |
| disagreement | `disagreement.cost-risk-counterclaim`, `disagreement.usage-estimate`, `disagreement.premature-consensus` | 100.0% | 0.0% | PASS |
| edited-evidence | `edited-evidence.retention-forever`, `edited-evidence.corrected-policy` | 100.0% | 0.0% | PASS |
| partial-dependency-loss | `partial-dependency-loss.portability`, `partial-dependency-loss.transactions` | 100.0% | 0.0% | PASS |
| multi-parent-reuse | `multi-parent-reuse.database-sibling`, `multi-parent-reuse.deployment-sibling`, `multi-parent-reuse.database-parent`, `multi-parent-reuse.deployment-parent` | 100.0% | 0.0% | PASS |
| temporal-anchor-trap | `temporal-anchor-trap.restore-evidence`, `temporal-anchor-trap.backup-memory` | 100.0% | 0.0% | PASS |

### Cross Room

| Fixture | Selected candidates | Recall | Contamination | Gates |
|---|---|---:|---:|---|
| cross-room-intersection | `cross-room-intersection.room-a-argument`, `cross-room-intersection.room-b-argument` | 100.0% | 0.0% | PASS |
| multi-attached-leaf | `multi-attached-leaf.all-three-support`, `multi-attached-leaf.all-three-parent` | 100.0% | 0.0% | PASS |
| invocation-not-requester | `invocation-not-requester.shared-policy`, `invocation-not-requester.shared-journal` | 100.0% | 0.0% | PASS |
| semantic-authority-trap | `semantic-authority-trap.lexical-decoy`, `semantic-authority-trap.authorized-rationale` | 100.0% | 50.0% | PASS |
| public-private-boundary | `public-private-boundary.public-rationale`, `public-private-boundary.public-decoy` | 100.0% | 0.0% | PASS |

## Interpretation

Semantic neighbors are the smallest tested policy that reliably bootstraps
new clusters at every structural height and crosses Room anchors after exact
invocation-Namespace filtering. Existing-parent routing is useful only after
structure already exists. Temporal/anchor-local routing admits substantial
same-Room noise at its only passing bound and cannot discover the deliberately
unanchored cross-Room relationship.

The selected bounds are experimental operating inputs, not permanent limits
on parent count, graph fan-out, hierarchy depth, or accumulated knowledge.

## Hard-gate evidence

- Exact disjunctive authority-alternative eligibility, including the virtual
  public-boundary marker, is resolved before a policy receives a semantic
  candidate view or requests a recorded similarity.
- Inaccessible and sunset Records contribute no selected ID, score, semantic
  open, considered ID, or aggregate diagnostic count.
- Every fixture-declared required relationship is present within the selected
  bounded neighborhood.
- Two independent executions serialize to the same result for every fixture.
- Strict corpus validation rejects malformed, duplicate, cyclic, unknown, or
  authority-inconsistent fixture structure before evaluation.

## Limitations

- The corpus is synthetic and the semantic similarities are committed outputs
  of a deterministic fake embedding port. They establish policy shape and
  authority ordering, not production retrieval quality.
- This wave evaluates candidate generation only. It does not evaluate model
  parent synthesis, Organizer judgment, Sleep, lifecycle publication, or full
  graph correctness.
- Compared-item counts are deterministic work estimates. Wall-clock timing is
  intentionally not a portable hard gate.
- Cross-Room fixtures reproduce exact alternative and public-boundary
  semantics without running a database, cryptographic grant lifecycle,
  server, or production worker.
- The decision must be revisited with new benchmark evidence if real Organizer
  evaluation shows recurring information loss, excessive embedding cost, or
  structural redundancy.

## Reproduction

```bash
bun run --cwd packages/reflection eval:reflection-candidates
```

The command validates the corpus, recomputes both artifacts, and fails if the
committed JSON or Markdown differs. Use the explicitly non-default `--write`
maintenance mode only when intentionally reviewing a corpus or policy change.
