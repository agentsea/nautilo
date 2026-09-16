# D577 security-research qualification

This is a deliberately vulnerable synthetic repository and an evidence record for Task status, source access and security-research delivery. It is not a security clearance for Nautilo. The fixture exposes ordinary JavaScript functions, not a deployed HTTP service. Keep the independent oracle outside the model's Current Folder.

## Live model acceptance

On September 5, 2026, the ordinary Nautilo Task path ran `openai:gpt-5.6-sol` against a fresh standalone copy of `fixture/`: 8 committed files, 4,752 bytes and 110 lines. Git HEAD was `2931d290d2a85b4d07ebd4380ec57280cfa011f1`; an ignored, untracked `dist/generated.js` comment was added afterward. The brief requested broad, read-only security research, source evidence, counterevidence and honest coverage. It did not disclose the planted bugs or oracle. No repository code execution or external-account access was available to the model.

The run used an isolated qualification environment. Personal instance, session,
and Task identifiers are retained in the private acceptance record.

All scanners returned **zero observations**. Gitleaks, Trivy and Semgrep completed; OSV reported unavailable dependency coverage because the fixture had no supported package source. The LLM nevertheless found both planted bugs:

1. A project-only authorization cache reuses one user's allow decision for another user. The report traced API, policy and shared store and identified the safe fresh-membership preview as counterevidence.
2. Export creation authorizes the supplied project ID, while the worker dereferences an independent document ID. The attacker owns the resulting job and can download another project's document. The report correctly distinguished the valid download-owner check from the missing document/project binding.

It rejected an unsupported authentication-bypass claim because the documented trusted gateway is outside the repository, left revocation semantics unresolved, and called tracked/dirty provenance unknown rather than treating ignored dist presence as committed source. It explicitly did not execute the tests. Independent `oracle.test.mjs`, run afterward outside the model's folder, reproduced both confidentiality failures and confirmed the safe controls.

The ledger remained **partial** after finalization and two result pages. `reportReady: true` and `nextCursor: null` did not promote coverage to complete. The persisted Markdown artifact returned HTTP 200, 18,406 bytes, with the report matching the final assistant answer. See [actual report](receipts/2026-09-05-sol-report.md), [task/ledger receipt](receipts/2026-09-05-sol-receipt.json), and [fixture hashes](receipts/2026-09-05-fixture-sha256.json).

## Startup and evidence measurements

The latest scanner parser was exercised with the real, manifest-pinned managed scanner suite after the live LLM run. A fresh temporary managed cache took **21,737 ms** for acquisition and execution; repeating with that cache took **988 ms**. Preparation callbacks fired at **0.692 ms** and **0.171 ms**, before acquisition. These are producer callback timings, not browser paint latency. Acquisition dominated the cold run (last component ready at 21,320 ms); warm verification finished at 575 ms. Both runs preserved zero-hit and unavailable-lane semantics. The temporary benchmark cache was removed by its owning script. See [phase events](receipts/2026-09-05-startup.jsonl).

Atomic admission of 227 synthetic sanitized observations took **2.07 ms**, versus **367.09 ms** for the previous repeated full-ledger writes in the same experiment. This measures ledger admission only and does not explain the old Mac's entire delay. See [measurement](receipts/2026-09-05-admission.json).

A blocked-acquisition regression proves progress is emitted before resolution and that cancellation reaches the owned request. Relay correlation and owner/run checks reject unrelated progress. Real PostgreSQL approval tests and lifecycle mocks cover accepted resume, denied/duplicate claims, chained waiting and stopped-run protection. Persisted metadata contains fixed stages, probe names and timestamps, not tool arguments or source contents.

## Source and result limits

Text reads now use 64 KiB response pages, independent of total file or line length. Tests select a late range after an 18 MiB prefix and reconstruct long Unicode/CRLF/BOM lines byte-for-byte. Cursors bind byte/line positions to the reader session; a restart expires them and requires restarting the requested range. Identity/size/mtime/ctime stamps reject ordinary source mutation; they are not immutable filesystem snapshots. Memory scales with the page; seeking a late line still traverses its prefix.

Scanner JSON is incrementally parsed by result group, sanitized and admitted without a total-report byte cap. A >20 MB regression preserves 1,000 distinct findings and strips secret values. Invalid tails retain valid sanitized prefixes and mark the lane incomplete. Memory scales with the largest raw result group plus normalized observations; this is not a constant-memory ledger. Large individual OSV/Trivy groups still require proportional memory.

`limits:check` passed with 4,615 observations, 507 reviewed and 4,108 frozen legacy entries; no new legacy debt was admitted. The text page and format-sniff buffers have evidence-backed lossless decisions. The existing 16 MiB binary/write/media transport and 10 MiB model image/PDF admission caps remain named D577 debt requiring chunked or provider-derived transport; disclosure alone does not justify them. Related document chunk routing was inspected separately. The detector provides syntax inventory, not semantic authority: unsupported languages, dynamic/generated relationships and runtime policies still require manual review.

## Verification and reproduction

- `bun run --cwd packages/agent test:unit`: 3,717 passes across normal and isolated suites.
- Runtime unit suites: 1,790 passes; Desktop unit suites: 2,572 passes before the parser addition, followed by all 11 updated probe tests passing.
- Relay unit suite: 334 passes; types: 190; focused Workbench task state/transcript: 33 plus 2 isolated drawer tests.
- Real PostgreSQL approval integration: 4 passes; isolated approval lifecycle: 5; byte/guarded-file tests: 27.
- Affected package typechecks, Desktop Electron build, eval typecheck, changed-code lint, unused gate and limit gate passed. Twenty pre-existing lint errors in the touched Desktop integration test were reproduced from base and repaired with typed JSON assertions and Bun-compatible promise assertions; the full file now lints. The preserved JavaScript audit corpus uses ordinary JS lint rather than a new TypeScript contract that would alter the measured bytes.
- `node --test dev/evals/security-research/fixture/behavior.test.mjs` and `node --test dev/evals/security-research/oracle.test.mjs`: three passes each.
- Reproduce scanner timings with `bun dev/evals/security-research/benchmark-startup.ts /absolute/path/to/standalone-fixture`; reproduce admission with `bun dev/evals/security-research/benchmark-admission.ts`.

[Check counts](receipts/2026-09-05-checks.json) identify the suites separately; do not sum overlapping focused tests as unique coverage. Base source was `9480e19dad3ef994773746e478c8dc1eebbba02b` plus the D577 working diff. The model run preceded the final scanner streaming parser and cursor authentication hardening; the final code was separately covered by the real scanner benchmark, byte tests and build. This receipt is local qualification, not signed-package or release qualification.

## Remaining qualification

The old incident was partial: 11m 06s including approvals, 33 file results, two hypotheses, and only one of eight mapped surfaces labelled reviewed. No evidence establishes a comprehensive review of the two-million-line checkout. Its original two-minute startup cannot be partitioned retrospectively into model, acquisition and scanning time.

This smaller fixture proves meaningful LLM analysis outside scanner leads in one run. It does not establish recall on a large repository, prevent every future unsupported model claim, or prove exhaustive coverage. Nautilo-scale research, packaged old-Mac cold/warm UI timing, measured first browser paint/cancellation latency, and a live human-approval chain across reload remain follow-up acceptance. Contract tests and producer measurements cover those mechanics without claiming those additional live journeys occurred. Source qualification does not establish deployment.

## PR integration corrections

PR #1225's first CI run exposed Mobile's dependency on the old generic waiting label and two newly added query-inventory entries. Mobile now retains an explicit human-reply reason only after the matching owner-scoped event; generic awaiting remains needs-attention and resumed work clears the reason. All 219 Mobile unit files pass. The Desktop range parser also retains strict invalid-range rejection and its existing zero-offset alias.

The new DB fragments are contained in `recordTaskPreparation`: a parameterized JSONB update of fixed validated status facts and an exact running TaskRun existence predicate, combined with the owner/task/running guards. The query inventory was regenerated after reviewing those predicates; it does not authorize broader data access.

The optional standalone Mobile TypeScript invocation reports three errors outside this diff (user-agreement's existing unknown platform union and two api-client `.ts` import-extension settings); Mobile has no package typecheck script. Its full unit suite and the repository's required remote typecheck remain separate checks. No errors were suppressed to obtain a green required gate.

## Section-completion qualification

The `section-fixture/` corpus adds four packages (HTTP, identity, storage and
jobs), independent cross-file vulnerabilities and safe counterexamples.
`section-oracle.test.mjs` stays outside the model's Current Folder. Its six
combined oracle/behavior checks pass; this is fixture verification, not LLM
qualification.

On September 6, the controlled `repair-probe.ts` passed malformed history
through the production output preflight and sent it to the automatically
selected security-research model, `openrouter:z-ai/glm-5.3`. The model returned
one valid evidence-record call in 15.425 seconds and accurately identified that
the cache key omits user identity. The probe executes no tools. See the
[complete sanitized receipt](receipts/2026-09-06-glm-repair.json).

A later qualification run verified session restoration across a clean restart.
Two ordinary background Tasks used the automatically selected GLM 5.3 with no
model override. Both used the same standalone eight-file, 5,540-byte corpus;
the brief supplied the scope but did not disclose the oracle or planted bugs.
The model could read source and record research, but could not execute the
repository or access the oracle outside Current Folder.

The first run completed in 5m 6.715s: seven source/document reads totaling
5,520 bytes, 52 tool results, all four packages plus cross-boundary review,
and all three planted vulnerability classes despite zero scanner findings.
It repaired three schema-validation failures and three premature finalizations
within the original Task. All 32 code-evidence file hashes matched the fixture.
Its report nevertheless misdescribed an absent external gateway as an access
restriction and did not identify unavailable scanner coverage as another
partial-status cause. That explanation failed acceptance. The
[first report](receipts/2026-09-06-glm-section-report.md) and
[receipt](receipts/2026-09-06-glm-section-audit.json) retain this defect honestly.

The final protocol distinguishes repository scope, external assumptions and
actual read denials, and requires separate explanations of source coverage
and scanner coverage. The runtime artifact header makes the same distinction.
A fresh ordinary Task on the rebased build completed evidence closure for all
four packages and all three mapped cross-package boundaries; the absent
gateway is source-backed not_applicable, with its trust assumption retained.
The second run completed in 7m 14.369s with 59 tool results, 26 ledger records
and 28 code-evidence file hashes verified against the source. The report found
all three oracle vulnerability classes, correctly attributed partial status
solely to unavailable OSV dependency coverage, and retained the external
gateway as an assumption rather than a denied read. See the
[corrected report](receipts/2026-09-06-glm-scope-report.md) and
[complete receipt](receipts/2026-09-06-glm-scope-audit.json). The report
approximates line count as ~150; the measured corpus is 128 lines including
two .gitignore lines. Its source-byte and hash measurements are recorded in
the receipt. The model did not execute code; six independent oracle/behavior
checks passed afterward.

Real Task source cards passed native visual inspection in light and dark
themes on the theme-fix build. They preserve read-only source, original line
numbers, and horizontal scrolling at a 360 CSS-pixel constrained card width.
The independent DOM regression preserves all 350 received lines. These are
separate proofs: the native fixture is small, and the constrained card is not
a full mobile-window acceptance. Screenshots remain private because the
populated clone's surrounding workspace includes unrelated baseline names.

This qualification proves source reasoning beyond deterministic scans and
same-Task recovery on a small repository. It does not establish exhaustive
coverage or reasoning quality on a two-million-line repository, or establish deployment. Matching server and Desktop deployment is still
required.
