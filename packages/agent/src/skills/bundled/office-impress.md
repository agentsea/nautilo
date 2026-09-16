---
name: office-impress
description: Editing presentations (LibreOffice Impress / .pptx) in Nautilo. Use the `office` tool with `zone: "workspace"` and `inPlace: true` to edit the user's OPEN deck live through the engine — slide ops (insert/duplicate/delete/move/goto, layout, speaker-notes), shape ops (select/format/arrange), tables, default charts, master view, and presenter mode. Slide transitions, animations, and chart config stay UI-only.
requiresTools: [office]
source: official
version: 1
---
# Office Impress — Skill

To edit a presentation the user has open, use the **`office`** tool with
**`zone: "workspace"`** and **`inPlace: true`**. This is THE path. It edits
the human's live Impress deck through the engine (coolwsd holds the WOPI
lock; the save flows back via WOPI PutFile → revision bump + SSE), so the
change appears in the editor the user is looking at.

Do **not**:
- hand-build decks by writing raw XML / `.pptx` bytes,
- use generic file/text tools to mutate a `.pptx`,
- try to drive the engine's dialogs (transition pane, animation pane,
  chart config, header/footer dialog) — those are UI-only, not
  agent-reachable,
- use `office` WITHOUT `inPlace` for an edit you want to land in the deck.

## Addressing model

Impress is **slide- and shape-addressed**, not text-anchored:

- **Slides** are 0-based. Ops that name a slide take `slide: n`; ops that
  act on "the current slide" act on whatever slide is active (use
  `slide_goto` to change it first). `place_textbox` can target a specific
  slide via `targetSlide` (or legacy aliases `slide` / `index`).
- **Shapes** are addressed by **slide coordinate** in **centimetres** via
  an optional `at: {x, y}`. Passing `at` fires `select_shape_at` first (a
  LOK mouse click at that point), then the verb acts on the selection.
  Omit `at` to act on the current selection. Slide sizes for reference:
  4:3 = 25.4 × 19.05 cm, 16:9 = 33.87 × 19.05 cm.

> **Live-verify caveat.** Coordinate-based ops (`select_shape_at`,
> `place_textbox`, and any shape op with `at`) depend on the twips
> coordinate mapping and LOK-click ack timing, which are **not yet
> runtime-verified**. Treat placement as best-effort and confirm with the
> user rather than assuming pixel-precise landing.

## Slide operations

| command | args | effect |
|---|---|---|
| `slide_insert` | `at?` (0-based pos) | insert a slide (after current, or at `at`) |
| `slide_duplicate` | — | duplicate the current slide |
| `slide_delete` | — | delete the current slide |
| `slide_move` | `dir: up\|down\|first\|last` | move the current slide |
| `slide_goto` | `index` (0-based) | make slide N active |
| `set_layout` | `slide`, `layoutId` | apply an AutoLayout to slide N |
| `set_notes` | `slide`, `text` | set speaker-notes text on slide N *(live-verify pending)* |
| `slide_visibility` | `slide?`, `hidden: bool` | hide/show the current (or Nth) slide |

## Shapes

| command | args | effect |
|---|---|---|
| `select_shape_at` | `at: {x,y}` (cm) | select the shape at a coordinate (keystone for the ops below) |
| `place_textbox` | `x`,`y`,`w`,`h` (cm), `text`, `targetSlide?` (`slide`/`index` aliases accepted) | insert a text box with text *(live-verify heavy)* |
| `format_shape` | `at?`, `fillColor?`, `lineColor?`, `x?`,`y?`,`w?`,`h?` (cm), `rotation?` (deg), `flipH?`, `flipV?`, `originalSize?` | fill/line color, position/size/rotation, flips; `originalSize` resets an image to native size |
| `arrange_shape` | `at?`, `zorder? front\|back\|forward\|backward`, `align? left\|center\|right\|top\|middle\|bottom`, `group?`, `ungroup?` | z-order / align / group-ungroup |
| `insert_table` | `rows`, `cols` | insert an N×M table onto the current slide |
| `shape_autofit` | `at?`, `autofit: bool` | toggle auto-fit-to-size on the selected text box *(toggle — see caveat)* |
| `convert_shape` | `at?`, `kind: bitmap\|metafile\|bezier` | convert the selected shape |
| `group_nav` | `action: enter\|leave` | enter/leave a group selection |

Colors are `#rrggbb`. `format_shape` requires at least one field. Its
`fillColor`/`lineColor` set a value, but flips and `originalSize` are FF.

## Charts, master view, fields, presenter

| command | args | effect |
|---|---|---|
| `insert_chart` | — | insert a **default** chart onto the current slide (config is UI-only) |
| `master_view` | `enter: bool` | enter/exit Master View |
| `master_display` | `displayBackground?`, `displayObjects?` (bool) | per-slide master background/objects toggles *(toggles)* |
| `slide_field` | `kind: pagenumber\|pagecount\|pagetitle\|date\|time\|author\|text`, `text?` | insert a field at the cursor in a text box (`kind=text` uses textinput) |
| `slide_outline` | `action: expand\|summary` | expand-page / summary-page on the current slide |
| `presentation` | `mode: current\|rehearse` | start the slideshow from the current slide, or enter rehearse-timings mode *(embed/fullscreen unverified)* |

## Images → `insert_image` (intent-level placement)

Drop a workspace image artifact onto the deck and size/position it by
**INTENT**, not mechanics. You describe what you want; the tool parses the
image's native pixel size from its header bytes, fetches the real slide
size from the engine, computes the rect deterministically, clamps it
on-slide, applies it, and hands back exactly where it landed. You never
touch twips, native pixel sizes, or intermediate steps.

| arg | shape | notes |
|---|---|---|
| `command` | `"insert_image"` | |
| `zone` / `inPlace` | `"workspace"` / `true` | required |
| `path` | string | the workspace deck being edited (the inPlace target) |
| `imagePath` | string | the workspace image artifact to insert, e.g. `"assets/logo.png"` |
| `at` | named anchor \| `{x, y}` cm | optional. A NAMED anchor (`center` [default], `top-left`, `top`, `top-right`, `left`, `right`, `bottom-left`, `bottom`, `bottom-right`) OR an explicit `{x, y}` cm point for the placed image's top-left |
| `size` | `"fit"` \| fraction \| `{w, h}` cm | optional. `"fit"` [default] = contain within ≤ 0.9 of the slide preserving native aspect (aspect-correct, GUARANTEED on-slide). A number (e.g. `0.33`) = that fraction of the SLIDE WIDTH, height derived from native aspect. `{w, h}` = explicit cm; if only one of w/h is given the other is derived from native aspect; both → as-is (may distort). |
| `w` / `h` | cm (number) | optional legacy explicit-cm overrides (prefer `size`) |
| `targetSlide` / `slide` / `index` | 0-based slide | optional — set the active slide BEFORE the insert (aliases must agree) |

**With NO params at all:** contain + center, aspect-correct, on-slide.

**The result INCLUDES the placed rect** — `placedRect {xCm, yCm, wCm, hCm}`
plus `slideSize`, `nativePixels`, `anchor`, `sizeMode`, and
`slideSizeSource` (`"engine"` real readback, or `"fallback"` if the slide
size couldn't be read). Use it for immediate spatial feedback; you do NOT
need a separate `office extract` to confirm placement.

```jsonc
// Drop a logo, fit + center it on the current slide.
{ "command": "insert_image", "zone": "workspace", "inPlace": true,
  "path": "decks/pitch.pptx", "imagePath": "assets/logo.png" }

// Top-right corner, ~1/3 of the slide wide.
{ "command": "insert_image", "zone": "workspace", "inPlace": true,
  "path": "decks/pitch.pptx", "imagePath": "assets/logo.png",
  "at": "top-right", "size": 0.33 }

// Explicit 10×6 cm at (3, 2).
{ "command": "insert_image", "zone": "workspace", "inPlace": true,
  "path": "decks/pitch.pptx", "imagePath": "assets/chart.png",
  "at": { "x": 3, "y": 2 }, "size": { "w": 10, "h": 6 } }
```

Sizing is DETERMINISTIC — it is computed from the image header bytes
(PNG IHDR / JPEG SOF) and the real slide size, NOT a runtime
`graphicselection:` echo. The unit tests of the pure compute function are
meaningful proof of the geometry. Wire transport (getchildid → multipart
POST → socket `insertfile name=… type=graphic`) is grounded in
Collabora's `Map.FileInserter.js`. **Live-verify pending** — the image
visibly lands correctly on the live slide (confidence is HIGH because the
geometry is deterministic, not echo-dependent).

## Toggle caveat

`shape_autofit`, `master_display` (and Writer/Calc `track_changes` /
`freeze_panes`) are **state TOGGLES**, not sets — the tool does not read
current state before firing. Sending `autofit: true` on an already-autofit
shape flips it OFF. Pass the field only when you intend to flip.

## Spatial awareness — see where things actually are

You are NOT placing shapes blind. Two feedback channels exist; use them:

1. **Geometry readback (exact, preferred):** `office extract` (no `inPlace`) on
   a `.pptx` returns `doctype: "slides"` — `slideSize {widthCm, heightCm}` plus
   every shape per slide as `{name, type, xCm, yCm, wCm, hCm, z, text}` and a
   per-slide `notes` string (the speaker-notes text, `""` if none) so `set_notes`
   is verifiable. Coordinates are in the SAME centimetres your `place_textbox` /
   `format_shape` args use, and `type` identifies the box (e.g.
   `com.sun.star.presentation.TitleTextShape` = the title placeholder).
   Because in-place ops save before returning, the loop is closed:
   **place → extract → check (overlap? off-slide? misaligned?) → adjust.**
   Overlap and off-slide checks are arithmetic, not guesswork — e.g. a shape
   is off-slide when `xCm + wCm > slideSize.widthCm`.
2. **Visual render (judgment):** `office render` the deck to PNG/PDF, then
   read the image — you can genuinely look at it. Use for aesthetic calls
   (crowding, balance) that arithmetic doesn't capture. Costlier per
   iteration; prefer the geometry readback for placement mechanics.

## Results are authoritative — do not loop

A success result (`ok: true`) means the edit landed in the user's open deck
AND was verified against the saved bytes (the tool waits for the on-disk
byte change before returning). Do **not** re-run `office extract` to
"check", and do **not** repeat the identical call after a success. A
failure result carries a `reason` — act on it; do not blindly retry.
"did not persist" is a rare transient; retry **at most once**.

## Worked example — new slide, title, and a colored box

```jsonc
// 1. Insert a slide after the current one and make it active.
{ "command": "slide_insert", "zone": "workspace", "inPlace": true, "path": "decks/pitch.pptx" }
{ "command": "slide_goto",   "zone": "workspace", "inPlace": true, "path": "decks/pitch.pptx", "index": 3 }

// 2. Apply a title+content layout to that slide (0-based index 3).
{ "command": "set_layout", "zone": "workspace", "inPlace": true, "path": "decks/pitch.pptx", "slide": 3, "layoutId": 1 }

// 3. Drop a text box and set speaker notes.
{ "command": "place_textbox", "zone": "workspace", "inPlace": true, "path": "decks/pitch.pptx",
  "x": 2, "y": 2, "w": 20, "h": 3, "text": "Q3 Results" }
{ "command": "set_notes", "zone": "workspace", "inPlace": true, "path": "decks/pitch.pptx",
  "slide": 3, "text": "Walk through revenue then margins." }
```

## Not yet available (do not assume)

These are **not** agent-reachable — do not invent them, and do **not** try
to open the engine's UI dialogs (the agent cannot drive a modal):

- **Slide transitions** and **object animations** — dialog/pane-gated.
- **Chart configuration** (type/series/axes/titles) — dialog-gated; you can
  only `insert_chart` a default chart.
- **Header/footer dialog**, **slide-size/page-setup dialog** — dialog-gated.
- **Reading slide text back** — use `office extract` (no `inPlace`).

If the user asks for any of the above, say it's not yet wired and fall back
to what is here. Do not fake it. The natural division: **structure and
placement are agent-reachable; fine visual/animation config is UI-only** —
do the structural work, then hand off the polish to the user in the editor.

## Notes

- Impress ops require `zone: "workspace"` + `inPlace: true`; `out` is not
  used (they never mint a new artifact).
- The session is reused across calls by the engine's session manager —
  consecutive edits to the same `path` are cheap.
- Do **not** shell out to `soffice` / `libreoffice`.
