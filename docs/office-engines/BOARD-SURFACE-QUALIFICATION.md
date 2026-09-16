# Native Board surface qualification

2026-09-13. Integrated Apps-panel acceptance remained in progress at this
checkpoint. This is a real owned-editor surface, not the earlier DOM mock. It
was not yet an installed, canonically saved or released Board mini-app.

## Working surface

`packages/first-party-apps/board/src/board-surface.ts` composes the owned
`office-board` model, `office-slides` canvas editor and in-memory store. A quiet
header, separate creation rail, fixed formatting region and navigation footer
keep the canvas usable at wide and narrow widths. The empty state creates a
note ready for immediate typing. Fonts are visible, with editable suggestions.

Native behavior includes sticky notes, text, the shape path registry, attached
connectors, resize, grouping/ungrouping, arrangement, image placement, undo/redo,
pan, zoom, grid/snap controls and an optional outline/minimap. Escape commits
Board text and returns canvas focus. Image bytes remain intact and async image
loads repaint without another interaction. Pending imports are exposed to the
future host integration. Read-only mounts hide editing and reject mutation.

Ivory/Tokyo are view palettes. Role text follows the view while explicit colors,
source geometry and undo history remain unchanged. The synthetic Slides theme
is derived view state. The implementation adds no upstream frontend, database,
Yorkie service, font-install service or second chat client.

## Verified evidence

- `board-native/qualification.json`: **18 browser scenarios**, Chrome
  152.0.7977.83. Actual keyboard/pointer input and canvas pixels; no engine mocks.
  First-note text remains in order. Header/rail node identity stays stable and
  typing produces zero header mutations in the surface fixture.
- Five Board navigation tests: negative/distant/rotated objects, zoom beyond the
  inherited range in either direction, empty hosts, minimap reconstruction and
  grid density. Board TypeScript, ESLint and scoped Knip files/exports/types pass.
- Shared Slides editor: **182 tests / 4 files**, including a new focused-text
  input regression. Slides TypeScript and touched-file ESLint pass.
- Existing Slides app: **164 tests / 16 files** plus the existing real-browser
  runtime qualification: editing, menus, presenter exit, 23 themes, 11 layouts,
  undo/redo, exact fixture reopen, narrow palettes and read-only preview pass.
- Existing Writer: **294 passing / 28 files**, one pre-existing conditional
  OfficeCLI DOCX image integration skip. Owned Docs/Writer production source is
  unchanged; this is regression evidence, not a new Writer release qualification.
- `slides:prepare` succeeds from the changed shared editor (3 builds, 2 cached).
- Limit inventory/check records one new `ui_projection` decision for fit padding.
  Every fit call only changes the view; complete object bounds survive and no
  implicit zoom ceiling/floor is introduced. Frozen legacy debt does not grow.
  Detector syntax coverage and limitations remain in the generated investigation
  map; this is not a new full audit of unrelated legacy boundaries.

Screenshots: [Ivory](board-native/ivory.png),
[Tokyo](board-native/tokyo.png),
[formatting](board-native/tokyo-formatting.png),
[live palette switch](board-native/palette-switch.png),
[narrow](board-native/narrow.png), and
[empty state](board-native/ivory-empty.png).

## Shared editor correction

The old overlay repaint cleared the whole overlay and then re-appended the text
editor. Browser focus was lost even though the same textarea object was restored;
subsequent printable keys could restart editing at the beginning. Selection
chrome is now composed separately and replaced around the continuously mounted
text input and peer layer. Existing overlay and peer tests remain green.
Original intake hashes in `snapshot.json` are retained as provenance. This is
an owned-source modification, recorded in `CHANGES.md`.

## Product experience preflight

First value is one click followed by typing into a movable note. Creation,
formatting and navigation have stable homes. No filename, token or setup form
appears in this surface. The developer preview explicitly says edits stay in the
tab; it does not claim autosave. The final create-and-open journey still requires
the canonical host work below.

## Open acceptance at this checkpoint

**Integrated surface acceptance was not complete:** the fixture proves native
surface stability,
not the real Workbench Apps sidebar during autosave/context updates. That exact
integrated typing/no-flicker proof remains required as the host is connected.
Do not silently treat the header observer as installed Apps-panel acceptance.

**Canonical delivery:** canonical create/open, Workspace and authorized Current Folder
save/reopen, strict revisions, draft/recovery, pending-image handling across host
shutdown, and same-document Human/Genie tooling/concurrency. The current
`changed` callback is a dirty notification, never a persistence receipt.

**Packaged lifecycle:** manifest/registration, enabled initial seed preserving Human disable,
packaging, upgrade/restart/backup/rollback, authenticated acceptance, distinct
sidebar/store icon and actual expanded-listing screenshot. This surface has no
`app.json` and cannot accidentally seed itself as a production app. No installed
application environment or persisted user data was changed for this evidence.

Authenticated Miro import and freehand authoring are not implemented by this
surface. Miro mapping limitations remain in `BOARD-QUALIFICATION.md`. No claim of
complete upstream frontend parity or arbitrary native-model authoring freedom is
made for the human toolbar; unrestricted native tooling belongs to canonical tool qualification.
