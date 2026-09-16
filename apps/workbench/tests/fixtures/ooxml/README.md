# D431 OOXML fidelity corpus

This is a small, redistributable qualification corpus for the browser reader.
Every sentence, number, color-study image, and chart value is original D431
fixture content. It contains no customer or private documents. The reference
captures were generated locally on 2026-07-27: LibreOffice PDF/PNG for DOCX,
artifact-tool PNG for every XLSX sheet, and artifact-tool PNG for every PPTX
slide. The native XLSX image is stored in `xl/media/image.png` and anchored in
the rich workbook, but the artifact-tool workbook PNG renderer omits that image
from its capture; this is recorded in `manifest.json` rather than hidden.

## Taxonomy

Each format has one `simple`, `rich`, `edge`, and `malformed` entry. The edge
files are deliberately bounded: DOCX has 120 short paragraphs plus a 12-column
table; XLSX has 240 × 20 populated cells; PPTX has 15 slides. The malformed
entries are 768-byte truncations of the rich package. They are expected to fail
ZIP integrity checks and are not high-expansion archives.

The existing `apps/desktop/scratch/d362-spike/sample/*`,
`packages/server/assets/office-templates/blank.*`, and
`packages/server/tests/integration/fixtures/d391-roundtrip.docx` remain
smoke-only sources. They are deliberately not duplicated here.

## Regeneration and checking

Run `generate_docx.py` with the bundled Python runtime, then run
`generate_office.mjs` through a temporary symlink whose directory has a
`node_modules` link to the bundled runtime dependencies. Re-render DOCX with
`render_docx.py --emit_pdf`; rerun the artifact-tool renders for XLSX/PPTX.
OOXML ZIP timestamps and artifact-tool object IDs may vary between runs, so
refresh the size/SHA-256 index in `manifest.json` after regeneration before
using the corpus as an exact-byte baseline. The semantic feature inventory,
expected counts, and reference paths are deterministic.

The rich DOCX uses a genuine external OOXML hyperlink targeting
`https://example.invalid/d431`. Product behavior must keep it inert or send it
through Nautilo's validated external-link handler; the fixture never authorizes
direct navigation.

## Local capacity packages

`apps/workbench/scripts/ooxml-fixtures/generate_capacity.py` creates local-only
DOCX, XLSX, or PPTX transport fixtures from the tracked `simple` template. It
adds deterministic, unreferenced OPC payload parts
(`capacity/payload-000.bin`, and so on) using ZIP_STORED and adds their
content-type overrides; original OOXML parts remain in the package. Every
payload part stays at or below the reader's 64 MiB per-entry budget. Payloads
are streamed, so a 100 MiB or 300 MiB package does not require an equivalently
sized memory allocation.

For the normal local output (which is gitignored), run for example:

```sh
python3 apps/workbench/scripts/ooxml-fixtures/generate_capacity.py --format docx --target-mib 100
python3 apps/workbench/scripts/ooxml-fixtures/generate_capacity.py --format xlsx --target-mib 300
python3 apps/workbench/scripts/ooxml-fixtures/generate_capacity.py --format pptx --target-mib 300
```

Files land in `apps/workbench/tests/fixtures/ooxml/capacity/` and are never
committed. A dedicated child of the system temporary directory can be supplied
with `--output-dir` for fast tests. Targets are exact binary MiB values and are
limited to 1–512 MiB; the script rejects unsupported formats, arbitrary output
locations, and overwrites. Record the emitted file's size and SHA-256 in local
qualification evidence if needed. These files exercise source transport and
capacity only: a 300 MiB package is not a claim that it passes reader limits.
