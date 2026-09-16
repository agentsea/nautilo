# Reflection Wave 5 authority-algebra feasibility benchmark

**Status:** GENERATED — deterministic offline authority corpus with measured local latency.

**Corpus:** `authority-algebra-corpus-v1`

**Hard gates:** PASS

Scenario | Result | Leaves | Input choices | Peak | Final | Pruned | Operations | Resumptions | Checkpoint bytes | Observed / budget ms
---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:
representative-overlap | PASS | 3 | 5 | 2 | 2 | 1 | 11 | 1 | 1522 | 0.768 / 250
dominance-heavy | PASS | 8 | 512 | 1 | 1 | 504 | 519 | 74 | 38331 | 17.444 / 500
crypto-boundary-256 | PASS | 1 | 256 | 256 | 256 | 0 | 256 | 36 | 32467 | 13.212 / 1000
crypto-boundary-276 | PASS | 1 | 276 | 276 | 276 | 0 | 276 | 39 | 35046 | 14.187 / 1000

Latency is environment-specific evidence. Check mode re-runs its ceiling gate while comparing all deterministic fields to this reviewed artifact.

```bash
bun run --cwd packages/reflection eval:reflection-authority
```
