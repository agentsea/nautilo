# Office app artwork

The Writer, Design, Sheets, Slides, and Board SVG icons are original Nautilo
artwork. They share a rounded tile silhouette and use distinct blue, coral,
green, and warm amber palettes.

`sheets-preview.png` is a capture of the actual Sheets editor, using a fictional
Studio North launch budget. It contains no user data. The formula bar, calculated
totals, formatting, and sheet tabs are rendered by the app itself.

`writer-preview.png` and `design-preview.png` are captures of the actual Writer
and Nautilo Design editors, using a fictional Studio North creative brief and
launch poster with a brand palette. Both were captured at 1280 × 800 CSS pixels
with a 2× pixel density from the bundled app entry points and styles, using a
temporary read-only document bridge. No account or user instance was accessed.
The Design capture includes the selected headline and its text inspector.

`slides-preview.png` is a capture of the actual Slides editor using a fictional
Studio North launch presentation. It shows the slide thumbnails, editing canvas,
and speaker notes, and contains no user data.

`board-preview.png` is a capture of the actual Board editor using a fictional
Studio North launch map. Its notes, labels, connectors, and launch badge are
created by the checked-in capture script; it contains no user data.

To refresh the previews from the repository root:

```sh
bun run sheets:prepare
bun packages/first-party-apps/spreadsheet/scripts/capture-preview.ts
bun run slides:prepare
bun packages/first-party-apps/presentation/scripts/capture-preview.ts
bun run board:prepare
bun packages/first-party-apps/board/scripts/capture-preview.ts
```

The scripts use Playwright's Chromium. To use installed Chrome, set
`NAUTILO_SHEETS_CHROME_EXECUTABLE`, `NAUTILO_SLIDES_CHROME_EXECUTABLE`, or
`NAUTILO_BOARD_CHROME_EXECUTABLE` to its executable path. Each starts a temporary
loopback capture harness and closes it afterward; no account or live instance is
accessed. Review the resulting image before committing it. The generated Sheets,
Slides, and Board captures are 1120 × 700 CSS pixels at 2× density.

The Workbench visual map supplies these assets to the sidebar, app overview,
and expanded app details. Other apps retain the existing fallback presentation.
