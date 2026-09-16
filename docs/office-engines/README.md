# Owned Office engines: Core, Docs, Sheets, Slides and Board

Nautilo owns Core, Docs, Sheets, Slides and Board in `packages/office-{core,docs,sheets,slides,board}`. These private workspace packages derive from Wafflebase
0.6.9 at `acde58012910ec68645c65b6896d5408fad1645c` (2026-09-06).
They build with the normal Bun/Turbo workspace pipeline. No submodule, external
package publisher or upstream backend is required.

Core has one maintained source tree: `packages/office-core`. Docs, Sheets and
Slides all resolve `@nautilo/office-core` to that same workspace build; do not
copy Core source into individual engine packages. Standalone mini-app artifacts
include generated dependency code so their installed copies remain self-contained.
Those packaging outputs are rebuilt from the shared source, never edited or
versioned as independent Core implementations.

`snapshot.json` records SHA-256 hashes of 1,153 original upstream files, before
Nautilo modifications. Package LICENSE files retain Apache-2.0 and NOTICE.md
records origin and modifications. `CHANGES.md` records adaptations. Generated
app artifacts include the transitive dependency notices and complete file hashes.

Nautilo can change this code to fit the product. Future upstream improvements
are reviewed and selectively ported with regression tests, source revision and
modification notes. There is no automatic upstream merge obligation. Preserve
original copyright and applicable license notices when porting code.

Writer consumes the owned Docs browser and Node exports.
The existing Markdown editor remains in place.
Notes remains deferred. [Board](../../packages/first-party-apps/board/README.md)
and [Slides](../../packages/first-party-apps/presentation/README.md) are bundled
mini-apps; no upstream backend service is included.
See [testing](TESTING.md) for engine, browser and packaged-image checks.
The Slides native Genie authoring contract and responsibility boundaries are in
[SLIDES-GENIE-AUTHORING.md](SLIDES-GENIE-AUTHORING.md).

## Build and qualification

Run `bun install --frozen-lockfile`, then
`bunx turbo run build --filter=@nautilo/office-sheets...`.
For Writer, build `bunx turbo run build --filter=@nautilo/office-docs...` before
building the app. Its standalone production install uses relative `file:` package
dependencies so it can resolve the same sources outside the root workspace.
The server runtime projection follows and validates those registered local edges.
`bun run sheets:prepare` assembles verified compiled files for the mini-app.
Tests, typecheck, lint, unused-code and limit reviews remain normal repository
gates. Generated ANTLR parser files are excluded from handwritten-code lint;
the grammar, generator script and original generated-file hashes remain tracked.

Package build success is not product acceptance. Human and Genie editing,
save/reopen, both document surfaces, palette readability and packaged lifecycle
must qualify before Sheets is called ready. Deployment is a separate action.

## Named engine debt retained for this delivery

D411-ENGINE-BULK-RANGES: the inherited checkbox and border implementations
materialize selected cells. Their temporary 50,000-cell guards have no valid
policy authority; a measured 60,000-cell in-memory case completes in roughly
140 ms. Removing those guards alone would still permit full-grid allocation.
They now refuse before mutation with a typed error, and checkbox keyboard
refusals appear in the app. No partial edit or successful-save claim occurs.
The follow-up should use compressed border patches and a checkbox range-state
representation, preserving formula exceptions, serialization and one undo unit.
These cutoffs must be removed through that redesign, not treated as permanent.
Borders are not exposed by the current Nautilo toolbar or Genie tools.

D411-ENGINE-PRESENCE: the inherited 10,000-axis extension guard suppresses dense
selection anchors beyond existing coverage. Canonical cell selection and data
remain intact, but upstream peer range shape and insertion stability can degrade
to an active-cell coordinate. Nautilo Sheets does not expose upstream peer
presence; its MemStore does not publish or resolve peer anchors. This debt does
not gate the current single-session Nautilo Office surface. Before enabling peer
presence, implement sparse selection anchors/coordinates
with explicit fallback semantics. The old dense-Yorkie freeze measurement does
not justify this exact cutoff for Nautilo.


## Slides dependency qualification

`bunx turbo run build typecheck test:unit --filter=@nautilo/office-slides...`
checks its owned dependency graph. Docs and Slides expose explicit `/browser`
and `/node` entries. Node model consumers do not require browser globals; PPTX
parsing additionally needs a DOMParser/XMLSerializer implementation. Browser
bundles retain the lazy spell dictionary and associated license.

Connector export now writes attached endpoint references using assigned slide
shape IDs, including forward references and group descendants. Missing exported
targets are explicit errors. Raw roundtrip regressions cover rect/ellipse sites;
other PPTX fidelity limits still require application-level qualification.

Writer preparation is part of the normal root postinstall, before app-local
file dependencies are snapshotted. After editing the engine, run
`bun run writer:prepare` and `bun run first-party-apps:install` before a standalone
Writer build; the server seeder also overlays the declared local package sources.
