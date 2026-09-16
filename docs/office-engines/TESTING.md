# Testing Office engines and apps

Run commands from the repository root after `bun install --frozen-lockfile`.
The engine packages, app adapters and packaged image have separate checks.

## Engine checks

```sh
bunx turbo run build typecheck test:unit --filter=@nautilo/office-board...
bunx turbo run build typecheck test:unit --filter=@nautilo/office-slides...
bun run --cwd packages/office-board test:browser
```

The Board browser test needs Playwright Chromium, or an installed Chrome with
`BOARD_TEST_BROWSER_CHANNEL=chrome`. It exercises emitted browser exports;
the unit task also checks Node and CommonJS exports without global DOM shims.

## App checks

The [Board README](../../packages/first-party-apps/board/README.md) and
[Slides README](../../packages/first-party-apps/presentation/README.md) list
their build, unit and browser commands. Board has separate surface and
canonical-bridge browser harnesses. Slides uses a strict version-checking
test bridge. These fixtures do not require a Nautilo account.

For integration testing, use disposable documents in both Workspace and a
granted Current Folder. Check Human and Genie edits, save/reopen, stale-write
conflicts, interrupted writes, Save Copy, and recovery after restart. Include
active text composition and unfinished image imports: an incomplete draft must
remain visible rather than overwrite the saved file.

## Packaged checks

```sh
bun packaging/wafflebase/verify-board-image.mjs IMAGE SOURCE_SHA
bun packaging/wafflebase/verify-slides-image.mjs IMAGE SOURCE_SHA
```

Use the image and source revision being tested. The verifiers check packaged
files, exports, hashes, notices and artwork. Board also checks disposable app
state transitions. Authenticated UI, full-instance backup/restore and release
publication require their own verification; a passing browser fixture does
not establish those results.

## Mapping and conversion limitations

Board's Miro mapper is best-effort. Unknown items and unresolved connectors can
be skipped; frames, cards, connector captions and text geometry can be
approximated. Rich text, font families, links and source styling are not fully
preserved or fully reported. The mapper is not an authenticated import service.

Slides conversion behavior, draft recovery and known restrictions are documented
in its [app README](../../packages/first-party-apps/presentation/README.md).
Test exported documents in the intended viewer and retain originals. Native
editing support does not guarantee lossless PowerPoint or PDF conversion.

## Fixture artwork

[board-native](board-native/) contains synthetic editor captures and browser
results. The Board surface and canonical-browser scripts reproduce those
fixtures. The separate
[capture script](../../packages/first-party-apps/board/scripts/capture-preview.ts)
creates the public app preview. Asset origins are recorded in
[ASSET_PROVENANCE.md](../../ASSET_PROVENANCE.md).
