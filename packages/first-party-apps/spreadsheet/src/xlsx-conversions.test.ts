import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { getWorksheetCell, parseRef, writeWorksheetCell } from "../engine/node.js";
import { createSheetDocument, parseSheetHtml, serializeSheetHtml } from "./sheet-document";
import { exportXlsx, importXlsx, type XlsxConversionHost } from "./xlsx-conversions";

const dumpEnvelope = {
  success: true,
  data: [
    { command: "meta", dumpVersion: 2 },
    { command: "set", path: "/sheet[1]", props: { name: "Imported" } },
    { command: "import", parent: "/Imported", props: { "start-cell": "A1" }, text: "Value,Formula\n21,=A2*2\n" },
    { command: "add", parent: "/Imported", type: "picture", props: { name: "unsupported" } },
  ],
};

function nativeHtml(withUnsupported = false): string {
  const document = createSheetDocument();
  writeWorksheetCell(document.sheets["tab-1"], parseRef("A1"), { v: "Export me", s: { b: true } });
  if (withUnsupported) document.sheets["tab-1"].charts = { chart1: {} as never };
  return serializeSheetHtml(document);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type FixtureOptions = {
  source?: Uint8Array;
  raceOnSecondRead?: boolean;
  reportedSha256?: string | null;
  createDocument?: XlsxConversionHost["document"]["createDocument"];
  run?: XlsxConversionHost["office"]["run"];
};

function hostFixture(options: FixtureOptions = {}) {
  const source = Buffer.from(options.source ?? Buffer.from(nativeHtml()));
  const changed = Buffer.concat([source, Buffer.from(" changed")]);
  const createArgs: Array<Parameters<XlsxConversionHost["document"]["createDocument"]>[0]> = [];
  const runArgs: Array<Parameters<XlsxConversionHost["office"]["run"]>[0]> = [];
  const readCalls: Array<{
    target: Parameters<XlsxConversionHost["document"]["read"]>[0];
    options: Parameters<XlsxConversionHost["document"]["read"]>[1];
  }> = [];
  const host: XlsxConversionHost = {
    document: {
      read: async (target, readOptions) => {
        readCalls.push({ target, options: readOptions });
        const bytes = options.raceOnSecondRead && readCalls.length >= 2 ? changed : source;
        const binary = readOptions?.encoding === "base64";
        return {
          content: bytes.toString(binary ? "base64" : "utf8"),
          mimeType: binary
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "text/html",
          displayPath: "Book",
          baseSha256: Object.hasOwn(options, "reportedSha256")
            ? options.reportedSha256 ?? null
            : digest(bytes),
          baseRevision: 1,
          encoding: binary ? "base64" : "utf8",
          byteLength: bytes.byteLength,
        };
      },
      createDocument: async (args) => {
        createArgs.push(args);
        return options.createDocument
          ? options.createDocument(args)
          : { ok: true, artifactPath: args.path, sha256: "created-sha", byteLength: args.content.length };
      },
    },
    office: {
      run: async (args) => {
        runArgs.push(args);
        if (options.run) return options.run(args);
        return args.input
          ? { ok: true, json: dumpEnvelope }
          : { ok: true, displayPath: args.output?.path, sha256: "xlsx-sha", byteLength: 2048 };
      },
    },
  };
  return {
    host,
    sourceSha256: digest(source),
    createArgs,
    runArgs,
    readCalls,
  };
}

const workspaceImport = {
  source: { surface: "workspace" as const, path: "finance/Book.xlsx" },
  targetPath: "finance/Book.spreadsheet.html",
};
const workspaceExport = {
  source: { surface: "workspace" as const, path: "Book.spreadsheet.html" },
  target: { surface: "workspace" as const, path: "Book.xlsx" },
};

describe("Sheets import-xlsx / export-xlsx", () => {
  test("previews import warnings without writing, then imports the acknowledged exact source", async () => {
    const fixture = hostFixture({ source: Buffer.from("PK\u0003\u0004xlsx fixture") });
    const preview = await importXlsx(workspaceImport, { nautiloApp: fixture.host });
    expect(preview).toMatchObject({
      ok: false,
      status: "confirmation_required",
      sourceSha256: fixture.sourceSha256,
      stateChanged: false,
    });
    expect("warnings" in preview && preview.warnings).toEqual([
      expect.stringContaining("Excel import creates an editable copy"),
      expect.stringContaining("picture is not supported"),
    ]);
    expect(fixture.createArgs).toHaveLength(0);
    expect(fixture.readCalls[0]).toEqual({
      target: { surface: "workspace", path: "finance/Book.xlsx" },
      options: { encoding: "base64" },
    });

    const result = await importXlsx({
      ...workspaceImport,
      acknowledgedSourceSha256: fixture.sourceSha256,
    }, { nautiloApp: fixture.host });
    expect(result).toMatchObject({
      ok: true,
      status: "imported",
      sourceSha256: fixture.sourceSha256,
      originalPreserved: true,
      artifactPath: "finance/Book.spreadsheet.html",
      sheetCount: 1,
      skippedCount: 1,
    });
    expect(fixture.runArgs.at(-1)).toEqual({
      input: { surface: "workspace", path: "finance/Book.xlsx" },
      readArgv: ["dump", "/", "--json"],
    });
    expect(fixture.createArgs[0]).toMatchObject({
      surface: "workspace",
      path: "finance/Book.spreadsheet.html",
      mimeType: "text/html",
      colocateWith: { surface: "workspace", path: "finance/Book.xlsx" },
      overwrite: false,
    });
    const parsed = parseSheetHtml(fixture.createArgs[0].content);
    expect(parsed.tabs["tab-1"]?.name).toBe("Imported");
    expect(getWorksheetCell(parsed.sheets["tab-1"], parseRef("B2"))).toMatchObject({
      f: "=A2*2",
      v: "42",
    });
  });

  test("previews export warnings without calling the writing office route, then exports after acknowledgment", async () => {
    const fixture = hostFixture({ source: Buffer.from(nativeHtml(true)) });
    const preview = await exportXlsx(workspaceExport, { nautiloApp: fixture.host });
    expect(preview).toMatchObject({
      ok: false,
      status: "confirmation_required",
      sourceSha256: fixture.sourceSha256,
    });
    expect("warnings" in preview && preview.warnings).toEqual([
      expect.stringContaining("Excel export creates a separate copy"),
      expect.stringContaining("charts is not supported"),
    ]);
    expect(fixture.runArgs).toHaveLength(0);

    const result = await exportXlsx({
      ...workspaceExport,
      acknowledgedSourceSha256: fixture.sourceSha256,
      overwrite: true,
    }, { nautiloApp: fixture.host });
    expect(result).toMatchObject({
      ok: true,
      status: "exported",
      displayPath: "Book.xlsx",
      byteLength: 2048,
      sourceSha256: fixture.sourceSha256,
      originalPreserved: true,
      skippedCount: 1,
    });
    expect(fixture.runArgs.at(-1)).toMatchObject({
      output: { surface: "workspace", path: "Book.xlsx" },
      overwrite: true,
    });
    expect(fixture.runArgs.at(-1)?.ops).toContainEqual({
      command: "set",
      path: "/Sheet1/A1",
      props: { value: "Export me", type: "string", "font.bold": "true" },
    });
  });

  test("uses exact Current Folder reads for both directions", async () => {
    const imported = hostFixture({ source: Buffer.from("PK\u0003\u0004local xlsx") });
    await importXlsx({
      source: { surface: "currentFolder", path: "incoming/Book.xlsx" },
      targetPath: "incoming/Book.spreadsheet.html",
      overwrite: true,
      acknowledgedSourceSha256: imported.sourceSha256,
    }, { nautiloApp: imported.host });
    expect(imported.readCalls.map((call) => call.target)).toEqual([
      { surface: "currentFolder", relativePath: "incoming/Book.xlsx" },
      { surface: "currentFolder", relativePath: "incoming/Book.xlsx" },
    ]);
    expect(imported.createArgs[0]).toMatchObject({ surface: "currentFolder", overwrite: true });
    expect(imported.createArgs[0]?.colocateWith).toBeUndefined();

    const exported = hostFixture();
    await exportXlsx({
      source: { surface: "currentFolder", path: "Book.spreadsheet.html" },
      target: { surface: "currentFolder", path: "Book.xlsx" },
      acknowledgedSourceSha256: exported.sourceSha256,
    }, { nautiloApp: exported.host });
    expect(exported.readCalls.map((call) => call.target)).toEqual([
      { surface: "currentFolder", relativePath: "Book.spreadsheet.html" },
      { surface: "currentFolder", relativePath: "Book.spreadsheet.html" },
    ]);
  });

  test("rejects a stale source after acknowledgment before either output write", async () => {
    const imported = hostFixture({
      source: Buffer.from("PK\u0003\u0004racing xlsx"),
      raceOnSecondRead: true,
    });
    expect(await importXlsx({
      ...workspaceImport,
      acknowledgedSourceSha256: imported.sourceSha256,
    }, { nautiloApp: imported.host })).toMatchObject({
      ok: false,
      status: "stale_source",
      stateChanged: false,
      retrySafe: true,
    });
    expect(imported.createArgs).toHaveLength(0);

    const exported = hostFixture({ raceOnSecondRead: true });
    expect(await exportXlsx({
      ...workspaceExport,
      acknowledgedSourceSha256: exported.sourceSha256,
    }, { nautiloApp: exported.host })).toMatchObject({
      ok: false,
      status: "stale_source",
      stateChanged: false,
      retrySafe: true,
    });
    expect(exported.runArgs).toHaveLength(0);
  });

  test("returns conflicts only after warning acknowledgment and preserves warnings", async () => {
    const imported = hostFixture({
      source: Buffer.from("PK\u0003\u0004conflict xlsx"),
      createDocument: async () => ({ ok: false, code: "EXISTS", message: "already exists" }),
    });
    const importResult = await importXlsx({
      ...workspaceImport,
      acknowledgedSourceSha256: imported.sourceSha256,
    }, { nautiloApp: imported.host });
    expect(importResult).toMatchObject({
      ok: false,
      status: "conflict",
      target: { surface: "workspace", path: "finance/Book.spreadsheet.html" },
      stateChanged: false,
      retrySafe: true,
    });
    expect("warnings" in importResult && importResult.warnings.length).toBeGreaterThan(1);

    const exported = hostFixture({
      run: async () => ({ ok: false, code: "CONFLICT", message: "already exists" }),
    });
    const exportResult = await exportXlsx({
      ...workspaceExport,
      acknowledgedSourceSha256: exported.sourceSha256,
    }, { nautiloApp: exported.host });
    expect(exportResult).toMatchObject({
      ok: false,
      status: "conflict",
      target: workspaceExport.target,
      stateChanged: false,
      retrySafe: true,
    });
    expect("warnings" in exportResult && exportResult.warnings.length).toBeGreaterThan(0);
  });

  test("rejects malformed acknowledgments before reading or converting", async () => {
    const imported = hostFixture({ source: Buffer.from("PK\u0003\u0004bad ack") });
    expect(await importXlsx({
      ...workspaceImport,
      acknowledgedSourceSha256: "yes",
    }, { nautiloApp: imported.host })).toMatchObject({
      ok: false,
      status: "invalid_request",
      code: "invalid_conversion_request",
    });
    const exported = hostFixture();
    expect(await exportXlsx({
      ...workspaceExport,
      acknowledgedSourceSha256: "A".repeat(64),
    }, { nautiloApp: exported.host })).toMatchObject({
      ok: false,
      status: "invalid_request",
    });
    expect(imported.readCalls).toHaveLength(0);
    expect(imported.runArgs).toHaveLength(0);
    expect(exported.readCalls).toHaveLength(0);
    expect(exported.runArgs).toHaveLength(0);
  });

  test("a well-formed acknowledgment for an older revision prompts for the current source", async () => {
    const fixture = hostFixture();
    const result = await exportXlsx({
      ...workspaceExport,
      acknowledgedSourceSha256: "e".repeat(64),
    }, { nautiloApp: fixture.host });
    expect(result).toMatchObject({
      status: "confirmation_required",
      sourceSha256: fixture.sourceSha256,
      stateChanged: false,
    });
    expect(fixture.runArgs).toHaveLength(0);
  });

  test("refuses a binary source whose bytes do not match its claimed revision", async () => {
    const fixture = hostFixture({
      source: Buffer.from("PK\u0003\u0004mismatched receipt"),
      reportedSha256: "f".repeat(64),
    });
    expect(await importXlsx(workspaceImport, { nautiloApp: fixture.host })).toMatchObject({
      ok: false,
      status: "error",
      stateChanged: false,
      retrySafe: true,
      message: "The source bytes do not match their revision identity.",
    });
    expect(fixture.runArgs).toHaveLength(0);
    expect(fixture.createArgs).toHaveLength(0);
  });

  test("rejects malformed paths and surfaces OfficeCLI or mapper failures without writing", async () => {
    const fixture = hostFixture();
    expect(await importXlsx({
      source: { surface: "workspace", path: "Book.csv" },
      targetPath: "Book.spreadsheet.html",
    }, { nautiloApp: fixture.host })).toMatchObject({ ok: false, code: "invalid_conversion_request" });
    expect(await exportXlsx({
      source: { surface: "workspace", path: "Book.spreadsheet.html" },
      target: { surface: "workspace", path: "Book.csv" },
    }, { nautiloApp: fixture.host })).toMatchObject({ ok: false, code: "invalid_conversion_request" });

    const officeFailure = hostFixture({
      source: Buffer.from("PK\u0003\u0004office failure"),
      run: async () => ({ ok: false, code: "UNAVAILABLE", message: "OfficeCLI unavailable" }),
    });
    expect(await importXlsx(workspaceImport, { nautiloApp: officeFailure.host })).toEqual({
      ok: true,
      status: "failed",
      code: "UNAVAILABLE",
      message: "OfficeCLI unavailable",
    });

    const malformed = hostFixture({
      source: Buffer.from("PK\u0003\u0004malformed dump"),
      run: async () => ({ ok: true, json: { success: true, data: [] } }),
    });
    expect(await importXlsx(workspaceImport, { nautiloApp: malformed.host })).toMatchObject({
      ok: true,
      status: "failed",
      code: "XLSX_MAPPING_FAILED",
    });
    expect(malformed.createArgs).toHaveLength(0);
  });
});
