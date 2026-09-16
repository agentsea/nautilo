#!/usr/bin/env bun
/** Capture the real Sheets editor with fictional, reproducible showcase data.
 * Run after `bun run sheets:prepare`. No user instance or account is accessed.
 */
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { createSheetDocument, addSheet, serializeSheetHtml } from "../src/sheet-document";
import { recalculateWorkbook } from "../src/sheet-calculation";
import { writeWorksheetCell, type CellStyle } from "../engine/node.js";
import { buildMiniAppRuntimeSrcDoc } from "../../../server/src/apps/app-runtime-html";

const repository = resolve(import.meta.dir, "../../../..");
const appRoot = join(repository, "packages/first-party-apps/spreadsheet");
const output = join(repository, "apps/workbench/public/apps/office/sheets-preview.png");
let workbook = createSheetDocument();
const firstId = workbook.tabOrder[0];
workbook.tabs[firstId].name = "Launch budget";
const sheet = workbook.sheets[firstId];
const write = (row: number, col: number, value: string, style?: CellStyle): void => {
  writeWorksheetCell(sheet, { r: row, c: col }, { ...(value.startsWith("=") ? { f: value } : { v: value }), ...(style ? { s: style } : {}) });
};
const style = (startRow: number, endRow: number, startCol: number, endCol: number, value: CellStyle): void => {
  (sheet.rangeStyles ??= []).push({ range: [{ r: startRow, c: startCol }, { r: endRow, c: endCol }], style: value });
};
[300, 125, 140, 140, 150, 115].forEach((width, index) => { sheet.colWidths[String(index + 1)] = width; });
for (let row = 1; row <= 17; row += 1) sheet.rowHeights[String(row)] = 32;
sheet.rowHeights["1"] = 46;
sheet.rowHeights["2"] = 32;
sheet.rowHeights["3"] = 20;
sheet.rowHeights["13"] = 20;
sheet.rowHeights["14"] = 42;
sheet.merges = { A1: { rs: 1, cs: 6 }, A2: { rs: 1, cs: 6 }, A16: { rs: 1, cs: 6 } };
write(1, 1, "STUDIO NORTH  /  AUTUMN LAUNCH");
write(2, 1, "A clear view of the plan, the spend, and what’s left.");
style(1, 1, 1, 6, { bg: "#123F3A", tc: "#FFFFFF", b: true, va: "middle" });
style(2, 2, 1, 6, { bg: "#E8F3ED", tc: "#356A5F", va: "middle" });
["Workstream", "Owner", "Budget", "Spent", "Remaining", "Used"].forEach((label, index) => write(4, index + 1, label));
style(4, 4, 1, 6, { bg: "#D4E9DF", tc: "#174D40", b: true, va: "middle" });
const rows = [
  ["Brand & strategy", "Avery", 24000, 18250],
  ["Website", "June", 36000, 24100],
  ["Launch film", "Milo", 42000, 29600],
  ["Community", "Sofia", 18000, 9800],
  ["Events", "Reese", 30000, 21000],
  ["Editorial", "Ellis", 16000, 9400],
  ["Paid media", "Noor", 28000, 15800],
  ["Photography", "Jordan", 12000, 7200],
] as const;
rows.forEach((values, index) => {
  const row = index + 5;
  values.forEach((value, col) => write(row, col + 1, String(value)));
  write(row, 5, `=C${row}-D${row}`);
  write(row, 6, `=D${row}/C${row}`);
  style(row, row, 1, 6, { bg: index % 2 === 0 ? "#FFFFFF" : "#F3F7F4", tc: "#273F38", va: "middle" });
});
style(5, 12, 2, 2, { tc: "#667D74" });
style(5, 14, 3, 5, { nf: "currency", cu: "USD", dp: 0 });
style(5, 14, 6, 6, { nf: "percent", dp: 0 });
style(5, 12, 5, 5, { bg: "#E8F5EC", tc: "#1E7156", b: true });
write(14, 1, "TOTAL LAUNCH BUDGET");
for (const [col, letter] of [[3, "C"], [4, "D"], [5, "E"]] as const) write(14, col, `=SUM(${letter}5:${letter}12)`);
write(14, 6, "=D14/C14");
style(14, 14, 1, 6, { bg: "#123F3A", tc: "#FFFFFF", b: true, va: "middle" });
write(16, 1, "Planning together. Every number connected.", { tc: "#62776F", i: true, va: "middle" });
workbook = addSheet(workbook, "Timeline").document;
workbook = addSheet(workbook, "Vendors").document;
workbook = await recalculateWorkbook(workbook);
const content = serializeSheetHtml(workbook);
const built = await Bun.build({ entrypoints: [join(appRoot, "main.ts")], target: "browser", format: "esm", minify: true, sourcemap: "none", splitting: false });
if (!built.success) throw new Error(built.logs.map(entry => entry.message).join("\n"));
const html = `<!doctype html><html data-theme="light"><head></head><body><div id="app"></div><script>
let content = ${JSON.stringify(content).replaceAll("<", "\\u003c")};
window.nautiloApp = {
 document: {
  read: async () => ({content, baseRevision:1, baseSha256:"showcase", path:"Autumn launch.spreadsheet.html"}),
  write: async () => { throw new Error("This capture fixture is read-only."); },
  onChange: () => () => {}, downloadCopy: async () => {}
 }, context: {set: () => {}}, humanEdit: {set: () => {}}
};</script></body></html>`;
const runtime = buildMiniAppRuntimeSrcDoc({ appId: "nautilo-spreadsheet", html, styles: [{ path: "styles.css", content: await Bun.file(join(appRoot, "styles.css")).text() }], bundleJs: await built.outputs[0].text() });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(runtime, { headers: { "content-type": "text/html" } }) });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.env["NAUTILO_SHEETS_CHROME_EXECUTABLE"] ? { executablePath: process.env["NAUTILO_SHEETS_CHROME_EXECUTABLE"] } : {}) });
  const page = await browser.newPage({ viewport: { width: 1120, height: 700 }, deviceScaleFactor: 2, locale: "en-US" });
  await page.goto(`http://${server.hostname}:${server.port}/`);
  await page.getByRole("tab", { name: "Launch budget", exact: true }).waitFor();
  const canvas = await page.locator("canvas").first().boundingBox();
  if (!canvas) throw new Error("The Sheets canvas is missing.");
  const rowCenter = 23 + Object.entries(sheet.rowHeights).filter(([row]) => Number(row) < 14).reduce((sum, [, height]) => sum + height, 0) + 21;
  const columnCenter = 50 + [1, 2, 3, 4].reduce((sum, col) => sum + sheet.colWidths[String(col)], 0) + sheet.colWidths["5"] / 2;
  await page.mouse.click(canvas.x + columnCenter, canvas.y + rowCenter);
  await page.locator('[contenteditable="true"]').first().filter({ hasText: "=SUM(E5:E12)" }).waitFor();
  await page.screenshot({ path: output });
  console.log(`Captured real Sheets editor: ${output}`);
} finally {
  await browser?.close();
  await server.stop(true);
}
