# Nautilo Board

The owned Board model and Slides canvas editor power the native mini-app.
Its production entry composes canonical document writes, recovery, Human edit
leases and Genie tools. Authenticated development and packaged Desktop/Genie
acceptance are complete for the recorded local candidate. PR synchronization and
remote CI remain pending; no production release is claimed.

Run `bun run board:prepare` from the repository root to build self-contained
browser and Node tool bundles with provenance and dependency notices. The
first-party seeder includes Board only when those artifacts are complete and
hash-valid. It preserves an existing explicit disable preference. The app is
grouped under Nautilo Office. Source dependencies are build-time only; seeded
runtime entrypoints use the compiled bundles without a workspace install.

The standalone design fixture remains separate from the canonical app:

From the repository root (Bun 1.3.11):

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@nautilo/office-board
bun packages/first-party-apps/board/scripts/serve-preview.ts
```

The loopback server prints its port. Open `/?example=1` for the example board or
`/?example=1&theme=dark` for Tokyo. The page clearly identifies in-tab edits;
Download a copy exports the current native model, including an active text draft.
No database, login, remote service or installed Desktop is changed.

Verification:

```sh
bun run --cwd packages/first-party-apps/board test
bun run --cwd packages/first-party-apps/board typecheck
bun run --cwd packages/first-party-apps/board lint
bunx knip --directory packages/first-party-apps/board --config knip.json --include files,exports,types
bun packages/first-party-apps/board/scripts/qualify-browser.ts
```

The browser script builds current source and tests in isolated headless Chrome.
It writes real canvas screenshots and a result under `docs/office-engines/board-native`.
It exercises note typing, fonts, native movement/resize, attached connections,
grouping, image bytes/pixels, undo, zoom, minimap, palettes, keyboard and read-only
behavior. Those are surface checks; they are not canonical save or installed
Workbench acceptance. See `docs/office-engines/BOARD-SURFACE-QUALIFICATION.md`.

`mountBoardSurface` exposes the complete native model, including in-flight text,
view/selection state and pending images. `board-app.ts` commits editing before
explicit saves and close, while the serial session uses exact SHA/revision CAS.
Typing holds autosave and does not republish unchanged host context. Conflicts
retain the Human draft and offer retry, save-copy or explicit reload. Preview
mounts the same canvas read-only. `preview.ts` remains a developer fixture.

Genie tools create a saved file with an Open in Board action, discover the full
source-derived schema, inspect complete or selected contents, and atomically
patch the native model. Open edits use the host-owned session/version; closed
edits use the inspected SHA. `insert-image` resolves authorized media through
the existing host asset reader and allocates identity in code. It does not ask
the Genie to generate base64. Canvas image admission matches canonical validation
so an unsupported image cannot trap the document in an unsavable state.

`bun run --cwd packages/first-party-apps/board test:canonical-browser` tests the
prepared production bundle against an HTTP canonical bridge fixture, including
save/reopen, stable typing, concurrency/copy, image refusal and both palettes.
This is distinct from live Nautilo account/Genie acceptance. See
`docs/office-engines/BOARD-CANONICAL-QUALIFICATION.md` for exact evidence and gaps.

Role-based text follows the view palette; authored colors are preserved. Notes
use explicit dark text on pastel fills. The synthetic Slides theme is derived
view state and does not create undo entries or change Board source bytes.
Font suggestions are editable; they are not an allowed-font list. Fonts must be
available to the browser; there is no remote font installation in this surface.

The interface uses the owned shape path registry. It does not claim every
PowerPoint feature, freehand authoring, hosted collaboration or authenticated Miro
import. The server image builds and includes Board unconditionally. Fresh seeding is
enabled; explicit Human disable preferences survive reseeding and upgrades.
The sidebar and expanded app listing use distinct Office artwork and a real
editor screenshot. See
[packaged qualification](../../../docs/office-engines/BOARD-PACKAGED-QUALIFICATION.md)
for the exact candidate, lifecycle, full restore and authenticated Human/Genie
evidence, and `docs/office-engines/BOARD-LIVE-QUALIFICATION.md` for the broader
development Desktop/storage integrity matrix.

Capture the public editor image with `bun packages/first-party-apps/board/scripts/capture-preview.ts`.
Verify a built image with `bun packaging/wafflebase/verify-board-image.mjs IMAGE SOURCE_SHA`.
The image verifier checks bytes, exports, licenses, artwork and disposable app
state transitions; full-instance restoration and authenticated UI are separate.
