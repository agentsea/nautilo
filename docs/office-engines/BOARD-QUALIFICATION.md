# Board engine qualification — 2026-09-13

Status: owned engine qualified for native surface implementation. The Board
mini-app, canonical persistence, Genie actions and packaged release remain open.
The interactive `board-interface.html` is still a design study.

## Source and ownership

`@nautilo/office-board` is a private workspace package derived from Wafflebase
0.6.9 at `acde58012910ec68645c65b6896d5408fad1645c`. All 22 original package
files are recorded before modification in [snapshot.json](snapshot.json).
Apache-2.0 LICENSE and origin/modification NOTICE are retained. No upstream
NOTICE file was present. The package includes complete parse5 8.0.1 MIT and
entities 8.0.0 BSD-2-Clause notices for its bundled HTML parser.

The complete Git trees at that revision and
`13b487d9b5fbb913d9b387c82d912322021cbce4` were compared: both have 22 Board
files; all 21 non-manifest blobs are identical. The only change is the manifest
version from 0.6.9 to 0.6.10. See [the exact blob comparison](board-upstream-comparison.json).
There is no newer Board engine fix to port from that reference. This does not
claim parity with future upstream revisions or all shared engine changes.

Core has one source tree. Board directly depends on the existing owned Docs and
Slides packages; Core is reached transitively. No registry Wafflebase package,
upstream frontend/backend, Yorkie service, public publishing, or second storage
system is introduced. The sole shared-engine source change adds existing pure
viewport, connection-site and theme functions/types to Slides' Node exports.
No shared renderer, store, document model or Writer behavior was rewritten.

Nautilo adaptations: owned package identity/imports; explicit emitted root,
`/node` and `/browser` exports; no source aliases in tests; portable HTML parser;
removal of implicit 10%–800% zoom clamps; finite/invertible transform checks;
duplicate Miro item IDs rejected before mapping/image resolution; safe skip
counters for external names such as `__proto__`; typed inherited test assertions.

## Dependency and consumer contract

Build order is **Core → Docs → Slides → Board**. Run from the repository root:

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@nautilo/office-board...
bunx turbo run lint typecheck test:unit --filter=@nautilo/office-board
bunx knip --workspace packages/office-board
bun run limits:check
```

Turbo's Board lint/types/unit tasks depend on its emitted build; the build follows
workspace dependency edges. Vite keeps owned engines external instead of
embedding another copy. parse5/entities are bundled in Board's ES/CJS output.
Root, `/node` and `/browser` intentionally expose the same pure API, with ES and
CommonJS conditions plus declarations. Browser applications separately import
`@nautilo/office-slides/browser` for the actual canvas editor.

The mapper now parses HTML under Node without installing global `DOMParser` or
pulling in jsdom. It still generates fresh element handles and calls the supplied
image URL resolver: it is not an idempotent persisted import operation. A host
must validate input, stage assets, preserve a planned result across retries, and
commit it once through canonical authority. It must never persist `__id` as an
unresolved connector target. The native store's `batch()` is required for all
mutations; its ordinary undo/redo and JSON roundtrip remain compatible.

`boardToSlidesDocument` is a projection, not a second document: it uses one
synthetic slide, `board`, and references the supplied element array. Treat it as
read-only outside the store. Do not mutate its shared built-in theme/master/layout
objects or serialize the projection as a separate authoritative Slides deck.

## Frontend composition map

[The frontend dependency inventory](board-frontend-dependencies.json) starts with
15 Board production files plus the Miro import runner and content applier. It
traverses 168 local files, records original SHA-256 values and external edges,
and resolves all static literal imports. Fourteen Board test files are listed
separately. This is a reference inventory, not 168 files approved for import.
Computed imports and remote services are outside that mechanical closure; their
ownership is addressed below. Paths in this table are relative to upstream
`packages/frontend/src/`, unless a Nautilo path is given.

| Upstream surface and dependencies | Nautilo integration decision / regression gate |
|---|---|
| `app/board/board-view.tsx` mounts Slides `initializeEditor`, viewport/culling, overlay, read-only, snap and host context-menu hooks | Compose a Board-specific surface in the existing first-party mini-app architecture. Keep one mounted editor/store, update its viewport and contextual controls; do not remount the Apps panel on each edit. Existing `packages/first-party-apps/presentation/src/slides-surface.ts` shows the owned editor and image input lifecycle. |
| `board-wheel`, `board-touch-gestures`, `is-editable-target` | Selectively adapt gesture/focus helpers and their tests. Text entry must not trigger canvas shortcuts. Wheel/pinch/space-pan must share the applied viewport; release pointer capture and listeners on disposal. |
| `board-zoom`, `fit-to-content`, `minimap-geometry`, `board-minimap` | Adapt fit, minimap and navigation as session view state. Remove the upstream 0.1 floor that prevents fitting large scenes and duplicated 0.1–8 UI clamps; fit must show the whole scene and remain repeatable after panning. Empty or unsized hosts must not reset an established view. |
| `board-grid` | Adapt visible grid/snap geometry and preference ownership. Grid density is display projection; snapping is an explicit Human choice. Keep both coordinated with current zoom, never round stored coordinates merely to draw the grid. |
| `sticky` | Adapt native round-rectangle/text creation in one store batch at the current viewport center. Preserve palette readability and editable text; no alternative sticky-only model. |
| `board-toolbar.tsx` → Slides `shape-picker`, `line-picker`, `line-picker-helpers`, `toolbar/state`, `global-controls`, `zoom-control`, `shape-controls`, `image-controls`, `text-element-controls`, `text-edit-section`, `arrange-menu`, `can-ungroup` | These are React/Radix/Tabler frontend composition, not part of the Board engine. Build Nautilo controls against owned editor/store APIs. Retain full native shape/text/image/connector capabilities; separate creation rail, font/style context and navigation. Do not import the upstream application shell just to get these controls. |
| Those controls → shared color/font/unit inputs, dropdowns/tooltips/popovers and theme hooks | Reuse Nautilo tokens and existing native controls; derive selection state without rebuilding host navigation. Verify Ivory/Tokyo, focus order, disabled reasons, selected/mixed values, actual font family and size, and narrow embedded widths. All transitive paths are retained in the inventory. |
| `board-image` → Slides `slides-image-input`, `insert-image` → spreadsheet upload/URL resolver and workspace image API | Adapt placement/clipboard/drop logic to Nautilo's asset bridge. Capture the intended world position; show pending/error state, keep original image bytes and reject stale completion into a replaced document. Do not retain upstream workspace upload URLs/auth. |
| `yorkie-board-store` → Yorkie root/types, shared Slides geometry and Docs numeric conversion | Use the owned native model/store and a Board adapter to existing canonical document/session contracts. Reference behavior for connector remapping, groups and batched undo. Do not copy Yorkie document authority, mutation callbacks or numeric banding as product policy. |
| `board-cursor-publish`, Board/Slides presence types, Sheets peer colors | Upstream multi-user presence is not the initial Nautilo persistence implementation. Do not pull Sheets or Yorkie into Board for cursor colors, or display fake collaborators. Concurrent Human/Genie safety uses Nautilo's existing edit/revision authority. |
| `board-detail.tsx` → router, React Query, `CollabDocumentProvider`, auth/workspace/document APIs, app sidebar/header, sharing, user presence, history and preview surfaces | Exclude upstream application ownership. Nautilo owns launch/open, authenticated Workspace/Current Folder access, listing, chat, revisions, history and Reader previews. No second app shell or backend. |
| `lib/thumbnail-capture` / preview and history consumers | Produce an inert real Board preview from the canonical native payload; no blank HTML Reader. Capture an actual editor screenshot for the expanded app listing in the packaging gate. |
| `app/documents/miro-import-runner`, progress/summary/dialog, upload queue, `api/miro`, `apply-imported-content` | Mapping is qualified here; authenticated fetch/import is a separate future flow. Replace upstream document creation/deletion/upload/auth with Nautilo authority. Use two-pass handle remapping, one atomic native commit, truthful imported/approximated/skipped results and retry/cancellation recovery. |

Canonical seams to reuse by contract, not by copying presentation-only behavior:
`packages/first-party-apps/presentation/src/slide-bridge.ts`, `slide-session.ts`,
`slide-document.ts`, `slide-recovery.ts`, `slide-model-validation.ts`,
`slide-authoring.ts`, `slide-json-patch.ts`, `slide-tools.ts`, and `agent-tools.ts`.
Board needs its own native document envelope/schema, creation association and
complete model tools. Workspace and authorized Current Folder operations remain
owned by the host; source SHA/revision, dirty-Human state and close/recovery
receipts remain mandatory. No new Genie creative whitelist is warranted.

## Miro fidelity and boundaries

The mapper covers text, sticky notes, shapes, images, frames, cards/app cards and
attached connectors. Existing regressions exercise real API numeric strings,
transparent fills, border styles, font size/color/alignment, parent-relative and
rotated geometry, cycles/orphans, arrowheads, per-kind connection sites, captions,
missing image URLs and escaped text. A new 10,001-item fixture proves the engine
does not inherit the excluded upstream service's 10,000-item cutoff.

This is best-effort mapping, not certified lossless Miro import. Unknown item
kinds and unresolved connectors are counted as skipped; unknown shape/arrowhead
kinds and parent/caption approximations have separate counters. Frames become
labelled regions rather than containers, cards lose application behavior,
caption labels are detached, and text dimensions are estimates. Rich HTML,
font families, links and source-only styling are not fully modeled or fully
reported by the inherited mapper. Before exposing live Miro import, add complete
fidelity reporting and payload/asset validation at its authority boundary.
Do not describe these counters as a complete fidelity report today.

The upstream service also caps rehosted images and aggregate bytes. It is not
included. Its cutoffs, auth, pagination and rehosting are not Nautilo policy.
The sole new deterministic limit observation is optional caller zoom policy;
its reviewed decision records no implicit default cap or canonical-content loss.
The scanner does not certify mapper input validity or every indirect engine
numeric boundary. Existing shared-engine debt is unchanged, not declared safe.

## Evidence and remaining work at this checkpoint

- Board: 128 tests in seven files, including all 121 inherited tests under Node
  against emitted owned dependencies; no source aliases or DOM globals.
- Public exports: root/node/browser × ES/CommonJS, real HTML mapping and viewport
  calls in Node; no global parser installed.
- Browser: Chrome 152.0.7977.83 loads emitted Board and Slides browser exports,
  mounts the real canvas at negative world coordinates, renders the expected
  opaque blue pixel `[51,102,255,255]`, maps `A & B`, and applies 20× zoom.
  Run `BOARD_TEST_BROWSER_CHANNEL=chrome bun run --cwd packages/office-board test:browser`
  with installed Chrome, or omit the variable with Playwright Chromium installed.
  The loopback fixture is fulfilled by Playwright; it touches no Nautilo account.
- Shared regression: Slides viewport, overlay, connection-sites and memory store,
  four files / 79 tests passed. No full repository CI or live app release claimed.
- Board lint, types, build, emitted tests and scoped Knip passed. Frozen-lockfile
  install passed. All four engine `dist` directories were removed in this isolated
  worktree and `turbo run build --force --filter=@nautilo/office-board...` rebuilt
  Core → Docs → Slides → Board (4 successful, 0 cached, 11.587 seconds).
  Export/browser checks were rerun against those outputs. This proves cold outputs
  using installed locked dependencies, not a fresh downloaded dependency cache.
- `limits:check` passed: 5,120 observations, 1,253 reviewed, 3,867 unchanged legacy.
  One new caller-policy decision is recorded; no legacy debt was admitted.

The next work at this checkpoint was the actual Nautilo Board surface, followed
by canonical Human/Genie save, reopen and recovery, then packaged default-enabled
Office lifecycle, icon and real screenshot qualification. Surface acceptance
must cover pan,
zoom/fit, minimap, sticky/text/fonts, every native shape and connector entry path,
images, grouping/arrange, undo, keyboard/focus, empty/large scenes, both palettes
and narrow widths without Apps-panel flicker. Packaging must preserve an explicit
Human disable choice. Writer is complete separately; no migration reopened.
