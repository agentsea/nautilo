# Encryption invariants

This private workspace package is Nautilo's Wave 0 encryption coverage and
default-off enforcement boundary. It does not encrypt product data, create
keys, or expose an activation setting.

The browser-safe package entry point exports only the pure coverage model,
registry audit, activation parser, and report formatter. Filesystem, Drizzle,
migration, DTO, and source scanners are available only through
`@nautilo/encryption-invariants/node`.

## Commands

From the repository root:

```bash
bun run encryption:check
bun run encryption:inventory
bun run encryption:indicators
bun run encryption:assurance
bun run --cwd packages/encryption-invariants test:unit
bun run --cwd packages/encryption-invariants test:coverage
bun run --cwd packages/encryption-invariants test:integration
bun run --cwd packages/encryption-invariants test:property
bun run --cwd packages/encryption-invariants test:mutation
```

`encryption:check` is credential-free and read-only. It inventories the actual
repository, validates the typed registry, checks Drizzle against the committed
migration tail, inventories exact Drizzle insert/update/delete writers, audits
structural HTTP/WS/SSE DTO and source declarations, rejects activation
references, and compares the generated report byte-for-byte.

`encryption:indicators` runs `encryption:check`, decision coverage,
real-boundary integration, and property tests. A separate GitHub workflow runs
these indicators nightly, where failures remain visible without blocking
ordinary development or PR merges. `encryption:assurance` adds mutation testing
for an explicit complete local audit. Mutation assurance is scheduled only on
the first day of each month and remains manually dispatchable. Neither command
is part of commit hooks, pre-push, `ci-gates.sh all`, `ci:local`, or the
pull-request aggregate.

`encryption:inventory` rewrites only
`generated/encryption-coverage.md`. It does not update the baseline or accept a
new observation.

`test:coverage` enforces 100% line, statement, and function coverage over the
pure fail-closed decision modules, including activation-source decisions and
report formatting. Node scanners are additionally exercised against real
repository boundaries and focused negative fixtures in `test:integration`.
`test:mutation` independently requires every configured security-relevant
decision mutation to be killed; there is no retry or survivor allowance.

## Updating coverage

Do not regenerate or bulk-replace the initial baseline. A newly observed
surface must be reviewed and then handled explicitly:

1. Prefer a precise classified entry with the required evidence when the
   observation has an honestly supported classification.
2. Do not describe a future bridge as implemented. Only the exact committed
   Wave 0 snapshot may remain owned baseline debt. Its count and SHA-256
   fingerprint are independently locked; adding a current debt row does not
   grandfather a new observation and fails alongside the unknown observation.
   Updating that lock is a deliberate reset of the initial snapshot, never the
   normal classification workflow.
3. When a new locator is demonstrably another representation or call site of
   one exact frozen plaintext boundary, add a reviewed existing-debt link
   instead of inventing new debt or lying about encryption. The link must
   identify its exact frozen target, remain on the same semantic boundary, and
   carry executable evidence. Missing, non-frozen, wrong-boundary, and stale
   links fail closed; the generated report shows the inherited release impact.
4. Register each open DTO leaf against either a concrete closed schema or its
   exact debt ID. A route-wide `unknown`, `json`, or wildcard declaration is
   rejected.
5. Review every new or stale source alarm. The exact alarm locator snapshot is
   committed so a hash cannot hide which call site changed. The initial exact
   alarm manifest records owned, release-blocking review debt separately from
   the semantic coverage registry: a mechanical `fetch`, file write, or log
   call is not automatically a distinct persisted-data surface. Later review
   replaces each alarm-debt closure with a semantic declaration or an exact
   reviewed exclusion; an unmapped alarm always fails the check.
6. Run `encryption:inventory`, inspect the generated diff, then run
   `encryption:check` and all five package assurance lanes.

The generated report contains no timestamp or absolute checkout path. Baseline
debt blocks applicable release claims until later encryption waves replace it
with implemented classifications and executable negative evidence. It also
records deterministic fingerprints and counts for source alarms, schema and
migration structures, DTOs, activation lifecycle coverage, exact exclusions,
and every repository verification category.
