#!/usr/bin/env node
/**
 * Build the XLSX and PPTX halves of the D431 corpus with artifact-tool.
 *
 * Run this file through a temporary symlink whose directory has the bundled
 * `node_modules` link. OOXML ZIP timestamps can vary; authored values and
 * layout inputs are deterministic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/ooxml"));
const xlsxDir = path.join(root, "xlsx");
const pptxDir = path.join(root, "pptx");
const refsXlsx = path.join(root, "references", "xlsx");
const refsPptx = path.join(root, "references", "pptx");
const imagePath = path.join(root, "docx", "original-color-study.png");

async function writeBlob(file, blob) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
}

async function imageDataUrl() {
  const bytes = await fs.readFile(imagePath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function sheetStyle(sheet, range) {
  sheet.showGridLines = false;
  range.format.verticalAlignment = "center";
}

async function exportXlsx(workbook, name, renders) {
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path.join(xlsxDir, name));
  for (const [sheetName, renderRange] of renders) {
    const png = await workbook.render({ sheetName, range: renderRange, scale: 1.5, format: "png" });
    await writeBlob(path.join(refsXlsx, `${path.basename(name, ".xlsx")}--${sheetName.replaceAll(" ", "-")}.png`), png);
  }
}

async function buildSimpleXlsx() {
  const wb = Workbook.create();
  const sheet = wb.worksheets.add("Read me");
  sheet.getRange("A1:C4").values = [
    ["D431 simple workbook", null, null],
    ["Metric", "Value", "Display"],
    ["Typed date", new Date("2026-07-27T00:00:00Z"), "yyyy-mm-dd"],
    ["Amount", 1250, "currency"],
  ];
  sheet.getRange("A1:C1").merge();
  sheet.getRange("A1:C1").format = { fill: "#0B2545", font: { bold: true, color: "#FFFFFF", size: 15 } };
  sheet.getRange("A2:C2").format = { fill: "#E8EEF5", font: { bold: true, color: "#0B2545" } };
  sheet.getRange("B3").format.numberFormat = "yyyy-mm-dd";
  sheet.getRange("B4").format.numberFormat = "$#,##0";
  sheet.getRange("A1:C4").format.borders = { preset: "outside", style: "thin", color: "#B8C5D1" };
  sheet.getRange("A1:C4").format.autofitColumns();
  sheet.getRange("A1:C4").format.autofitRows();
  sheetStyle(sheet, sheet.getRange("A1:C4"));
  await exportXlsx(wb, "simple.xlsx", [["Read me", "A1:C4"]]);
}

async function buildRichXlsx() {
  const wb = Workbook.create();
  const overview = wb.worksheets.add("Overview");
  const data = wb.worksheets.add("Monthly data");
  const support = wb.worksheets.add("Supporting data");
  const img = await imageDataUrl();
  const monthly = [
    ["Month", "Bookings", "Renewal rate", "Target", "Variance"],
    ["Jan", 72000, 0.81, 70000, null],
    ["Feb", 78000, 0.83, 73000, null],
    ["Mar", 86000, 0.85, 76000, null],
    ["Apr", 91000, 0.88, 82000, null],
    ["May", 97000, 0.9, 90000, null],
    ["Jun", 104000, 0.91, 96000, null],
  ];
  data.getRange("A1:E7").values = monthly;
  data.getRange("E2").formulas = [["=B2-D2"]];
  data.getRange("E2:E7").fillDown();
  data.getRange("A1:E1").format = { fill: "#0B2545", font: { bold: true, color: "#FFFFFF" } };
  data.getRange("B2:B7").format.numberFormat = "$#,##0";
  data.getRange("C2:C7").format.numberFormat = "0.0%";
  data.getRange("D2:E7").format.numberFormat = "$#,##0";
  data.getRange("A1:E7").format.borders = { preset: "inside", style: "thin", color: "#D9E2EA" };
  data.getRange("E2:E7").conditionalFormats.add("cellIs", { operator: "greaterThanOrEqual", formula: 0, format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } } });
  data.getRange("E2:E7").conditionalFormats.add("cellIs", { operator: "lessThan", formula: 0, format: { fill: "#FEE2E2", font: { color: "#991B1B", bold: true } } });
  data.freezePanes.freezeRows(1);
  data.freezePanes.freezeColumns(1);
  data.getRange("A1:E7").format.autofitColumns();
  sheetStyle(data, data.getRange("A1:E7"));
  overview.getRange("A1:H1").merge();
  overview.getRange("A1:H1").values = [["D431 qualification workbook — original, deterministic data"]];
  overview.getRange("A1:H1").format = { fill: "#0B2545", font: { bold: true, color: "#FFFFFF", size: 16 } };
  overview.getRange("A3:B6").values = [["Metric", "Value"], ["Total bookings", null], ["Average renewal", null], ["Latest variance", null]];
  overview.getRange("B4").formulas = [["=SUM('Monthly data'!B2:B7)"]];
  overview.getRange("B5").formulas = [["=AVERAGE('Monthly data'!C2:C7)"]];
  overview.getRange("B6").formulas = [["='Monthly data'!E7"]];
  overview.getRange("A3:B3").format = { fill: "#E8EEF5", font: { bold: true, color: "#0B2545" } };
  overview.getRange("B4").format.numberFormat = "$#,##0";
  overview.getRange("B5").format.numberFormat = "0.0%";
  overview.getRange("B6").format.numberFormat = "$#,##0";
  overview.getRange("A3:B6").format.borders = { preset: "all", style: "thin", color: "#B8C5D1" };
  const chart = overview.charts.add("line", data.getRange("A1:B7"));
  chart.title = "Bookings trend";
  chart.hasLegend = false;
  chart.xAxis = { axisType: "textAxis" };
  chart.yAxis = { numberFormatCode: "$#,##0" };
  chart.setPosition("D3", "K18");
  overview.images.add({ dataUrl: img, anchor: { from: { row: 20, col: 0 }, extent: { widthPx: 240, heightPx: 120 } } });
  overview.getRange("A19:C19").merge();
  overview.getRange("A19:C19").values = [["Original embedded image / drawing anchor below"]];
  overview.getRange("A19:C19").format = { font: { italic: true, color: "#52677C" } };
  overview.getRange("A1:K28").format.columnWidth = 14;
  overview.getRange("A1:K28").format.rowHeight = 20;
  sheetStyle(overview, overview.getRange("A1:K28"));
  support.getRange("A1:C5").values = [["Category", "Weight", "Notes"], ["Visual", 0.4, "Human comparison"], ["Interaction", 0.35, "Keyboard and selection"], ["Packaging", 0.25, "WASM closure"], ["Total", null, "Formula driven"]];
  support.getRange("B5").formulas = [["=SUM(B2:B4)"]];
  support.getRange("A1:C1").format = { fill: "#E8EEF5", font: { bold: true, color: "#0B2545" } };
  support.getRange("B2:B5").format.numberFormat = "0%";
  support.getRange("A1:C5").format.autofitColumns();
  sheetStyle(support, support.getRange("A1:C5"));
  try { support.visibility = "Hidden"; } catch { /* facade versions vary; manifest records best effort */ }
  await exportXlsx(wb, "rich.xlsx", [["Overview", "A1:K36"], ["Monthly data", "A1:E7"], ["Supporting data", "A1:C5"]]);
}

async function buildEdgeXlsx() {
  const wb = Workbook.create();
  const sheet = wb.worksheets.add("Bounded grid");
  const cols = Array.from({ length: 20 }, (_, i) => `Field ${String(i + 1).padStart(2, "0")}`);
  sheet.getRange("A1:T1").values = [cols];
  const rows = Array.from({ length: 240 }, (_, r) => cols.map((_, c) => (c === 0 ? `row-${String(r + 1).padStart(3, "0")}` : (r + 1) * (c + 1))));
  sheet.getRange("A2:T241").values = rows;
  sheet.getRange("A1:T1").format = { fill: "#0B2545", font: { bold: true, color: "#FFFFFF" } };
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(1);
  sheet.getRange("B2:T241").format.numberFormat = "#,##0";
  sheet.getRange("A1:T241").format.borders = { preset: "inside", style: "thin", color: "#E2E8F0" };
  sheet.getRange("A1:T241").format.columnWidth = 12;
  sheetStyle(sheet, sheet.getRange("A1:T241"));
  await exportXlsx(wb, "edge-bounded-grid.xlsx", [["Bounded grid", "A1:T40"]]);
}

function addText(slide, text, position, style = {}) {
  const shape = slide.shapes.add({ geometry: "textbox", position, fill: "none", line: { style: "solid", fill: "none", width: 0 } });
  shape.text = text;
  shape.text.style = { fontSize: 20, color: "#16283D", ...style };
  return shape;
}

async function exportPptx(presentation, name) {
  for (const [index, slide] of presentation.slides.items.entries()) {
    await writeBlob(path.join(refsPptx, `${path.basename(name, ".pptx")}--slide-${String(index + 1).padStart(2, "0")}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
  }
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(path.join(pptxDir, name));
}

function basePresentation() {
  return Presentation.create({ slideSize: { width: 1280, height: 720 } });
}

async function buildSimplePptx() {
  const p = basePresentation();
  const slide = p.slides.add();
  slide.background.fill = "#F8FAFC";
  addText(slide, "D431 simple presentation", { left: 90, top: 170, width: 900, height: 80 }, { fontSize: 52, bold: true, color: "#0B2545" });
  addText(slide, "One original slide for baseline reader comparison", { left: 94, top: 270, width: 760, height: 40 }, { fontSize: 24, color: "#52677C" });
  await exportPptx(p, "simple.pptx");
}

async function buildRichPptx() {
  const p = basePresentation();
  const imageBytes = await fs.readFile(imagePath);
  const imageBuffer = imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength);
  const slide1 = p.slides.add();
  slide1.background.fill = "#F8FAFC";
  addText(slide1, "Reader qualification", { left: 72, top: 82, width: 840, height: 74 }, { fontSize: 54, bold: true, color: "#0B2545" });
  addText(slide1, "Original OOXML visual evidence for a browser-native reader", { left: 76, top: 173, width: 720, height: 45 }, { fontSize: 24, color: "#52677C" });
  slide1.shapes.add({ geometry: "rect", position: { left: 76, top: 280, width: 660, height: 8 }, fill: "#2E74B5", line: { style: "solid", fill: "#2E74B5", width: 0 } });
  slide1.images.add({ blob: imageBuffer, contentType: "image/png", alt: "Original D431 color study", fit: "cover", position: { left: 842, top: 280, width: 300, height: 150 }, geometry: "roundRect", borderRadius: "rounded-xl" });
  slide1.speakerNotes.textFrame.setText("Fixture notes: title, body text, native shape, and original embedded image. [Sources] Original D431 fixture asset; no external source.");
  slide1.speakerNotes.setVisible(true);
  const slide2 = p.slides.add();
  slide2.background.fill = "#FFFFFF";
  addText(slide2, "Evidence should lead to a format-by-format decision", { left: 72, top: 60, width: 1000, height: 56 }, { fontSize: 38, bold: true, color: "#0B2545" });
  slide2.charts.add("bar", { position: { left: 88, top: 154, width: 650, height: 365 }, title: "Qualification coverage", categories: ["Visual", "Interaction", "Packaging"], series: [{ name: "Checks", values: [5, 4, 3], fill: "#2E74B5" }], hasLegend: false, dataLabels: { showValue: true, position: "outEnd" }, yAxis: { majorGridlines: { style: "solid", fill: "#E2E8F0", width: 1 } } });
  addText(slide2, "Native chart objects test whether a renderer preserves labels, axes, and bar geometry.", { left: 790, top: 245, width: 340, height: 130 }, { fontSize: 25, color: "#52677C" });
  const slide3 = p.slides.add();
  slide3.background.fill = "#F8FAFC";
  addText(slide3, "A compact native table exposes alignment and text wrapping", { left: 72, top: 60, width: 1050, height: 56 }, { fontSize: 38, bold: true, color: "#0B2545" });
  const table = slide3.tables.add({ rows: 4, columns: 3, left: 90, top: 170, width: 920, height: 270, values: [["Format", "Gate", "Status"], ["DOCX", "Page geometry", "Qualify"], ["XLSX", "Workbook viewport", "Qualify"], ["PPTX", "Slide fidelity", "Qualify"]] });
  table.styleOptions = { headerRow: true, bandedRows: true };
  for (let col = 0; col < 3; col += 1) {
    table.getCell(0, col).fill = "#0B2545";
    table.getCell(0, col).text.style = { fontSize: 18, color: "#FFFFFF", bold: true };
  }
  table.borders.assign({ style: "solid", fill: "#CBD5E1", width: 1 });
  slide3.speakerNotes.textFrame.setText("Fixture notes: native table with three columns and four rows. [Sources] Original D431 fixture content.");
  slide3.speakerNotes.setVisible(true);
  const slide4 = p.slides.add();
  slide4.background.fill = "#0B2545";
  addText(slide4, "Decision rule", { left: 90, top: 100, width: 800, height: 70 }, { fontSize: 50, bold: true, color: "#FFFFFF" });
  addText(slide4, "Replace a legacy view only after its own visual, interaction, and packaging evidence clears the gate.", { left: 95, top: 220, width: 850, height: 130 }, { fontSize: 30, color: "#DCE8F5" });
  slide4.shapes.add({ geometry: "roundRect", position: { left: 96, top: 420, width: 390, height: 82 }, fill: "#E6B325", line: { style: "solid", fill: "#E6B325", width: 0 }, borderRadius: "rounded-xl" });
  addText(slide4, "Evidence before cutover", { left: 128, top: 442, width: 330, height: 35 }, { fontSize: 23, bold: true, color: "#0B2545" });
  await exportPptx(p, "rich.pptx");
}

async function buildEdgePptx() {
  const p = basePresentation();
  for (let i = 1; i <= 15; i += 1) {
    const slide = p.slides.add();
    slide.background.fill = i % 2 ? "#F8FAFC" : "#FFFFFF";
    addText(slide, `Bounded slide ${String(i).padStart(2, "0")}`, { left: 72, top: 72, width: 800, height: 55 }, { fontSize: 40, bold: true, color: "#0B2545" });
    addText(slide, "Repeated but bounded native shapes exercise navigation and lifecycle behavior across a non-trivial deck.", { left: 75, top: 150, width: 770, height: 75 }, { fontSize: 24, color: "#52677C" });
    for (let c = 0; c < 8; c += 1) slide.shapes.add({ geometry: "roundRect", position: { left: 84 + c * 135, top: 300 + (c % 2) * 110, width: 102, height: 70 }, fill: c % 3 === 0 ? "#2E74B5" : c % 3 === 1 ? "#E6B325" : "#0B2545", line: { style: "solid", fill: "#FFFFFF", width: 1 }, borderRadius: "rounded-lg" });
  }
  await exportPptx(p, "edge-bounded-deck.pptx");
}

async function corrupt(dir, sourceName) {
  const source = path.join(dir, sourceName);
  const contents = await fs.readFile(source);
  await fs.writeFile(path.join(dir, `malformed-truncated${path.extname(sourceName)}`), contents.subarray(0, 768));
}

async function main() {
  await Promise.all([fs.mkdir(xlsxDir, { recursive: true }), fs.mkdir(pptxDir, { recursive: true }), fs.mkdir(refsXlsx, { recursive: true }), fs.mkdir(refsPptx, { recursive: true })]);
  await buildSimpleXlsx();
  await buildRichXlsx();
  await buildEdgeXlsx();
  await buildSimplePptx();
  await buildRichPptx();
  await buildEdgePptx();
  await corrupt(xlsxDir, "rich.xlsx");
  await corrupt(pptxDir, "rich.pptx");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
