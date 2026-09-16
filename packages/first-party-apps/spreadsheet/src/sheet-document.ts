import {
  createSpreadsheetDocument,
  createWorksheet,
  generateTabId,
  getNextDefaultSheetName,
  getUniqueTabName,
  getWorksheetEntries,
  normalizeTabName,
  parseRef,
  parseWorksheetCellKey,
  type SpreadsheetDocument,
  type Worksheet,
} from "../engine/node.js";
import { sheetCellDisplay, validateStoredFilter } from "./sheet-filter";

export type SheetDocument = SpreadsheetDocument;

const MANIFEST_ID = "manifest";
const MANIFEST_TYPE = "application/vnd.nautilo.document+json";
const LEGACY_MANIFEST_TYPE = "application/vnd.nautilo.spreadsheet+json";
const PAYLOAD_ID = "wafflebase-spreadsheet";
const PAYLOAD_TYPE = "application/vnd.wafflebase.spreadsheet+json";
const PREVIEW_MAX_ROWS = 50;
const PREVIEW_MAX_COLUMNS = 20;

type ScriptBlock = {
  readonly attributes: Record<string, string>;
  readonly content: string;
};

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeObject(value: unknown, path = "document"): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((entry, index) => pending.push({
        value: entry,
        path: `${current.path}[${index}]`,
      }));
      continue;
    }
    for (const key of Object.keys(current.value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`${current.path}.${key} is forbidden`);
      pending.push({
        value: (current.value as Record<string, unknown>)[key],
        path: `${current.path}.${key}`,
      });
    }
  }
}

function assertPlainRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
}

function assertCanonicalPositiveIndexKeys(value: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(value)) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 1 || String(index) !== key) {
      throw new Error(`${path} must use canonical positive 1-based integer keys`);
    }
  }
}

function validateCell(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const field of ["v", "f", "spillAnchor"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`${path}.${field} must be a string when present`);
    }
  }
  if (value["s"] !== undefined && !isRecord(value["s"])) {
    throw new Error(`${path}.s must be an object when present`);
  }
  for (const field of ["spillRows", "spillCols"] as const) {
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1)
    ) {
      throw new Error(`${path}.${field} must be a positive integer when present`);
    }
  }
  if (value["spillBlocked"] !== undefined && typeof value["spillBlocked"] !== "boolean") {
    throw new Error(`${path}.spillBlocked must be a boolean when present`);
  }
}

function validateWorksheet(value: unknown, tabId: string): asserts value is Worksheet {
  const path = `document.sheets[${JSON.stringify(tabId)}]`;
  assertPlainRecord(value, path);
  assertPlainRecord(value["cells"], `${path}.cells`);
  assertStringArray(value["rowOrder"], `${path}.rowOrder`);
  assertStringArray(value["colOrder"], `${path}.colOrder`);
  validateStoredFilter(value["filter"], { rows: value["rowOrder"].length, columns: value["colOrder"].length });
  if (new Set(value["rowOrder"]).size !== value["rowOrder"].length) {
    throw new Error(`${path}.rowOrder must contain unique IDs`);
  }
  if (new Set(value["colOrder"]).size !== value["colOrder"].length) {
    throw new Error(`${path}.colOrder must contain unique IDs`);
  }
  for (const field of ["nextRowId", "nextColId"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 1) {
      throw new Error(`${path}.${field} must be a positive integer`);
    }
  }
  for (const field of ["rowHeights", "colWidths", "rowStyles", "colStyles"] as const) {
    assertPlainRecord(value[field], `${path}.${field}`);
    assertCanonicalPositiveIndexKeys(value[field], `${path}.${field}`);
  }
  for (const field of ["rowHeights", "colWidths"] as const) {
    for (const [index, size] of Object.entries(value[field] as Record<string, unknown>)) {
      if (!Number.isFinite(size)) throw new Error(`${path}.${field}.${index} must be a finite number`);
    }
  }
  for (const field of ["rowStyles", "colStyles"] as const) {
    for (const [index, style] of Object.entries(value[field] as Record<string, unknown>)) {
      if (!isRecord(style)) throw new Error(`${path}.${field}.${index} must be an object`);
    }
  }
  for (const field of ["rangeStyles", "conditionalFormats", "dataValidations"] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`${path}.${field} must be an array when present`);
    }
    if (Array.isArray(value[field]) && value[field].some((entry) => !isRecord(entry))) {
      throw new Error(`${path}.${field} must contain objects`);
    }
  }
  for (const field of ["merges", "charts", "images", "comments"] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) {
      throw new Error(`${path}.${field} must be an object when present`);
    }
    if (isRecord(value[field]) && Object.values(value[field]).some((entry) => !isRecord(entry))) {
      throw new Error(`${path}.${field} must contain objects`);
    }
  }
  for (const field of ["frozenRows", "frozenCols"] as const) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`${path}.${field} must be a non-negative integer`);
    }
  }
  const rowIds = new Set(value["rowOrder"]);
  const colIds = new Set(value["colOrder"]);
  for (const [key, cell] of Object.entries(value["cells"])) {
    const { rowId, colId } = parseWorksheetCellKey(key);
    if (!rowIds.has(rowId) || !colIds.has(colId)) {
      throw new Error(`${path}.cells[${JSON.stringify(key)}] references an unknown axis ID`);
    }
    validateCell(cell, `${path}.cells[${JSON.stringify(key)}]`);
  }
}

export function validateSheetDocument(value: unknown): SheetDocument {
  assertSafeObject(value);
  assertPlainRecord(value, "document");
  assertPlainRecord(value["tabs"], "document.tabs");
  assertStringArray(value["tabOrder"], "document.tabOrder");
  assertPlainRecord(value["sheets"], "document.sheets");

  const tabOrder = value["tabOrder"];
  if (tabOrder.length === 0) throw new Error("document.tabOrder must contain at least one tab");
  if (new Set(tabOrder).size !== tabOrder.length) {
    throw new Error("document.tabOrder must contain unique tab IDs");
  }
  const tabIds = Object.keys(value["tabs"]);
  const sheetIds = Object.keys(value["sheets"]);
  if (tabIds.length !== tabOrder.length || tabIds.some((id) => !tabOrder.includes(id))) {
    throw new Error("document.tabs must exactly match document.tabOrder");
  }
  if (sheetIds.length !== tabOrder.length || sheetIds.some((id) => !tabOrder.includes(id))) {
    throw new Error("document.sheets must exactly match document.tabOrder");
  }
  const seenNames = new Set<string>();
  for (const tabId of tabOrder) {
    const tab = value["tabs"][tabId];
    assertPlainRecord(tab, `document.tabs[${JSON.stringify(tabId)}]`);
    if (tab["id"] !== tabId) throw new Error(`tab ${tabId} must carry its map key as id`);
    if (typeof tab["name"] !== "string" || normalizeTabName(tab["name"]).length === 0) {
      throw new Error(`tab ${tabId} must have a non-empty name`);
    }
    const nameKey = normalizeTabName(tab["name"]).toUpperCase();
    if (seenNames.has(nameKey)) throw new Error(`duplicate sheet name: ${tab["name"]}`);
    seenNames.add(nameKey);
    if (tab["type"] !== "sheet" && tab["type"] !== "datasource" && tab["type"] !== "lakehouse") {
      throw new Error(`tab ${tabId} has an unsupported type`);
    }
    validateWorksheet(value["sheets"][tabId], tabId);
  }
  return value as unknown as SheetDocument;
}

function attributesFrom(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attributes, key)) throw new Error(`duplicate script attribute: ${key}`);
    attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function scriptsFrom(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const matcher = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(html)) !== null) {
    blocks.push({ attributes: attributesFrom(match[1] ?? ""), content: match[2] ?? "" });
  }
  const openings = html.match(/<script\b/gi)?.length ?? 0;
  if (openings !== blocks.length) throw new Error("spreadsheet contains an unterminated script block");
  return blocks;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw.replace(/<\\\/script/gi, "</script"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function parseSheetHtml(html: string): SheetDocument {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error("spreadsheet HTML must be a non-empty string");
  }
  const scripts = scriptsFrom(html);
  if (scripts.length !== 2) throw new Error("spreadsheet HTML must contain exactly two data scripts");
  const manifestBlocks = scripts.filter((block) =>
    block.attributes["id"] === MANIFEST_ID &&
    (block.attributes["type"] === MANIFEST_TYPE || block.attributes["type"] === LEGACY_MANIFEST_TYPE));
  if (manifestBlocks.length !== 1) throw new Error("spreadsheet manifest script is missing or ambiguous");
  const manifestBlock = manifestBlocks[0];
  if (Object.keys(manifestBlock.attributes).some((key) => key !== "id" && key !== "type")) {
    throw new Error("spreadsheet manifest script contains executable or unsupported attributes");
  }
  const manifest = parseJson(manifestBlock.content, "spreadsheet manifest");
  assertSafeObject(manifest, "manifest");
  assertPlainRecord(manifest, "manifest");
  if (manifest["documentType"] !== "spreadsheet" || manifest["editor"] !== "wafflebase") {
    throw new Error("spreadsheet manifest identity is invalid");
  }
  if (manifest["payloadFormat"] !== PAYLOAD_TYPE) throw new Error("spreadsheet payload format is invalid");
  if (typeof manifest["payloadId"] !== "string" || manifest["payloadId"].length === 0) {
    throw new Error("spreadsheet manifest payloadId is invalid");
  }
  const payloadBlocks = scripts.filter((block) =>
    block.attributes["id"] === manifest["payloadId"] && block.attributes["type"] === PAYLOAD_TYPE);
  if (payloadBlocks.length !== 1) throw new Error("spreadsheet payload script is missing or ambiguous");
  const payloadBlock = payloadBlocks[0];
  if (Object.keys(payloadBlock.attributes).some((key) => key !== "id" && key !== "type")) {
    throw new Error("spreadsheet payload script contains executable or unsupported attributes");
  }
  return validateSheetDocument(parseJson(payloadBlock.content, "spreadsheet payload"));
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function columnLabel(column: number): string {
  let label = "";
  for (let current = column; current > 0; current = Math.floor((current - 1) / 26)) {
    label = String.fromCharCode(65 + ((current - 1) % 26)) + label;
  }
  return label;
}

function previewSheet(document: SheetDocument): { name: string; sheet: Worksheet } {
  const id = document.tabOrder.find((tabId) => document.tabs[tabId]?.type === "sheet")
    ?? document.tabOrder[0];
  return { name: document.tabs[id].name, sheet: document.sheets[id] };
}

function buildSheetPreviewHtml(document: SheetDocument): string {
  const { name, sheet } = previewSheet(document);
  const title = escapeHtml(name);
  const entries = getWorksheetEntries(sheet);
  if (entries.length === 0) {
    return `<main class="nautilo-spreadsheet-preview"><h1>${title}</h1><p>Empty spreadsheet. Open with Sheets to edit.</p></main>`;
  }

  let minRow = Infinity;
  let maxRow = 0;
  let minColumn = Infinity;
  let maxColumn = 0;
  const cells = new Map(entries);
  for (const [reference] of entries) {
    const { r, c } = parseRef(reference);
    minRow = Math.min(minRow, r);
    maxRow = Math.max(maxRow, r);
    minColumn = Math.min(minColumn, c);
    maxColumn = Math.max(maxColumn, c);
  }

  const previewMaxRow = Math.min(maxRow, minRow + PREVIEW_MAX_ROWS - 1);
  const previewMaxColumn = Math.min(maxColumn, minColumn + PREVIEW_MAX_COLUMNS - 1);
  let table = `<main class="nautilo-spreadsheet-preview"><h1>${title}</h1><table><thead><tr><th scope="col" aria-label="Row"></th>`;
  for (let column = minColumn; column <= previewMaxColumn; column += 1) {
    table += `<th scope="col">${columnLabel(column)}</th>`;
  }
  table += "</tr></thead><tbody>";
  for (let row = minRow; row <= previewMaxRow; row += 1) {
    table += `<tr><th scope="row">${row}</th>`;
    for (let column = minColumn; column <= previewMaxColumn; column += 1) {
      const reference = `${columnLabel(column)}${row}`;
      const cell = cells.get(reference);
      table += `<td>${cell ? escapeHtml(sheetCellDisplay(sheet, { r: row, c: column }, cell)) : ""}</td>`;
    }
    table += "</tr>";
  }
  table += "</tbody></table>";
  if (previewMaxRow < maxRow || previewMaxColumn < maxColumn) {
    const shownRows = previewMaxRow - minRow + 1;
    const usedRows = maxRow - minRow + 1;
    const shownColumns = previewMaxColumn - minColumn + 1;
    const usedColumns = maxColumn - minColumn + 1;
    table += `<p class="nautilo-spreadsheet-preview-truncation">Preview truncated: showing ${shownRows} of ${usedRows} rows and ${shownColumns} of ${usedColumns} columns in the used range.</p>`;
  }
  table += "<p>Static preview. Open with Sheets to edit.</p></main>";
  return table;
}

export function serializeSheetHtml(document: SheetDocument): string {
  const safe = validateSheetDocument(structuredClone(document));
  const manifest = {
    documentType: "spreadsheet",
    editor: "wafflebase",
    payloadId: PAYLOAD_ID,
    payloadFormat: PAYLOAD_TYPE,
    version: "1.0",
  };
  const preview = buildSheetPreviewHtml(safe);
  const title = escapeHtml(previewSheet(safe).name);
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><title>${title}</title>`,
    "<style>",
    "body { font-family: system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #fff; }",
    "table { border-collapse: collapse; font-size: 13px; }",
    "th, td { border: 1px solid #d8dee9; min-width: 6rem; padding: 0.35rem 0.5rem; text-align: left; }",
    "th { background: #f8fafc; color: #475569; font-weight: 600; }",
    "p { color: #64748b; }",
    "</style>",
    `<script id="${MANIFEST_ID}" type="${MANIFEST_TYPE}">${safeScriptJson(manifest)}</script>`,
    `<script id="${PAYLOAD_ID}" type="${PAYLOAD_TYPE}">${safeScriptJson(safe)}</script>`,
    "</head><body>",
    preview,
    "</body></html>",
  ].join("\n");
}

export function createSheetDocument(): SheetDocument {
  return createSpreadsheetDocument();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validatedSheetName(name: string): string {
  const normalized = normalizeTabName(name);
  if (!normalized) throw new Error("sheet name must not be blank");
  if (normalized.includes("'") || normalized.includes("!") || containsControlCharacter(normalized)) {
    throw new Error("sheet name contains characters unsupported by cross-sheet formulas");
  }
  return normalized;
}

function formulaSheetName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : `'${name}'`;
}

function rewriteFormulaSheetName(formula: string, oldName: string, nextName: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  while (index < formula.length) {
    const char = formula[index];
    if (char === '"') {
      if (inString && formula[index + 1] === '"') {
        result += '""';
        index += 2;
        continue;
      }
      inString = !inString;
      result += char;
      index += 1;
      continue;
    }
    if (!inString) {
      const match = /^(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))!/.exec(formula.slice(index));
      if (match) {
        const referenced = match[1] ?? match[2];
        result += referenced.toUpperCase() === oldName.toUpperCase()
          ? `${formulaSheetName(nextName)}!`
          : match[0];
        index += match[0].length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return result;
}

function rewriteWorkbookFormulas(
  document: SheetDocument,
  rewrite: (formula: string) => string,
): void {
  for (const tabId of document.tabOrder) {
    const worksheet = document.sheets[tabId];
    if (!worksheet) continue;
    for (const [, cell] of getWorksheetEntries(worksheet)) {
      if (cell.f) cell.f = rewrite(cell.f);
    }
  }
}

export function addSheet(
  document: SheetDocument,
  name?: string,
): { document: SheetDocument; tabId: string } {
  const next = structuredClone(validateSheetDocument(document));
  const preferred = name === undefined ? getNextDefaultSheetName(next.tabs) : validatedSheetName(name);
  const sheetName = getUniqueTabName(next.tabs, preferred, getNextDefaultSheetName(next.tabs));
  const tabId = generateTabId();
  next.tabs[tabId] = { id: tabId, name: sheetName, type: "sheet" };
  next.sheets[tabId] = createWorksheet();
  next.tabOrder.push(tabId);
  return { document: next, tabId };
}

export function renameSheet(document: SheetDocument, id: string, name: string): SheetDocument {
  const next = structuredClone(validateSheetDocument(document));
  const tab = next.tabs[id];
  if (!tab || !next.tabOrder.includes(id)) throw new Error(`sheet does not exist: ${id}`);
  const oldName = tab.name;
  const nextName = getUniqueTabName(next.tabs, validatedSheetName(name), "Sheet", id);
  if (nextName === oldName) return next;
  tab.name = nextName;
  rewriteWorkbookFormulas(next, (formula) => rewriteFormulaSheetName(formula, oldName, nextName));
  return validateSheetDocument(next);
}
