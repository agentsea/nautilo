# Reflection Wave 9 foreground-context policy evaluation

**Status:** GENERATED — deterministic offline packing and continuity evidence.

**Corpus:** `reflection-foreground-context-2026-08-15.1`

**Selected:** `balanced_semantic_first`

**Structural hard gates:** PASS

Candidate | All gates | Continuity
---|---|---
balanced_semantic_first | PASS | 100.0%
journal_first | FAIL | 83.3%
records_first | FAIL | 50.0%

The selected policy preserves the mandatory recent suffix, then gives bounded
space to both Journal continuity and organized Records before older turns.
The two rejected orders each starve one semantic source in the cramped corpus.
No runtime semantic dedupe or quality classifier is introduced.

The 5 s foreground deadline bounds the complete embedding-plus-exact-search
contribution. It is distinct from the SQL statement timeout and was selected
after live OpenAI plus populated-PostgreSQL measurements on 2026-08-17:
20 end-to-end runs had p50 926 ms, p90 1,642 ms, p95 2,056 ms, and max
2,416 ms after disabling transaction-local PostgreSQL JIT. The 5 s ceiling
is about 2.4x the observed p95, leaving room for slower production hosts and
networks while still bounding provider stalls. Production deadline misses remain
content-free diagnostics and must inform later tuning.

## Reproduce

```bash
bun run --cwd packages/reflection eval:reflection-foreground
```
