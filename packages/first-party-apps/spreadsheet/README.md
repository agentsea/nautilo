# Sheets — Nautilo Office

Sheets is a first-party Nautilo Office mini-app for native Wafflebase spreadsheets. It provides its own spreadsheet grid, formula bar, sheet tabs, editing toolbar, undo history, and save/conflict status inside Nautilo. Documents are ordinary `.spreadsheet.html` files in Workspace or Current Folder; the canonical workbook JSON lives in the file rather than in an app-specific backend.

Sheets appears alongside Writer in Nautilo Office on Desktop and Web. Source builds include it by default; availability in a released installation depends on the server image it runs. The browser harness below is one part of qualification, alongside authenticated and packaged lifecycle checks.

## Prepare and run locally

The canonical development stack validates the reviewed artifact before it
starts the server:

```sh
bun run dev-stack --instance <name>
```

It reuses a current generated engine. If the engine is missing, incomplete, or
stale against either the owned office source fingerprint or the canonical
artifact recipe, dev-stack runs the following preparation command and validates
the result again before continuing:

```sh
bun run sheets:prepare
```

Run that command directly when preparing only the artifact or diagnosing a
build failure. `bun run dev-stack --no-build` never rebuilds Sheets; it fails
before server startup with this remediation command when the checked-in source
and generated engine do not match.

For live Desktop qualification, first prepare a named populated test clone using
Nautilo's default-instance testing workflow. Start that clone with its own
`NAUTILO_PROFILE` and an explicit `dev-stack --instance` argument; keep the
protected default instance and installed Desktop application separate.

`sheets:prepare` builds `@nautilo/office-core` and `@nautilo/office-sheets` through the ordinary Bun/Turbo workspace and atomically replaces `engine/` only after assembly succeeds. Browser clients receive the compiled `browser.js` entry; server tools load the DOM-free `node.js` entry.

Normal server startup calls the first-party app seeder. The seeder skips Sheets when the compiled engine is absent, verifies every file hash in `engine/provenance.json`, copies a complete app into the instance apps root, and invalidates its build cache. A fresh prepared installation enables **Sheets** under **Nautilo Office**. Existing disabled choices are preserved; enable Sheets in Apps if you previously disabled it or installed an earlier opt-in seed. Re-running `sheets:prepare` and restarting the server refreshes a changed seed while preserving the user's existing enabled or disabled choice.

The canonical Docker build includes Sheets by default:

```sh
docker build \
  --file packaging/docker/Dockerfile \
  --tag nautilo-server-with-office \
  .
```

For a bounded artifact-stage check without producing the final server image, add `--target wafflebase-sheets-build`. Set `--build-arg NAUTILO_WAFFLEBASE_SHEETS=0` only when intentionally building an image without Sheets.

The canonical Compose source-deployment path includes Sheets by default. For a
new, explicitly selected deployment profile, run `nautilo deploy --profile
<profile>` from a clean source checkout. For an existing deployment, use
`nautilo upgrade --from-sources --profile <profile>` to retain the normal backup
and rollback workflow. `NAUTILO_WAFFLEBASE_SHEETS=0` explicitly excludes Sheets
from a source build; this is not a runtime enablement flag. Registry deployments
use the payload already present in their qualified image.

## Use Sheets

Under **Nautilo Office → Sheets**, create a **New spreadsheet** in Workspace or Current Folder, open a native `.spreadsheet.html` document, or use **Import to Sheets** on an `.xlsx` file. Import creates a separate native `.spreadsheet.html` beside its source and preserves the original workbook. Export from Sheets creates a separate `.xlsx` in Workspace or Current Folder through the normal destination and conflict flow. Both conversions show fidelity warnings before writing; accepting them is bound to the exact source revision, and a changed source requires a fresh preview.

Edits autosave through Nautilo's document bridge using strict revision checks. If the file changes elsewhere, Sheets keeps the local draft and shows recovery actions:

- **Save a copy** downloads the current local draft without overwriting the open file.
- **Reload latest** requires explicit confirmation before discarding local edits and loading the authoritative file.

The Genie surface exposes seven app-owned tools:

- `create-file` creates an empty native spreadsheet through the manifest action.
- `inspect-document` reads a caller-selected range from a closed file and returns its exact SHA-256 edit precondition.
- `edit-document` applies an atomic batch to that inspected closed-file revision.
- `inspect-open-sheet` reads a caller-selected range and version token from the active Sheets session.
- `edit-open-sheet` applies an atomic batch through the host-bound active session only when that inspected version still matches.
- `import-xlsx` maps an OfficeCLI workbook dump into a separate native spreadsheet through the app-owned document boundary.
- `export-xlsx` maps a saved native spreadsheet to OfficeCLI batch operations and writes a separate `.xlsx` through the host boundary.

Range inspection returns sparse stored cells, persisted filter state, manually hidden rows and columns, and truthful completeness. An optional search finds stored values, including numeric results, on the selected sheet or across the workbook. Formula text is searched only when `formulas` is true. Every match says whether its row is hidden. If the caller's page size does not cover the requested range or search result set, inspection returns a continuation tied to the same document version, sheet, range, search scope, query, case choice, and formula choice.

Supported mutation batches set or clear values and formulas, apply basic range formatting, merge or unmerge cells, insert or delete rows and columns, sort rows, and set or clear filters. `sort-range` uses a key column inside the requested range, but it moves complete worksheet rows within those row bounds so data and row metadata stay together; callers must explicitly say whether the first row is a header. Relative formulas move with their rows. Sorts refuse complex intersecting metadata, merges, and dynamic-array spills rather than moving only part of a logical row. Filters persist their range and per-column conditions and report the rows they hide. Sort/filter ranges must fit the workbook’s stored row and column extent; they never allocate a sheet from arbitrary caller coordinates. Add data or insert rows/columns before extending a data range. Sorting across an active filter boundary requires clearing that filter first. Formula results are recalculated across editable sheets before the changed document is persisted.

Safety checks refuse stale inspection tokens, malformed native containers, unsafe spill-cell edits, and operations that would discard unknown cell or worksheet metadata. Unknown metadata that can be retained is round-tripped. Datasource and lakehouse tabs are treated as cached source data and are not recalculated. Cross-sheet unbounded range references are refused because the current headless calculator cannot evaluate them safely.

This release does not expose Genie mutations for sheet creation or rename, charts, pivot tables, comments, or images, and it has no qualified mobile surface. XLSX conversion covers editable sheets, primitive values, formulas and recalculated results where supported, basic number/date and cell formats, row/column sizes and visibility, merges, filters, and frozen panes. Charts, images, pivots, comments, macros, external links, and datasource/lakehouse semantics are omitted or reduced only with explicit conversion warnings; the original source remains intact.

## Verify changes

Run the focused source and packaging suites from the repository root:

```sh
bun test packages/first-party-apps/spreadsheet/src
bun test packaging/wafflebase
bunx tsc --noEmit -p packages/first-party-apps/spreadsheet/tsconfig.json
bunx tsc --noEmit -p packaging/wafflebase/tsconfig.json
```

The browser harness rebuilds the app bundle and exercises the grid, formulas, paste, formatting, structure, tabs, sorting, multi-column filtering, search, undo, both themes at narrow widths, sandboxed dialogs, and conflict recovery against a small in-page host bridge:

```sh
bun bin/nautilo-dev/scripts/qualify-sheets-browser.ts
```

It proves the iframe-side source flow. Authenticated Workbench wiring, host message validation, app seeding, and artifact storage require their own server and integration checks.

## Owned engine and provenance

The engine is maintained as `@nautilo/office-core` and `@nautilo/office-sheets` in this monorepo, derived from Wafflebase `0.6.9` at commit `acde58012910ec68645c65b6896d5408fad1645c`. `engine/provenance.json` records the owned source fingerprint, build-recipe hash, origin, every emitted file hash, and transitive runtime dependency notices. Artifact assembly performs no compiled-output transformations.
