# Reflection Wave 3 real-model benchmark summary

**Status:** REVIEWED — redacted synthetic-fixture evidence, 2026-08-12.

**Provider:** `openai`

**Exact model:** `openai:gpt-5.6-terra`

**Runs per scenario:** `3`

**Corpus:** `2026-08-12.1`

**Candidate policy:** `candidate-policy-v1`

**Organizer prompt:** `hierarchy-organizer-v1`

**Implementation base:** `e5534fc8e1c574206ced7d00aa58a0b1cc265834`
with the uncommitted Wave 3 implementation under review.

## Reviewed outcome

- Structural hard gates: **PASS** for all 9 scenario repetitions.
- Expected operation: **9/9**.
- Required supporting handles: **6/6 parent repetitions**.
- Valuable independent leaf: **3/3 `no_change`**.
- Redundant parents: **0**.
- Repairs: **0**.
- Successor churn: **0**.
- Exact normalized-proposal agreement: **1/3 scenario groups**. The independent
  leaf was byte-stable; both useful-parent scenarios selected stable support
  but varied bounded wording, and one Postgres run varied child order.
- Safe reported usage: 9 calls, 3,273 input tokens, 933 output tokens, 4,206
  total tokens.

The disagreement scenario preserved both competing cost claims in all three
accepted parent statements. No semantic threshold was applied: these results
are review evidence, while structural validation remained the only hard gate.

## Reproduce

```bash
bun run --cwd packages/runtime eval:reflection-hierarchy:model -- \
  --provider openai \
  --model openai:gpt-5.6-terra \
  --runs 3
```

The live report was written to the gitignored, mode-600 transient result
directory. This committed summary contains no prompts, raw provider responses,
reasoning metadata, credentials, headers, error bodies, or real Nautilo source
data.
