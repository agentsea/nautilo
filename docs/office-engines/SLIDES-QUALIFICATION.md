# Owned Slides qualification follow-up

The owned Docs+Slides dependency slice remains under qualification. The native
Slides app, contextual toolbar, Design gallery, Preview and presentation exit are
implemented. Source checks and retained-instance evidence do not complete release
qualification. Writer's existing external Docs dependency remains unchanged.

## Protected draft recovery source checkpoint — 2026-09-11

The source now captures focused text, IME composition, formatting, shape/cell
text, crop geometry and notes without forcing a commit or moving the caret.
An independent persistence lane checkpoints the latest recoverable scene while
canonical saves are stalled. Exact drafts restore automatically only when the
base matches; divergent or incomplete drafts stay visible in conflict. An exact
already-canonical draft is cleared without another document write. An unfinished
image operation remains disclosed even if the last snapshot equals the saved file.

Desktop owns encrypted recovery files inside the isolated profile. Authenticated
open binds server origin/fingerprint, Human, Slides and the exact document.
Revisioned compare-and-swap and retained tombstones prevent overlapping editors
from clearing or resurrecting another draft. Checksums validate draft content
and base fields. Reads and writes recheck live authority after asynchronous I/O;
Current Folder also rechecks native relay and allowed-root authority. Local
checkpoint writes do not contact the server or write beside user documents.

Boundaries remain explicit:

- New targetless decks gain a stable recovery identity only after their first
  canonical save. A crash before that first materialization is not protected.
- Existing authorized handles checkpoint through server outages. A full renderer
  or Desktop restart requires ordinary authentication and readable canonical
  content before restoring; cold offline app opening is not delivered here.
- Pending image bytes are not serializable until reading/decoding finishes.
  Recovery records disclose incomplete capture and cannot silently autosave it.
- Current Folder recovery identity follows the canonical path, not a rename.
- Browser-only recovery, recovery-file discovery, tombstone cleanup and other
  Office apps are outside this implementation. Unprotected OS storage fails closed.

The bounded live crash cases now pass on a rebuilt image:

- Workspace: a protected notes draft survived forcibly terminating Desktop and
  the paused test server. The canonical revision remained unchanged after restart;
  the restored draft subsequently saved as one new revision and cleared its journal.
- Current Folder: active text survived an actual editor renderer crash, with the
  file unchanged until recovery. The restored model changed only the intended text
  and its normal committed text-frame height.
- Current Folder: unfinished IME composition survived a Desktop process kill
  after an external file change. Reopening retained the draft in conflict and
  preserved the external file without overwriting it.

The full matrix remains open, including the boundaries above. Live acceptance
also exposed that the Slides conflict notice downloaded a copy while the host
lifecycle saved one in the document's zone. Both now use the host's Save Copy
contract and report its destination. Committing a focused editor for a copy cannot
trigger an autosave into the original. A lifecycle copy permits closing only after
the exact copied generation's journal is cleared through acknowledged CAS; delayed
checkpoints cannot resurrect that generation. A notice copy keeps the journal while
the editor remains open. Browser frames omit the native recovery API entirely.
Packaged requalification passes on source `f31a6647e99ae72919f085ae04d8e99b7310c497`
and image `sha256:ffe449083f3e245ee9cffc68faa18187112c1fe9933b8702e01c8d0343c81c1e`.
The notice and guarded-close actions each created a Current Folder copy with bytes
identical to the pre-crash IME draft. The notice retained recovery; guarded close
cleared it. Reopening the original showed Saved, kept the external canonical SHA
unchanged, and read a journal tombstone rather than restoring the copied draft.
The adopted Workbench bundle is `index-BaSO3c4i.js`. Evidence is retained under
`/private/tmp/stack416-crash-recovery-20260911/final-*`; the immutable package
verification is `/private/tmp/stack416-copy-final-image-verify.log`.

The tracked verifier at
`packaging/wafflebase/verify-slides-image.mjs` now reproduces the offline engine,
Writer, artwork and Workbench registry checks using an immutable image ID.

## Packaged recovery and listing checkpoint — 2026-09-11

Source `07766dbf1` adds the canonical Workspace coordinator to app-tool writes,
so acknowledged Human drafts refuse competing edits. Exact source bytes and
revision enter the existing shared lock/admission/history path. Successful writes
return the immutable receipt version; a rebased result requires a fresh read
before further edits in the same worker. Legacy direct save/patch helpers are
removed. Focused host/adapter tests pass 40/40. Root typecheck 79/79, lint 78/78,
unit tasks 74/74 and unused-code checks pass. Limit observations remain 4,997,
959 reviewed and 4,038 frozen legacy; only generated source locations changed.

The earlier package `sha256:e56e2fd93119a5b7b27e02b164cd7fde8367a9974d7003ed922dbcbb79bfa2da`
passes 449 engine hashes, emitted entry checks and exact Writer/artwork parity.
Actual Moxie was refused against an acknowledged dirty Human draft with canonical
revision 9 unchanged. After the Human save, a clean Genie notes edit saved and
reopened at revision 11 with the same hash and no other model changes.

The host Save Copy lifecycle now supports Slides in both document zones.
Authenticated server-outage/reconnect, Workspace lost acknowledgement, and exact
Save Copy/reopen cases pass. That image predates the protected journal above and
only retains drafts in memory. The later checkpoints above qualify the rebuilt
package and bounded renderer/Desktop crash cases; the complete both-zone
Human/Genie matrix remains a release gate.
Writer is unchanged.

The shared Office listing includes an original Slides icon and a real editor
screenshot of a fictional four-slide deck. Sidebar, overview and expanded details
use the same assets; both light and dark listing views were inspected. The native
Presentation document association is described correctly in expanded details.

## Engine safety checkpoint — 2026-09-10

Nested-table traversal is iterative across Docs layout, canvas/PDF painting,
DOCX/plain-text export, font/image discovery, clipboard cloning, model lookup and
search, store snapshots and cell navigation. The temporary eight-table paste
restriction is removed. Regressions exercise real deep editor paste/undo/redo,
clone independence and fresh IDs, document-order search, layout/paint, and export.
Different tests reach different depths; parser depth alone is not editing proof.

Slides text boxes cannot render table blocks. Paste is refused before any content
or selection mutation, with a message through the existing host toast callback:
use Insert > Table or plain-text paste. Library callers without the callback
receive an explicit error. Native slide table elements remain supported.

Preset fixes use the checked-in PowerPoint XML guide equations and imported raw
adjustment tests, including square, wide and tall frames. Paint-time pins preserve
stored adjustments. Signed callout coordinates and Shift snap proximity have
separate domains. Small table resizing uses actual adjacent boundaries and
preserves no-move gestures rather than imposing a ten-pixel minimum.

All 143 previously unreviewed limit observations have been assessed. The current
inventory has 4,997 observations: 959 reviewed, 4,038 frozen legacy, zero unreviewed.
No legacy admission was used. The following 21 named observations are resolved:

- Seven curved/circular/uturn arrow numeric domains derive from frame/sibling
  guides shared with the actual preset geometry consumer.
- Thirteen directional arrow-callout observations are replaced or derived from
  exact coupled guide pins, preserving imported out-of-domain adjustments.
- The IME browser diagnostic's hidden ten-second deadline is removed. The caller
  supplies the duration; validation enforces Node's actual timer representation.

Twelve former debt observations remain as reviewed derived geometry/UI rules;
nine obsolete observations are removed. Newly extracted helper bounds are reviewed
against the same authority. Static adjustment metadata used for Shift snapping or
tooltips is not a rendering-domain authority. Other repository debt remains outside
this bounded repair.

The IME readiness policy requires a caller-provided positive integer timeout
and guarantees cleanup of controlled browser children and the Vite listener.
Its 13 focused tests use controlled children/listeners; no real Playwright browser
acceptance was run, and no production timeout measurement is claimed.

## Conversion and remaining delivery gates

Editable chart PPTX export is implemented. Sparse represented chart points retain
indices without allocating missing coordinates. The renderer supports
native horizontal bars, signed stacked and percent-stacked line/area baselines,
explicit value-axis bounds and category-axis crossing, with bounded clipping and
finite-range validation. Equal, inverted and unrepresentable one-sided axes fail
explicitly rather than being rewritten.

The negative bar/column discrepancy is repaired by explicitly disabling series
inversion in PPTX. Fresh LibreOffice rendering preserves negative bars, including
sparse categories, without rewriting chart caches or embedded workbook values.
PowerPoint accepts those chart and workbook parts. Native line/area stacks now
use algebraic running totals, and percentage stacks retain signed shares over
total magnitude, matching the observed PowerPoint behavior.

One viewer difference remains: the tested LibreOfficeDev 26.8.0.0.alpha0 uses
absolute shares for negative percentage-stacked line/area charts. Export warns
only for that combination. This does not waive the broader fidelity gate.

PowerPoint qualification also exposed two package defects: missing required
East Asian/complex-script theme font entries and overlapping master/layout IDs.
The minimal corrected package opens without repair. Diagnostic isolation and
fixtures are under `/private/tmp/stack416-negative-chart-fix`; final-source
runtime/package adoption remains separate from this desktop viewer evidence.

Native list increments preserve exact safe integers. PPTX permits list levels
0..8; export refuses deeper native lists rather than flattening them. Malformed
chart imports report placeholders; native conversions must preserve originals.

1. Complete the broader representative PPTX/PDF fidelity matrix, including the
   disclosed signed percentage line/area viewer difference.
2. Complete editing/palette coverage and Human+Genie duplicate, concurrent and
   interrupted-draft recovery against the actual server in both document zones.
3. Complete the remaining packaged lifecycle qualification.
   September 11 package checks include 449 engine hashes and emitted browser/Node
   entries; bounded successful recovery cases do not close the full matrix.
4. Complete fresh install/upgrade/backup/rollback acceptance, final main sync and
   remote CI. Local checks do not establish merge, release or installed adoption.
