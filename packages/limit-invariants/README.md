# Limit invariants

This private workspace package is Nautilo's developer-only inventory and drift
gate for hard-coded ceilings, timeouts, retries, retention, truncation,
pagination, batching, payload bounds, and concurrency limits. It is not a
runtime package and exposes no browser, server, database, Workbench, Desktop,
Mobile, Genie, or customer-instance surface.

The scanner is deliberately dumb. It reports deterministic source facts,
parser-grounded extraction confidence, and transparent mechanical priority
cues. It never infers authority, legitimacy, classification, approval, or
remediation. The `limit-preflight` Codex skill performs the semantic
investigation and either records an evidence-backed reviewed decision or
surfaces the unresolved decision to the user.

## Commands

From the repository root:

```bash
bun run limits:inventory
bun run limits:report
bun run limits:check
bun run limits:scout
```

`limits:inventory` regenerates mechanically grouped primary investigation
packets and the matrix projection. Each packet gives one producer/literal
anchor, every linked site, exact expressions, effects, and ordering reasons;
it is not a verdict. `limits:report` regenerates the human matrix.
`limits:check` fails for new, changed, removed, stale, duplicated, malformed,
or uncovered primary packets and for stale matrix output.

`limits:scout` writes a non-blocking wide-scout projection for generic measured
comparisons and scheduling timers. Test, fixture, generated, migration, and
vendor sites are evidence lanes, not independent blocking policy decisions.
The skill inspects them while proving or rejecting a primary packet. These
lanes are semantic syntax categories, not machine judgments about legitimacy.

## Discovery contract

The default walk covers `.github`, `apps`, `bin`, `deploy`, `dev`, `infra`,
`native`, `ops`, `packages`, `packaging`, and `scripts`. It parses JavaScript
and TypeScript with the TypeScript compiler API, JSON structurally, and narrow
boundary assignments or timeout commands in YAML, TOML, and shell files.
Other extensions are unsupported and intentionally absent rather than being
reported with invented confidence.

Dependency trees, build outputs, coverage, release output, the scanner's own
package, existing invariant baselines, Bun/npm locks, and the ordinary
generated/dist/build directory families are excluded. Test, fixture,
migration, generated, and vendor source is routed to the evidence lane instead
of being admitted as production policy. A malformed live JSON source fails
with its exact repository path; malformed evidence fixtures remain evidence
noise rather than blocking the product inventory.

`bun run --cwd packages/limit-invariants admit-legacy` is a one-time
initialization command and refuses to replace a non-empty legacy ledger.
`shrink-legacy` can only retain exact current fingerprints or remove rows; it
cannot absorb a new or changed observation.

## Review workflow

1. Run `bun run limits:inventory` and inspect the factual diff.
2. Invoke the canonical `limit-preflight` skill to trace the complete
   producer-to-consumer behavior and its real authority.
3. Add or update a row in `baseline/reviewed-limit-decisions.jsonl` only when
   the evidence supports the classification and disposition. If it does not,
   surface the decision to the user.
4. Remove the matching legacy row with `shrink-legacy`, regenerate the report,
   and run `bun run limits:check`.

There is no permanent `approved arbitrary` state. A local literal, comment,
configuration knob, test, or existing ledger row is not policy authority.

## Baseline and measured cost

The checked-in baseline records primary investigation packets, not every
boundary-shaped syntax site. Frozen legacy packets remain visible and unable
to grow through ordinary commands; frozen does not mean approved or safe.
The non-blocking scout can broaden an investigation without turning every
counter comparison, timer scheduler, or test fixture into a demanded review.

The scanner adds no internal timeout, candidate cap, file-size ceiling, or
concurrency clamp. Record full-scan wall time, memory, packet/site counts, and
repeat-run hashes whenever the discovery contract materially changes; keep the
required full scan only while the measured cost fits the invariant lane.

The schema-v2 baseline was measured on 2026-08-27 in the feature worktree: two
complete inventory runs took 7.10 s and 7.14 s, each produced 4,320 primary
packets linking 4,824 sites, and produced identical inventory, focus-map, and
matrix SHA-256 hashes. A separate full check took 8.06 s with 476,725,248 bytes
maximum resident set size. The agent-facing focus map routes first to 17 named
semantic-loss junctions; none of these counts are semantic verdicts.
