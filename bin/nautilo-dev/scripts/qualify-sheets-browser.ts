#!/usr/bin/env bun
/**
 * Browser qualification for the first-party Sheets mini-app.
 *
 * This rebuilds the browser bundle from source and runs it with a deliberately
 * small in-page host bridge. It proves the iframe-side editor flow only; host
 * postMessage validation, artifact storage, and authenticated Workbench wiring
 * remain covered by their own tests.
 *
 * Run from any directory:
 *   bun bin/nautilo-dev/scripts/qualify-sheets-browser.ts
 *
 * To use an installed Chrome instead of Playwright's bundled Chromium:
 *   NAUTILO_SHEETS_CHROME_EXECUTABLE=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     bun bin/nautilo-dev/scripts/qualify-sheets-browser.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Frame, type Locator, type Page } from "playwright";
import { buildMiniAppRuntimeSrcDoc } from "../../../packages/server/src/apps/app-runtime-html";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const APP_ROOT = join(REPO_ROOT, "packages/first-party-apps/spreadsheet");
const CHROME_EXECUTABLE = process.env["NAUTILO_SHEETS_CHROME_EXECUTABLE"];
const SCREENSHOT_PATH = process.env["NAUTILO_SHEETS_SMOKE_SCREENSHOT"] ?? join(tmpdir(), "nautilo-sheets-browser-smoke.png");
const MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

type Cell = { v?: string; f?: string; s?: { b?: boolean } };
type RangeStyle = { range: [{ r: number; c: number }, { r: number; c: number }]; style: { b?: boolean } };
type SheetDocument = {
  tabs: Record<string, { name: string }>;
  tabOrder: string[];
  sheets: Record<string, {
    cells: Record<string, Cell>;
    rowOrder: string[];
    colOrder: string[];
    rangeStyles?: RangeStyle[];
    filter?: { hiddenRows: number[]; columns: Record<string, unknown> };
    hiddenRows?: number[];
  }>;
};
type HarnessState = { content: string; writes: number; copies: number; revision: number; copyContent?: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function payloadFrom(html: string): SheetDocument {
  const match = /<script id="wafflebase-spreadsheet" type="application\/vnd\.wafflebase\.spreadsheet\+json">([\s\S]*?)<\/script>/.exec(html);
  assert(match?.[1], "Saved HTML does not contain the spreadsheet payload.");
  return JSON.parse(match[1]) as SheetDocument;
}

function sheet(document: SheetDocument, name: string): SheetDocument["sheets"][string] {
  const id = document.tabOrder.find((tabId) => document.tabs[tabId]?.name === name);
  assert(id, `Expected sheet ${name}.`);
  return document.sheets[id]!;
}

function hasBoldStyle(document: SheetDocument, name: string, row: number, column: number): boolean {
  return sheet(document, name).rangeStyles?.some((patch) => patch.style.b === true
    && patch.range[0].r <= row && row <= patch.range[1].r
    && patch.range[0].c <= column && column <= patch.range[1].c) ?? false;
}

function cellAt(document: SheetDocument, name: string, row: number, column: number): Cell | undefined {
  const worksheet = sheet(document, name);
  const rowId = worksheet.rowOrder[row - 1];
  const columnId = worksheet.colOrder[column - 1];
  return rowId && columnId ? worksheet.cells[`${rowId}|${columnId}`] : undefined;
}

function hasCell(
  document: SheetDocument,
  name: string,
  expected: Pick<Cell, "f" | "v">,
): boolean {
  return Object.values(sheet(document, name).cells).some(
    (cell) => (expected.f === undefined || cell.f === expected.f)
      && (expected.v === undefined || String(cell.v) === String(expected.v)),
  );
}

function formulaCell(document: SheetDocument, name: string, formula: string): Cell {
  const cell = Object.values(sheet(document, name).cells).find((candidate) => candidate.f === formula);
  assert(cell, `Expected ${name} to contain ${formula}.`);
  return cell;
}

async function state(page: Page): Promise<HarnessState> {
  return page.evaluate(() => {
    const smoke = (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke;
    return { content: smoke.content, writes: smoke.writes, copies: smoke.copies, revision: smoke.revision };
  });
}

async function documentState(page: Page): Promise<SheetDocument> {
  return payloadFrom((await state(page)).content);
}

async function sandboxState(frame: Frame): Promise<HarnessState> {
  return frame.evaluate(() => {
    const smoke = (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke;
    return { content: smoke.content, writes: smoke.writes, copies: smoke.copies, revision: smoke.revision };
  });
}

async function sandboxDocumentState(frame: Frame): Promise<SheetDocument> {
  return payloadFrom((await sandboxState(frame)).content);
}

async function waitForWrite(page: Page, minimum: number): Promise<void> {
  try { await page.waitForFunction(
    (expected) => (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke.writes >= expected,
    minimum,
    { timeout: 20_000 },
  ); } catch (error) {
    const status = await page.getByRole("status").textContent();
    throw new Error(`Expected save ${minimum}; received ${(await state(page)).writes}. Editor status: ${status}`, { cause: error });
  }
}

async function waitForSandboxWrite(frame: Frame, minimum: number): Promise<void> {
  await frame.waitForFunction(
    (expected) => (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke.writes >= expected,
    minimum,
    { timeout: 20_000 },
  );
}

async function cellPosition(page: Page, row: number, column: number): Promise<{ x: number; y: number }> {
  const canvas = await page.locator("canvas").first().boundingBox();
  assert(canvas, "Spreadsheet canvas is not visible.");
  // The blank fixture uses the pinned engine's default 100px columns and 23px
  // rows. Anchor coordinates to its canvas so shell layout changes stay testable.
  return { x: canvas.x + 90 + (column - 1) * 100, y: canvas.y + 34 + (row - 1) * 23 };
}

async function typeCell(page: Page, column: number, value: string): Promise<void> {
  const { x, y } = await cellPosition(page, 1, column);
  await page.mouse.dblclick(x, y);
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

async function pasteRange(page: Page, row: number, column: number, value: string): Promise<void> {
  await page.evaluate(async (text) => { await navigator.clipboard.writeText(text); }, value);
  await selectCell(page, row, column);
  await page.keyboard.press(`${MODIFIER}+V`);
}

async function selectCell(page: Page, row: number, column: number): Promise<void> {
  const { x, y } = await cellPosition(page, row, column);
  await page.mouse.click(x, y);
  await page.waitForFunction(
    ({ row, column }) => {
      const context = (window as unknown as { __sheetsSmoke: { context?: { selection?: { range?: Array<{ r: number; c: number }> } } } }).__sheetsSmoke.context;
      const range = context?.selection?.range;
      return range?.[0]?.r === row && range[0]?.c === column && range[1]?.r === row && range[1]?.c === column;
    },
    { row, column },
    { timeout: 5_000 },
  );
}

async function qualifySandboxDialog(page: Page, origin: string): Promise<void> {
  await page.setContent(`<iframe sandbox="allow-scripts" src="${origin}/"></iframe>`);
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  assert(frame, "Sandboxed spreadsheet frame did not load.");
  await frame.getByRole("tab", { name: "Sheet1", exact: true }).waitFor({ timeout: 20_000 });

  let writes = (await sandboxState(frame)).writes;
  await frame.getByRole("button", { name: "Add sheet", exact: true }).click();
  await frame.getByRole("textbox", { name: "Sheet name" }).fill("Sandbox totals");
  await frame.getByRole("button", { name: "Create sheet", exact: true }).click();
  await frame.getByRole("tab", { name: "Sandbox totals", exact: true }).waitFor({ timeout: 20_000 });
  await waitForSandboxWrite(frame, ++writes);

  await frame.getByRole("button", { name: "Rename active sheet", exact: true }).click();
  const input = frame.getByRole("textbox", { name: "Sheet name" });
  await input.fill("Sandbox renamed");
  await input.press("Enter");
  await frame.getByRole("tab", { name: "Sandbox renamed", exact: true }).waitFor({ timeout: 20_000 });
  await waitForSandboxWrite(frame, ++writes);

  const document = await sandboxDocumentState(frame);
  assert(
    document.tabOrder.map((id) => document.tabs[id]?.name).join(",") === "Sheet1,Sandbox renamed",
    "Sandboxed add and rename did not persist the expected tabs.",
  );
}

function harnessHtml(initialContent: string): string {
  const content = JSON.stringify(initialContent).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"></head>
<body><div id="app"></div>
<script>
  const state = window.__sheetsSmoke = {
    content: ${content}, revision: 1, writes: 0, copies: 0, conflictNext: false, change: undefined,
  };
  const envelope = () => ({ content: state.content, baseSha256: "smoke-" + state.revision, baseRevision: state.revision, path: "Smoke.spreadsheet.html" });
  window.nautiloApp = {
    document: {
      read: async () => envelope(),
      write: async (content, base) => {
        if (state.conflictNext || base.baseSha256 !== "smoke-" + state.revision || base.baseRevision !== state.revision) {
          state.conflictNext = false;
          return { kind: "conflict", currentSha256: "smoke-" + state.revision };
        }
        state.content = content;
        state.revision += 1;
        state.writes += 1;
        return { kind: "saved", sha256: "smoke-" + state.revision, revision: state.revision, path: "Smoke.spreadsheet.html" };
      },
      onChange: (listener) => { state.change = listener; return () => { if (state.change === listener) state.change = undefined; }; },
      downloadCopy: async (content) => { state.copyContent = content; state.copies += 1; },
    },
    context: { set: (summary) => { state.context = summary; } },
    humanEdit: { set: (update) => { state.humanEdit = update; } },
  };
</script>
</body></html>`;
}

async function buildBundle(outputDirectory: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(APP_ROOT, "main.ts")],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
    splitting: false,
    root: APP_ROOT,
  });
  if (!result.success) {
    const diagnostics = result.logs.map((entry) => entry.message).join("\n");
    throw new Error(`Sheets browser bundle failed:\n${diagnostics}`);
  }
  const output = result.outputs.find((entry) => entry.path.endsWith("main.js"));
  assert(output, "Sheets browser bundle did not emit main.js.");
  return output.path;
}

async function qualifyDataUI(page: Page, initialWrites: number): Promise<number> {
  let writes = initialWrites;
  await page.getByRole("button", { name: "Add sheet", exact: true }).click();
  await page.getByRole("textbox", { name: "Sheet name" }).fill("Records");
  await page.getByRole("button", { name: "Create sheet", exact: true }).click();
  await page.getByRole("tab", { name: "Records", exact: true }).waitFor();
  await waitForWrite(page, ++writes);

  await pasteRange(page, 1, 1, [
    "Name\tAmount\tDouble",
    "Gamma\t314\t=B2*2",
    "Alpha\t100\t=B3*2",
    "Beta\t200\t=B4*2",
  ].join("\n"));
  await waitForWrite(page, ++writes);
  let document = await documentState(page);
  assert(cellAt(document, "Records", 2, 3)?.v === "628", "Record fixture formula did not calculate before sorting.");

  const dataButton = page.getByRole("button", { name: "Data", exact: true });
  await dataButton.click();
  const dataPanel = page.getByRole("dialog", { name: "Sort and filter data" });
  await dataPanel.getByLabel("Data range").fill("A1:C4");
  await dataPanel.getByLabel("Data column").selectOption("2");
  await dataPanel.getByLabel("Sort direction").selectOption("asc");
  await dataPanel.getByLabel("Header row").check();
  await dataPanel.getByRole("button", { name: "Apply sort", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(cellAt(document, "Records", 1, 1)?.v === "Name", "Header moved during ascending sort.");
  assert(cellAt(document, "Records", 2, 1)?.v === "Alpha" && cellAt(document, "Records", 4, 1)?.v === "Gamma", "Ascending sort order is wrong.");
  assert(cellAt(document, "Records", 2, 3)?.f === "=B2*2" && cellAt(document, "Records", 2, 3)?.v === "200", "Ascending sort did not preserve the formula row.");

  await dataPanel.getByLabel("Sort direction").selectOption("desc");
  await dataPanel.getByRole("button", { name: "Apply sort", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(cellAt(document, "Records", 2, 1)?.v === "Gamma" && cellAt(document, "Records", 4, 1)?.v === "Alpha", "Descending sort order is wrong.");
  assert(cellAt(document, "Records", 2, 3)?.f === "=B2*2" && cellAt(document, "Records", 2, 3)?.v === "628", "Descending sort did not preserve the formula row.");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await waitForWrite(page, ++writes);
  assert(cellAt(await documentState(page), "Records", 2, 1)?.v === "Alpha", "One Undo did not restore the ascending row order.");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await waitForWrite(page, ++writes);
  assert(cellAt(await documentState(page), "Records", 2, 1)?.v === "Gamma", "One Redo did not restore the descending row order.");

  await dataPanel.getByLabel("Data column").selectOption("1");
  await dataPanel.getByLabel("Filter condition").selectOption("equals");
  await dataPanel.getByLabel("Filter value").fill("Alpha");
  await dataPanel.getByRole("button", { name: "Apply filter", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(document.sheets[document.tabOrder.find((id) => document.tabs[id]?.name === "Records")!]?.filter?.hiddenRows.join(",") === "2,3", "Filter did not hide the non-matching record rows.");
  assert(cellAt(document, "Records", 2, 1)?.v === "Gamma" && cellAt(document, "Records", 4, 1)?.v === "Alpha", "Filtering discarded or reordered source data.");

  await dataPanel.getByLabel("Data column").selectOption("2");
  await dataPanel.getByLabel("Filter value").fill("100");
  await dataPanel.getByRole("button", { name: "Apply filter", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(Object.keys(sheet(document, "Records").filter?.columns ?? {}).join(",") === "1,2", "A second column filter replaced the first condition.");
  assert(sheet(document, "Records").filter?.hiddenRows.join(",") === "2,3", "Combined filters produced the wrong visible rows.");
  await dataPanel.getByRole("button", { name: "Remove column filter", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(Object.keys(sheet(document, "Records").filter?.columns ?? {}).join(",") === "1", "Removing one column filter removed another condition.");
  await page.setViewportSize({ width: 480, height: 720 });
  const dataBox = await dataPanel.boundingBox();
  assert(dataBox && dataBox.x >= 0 && dataBox.x + dataBox.width <= 480 && dataBox.y + dataBox.height <= 720, "Data panel escaped the narrow viewport.");
  await page.screenshot({ path: "/tmp/stack414-data-filter-narrow.png" });
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.screenshot({ path: "/tmp/stack414-data-filter.png" });
  await dataPanel.getByRole("button", { name: "Clear filter", exact: true }).click();
  await waitForWrite(page, ++writes);
  document = await documentState(page);
  assert(!sheet(document, "Records").filter, "Clear filter left persisted filter state.");
  assert(cellAt(document, "Records", 2, 1)?.v === "Gamma" && cellAt(document, "Records", 4, 1)?.v === "Alpha", "Clear filter lost source data.");
  await dataPanel.getByRole("button", { name: "Close", exact: true }).click();

  await page.keyboard.press(`${MODIFIER}+F`);
  const search = page.getByRole("search");
  const searchInput = search.getByLabel("Find in spreadsheet");
  await searchInput.fill("314");
  await expectSearchCount(search, "1 match");
  await searchInput.fill("B2*2");
  await expectSearchCount(search, "1 match");
  await search.getByLabel("Search scope").selectOption("workbook");
  await searchInput.fill("43");
  await expectSearchCount(search, "1 match");
  await search.getByRole("button", { name: "Next", exact: true }).click();
  await search.getByRole("button", { name: "Previous", exact: true }).click();
  await searchInput.fill("stack414-no-such-value");
  await expectSearchCount(search, "No matches");
  await page.screenshot({ path: "/tmp/stack414-data-search.png" });

  await page.setViewportSize({ width: 480, height: 720 });
  await page.screenshot({ path: "/tmp/stack414-data-light-narrow.png" });
  await page.evaluate(() => { globalThis.document.documentElement.dataset["theme"] = "dark"; });
  await page.locator('.sheets-shell[data-sheets-theme="dark"]').waitFor();
  const searchBox = await search.boundingBox();
  assert(searchBox && searchBox.x >= 0 && searchBox.x + searchBox.width <= 480, "Search panel escaped the narrow viewport.");
  await page.screenshot({ path: "/tmp/stack414-data-dark-narrow.png" });
  await page.evaluate(() => { globalThis.document.documentElement.dataset["theme"] = "light"; });
  await page.locator('.sheets-shell[data-sheets-theme="light"]').waitFor();
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1400, height: 850 });
  return writes;
}

async function expectSearchCount(search: Locator, expected: string): Promise<void> {
  await search.locator(".sheets-shell__search-count").filter({ hasText: expected }).waitFor({ timeout: 5_000 });
}

async function main(): Promise<void> {
  const template = await Bun.file(join(APP_ROOT, "templates/empty-spreadsheet.html")).text();
  const outputDirectory = await mkdtemp(join(tmpdir(), "nautilo-sheets-browser-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let sandboxPage: Page | undefined;

  try {
    const bundle = await buildBundle(outputDirectory);
    const runtimeHtml = buildMiniAppRuntimeSrcDoc({
      appId: "nautilo-spreadsheet",
      html: harnessHtml(template),
      styles: [{ path: "./styles.css", content: await Bun.file(join(APP_ROOT, "styles.css")).text() }],
      bundleJs: await Bun.file(bundle).text(),
    });
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        const headers = { "access-control-allow-origin": "*" };
        if (path === "/") return new Response(runtimeHtml, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
        return new Response("Not found", { status: 404 });
      },
    });
    browser = await chromium.launch({
      headless: true,
      ...(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 850 } });
    const origin = `http://${server.hostname}:${server.port}`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://${server.hostname}:${server.port}/`, { waitUntil: "load" });
    await page.getByRole("tab", { name: "Sheet1", exact: true }).waitFor({ timeout: 20_000 }).catch(async (error: unknown) => {
      await page.screenshot({ path: SCREENSHOT_PATH.replace(/\.png$/, "-failure.png") });
      throw new Error(`Sheets failed to start. Browser errors: ${pageErrors.join("; ")}`, { cause: error });
    });
    const gridHeight = await page.locator("canvas").first().evaluate((canvas) => canvas.getBoundingClientRect().height);
    assert(gridHeight > 200, `Spreadsheet grid did not receive a usable viewport (canvas height ${gridHeight}).`);
    const shellBox = await page.locator(".sheets-shell").boundingBox();
    assert(shellBox?.x === 0 && shellBox.y === 0 && shellBox.height === 850,
      "Host document padding displaced or clipped the spreadsheet viewport.");

    sandboxPage = await context.newPage();
    await qualifySandboxDialog(sandboxPage, origin);
    await sandboxPage.close();
    sandboxPage = undefined;

    let writes = (await state(page)).writes;
    await typeCell(page, 1, "21");
    await waitForWrite(page, ++writes);
    await typeCell(page, 2, "=A1*2");
    await waitForWrite(page, ++writes);
    const firstDocument = await documentState(page);
    assert(String(cellAt(firstDocument, "Sheet1", 1, 1)?.v) === "21", "Expected typed value in Sheet1!A1.");
    const sourceFormula = cellAt(firstDocument, "Sheet1", 1, 2);
    assert(sourceFormula?.f === "=A1*2" && String(sourceFormula.v) === "42", "Expected Sheet1!B1 =A1*2 to calculate 42.");

    await page.getByRole("button", { name: "Add sheet", exact: true }).click();
    await page.getByRole("textbox", { name: "Sheet name" }).fill("Totals");
    await page.getByRole("button", { name: "Create sheet", exact: true }).click();
    await page.getByRole("tab", { name: "Totals", exact: true }).waitFor();
    await waitForWrite(page, ++writes);
    await typeCell(page, 1, "=Sheet1!B1+1");
    await waitForWrite(page, ++writes);
    const totalsDocument = await documentState(page);
    const totalsCell = formulaCell(totalsDocument, "Totals", "=Sheet1!B1+1");
    assert(String(totalsCell.v) === "43", `Expected Totals formula to calculate 43, received ${String(totalsCell.v)}.`);

    writes = await qualifyDataUI(page, writes);

    await page.getByRole("tab", { name: "Sheet1", exact: true }).click();
    await page.evaluate(async () => { await navigator.clipboard.writeText("9\t10\n11\t12"); });
    await selectCell(page, 1, 3);
    await page.keyboard.press(`${MODIFIER}+V`);
    await waitForWrite(page, ++writes);
    const pasted = await documentState(page);
    for (const value of ["9", "10", "11", "12"]) {
      assert(hasCell(pasted, "Sheet1", { v: value }), `Expected pasted value ${value}.`);
    }

    await selectCell(page, 1, 2);
    await page.getByRole("button", { name: "Bold", exact: true }).click();
    await waitForWrite(page, ++writes);
    assert(hasBoldStyle(await documentState(page), "Sheet1", 1, 2), "Expected Bold to persist a range style on Sheet1!B1.");
    await page.getByRole("button", { name: "Bold", exact: true, pressed: true }).waitFor();
    await selectCell(page, 1, 1);
    await page.getByRole("button", { name: "Bold", exact: true, pressed: false }).waitFor();

    const rowsBeforeInsert = sheet(await documentState(page), "Sheet1").rowOrder.length;
    await page.getByRole("button", { name: "Cells", exact: true }).click();
    await page.getByRole("menuitem", { name: "Insert row", exact: true }).click();
    await waitForWrite(page, ++writes);
    assert(sheet(await documentState(page), "Sheet1").rowOrder.length > rowsBeforeInsert, "Expected Insert row to change worksheet structure.");

    await typeCell(page, 5, "undo-marker");
    await waitForWrite(page, ++writes);
    assert(hasCell(await documentState(page), "Sheet1", { v: "undo-marker" }), "Expected marker before undo.");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForWrite(page, ++writes);
    assert(!hasCell(await documentState(page), "Sheet1", { v: "undo-marker" }), "Expected Undo to restore the prior worksheet state.");

    await page.evaluate(() => { (window as unknown as { __sheetsSmoke: { conflictNext: boolean } }).__sheetsSmoke.conflictNext = true; });
    await typeCell(page, 6, "stale-local");
    await page.locator('[role="status"][data-status="conflict"]').waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Save a copy", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke.copies === 1);
    await page.getByRole("button", { name: "Reload latest", exact: true }).click();
    await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
    await page.locator('[role="status"][data-status="saved"]').waitFor({ timeout: 20_000 });

    const draftCell = await cellPosition(page, 1, 7);
    await page.mouse.dblclick(draftCell.x, draftCell.y);
    await page.keyboard.type("uncommitted-local");
    await page.evaluate(() => {
      const smoke = (window as unknown as { __sheetsSmoke: HarnessState & { change(event: { type: string }): void } }).__sheetsSmoke;
      smoke.revision += 1;
      smoke.change({ type: "changed" });
    });
    await page.locator('[role="status"][data-status="conflict"]').waitFor();
    assert(await page.locator('[contenteditable="true"]:focus').textContent() === "uncommitted-local",
      "An incoming revision replaced the unfinished cell input.");
    await page.setViewportSize({ width: 480, height: 720 });
    await page.screenshot({ path: SCREENSHOT_PATH.replace(/\.png$/, "-recovery.png") });
    await page.getByRole("button", { name: "Save a copy", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke.copies === 2);
    const copyContent = await page.evaluate(() => (window as unknown as { __sheetsSmoke: HarnessState }).__sheetsSmoke.copyContent);
    assert(copyContent && cellAt(payloadFrom(copyContent), "Sheet1", 1, 7)?.v === "uncommitted-local",
      "Recovery copy omitted unfinished input.");
    await page.getByRole("button", { name: "Reload latest", exact: true }).click();
    await page.getByRole("button", { name: "Discard local edits and reload", exact: true }).click();
    await page.locator('[role="status"][data-status="saved"]').waitFor();
    await page.setViewportSize({ width: 1400, height: 850 });

    await selectCell(page, 1, 8);
    const canvas = await page.locator("canvas").first().boundingBox();
    assert(canvas, "Missing canvas before formula-bar test.");
    const formulaIndex = await page.locator('[contenteditable="true"]').evaluateAll((nodes, canvasTop) =>
      nodes.findIndex(node => { const box = node.getBoundingClientRect(); return box.height > 0 && box.y < canvasTop; }), canvas.y);
    assert(formulaIndex >= 0, "Missing engine formula bar.");
    const formulaBar = page.locator('[contenteditable="true"]').nth(formulaIndex);
    await formulaBar.click();
    await page.keyboard.type("=6*7");
    await formulaBar.blur();
    await page.setViewportSize({ width: 1180, height: 760 });
    await page.waitForFunction(
      (index) => document.querySelectorAll<HTMLElement>('[contenteditable="true"]')[index]?.innerText === "=6*7",
      formulaIndex,
    );
    assert(await formulaBar.textContent() === "=6*7", "Resize repaint hid unfinished formula-bar input before Save.");
    writes = (await state(page)).writes;
    await page.getByRole("button", { name: "Save spreadsheet", exact: true }).click();
    await waitForWrite(page, ++writes);
    const formulaSave = cellAt(await documentState(page), "Sheet1", 1, 8);
    assert(formulaSave?.f === "=6*7" && formulaSave.v === "42", "Save omitted unfinished formula-bar input.");

    const escapeCell = await cellPosition(page, 1, 9);
    await page.mouse.dblclick(escapeCell.x, escapeCell.y);
    await page.keyboard.type("discard-this");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (window as unknown as { __sheetsSmoke: { humanEdit?: { state: string } } }).__sheetsSmoke.humanEdit?.state === "clean");

    assert(pageErrors.length === 0, `Unexpected page error: ${pageErrors[0]}`);
    await page.screenshot({ path: SCREENSHOT_PATH });
    for (const width of [804, 480]) {
      await page.setViewportSize({ width, height: 720 });
      await page.getByRole("button", { name: "Cells", exact: true }).click();
      const menu = await page.getByRole("menu", { name: "Cells actions" }).boundingBox();
      assert(menu && menu.x >= 0 && menu.x + menu.width <= width && menu.y + menu.height <= 720,
        `Cells menu escaped the ${width}px viewport.`);
      await page.screenshot({ path: SCREENSHOT_PATH.replace(/\.png$/, `-${width}.png`) });
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 804, height: 720 });
    await page.emulateMedia({ colorScheme: "dark" });
    assert(await page.locator(".sheets-shell").getAttribute("data-sheets-theme") === "light",
      "OS dark mode overrode the explicit Nautilo light palette.");
    await selectCell(page, 1, 1);
    const paletteCell = await cellPosition(page, 1, 1);
    await page.mouse.dblclick(paletteCell.x, paletteCell.y);
    await page.keyboard.type("Palette draft");
    await page.evaluate(() => { document.documentElement.dataset["theme"] = "dark"; });
    assert(await page.locator(".sheets-shell").getAttribute("data-sheets-theme") === "light",
      "Palette switch remounted a pending cell draft.");
    writes = (await state(page)).writes;
    await page.keyboard.press("Enter");
    await waitForWrite(page, ++writes);
    await page.locator('.sheets-shell[data-sheets-theme="dark"]').waitFor();
    assert(cellAt(await documentState(page), "Sheet1", 1, 1)?.v === "Palette draft", "Palette switch lost the draft.");
    await selectCell(page, 1, 1);
    const darkColors = await page.locator(".sheets-shell__grid-host").evaluate(host => ({
      background: getComputedStyle(host).backgroundColor,
      formula: getComputedStyle(host.querySelector('[contenteditable="true"]')!).color,
    }));
    assert(darkColors.background === "rgb(30, 30, 30)" && darkColors.formula === "rgb(255, 255, 255)",
      `Dark palette has unreadable engine colors: ${JSON.stringify(darkColors)}.`);
    await page.screenshot({ path: SCREENSHOT_PATH.replace(/\.png$/, "-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    assert(await page.locator(".sheets-shell").getAttribute("data-sheets-theme") === "dark",
      "OS light mode overrode the explicit Nautilo dark palette.");
    await page.evaluate(() => { document.documentElement.dataset["theme"] = "light"; });
    await page.locator('.sheets-shell[data-sheets-theme="light"]').waitFor();
    const lightColors = await page.locator(".sheets-shell__grid-host").evaluate(host => ({
      background: getComputedStyle(host).backgroundColor,
      formula: getComputedStyle(host.querySelector('[contenteditable="true"]')!).color,
    }));
    assert(lightColors.background === "rgb(255, 255, 255)" && lightColors.formula === "rgb(0, 0, 0)",
      `Light palette has unreadable engine colors: ${JSON.stringify(lightColors)}.`);
    await page.screenshot({ path: SCREENSHOT_PATH.replace(/\.png$/, "-light.png") });
    writes = (await state(page)).writes;
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await waitForWrite(page, ++writes);
    assert(cellAt(await documentState(page), "Sheet1", 1, 1)?.v !== "Palette draft", "Palette switch reset undo history.");
    console.log(`Sheets browser qualification passed: typing, formulas, tabs, undo/redo, paste, style, structure, sort/filter/search data flows, narrow light/dark layout, and conflict recovery. Screenshot: ${SCREENSHOT_PATH}`);
  } finally {
    await sandboxPage?.close();
    await browser?.close();
    await server?.stop(true);
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

await main();
