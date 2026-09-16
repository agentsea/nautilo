/**
 * App-owned mapping between OfficeCLI's replayable XLSX dump and the native
 * Sheets document. This module deliberately mirrors the CLI JSON contract
 * rather than importing the server's OfficeCLI implementation.
 */
import {
  cellFromInput,
  createSpreadsheetDocument,
  createWorksheet,
  getWorksheetCell,
  getWorksheetEntries,
  parseRanges,
  parseRef,
  resolveWorksheetCellStyle,
  toSref,
  writeWorksheetCell,
  type Cell,
  type CellStyle,
  type Range,
  type SpreadsheetDocument,
  type Worksheet,
} from "../engine/node.js";

export type OfficeCliDumpEnvelope = {
  readonly success?: boolean;
  readonly message?: string;
  readonly data?: unknown;
  readonly warnings?: unknown[];
};

export type XlsxConversionWarning = {
  readonly path: string;
  readonly feature: string;
  readonly reason: string;
};

export type OfficeCliBatchCommand = {
  readonly command: "add" | "set";
  readonly parent?: string;
  readonly path?: string;
  readonly type?: string;
  readonly props?: Record<string, string>;
};

export type XlsxImportMapResult = {
  readonly document: SpreadsheetDocument;
  readonly skipped: readonly XlsxConversionWarning[];
};

export type XlsxExportMapResult = {
  readonly commands: readonly OfficeCliBatchCommand[];
  readonly skipped: readonly XlsxConversionWarning[];
};

type DumpCommand = {
  command: string;
  path?: string;
  parent?: string;
  type?: string;
  props?: Record<string, string>;
  text?: string;
  dumpVersion?: number;
  unknownFields: string[];
};

const STYLE_PROPS = new Set([
  "font.bold",
  "font.italic",
  "font.color",
  "fill",
  "strike",
  "underline",
  "alignment.horizontal",
  "alignment.vertical",
  "numberformat",
  "border.left",
  "border.right",
  "border.top",
  "border.bottom",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${label}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function parseDumpCommands(envelope: OfficeCliDumpEnvelope): DumpCommand[] {
  if (!isRecord(envelope) || envelope.success !== true) {
    throw new Error(envelope.message || "OfficeCLI did not return a successful XLSX dump");
  }
  if (!Array.isArray(envelope.data)) throw new Error("OfficeCLI XLSX dump data must be an array");
  return envelope.data.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.command !== "string") {
      throw new Error(`OfficeCLI XLSX dump command ${index} is malformed`);
    }
    return {
      command: raw.command,
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      ...(typeof raw.parent === "string" ? { parent: raw.parent } : {}),
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
      ...(raw.props !== undefined ? { props: toStringRecord(raw.props, `command ${index}.props`) } : {}),
      ...(typeof raw.text === "string" ? { text: raw.text } : {}),
      ...(typeof raw.dumpVersion === "number" ? { dumpVersion: raw.dumpVersion } : {}),
      unknownFields: Object.keys(raw).filter((key) => ![
        "command",
        "path",
        "parent",
        "type",
        "props",
        "text",
        "dumpVersion",
      ].includes(key)),
    };
  });
}

function warning(path: string, feature: string, reason: string): XlsxConversionWarning {
  return { path, feature, reason };
}

function uniqueSheetName(document: SpreadsheetDocument, requested: string): string {
  const base = requested.trim() || "Sheet";
  const occupied = new Set(document.tabOrder.map((id) => document.tabs[id].name.toUpperCase()));
  if (!occupied.has(base.toUpperCase())) return base;
  let suffix = 2;
  while (occupied.has(`${base} (${suffix})`.toUpperCase())) suffix += 1;
  return `${base} (${suffix})`;
}

function appendSheet(document: SpreadsheetDocument, requested: string): string {
  const id = `tab-${document.tabOrder.length + 1}`;
  const name = uniqueSheetName(document, requested);
  document.tabs[id] = { id, name, type: "sheet" };
  document.sheets[id] = createWorksheet();
  document.tabOrder.push(id);
  return id;
}

function sheetIdByPath(document: SpreadsheetDocument, path: string): string | undefined {
  const candidate = path.startsWith("/") ? path.slice(1) : path;
  return document.tabOrder.find((id) => document.tabs[id].name === candidate);
}

function sheetAndTail(
  document: SpreadsheetDocument,
  path: string,
): { sheetId: string; sheetPath: string; tail: string } | undefined {
  const matches = document.tabOrder
    .map((sheetId) => ({ sheetId, sheetPath: `/${document.tabs[sheetId].name}` }))
    .filter(({ sheetPath }) => path === sheetPath || path.startsWith(`${sheetPath}/`))
    .sort((left, right) => right.sheetPath.length - left.sheetPath.length);
  const match = matches[0];
  return match ? { ...match, tail: path.slice(match.sheetPath.length + (path === match.sheetPath ? 0 : 1)) } : undefined;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("OfficeCLI XLSX dump contains unterminated CSV quoting");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function columnLabel(column: number): string {
  let label = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

function columnIndex(label: string): number | undefined {
  if (!/^[A-Za-z]+$/.test(label)) return undefined;
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function normalizedColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

function countDecimals(format: string): number {
  const decimal = format.replace(/"[^"]*"/g, "").match(/\.(0+)/);
  return decimal?.[1]?.length ?? 0;
}

function styleFromNumberFormat(format: string): CellStyle {
  const stripped = format.replace(/"[^"]*"/g, "").replace(/\\./g, "");
  if (format === "@") return { nf: "plain" };
  if (/%/.test(stripped)) return { nf: "percent", dp: countDecimals(stripped) };
  if (/[ymdhis]/i.test(stripped.replace(/\[[^\]]*\]/g, ""))) return { nf: "date" };
  const currency = format.match(/[$€£¥₩]/)?.[0];
  if (currency) {
    const currencyCodes: Record<string, string> = {
      "$": "USD",
      "€": "EUR",
      "£": "GBP",
      "¥": "JPY",
      "₩": "KRW",
    };
    return {
      nf: "currency",
      cu: currencyCodes[currency],
      dp: countDecimals(stripped),
    };
  }
  return { nf: "number", dp: countDecimals(stripped) };
}

function mapStyle(
  props: Record<string, string>,
  path: string,
  skipped: XlsxConversionWarning[],
): CellStyle | undefined {
  const style: CellStyle = {};
  const bool = (prop: string, key: keyof Pick<CellStyle, "b" | "i" | "u" | "st" | "bt" | "br" | "bb" | "bl">) => {
    if (props[prop] === undefined) return;
    const parsed = parseBoolean(props[prop]);
    if (parsed === undefined) skipped.push(warning(path, prop, `Unsupported boolean value ${JSON.stringify(props[prop])}.`));
    else style[key] = parsed;
  };
  bool("font.bold", "b");
  bool("font.italic", "i");
  bool("strike", "st");
  if (props.underline !== undefined) style.u = props.underline !== "none";
  const textColor = props["font.color"] === undefined ? undefined : normalizedColor(props["font.color"]);
  if (props["font.color"] !== undefined && !textColor) skipped.push(warning(path, "font.color", "Theme, tinted, or malformed font colors are not representable in native Sheets."));
  else if (textColor) style.tc = textColor;
  const fill = props.fill === undefined ? undefined : normalizedColor(props.fill);
  if (props.fill !== undefined && !fill) skipped.push(warning(path, "fill", "Gradient, pattern, theme, or malformed fills are not representable in native Sheets."));
  else if (fill) style.bg = fill;
  if (props["alignment.horizontal"] !== undefined) {
    const align = props["alignment.horizontal"];
    if (align === "left" || align === "center" || align === "right") style.al = align;
    else skipped.push(warning(path, "alignment.horizontal", `${align} alignment is not representable in native Sheets.`));
  }
  if (props["alignment.vertical"] !== undefined) {
    const align = props["alignment.vertical"];
    if (align === "top" || align === "bottom") style.va = align;
    else if (align === "center") style.va = "middle";
    else skipped.push(warning(path, "alignment.vertical", `${align} alignment is not representable in native Sheets.`));
  }
  if (props.numberformat !== undefined) Object.assign(style, styleFromNumberFormat(props.numberformat));
  for (const [prop, key] of [["border.left", "bl"], ["border.right", "br"], ["border.top", "bt"], ["border.bottom", "bb"]] as const) {
    if (props[prop] !== undefined) style[key] = props[prop] !== "none";
  }
  for (const prop of Object.keys(props)) {
    if (STYLE_PROPS.has(prop) || prop === "value" || prop === "formula" || prop === "type" || prop === "merge") continue;
    skipped.push(warning(path, prop, `OfficeCLI XLSX property ${prop} is not representable in native Sheets.`));
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

const EXCEL_UNIX_EPOCH_DAYS = 25569;
const DATE_1904_OFFSET_DAYS = 1462;
const MS_PER_DAY = 86_400_000;

function excelSerialToDateString(serial: number, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial)) return undefined;
  const epochDays = date1904 ? EXCEL_UNIX_EPOCH_DAYS - DATE_1904_OFFSET_DAYS : EXCEL_UNIX_EPOCH_DAYS;
  const date = new Date(Math.round((serial - epochDays) * MS_PER_DAY));
  if (Number.isNaN(date.getTime())) return undefined;
  const hms = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  if (serial >= 0 && serial < 1) return hms;
  const ymd = `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return serial % 1 === 0 ? ymd : `${ymd} ${hms}`;
}

function convertDatesInRange(sheet: Worksheet, range: Range, date1904: boolean): void {
  for (const [sref, cell] of getWorksheetEntries(sheet)) {
    const ref = parseRef(sref);
    if (ref.r < range[0].r || ref.r > range[1].r || ref.c < range[0].c || ref.c > range[1].c || cell.f || cell.v === undefined) continue;
    const serial = Number(cell.v);
    const converted = excelSerialToDateString(serial, date1904);
    if (converted) cell.v = converted;
  }
}

function applyStyle(sheet: Worksheet, range: Range, style: CellStyle, date1904: boolean): void {
  sheet.rangeStyles ??= [];
  sheet.rangeStyles.push({ range, style });
  if (style.nf === "date") convertDatesInRange(sheet, range, date1904);
}

function addMerge(sheet: Worksheet, rangeText: string): void {
  for (const range of parseRanges(rangeText)) {
    const from = { r: Math.min(range[0].r, range[1].r), c: Math.min(range[0].c, range[1].c) };
    const to = { r: Math.max(range[0].r, range[1].r), c: Math.max(range[0].c, range[1].c) };
    if (from.r === to.r && from.c === to.c) continue;
    sheet.merges ??= {};
    sheet.merges[toSref(from)] = { rs: to.r - from.r + 1, cs: to.c - from.c + 1 };
  }
}

function importCsv(sheet: Worksheet, text: string, startCell: string): void {
  const start = parseRef(startCell);
  for (const [rowOffset, row] of parseCsv(text).entries()) {
    for (const [columnOffset, raw] of row.entries()) {
      if (raw === "") continue;
      writeWorksheetCell(sheet, { r: start.r + rowOffset, c: start.c + columnOffset }, cellFromInput(raw));
    }
  }
}

function applyAutoFilterProps(
  sheet: Worksheet,
  path: string,
  props: Record<string, string>,
  skipped: XlsxConversionWarning[],
): void {
  const range = props.range ? parseRanges(props.range)[0] : undefined;
  if (!range) {
    skipped.push(warning(path, "autofilter", "The OfficeCLI AutoFilter did not include a usable range."));
    return;
  }
  const columns: NonNullable<Worksheet["filter"]>["columns"] = {};
  const operators = {
    equals: "equals",
    notEquals: "notEquals",
    contains: "contains",
    doesNotContain: "notContains",
    blanks: "isEmpty",
    nonBlanks: "isNotEmpty",
    values: "in",
  } as const;
  for (const [key, value] of Object.entries(props)) {
    if (key === "range") continue;
    const match = /^criteria(\d+)\.([A-Za-z]+)$/.exec(key);
    const operation = match ? operators[match[2] as keyof typeof operators] : undefined;
    if (!match || !operation) {
      skipped.push(warning(path, key, `Excel filter criterion ${key} is not representable in native Sheets.`));
      continue;
    }
    const column = range[0].c + Number(match[1]);
    columns[String(column)] = operation === "in"
      ? { op: operation, values: value.split(",") }
      : operation === "isEmpty" || operation === "isNotEmpty"
        ? { op: operation }
        : { op: operation, value };
  }
  sheet.filter = {
    startRow: range[0].r,
    endRow: range[1].r,
    startCol: range[0].c,
    endCol: range[1].c,
    columns,
    hiddenRows: [],
  };
}

function applyCellOrRangeSet(
  sheet: Worksheet,
  path: string,
  tail: string,
  props: Record<string, string>,
  date1904: boolean,
  skipped: XlsxConversionWarning[],
): void {
  const ranges = parseRanges(tail);
  if (ranges.length !== 1) throw new Error(`OfficeCLI XLSX path is not one cell or range: ${path}`);
  const range = ranges[0];
  if (range[0].r === range[1].r && range[0].c === range[1].c && (props.value !== undefined || props.formula !== undefined)) {
    const current = getWorksheetCell(sheet, range[0]);
    let cell: Cell = current ? { ...current } : {};
    if (props.formula !== undefined) {
      cell.f = props.formula.startsWith("=") ? props.formula : `=${props.formula}`;
      delete cell.v;
    } else if (props.value !== undefined) {
      cell = props.type?.toLowerCase() === "string" ? { v: props.value } : cellFromInput(props.value);
    }
    const style = mapStyle(props, path, skipped);
    if (style) cell.s = { ...(cell.s ?? {}), ...style };
    if (cell.s?.nf === "date" && !cell.f && cell.v !== undefined) {
      const converted = excelSerialToDateString(Number(cell.v), date1904);
      if (converted) cell.v = converted;
    }
    writeWorksheetCell(sheet, range[0], cell);
  } else {
    const style = mapStyle(props, path, skipped);
    if (style) applyStyle(sheet, range, style, date1904);
  }
  if (props.merge) addMerge(sheet, props.merge);
}

export function mapOfficeCliDumpToSheet(envelope: OfficeCliDumpEnvelope): XlsxImportMapResult {
  const commands = parseDumpCommands(envelope);
  const document = createSpreadsheetDocument();
  const skipped: XlsxConversionWarning[] = Array.isArray(envelope.warnings)
    ? envelope.warnings.map((entry, index) => warning(
      "/",
      `officecli-warning-${index + 1}`,
      typeof entry === "string" ? entry : JSON.stringify(entry) ?? String(entry),
    ))
    : [];
  let date1904 = false;
  let sawMeta = false;

  for (const command of commands) {
    const path = command.path ?? command.parent ?? "/";
    for (const field of command.unknownFields) {
      skipped.push(warning(path, field, `OfficeCLI XLSX dump field ${field} is not understood by this importer.`));
    }
    if (command.command === "meta") {
      sawMeta = true;
      if (command.dumpVersion !== 2) skipped.push(warning("/", "dumpVersion", `OfficeCLI dump version ${String(command.dumpVersion)} has not been qualified.`));
      continue;
    }
    if (command.command === "set" && command.path === "/") {
      for (const [key, value] of Object.entries(command.props ?? {})) {
        if (key === "workbook.date1904") {
          const parsed = parseBoolean(value);
          if (parsed === undefined) skipped.push(warning("/", key, `Unsupported boolean value ${JSON.stringify(value)}.`));
          else date1904 = parsed;
        }
        else skipped.push(warning("/", key, `Workbook property ${key} is not represented by native Sheets.`));
      }
      continue;
    }
    if (command.command === "set" && /^\/sheet\[1\]$/.test(command.path ?? "")) {
      const name = command.props?.name?.trim();
      if (name) document.tabs[document.tabOrder[0]].name = name;
      for (const key of Object.keys(command.props ?? {})) {
        if (key !== "name") skipped.push(warning(command.path!, key, `Sheet property ${key} is not represented by native Sheets.`));
      }
      continue;
    }
    if (command.command === "add" && command.parent === "/" && command.type === "sheet") {
      const id = appendSheet(document, command.props?.name ?? "Sheet");
      for (const key of Object.keys(command.props ?? {})) {
        if (key !== "name") skipped.push(warning(`/${document.tabs[id].name}`, key, `Sheet property ${key} is not represented by native Sheets.`));
      }
      continue;
    }
    if (command.command === "add" && command.parent && command.type?.toLowerCase() === "autofilter") {
      const sheetId = sheetIdByPath(document, command.parent);
      if (!sheetId) skipped.push(warning(command.parent, "autofilter", "The AutoFilter targeted an unknown sheet."));
      else applyAutoFilterProps(document.sheets[sheetId], `${command.parent}/autofilter`, command.props ?? {}, skipped);
      continue;
    }
    if (command.command === "import" && command.parent && typeof command.text === "string") {
      const sheetId = sheetIdByPath(document, command.parent);
      if (!sheetId) {
        skipped.push(warning(command.parent, "sheet", "CSV payload targeted a sheet that was not present in the dump."));
        continue;
      }
      importCsv(document.sheets[sheetId], command.text, command.props?.["start-cell"] ?? "A1");
      for (const key of Object.keys(command.props ?? {})) {
        if (key !== "start-cell") skipped.push(warning(command.parent, key, `OfficeCLI CSV import property ${key} is not represented by native Sheets.`));
      }
      continue;
    }
    if (command.command === "set" && command.path) {
      const located = sheetAndTail(document, command.path);
      if (!located) {
        skipped.push(warning(command.path, "path", "The dump command targeted an unknown sheet or workbook path."));
        continue;
      }
      const sheet = document.sheets[located.sheetId];
      const props = command.props ?? {};
      if (located.tail === "") {
        if (props.merge) addMerge(sheet, props.merge);
        if (props.freeze && props.freeze !== "none" && props.freeze !== "false") {
          const anchor = parseRef(props.freeze);
          sheet.frozenRows = Math.max(0, anchor.r - 1);
          sheet.frozenCols = Math.max(0, anchor.c - 1);
        }
        if (props.autoFilter && props.autoFilter !== "false" && props.autoFilter !== "none") {
          const range = parseRanges(props.autoFilter)[0];
          if (range) sheet.filter = {
            startRow: range[0].r,
            endRow: range[1].r,
            startCol: range[0].c,
            endCol: range[1].c,
            columns: {},
            hiddenRows: [],
          };
        }
        for (const key of Object.keys(props)) {
          if (key !== "merge" && key !== "freeze" && key !== "autoFilter") skipped.push(warning(command.path, key, `Sheet property ${key} is not represented by native Sheets.`));
        }
      } else {
        const row = /^row\[(\d+)\]$/.exec(located.tail);
        const column = /^col\[([^\]]+)\]$/.exec(located.tail);
        if (row) {
          const index = Number(row[1]);
          if (props.height !== undefined) {
            const points = Number(props.height.replace(/pt$/i, ""));
            if (Number.isFinite(points)) sheet.rowHeights[String(index)] = Math.round((points * 96) / 72);
            else skipped.push(warning(command.path, "height", `Row height ${JSON.stringify(props.height)} is not usable.`));
          }
          if (props.hidden !== undefined) {
            const hidden = parseBoolean(props.hidden);
            if (hidden === true) (sheet.hiddenRows ??= []).push(index);
            else if (hidden === undefined) skipped.push(warning(command.path, "hidden", `Unsupported boolean value ${JSON.stringify(props.hidden)}.`));
          }
          for (const key of Object.keys(props)) if (key !== "height" && key !== "hidden") skipped.push(warning(command.path, key, `Row property ${key} is not represented by native Sheets.`));
        } else if (column) {
          const index = columnIndex(column[1]);
          if (!index) throw new Error(`OfficeCLI XLSX column path is malformed: ${command.path}`);
          if (props.width !== undefined) {
            const width = Number(props.width);
            if (Number.isFinite(width)) sheet.colWidths[String(index)] = Math.round(width * 7 + 5);
            else skipped.push(warning(command.path, "width", `Column width ${JSON.stringify(props.width)} is not usable.`));
          }
          if (props.hidden !== undefined) {
            const hidden = parseBoolean(props.hidden);
            if (hidden === true) (sheet.hiddenColumns ??= []).push(index);
            else if (hidden === undefined) skipped.push(warning(command.path, "hidden", `Unsupported boolean value ${JSON.stringify(props.hidden)}.`));
          }
          if (props.numberformat !== undefined) sheet.colStyles[String(index)] = styleFromNumberFormat(props.numberformat);
          for (const key of Object.keys(props)) if (key !== "width" && key !== "hidden" && key !== "numberformat") skipped.push(warning(command.path, key, `Column property ${key} is not represented by native Sheets.`));
        } else if (located.tail === "autofilter") {
          applyAutoFilterProps(sheet, command.path, props, skipped);
        } else applyCellOrRangeSet(sheet, command.path, located.tail, props, date1904, skipped);
      }
      continue;
    }
    skipped.push(warning(path, command.type ?? command.command, `OfficeCLI XLSX ${command.command} ${command.type ?? "command"} is not supported by native Sheets conversion.`));
  }
  if (!sawMeta) throw new Error("OfficeCLI XLSX dump is missing its version marker");
  return { document, skipped };
}

function escapeSheetPath(name: string): string {
  return `/${name}`;
}

function formatCode(style: CellStyle): string | undefined {
  if (style.nf === "plain") return "@";
  if (style.nf === "date") return "yyyy-mm-dd";
  const decimal = style.dp && style.dp > 0 ? `.${"0".repeat(style.dp)}` : "";
  if (style.nf === "percent") return `0${decimal}%`;
  if (style.nf === "currency") {
    const symbol = ({ USD: "$", EUR: "€", GBP: "£", JPY: "¥", KRW: "₩" } as Record<string, string>)[style.cu ?? "USD"] ?? `${style.cu ?? "USD"} `;
    return `${symbol}#,##0${decimal}`;
  }
  if (style.nf === "number") return `#,##0${decimal}`;
  return undefined;
}

function propsFromStyle(style: CellStyle): Record<string, string> {
  const props: Record<string, string> = {};
  if (style.b !== undefined) props["font.bold"] = String(style.b);
  if (style.i !== undefined) props["font.italic"] = String(style.i);
  if (style.u !== undefined) props.underline = style.u ? "single" : "none";
  if (style.st !== undefined) props.strike = String(style.st);
  if (style.tc !== undefined) props["font.color"] = style.tc;
  if (style.bg !== undefined) props.fill = style.bg;
  if (style.al !== undefined) props["alignment.horizontal"] = style.al;
  if (style.va !== undefined) props["alignment.vertical"] = style.va === "middle" ? "center" : style.va;
  const numberformat = formatCode(style);
  if (numberformat) props.numberformat = numberformat;
  if (style.bl !== undefined) props["border.left"] = style.bl ? "thin" : "none";
  if (style.br !== undefined) props["border.right"] = style.br ? "thin" : "none";
  if (style.bt !== undefined) props["border.top"] = style.bt ? "thin" : "none";
  if (style.bb !== undefined) props["border.bottom"] = style.bb ? "thin" : "none";
  return props;
}

function isNumeric(value: string): boolean {
  return /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value) && !/^[-+]?0\d/.test(value);
}

function cellContentProps(cell: Cell, effectiveStyle: CellStyle | undefined): Record<string, string> {
  if (cell.f) return { formula: cell.f.startsWith("=") ? cell.f.slice(1) : cell.f };
  if (cell.v === undefined) return {};
  if (cell.v === "TRUE" || cell.v === "FALSE") return { value: cell.v, type: "boolean" };
  if (effectiveStyle?.nf === "date") return { value: cell.v, type: "date" };
  if (isNumeric(cell.v)) return { value: cell.v, type: "number" };
  return { value: cell.v, type: "string" };
}

function rangeText(range: Range): string {
  return toSref(range[0]) === toSref(range[1]) ? toSref(range[0]) : `${toSref(range[0])}:${toSref(range[1])}`;
}

function mergeText(sheet: Worksheet): string | undefined {
  const ranges = Object.entries(sheet.merges ?? {}).map(([anchor, span]) => {
    const start = parseRef(anchor);
    return `${anchor}:${toSref({ r: start.r + span.rs - 1, c: start.c + span.cs - 1 })}`;
  });
  return ranges.length > 0 ? ranges.join(",") : undefined;
}

function filterProps(sheet: Worksheet): Record<string, string> | undefined {
  const filter = sheet.filter;
  if (!filter) return undefined;
  const props: Record<string, string> = {
    range: `${columnLabel(filter.startCol)}${filter.startRow}:${columnLabel(filter.endCol)}${filter.endRow}`,
  };
  const operator = {
    equals: "equals",
    notEquals: "notEquals",
    contains: "contains",
    notContains: "doesNotContain",
    isEmpty: "blanks",
    isNotEmpty: "nonBlanks",
    in: "values",
  } as const;
  for (const [column, condition] of Object.entries(filter.columns)) {
    const offset = Number(column) - filter.startCol;
    if (!Number.isSafeInteger(offset) || offset < 0) continue;
    const op = operator[condition.op];
    const value = condition.op === "in" ? (condition.values ?? []).join(",") : condition.value ?? "true";
    props[`criteria${offset}.${op}`] = value;
  }
  return props;
}

export function mapSheetToOfficeCliBatch(document: SpreadsheetDocument): XlsxExportMapResult {
  const commands: OfficeCliBatchCommand[] = [];
  const skipped: XlsxConversionWarning[] = [];

  document.tabOrder.forEach((sheetId, sheetIndex) => {
    const tab = document.tabs[sheetId];
    const sheet = document.sheets[sheetId];
    const sheetPath = escapeSheetPath(tab.name);
    if (sheetIndex === 0) commands.push({ command: "set", path: "/sheet[1]", props: { name: tab.name } });
    else commands.push({ command: "add", parent: "/", type: "sheet", props: { name: tab.name } });
    if (tab.type !== "sheet") skipped.push(warning(sheetPath, tab.type, `The ${tab.type} tab is exported as its cached cells; its source semantics are not representable in XLSX.`));

    for (const [sref, cell] of getWorksheetEntries(sheet)) {
      const ref = parseRef(sref);
      const props = { ...cellContentProps(cell, resolveWorksheetCellStyle(sheet, ref, cell.s)), ...(cell.s ? propsFromStyle(cell.s) : {}) };
      if (Object.keys(props).length > 0) commands.push({ command: "set", path: `${sheetPath}/${sref}`, props });
      for (const feature of ["spillRows", "spillCols", "spillAnchor", "spillBlocked"] as const) {
        if (cell[feature] !== undefined) skipped.push(warning(`${sheetPath}/${sref}`, feature, `Dynamic-array metadata ${feature} is not directly representable by this XLSX exporter.`));
      }
    }
    if (sheet.sheetStyle && Object.keys(propsFromStyle(sheet.sheetStyle)).length > 0) {
      skipped.push(warning(sheetPath, "sheetStyle", "A whole-sheet style cannot be expressed without expanding it across Excel's full grid."));
    }
    for (const [index, style] of Object.entries(sheet.colStyles)) {
      const props = propsFromStyle(style);
      const numberformat = props.numberformat;
      if (numberformat) commands.push({ command: "set", path: `${sheetPath}/col[${columnLabel(Number(index))}]`, props: { numberformat } });
      if (Object.keys(props).some((key) => key !== "numberformat")) skipped.push(warning(`${sheetPath}/col[${columnLabel(Number(index))}]`, "columnStyle", "Excel column conversion supports the native number format but not other whole-column styles."));
    }
    for (const [index, style] of Object.entries(sheet.rowStyles)) {
      if (Object.keys(style).length > 0) skipped.push(warning(`${sheetPath}/row[${index}]`, "rowStyle", "Whole-row native styles are not represented by OfficeCLI XLSX row properties."));
    }
    for (const patch of sheet.rangeStyles ?? []) {
      const props = propsFromStyle(patch.style);
      if (Object.keys(props).length > 0) commands.push({ command: "set", path: `${sheetPath}/${rangeText(patch.range)}`, props });
    }
    for (const [index, pixels] of Object.entries(sheet.rowHeights)) {
      commands.push({ command: "set", path: `${sheetPath}/row[${index}]`, props: { height: `${pixels * 72 / 96}pt` } });
    }
    for (const [index, pixels] of Object.entries(sheet.colWidths)) {
      commands.push({ command: "set", path: `${sheetPath}/col[${columnLabel(Number(index))}]`, props: { width: String(Math.max(0, (pixels - 5) / 7)) } });
    }
    for (const index of sheet.hiddenRows ?? []) commands.push({ command: "set", path: `${sheetPath}/row[${index}]`, props: { hidden: "true" } });
    for (const index of sheet.hiddenColumns ?? []) commands.push({ command: "set", path: `${sheetPath}/col[${columnLabel(index)}]`, props: { hidden: "true" } });
    const merge = mergeText(sheet);
    if (merge) commands.push({ command: "set", path: sheetPath, props: { merge } });
    if (sheet.frozenRows > 0 || sheet.frozenCols > 0) {
      commands.push({ command: "set", path: sheetPath, props: { freeze: `${columnLabel(sheet.frozenCols + 1)}${sheet.frozenRows + 1}` } });
    }
    const autoFilter = filterProps(sheet);
    if (autoFilter) commands.push({ command: "add", parent: sheetPath, type: "autofilter", props: autoFilter });

    for (const [feature, value] of [
      ["conditionalFormats", sheet.conditionalFormats],
      ["dataValidations", sheet.dataValidations],
      ["charts", sheet.charts],
      ["images", sheet.images],
      ["comments", sheet.comments],
      ["pivotTable", sheet.pivotTable],
    ] as const) {
      const present = Array.isArray(value) ? value.length > 0 : Boolean(value && Object.keys(value).length > 0);
      if (present) skipped.push(warning(sheetPath, feature, `Native Sheets ${feature} is not supported by this XLSX conversion and was omitted.`));
    }
  });
  return { commands, skipped };
}
