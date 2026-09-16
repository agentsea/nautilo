# Nautilo Office engine modifications

Baseline: Wafflebase 0.6.9, acde58012910ec68645c65b6896d5408fad1645c.
Modification dates: 2026-09-06 through 2026-09-13. Original-file hashes are in snapshot.json.

## Native Board surface — 2026-09-13

New Nautilo-authored UI in `packages/first-party-apps/board` composes the owned
model and editor without importing the upstream frontend. Notes/fonts, shapes,
attached connectors, resize/arrange, images, undo and navigation work on the
native canvas. Role colors use a derived view theme; explicit document colors
and source geometry are preserved across palette changes.

Changed `packages/office-slides/src/view/editor/editor.ts` to paint selection
chrome without disconnecting the mounted text input or peer layer. Re-attaching
the focused textarea previously lost focus and could restart type-to-edit at
the beginning of a note. A native-input regression and real Board typing test
cover this; Slides browser qualification and existing shared-editor tests pass.
Original provenance hashes remain the intake record, not rewritten source hashes.
See the [Board app](../../packages/first-party-apps/board/README.md) for the
current surface and test commands.

## Owned Board engine — 2026-09-13

Added the 22-file Board 0.6.9 package; upstream 0.6.10 reference has identical
non-manifest Board source. Preserve original hashes and Apache notices. Use
owned Docs/Slides emitted exports with their existing shared Core dependency;
no upstream backend/frontend is imported. Added pure Board-required Slides Node
exports, portable parse5 HTML mapping, explicit caller zoom bounds without
implicit cutoffs, duplicate-ID rejection and prototype-safe skip accounting.
Inherited tests now use native type assertions and run without DOM/source aliases.
Browser/Node/CommonJS consumer checks are described in [testing](TESTING.md).

## Live Genie and PowerPoint qualification — 2026-09-11

- Genie creation starts from a request: the canonical Slides template is created
  without overwriting an existing destination, closed-document tools populate it,
  and the result offers **Open in Slides** directly in the editor. The server
  reports saved bytes separately from client navigation. Current Folder actions
  recheck the captured folder through Desktop before opening a historical result.
- Canonical Workspace file creation now publishes bytes exclusively for both
  buffer and stream writers. Post-publication failures remain partial writes;
  tool-handler failures retain successful template-creation receipts.

Native adoption now preserves valid recent-color casing, order, duplicates and
empty arrays, and string stroke colors. Normalization remains an explicit color
write operation. Authoring refusal reports every incompatible field with native
JSON Pointers and proposed engine values, while leaving the source unchanged.
The app clarifies image-helper ownership of identities and resolved source bytes.

PowerPoint import inherits master placeholder geometry through layouts, including
partial layout overrides, and export retains slide placeholder identities. Import
reports unsupported table-style switches and referenced theme effects. Export
reports unsupported image backgrounds and radial-to-linear background conversion;
Nautilo includes these warnings before the existing conversion confirmation.
These reports do not claim complete master typography or theme-style fidelity.

The host image resolver retains exact source bytes, restores Sharp's native
pixel/channel guards, performs sequential full pixel validation, and inherits the
existing app-tool deadline. Duplicate base64 output is removed. Decoder limit,
corruption and deadline failures are distinct. No new creative-property limit,
image-size policy, service or Writer migration is introduced.

## Reusable slide templates — 2026-09-11

Slides can capture one slide with its design resources and import an independent
copy in one undo transaction. Imported elements, notes, animations, themes,
masters and layouts receive fresh identities; connector references follow their
copied targets. Cross-deck geometry and text scaling use the source and target
document units.

An optional slide theme preserves the template's colors and fonts without
changing other slides. Documents without this field keep their previous deck
theme behavior. Applying a presentation theme clears slide overrides. Canvas,
thumbnails, presenter, PDF font discovery and PPTX relationships honor the
selected slide theme; export-only master/layout copies support mixed themes
without rewriting the native deck. Nautilo supplies the private Artifact library
and Design gallery. This does not add linked-master editing or change Writer.

## Slides draft capture — 2026-09-11

Owned Docs exposes a detached text-box snapshot and event-driven draft changes,
including active browser IME/Hangul composition and formatting, without blur or
an undo/store mutation. Owned Slides overlays active text, shape/cell text,
fitted text-box height, crop geometry and focused notes into a detached document.
Pending image reads/decodes explicitly mark that snapshot incomplete.

The Nautilo adapter checkpoints these drafts through a Desktop-owned protected
local journal, separate from canonical document saves. It binds the authenticated
Human, server fingerprint, app and document; uses revisioned CAS/tombstones,
integrity checks and atomic writes; and rechecks authority around asynchronous
I/O. Workspace remains server-canonical and Current Folder drafts stay local.
Current recovery behavior and limitations are described in the
[Slides app](../../packages/first-party-apps/presentation/README.md#document-contract).

## Nautilo adapter qualification — 2026-09-11

The earlier adapter checkpoint made no engine edits. Nautilo's host wires Slides
Save Copy through the existing lifecycle and routes app-tool Workspace edits
through the canonical mutation coordinator, Human draft admission and immutable
commit receipts. The shared Apps listing has an original Slides icon and a real
editor screenshot. See [testing](TESTING.md) for repeatable checks.

## Engine safety follow-up — 2026-09-10

- Removed the temporary eight-table paste restriction after repairing recursive
  Docs layout, canvas/PDF painting, DOCX/plain-text export, font/image discovery,
  model/search/style updates, clipboard cloning, store snapshots and navigation.
  Deep clipboard copies have independent descendants and fresh IDs.
- Slides text boxes atomically refuse unsupported table paste through the host
  toast callback; callers without one receive an error. Native slide tables are
  still available through Insert > Table. Writer's external dependency is unchanged.
- Corrected frame/sibling-derived preset bounds and paint pins for basic shapes,
  selected arrows and ribbons. Raw imported adjustments are preserved. Callout
  tails use signed format coordinates with a separate Shift snap proximity range.
- Small-table resizing preserves no-move gestures and positive subpixel cells
  within adjacent boundaries, removing the invented ten-pixel minimum.
- All 143 previously unreviewed limit findings are assessed. The ledger passes
  with 4,997 observations: 959 reviewed and 4,038 unchanged frozen legacy.
  The 21 named shape/IME findings are resolved: twelve live observations now
  derive from verified guide authority, and nine obsolete observations are removed.
  No legacy admission was used.
- Directional arrow callouts now use the checked-in DrawingML frame/sibling guide
  chain for both paint and drag. Circular, curved and U-turn arrow handle domains
  are likewise derived from the preset geometry. Raw imported
  adjustments remain stored without paint-time normalization.
- The IME browser diagnostic takes its readiness duration from the caller and
  cleans up controlled browser children and its listener on every exit path.
  Thirteen policy tests cover controlled cleanup; real Playwright acceptance was
  not run in this pass.
- Charts now render native horizontal bars, signed stacked line/area series,
  sparse gaps, explicit value-axis bounds and category-axis crossing. Import,
  model validation and export reject equal, inverted or unrepresentable axes.
  Bar/column export explicitly disables negative inversion, repairing the tested
  LibreOffice sign fallback without changing values. Line/area stacks use signed
  running totals; percentage stacks divide by total magnitude, matching PowerPoint.
  LibreOffice differs for signed percentage line/area stacks, so export warns
  specifically for that combination. Ordinary signed charts no longer warn.
- PPTX theme font collections include the required East Asian and complex-script
  entries. Exported layout IDs follow all emitted master IDs without collisions.
  Both repairs are necessary for the tested PowerPoint package to open cleanly.

## Owned Docs / Writer intake — 2026-09-11

Docs is imported from reviewed Nautilo checkpoint
`182b804441a4130a394820df73a714b694152566`, package tree
`085c0df19858e8abeb6b63149e0d7c88d603ac7c`. It retains the complete source,
tests, spell dictionaries and their licenses. The existing Core tree is reused.
The reviewed slice includes recursive table, clipboard, IME/draft, layout,
style, image and export corrections developed during Office qualification.
These source capabilities require separate Writer UI and persistence acceptance.

Writer uses supported browser/Node exports instead of generated dependency paths.
The Node entry now also exports the data-only DocStore contract and SearchMatch
type. Relative internal file dependencies support both root workspaces and
standalone app installs; the runtime projection validates their exact targets.
The Writer store implements nested undo grouping, multi-range styling and ordered
block insertion, publishes surviving failed-batch drafts, and waits for an exact
remote baseline hash before deriving its next save. Canonical container parsing
preserves safe manifest extensions and refuses malformed existing input.
No upstream service, collaboration backend, npm publication or automatic Git
synchronization is introduced. The prior registry engine is removed from runtime
dependencies; persisted document identifiers remain unchanged.

## Core and Sheets intake

- Renamed packages and internal imports to private @nautilo/office-* workspaces;
  manifests, test aliases and build configuration follow Bun/Turbo.
- Core uses explicit .js relative imports so emitted ESM resolves in Node.
  Its CSS builder accepts replacement token values while retaining typed keys;
  the preview-worker test resolves the workspace tsx executable. The CSS build
  runs through Bun in the canonical Linux Docker stage.
- Sheets exposes explicit browser and headless Node entry points. Readable
  assert/util compatibility modules satisfy ANTLR in both entries; the shared
  headless entry is DOM-free and browser-safe. ANTLR is a production dependency. No compiled
  output is patched or rewritten.
- Active gold grid headers use dark text in both themes; the actual canvas
  paint path is covered by regression tests.
- Normal strict repository qualification applies to handwritten source.
  Type/promise lint adaptations are recorded in modified source. Generated
  ANTLR output is retained with its grammar and excluded only from source lint.

Application persistence, host permissions, menus, palette integration and Genie
contracts are Nautilo-owned adapters outside these engine packages. The upstream
backend, Yorkie service, authentication and storage are not part of this intake.

Additional owned-source corrections:

- Render completion now waits for the formula bar before notifying its host,
  allowing the host to restore unfinished input after a viewport resize.
  Formula-bar repaint is suspended during native IME composition.
- Internal-only function exports and unused helper declarations were removed after
  reference checks; public entry points and registered formula functions remain.
- Filter values now have Show more continuation; values beyond the first 200
  remain searchable, selectable and included in Apply.
- CSV and Parquet no longer inherit Yorkie's estimated byte or 40,000-cell
  admission caps. Callers may explicitly supply maxCells. CSV reports a terminal
  row-boundary partial import; Parquet rejects before creating a worksheet.
- XLSX column declarations retain widths, hidden state and default styles across
  the complete valid declaration, including columns beyond populated cells.
  Invalid spans fail explicitly; Excel's 16,384-column format extent is enforced.
- Large checkbox and border operations now return typed, pre-mutation refusals.
  The existing 50,000-cell cutoffs remain named temporary debt, not a justified
  product limit. The Sheets host displays checkbox refusals.


## Docs and Slides source slice — 2026-09-08

- Adopted the already inventoried Docs and Slides source from the same acde580
  snapshot, preserving 915 additional original-file hashes and dictionary license.
  No Writer, Notes or Board consumer cutover is included.
- Added private package manifests, browser/Node exports, normal build ordering,
  Docker dependency-stage manifests and scoped unused-code entry points. The
  imported source is subject to normal repository lint and type qualification.
- Slides PPTX export now retains connector attachment references after numeric
  shape-ID assignment. Rect and ellipse site indices, escaped IDs, forward
  references and nested group targets have raw semantic regression coverage.
  A missing exported target or site outside the target's actual connection-site
  set raises an explicit export error. Raw model IDs also preserve animation
  targets containing XML-special characters. Raw XML assertions cover both paths.
- Strict type/lint qualification replaces unsafe implicit fixture and JSON types,
  removes unused internal exports after public-entry/reference checks, and keeps
  the full built-in theme registry. Dictionary assets remain checked in; the unused
  dictionary-en development dependency is removed. Docs coverage follows the same
  Vitest version range as the other owned packages, avoiding a root downgrade.
- Docs export yielding closes both MessageChannel ports, cancels a pending frame
  when the existing fallback fires, and settles once. The serialized CRDT style
  registry now rejects non-object JSON; this is a shallow shape check, not complete
  document validation. Slides migration remains a compatibility transform and
  requires host validation of untrusted source and resulting documents.
- Package-level Node ESM/CJS loading and browser bundling tests cover emitted
  entry points, declarations, lazy dictionary assets and required licenses.

## Docs and Slides preservation corrections — 2026-09-08

- Clipboard JSON sanitization visits nested table content iteratively and keeps
  deeper list levels. Parser-only deep traversal is not end-to-end paste proof:
  rich paste now rejects unsupported recursive nesting before changing the document
  or selection. The inherited eight-table admission boundary remains named debt
  until the downstream recursive consumers are repaired.
- List indentation no longer stops at eight in the native model. Controls use
  exact integer arithmetic; ordered-list counters visit represented levels rather
  than allocating an array up to the numeric indentation level. PPTX export
  rejects levels outside its 0..8 format domain without changing the source deck.
- Slides recent colors retain every valid distinct persisted entry in recency
  order. Migration no longer discards entries after eight.
- PPTX chart caches and literals retain sparse original point indices and aligned
  category/series values. Canvas placement preserves gaps without allocating or
  visiting missing points. Invalid/duplicate indices take the reported placeholder
  path. The source archive is read-only; retaining original uploads remains a host
  responsibility. Unsupported chart PPTX export now fails instead of omitting charts.
- Shape fixes cover canonical arc endpoints, cube depth, left/right/up arrow
  shaft range, separate plus/minus/multiply ranges and coupled divide/equal guides.
  Angular drag helpers calculate wrap turns directly and preserve both 180-degree
  ties; there is no fixed iteration cutoff. This does not certify all preset shapes.
- Peer labels derive their display width from the actual canvas. IME diagnostic
  failure reaches browser/server cleanup before exiting.

Current app and conversion behavior is documented in the
[Slides app](../../packages/first-party-apps/presentation/README.md).

## Slides native authoring contract — 2026-09-11

- Export the built-in theme catalog through the DOM-free Node entry for app-owned
  tools. Give Slides table row/cell/style types distinct exported names while
  retaining the original aliases, avoiding collisions with Docs schema types.
  Native serialized data and Writer's dependency remain unchanged.
- Generate the full native document schema and a standalone validator from owned
  TypeScript types. The generator adapts placeholder intersections and the
  existing sparse notes style representation; validation never coerces, defaults
  or removes data. `check:model-schema` verifies generated files without mutation.
- App-owned JSON Pointer transactions expose preserved native fields, with
  deterministic identity/resource/geometry helpers and existing canonical save
  authority. [Authoring design](SLIDES-GENIE-AUTHORING.md) records the preflight
  and qualification boundary; this does not imply a product release.

### Writer integration follow-up

Internal Docs/Core and proposal/types edges use exact workspace-matching versions.
Standalone Writer binds all three to local `file:` overrides; its refreshed frozen
lock removes the old registry Docs tree. The runtime projection validates these
version pins and includes the owned workspaces. Root postinstall compiles Docs/Core
before app installation. Owned browser files are `browser.js` / `browser.cjs`;
the old generated-path shim and obsolete vendor exclusions are deleted.

Writer exposes native create-file through canonical create-only host storage.
The result retains a saved target and an openable path; it never reports an editor
opened merely because creation succeeded. Existing closed/open edit and review
authority remain unchanged.

### Writer and Slides integration — 2026-09-12

Writer 2.0.1 now shares the owned Docs package already used by Slides. The
combined source preserves the subsequent Slides qualification corrections,
including the bounded-cost large-paste indicator fixture. Docs uses the owned
`browser.js` / `browser.cjs` entry names for both consumers. Current Folder
creation retains the coordinated missing-preimage guard for native text and
binary exports, including binary hash receipts and retry classification.
