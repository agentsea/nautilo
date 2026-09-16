---
name: office-calc
description: Editing spreadsheets (LibreOffice Calc / .xlsx) in Nautilo. Use the `office` tool with `zone: "workspace"` and `inPlace: true` to edit the user's OPEN spreadsheet live through the engine — `set_cell` for one cell, `set_range` for a grid, `format_range` to style cells (bold/number-format/merge/wrap/colors/alignment/borders), `sheet` to add/rename/delete/switch tabs, `freeze_panes`, `calc_data` to sort or AutoFilter a range, and `insert_chart` for a default chart. Formulas (leading `=`) evaluate live. Chart config / conditional formatting / pivots / sparklines / function-wizard stay UI-only.
requiresTools: [office]
source: official
version: 1
---
# Office Calc — Skill

To edit a spreadsheet the user has open, use the **`office`** tool with
**`zone: "workspace"`** and **`inPlace: true`**. This is THE path. It edits
the human's live Calc document through the engine (coolwsd holds the WOPI
lock; the save flows back via WOPI PutFile → revision bump + SSE), so the
change appears in the editor the user is looking at.

Do **not**:
- hand-build spreadsheets by writing raw XML / CSV / `.xlsx` bytes,
- use generic file/text tools to mutate a `.xlsx`,
- try to drive the engine's built-in dialogs (Function Wizard, sorting,
  number-format pickers) — those are UI-only, not agent-reachable,
- use `office` WITHOUT `inPlace` for an edit you want to land in the user's
  doc — without `inPlace`, workspace write ops MINT A NEW artifact at `out`
  and leave the input untouched.

The agent-reachable Calc verbs are `set_cell`, `set_range`, and
`format_range`. The first two write values; `format_range` styles cells
that already exist. All three are live, in-place, single-call. There is
no "read cell" verb — to see sheet contents, use `office extract` (a
separate call, no `inPlace`).

## Single cell → `set_cell`

One cell, one value. Args:

| arg | shape | notes |
|---|---|---|
| `command` | `"set_cell"` | |
| `zone` | `"workspace"` | required for in-place |
| `inPlace` | `true` | required for in-place |
| `path` | string | the workspace spreadsheet, e.g. `"books/q3.xlsx"` |
| `cell` | string | cell address, e.g. `"B2"` (absolute `$B$2` also accepted) |
| `value` | string \| number | a number `125000`, a string `"Q1"`, or a formula `"=SUM(B2:B5)"` |
| `sheet` | number (optional) | 0-based sheet index; defaults to `0` |

A `value` (or stringified number) starting with `=` is a **formula** — it
is evaluated by the engine, not stored as text. `=SUM(B2:B5)` computes.

## Multiple cells / ranges → `set_range`

Write a whole grid in one call. Args:

| arg | shape | notes |
|---|---|---|
| `command` | `"set_range"` | |
| `zone` | `"workspace"` | required for in-place |
| `inPlace` | `true` | required for in-place |
| `path` | string | the workspace spreadsheet |
| `range` | string | top-left anchor, e.g. `"A1"` (a full `"A1:C3"` is accepted but only the top-left is used) |
| `rows` | 2D array of (string \| number) | the grid, row-major, written from the top-left |
| `sheet` | number (optional) | 0-based sheet index; defaults to `0` |

`rows` is the grid you want to land starting at `range`. Example:
`range: "A1"`, `rows: [["Quarter","Revenue"],["Q1",125000],["Q2",148000]]`
writes `A1=Quarter, B1=Revenue, A2=Q1, B2=125000, A3=Q2, B3=148000`.

**Prefer `set_range` over a chain of `set_cell`** whenever you are writing
more than ~2 cells — one call, one save, one durability gate. Each
`set_cell` is a full verified transaction; a 6-cell row done as six
`set_cell` calls is six round-trips and six saves for what `set_range`
does in one.

## Cell formatting → `format_range`

Style cells that already exist (written by `set_cell` / `set_range`).
All format fields are OPTIONAL — apply only those you provide. `range`
selects the target via `.uno:GoToCell`; every other field fires its
UNO verb in order. Args:

| arg | shape | notes |
|---|---|---|
| `command` | `"format_range"` | |
| `zone` | `"workspace"` | required for in-place |
| `inPlace` | `true` | required for in-place |
| `path` | string | the workspace spreadsheet |
| `range` | string | `"A1"` or `"A1:C3"` — selected via `.uno:GoToCell {ToPoint}` |
| `bold` | boolean (optional) | `.uno:Bold` — **TOGGLE**, see caveat below |
| `italic` | boolean (optional) | `.uno:Italic` — **TOGGLE** |
| `underline` | boolean (optional) | `.uno:Underline` — **TOGGLE** |
| `numberFormat` | `"general"` \| `"number"` \| `"currency"` \| `"percent"` \| `"date"` (optional) | maps to `.uno:NumberFormatStandard` / `Decimal` / `Currency` / `Percent` / `Date` (FF) |
| `merge` | boolean (optional) | `.uno:ToggleMergeCells` — toggle merge across the range |
| `wrap` | boolean (optional) | `.uno:WrapText` — toggle wrap text |
| `fontColor` | `"#rrggbb"` (optional) | `.uno:Color { "Color.Color": long }` — Calc cell text color |
| `bgColor` | `"#rrggbb"` (optional) | `.uno:BackgroundColor { "BackgroundColor.Color": long }` — cell FILL (not text highlight) |
| `align` | `"left"` \| `"center"` \| `"right"` (optional) | `.uno:AlignLeft` / `AlignHorizontalCenter` / `AlignRight` (FF) — cell horizontal alignment |
| `borders` | `"outline"` \| `"all"` \| `"none"` (optional) | `.uno:SetBorderStyle` preset — `outline` = outer 4 borders, `all` = outer + inner, `none` = clear all. Black, width 1; arbitrary per-side specs are not exposed. |

**Caveat — bold/italic/underline are TOGGLES.** `format_range` does not
read current cell state before sending. It assumes the field is being
applied to freshly-written / unformatted cells (the common agent path:
write the table with `set_range`, then style it with `format_range`).
If a cell is already bold, sending `bold: true` will TOGGLE it off. Pass
the field only when you want to flip the state; omit it to leave it
alone. There is no clean UNO "set bold ON" verb that takes a bool.

Hex colors are `#rrggbb` (e.g. `"#ff0011"`). The tool parses to a long
and sends `<cmd>.Color` (type `long`) — the same arg shape Collabora's
own color picker uses.

At least ONE format field must be provided — a no-op `format_range` is
rejected as a caller bug.

## Sheet management → `sheet`

Add, rename, delete, or switch sheets (tabs) live. Args:

| arg | shape | notes |
|---|---|---|
| `command` | `"sheet"` | |
| `zone` / `inPlace` | `"workspace"` / `true` | required |
| `path` | string | the workspace spreadsheet |
| `action` | `"add"` \| `"rename"` \| `"delete"` \| `"switch"` | required |
| `index` | number (optional) | 0-based sheet position — the insert/target position (`switch` requires it) |
| `name` | string | required for `rename`; optional for `add` (omit → Core assigns `SheetN`) |

- `add` inserts a new sheet at `index` (0-based); omit `name` to let the engine name it.
- `rename` renames the sheet at `index` to `name`.
- `delete` removes the sheet at `index`.
- `switch` makes the 0-based sheet `index` the active one.

To find the right `index`, `office extract` first — it returns the sheets in order.

## Freeze panes → `freeze_panes`

`freeze_panes` with `enabled: true|false` freezes/unfreezes at the current
selection. It is **idempotent**: the tool reads the live `.uno:FreezePanes`
state and only toggles if it disagrees with `enabled`, so calling it twice with
the same value is safe (it falls back to a single toggle only if the state
can't be read). Position the caret first (e.g. a prior `set_cell` on the
freeze row/col).

## Sort & filter → `calc_data`

`calc_data` selects a `range` then fires a Data-group verb:

| arg | shape | notes |
|---|---|---|
| `command` | `"calc_data"` | |
| `zone` / `inPlace` | `"workspace"` / `true` | required |
| `path` | string | the workspace spreadsheet |
| `range` | string | the cells to sort / filter, e.g. `"A1:C20"` (required) |
| `action` | `"sort_asc"` \| `"sort_desc"` \| `"autofilter"` | required |

- `sort_asc` / `sort_desc` → `.uno:SortAscending` / `.uno:SortDescending` — sort
  the range by its **leftmost column**.
- `autofilter` → `.uno:DataFilterAutoFilter` — toggle header filter dropdowns on
  the range.

All FF. (The **insert-function wizard** and **sparklines** stay UI-only —
both are dialog-gated.)

## Charts → `insert_chart` (insert only)

`insert_chart` fires `.uno:InsertObjectChart` and inserts a **default** chart from
the current selection. That is the whole agent surface — chart **configuration**
(type, series, axes, titles) is dialog-gated and **not** agent-reachable. Insert the
default chart and tell the user to refine it in the editor; do not pretend you can
set the chart type.

## Images → `insert_image`

Drop a workspace image artifact onto the current cell / cursor of the open
spreadsheet (agent parity for the human Insert > Image button). The image
lands at the current selection — there is no anchor / `at` pre-positioning
yet, so move the cursor first (e.g. a prior `set_cell` on the target cell)
to control placement. Args: `path` (the spreadsheet being edited),
`imagePath` (the workspace image to insert). Wire is grounded in
Collabora's `Map.FileInserter.js`: `getchildid` → multipart POST
`{name, childid, file}` to `/cool/<WOPISrc>/insertfile` → socket
`insertfile name=… type=graphic`. **Live-verify pending** — K.1 + K.4
await a live dev-stack pass.

## Formulas

A cell whose `value` (or stringified entry in `rows`) starts with `=` is a
formula. The engine evaluates it on commit; the stored cell holds the
formula and renders the computed value. `=SUM(B2:B5)`, `=A2*1.1`,
`=IF(B2>0,"yes","no")` all work. Use `set_cell` for a single formula or
`set_range` to drop a column of formulas alongside their inputs.

## Results are authoritative — do not loop

A success result (`ok: true` / `changed: true`) means the edit landed in
the user's open spreadsheet AND was verified against the saved bytes (the
tool waits for the on-disk byte change before returning). The result
includes `updatedDoc` — the re-extracted post-edit sheet content. Do
**not**:
- run `office extract` to "check whether it really landed",
- call `set_cell` / `set_range` / `format_range` again with the same value,
- retry the identical call after a success.

A `changed: false` / `ok: false` result with a `reason` is the failure
path — **act on the reason, do not repeat the identical call.**
"did not persist" is a rare transient; retry **at most once**.

## Worked example — quarterly table + header style + currency

Build a 4-row quarterly table with a header in one `set_range`, then
style the header (bold + fill) and currency-format the revenue column
with `format_range`, then add a SUM total in one `set_cell`:

```jsonc
// 1. Write the table (header + two quarters) starting at A1.
{
  "command": "set_range",
  "zone": "workspace",
  "inPlace": true,
  "path": "books/q3.xlsx",
  "range": "A1",
  "rows": [
    ["Quarter", "Revenue"],
    ["Q1", 125000],
    ["Q2", 148000]
  ]
}

// 2. Style the header row: bold + light-blue fill across A1:B1.
{
  "command": "format_range",
  "zone": "workspace",
  "inPlace": true,
  "path": "books/q3.xlsx",
  "range": "A1:B1",
  "bold": true,
  "bgColor": "#dde6ff"
}

// 3. Currency-format the revenue cells B2:B3.
{
  "command": "format_range",
  "zone": "workspace",
  "inPlace": true,
  "path": "books/q3.xlsx",
  "range": "B2:B3",
  "numberFormat": "currency"
}

// 4. Add a SUM total below the Revenue column.
{
  "command": "set_cell",
  "zone": "workspace",
  "inPlace": true,
  "path": "books/q3.xlsx",
  "cell": "B4",
  "value": "=SUM(B2:B5)"
}
```

Four calls, four saves, all verified. Write first, format second —
`format_range` works on cells that already exist.

## Not yet available (do not assume)

These are **not** agent-reachable today — do not invent them, and do
**not** try to reach them through the engine's UI dialogs (they open a
modal the agent cannot drive):

- **Conditional formatting** — dialog-gated.
- **Chart configuration** — you can `insert_chart` (a default chart), but
  setting type/series/axes/titles is dialog-gated. Insert + defer the rest
  to the user.
- **Pivot tables** — dialog-gated.
- **Sparklines + the insert-function wizard** — dialog-gated (`.uno:InsertSparkline`
  opens the Sparkline dialog; `.uno:FunctionDialog` opens the function wizard).
  Sort ascending/descending and AutoFilter ARE available now (`calc_data`).
- **Reading a single cell's value back** — there is no "read cell" verb;
  use `office extract` (no `inPlace`, returns the sheet rows as JSON).

If the user asks for any of the above, say it's not yet wired and fall back
to what is here. Do **not** fake it (e.g. `REPT()` bar-chart tricks in a
cell) — say plainly that chart config / CF / pivots are UI-only for now.

**Now available (previously listed here as missing):** cell **borders**
(`format_range --borders`), **sheet** add/rename/delete/switch (`sheet`),
**freeze panes** (`freeze_panes`, now idempotent), **sort + AutoFilter**
(`calc_data`), default **chart insert** (`insert_chart`), and **image
insert** (`insert_image`, Wave K — drops a workspace image onto the
current cell / cursor; live-verify pending). See the sections above.

## Notes

- For Calc editing use `set_cell` / `set_range` / `format_range`, plus
  `sheet` / `freeze_panes` / `calc_data` / `insert_chart` for structure. All
  require `zone: "workspace"` + `inPlace: true`.
- `inPlace: true` with `zone` other than `"workspace"` is rejected.
- The session is reused across calls by the engine's session manager —
  consecutive edits to the same `path` are cheap.
- Do **not** shell out to `soffice` / `libreoffice`.
