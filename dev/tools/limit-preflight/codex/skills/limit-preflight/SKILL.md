---
name: limit-preflight
description: Audit a Nautilo repository or proposed diff for hard-coded ceilings, timeouts, retries, truncation, retention, pagination, batching, payload bounds, and concurrency limits. Use when Codex must run the deterministic limit inventory, investigate the real producer-to-consumer behavior and authority, record an evidence-backed decision, identify arbitrary limits, or surface unresolved policy choices to the user. Do not use for Nautilo runtime or Genie tooling.
---

# Limit Preflight

Use the repository scanner as a measuring instrument and perform the semantic
review yourself. The scanner is deliberately dumb: it reports source facts,
extraction confidence, mechanical priority cues, and fingerprint drift. It
does not know whether a limit is legitimate.

## Choose the mode

- For a repository audit, run `bun run limits:check`, then
  `bun run limits:inventory` when the check reports factual drift. Read
  `packages/limit-invariants/generated/limit-matrix.md` and investigate the
  highest-priority unreviewed or changed observations first.
- For a proposed diff, inspect the diff and run `bun run limits:check`. Focus
  on new and changed observations while still reporting any pre-existing check
  failure that prevents a truthful result.
- If the repository has no `limits:*` commands, perform a code-grounded manual
  review and say that deterministic coverage is unavailable. Do not invent a
  compatible scanner or ledger format in another repository.

Treat a primary observation as an investigation packet, not a confirmed
limit: one deterministic producer or literal anchor plus its linked sites,
expressions, effects, and mechanical ordering reasons. Do not dump every packet
back to the user. Wield the map: start with live reusable semantic loss,
termination, eviction, and retry packets, inspect the complete code path, and
report verified findings.

Read the scout coverage row before relying on the scan. Its supported and
unsupported syntax is the detector's honest boundary. Definition, consumer,
import, caller, generated-consumer, continuation, and policy-family links are
mechanical navigation cues. Verify every cited relationship in source; a link
is not authority and is not proof that two limits share one policy.

Run `bun run limits:scout` when the task calls for a broader hunt through
generic measured comparisons or scheduling timers. Test, fixture, generated,
migration, and vendor matches are supporting evidence lanes; inspect them when
they bear on a primary packet instead of presenting them as independent policy
decisions. Lane assignment is mechanical syntax routing, not legitimacy.

Running an audit does not authorize code changes. Implement remediation only
when the user asked for it.

## Investigate each observation

Trace the complete producer-to-consumer path before deciding:

1. Identify what is actually bounded and the observable effect: truncation,
   omission, rejection, attempt termination, eviction, sampling, summary,
   clamping, pagination, chunking, retries, payload size, or concurrency.
2. Locate the real authority. Valid authority can be an exact provider/model
   catalogue, protocol or file-format rule, platform/security boundary,
   explicit caller/user policy, or measured operational evidence. A literal,
   comment, configuration knob, existing test, or legacy row is not authority.
   Neither an industry convention nor a "field standard" is authority without
   a primary specification or measurement that applies to this exact path.
3. Determine whether full semantics survive. For frames, pages, batches, and
   buffers, prove reconstruction or stable continuation. For recoverable
   partial results, prove that replay uses the same immutable source/version,
   cursor or range semantics are stable, ordering is deterministic, and replay
   is idempotent or safely deduplicated. For terminal partial results, say
   explicitly that no continuation exists and identify what the caller learns
   about completeness and the inaccessible remainder. Disclosure makes loss
   truthful; it does not make the cutoff legitimate.
4. For timeouts, retries, and leases, prove cancellation and owned-child
   cleanup, truthful state, safe retry or resume, and visible recovery. A
   timeout may bound an attempt; it must not silently erase canonical work.
5. Inspect behavioral tests that prove the authority and user-visible result.
   Boundary-only tests do not prove the boundary is justified.
6. After the direct packet is understood, inspect every mechanically related
   policy-family reference. Decide independently whether it shares authority,
   should derive from the same source, or only happens to use the same value.
   Do not stop after the first familiar constant and do not impose a top-N cap.

## Make or surface the judgment

Use one classification: `authoritative_hard_limit`,
`measured_operational_limit`, `lossless_boundary`, `caller_policy`,
`soft_default`, `ui_projection`, `temporary_debt`, or `arbitrary`.

Use one disposition: `retain`, `derive`, `remove`, `redesign`, or
`defer_named`. There is no permanent retained `arbitrary` limit.

Record a decision only when the inspected code and evidence support it. When
authority, acceptable loss, or remediation is genuinely ambiguous, stop at a
clear unresolved verdict and surface the unresolved decision to the user.
Present the exact observation, the verified behavior, the missing decision,
and the realistic options. Never let the scanner, CI, or a plausible-sounding
rationale make that choice by proxy.

## Update the reviewed ledger

Edit `packages/limit-invariants/baseline/reviewed-limit-decisions.jsonl` by
hand after investigation. Pin the exact `locator` and `fingerprint`, and fill
every field with concrete evidence:

- `classification`, `disposition`, `authority`, and `owner`;
- `lossAndCompleteness`, `visibility`, and `continuationOrRecovery`;
- executable `evidence` paths and a code-grounded `rationale`.

Run `bun run --cwd packages/limit-invariants shrink-legacy` when a reviewed
decision replaces frozen debt. Then run `bun run limits:report` and
`bun run limits:check`. Never use `admit-legacy` as an ordinary update path;
it exists only to initialize an empty repository baseline and refuses to grow
an existing ledger.

## Report

Return:

- the deterministic scan/check result and commands run;
- reviewed retained limits with their real authority and proof;
- arbitrary limits with exact removal/derivation/redesign direction;
- unchanged legacy debt, grouped by mechanical priority but not called safe;
- unresolved decisions explicitly surfaced to the user;
- verification results and any detector blind spots.
