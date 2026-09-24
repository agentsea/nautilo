# Limit invariants

This private workspace package is Nautilo's optional developer-only inventory
for hard-coded ceilings, timeouts, retries, retention, truncation,
pagination, batching, payload bounds, and concurrency limits. It is not a
runtime package and exposes no browser, server, database, Workbench, Desktop,
Mobile, Genie, or customer-instance surface.

No pre-push hook or pull-request CI job invokes a limit-policy gate or check. A
separate human review of constants introduced by added code owns the decision:
it identifies the constants mechanically, investigates their behavior, and
presents the Human with rationale and concrete options. This scanner can supply
supporting evidence for that review.

The scanner is deliberately dumb. It reports deterministic source facts,
parser-grounded extraction confidence, and transparent mechanical priority
cues. It never infers authority, legitimacy, classification, approval, or
remediation. The `limit-preflight` Codex skill performs the semantic
investigation and either records an evidence-backed reviewed decision in the
tracked review ledger or surfaces the unresolved decision to the user. The
inventory, ledger, and generated reports are visible repository artifacts so
their history and current coverage can be reviewed with the source they govern.

## Commands

From the repository root:

```bash
bun run limits:inventory
bun run limits:report
bun run limits:check
bun run limits:scout
bun run --cwd packages/limit-invariants review --repository agentsea/nautilo --head <exact-40-character-sha>
```

`limits:inventory` regenerates mechanically grouped primary investigation
packets and the matrix projection. Each packet gives one producer/literal
anchor, every linked site, exact expressions, effects, and ordering reasons;
it is not a verdict. `limits:report` regenerates the human matrix.
`limits:check` fails for new, changed, removed, stale, duplicated, malformed,
or uncovered primary packets. It requires the local inventory, reviewed
decisions, frozen legacy debt, and legacy lock; missing evidence fails closed.
The matrix and investigation map are local non-authoritative reports, so their
freshness does not control the semantic check.

Repository automation does not run the limit-policy check or require a review
status. Run the inventory commands only when their broader historical evidence
helps an investigation; the pull-request constants review remains the decision
point.

The `review` CLI remains available for an explicit maintainer action. It
requires an explicit GitHub `owner/name`, a full commit SHA, a matching
`origin`, and a worktree with no tracked or non-ignored untracked changes. It
runs the strict local check, verifies the same clean HEAD again, then publishes
only the generic `limit-policy-reviewed` success status. No hook or CI workflow
calls it or requires that status.

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

## Optional inventory workflow

1. Run `bun run limits:inventory` and inspect the factual diff.
2. Trace the complete producer-to-consumer behavior and its real authority.
3. Add or update a row in
   `baseline/reviewed-limit-decisions.jsonl` only when the evidence
   supports the classification and disposition. If it does not, surface the
   decision to the user.
4. Remove the matching legacy row with `shrink-legacy`, regenerate the report,
   and run `bun run limits:check`.

There is no permanent `approved arbitrary` state. A local literal, comment,
configuration knob, test, or existing ledger row is not policy authority.

## Tracked audit artifacts

The tracked `baseline/*` files record primary investigation packets, not every
boundary-shaped syntax site. Generated reports live in `generated/`. Review
their diffs with the source change and keep them free of credentials, personal
data, private planning references, and workstation-specific paths. Frozen
legacy packets remain visible and unable to grow through ordinary commands;
frozen does not mean approved or safe.
The non-blocking scout can broaden an investigation without turning every
counter comparison, timer scheduler, or test fixture into a demanded review.

The scanner adds no internal timeout, candidate cap, file-size ceiling, or
concurrency clamp. Record full-scan wall time, memory, packet/site counts, and
repeat-run hashes whenever the discovery contract materially changes; keep the
required full scan only while the measured cost fits the invariant lane.
