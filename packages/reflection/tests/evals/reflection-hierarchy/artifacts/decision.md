# Reflection Wave 3 synthetic hierarchy evaluation

**Status:** GENERATED — deterministic, offline, dormant fixture evidence.

**Corpus:** `2026-08-21.1`

**Candidate policy:** `candidate-policy-v1`

**Organizer prompt:** `hierarchy-organizer-v1`

**Structural hard gates:** PASS

## Scenario gates

Scenario | Result | Purpose
---|---|---
postgres-neon-decision | PASS | PostgreSQL and Neon arguments retain their final decision.
valuable-independent-leaf | PASS | A useful leaf remains searchable without a forced parent.
emergent-depth | PASS | Recursive synthesis creates useful depth without predefined levels.
cross-room-exact-intersection | PASS | Cross-Room publication uses the exact audience intersection.
preserved-disagreement | PASS | Conflicting evidence is retained without false consensus.
single-current-parent | PASS | A Record cannot acquire a second current semantic parent.
immutable-correction | PASS | Corrected evidence creates immutable successor history.
partial-dependency-loss | PASS | Remaining evidence supports a truthful replacement.
total-dependency-loss | PASS | All-support loss sunsets without replacement.
scheduled-old-record | PASS | Scheduled paging considers unchanged retained Records.
no-change-convergence | PASS | Repeated unchanged work creates no new graph state.
search-redundancy | PASS | One utility order suppresses redundant ancestor/descendant hits.
deep-evidence-retrieval | PASS | Budgeted continuation traces a deep result to leaves.
multi-attached-memory | PASS | An authored Memory leaf unions valid attachment audiences.
invocation-namespace-authority | PASS | Requester-private access cannot enter shared-Room semantics.

## Semantic diagnostics

These diagnostics describe this small corpus. They are not product thresholds.

```json
{
  "unsupportedClaimCount": 0,
  "usefulParentRecall": 1,
  "redundantParentCount": 0,
  "preservedDisagreement": true,
  "maxStructuralHeight": 2,
  "maxFanOut": 3,
  "noChangeRate": 1,
  "successorChurn": 0.13333333333333333,
  "searchUsefulness": 1,
  "evidenceTraceCompleteness": 1
}
```

## Reproduce

```bash
bun run --cwd packages/reflection eval:reflection-hierarchy
```
