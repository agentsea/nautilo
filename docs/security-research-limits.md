# Security research limit review

This review covers the accountable research, discovery continuation, report
export and progress changes. A passing limit check verifies the recorded source
observations and decisions. It does not certify the quality of an LLM audit.

## Changed boundaries

| Boundary | Decision | Actual authority and recovery |
| --- | --- | --- |
| Export/recovery lifecycle queries: `LIMIT 1` | Lossless boundary | Every query selects an exact Task or TaskRun primary key. No collection is sampled. PostgreSQL tests cover delivery retry, paused/cancelled races, disconnected Resume and same-run recovery. |
| Restored Desktop binding expiry | Existing authority retained | Reconnect refreshes only the transport session after owner, Desktop, pairing, roots and current capabilities pass. Original capture time is preserved; legacy checkpoints use the conservative Task creation time, never the time of Resume. Unavailable restoration preserves the checkpoint for later reconnect. |
| Directory list defaults: 1,000 / 5,000 entries | Soft defaults | Caller-overridable positive page size. The complete ordered discovery is fingerprinted, and every eligible entry remains reachable through `discoveryCursor`. The former 20,000-entry ceiling is removed. |
| Glob / grep defaults: 1,000 / 200 entries | Soft defaults | Ripgrep runs to completion. Only the selected page is retained; total count, offsets, output version and continuation are returned. The result count is not a source-review count. |
| Recursive directory depth | Caller policy | No implicit depth stops recursive discovery. An explicit requested depth marks each omitted subtree; exhausting its page cursor does not erase these scope exclusions. The scanner's new `depth_limit: 0` packets are counter initializers. |
| Ledger results: 100 aggregate entries per page | Lossless boundary | Observations, citations, records and inventory share one page allowance. The cursor binds the scan, TaskRun, query, filters, finalization mode and selected content version. A changed query/version rejects instead of skipping data. |
| Record-kind filter cardinality | Derived protocol constraint | The maximum derives from the canonical enum, including `review_unit`; the old literal nine is removed. This does not limit record count. |
| Checkpoint open IDs | Removed | The remaining canonical 20-ID maximum was arbitrary for a durable continuation pointer. Both provider and canonical schemas now admit the complete pointer list. |
| Accumulated evidence and counterevidence references | Removed | A live valid request with 20 citations plus two existing links failed only after the ledger combined them. Provider and stored record schemas now retain all accumulated references; restart, write replay, targeted reload and final appendix preserve the complete graph. |
| Citation requests and acknowledgement batches: 20 citations per call | Temporary debt; separate request framing | The existing request batch remains, with explicit successive-update recovery. Its value is not established by provider/platform authority. It no longer limits accumulated record links; replay returns only the exact invocation's minted batch. D563 owns deriving or removing this retained request magnitude; D580 removes the aggregate ceiling and proves complete continuation. |
| Authored note fields: former 2,000 characters and newline rejection | Removed as arbitrary | GLM7's 2,475-character substantive note was rejected and its correction hidden from the model. No provider or storage authority justified forcing knowledge into separate records. Shared provider/durable schemas now preserve full multiline text through append, update, restart, exact retrieval and export; focused tests cross 9 KB. |
| Scanner explanations: former 1,000-character slice and 2,000-character schema maximum | Removed as arbitrary | Trivy titles and Semgrep explanations were silently shortened before persistence. Raw JSON lived only in scratch storage and was deleted after the probe suite, so the remainder had no recovery path. Full normalized scanner prose now survives observation admission, restart, result pages and final export. Gitleaks still discards matched secret values and reports only redacted attribution. |
| Repository-map mutations: former 32 sections | Removed as arbitrary | A complete plan may contain more than 32 behaviors or sections. The 40-section ledger regression preserves all entries through restart and retrieval and proves an unfinished section outside the status preview still prevents finalization. Only the compact status preview retains 32 entries, with total and omitted counts. |
| Status: bounded coverage, hypothesis and prose projections | UI projection | Full collections determine completion. `researchProgress` exposes totals and omitted counts; targeted reads or full result pages recover complete records. |
| Security Task cards versus generic depth/preview bounds | Validated display projection | Full canonical receipts are validated before generic preview projection. Accepted note fields remain complete; accumulated references and result indexes become exact counts with explicit saved-research/report recovery. A 6,000-reference regression crosses the unchanged generic preview boundary without losing the note. Display data cannot become report readiness or tool authority. Generic limits remain debt for other result types. |
| Oversized final-page recovery: one record per suggested query | Soft default | This is a model recovery hint, not a tool maximum. Retrieve an entire selected record with `recordIds`, or page conclusion kinds using the query-bound cursor. The original final pages and full report appendix remain canonical. |

The remaining `SECURITY_SCAN_MAX_TEXT_CHARS = 2_000` applies only to
diagnostic `error.continuation` and inventory `reason`; it no longer applies to
research notes or scanner explanations. Inventory reasons are closed generated
phrases and recognized format names, with no omitted source prose. The diagnostic
maximum has no established provider/storage authority or field continuation and
remains named D563 debt. The same applies to remaining 240-character error/cancel
framing, 512-character trusted tool-call identity framing and optional
500-character citation search hints. Their schema rejection is explicit, but
that does not make them lossless or justify their magnitude. Optional search
hints can be omitted while citing an exact inspected source range; full note
content never needs to be split to fit these fields.

Previously shortened scanner explanations cannot be reconstructed from deleted
scratch reports. The scanner fix preserves newly admitted results; it does not
retroactively recover omitted prose in an existing ledger.

Discovery cursors fingerprint the ordered output, not an atomic snapshot of
all source bytes. A grep preview is a lead. Actual source conclusions still
require separately inspected, hash-bound file citations. Ripgrep ignore rules,
binary handling, authority denials, symlinks and caller-selected depth remain
explicit scope exclusions. A cancelled, timed-out or externally stopped engine
attempt cannot claim a complete discovery page.

Ledger mutation retries use durable operation receipts and revision checks.
Paged retrieval can change the page size without changing the underlying
query. Targeted note reads cannot qualify as a complete final report. Final
report retrieval includes every unfiltered record and inventory entry. A sealed
`exportSnapshot` lets the runtime consume read-only `category: all` pages,
checking stable snapshot identity, cursor progress, distinct item count and
the complete content digest. Legacy receipts retain the model-paged
`finalize: true` chain until its final receipt is report-ready.

## Context and report reconstruction

The restricted research Task does not head/tail-truncate source/tool JSON.
A paired accepted checkpoint permits projecting earlier completed cycles out
of the model input. The original brief, checkpoint and complete current tool
cycles remain. `preModelNode` retains the original canonical `messages` array;
only `preparedMessages` receives that projection. This distinction is required
because the graph message reducer replaces its input.

Recovery uses the checkpoint and selected needed record IDs rather than loading
every historical note into each model context. An unrelated or empty final
page cannot satisfy the reload: all checkpoint open IDs must actually appear
in accepted result receipts. The model must persist useful
notes before checkpointing. If uncheckpointed input would exhaust the complete
prepared request, explicit context recovery now pauses new investigation and
lets the same model consolidate it through ordinary protected tool turns.
Canonical notes and exact historical inputs remain retrievable; a provider
context rejection also enters this recovery path on the same actual model.

After finalization, immutable result-page payloads may leave the provider
context. Complete conclusions remain when they fit; otherwise an explicit
projection carries a recoverable conclusion index, total and omitted count.
Its size derives from the configured model budget, not a finding quota. Even
an oversized latest page may be projected while preserving its exact status,
continuation cursor, report-ready flag and canonical item counts. Tool pairing
remains valid; mixed tool batches are not projected by this rule.

Legacy original pages remain in canonical messages. New deterministic exports
read the immutable ledger directly under the same TaskRun/Desktop authority;
export pages never inflate model history. Both paths preserve notes, citation indexes, scanner observations,
inventory and the exact final status, including every scanner lane's coverage
and error, even when the model produces only an explicitly labelled overview.
Report delivery rejects a missing, null or empty appendix instead of treating
the narrative as complete evidence. Dynamic Markdown fences are computed by
iteration across every backtick run, avoiding host argument-count overflow
without adding a content ceiling. Token estimates remain approximate; this
projection does not promise that every possible retained brief or single
record fits every provider window.

Focused roles retain one canonical transcript and one TaskRun. A validated
standalone handoff projects the outgoing workspace only after a current
substantive checkpoint; new unseen source and failed handoff drafts cannot
silently disappear. Working system metadata carries only the assignment,
handoff and coordinator-plan entry points, not all historical seed references.
Additional notes and references remain exactly retrievable. Complete report
drafts have no new character ceiling: ordinary protected handoff input preserves
them, and an exact TaskRun-bound historical reference survives the review return.
Context pressure still uses the actual provider allowance and exact recovery.
Fresh source-read receipts and revision closure are structural review
prerequisites, not deterministic judgments about correctness or sufficient depth.

Finalization revalidates the complete file digest for every source referenced
by a current conclusion, including linked evidence and counterevidence and
explicitly inspected dependencies outside the inventory. Citation ranges are
grouped by path so one full-file digest serves all ranges, without sampling
files or limiting the number of citations. Changed or unavailable source
rejects with the exact record/citation needing repair; historical notes remain
recoverable in the same scan. Updated checkpoints retain durable acceptance
order, so equal timestamps cannot make an older pending checkpoint override a
newly accepted update. Neither check introduces a time or work quota.

## Manual review outside primary scanner coverage

The inventory format classifier reads a 12-byte prefix for candidate media and
document extensions. Twelve bytes cover the three 32-bit fields of the
[WebP RIFF header](https://developers.google.com/speed/webp/docs/riff_container#webp_file_header),
including its `WEBP` marker at offset eight. The other recognized signatures
fit inside that prefix. Extensions alone never establish an exclusion; an
unknown signature remains inventoried as possible source.

This prefix classifies a disclosed non-source asset exclusion. It does not
validate the full format, prove that the asset is benign, inspect embedded
content, or count as reading a source file. Source review and file reads have
separate continuation and evidence contracts. File-descriptor identity and
current filesystem authority are checked before the classification read.

Inventory progress reports observed file and directory counts while traversal
is incomplete, without inventing a total or percentage. Progress persistence
coalesces the latest pending snapshot per exact TaskRun while a write is in
flight, then drains it on shutdown. It preserves current state rather than
creating a database write for every intermediate counter. Canonical research
records and transcript events are not deleted by this coalescing. The existing
DB update still requires the matching owner and currently running TaskRun.

The live relay path bypasses native LangChain tool events. Task progress now
observes the actual tools-node chain: its first approved call and newly
appended matching ToolMessage. Replayed, unrelated and error receipts cannot
invent accepted work. Foreground tool telemetry remains suppressed for these
background Tasks; the correction does not widen their audience or retain
source text in durable preparation.

Inventory paging begins without a continuation flag, then reuses the exact
query only while its cursor is non-null. Restarting an unfiltered final export
invalidates the earlier readiness proof until that new chain is exhausted.
Targeted synthesis reads can still preserve an already completed export.

Accepted acknowledgements and status now expose `nextResearchWork`, reusing
the existing complete research and scanner-triage checks instead of reducing
their exact diagnostic to a boolean. It includes section mismatches even when
all units count complete, exact hypothesis reference repairs and undisposed
scanner members. New producers return the full string or null; older receipts
may omit the field. No text cap or new traversal is added. Null does not prove
current source hashes, complete discovery, report export or semantic quality.

When the existing repeated-failure guard stops work, its final protected
ToolMessage now returns through the normal tools-node checkpoint and transcript
path before the next pre-model node raises the same typed stop. That check runs
before configuration or provider preparation. A checkpoint resume preserves
the stop without re-executing the failed tool; a genuinely fresh foreground,
fork or Task request resets its failure episode. The new state field carries
only the existing normalized key, not an additional raw receipt. The original
receipt remains in its authorized canonical transcript/checkpoint, rather than
being lost at the throw or copied into generic errors and logs.

Repeated-failure thresholds and the existing streak retention boundary are
unchanged. Validated structured failures exclude volatile runtime snapshots
from their identity. Preserving the last receipt is not authority
for those pre-existing values: the three-round corrective threshold, 240-character
normalized key and 64-entry streak retention remain recorded legacy debt.
No new retry, delay, timer, scheduler or provider attempt is introduced.

## Received reasoning and the legacy idle watchdog

The OpenRouter completions adapter now retains the provider's `reasoning` and
`reasoning_details` delta fields in nonvisible LangChain chunk metadata. The
installed converter already preserved `reasoning_content` but dropped those
other fields. These shapes are documented in the
[OpenRouter reasoning protocol](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
They are received model activity, not a visible answer or proof of useful
source analysis. The progress classifier accepts nonempty text, summary or
encrypted reasoning data, rejects empty metadata and the redacted placeholder,
and only resets the supervisor for the exact active attempt. Private reasoning
does not become Task progress copy or visible token output.

This corrects false idle termination while reasoning is arriving; it does not
extend or justify the existing 60,000/180,000 ms values. The first-progress and
idle boundaries remain explicitly reviewed **temporary debt** under D563,
with no provider SLA, catalogue authority or measured-policy claim. A silent
provider can still hit that legacy boundary. An optional caller absolute
deadline is unchanged. Attempt termination aborts the provider and preserves
typed first-progress/idle/absolute, elapsed, partial/visible and fallback facts;
the new diagnostic fields contain no reasoning payload. Parent cancellation
and stale-attempt rejection remain intact. A terminated provider stream itself
cannot resume; fresh fallback/retry and durable ledger recovery are separate.

The deterministic scout supports named numeric boundaries, reduction and
paging sinks, schemas, comparisons and timers in its listed source languages.
It does not prove semantic authority, resolve every package export, inspect
runtime-only values, or understand arbitrary generated/binary syntax. In this
run it did not emit a primary packet for the format-prefix allocation,
checkpoint projection, or exact-run progress coalescer; these paths were read
manually instead of being treated as absent.

## Evidence and remaining debt

Behavioral evidence is in:

- `apps/desktop/tests/unit/security-scan-ledger.test.ts`: durable replay,
  exact-note reads, inventory pages and query/version-bound cursors.
- `apps/desktop/tests/unit/security-review-work.test.ts`: source-version
  obligations, full progress totals, exclusions and exact scanner dispositions.
- `packages/relay/tests/unit/native-search.test.ts`: complete discovery-page
  reconstruction and changed-output detection beyond the short grep preview.
- `packages/agent/tests/unit/history-manager.test.ts` and
  `pre-model-prompt-cache.test.ts`: complete tool pairs, accepted checkpoints,
  provider-only projection and retained canonical report pages.
- `packages/agent/tests/unit/security-research-appendix.test.ts`: notes retained
  independently of the final model narrative.
- `packages/runtime/tests/unit/task-preparation-writer.test.ts`: latest-state
  coalescing, exact-run separation, write failures and shutdown drain.
- `packages/runtime/tests/unit-isolated/resume-task-research-progress.test.ts`:
  actual approval-resume processor, accepted notes and exact-run progress.
- `packages/runtime/tests/unit/security-report-artifact.test.ts`: complete
  appendix delivery and rejection of missing canonical export.
- `packages/agent/tests/unit/openrouter-reasoning-progress.test.ts`: real
  converted provider shapes and virtual time beyond the original 180-second
  first-progress deadline, followed by actual idle timeout and cancellation.
- `packages/agent/tests/unit/provider-errors.test.ts`: safe typed timeout
  diagnosis without arbitrary provider payloads.
- `packages/agent/tests/unit/tools-node-no-progress-batch.test.ts`: the actual
  graph checkpoints the protected terminal tool receipt, then stops before a
  provider call; resuming the checkpoint does not re-execute the tool.
- `packages/agent/tests/unit-isolated/subagent-task-progress-stream.test.ts`
  and `subagent-stream-input-guard.test.ts`: terminal receipt persistence and
  fresh-request versus checkpoint-resume episode boundaries.

Frozen debt is not declared safe by this review. Current counts and mechanical
priorities are recorded in the generated limit matrix; reviewed temporary debt
is distinct from the frozen unreviewed baseline. Unchanged debt in the touched subsystems includes generic non-research context
clamping, short generic progress arguments, grep previews, diff previews,
media/shell output framing and history lookup boundaries. Their detector
priority is an investigation cue, not a semantic verdict.

The live small-codebase acceptance must separately demonstrate substantive
source-to-sink analysis, useful retained notes, accurate exclusions, successful
continuation and a complete delivered report. Neither a green limit check nor
a larger finding count substitutes for that evidence.


## Recoverable research context rollover

The final prepared-message allowance derives from the selected model context
window, the existing operator history fraction, and the complete serialized
tool definitions. The provider invocation applies its own actual-model check,
including after a fallback for an unrelated failure. A context rejection
itself retries the same model with strictly fewer estimated input tokens; it
does not silently change the user's model or privacy route. Cancellation wins
before and after recovery. An attempt-local stream observer prevents context
retry after visible output in background Tasks as well as foreground Rooms;
hidden reasoning and tool-argument deltas are not visible output. An irreducible instruction/tool envelope still
returns an explicit provider-capacity error rather than an unchanged retry.

The existing 4,096-token completion safety reserve is separate operational
headroom, not a provider-mandated ceiling or a qualification claim. Its
magnitude remains pre-existing model-budget policy debt. The catalog output
maximum is authoritative; counting the complete tool schema now prevents that
maximum from consuming input capacity already occupied by bound definitions.

The final-budget planner reapplies accepted-checkpoint windowing after the
complete system/tool envelope is known, including an actual smaller provider
allowance. Raw-history estimates alone cannot decide when to evict completed
cycles. The new page allocator gives half the CURRENT free message workspace
to the next historical receipt and keeps the other half for its assistant
call and model-written notes. This soft allocation is tested with a roughly
12,000-token immutable prefix and a 20,388-token message allowance, rather than
only a tiny system-message fixture. It is not a cap on canonical content.
Parallel context reads share the one page allowance. UTF-8 page boundaries
and whole serialized, escaped receipt framing are measured before delivery.
File-result pages also retain a verified source header from their paired canonical
request: path, zone, command, relevant request ranges and an exact full-call
reference. The result reference binds that originating call as well as result
bytes. The header is included in whole-receipt budgeting; unavailable or
unpresented identity fields are explicit and do not become guessed citations.
No hidden provider reasoning or private sidecar is included. Display projection
retains source identity while removing opaque internal references.
Every remaining byte has a content-bound continuation. A page too small even
for framing rejects explicitly; it cannot return a misleading empty success.

The recovery prompt presents the exact pending count and a deterministic
`continueContext:true` request. The runtime resolves and records the actual
reference, byte cursor and filters; replay checks that resolved selection
against the same immutable historical input. Explicit selection remains
available. Historical-message and saved-record indexes are optional navigation,
never mandatory source debt, byte-progress credit or semantic consolidation
requirements. The substantive queue persists without a count ceiling.

A page acknowledged only in tool receipts is not a semantic summary. New
investigation stays blocked until required substantive inputs have been read
and a later model turn has saved the handoff. Consolidation is required when
actual prepared workspace cannot admit another page or the recovery batch is
complete, rather than after every page. All presented unconsolidated substantive
pages remain visible across correction turns; blocked requests cannot evict
content still needing consolidation. A checkpoint batched with a read cannot
cover bytes its author had not seen. During
finalized report synthesis, the accepted ledger is already immutable: recovery
is read-only and does not require an impossible new checkpoint. Historical
navigation preserves an existing complete export proof but cannot create one.
Validated local context-control errors remain exact optional history rather
than new mandatory source input. The newest actionable error and its complete
tool batch remain visible, even if an earlier history window omitted them.
Unknown errors, source failures and visible unsaved reasoning retain their
normal recovery obligations. An irreducible protected batch produces an
explicit capacity outcome rather than hiding the correction. Checkpoint-phase
guidance selects record submission instead of another context read; the model
still authors the substantive notes and checkpoint.
Paired, schema-valid accepted record acknowledgements bound to the current
Task/Run are persisted ledger echoes, not new source input. Their provider
projection retains record identity/revision/kind and newly minted citation
metadata without modification when it fits. If metadata itself cannot fit, an
explicit metadata-not-presented marker preserves exact retrieval rather than
claiming presentation. The saved record can be reloaded by ID, while
its exact historical receipt remains separately addressable. Source results,
rejected/unpaired writes and unsaved reasoning do not receive this exemption.
Recovery feedback carries the cumulative unique verified historical byte count,
including unsaved reasoning and non-source tool payloads. These are historical
input bytes, not code coverage. The existing repeated-failure guard distinguishes intervening real recovery
from the same blocked request with no byte advancement. Status polling, duplicate
reads and checkpoint writes alone do not manufacture byte progress. No failure
limit is raised or bypassed. Schema-valid error code/message fields determine
failure identity; changing runtime counters and timestamps cannot reset an
unchanged-error streak. Context reads have their own operation identity, so
a successful status lookup does not erase a failed read streak.
If a newly reduced provider allowance cannot show that page, the planner
rewinds to its ORIGINAL source range and excludes the unpresented receipt from
byte acknowledgement. Invalid historical handles cannot enter the pending
queue, and a reset reuses its frozen index rather than creating index debt.

Provider normalization uses runtime-bound transient origins for legacy messages
without IDs, including sanitized tool-call IDs and flattened text blocks. It
cannot turn a reset into an index-only substitute for unsaved reasoning. The
original canonical transcript is never mutated or replaced by this mapping.
Stable ToolMessage IDs are assigned through the message library's ID setter,
which also persists them in serialized constructor fields. The production
checkpoint serializer must preserve the exact frozen source/index references
on reload; an in-memory ID assertion alone does not establish restart safety.
Protected dispatch returns only safe recovery metadata, keeping decrypted
prompts transient. Fresh Tasks/foreground inputs clear it; checkpoint resumes
preserve it. Card projection preserves historical visible text and exact byte
metadata with read-only CodeMirror, while progress omits source text and handles.

Manual review covered dynamic allocation, transient origin binding, the frozen
index, byte cursor validation, parallel allocation and semantic checkpoint
ordering even where the deterministic scout emitted no primary packet. These
checks prove recovery mechanics, not analysis quality or sustained memory and
latency at millions of source lines. Live forced-rollover qualification is
recorded separately with exact model, source manifest and report evidence.

## Saved research continuity

The saved-record locator is a lossless, derived index of accepted canonical
receipts in the authorized TaskRun; it introduces no additional store or record
quota. Its frozen reference binds the owner, Task, Run and complete index bytes.
Optional record-kind and exact source-path filters bind the continuation, and
the returned digest covers the exact filtered serialization. Appending later
notes cannot invalidate an older frozen continuation. Complete UTF-8 pages
preserve titles and pointers to both the exact historical receipt and the latest
ledger record; index metadata cannot claim source inspection or report readiness.

Duplicate classification compares validated original objects, without using
schema trimming or defaults to erase differences. Research echoes must match
earlier accepted records and citation metadata. Inventory echoes must match the
same scan, target and inventory fingerprints and complete page entries. First
copies and changed or unknown inputs remain mandatory. Saved status prose can
be replaced by exact pointers only when matched to earlier accepted notes;
current coverage states, scanner lanes, errors and continuation remain intact.
Unknown prose is never promoted into the protected system prompt.

Compact status controls receive at most one quarter of the current free message
workspace. This is a soft projection allocation, not a canonical content limit:
omitted details carry an explicit marker and exact retrieval reference. Newer
accepted record progress is distinguished from the last observed scan status.
Saved-index reads and verified saved-state echoes do not advance source-recovery
byte counters or reset the existing repeated-failure policy. Substantive input still
requires a later model-authored handoff before eviction; optional navigation
does not add that debt.

Manual review covered the dynamic status allocation, canonical duplicate
classification, filtered cursor binding and progress exclusions. The focused
`security-context-saved-continuity.test.ts` suite reconstructs filtered UTF-8
pages and their digest, retains changed inputs, checks owner/version isolation,
and proves discovery after an empty checkpoint. These tests establish storage
and retrieval mechanics; meaningful reuse of notes requires live qualification.


## Runtime facts and model judgment

Recovery receipts expose server-derived phase, pending-input count, recovered
historical-input bytes and retained unconsolidated pages with their canonical
message snapshot boundary. These facts are separate from model-authored saved
notes and do not prove semantic quality or complete inspection. Historical
file descriptors carry the original operation outcome from canonical tool
status, with legacy unknown outcomes explicit. Failed attempted paths remain
discoverable without being promoted to successful reads. Display projections
retain useful source identity and code while removing runtime handles.

The LLM must interpret source, test causal hypotheses against counterevidence,
correct contradicted notes and decide the next investigation. The runtime owns
exact selection, continuation, input budgets, accepted-write identity and
execution state. No deterministic check certifies that the analysis is good;
blind live qualification and independent report review remain necessary.


## Parent task.read retrieval

Live failure replay showed a 925,963-character valid Task receipt shortened by
170,991 middle characters, removing every reference to an accepted finding. A
later pass reclamped that damaged JSON and replaced the omission notice with
161 characters. A separate 500-entry database cap omitted the last eight
authored events. These were semantic loss, not legitimate completeness bounds.

The 500-entry source ceiling is removed. The shared transcript reader uses SQL
batches across a frozen end-row boundary; the existing API deliberately fetches
all authorized visible rows. Model-facing sections are byte-paged with complete
escaped envelope sizing and content/scope-bound continuation. Database batching
and page framing are lossless boundaries, not quotas on audit duration or source
size. Source changes inside a frozen selection reject; later appends remain
outside its boundary. Literal search is optional navigation with explicit
matching/total entry counts and query-bound continuation.

Response allowance derives from the actual selected model's context, bound tool
definitions and prepared messages. Half of the remaining workspace is reserved
for the following model turn; the existing per-message projection policy also
bounds a single response. These are recoverable framing allocations rather than
source limits. The budget is recomputed for the actual responder after fallback
and shared across parallel reads. A header that cannot fit produces an explicit
capacity error, never an empty success or shortened JSON.

A legacy oversized Task receipt receives a valid retrieval projection. Retained
canonical receipts remain unchanged, and omitted page fingerprints prevent
continuation from treating invisible bytes as presented. Full source remains
retrievable through its original selection, including an offset-zero cursor that
freezes the first page. Reaching a null cursor terminates that selection; it does
not restart an earlier partial page. Exact byte completion does not establish
that the parent understood the evidence.

Each section page currently materializes its frozen selection to verify the
source hash. This measured-path architecture can cost O(pages × transcript size);
removing the source ceiling is not a claim of constant-memory or large-audit
latency qualification. No new transcript store or semantic summarizer is added.
