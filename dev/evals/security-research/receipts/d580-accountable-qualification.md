# D580 security research qualification

## Scope and acceptance bar

The frozen Harbor target is `accountable-fixture/`: 36 files, 39,926 UTF-8 bytes and 704 lines, across eight application packages plus tests. Its standalone Git commit is `2e62619bad8336132dc8535e40be369537b4b268`. The external oracle and grading notes were outside the model's authorized Current Folder. All target file hashes remained unchanged after the runs below.

The independent oracle contains 15 executable tests covering six cross-file vulnerability families and their safe lookalikes, including cache and deferred-job revocation timing. The insecure tests assert that the intended challenge remains present; they are not assertions of desired secure behavior. Qualification requires supported traces, correct distinctions from safe controls, actionable fixes and tests, retained notes, complete ledger export and a real readable report. Finding counts and elapsed time alone do not pass.

This small fixture does not simulate a two-million-line codebase, prolonged context pressure or every transport boundary. Dedicated regression tests cover discovery pagination, context recovery, source preservation and report readiness separately.

## Observed runs

| Run | Model and build | Observed outcome | Qualification |
| --- | --- | --- | --- |
| First default run | OpenRouter GLM 5.3; initial implementation | Delivered all 36 source files but timed out before accepted research notes or report. Reasoning liveness and relay progress defects were identified and fixed. | Failed runtime delivery; semantics ungraded. |
| Second default run | OpenRouter GLM 5.3; `78b59fa07` | 18m15s. Correctly traced four exploit families, missed direct bundle scoping and real invitation-token replay. Repeated a section-key mismatch, stopped with `no_progress`, and lost the final error receipt. | Failed semantics and report delivery. |
| Third default run | OpenRouter GLM 5.3; `e5bc8fd3e` | Corrected invitation-token analysis but still falsely declared direct bundle selection scoped. Its crossreference check did not re-open that conclusion. Hidden combined evidence-reference limit caused repeated opaque record errors. The operator canonically stopped this isolated failed trial; it did not terminate spontaneously. | Failed semantics; no report. |
| Blind comparison | OpenAI GPT-5.6 Sol; same `e5bc8fd3e` build | 10m22.515s. All six families with relevant lifecycle variants and safe controls. Eight actual source-window contradiction rereads. Three final result pages, full report persisted and opened in Nautilo. | Passed this fixture's source reasoning and report delivery; not default-route qualification. |

The comparison prompt changed only the requested model: the audit instructions and frozen source were the same. No oracle hints were supplied. The final ordinary run below separately qualifies configured-model inheritance and accumulated-reference corrections after integration.

## Blind comparison evidence

- Task: `326740bf-69cc-4e44-9a08-518a4fe1026a`; run: `911c8b72-f727-4413-a03e-c644412e4142`.
- Started: `2026-09-07T11:26:28.231Z`; completed: `2026-09-07T11:36:50.746Z`.
- Resolved model: `openai:gpt-5.6-sol`; it was explicitly pinned for this diagnostic comparison.
- Workspace Markdown artifact: `artifacts/security-reports/security-scan-326740bf-69cc-4e44-9a08-518a4fe1026a-911c8b72-f727-4413-a03e-c644412e4142.md`.
- Actual retrieved bytes: **206,893**, matching the authenticated artifact response length. SHA-256: `73fda9442cbf02625f3d47a6d49e05914667a965384c878f29043f5dcfb8aaec`.
- Independent reconstruction: all **53 latest accepted records** retain exact substantive fields, all referenced source IDs resolve in the **195-entry citation index**, and the inventory contains **36 files plus one disclosed exclusion**.
- The artifact opened as rendered Markdown, with its full review log, citation index and inventory present; source task cards used CodeMirror. No rendering error was observed.
- Scanner observations: zero. The report distinguishes complete inventoried source review from partial scanner coverage and unavailable OSV dependency analysis. Repository tests were inspected by the model, not executed.

| Hidden behavior | Independent report assessment |
| --- | --- |
| Cache authority | Cross-user reuse, denial poisoning, membership revision/revocation/expiry remediation and a revoke-after-warm regression are present. |
| Direct bundle selection | Explicit IDs use global lookup; scoped preview and queue admission are correctly distinguished. |
| Deferred and completed exports | Both revocation-before-execution and revocation-after-completion are covered; fresh publication authorization is recognized. |
| Upload destination | Correctly identifies foreign-project creation, distinguishes filename checks, and notes incorrect activity attribution. |
| Invitation as document share | Real pending recipient can read before redemption with a valid signature; missing consumer audience/purpose and scope checks are traced. |
| Export completion event | Organization-wide subscription receives private document bodies; metadata-only activity and owner-only download are distinguished. |

Minor editorial issues remain: the report contains the invalid identifier `CWE- confused-deputy`, and remediation snippets are illustrative rather than executable patches. These do not undermine the supported exploit traces. No claim is made that one successful model run establishes a universal best model or exhaustive production security.

## Follow-up defects reproduced by the live tests

1. Security routing substituted catalog-preferred GLM even when a different model was configured. The correction preserves the configured model and explicit pins/profiles, without replacing one forced provider with another.
2. A successful repaired file command could lose its activity label because progress observed raw arguments. The correction consumes content-free operation metadata minted by the canonical invocation service, never arbitrary file contents.
3. A valid record request with 20 citations and two existing evidence links became 22 stored references and failed the hidden aggregate maximum of 20. All four sampled real requests passed input validation and failed only after the ledger combined their references. The correction must preserve accumulated evidence, including replay and final export, rather than drop links or raise the limit arbitrarily.

## Final ordinary-path qualification

**Passed the smaller-fixture acceptance bar**, with the limitations below. Runtime build: `ee70b8a02d547727070c0bdc7415c2d7fa863e7a`. The original blind prompt requested the normal default research model; `requestedModelId` was null, resolving to the configured `openai:gpt-5.6-sol`. No model setting or credential was changed.

- Task `6e22beaa-efe3-4793-8a9d-4743b57e3ca0`; run `3fbb9f56-4287-470d-b703-5355cfc751f1`.
- Started `2026-09-07T12:11:01.119Z`; completed `2026-09-07T12:24:39.915Z`: **13m38.796s**.
- All **36 source files / 39,926 unique bytes** matched the frozen source hashes. Six behavioral review units assigned all files; notes were accepted during exploration, before all source reads finished.
- Seven actual contradiction rereads revisited access caching, sharing, bundles, uploads, jobs, events and invitations. Review revised the callback-failure hypothesis and finding rather than merely asserting that a recheck happened.
- Independent grading found all six seeded vulnerability families, their lifecycle variants and the six safe controls correctly distinguished. Eight findings were reported: six High, two Medium. The two additional defensible Medium findings concern voluntary invitation redemption replacing existing membership and integration-dependent synchronous callback failures; neither establishes arbitrary remote code execution or forced privilege escalation.
- Four final result pages retained **52 latest accepted records, 223 citations and 37 inventory entries** (36 files plus one disclosed exclusion), with every referenced source ID resolving. No security-tool error receipts occurred in the 243-entry transcript.
- The authenticated Workspace artifact was retrieved unchanged: **228,880 UTF-8 bytes**, matching its response length; SHA-256 `124fd776bcb2952ee5580d02af783c4ae25de733ec03654a95eae1c2fbc48b9b`.
- Artifact path: `artifacts/security-reports/security-scan-6e22beaa-efe3-4793-8a9d-4743b57e3ca0-3fbb9f56-4287-470d-b703-5355cfc751f1.md`. It opened as readable Markdown with its full review log, citation index and inventory.
- Scanner observations were **zero**. Gitleaks, Trivy and Semgrep completed with **limited** coverage; OSV was **unavailable**, finding no supported package sources. This was meaningful model source analysis, not successful full scanner coverage. The model inspected repository tests but did not execute them.

### Remaining report caveats

The final HBR003 prose correctly narrows the bundle flaw to the direct endpoint and recognizes queued-export validation. However, its retained finding impact still says “any deferred workflow”; later notes and final prose correct this but the durable finding wording was not fully reconciled. The original report is preserved unchanged, not silently edited to hide this inconsistency.

The prose also omits some exact scanner coverage labels. The follow-up export correction below retains canonical coverage independently of prose. Neither structural completion nor this successful small run proves exhaustive reasoning on two million lines or reliable multi-hour execution.

### Presentation and export corrections validated after the audit

Acceptance exposed a real display defect: generic transcript depth limits replaced nested reference objects before the security renderer validated the receipt, hiding otherwise intact research notes. A dedicated display-only projection now validates canonical receipts first, preserves accepted substantive text, and replaces reference/index arrays with exact counts and recovery guidance. It carries no execution cursor or report-readiness authority; generic limits for other receipts are unchanged.

After rebuilding and reloading the real Workbench, **all 87 accepted record acknowledgements** rendered their complete accepted scalar text, with **zero generic fallbacks or missing fields**. All **43 source-read cards** remained read-only CodeMirror editors. The source runtime and completed audit were not restarted or rerun for this display-only change.

The final report exporter now also includes the **exact final accepted ledger status**, including each scanner's coverage and error. Focused tests cover final-page selection, exact status retention and Markdown fence safety, alongside runtime artifact tests (21 tests / 114 assertions). Reconstruction from the actual four final pages verified the new appendix separately. The original live artifact above predates this export addition and remains unchanged.

UI renderer checks passed 6 tests / 53 assertions; generic transcript projection passed 3 tests / 18 assertions. Workbench build, shared types and scoped lint passed. Full exact-head remote CI and the merge receipt are recorded in PR 1231 and the D580 tracking shard.
