---
name: office-control
description: Editing and automating office documents (.docx/.xlsx/.pptx) in Nautilo. Use `edit_doc` to change a user's workspace document; use the `office` tool for headless transforms — convert, render, extract, compare — and for producing NEW files.
requiresTools: [edit_doc, office]
source: official
version: 2
---
# Office Control — Skill

Two tools, two jobs. Pick by intent:

- **`edit_doc` — change a document the user has (or will open).** This is
  THE way to modify a workspace document. State an intent and the tool
  handles everything (finding the doc, applying the change on the live
  engine, saving, and confirming it persisted) and returns the updated
  content. You never think about zones, sessions, saving, or file formats.
- **`office` — headless transforms + producing new files.** Convert,
  render, extract, compare, read metadata, or generate a NEW output
  artifact. Use it to READ a document's content or to make a separate file
  — NOT to edit the user's live document.

Do **not** shell out to `soffice`/`libreoffice`.

## Headless generation of NEW documents → `officecli` (see office-generate)

For **GENERATING a new document / deck / sheet from scratch**, from
user-provided assets, by filling a template, or by replaying a batch
— use the **`officecli`** tool and the **office-generate** skill. It
is HEADLESS: no open editor session, zero-clobber on the input (write
commands mint a NEW artifact at `out`), and it covers the full
OfficeCLI surface — `create → add/set → view screenshot/issues` →
fix, `merge` (template fill), `dump → batch` (learn-from-sample),
`help` (prop discovery), and the `raw` / `raw_set` / `add_part` L3
escape hatch.

The split is unambiguous:

| Intent | Tool |
|---|---|
| Edit a document the user has OPEN in their editor | `edit_doc` (text ops) or `office` with `zone:"workspace"` + `inPlace:true` (rich Calc/Impress/Writer ops) |
| Headless transforms on, and new-file production from, an existing doc — convert / render / extract / compare / template-fill / find-replace | `office` (this skill) |
| Generate a NEW doc/deck/sheet from scratch, from assets, by template `merge`, or by `batch` replay — no open editor | **`officecli`** (see the **office-generate** skill) |

`edit_doc` + `office` remain the interactive editing + transform
tools; `officecli` is the headless authoring/generation tool. The two
do not overlap — `officecli` actively refuses to mutate a workspace
document that is open in an editor session (lockout).

## Live in-place editing beyond plain text

`edit_doc` covers text changes (append/replace/insert/delete). For **richer
live edits to the user's open document**, the `office` tool has an
in-place mode (`zone: "workspace"`, `inPlace: true`) that drives the live
engine — no new file, the change lands in the doc the user is looking at:

- **Writer formatting & structure:** `format_text` (bold/italic/underline/
  strike/color/highlight/style/font on an anchored phrase), `insert_link`,
  `insert_comment`, `insert_table`, `track_changes` (suggest mode), and
  `review_changes` (accept/reject tracked changes).
- **Calc:** `set_cell`, `set_range`, `format_range`, `sheet`,
  `freeze_panes`, `insert_chart`, `insert_image` — see the **office-calc** skill.
- **Impress:** slide/shape/notes/layout/presenter ops, `insert_image` — see the
  **office-impress** skill.
- **Image insert (any app):** `insert_image --path <doc> --imagePath <image>`
  drops a workspace image onto the current cursor / selection of the open
  doc (Writer / Calc / Impress). Lands where the cursor is — pair with a
  prior cursor move (e.g. `select_shape_at` / `set_cell`) to control
  placement. Live-verify pending (Wave K).

Dialog-gated features (Calc chart config / conditional formatting / pivots;
Impress transitions / animations) are UI-only — not agent-reachable. Do the
reachable work and hand the rest to the user; never fake it.

## Editing a user's document → `edit_doc`

Give `operation`, `path`, `text`, and (when needed) `anchor`. Nothing else.

| Intent | operation | args |
|---|---|---|
| Add text to the end | `append` | `path`, `text` |
| Change one exact existing phrase | `replace_exact` | `path`, `anchor` (exact text to change), `text` (replacement) |
| Add a paragraph after/before an anchor paragraph | `insert_after` / `insert_before` | `path`, `anchor` (text in the target paragraph), `text` |
| Replace the whole paragraph containing an anchor | `rewrite_section` | `path`, `anchor`, `text` |
| Remove an exact phrase | `delete` | `path`, `anchor` (exact text to remove; no `text`) |

The result is **authoritative** — the tool has already waited for the change to
persist before returning, so trust it and do not loop:
- `changed: true` + a `summary` + `updatedDoc` — **done and verified.** `updatedDoc`
  is the real post-edit content. Do **not** run `office extract` to "check whether
  it really landed", and do **not** call `edit_doc` again for the same change. It
  landed. Move on.
- `changed: false` + a `reason` — nothing changed. **Act on the reason; do not repeat
  the identical call:**
  - "text to replace was not found" → the `anchor` isn't in the doc; `office extract`
    to see exact wording, then retry with corrected `anchor`.
  - "appears N times" → give a longer, unique `anchor` so only the intended spot changes.
  - "did not persist" → a rare transient (the tool already retried transport once);
    retry **at most once**, don't loop.

Rules that keep edits correct:
- `replace_exact` refuses to guess: if the `anchor` is absent or ambiguous it changes
  nothing and tells you why. Fix the `anchor`, don't retry blindly.
- `append` never deletes existing content.
- All anchor ops (`replace_exact`, `insert_after`, `insert_before`, `rewrite_section`)
  require a UNIQUE anchor — absent or ambiguous → no change + a reason. Fix the anchor,
  don't retry blindly.
- To target a mid-document edit, first `office extract` to see exact wording, then
  `edit_doc` with a precise `anchor`/`text`.

## Reading & transforming → `office`

Runs on the server-side LibreOffice engine (nwuno). Reads/writes artifacts
by `path`. For a user's document set `zone: "workspace"`; `home`/`scratch`
are the legacy scratch zones (same as the `file` tool).

| Goal | command | key args |
|---|---|---|
| List engine + supported formats | `info` | — |
| Read structure (paragraphs/tables/headings or sheet rows) as JSON | `extract` | `path`, `zone` |
| Read / write document metadata | `meta_get` / `meta_set` | `path` (+ `out`, `meta` for set) |
| Change format (docx→pdf, xlsx→csv, …) | `convert` | `path`, `out`, `to?` |
| Render to PDF/image | `render` | `path`, `out` |
| Diff two documents | `compare` | `path`, `path2`, `out` |
| Fill a template's `${placeholders}` into a NEW file | `template_fill` | `path`, `out`, `mapping` |
| Find & replace into a NEW file | `find_replace` | `path`, `out`, `find`, `replace`, `regex?` |
| Append/insert into a NEW file | `insert_text` | `path`, `out`, `text`, `atEnd?` |
| Set a spreadsheet cell into a NEW file | `set_cell` | `path`, `out`, `cell`, `value`, `sheet?` |
| Bulk-set a range into a NEW file | `set_range` | `path`, `out`, `range`, `rows`, `sheet?` |

**Important:** on `zone: "workspace"`, `office` write ops (`find_replace`,
`insert_text`, `set_cell`, `template_fill`, …) MINT A NEW artifact at `out`
— they do **not** change the input document. To change the user's actual
document in place, use `edit_doc`.

## Notes

- **Template fill** is the high-leverage move for invoices/contracts/reports:
  author a `.docx` with `${name}`, `${date}`, … then `template_fill` with a
  `mapping` (produces a new file).
- `value` starting with `=` in `set_cell` is treated as a **formula**.
- Fidelity is real LibreOffice rendering; conversions preserve formatting far
  better than text extraction.
