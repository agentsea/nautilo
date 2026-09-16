import { recalculateWorkbook } from "./sheet-calculation";
import { parseSheetHtml, serializeSheetHtml } from "./sheet-document";
import {
  mapOfficeCliDumpToSheet,
  mapSheetToOfficeCliBatch,
  type XlsxConversionWarning,
} from "./xlsx-mapper";

const SHA256 = /^[a-f0-9]{64}$/;
const IMPORT_WARNING =
  "Excel import creates an editable copy. Unsupported workbook features may change or be omitted. Review the imported workbook against the original before using the copy.";
const EXPORT_WARNING =
  "Excel export creates a separate copy. Unsupported native Sheets features may change or be omitted. Review the exported workbook in Excel or another spreadsheet viewer.";

type ConversionSurface = "workspace" | "currentFolder";
type ConversionTarget = { surface: ConversionSurface; path: string };
type ReadTarget =
  | { surface: "workspace"; path: string }
  | { surface: "currentFolder"; relativePath: string };

type DocumentReadResult = {
  content: string;
  mimeType: string | null;
  displayPath: string;
  baseSha256: string | null;
  baseRevision: number | null;
  encoding?: "utf8" | "base64";
  byteLength?: number;
};

type CreateResult =
  | { ok: true; artifactPath: string; sha256: string; byteLength: number }
  | {
      ok: false;
      code: string;
      message: string;
      displayPath?: string;
      bytesWritten?: number;
      metadataConfirmed?: false;
      stateChanged?: true;
      retrySafe?: false;
    };

export type XlsxConversionHost = {
  document: {
    read(target: ReadTarget, options?: { encoding?: "utf8" | "base64" }): Promise<DocumentReadResult>;
    createDocument(args: {
      surface: ConversionSurface;
      path: string;
      content: string;
      mimeType?: string;
      colocateWith?: { surface: "workspace"; path: string };
      overwrite?: boolean;
    }): Promise<CreateResult>;
  };
  office: {
    run(args: {
      input?: ConversionTarget;
      readArgv?: string[];
      ops?: unknown[];
      output?: ConversionTarget;
      overwrite?: boolean;
    }): Promise<
      | { ok: true; json?: unknown; sha256?: string; byteLength?: number; displayPath?: string }
      | { ok: false; code: string; message: string }
    >;
  };
};

export type XlsxConversionContext = { nautiloApp: XlsxConversionHost };

type ConversionError = {
  ok: false;
  status: "invalid_request" | "error";
  code: string;
  message: string;
  stateChanged: false | "unknown";
  retrySafe: boolean;
};

function invalid(message: string): ConversionError {
  return {
    ok: false,
    status: "invalid_request",
    code: "invalid_conversion_request",
    message,
    stateChanged: false,
    retrySafe: false,
  };
}

function hostException(error: unknown, writing: boolean): ConversionError {
  return {
    ok: false,
    status: "error",
    code: "conversion_host_failed",
    message: error instanceof Error ? error.message : String(error),
    stateChanged: writing ? "unknown" : false,
    retrySafe: !writing,
  };
}

function failed(code: string, message: string) {
  return { ok: true as const, status: "failed" as const, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function conversionPath(value: unknown, surface: ConversionSurface, field: string): string | ConversionError {
  if (typeof value !== "string" || value.trim().length === 0) return invalid(`${field} must be a non-empty string`);
  const path = value.trim();
  if (hasControlCharacters(path) || path.startsWith("/") || path.startsWith("\\")) {
    return invalid(`${field} must be a safe relative path`);
  }
  if (path.split(/[\\/]/).some((segment) => segment === "..")) return invalid(`${field} must not contain ".." segments`);
  if (surface === "currentFolder" && path.includes("\\")) return invalid(`${field} must use forward slashes`);
  return path;
}

function sourceFrom(value: unknown, operation: string): ConversionTarget | ConversionError {
  if (!isRecord(value)) return invalid("source must be an object");
  if (value.surface !== "workspace" && value.surface !== "currentFolder") {
    return invalid(`source.surface must be "workspace" or "currentFolder" for ${operation}`);
  }
  const path = conversionPath(value.path, value.surface, "source.path");
  return typeof path === "string" ? { surface: value.surface, path } : path;
}

function targetFrom(value: unknown, operation: string): ConversionTarget | ConversionError {
  if (!isRecord(value)) return invalid("target must be an object");
  if (value.surface !== "workspace" && value.surface !== "currentFolder") {
    return invalid(`target.surface must be "workspace" or "currentFolder" for ${operation}`);
  }
  const path = conversionPath(value.path, value.surface, "target.path");
  return typeof path === "string" ? { surface: value.surface, path } : path;
}

function acknowledgmentFrom(value: unknown): string | undefined | ConversionError {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256.test(value)) {
    return invalid("acknowledgedSourceSha256 must come from the conversion preview");
  }
  return value;
}

function readTarget(target: ConversionTarget): ReadTarget {
  return target.surface === "workspace"
    ? { surface: "workspace", path: target.path }
    : { surface: "currentFolder", relativePath: target.path };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  ).toString("hex");
}

async function verifiedSourceBytes(read: DocumentReadResult, binary: boolean): Promise<Uint8Array> {
  if (!read.baseSha256 || !SHA256.test(read.baseSha256)) {
    throw new Error("The source has no exact revision identity.");
  }
  if (binary && read.encoding !== "base64") {
    throw new Error("This server does not provide byte-exact binary document reads.");
  }
  if (!binary && read.encoding !== undefined && read.encoding !== "utf8") {
    throw new Error("This server did not provide UTF-8 native spreadsheet content.");
  }
  const bytes = Buffer.from(read.content, binary ? "base64" : "utf8");
  if (binary && bytes.toString("base64") !== read.content) {
    throw new Error("The binary source is incomplete or incorrectly encoded.");
  }
  if (read.byteLength !== undefined && read.byteLength !== bytes.byteLength) {
    throw new Error("The source byte length does not match the document read receipt.");
  }
  if (await sha256(bytes) !== read.baseSha256) {
    throw new Error("The source bytes do not match their revision identity.");
  }
  return bytes;
}

function warningMessages(warnings: readonly XlsxConversionWarning[]): string[] {
  return warnings.map((entry) => `${entry.path}: ${entry.reason}`);
}

function confirmation(sourceSha256: string, warnings: string[]) {
  return {
    ok: false as const,
    status: "confirmation_required" as const,
    sourceSha256,
    warnings,
    stateChanged: false as const,
    message: "Review conversion differences before creating the copy. Your original file will be kept.",
  };
}

function staleSource() {
  return {
    ok: false as const,
    status: "stale_source" as const,
    stateChanged: false as const,
    retrySafe: true as const,
    message: "The original changed during conversion. Start conversion again to review the latest file.",
  };
}

export async function importXlsx(args: unknown, ctx: XlsxConversionContext) {
  if (!isRecord(args)) return invalid("args must be an object");
  const source = sourceFrom(args.source, "import-xlsx");
  if (!("surface" in source)) return source;
  if (!source.path.toLowerCase().endsWith(".xlsx")) return invalid('source.path must end with ".xlsx"');
  const targetPath = conversionPath(args.targetPath, source.surface, "targetPath");
  if (typeof targetPath !== "string") return targetPath;
  if (!targetPath.toLowerCase().endsWith(".spreadsheet.html")) return invalid('targetPath must end with ".spreadsheet.html"');
  const acknowledgment = acknowledgmentFrom(args.acknowledgedSourceSha256);
  if (isRecord(acknowledgment)) return acknowledgment;

  try {
    const initial = await ctx.nautiloApp.document.read(readTarget(source), { encoding: "base64" });
    await verifiedSourceBytes(initial, true);
    const sourceSha256 = initial.baseSha256!;

    const run = await ctx.nautiloApp.office.run({ input: source, readArgv: ["dump", "/", "--json"] });
    if (!run.ok) return failed(run.code, run.message);

    let mapped;
    try {
      mapped = mapOfficeCliDumpToSheet(run.json as never);
    } catch (error) {
      return failed("XLSX_MAPPING_FAILED", error instanceof Error ? error.message : String(error));
    }
    const conversionWarnings: XlsxConversionWarning[] = [...mapped.skipped];
    let document = mapped.document;
    try {
      document = await recalculateWorkbook(document);
    } catch (error) {
      conversionWarnings.push({
        path: "/",
        feature: "formula-results",
        reason: `Some formula results could not be recalculated: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const warnings = [IMPORT_WARNING, ...warningMessages(conversionWarnings)];
    if (acknowledgment !== sourceSha256) return confirmation(sourceSha256, warnings);

    const latest = await ctx.nautiloApp.document.read(readTarget(source), { encoding: "base64" });
    await verifiedSourceBytes(latest, true);
    if (latest.baseSha256 !== sourceSha256) return staleSource();

    let content: string;
    try {
      content = serializeSheetHtml(document);
    } catch (error) {
      return failed("SERIALIZER_FAILED", error instanceof Error ? error.message : String(error));
    }
    let created: CreateResult;
    try {
      created = await ctx.nautiloApp.document.createDocument({
        surface: source.surface,
        path: targetPath,
        content,
        mimeType: "text/html",
        overwrite: args.overwrite === true,
        ...(source.surface === "workspace"
          ? { colocateWith: { surface: "workspace" as const, path: source.path } }
          : {}),
      });
    } catch (error) {
      return hostException(error, true);
    }
    if (!created.ok) {
      const conflict = created.code === "EXISTS" || created.code === "CONFLICT";
      return {
        ...created,
        status: conflict ? "conflict" as const : "error" as const,
        stateChanged: created.stateChanged ?? (conflict ? false : "unknown"),
        retrySafe: conflict,
        target: { surface: source.surface, path: targetPath },
        warnings,
      };
    }
    return {
      ok: true as const,
      status: "imported" as const,
      artifactPath: created.artifactPath,
      displayPath: created.artifactPath,
      sha256: created.sha256,
      sourceSha256,
      originalPreserved: true,
      sheetCount: document.tabOrder.length,
      skippedCount: conversionWarnings.length,
      warnings,
    };
  } catch (error) {
    return hostException(error, false);
  }
}

export async function exportXlsx(args: unknown, ctx: XlsxConversionContext) {
  if (!isRecord(args)) return invalid("args must be an object");
  const source = sourceFrom(args.source, "export-xlsx");
  if (!("surface" in source)) return source;
  if (!source.path.toLowerCase().endsWith(".spreadsheet.html")) return invalid('source.path must end with ".spreadsheet.html"');
  const target = targetFrom(args.target, "export-xlsx");
  if (!("surface" in target)) return target;
  if (!target.path.toLowerCase().endsWith(".xlsx")) return invalid('target.path must end with ".xlsx"');
  const acknowledgment = acknowledgmentFrom(args.acknowledgedSourceSha256);
  if (isRecord(acknowledgment)) return acknowledgment;

  let writing = false;
  try {
    const initial = await ctx.nautiloApp.document.read(readTarget(source));
    await verifiedSourceBytes(initial, false);
    const sourceSha256 = initial.baseSha256!;
    let document;
    try {
      document = parseSheetHtml(initial.content);
    } catch (error) {
      return failed("PARSER_FAILED", error instanceof Error ? error.message : String(error));
    }
    const mapped = mapSheetToOfficeCliBatch(document);
    const warnings = [EXPORT_WARNING, ...warningMessages(mapped.skipped)];
    if (acknowledgment !== sourceSha256) return confirmation(sourceSha256, warnings);

    const latest = await ctx.nautiloApp.document.read(readTarget(source));
    await verifiedSourceBytes(latest, false);
    if (latest.baseSha256 !== sourceSha256) return staleSource();

    writing = true;
    const run = await ctx.nautiloApp.office.run({
      ops: [...mapped.commands],
      output: target,
      overwrite: args.overwrite === true,
    });
    if (!run.ok) {
      const conflict = run.code === "EXISTS" || run.code === "CONFLICT";
      return {
        ...run,
        status: conflict ? "conflict" as const : "error" as const,
        stateChanged: conflict ? false as const : "unknown" as const,
        retrySafe: conflict,
        target,
        warnings,
      };
    }
    return {
      ok: true as const,
      status: "exported" as const,
      artifactPath: run.displayPath ?? target.path,
      displayPath: run.displayPath ?? target.path,
      sha256: run.sha256 ?? "",
      byteLength: run.byteLength ?? 0,
      sourceSha256,
      originalPreserved: true,
      sheetCount: document.tabOrder.length,
      skippedCount: mapped.skipped.length,
      warnings,
    };
  } catch (error) {
    return hostException(error, writing);
  }
}
