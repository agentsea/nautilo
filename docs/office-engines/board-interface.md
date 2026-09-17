# Nautilo Board interface study

This standalone prototype explores Board layout and interaction. For the
installed app and its tests, see the [Board README](../../packages/first-party-apps/board/README.md).

Open [the interactive mock](board-interface.html). Its edits stay in the current
tab; it has no canonical file, network service, autosave receipt, or connected Genie.
[Ivory](board-design/ivory.png) and [Tokyo](board-design/tokyo.png) show the layout.

## Upstream evidence

Upstream **does provide an implemented Board interface**, not just an engine.
The references below are pinned to upstream revision
`13b487d9b5fbb913d9b387c82d912322021cbce4`.

- [Board design](https://github.com/wafflebase/wafflebase/blob/13b487d9b5fbb913d9b387c82d912322021cbce4/docs/design/board/board.md)
- [Editing parity design](https://github.com/wafflebase/wafflebase/blob/13b487d9b5fbb913d9b387c82d912322021cbce4/docs/design/board/board-editing-parity.md)
- [Board user guide](https://github.com/wafflebase/wafflebase/blob/13b487d9b5fbb913d9b387c82d912322021cbce4/packages/documentation/board/using-the-board.md)
- [Contextual toolbar](https://github.com/wafflebase/wafflebase/blob/13b487d9b5fbb913d9b387c82d912322021cbce4/packages/frontend/src/app/board/board-toolbar.tsx)
- [Editor composition](https://github.com/wafflebase/wafflebase/blob/13b487d9b5fbb913d9b387c82d912322021cbce4/packages/frontend/src/app/board/board-view.tsx)

Their pure Board package owns model, viewport and Miro mapping. The full frontend
adds editor mounting, sticky/image behavior, grid, minimap, fit, toolbar state,
and a Yorkie store. Those frontend pieces are separate from the engine package.
The guide and implementation must be compared: older design sections still call
some now-implemented toolbar functions future work.

## Experience decision

The upstream editor is a useful reference;
Nautilo needs a coherent native journey and a layout that stays legible in an
embedded panel. Build on the owned scene engine, preserving useful controls.

The target user wants to get ideas out of their head and organize them with a
Genie. First value: a readable note on a canvas that can be moved and connected.

Proposed happy path: Office → New Board → type the first note. Creation and
opening are one operation. The same operation is available to a Genie. No copied
path, token, separate account, or manual file creation is part of this journey.

The mock begins with illustrative content for design review. Its Blank board
action exposes the real empty-state design. Example notes are not starter data
that must be deleted from a newly created production board.

## Layout

- Quiet document header with app identity and truthful persistence status in the
  eventual product. Review-only Blank board/Reset demo actions are mock controls.
- Compact vertical creation rail: select, pan, sticky, text, shape, connection,
  image, undo and redo. Labels/tooltips stay discoverable; avoid an insert-only UI.
- Formatting appears at a stable canvas position when an item is selected:
  visible font family and size, emphasis, fill and delete. It does not remake the
  surrounding Apps sidebar per keystroke.
- Optional overview on the left; optional minimap and fit/zoom at the bottom.
  Frames in the example communicate organization; frame creation is not yet
  implemented in this interaction study.
- Canvas receives remaining space. Overview collapses on narrow widths.
- Ivory/Tokyo colors derive from the existing Slides semantic palette. Tokyo
  secondary labels use a brighter foreground for readability. Note text remains
  dark on pastel fills in either palette; plain text follows the canvas palette.
- Reuse Nautilo's existing Genie conversation surface in production. No second
  chat client or fictional presence/avatar strip is introduced here.

Keyboard: V select, H/Space pan, N note, T text, R shape, Escape exit editing,
Delete selected, Cmd/Ctrl-Z undo and Shift redo. Creation immediately selects
the object. Editing and moving are separate gestures. UI focus must not trigger
canvas shortcuts. Reduced motion needs no animation to understand state.

## Current prototype boundary

The HTML implements in-tab creation, movement, text/style editing, connections,
image selection, undo/redo, pan/zoom, palette switch, overview and blank state.
It deliberately uses an independent illustrative DOM scene so it can be reviewed
without a server. This is disposable interaction evidence, **not a replacement
scene engine or a future persistence layer**. The installed Board uses the
owned Board engine and shared editor components rather than this demo state.

No native undo/persistence/recovery/Genie acceptance is claimed from this mock.
The full upstream shape picker, grid snapping, resizing, freehand, multi-selection,
real minimap navigation, image asset persistence and production accessibility
remain part of engine/surface qualification.

## Integration design

The prototype illustrates the ownership boundaries below. The installed app's
current implementation lives in `packages/first-party-apps/board` and
`packages/office-board`; this study is not its implementation-status record.

| State                              | Owner and reconstruction                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Canonical board model and revision | Native document via mini-app bridge; same bytes for Human and Genie             |
| Synthetic single-slide view        | Derived Board adapter; rebuilt from canonical model                             |
| Selection, viewport, menus         | Iframe-local view state; never authoritative document content                   |
| Dirty edit and recovery journal    | Existing native session/recovery composition; preserve exact base revision      |
| Current Folder authority           | Selected device grant/relay, distinct from Workspace authority                  |
| Images                             | Canonical app/document asset contract; no upstream bucket credential dependency |

Reuse `packages/office-slides/src/view/editor/editor.ts` viewport/culling and
slide-chrome suppression. Follow the existing presentation app's document,
session, bridge and app-owned tools contracts. Selectively adapt upstream
Board/store/UI logic; do not mount its Yorkie provider or frontend application.
Inventory and qualify newer upstream fixes before importing them into shared
Slides or Docs. Writer and Slides remain independent regression consumers.

The app's inspect/create/open/edit operations execute exact deterministic work.
Genies choose content, organization and edits; tool design must not become a
list of canned allowed layouts or arbitrary action whitelists. Enforce schema,
authority, stable identity and exact revision semantics, not aesthetic policy.

## Failure and qualification gates

1. Browser engine: pan/zoom, hit tests, overlays, text caret, grid, culling,
   shapes/connections, image decode, undo and both palettes; Slides stays green.
2. Native document: create/open → edit → save → close/reopen in Workspace and
   authorized Current Folder. Dirty state never looks saved before a receipt.
3. Recovery: offline edits, stale revision, authority loss, missing original,
   restart and pending image; preserve work and expose a next action.
4. Human/Genie: create/open without a pre-created file, inspect/edit same model,
   concurrent updates, approvals, typed errors and no silent omitted objects.
5. Packaging: normal inclusion/enabled shipping behavior once qualified, explicit
   Human disable preserved, upgrade/rollback/backup/restore and icon/store image.

The prototype has no production size, history, retry, batch or zoom policy.
Native gates must measure the operating envelope and inherit only justified
format/provider/platform/authority boundaries. Large inspection must report
scope, completeness and a continuation or explicit full-content path. No
silent truncation, model-inferred counts or fixed arbitrary object ceiling.

Miro import is useful later; its mapper can be qualified now. An authenticated
import flow is separate from the first native create/edit/save journey, and its
unsupported content must be reported rather than silently discarded.
