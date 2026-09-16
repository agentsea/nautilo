import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorksheetEntries, writeWorksheetCell, type Cell } from "../engine/node.js";
import {
  createFile,
  editDocument,
  editOpenSheet,
  inspectDocument,
  inspectOpenSheet,
  type ServerNautiloAppHost,
} from "./sheet-tools";
import {
  createSheetDocument,
  addSheet,
  parseSheetHtml,
  serializeSheetHtml,
} from "./sheet-document";
import { spreadsheetLiveToolExtension } from "./live-tool-contract";

const FIRST_SHA = "a".repeat(64);
const SECOND_SHA = "b".repeat(64);

type ManifestFixture = {
  id: string;
  name: string;
  display: {
    groupId: string;
    groupName: string;
    groupOrder: number;
    appOrder: number;
    defaultCollapsed: boolean;
  };
  liveReview: unknown;
  capabilities: { state?: unknown; office?: unknown };
  agent: {
    instructions: string;
    tools: Array<{
      id: string;
      inputSchema: {
        required?: string[];
        properties: Record<string, unknown>;
      };
    }>;
  };
  contentAssociations: Array<{ match: { payloadFormat?: unknown } }>;
  conversions?: {
    import?: Array<{ id: string; sourceSurfaces: string[]; target: { extension: string }; tool: string; openAfterImport?: boolean }>;
    export?: Array<{ id: string; targetSurfaces: string[]; to: { extension: string }; tool: string }>;
  };
};

function sampleHtml(): string {
  const document = createSheetDocument();
  const sheet = document.sheets["tab-1"];
  writeWorksheetCell(sheet, { r: 1, c: 1 }, { v: "Name" });
  writeWorksheetCell(sheet, { r: 2, c: 1 }, { v: "Ada" });
  writeWorksheetCell(sheet, { r: 2, c: 2 }, { f: "=LEN(A2)" });
  return serializeSheetHtml(document);
}

function mockHost(overrides: Partial<ServerNautiloAppHost["document"]> = {}) {
  let content = sampleHtml();
  let sha = FIRST_SHA;
  let revision = 4;
  let targetedWrites = 0;
  let boundWrites = 0;
  let targetedReads = 0;
  const document: ServerNautiloAppHost["document"] = {
    async createFromAction(_actionId, opts) {
      return {
        target: opts.targetSurface === "workspace"
          ? { surface: "workspace" as const, path: opts.filename }
          : { surface: "currentFolder" as const, relativePath: opts.filename },
        displayPath: opts.filename,
        opened: opts.openAfterCreate ?? true,
      };
    },
    async read(target) {
      targetedReads += 1;
      return {
        content,
        mimeType: "text/html",
        displayPath: target.surface === "workspace" ? target.path : target.relativePath,
        baseSha256: sha,
        baseRevision: revision,
      };
    },
    async write(_target, next, options) {
      targetedWrites += 1;
      if (options?.baseSha256 !== sha || options?.baseRevision !== revision) {
        return { kind: "conflict", currentSha256: sha };
      }
      content = next.content;
      sha = SECOND_SHA;
      revision += 1;
      return { kind: "saved", sha256: sha, revision };
    },
    async writeBound(next) {
      boundWrites += 1;
      content = next.content;
      sha = SECOND_SHA;
      revision += 1;
      return { kind: "saved", sha256: sha, revision };
    },
    ...overrides,
  };
  return {
    host: { document } satisfies ServerNautiloAppHost,
    content: () => content,
    setContent: (next: string) => { content = next; },
    setSha: (next: string) => { sha = next; },
    targetedWrites: () => targetedWrites,
    boundWrites: () => boundWrites,
    targetedReads: () => targetedReads,
  };
}

describe("Sheets app-owned tools", () => {
  test("manifest exposes the native tools, XLSX conversions, and live direct-mutation pair", () => {
    const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.json"), "utf8"));
    const manifest = parsed as ManifestFixture;
    expect(manifest.id).toBe("nautilo-spreadsheet");
    expect(manifest.name).toBe("Sheets");
    expect(manifest.display).toEqual({
      groupId: "nautilo-office",
      groupName: "Nautilo Office",
      groupOrder: 10,
      appOrder: 20,
      defaultCollapsed: false,
    });
    expect(manifest.liveReview).toEqual({ enabled: true });
    expect(manifest.capabilities.state).toBeUndefined();
    expect(manifest.capabilities.office).toBe("convert");
    expect(manifest.agent.tools.map((tool) => tool.id)).toEqual([
      "create-file",
      "inspect-document",
      "edit-document",
      "inspect-open-sheet",
      "edit-open-sheet",
      "import-xlsx",
      "export-xlsx",
    ]);
    const liveInspect = manifest.agent.tools[3];
    const liveEdit = manifest.agent.tools[4];
    expect(liveInspect.inputSchema.properties.target).toBeUndefined();
    expect(liveEdit.inputSchema.properties.target).toBeUndefined();
    expect(liveEdit.inputSchema.required).toEqual(["expectedVersion", "operations"]);
    expect(manifest.agent.instructions).toContain("Use import-xlsx");
    expect(manifest.agent.instructions).toContain("export-xlsx");
    expect(manifest.agent.instructions).toContain("acknowledgedSourceSha256");
    for (const tool of manifest.agent.tools.slice(5)) {
      expect(tool.inputSchema.properties.acknowledgedSourceSha256).toEqual({
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description: "Exact source revision returned by the conversion warning preview.",
      });
    }
    expect(manifest.contentAssociations[0].match.payloadFormat).toBe(
      "application/vnd.wafflebase.spreadsheet+json",
    );
    expect(manifest.conversions?.import).toEqual([
      expect.objectContaining({
        id: "import-xlsx",
        sourceSurfaces: ["currentFolder", "workspace"],
        target: { surface: "workspace", extension: ".spreadsheet.html" },
        tool: "import-xlsx",
        openAfterImport: true,
      }),
    ]);
    expect(manifest.conversions?.export).toEqual([
      expect.objectContaining({
        id: "export-xlsx",
        targetSurfaces: ["currentFolder", "workspace"],
        to: {
          extension: ".xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        tool: "export-xlsx",
      }),
    ]);
    expect(spreadsheetLiveToolExtension.appId).toBe("nautilo-spreadsheet");
    expect(spreadsheetLiveToolExtension.mode).toBe("direct_mutation");
    expect(spreadsheetLiveToolExtension.liveToolIds).toEqual(["inspect-open-sheet", "edit-open-sheet"]);
    expect(spreadsheetLiveToolExtension.directMutationToolIds).toEqual(["edit-open-sheet"]);
    expect(spreadsheetLiveToolExtension.hostOwnsSessionBinding).toBe(true);
    expect(spreadsheetLiveToolExtension.hostOwnsIdempotencyKey).toBe(true);
    expect(spreadsheetLiveToolExtension.taskDelegation).toEqual({ mode: "direct_only" });
    expect("rebaseStaleDirectMutation" in spreadsheetLiveToolExtension).toBe(false);
  });

  test("canonical template parses and is the serializer output modulo its final newline", () => {
    const template = readFileSync(join(import.meta.dir, "..", "templates", "empty-spreadsheet.html"), "utf8");
    expect(parseSheetHtml(template)).toEqual(createSheetDocument());
    expect(template.trimEnd()).toBe(serializeSheetHtml(createSheetDocument()));
  });

  test("create-file validates the native basename and delegates to the manifest action", async () => {
    let seen: unknown;
    const mock = mockHost({
      async createFromAction(actionId, options) {
        seen = { actionId, options };
        return {
          target: { surface: "workspace", path: options.filename },
          displayPath: options.filename,
          opened: options.openAfterCreate ?? false,
        };
      },
    });
    const result = await createFile({
      targetSurface: "workspace",
      filename: "Budget.spreadsheet.html",
      openAfterCreate: false,
    }, { nautiloApp: mock.host });
    expect(result).toMatchObject({ ok: true, status: "created", opened: false });
    expect(seen).toEqual({
      actionId: "new-spreadsheet",
      options: {
        targetSurface: "workspace",
        filename: "Budget.spreadsheet.html",
        openAfterCreate: false,
      },
    });
    expect(await createFile({
      targetSurface: "workspace",
      filename: "../Budget.spreadsheet.html",
    }, { nautiloApp: mock.host })).toMatchObject({ ok: false, code: "invalid_create_request" });
  });

  test("uncertain create and write exceptions never claim a safe retry or unchanged state", async () => {
    const createMock = mockHost({
      async createFromAction() {
        throw new Error("create receipt timed out");
      },
    });
    expect(await createFile({
      targetSurface: "workspace",
      filename: "a.spreadsheet.html",
    }, { nautiloApp: createMock.host })).toEqual({
      ok: false,
      status: "error",
      code: "create_failed",
      message: "create receipt timed out",
      stateChanged: "unknown",
      retrySafe: false,
    });

    const closedMock = mockHost({
      async write() {
        throw new Error("write receipt timed out");
      },
    });
    expect(await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: FIRST_SHA,
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "C1", value: "changed" }] }],
    }, { nautiloApp: closedMock.host })).toEqual({
      ok: false,
      status: "error",
      code: "write_failed",
      message: "write receipt timed out",
      stateChanged: "unknown",
      retrySafe: false,
    });

    const liveMock = mockHost({
      async writeBound() {
        throw new Error("bound receipt timed out");
      },
    });
    expect(await editOpenSheet({
      sessionToken: "validated",
      documentVersion: { kind: "artifact_revision", revision: 4 },
      __canonicalContent: sampleHtml(),
      expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 4 }),
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "C1", value: "changed" }] }],
    }, { nautiloApp: liveMock.host })).toEqual({
      ok: false,
      status: "error",
      code: "bound_write_failed",
      message: "bound receipt timed out",
      stateChanged: "unknown",
      retrySafe: false,
    });
  });

  test("closed inspection pages sparse cells with a same-revision continuation", async () => {
    const mock = mockHost();
    const first = await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: "tab-1",
      range: "A1:C10",
      pageSize: 2,
    }, { nautiloApp: mock.host });
    expect(first).toMatchObject({
      ok: true,
      status: "inspected",
      expectedSha256: FIRST_SHA,
      sheetId: "tab-1",
      requestedRange: "A1:C10",
      sparseCellCount: 3,
      returnedCellCount: 2,
      completeness: "partial",
      omittedCellCount: 1,
    });
    if (!first.ok || first.completeness !== "partial") throw new Error("expected continuation");
    const second = await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: "tab-1",
      range: "A1:C10",
      pageSize: 2,
      cursor: first.nextCursor,
    }, { nautiloApp: mock.host });
    expect(second).toMatchObject({
      ok: true,
      completeness: "complete",
      returnedCellCount: 1,
      omittedCellCount: 0,
    });
    if (!second.ok) throw new Error("expected inspection");
    expect(second.cells).toEqual([{ ref: "B2", formula: "=LEN(A2)" }]);

    mock.setSha(SECOND_SHA);
    const staleContinuation = await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: "tab-1",
      range: "A1:C10",
      pageSize: 2,
      cursor: first.nextCursor,
    }, { nautiloApp: mock.host });
    expect(staleContinuation).toMatchObject({ ok: false, code: "inspection_failed" });
    if (staleContinuation.ok) throw new Error("expected stale continuation refusal");
    expect(staleContinuation.message).toContain("cursor does not match");
  });

  test("closed edit requires the inspected sha and writes with the same read revision", async () => {
    const mock = mockHost();
    expect(await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: SECOND_SHA,
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "C1", value: "Total" }] }],
    }, { nautiloApp: mock.host })).toMatchObject({ ok: false, status: "stale_revision" });
    expect(mock.targetedWrites()).toBe(0);

    const result = await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: FIRST_SHA,
      operations: [
        {
          op: "set-cells",
          sheetId: "tab-1",
          cells: [
            { ref: "C1", value: "Total" },
            { ref: "C2", formula: "SUM(B2:B9)" },
          ],
        },
        { op: "format-range", sheetId: "tab-1", range: "A1:C1", style: { bold: true, fillColor: "#ddeeff" } },
        { op: "merge-cells", sheetId: "tab-1", range: "A3:C3" },
        { op: "insert-rows", sheetId: "tab-1", index: 2, count: 1 },
        { op: "insert-columns", sheetId: "tab-1", index: 2, count: 1 },
      ],
    }, { nautiloApp: mock.host });
    expect(result).toMatchObject({ ok: true, status: "saved", sha256: SECOND_SHA });
    expect(mock.targetedWrites()).toBe(1);
    const saved = parseSheetHtml(mock.content());
    const inspection = inspectOpenSheet({
      sessionToken: "validated",
      documentVersion: { kind: "artifact_revision", revision: 5 },
      __canonicalContent: serializeSheetHtml(saved),
      sheetId: "tab-1",
      range: "A1:E10",
      pageSize: 20,
    }, { nautiloApp: mock.host });
    expect(inspection).toMatchObject({ ok: true, completeness: "complete" });
    if (!inspection.ok) throw new Error("expected inspection");
    expect(inspection.cells.some((cell) => cell.ref === "D3" && cell.formula === "=SUM(C3:C10)")).toBe(true);
    expect(saved.sheets["tab-1"].rangeStyles?.some((patch) => patch.style.b === true && patch.style.bg === "#ddeeff")).toBe(true);
    expect(saved.sheets["tab-1"].merges?.["A4"]).toEqual({ rs: 1, cs: 4 });
  });

  test("literal strings beginning with equals remain values while formula fields calculate", async () => {
    const mock = mockHost();
    const result = await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: FIRST_SHA,
      operations: [{
        op: "set-cells",
        sheetId: "tab-1",
        cells: [
          { ref: "C1", value: "=SUM(1,2)" },
          { ref: "C2", formula: "SUM(1,2)" },
        ],
      }],
    }, { nautiloApp: mock.host });
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const cells = new Map(getWorksheetEntries(parseSheetHtml(mock.content()).sheets["tab-1"]));
    expect(cells.get("C1")).toEqual({ v: "=SUM(1,2)" });
    expect(cells.get("C2")).toMatchObject({ f: "=SUM(1,2)", v: "3" });
  });

  test("cell and merge edits refuse spill state and unknown metadata before writing", async () => {
    const cases: Array<{
      cell: Cell;
      operations: unknown[];
      message: string;
    }> = [
      {
        cell: { f: "=MMULT(A2:A3,B2:C2)", v: "1", spillRows: 2, spillCols: 2 },
        operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "D1", value: "replacement" }] }],
        message: "dynamic-array spill",
      },
      {
        cell: { v: "1", spillAnchor: "D1" },
        operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "D1", value: null }] }],
        message: "dynamic-array spill",
      },
      {
        cell: { v: "protected", futureMetadata: { revision: 1 } } as Cell,
        operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "D1", value: "replacement" }] }],
        message: "unsupported metadata futureMetadata",
      },
      {
        cell: { v: "protected", futureMetadata: { revision: 1 } } as Cell,
        operations: [{ op: "merge-cells", sheetId: "tab-1", range: "C1:D1" }],
        message: "unsupported metadata futureMetadata",
      },
    ];
    for (const item of cases) {
      const document = createSheetDocument();
      writeWorksheetCell(document.sheets["tab-1"], { r: 1, c: 4 }, item.cell);
      const mock = mockHost();
      mock.setContent(serializeSheetHtml(document));
      const result = await editDocument({
        target: { surface: "workspace", path: "Budget.spreadsheet.html" },
        expectedSha256: FIRST_SHA,
        operations: item.operations,
      }, { nautiloApp: mock.host });
      expect(result).toMatchObject({ ok: false, status: "invalid_request", stateChanged: false });
      if (result.ok) throw new Error("expected protected-cell refusal");
      expect(result.message).toContain(item.message);
      expect(mock.targetedWrites()).toBe(0);
    }
  });

  test("open inspection uses only injected content and returns JSON.stringify(documentVersion)", () => {
    const mock = mockHost({
      async read() { throw new Error("targeted read must not run"); },
    });
    const version = { kind: "artifact_revision" as const, revision: 4 };
    const result = inspectOpenSheet({
      sessionToken: "validated",
      documentVersion: version,
      __canonicalContent: sampleHtml(),
      range: "A1:B2",
      pageSize: 10,
    }, { nautiloApp: mock.host });
    expect(mock.targetedReads()).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      status: "inspected",
      versionToken: JSON.stringify(version),
      completeness: "complete",
    });
    expect(inspectOpenSheet({
      sessionToken: "validated",
      documentVersion: version,
      __canonicalContent: sampleHtml(),
      range: "A1:B2",
      pageSize: 10,
      search: { query: "LEN", scope: "sheet", formulas: true },
    }, { nautiloApp: mock.host })).toMatchObject({
      ok: true,
      matches: [{ sheetId: "tab-1", ref: "B2", formula: "=LEN(A2)", hidden: false }],
      completeness: "complete",
    });
    expect(JSON.stringify(result)).not.toContain("validated");
  });

  test("open edit strictly rejects a stale prior read and writes only through writeBound", async () => {
    const mock = mockHost({
      async read() { throw new Error("targeted read must not run"); },
      async write() { throw new Error("targeted write must not run"); },
    });
    const args = {
      sessionToken: "validated",
      documentVersion: { kind: "artifact_revision" as const, revision: 4 },
      idempotencyKey: "host-owned-key",
      __canonicalContent: sampleHtml(),
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "C2", formula: "SUM(A1:B2)" }] }],
    };
    expect(await editOpenSheet({ ...args, expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 3 }) }, { nautiloApp: mock.host })).toMatchObject({
      ok: false,
      status: "stale_version",
      stateChanged: false,
    });
    expect(mock.boundWrites()).toBe(0);

    const result = await editOpenSheet({ ...args, expectedVersion: JSON.stringify(args.documentVersion) }, { nautiloApp: mock.host });
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 5 },
      versionToken: JSON.stringify({ kind: "artifact_revision", revision: 5 }),
    });
    expect(mock.boundWrites()).toBe(1);
    expect(mock.targetedReads()).toBe(0);
    expect(mock.targetedWrites()).toBe(0);
    const saved = parseSheetHtml(mock.content());
    expect(Object.values(saved.sheets["tab-1"].cells).some((cell) => cell.f === "=SUM(A1:B2)")).toBe(true);
  });

  test("open edit persists recalculated multi-hop formulas across inactive sheets", async () => {
    let document = addSheet(createSheetDocument(), "Middle").document;
    document = addSheet(document, "Last").document;
    const [firstId, middleId, lastId] = document.tabOrder;
    writeWorksheetCell(document.sheets[firstId], { r: 1, c: 1 }, { v: "1" });
    writeWorksheetCell(document.sheets[middleId], { r: 1, c: 1 }, { f: "=Sheet1!A1*2", v: "stale" });
    writeWorksheetCell(document.sheets[lastId], { r: 1, c: 1 }, { f: "=Middle!A1+1", v: "stale" });
    writeWorksheetCell(document.sheets[lastId], { r: 1, c: 2 }, { f: "=A1+1", v: "stale" });
    const mock = mockHost();
    const version = { kind: "artifact_revision" as const, revision: 4 };
    const result = await editOpenSheet({
      sessionToken: "validated",
      documentVersion: version,
      __canonicalContent: serializeSheetHtml(document),
      expectedVersion: JSON.stringify(version),
      operations: [{ op: "set-cells", sheetId: firstId, cells: [{ ref: "A1", value: 10 }] }],
    }, { nautiloApp: mock.host });
    expect(result).toMatchObject({ ok: true, status: "saved" });
    const saved = parseSheetHtml(mock.content());
    const middle = new Map(getWorksheetEntries(saved.sheets[middleId]));
    const last = new Map(getWorksheetEntries(saved.sheets[lastId]));
    expect(middle.get("A1")).toMatchObject({ f: "=Sheet1!A1*2", v: "20" });
    expect(last.get("A1")).toMatchObject({ f: "=Middle!A1+1", v: "21" });
    expect(last.get("B1")).toMatchObject({ f: "=A1+1", v: "22" });
  });

  test("open handlers reject path-shaped authority and malformed operation batches", async () => {
    const mock = mockHost();
    expect(inspectOpenSheet({
      sessionToken: "validated",
      documentVersion: { kind: "artifact_revision", revision: 4 },
      __canonicalContent: sampleHtml(),
      target: { surface: "workspace", path: "other.spreadsheet.html" },
      range: "A1:B2",
      pageSize: 10,
    }, { nautiloApp: mock.host })).toMatchObject({ ok: false, message: "unknown field target" });
    expect(await editOpenSheet({
      sessionToken: "validated",
      documentVersion: { kind: "artifact_revision", revision: 4 },
      __canonicalContent: sampleHtml(),
      expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 4 }),
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "A1", value: 1, formula: "A2" }] }],
    }, { nautiloApp: mock.host })).toMatchObject({ ok: false, status: "invalid_request" });
    expect(mock.boundWrites()).toBe(0);
  });

  test("closed data edits persist filters and keep a failed mixed batch atomic", async () => {
    const mock = mockHost();
    const saved = await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: FIRST_SHA,
      operations: [{ op: "set-cells", sheetId: "tab-1", cells: [{ ref: "A3", value: "Grace" }] }, {
        op: "set-filter",
        sheetId: "tab-1",
        range: "A1:B3",
        columns: { "1": { op: "contains", value: "Ada" } },
      }],
    }, { nautiloApp: mock.host });
    expect(saved).toMatchObject({ ok: true, status: "saved" });
    expect(parseSheetHtml(mock.content()).sheets["tab-1"].filter).toMatchObject({
      startRow: 1,
      endRow: 3,
      columns: { "1": { op: "contains", value: "Ada" } },
    });

    const beforeFailure = mock.content();
    const failed = await editDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      expectedSha256: SECOND_SHA,
      operations: [
        { op: "set-cells", sheetId: "tab-1", cells: [{ ref: "A2", value: "changed" }] },
        { op: "sort-range", sheetId: "tab-1", range: "A1:B3", column: 3, direction: "asc", header: true },
      ],
    }, { nautiloApp: mock.host });
    expect(failed).toMatchObject({ ok: false, status: "invalid_request", stateChanged: false });
    expect(mock.content()).toBe(beforeFailure);
    expect(mock.targetedWrites()).toBe(1);
  });

  test("open data edits retain exact version authority", async () => {
    const mock = mockHost();
    const version = { kind: "artifact_revision" as const, revision: 4 };
    const result = await editOpenSheet({
      sessionToken: "validated",
      documentVersion: version,
      __canonicalContent: sampleHtml(),
      expectedVersion: JSON.stringify(version),
      operations: [{ op: "sort-range", sheetId: "tab-1", range: "A1:B2", column: 1, direction: "desc", header: true }],
    }, { nautiloApp: mock.host });
    expect(result).toMatchObject({ ok: true, status: "saved", versionToken: JSON.stringify({ kind: "artifact_revision", revision: 5 }) });
    expect(mock.boundWrites()).toBe(1);
  });

  test("search pages numeric, formula, hidden, and workbook matches with query-bound cursors", async () => {
    const document = addSheet(createSheetDocument(), "Archive").document;
    const [firstId, secondId] = document.tabOrder;
    writeWorksheetCell(document.sheets[firstId], { r: 1, c: 1 }, { v: "Needle" });
    writeWorksheetCell(document.sheets[firstId], { r: 2, c: 1 }, { v: "42" });
    writeWorksheetCell(document.sheets[firstId], { r: 3, c: 1 }, { f: "=42+1", v: "43" });
    document.sheets[firstId].hiddenRows = [2];
    writeWorksheetCell(document.sheets[secondId], { r: 1, c: 1 }, { v: "needle in archive" });
    const mock = mockHost();
    mock.setContent(serializeSheetHtml(document));

    const first = await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: firstId,
      range: "A1:A3",
      pageSize: 1,
      search: { query: "needle", scope: "workbook" },
    }, { nautiloApp: mock.host });
    expect(first).toMatchObject({ ok: true, completeness: "partial", matchCount: 2, returnedMatchCount: 1 });
    if (!first.ok || first.completeness !== "partial") throw new Error("expected search continuation");
    expect(first.matches?.[0]).toMatchObject({ sheetId: firstId, ref: "A1", hidden: false });
    const second = await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: firstId,
      range: "A1:A3",
      pageSize: 1,
      search: { query: "needle", scope: "workbook" },
      cursor: first.nextCursor,
    }, { nautiloApp: mock.host });
    expect(second).toMatchObject({ ok: true, completeness: "complete", matches: [{ sheetId: secondId, ref: "A1" }] });
    expect(await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" },
      sheetId: firstId,
      range: "A1:A3",
      pageSize: 1,
      search: { query: "Needle", scope: "sheet", caseSensitive: true },
      cursor: first.nextCursor,
    }, { nautiloApp: mock.host })).toMatchObject({ ok: false, code: "inspection_failed" });

    expect(await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" }, sheetId: firstId,
      range: "A1:A3", pageSize: 10, search: { query: "42", scope: "sheet" },
    }, { nautiloApp: mock.host })).toMatchObject({ ok: true, matches: [{ ref: "A2", value: "42", hidden: true }] });
    expect(await inspectDocument({
      target: { surface: "workspace", path: "Budget.spreadsheet.html" }, sheetId: firstId,
      range: "A1:A3", pageSize: 10, search: { query: "42+1", scope: "sheet", formulas: true },
    }, { nautiloApp: mock.host })).toMatchObject({ ok: true, matches: [{ ref: "A3", formula: "=42+1", hidden: false }] });
  });
});
