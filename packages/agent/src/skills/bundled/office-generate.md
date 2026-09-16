---
name: office-generate
description: Headless authoring / generating NEW .docx/.xlsx/.pptx from scratch or from user-provided assets. Use the `officecli` tool when the user wants to "make a deck / slides / presentation / spreadsheet / report from scratch", "generate a pptx / xlsx / docx", fill a template, batch-generate, or learn-from-sample. NOT for editing a document the user has open — use edit_doc / office (inPlace) / the Writer mini-app for that.
requiresTools: [officecli]
source: official
version: 1
---
# Office Generate — Skill

Headless authoring of NEW office documents. One tool, one job: the
**`officecli`** tool drives the OfficeCLI binary to **create**,
**populate**, and **render** `.docx` / `.xlsx` / `.pptx` artifacts with
no open editor session and no user-facing mini-app. It is the
generate-from-scratch, closed-file, batch/template, and
render→look→fix path. It is **distinct from** the interactive office
tooling (`edit_doc`, `office` with `inPlace: true`, and the
Writer/Spreadsheet/Slides mini-app tools), which edit a document the
user is looking at.

Do **not**:
- shell out to `soffice` / `libreoffice` / `python-docx` /
  `openpyxl` — `officecli` is the sanctioned engine and reaches
  every documented capability,
- hand-build `.docx` / `.xlsx` / `.pptx` bytes or raw XML by hand
  when an L1/L2 verb exists (use the L3 `raw` / `raw_set` /
  `add_part` escape hatch only when `help` shows no typed verb for
  what you need),
- use `officecli` to mutate a workspace document that is currently
  open in an office editor session — the tool refuses with a
  lockout error. Switch to `edit_doc` / `office` (inPlace) / the
  Writer mini-app, or have the user close the editor first.

## WHEN — headless generation

Reach for `officecli` when the intent is any of:

- **Make a NEW document from scratch** — "make a deck", "generate a
  spreadsheet", "build a report .docx", "create a pptx for the Q3
  review". There is no open mini-app session; the output is a fresh
  artifact at a workspace path.
- **Generate from user-provided assets** — drop a folder of images
  into a slide deck, turn a CSV into a formatted `.xlsx`, lay a
  chart into a new `.pptx`. The inputs are files, not an open doc.
- **Template fill at scale** — design one layout, fill
  `{{key}}` placeholders across N deterministic reports (invoices,
  contracts, weekly metrics). One `merge` call per fill.
- **Batch / scripted generation** — build a document by replaying a
  JSON command array (`batch`), or learn a sample's structure
  (`dump`) and replay it onto a new file.
- **Render→look→fix on a closed file** — `view screenshot` to see
  it, `view issues` to read machine-detected defects, then fix with
  `set` / `add`. No editor involved.

Do **not** use `officecli` when the user has the document open in
their editor and wants the change to land in what they are looking
at — that is the interactive path (see the routing table below).

## HOW — the omnibus command model

`officecli` is one tool with a single `command` field. Commands fall
into three layers; prefer the lowest layer that does the job:

| Layer | Commands | Use when |
|---|---|---|
| **L1 — intent** | `create`, `add`, `set`, `remove`, `move`, `swap`, `merge`, `view`, `get`, `query`, `validate`, `refresh`, `help` | default — typed verbs for the common cases |
| **L2 — dom** | `get` / `query` with object paths + CSS-like selectors (`/body/p[1]`, `slide[1]`, `row[Revenue>1000]`), `set` / `add` with `--props` | when you need to address a specific node by path or selector |
| **L3 — raw** | `raw` (read XML), `add_part` (new part → relId), `raw_set` (XPath edit) | the zero-drop escape hatch — e.g. SmartArt, custom XML parts, anything `help` shows no typed verb for |

### Prop discovery → `help`

Before guessing a property name, run `help`:

```jsonc
// List every element + verb for a format.
{ "command": "help", "format": "pptx" }

// Full per-property schema for one element.
{ "command": "help", "format": "pptx", "element": "shape" }

// Same for docx / xlsx.
{ "command": "help", "format": "docx", "element": "paragraph" }
{ "command": "help", "format": "xlsx", "element": "cell" }
```

`help` is the schema introspection lane — it tells you the exact
`--prop` keys, types, and accepted values the binary supports. Use
it whenever you are unsure whether a property exists.

### The generate loop → `create → add/set → view → fix`

1. **`create`** a blank artifact at `out` (format inferred from the
   extension; `--locale` optional) and pass a valid `commands` array
   when building from scratch. Batch items use OfficeCLI's exact JSON
   shape: **`command`** (not `cmd`); `add` uses **`parent` + `type`**
   (not `path`); `set`/`remove`/`move`/`get` use `path`.
2. **`add`** children (paragraphs, slides, shapes, sheets, rows,
   charts, pictures) and **`set`** their properties inside that
   `commands` array so the initial document is generated in one
   create→batch→save cycle.
3. For later edits to an existing closed artifact, call `add` /
   `set` / `batch` with both `path` (input) and **`out`** (new
   output artifact). Mutations never overwrite the source.
4. **`view screenshot`** to look at the result, and **`view issues`**
   to read machine-detected defects (overflow, missing alt text,
   low contrast, broken refs). Both run headless — rendering is
   built into the binary; no display needed.
5. **Fix** with `set` / `add` / `remove` / `move` based on what you
   saw. Re-render. Repeat until the screenshot looks right AND
   `view issues` is clean.

```jsonc
// Create a deck and build the first slides in one valid commands array.
{ "command": "create", "out": "decks/q3-review.pptx",
  "commands": [
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title Slide" } },
    { "command": "add", "parent": "/slide[1]", "type": "placeholder", "props": { "phType": "title", "text": "Q3 Review" } },
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title and Content" } },
    { "command": "add", "parent": "/slide[2]", "type": "chart", "props": { "chartType": "column", "data": "...", "x": "1cm", "y": "3cm", "width": "20cm", "height": "10cm" } }
  ] }

// Render the slides to PNG and look at them.
{ "command": "view", "path": "decks/q3-review.pptx", "mode": "screenshot" }

// Read machine-detected issues, then fix.
{ "command": "view", "path": "decks/q3-review.pptx", "mode": "issues" }
```

### Markdown to native Word elements in one call

For a new `.docx`, add the supported Markdown subset as a `markdown` element
inside the initial `commands` array. OfficeCLI expands it into editable native
Word headings, paragraphs, and lists; `markdown` is **not** a `convert` format
and Nautilo does not parse it itself.

```jsonc
{ "command": "create", "out": "reports/brief.docx",
  "commands": [
    { "command": "add", "parent": "/body", "type": "markdown",
      "props": { "markdown": "# Brief\n\nA native paragraph.\n\n- First item\n- Second item" } }
  ] }
```

Top-level `data` is for `merge` only. Do **not** send `data` with `create`:
use `commands` (including the Markdown `add` shape above) when authoring a new
document.

### Imagery — two lanes

`officecli` embeds images through its `imageInputs` wrapper, which
materializes the image to a temp file and adds the correct
`picture` batch command with cm placement:

- **Image-gen output** — use `imageInputs: [{ source: "workspace",
  path: "artifacts/generated-hero.png", parent: "/slide[1]",
  at: "center", size: "fit", alt: "..." }]`. Preserve generated
  provenance in the `provenance` object when available.
- **Filesystem user assets** — use `imageInputs: [{ source: "fs",
  path: "/Users/me/assets/logo.png", parent: "/slide[1]",
  at: "bottom-right", size: { w: 4 }, alt: "Logo" }]`.
  PNG / JPG / GIF / SVG are supported.

For `.docx`, pictures can be inline or floating (`anchor=true` +
`wrap` / `hPosition` / `vPosition`). For `.xlsx`, anchor by cell
range (`anchor=B2:E6`, `anchorMode`). For `.pptx`, absolute `x/y` +
fill modes (stretch/contain/cover/tile). See the format-specific
`help <format> picture` for the full prop set.

### Template fill → `merge`

Design one document with `{{key}}` placeholders, then fill it N
times from JSON. Zero token cost per fill.

```jsonc
{ "command": "merge", "path": "templates/invoice.docx",
  "out": "invoices/2026-07-acme.docx",
  "data": { "client": "Acme", "amount": "€12,500", "date": "2026-07-08" } }
```

Placeholders are filled across paragraphs, table cells, shapes,
headers/footers, and chart titles. Use `merge` for invoices,
contracts, weekly metric decks — anything where the layout is fixed
and the values vary.

### Learn-from-sample → `dump` then `batch`

When the user hands you a sample document and says "make more like
this", do not hand-write OOXML:

1. **`dump`** the sample's subtree (paragraphs / tables / slides /
   styles / theme) to replayable batch JSON.
2. Inspect + mutate the JSON (swap text, adjust styling, change
   data).
3. **`batch`** the mutated JSON onto a new file created with
   `create`.

This is the sanctioned way to clone structure. `dump → batch` is
round-trippable for `.docx` and `.pptx`.

### Zone — workspace by default; in-place when `out === path`

`zone` defaults to **`"workspace"`**. Mutating commands:

- **Edit a closed file in place** — omit `out`, or set `out` equal to
  `path`. Bytes land on the same workspace artifact (revertable update).
- **Mint a NEW artifact (zero-clobber)** — pass a different `out` than
  `path`. The input is never overwritten.

`home` / `scratch` are the legacy scratch zones. Open editor sessions
still lock out `officecli` mutations.

### Bounded escape hatches

The `batch` command accepts up to **50** commands per call (bounded
to keep generation tractable and reviewable). The `raw` /
`raw_set` / `add_part` lane is the L3 zero-drop guarantee — anything
the typed verbs miss (SmartArt, custom XML parts, schema edges) is
still reachable by writing OOXML directly via XPath.

## ROUTING DECISION TREE — the crux

Pick the tool by **whether the document is open in the user's
editor** and **whether you are making a new file or editing an
existing one**:

| Situation | Use | Why |
|---|---|---|
| User has the doc OPEN in a Writer/Spreadsheet/Slides mini-app and wants the change to land in what they see | `edit_doc` (text ops) or `office` with `zone:"workspace"` + `inPlace:true` (rich Calc/Impress/Writer ops) or the app-specific mini-app tools (`app_nautilo_writer__*` etc.) | Live in-place editing through the engine; the save flows back via WOPI → the editor the user is looking at updates in real time. |
| User has the doc OPEN but `edit_doc` / `office inPlace` doesn't cover the op (e.g. slide transitions, chart config) | Do the reachable part interactively; **hand the rest to the user** — do not fake it, do not silently switch to headless on the open file | Those ops are dialog-gated and not agent-reachable. `officecli` will refuse to mutate an open workspace doc (lockout). |
| User wants a NEW document generated from scratch, from assets, from a template, or by batch — NO open editor session | **`officecli`** | Headless authoring; produces a fresh artifact at `out`; zero-clobber on the input. |
| User wants to edit a CLOSED workspace file in place (no open editor) | **`officecli`** with `out` omitted or `out === path` | Headless mutate of the same artifact; open sessions still lock out. |
| User wants to render / inspect / validate a closed file | **`officecli`** `view screenshot` / `view issues` / `validate` | Render→look→fix loop on a closed file, no editor needed. |
| User wants to fill a template N times | **`officecli`** `merge` | One call per fill; deterministic; zero token cost per fill. |
| User wants to clone/learn from a sample | **`officecli`** `dump` → `batch` | Round-trippable structured replay; never hand-write OOXML. |
| You are unsure whether a property/verb exists | **`officecli`** `help` | Schema introspection; the binary tells you what it supports. |

**The boundary, stated unambiguously:** `officecli` is HEADLESS. It
never edits a document the user has open — the tool actively
refuses such mutations (workspace lockout). For interactive
co-editing of an open document, use `edit_doc`, `office`
(`inPlace: true`), or the Writer/Spreadsheet/Slides mini-app tools.
For everything else — generating, templating, batching, rendering,
inspecting a closed file — use `officecli`.

See the **office-control** skill for the `edit_doc` vs `office`
split, the **office-calc** / **office-impress** skills for the
interactive in-place verb surface, and the **mini-app-authoring**
skill for the app-specific mini-app tools.

## Quality floors — generated output must clear a bar, not just a schema

A generated deck / sheet / doc that opens without errors is not
necessarily good. Hold generated output to these floors (folded
from the OfficeCLI domain guidance):

### Decks (`.pptx`)

- **Slide titles ≥ 36pt.** If a title is smaller, bump it.
- **One idea per slide.** Splitting a slide that carries two
  arguments into two slides is a fix, not a stylistic preference.
- **Render every slide before declaring completion.** Do not inspect one
  representative page and infer the rest. Call `view screenshot` without a
  page filter (or render every slide explicitly) and inspect the whole deck.
- **Character spacing is in points, not DrawingML hundredths.** For example,
  `spacing: 1.2` means 1.2pt; `spacing: 120` means an extreme 120pt gap and
  will force ordinary labels to wrap. Use `lineSpacing` for line spacing.
  `help pptx shape` in the pinned OfficeCLI version misstates this unit, so
  follow this rule until that upstream schema is corrected.
- **Every content slide carries a non-text visual** — a picture, a
  chart, a shape, or a diagram. A content slide with only a text
  bullet list fails the floor.
- **Speaker notes on every content slide** — the notes carry the
  talk-track; a content slide with empty notes fails the floor.
  Use `set` on the `notes` element (or `slide` `notes` prop).
- **Body text ≥ 18pt.** Smaller body text is unreadable on a
  projected deck.

### Sheets (`.xlsx`)

- **Header row styled and frozen** — bold + fill on the header,
  `freeze` on the row below it so it stays visible while scrolling.
- **Number formats match the meaning** — currency on money,
  percent on rates, date on dates. A number column with `general`
  format when the values are currency fails the floor.
- **Column widths fit the content** — no `###` overflow on the
  data rows.
- **One table per sheet** — a second logical table goes on a new
  tab, not below the first.

### Docs (`.docx`)

- **Headings styled, not bold-paragraphs** — use the `style` prop
  with canonical style ids (`Heading1`, `Heading2`, …) so the TOC
  and navigation work. If you want to use the display name with a
  space, use `styleName: "Heading 1"` — do not guess.
- **A TOC on docs > ~3 pages** — `add --type toc` after the title.
- **Tables have real data, header rows + borders** — `rows`/`cols`
  alone creates an empty grid. Use `data: "H1,H2;R1C1,R1C2"` for a
  populated table, or add/set `table-cell` nodes at
  `/body/tbl[1]/tr[R]/tc[C]`. Use `style: "medium2"` or
  `border.*` props for visible formatting.
- **Images carry `alt` text** — every `picture` gets an `alt` prop
  unless it is `decorative: true`.

### Universal

- **`validate` passes** — run `officecli validate` before
  declaring done. Schema errors are non-negotiable.
- **`view issues` is clean or triaged** — overflow, missing alt
  text, formula/field errors, low contrast, and broken refs are
  flagged. Fix what is fixable; surface the rest to the user.
- **`view screenshot` looks like the intent** — render the final
  output to PNG and look at it. If it does not match what the user
  asked for, it is not done.

## Worked example — generate a 5-slide deck from a brief

```jsonc
// Create the deck and build the structure in one batch: title + 3 content slides + closing.
{ "command": "create", "out": "decks/launch-plan.pptx",
  "commands": [
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title Slide" } },
    { "command": "add", "parent": "/slide[1]", "type": "placeholder", "props": { "phType": "title", "text": "Launch Plan" } },
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title and Content" } },
    { "command": "add", "parent": "/slide[2]", "type": "placeholder", "props": { "phType": "title", "text": "Goals" } },
    { "command": "add", "parent": "/slide[2]", "type": "shape", "props": { "text": "Ship v1 by Q4", "x": "1cm", "y": "3cm", "width": "20cm", "height": "3cm" } },
    { "command": "add", "parent": "/slide[2]", "type": "notes", "props": { "text": "Frame the quarter around one launch." } },
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title and Content" } },
    { "command": "add", "parent": "/slide[3]", "type": "placeholder", "props": { "phType": "title", "text": "Timeline" } },
    { "command": "add", "parent": "/slide[3]", "type": "chart", "props": { "chartType": "bar", "data": "Wk1:design,Wk3:build,Wk6:beta,Wk9:ship", "x": "1cm", "y": "3cm", "width": "20cm", "height": "10cm" } },
    { "command": "add", "parent": "/slide[3]", "type": "notes", "props": { "text": "Walk left-to-right; call out the beta gate." } },
    { "command": "add", "parent": "/", "type": "slide", "props": { "layout": "Title Slide" } },
    { "command": "add", "parent": "/slide[4]", "type": "placeholder", "props": { "phType": "title", "text": "Questions?" } }
  ] }

// Render → look → fix.
{ "command": "view", "path": "decks/launch-plan.pptx", "mode": "screenshot" }
{ "command": "view", "path": "decks/launch-plan.pptx", "mode": "issues" }

// Validate before declaring done.
{ "command": "validate", "path": "decks/launch-plan.pptx" }
```

Three tool calls: create-with-commands, render+inspect, validate.
The screenshot gives you eyes; `issues` gives you machine-detected
defects; `validate` gives you schema correctness.

## Notes

- `officecli` is the headless lane. For interactive editing of an
  open document, switch to `edit_doc` / `office` (`inPlace: true`)
  / the Writer/Spreadsheet/Slides mini-app tools.
- Write commands with a distinct `out` mint a NEW artifact
  (zero-clobber). Omit `out` or set `out === path` to update a closed
  file in place. Both paths use the revertable binary patch pipeline.
- The `batch` escape hatch is bounded to 50 commands per call.
- The `raw` / `raw_set` / `add_part` lane is the L3 zero-drop
  guarantee; use it only when `help` shows no typed verb for what
  you need.
- Do **not** shell out to `soffice` / `libreoffice` / `python-docx`
  / `openpyxl`. `officecli` is the sanctioned engine.

## Worked example — styled `.docx` report with a populated table

Do not call a document "advanced" unless the batch actually applies
advanced properties. In particular: `rows`/`cols` makes an empty
table; `style: "Heading 1"` is a display name, not the canonical
style id. Use `style: "Heading1"` or `styleName: "Heading 1"`.

```jsonc
{ "command": "create", "out": "reports/quarterly.docx",
  "commands": [
    { "command": "add", "parent": "/body", "type": "paragraph",
      "props": { "text": "Advanced Pressure Test Report", "style": "Heading1", "size": 22, "bold": true, "color": "1F4E78" } },
    { "command": "add", "parent": "/body", "type": "paragraph",
      "props": { "text": "This report exercises real table data, styled headings, and cell formatting.", "style": "Normal", "size": 12 } },
    { "command": "add", "parent": "/body", "type": "paragraph",
      "props": { "text": "Quarterly Breakdown", "style": "Heading2", "size": 16, "bold": true } },
    { "command": "add", "parent": "/body", "type": "table",
      "props": { "style": "medium2", "width": "16cm", "data": "Quarter,Revenue,Growth;Q1,$120k,12%;Q2,$140k,17%" } },
    { "command": "set", "path": "/body/tbl[1]/tr[1]/tc[1]", "props": { "fill": "1F4E78", "color": "FFFFFF", "bold": true } },
    { "command": "set", "path": "/body/tbl[1]/tr[1]/tc[2]", "props": { "fill": "1F4E78", "color": "FFFFFF", "bold": true } },
    { "command": "set", "path": "/body/tbl[1]/tr[1]/tc[3]", "props": { "fill": "1F4E78", "color": "FFFFFF", "bold": true } }
  ] }
```

After creating it, immediately verify:

```jsonc
{ "command": "view", "path": "reports/quarterly.docx", "mode": "text" }
{ "command": "view", "path": "reports/quarterly.docx", "mode": "screenshot" }
{ "command": "validate", "path": "reports/quarterly.docx" }
```

If the screenshot shows an empty grid, you forgot `data` or the cell
`set` calls. Fix the batch; do not declare success.
