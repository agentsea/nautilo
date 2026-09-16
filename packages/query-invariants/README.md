# Query inventory guard

This package implements ISSUE-M223 Phase 1. It statically inventories direct
SQL statements and `sql` fragments across application, operator, and test
source. Schema-derived Drizzle builder calls are intentionally outside this
baseline: the guard measures the direct-SQL surface being retired or contained.

Each generated observation records a stable source/symbol locator, normalized
SQL fingerprint, owner, database handle, operation, tables, SQL features,
reachability, boundedness, security sensitivity, proposed disposition, and
safety opportunity. The proposals are conservative syntax classifications,
not proof that a conversion preserves behavior or query plans.

`baseline/full-drizzle-sample.jsonl` tests that optimistic end of the syntax
classification. It deterministically selects the first, median, and last
locator for every live consumer owner, then pins a code-reviewed decision to
each SQL fingerprint. This is a stratified diagnostic sample, not a statistical
confidence interval; it exposes classification error without pretending that
21 observations prove the other candidates safe to migrate.

`baseline/reviewed-query-decisions.jsonl` is the separate human-reviewed layer
for every live consumer-owned observation that the syntax pass leaves
unresolved or proposes retaining direct. Decisions pin both locator and SQL
fingerprint, carry a code-grounded rationale, and distinguish statements,
transport adapters, SQL fragments, and duplicate composed executions. The
check fails when a decision is missing, stale, duplicated, or silently applied
to changed SQL.

Run `bun run db:query-inventory:check` to reject added, removed, or changed
observations. After reviewing every reported delta, run
`bun run db:query-inventory` to regenerate
`baseline/query-inventory.jsonl`. Its one-record-per-line format keeps query
deltas reviewable. Do not hand-edit the generated baseline.

The guard fails closed for database calls whose SQL expression cannot be
resolved statically. Migrations stored as standalone `.sql` files are not query
call sites and are not included; TypeScript migration utilities, tests, and
operator scripts are classified by reachability.
