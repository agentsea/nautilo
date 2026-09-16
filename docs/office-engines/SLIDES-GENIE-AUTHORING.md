# Slides Genie authoring

## User journey review

**Verdict: SALVAGEABLE.** The existing inspect/approve/save spine preserves Human
work, but its seven editing commands cannot complete ordinary presentation design.

**Promised outcome:** a Human describes a presentation, sees an editable deck in
Nautilo, then refines content and design with their Genie. Meaningful value is the
visible, saved, reusable presentation, not an accepted tool call.

**Actual journey:** the app supplies eight tools covering creation, open/closed
inspection and editing, PowerPoint conversion, and saving browser-prepared PDF.
Recorded live acceptance proves narrow text/notes edits and refusal over an
unsaved Human draft. The human editor can create images, charts, tables, groups,
rich text and themes that the seven-command editing subset cannot author.

**Friction ledger:** an already signed-in Human can give one instruction and, when
required by their policy, approve the resulting edit. No extra account, copied
ID/hash, terminal or provider switch is needed. However unsupported design work
currently forces an unbounded number of manual editor actions; there is no honest
fixed click count for finishing an arbitrary deck. Rich text is a dead end for the
plain-text shortcut. The new private template library has no Genie tool entry.

**Delete or combine:** remove the narrow command set as the boundary of creative
capability; retain its useful shortcuts for compatibility. Combine a related set
of changes into one validated transaction and existing approval. Do not create a
separate permission question for each object, font, theme or slide.

**Recommended journey:** ask → Genie inspects the actual document, resources and
native model contract → Genie chooses content/design → deterministic tools apply
an atomic edit through existing authority → visible result, saved receipt and
refinement. Schemas and document IDs are machine-facing facts, not Human forms.

**Recovery:** stale inspection requires rereading and reconsidering the edit.
Validation failure reports the offending operation/path and writes nothing.
Uncertain writes require canonical inspection rather than blind replay. Existing
Human drafts remain protected. Resource failure aborts before document publication;
template-library writes report their separate durable result.

**Now versus later:** deliver full native data editing, resource discovery, exact
asset resolution and reuse of saved templates through the existing worker/bridge.
Prove a complete designed deck and a subsequent revision. Defer a scripting VM,
another document format, a new database, an autonomous job framework and linked
master product UI. None is needed to give a Genie broad authoring agency.

| Responsibility | Deterministic code | Genie judgment |
| --- | --- | --- |
| Observe | Model/schema, dimensions, counts, exact ranges, resources, completeness | What to inspect for this request |
| Plan | Available native fields and operations; truthful format constraints | Story, design, typography, imagery, sequence |
| Transform | Native edits, identity allocation, resource copying, image decoding, validation | Chosen changes and preservation intent |
| Publish | Approval, current authority, exact version, atomic save, receipts | Whether the result meets the brief |
| Recover | Typed failure, unchanged/unknown state, reinspection path | Reconsider stale edits and explain material choices |

**Limit and information-loss ledger:** native slide width is the engine's 1920
logical units; height and pixel/point scale come from the inspected deck. They are
format facts, not an assumed rendering resolution. Inspection page size is caller
policy with stable version-bound continuation and an explicit full-content path;
no universal model-context ceiling. Existing canonical document/worker transport
bounds remain separately disclosed platform boundaries, not presentation-format
limits. Images follow the existing self-contained decoded-image contract; no
unrestricted network fetch is introduced. Unknown fields are retained, never
silently removed by validation. All patch batches are atomic. Export warnings and
cross-font-scale chart-template refusal remain visible until their underlying
fidelity constraints are resolved. No new arbitrary count, retry or retention cap.

**Unresolved user decisions:** none required for this implementation. The user's
existing approval policy and file/Room permissions continue to govern execution.

## Architecture review

**Verdict: Ready with named engineering gates.** The model and save authority stay
canonical. Full model editing requires a stronger runtime schema than the current
partial container validator; it must derive known field types from native model
source and validate structural invariants without rewriting valid source data.

| State | Owner / writer | Recovery |
| --- | --- | --- |
| Native presentation bytes | Workspace Artifact or Current Folder host | Canonical version/hash and existing save/recovery |
| Active Human draft | Editor and existing bound recovery journal | Existing conflict/recovery workflow |
| Edit candidate | Isolated app worker | Disposable until one canonical write |
| Native schema | Generated from owned engine types | Rebuild and drift verification |
| Images | Authorized artifact/local-file source | Exact bytes/hash, explicit decoding failure |
| Private template | Existing Human-private Artifact service | Existing exact namespace and byte persistence |

The mini-app owns inspection, native semantics, model validation and tool handlers.
The server owns verified app provenance, user/namespace authority and resource I/O.
The worker receives data-only RPCs. General editing is not arbitrary code execution.
Live writes remain targetless and pass through the existing mutation coordinator.
Read-only resource access does not weaken document targeting or grant a new write.

Applicable regression cells: open/closed editor × Workspace/Current Folder × clean/
stale/dirty/denied/duplicate × native text/image/chart/table/group/connector/design
resources. Tests distinguish source checks, worker packaging, visible editor
adoption and actual Genie chat acceptance. A successful unit test does not prove
the other cells. No schema migration, service, deployment topology or Writer engine
change is intended. Main synchronization and release remain separate work.
