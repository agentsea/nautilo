import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCatalog } from "@nautilo/catalog";
import {
  beginTaskWriterReviewVerification,
  registerTaskLiveMiniAppBinding,
  taskReturnBindingRegistryForTests,
  taskWriterReviewVerificationCoverageState,
} from "@nautilo/runtime";
import {
  jsonSchemaToZod,
  registerAppToolsForApp,
} from "../../src/apps/app-tool-registration";
import type { AppToolInvokeRequest, AppToolInvokeResult, AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { LiveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import {
  getLiveAppSessionExtension,
  getLiveReviewExtension,
  isDirectMutationLiveReviewExtension,
} from "../../src/apps/live-review-extension-registry";
import {
  createDefaultManifest,
  serializeWriterHtml,
} from "../../../first-party-apps/writer/src/office-document";
import { createEmptyDocument } from "../../../first-party-apps/design/src/scene-graph";
import { editOpenDesign } from "../../../first-party-apps/design/src/design-operations";

let appsRoot = "";

afterEach(async () => {
  taskReturnBindingRegistryForTests.clear();
  if (appsRoot) {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = "";
  }
});

async function makeAppsRoot(): Promise<string> {
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-tool-registration-"));
  return appsRoot;
}

function manifest(toolDescription = "Inspect sheet") {
  return {
    id: "sheet",
    name: "Sheet",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: {
      document: {
        artifact: "readwrite",
        currentFolder: "readwrite",
      },
      state: "readwrite",
    },
    agent: {
      tools: [
        {
          id: "inspect-document",
          description: toolDescription,
          runtime: "server",
          module: "./agent-tools.ts",
          handler: "inspectDocument",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              includeCells: { type: "boolean" },
            },
            required: ["target"],
          },
          impact: "read-only",
          requiredCapability: null,
          resultScanPolicy: "never",
        },
      ],
    },
  };
}

async function writeTestApp(root: string, opts?: { toolDescription?: string; toolSource?: string }): Promise<void> {
  const appDir = join(root, "sheet");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(manifest(opts?.toolDescription), null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(
    join(appDir, "agent-tools.ts"),
    opts?.toolSource ?? "export function inspectDocument(args) { return { ok: true, args }; }\n",
  );
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

async function writeBrowserPreparedExportApp(root: string, prepareInApp: boolean): Promise<void> {
  const appDir = join(root, "sheet");
  await mkdir(appDir, { recursive: true });
  const appManifest = manifest();
  const baseTool = appManifest.agent.tools[0];
  if (!baseTool) throw new Error("test manifest requires its ordinary tool");
  appManifest.agent.tools.push({
    ...baseTool,
    id: "export-pdf",
    description: "Export PDF",
    handler: "exportPdf",
  });
  Object.assign(appManifest, {
    conversions: {
      export: [{
        id: "export-pdf",
        label: "PDF (.pdf)",
        to: { extension: ".pdf", mimeType: "application/pdf" },
        tool: "export-pdf",
        ...(prepareInApp ? { prepareInApp: true } : {}),
        targetSurfaces: ["workspace", "currentFolder"],
      }],
    },
  });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(appManifest, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(join(appDir, "agent-tools.ts"), [
    "export function inspectDocument(args) { return { ok: true, args }; }",
    "export function exportPdf(args) { return { ok: true, args }; }",
    "",
  ].join("\n"));
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

async function writeLiveWriterTestApp(
  root: string,
  options: { appId?: string; liveReview?: boolean } = {},
): Promise<void> {
  const appId = options.appId ?? "nautilo-writer";
  const appDir = join(root, appId);
  await mkdir(appDir, { recursive: true });
  const liveToolManifest = {
    id: appId,
    name: "Writer",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: {
      document: { artifact: "readwrite", currentFolder: "readwrite" },
      state: "readwrite",
    },
    ...(options.liveReview === false ? {} : { liveReview: { enabled: true } }),
    agent: {
      tools: [{
        id: "edit-open-writer",
        description: "Propose edits to the open Writer document.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "editOpenWriter",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            sessionToken: { type: "string", minLength: 1, maxLength: 256 },
            documentVersion: LIVE_DOCUMENT_VERSION_SCHEMA,
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "replace" },
                      blockId: { type: "string", maxLength: 200 },
                      text: { type: "string", maxLength: 20_000 },
                      scope: { type: "object" },
                    },
                    required: ["kind", "blockId", "text", "scope"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "delete" },
                      blockId: { type: "string", maxLength: 200 },
                    },
                    required: ["kind", "blockId"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "merge-table-cells" },
                      tableBlockId: { type: "string", maxLength: 200 },
                      start: { type: "object" },
                      end: { type: "object" },
                    },
                    required: ["kind", "tableBlockId", "start", "end"],
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kind: { const: "delete-table" },
                      tableBlockId: { type: "string", maxLength: 200 },
                    },
                    required: ["kind", "tableBlockId"],
                  },
                ],
              },
            },
          },
          required: ["sessionToken", "documentVersion", "operations"],
        },
        impact: "read-only",
        requiredCapability: null,
        resultScanPolicy: "never",
      },
      {
        id: "read-open-writer-range", description: "Read live range", runtime: "server",
        module: "./agent-tools.ts", handler: "readOpenWriterRange",
        inputSchema: { type: "object", additionalProperties: false, properties: {
          sessionToken: { type: "string" }, documentVersion: LIVE_DOCUMENT_VERSION_SCHEMA, blockId: { type: "string" },
        }, required: ["sessionToken", "documentVersion", "blockId"] },
        impact: "read-only", requiredCapability: null, resultScanPolicy: "never",
      },
      {
        id: "locate-open-writer-text", description: "Locate live text", runtime: "server",
        module: "./agent-tools.ts", handler: "locateOpenWriterText",
        inputSchema: { type: "object", additionalProperties: false, properties: {
          sessionToken: { type: "string" }, documentVersion: LIVE_DOCUMENT_VERSION_SCHEMA, blockId: { type: "string" },
          target: { type: "string" },
        }, required: ["sessionToken", "documentVersion", "blockId", "target"] },
        impact: "read-only", requiredCapability: null, resultScanPolicy: "never",
      },
      {
        id: "inspect-document",
        description: "Inspect a Writer document.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "inspectDocument",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                surface: { type: "string", enum: ["workspace", "currentFolder"] },
                path: { type: "string" },
              },
              required: ["surface", "path"],
            },
          },
          required: ["target"],
        },
        impact: "read-only",
        requiredCapability: null,
        resultScanPolicy: "never",
      },
      {
        id: "replace-text",
        description: "Replace text in a closed Writer document.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "replaceText",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                surface: { type: "string", enum: ["workspace", "currentFolder"] },
                path: { type: "string" },
              },
              required: ["surface", "path"],
            },
          },
          required: ["target"],
        },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "on-suspicious",
      },
      {
        id: "import-docx",
        description: "Import a .docx to a closed Writer document.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "importDocx",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            targetPath: { type: "string" },
          },
          required: ["targetPath"],
        },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "on-suspicious",
      },
      {
        id: "export-docx",
        description: "Export a Writer document.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "exportDocx",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: {
              type: "object",
              additionalProperties: false,
              properties: {
                surface: { type: "string", enum: ["workspace", "currentFolder"] },
                path: { type: "string" },
              },
              required: ["surface", "path"],
            },
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                surface: { type: "string", enum: ["workspace", "currentFolder"] },
                path: { type: "string" },
              },
              required: ["surface", "path"],
            },
          },
          required: ["source", "target"],
        },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "on-suspicious",
      }],
    },
  };
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(liveToolManifest, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(
    join(appDir, "agent-tools.ts"),
    [
      "export function editOpenWriter(args) { return { ok: true, status: 'proposal_ready', documentVersion: args.documentVersion, operations: args.operations }; }",
      "export function readOpenWriterRange(args) { return { ok: true, status: 'range_read', documentVersion: args.documentVersion, content: args.__canonicalContent }; }",
      "export function locateOpenWriterText(args) { return { ok: true, status: 'locator_resolved', documentVersion: args.documentVersion, blockId: args.blockId, __range: { start: 2, end: 5 } }; }",
      "",
    ].join("\n"),
  );
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

async function writeLiveDesignTestApp(
  root: string,
  liveReview = true,
  strictOperationSchema = false,
): Promise<void> {
  const appDir = join(root, "nautilo-design");
  await mkdir(appDir, { recursive: true });
  const sessionProperties = {
    sessionToken: { type: "string", minLength: 1, maxLength: 256 },
    documentVersion: LIVE_DOCUMENT_VERSION_SCHEMA,
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
  };
  const productionManifest = await Bun.file(join(
    import.meta.dirname,
    "../../../first-party-apps/design/app.json",
  )).json() as {
    agent: { tools: Array<Record<string, unknown> & { id: string; inputSchema: Record<string, unknown> }> };
  };
  const productionCreateTool = productionManifest.agent.tools.find(
    (tool) => tool.id === "create-file",
  );
  if (!productionCreateTool) throw new Error("expected production Design create-file tool");
  const productionEditSchema = strictOperationSchema
    ? productionManifest.agent.tools.find(
        (tool) => tool.id === "edit-open-design",
      )?.inputSchema
    : undefined;
  const productionInspectSchema = strictOperationSchema
    ? productionManifest.agent.tools.find(
        (tool) => tool.id === "inspect-open-design",
      )?.inputSchema
    : undefined;
  await writeFile(join(appDir, "app.json"), `${JSON.stringify({
    id: "nautilo-design",
    name: "Design",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: { document: { artifact: "readwrite", currentFolder: "readwrite" }, state: "readwrite" },
    ...(liveReview ? { liveReview: { enabled: true } } : {}),
    agent: { tools: [
      productionCreateTool,
      {
        id: "inspect-open-design", description: "Inspect the active design.", runtime: "server",
        module: "./agent-tools.ts", handler: "inspectOpenDesign",
        inputSchema: productionInspectSchema ?? { type: "object", additionalProperties: false, properties: sessionProperties, required: ["sessionToken", "documentVersion"] },
        impact: "read-only", requiredCapability: null, resultScanPolicy: "never",
      },
      {
        id: "edit-open-design", description: "Atomically edit the active design.", runtime: "server",
        module: "./agent-tools.ts", handler: "editOpenDesign",
        inputSchema: productionEditSchema ?? { type: "object", additionalProperties: false, properties: { ...sessionProperties, operations: { type: "array" }, preconditions: { type: "array" } }, required: ["sessionToken", "documentVersion", "idempotencyKey", "operations"] },
        impact: "high", requiredCapability: "use_project_content", resultScanPolicy: "on-suspicious",
      },
    ] },
  }, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(join(appDir, "agent-tools.ts"), [
    "export function createFile(args) { return { ok: true, args }; }",
    "export function inspectOpenDesign(args) { return { ok: true, canonical: args.__canonicalContent }; }",
    "export function editOpenDesign(args) { return { ok: true, session: args.sessionToken, canonical: args.__canonicalContent }; }",
    "",
  ].join("\n"));
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

async function writeLivePresentationTestApp(root: string): Promise<void> {
  const appDir = join(root, "nautilo-presentation");
  await mkdir(appDir, { recursive: true });
  const productionManifest = await Bun.file(join(
    import.meta.dirname,
    "../../../first-party-apps/presentation/app.json",
  )).json() as {
    agent: { tools: Array<Record<string, unknown> & { id: string }> };
  };
  const editTool = productionManifest.agent.tools.find(
    (tool) => tool.id === "edit-open-presentation",
  );
  if (!editTool) throw new Error("expected production Presentation edit-open-presentation tool");
  await writeFile(join(appDir, "app.json"), `${JSON.stringify({
    id: "nautilo-presentation",
    name: "Presentation",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: { document: { artifact: "readwrite", currentFolder: "readwrite" }, state: "readwrite" },
    liveReview: { enabled: true },
    agent: { tools: [editTool] },
  }, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(join(appDir, "agent-tools.ts"), "export function editOpenPresentation() { return {}; }\n");
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

function runnerContext(overrides: Partial<AppToolRunnerContext> = {}): AppToolRunnerContext {
  return {
    ownerId: "user-1",
    userId: "user-1",
    agentId: "agent-1",
    turnId: "turn-agent-1",
    memoryAccessEnvelope: {
      ownerId: "user-1",
      agentId: "agent-1",
      memoryMode: "namespace",
      readableNamespaceIds: ["ns-1"],
      mutableNamespaceIds: ["ns-1"],
      writableNamespaceIds: ["ns-1"],
    } as never,
    ...overrides,
  };
}

const LIVE_DOCUMENT_VERSION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "artifact_revision" },
        revision: { type: "integer", minimum: 0 },
      },
      required: ["kind", "revision"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "local_sha" },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      required: ["kind", "sha256"],
    },
  ],
};

function liveWriterCanonical(text: string): string {
  return serializeWriterHtml(createDefaultManifest(), {
    blocks: [{ id: "block-1", type: "paragraph", inlines: [{ text, style: {} }] }],
  });
}

function liveWriterTableCanonical(covered = false): string {
  return serializeWriterHtml(createDefaultManifest(), {
    blocks: [{
      id: "table-1",
      type: "table",
      tableData: {
        columnWidths: [0.5, 0.5],
        rows: [{
          cells: [
            { style: {}, blocks: [{ id: "cell-1", type: "paragraph", style: {}, inlines: [{ text: "A", style: {} }] }] },
            { style: {}, ...(covered ? { colSpan: 0 } : {}), blocks: [{ id: "cell-2", type: "paragraph", style: {}, inlines: [{ text: "B", style: {} }] }] },
          ],
        }],
      },
    }],
  });
}

function parseToolResult(value: unknown): unknown {
  return JSON.parse(String(value)) as unknown;
}

describe("app tool registration", () => {
  test("registers manifest-declared app tools as plugin catalog entries", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    const seenRequests: unknown[] = [];

    const result = await registerAppToolsForApp(root, "sheet", {
      catalog,
      invoke: async (request): Promise<AppToolInvokeResult> => {
        seenRequests.push(request);
        return { ok: true, result: { called: request.tool.id, args: request.args } };
      },
    });

    expect(result).toMatchObject({
      status: "registered",
      appId: "sheet",
      toolCount: 1,
      toolNames: ["app_sheet__inspect_document"],
    });
    const entry = catalog.get("app_sheet__inspect_document");
    expect(entry).toMatchObject({
      source: "plugin",
      exposure: "discoverable",
      category: "documents",
      executor: "cloud",
      impact: "read-only",
      resultScanPolicy: "never",
    });
    expect(entry?.sourceServer).toMatch(/^app:sheet:[a-f0-9]{64}$/);

    const [tool] = catalog.getToolsForActor(runnerContext());
    expect(tool?.name).toBe("app_sheet__inspect_document");
    const content: unknown = await tool!.invoke({ target: "Budget.html" });
    const parsedContent: unknown = JSON.parse(String(content));
    expect(parsedContent).toEqual({
      called: "inspect-document",
      args: { target: "Budget.html" },
    });
    expect(seenRequests).toHaveLength(1);
  });

  test("exposes completed host mutation receipts when a direct agent tool fails", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    await registerAppToolsForApp(root, "sheet", {
      catalog,
      invoke: async (): Promise<AppToolInvokeResult> => ({
        ok: false,
        error: "Worker exited after the host write.",
        code: "timeout",
        completedHostMutations: [{
          method: "document.createRasterFromSvg",
          target: { surface: "workspace", path: "exports/Hero.png" },
          receipt: {
            ok: true,
            artifactPath: "exports/Hero.png",
            sha256: "png-sha",
            byteLength: 42,
          },
        }],
      }),
    });

    const [tool] = catalog.getToolsForActor(runnerContext());
    expect(parseToolResult(await tool!.invoke({ target: "Budget.html" }))).toEqual({
      ok: false,
      status: "completed_host_mutation",
      error: "Worker exited after the host write.",
      code: "timeout",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "exports/Hero.png" },
        receipt: {
          ok: true,
          artifactPath: "exports/Hero.png",
          sha256: "png-sha",
          byteLength: 42,
        },
      }],
    });
  });

  test("exposes an uncertain partial-write receipt without converting it to success", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    await registerAppToolsForApp(root, "sheet", {
      catalog,
      invoke: async (): Promise<AppToolInvokeResult> => ({
        ok: false,
        error: "Worker timed out while metadata was being confirmed.",
        code: "timeout",
        completedHostMutations: [{
          method: "document.createRasterFromSvg",
          target: { surface: "workspace", path: "exports/Partial.png" },
          receipt: {
            ok: false,
            code: "PARTIAL_WRITE",
            message: "PNG bytes were written but artifact metadata was not confirmed.",
            displayPath: "exports/Partial.png",
            bytesWritten: 42,
            metadataConfirmed: false,
            stateChanged: true,
            retrySafe: false,
          },
        }],
      }),
    });

    const [tool] = catalog.getToolsForActor(runnerContext());
    expect(parseToolResult(await tool!.invoke({ target: "Budget.html" }))).toEqual({
      ok: false,
      status: "completed_host_mutation",
      error: "Worker timed out while metadata was being confirmed.",
      code: "timeout",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "exports/Partial.png" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "PNG bytes were written but artifact metadata was not confirmed.",
          displayPath: "exports/Partial.png",
          bytesWritten: 42,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
  });

  test("preserves structured direct-mutation failures as exact tool content", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    let receivedArtifactResolver = false;
    const failure = {
      ok: false as const,
      status: "use_edit_open_writer" as const,
      code: "use_edit_open_writer" as const,
      message: "This document has an active mini-app editing session. Use that app’s live editing tools in the tab where it is open, or close that editor before editing the saved file." as const,
    };

    await registerAppToolsForApp(root, "sheet", {
      catalog,
      invoke: async (_request, options): Promise<AppToolInvokeResult> => {
        receivedArtifactResolver = typeof options?.liveReviewArtifactId === "function";
        return {
          ok: false,
          error: JSON.stringify(failure),
          code: "direct_mutation",
          directMutationFailure: failure,
        };
      },
    });

    const [tool] = catalog.getToolsForActor(runnerContext());
    const content: unknown = await tool!.invoke({ target: "Budget.html" });
    expect(JSON.parse(String(content))).toEqual(failure);
    expect(String(content)).not.toContain("Budget.html");
    expect(receivedArtifactResolver).toBe(true);
  });

  test("propagates turnId from catalog factory context into invoke request (M206)", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    let capturedTurnId: string | undefined;

    await registerAppToolsForApp(root, "sheet", {
      catalog,
      invoke: async (request): Promise<AppToolInvokeResult> => {
        capturedTurnId = request.context.turnId ?? undefined;
        return { ok: true, result: { ok: true } };
      },
    });

    const [tool] = catalog.getToolsForActor({
      ...runnerContext(),
      turnId: "turn-catalog-42",
      roomId: "room-9",
      currentFolder: "/tmp/project",
      workspacePath: "/tmp/workspace",
    });
    await tool!.invoke({ target: "Budget.html" });
    expect(capturedTurnId).toBe("turn-catalog-42");
  });

  test("refresh removes stale source-hash tools", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root, { toolDescription: "Initial inspect" });
    const catalog = new ToolCatalog();

    const first = await registerAppToolsForApp(root, "sheet", { catalog });
    expect(first.status).toBe("registered");
    if (first.status !== "registered") return;
    const firstSource = first.sourceServer;

    await writeTestApp(root, { toolDescription: "Updated inspect" });
    const second = await registerAppToolsForApp(root, "sheet", { catalog });
    expect(second.status).toBe("registered");
    if (second.status !== "registered") return;
    expect(second.sourceServer).not.toBe(firstSource);
    expect(catalog.query({ source: "plugin" })).toHaveLength(1);
    expect(catalog.get("app_sheet__inspect_document")?.sourceServer).toBe(second.sourceServer);
  });

  test("refresh removes browser-prepared export tools while preserving ordinary tools", async () => {
    const root = await makeAppsRoot();
    const catalog = new ToolCatalog();
    await writeBrowserPreparedExportApp(root, false);

    const first = await registerAppToolsForApp(root, "sheet", { catalog });
    expect(first).toMatchObject({ status: "registered", toolCount: 2 });
    expect(catalog.has("app_sheet__inspect_document")).toBe(true);
    expect(catalog.has("app_sheet__export_pdf")).toBe(true);

    await writeBrowserPreparedExportApp(root, true);
    const refreshed = await registerAppToolsForApp(root, "sheet", { catalog });

    expect(refreshed).toMatchObject({
      status: "registered",
      toolCount: 1,
      toolNames: ["app_sheet__inspect_document"],
    });
    expect(catalog.has("app_sheet__inspect_document")).toBe(true);
    expect(catalog.has("app_sheet__export_pdf")).toBe(false);
    expect(catalog.resolveProgressiveTools({
      activatedToolNames: ["app_sheet__export_pdf"],
    })).toMatchObject({ snapshot: { entries: [] }, tools: [] });
  });

  test("failed app-tool build unregisters stale tools and skips registration", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();
    const first = await registerAppToolsForApp(root, "sheet", { catalog });
    expect(first.status).toBe("registered");
    expect(catalog.has("app_sheet__inspect_document")).toBe(true);
    const active = catalog.resolveProgressiveTools({
      activatedToolNames: ["app_sheet__inspect_document"],
    });
    expect(active.snapshot.entries[0]).toMatchObject({
      name: "app_sheet__inspect_document",
      source: "plugin",
      exposure: "discoverable",
      executor: "cloud",
      impact: "read-only",
      requiresApproval: false,
    });
    expect(active.tools).toHaveLength(1);

    await writeTestApp(root, {
      toolSource: "import fs from 'node:fs';\nexport function inspectDocument() { return fs; }\n",
    });
    const second = await registerAppToolsForApp(root, "sheet", { catalog });
    expect(second.status).toBe("skipped");
    expect(catalog.has("app_sheet__inspect_document")).toBe(false);
    const stale = catalog.resolveProgressiveTools({
      activatedToolNames: ["app_sheet__inspect_document"],
    });
    expect(stale.snapshot.entries).toEqual([]);
    expect(stale.tools).toEqual([]);
  });
});

const ARTIFACT_VERSION = { kind: "artifact_revision" as const, revision: 7 };
const LOCAL_SHA = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const LOCAL_VERSION = { kind: "local_sha" as const, sha256: LOCAL_SHA };

describe("app tool registration — live Writer session gate (D386)", () => {
  const binding = {
    targetKind: "artifact" as const,
    appId: "nautilo-writer",
    userId: "user-1",
    namespaceIds: ["namespace-1"],
    artifactId: "artifact-1",
    documentId: "document-1",
    documentVersion: ARTIFACT_VERSION,
  };
  const currentFileBinding = {
    targetKind: "currentFile" as const,
    appId: "nautilo-writer",
    userId: "user-1",
    localTargetId: "local-target-1",
    relayId: "relay-1",
    canonicalPath: "/Users/human/project/docs/readme.md",
    currentFolderRoot: "/Users/human/project",
    relativePath: "docs/readme.md",
    documentVersion: LOCAL_VERSION,
  };
  const operation = {
    kind: "replace",
    blockId: "block-1",
    text: "new wording",
    scope: { kind: "match", anchor: "wording" },
  };

  test("registers review proposals as read-only without agent approval while direct writes remain high-impact", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();

    await registerAppToolsForApp(root, "nautilo-writer", { catalog });

    const editOpenWriter = catalog.get("app_nautilo_writer__edit_open_writer");
    const readOpenWriterRange = catalog.get("app_nautilo_writer__read_open_writer_range");
    const locateOpenWriterText = catalog.get("app_nautilo_writer__locate_open_writer_text");
    expect(editOpenWriter).toBeDefined();
    expect(readOpenWriterRange).toBeDefined();
    expect(locateOpenWriterText).toBeDefined();
    if (!editOpenWriter || !readOpenWriterRange || !locateOpenWriterText) {
      throw new Error("expected registered Writer live-review tools");
    }

    expect(editOpenWriter).toMatchObject({
      exposure: "discoverable",
      impact: "read-only",
      requiredCapabilities: [],
      requiresApproval: false,
      resultScanPolicy: "never",
    });
    for (const entry of [editOpenWriter, readOpenWriterRange, locateOpenWriterText]) {
      expect(entry.exposure).toBe("discoverable");
      expect(entry.discovery).toEqual({ preferredReviewWorkflow: true });
      for (const tag of ["nautilo-writer", "live-review", "review", "proposal"]) {
        expect(entry.tags).toContain(tag);
      }
    }
    expect(editOpenWriter.approvalMode).toBeUndefined();
    expect(catalog.get("app_nautilo_writer__replace_text")).toMatchObject({
      exposure: "discoverable",
      impact: "high",
      requiredCapabilities: ["use_project_content"],
      requiresApproval: true,
      resultScanPolicy: "on-suspicious",
    });
    expect(catalog.get("app_nautilo_writer__replace_text")?.tags).not.toContain("live-review");
    expect(catalog.get("app_nautilo_writer__replace_text")?.discovery).toBeUndefined();
  });

  test("gates Design direct edits with a bound session while keeping the binding out of app arguments", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const designBinding = { ...binding, appId: "nautilo-design" as const };
    const { token } = registry.issue(designBinding);
    const received = new Map<string, AppToolInvokeRequest>();

    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: "{\\\"kind\\\":\\\"design\\\"}" }),
      invoke: async (request): Promise<AppToolInvokeResult> => {
        received.set(request.tool.id, request);
        return { ok: true, result: { ok: true } };
      },
    });

    const edit = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    );
    const registration = catalog.get("app_nautilo_design__edit_open_design");
    expect(registration).toMatchObject({
      requiresApproval: true,
      discovery: { preferredLiveSessionWorkflow: true },
    });
    expect(registration?.guidance).toContain("active Design session");
    const create = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__create_file",
    );
    expect(catalog.get("app_nautilo_design__create_file")).toMatchObject({
      requiresApproval: true,
      requiredCapabilities: ["use_project_content"],
    });
    await create!.invoke({
      targetSurface: "workspace",
      filename: "Hero.design.html",
    });
    expect(received.get("create-file")?.args).toEqual({
      targetSurface: "workspace",
      filename: "Hero.design.html",
    });
    await edit!.invoke({
      sessionToken: token,
      documentVersion: designBinding.documentVersion,
      idempotencyKey: "design-edit-1",
      operations: [{ kind: "create_shape" }],
    });

    const editRequest = received.get("edit-open-design");
    expect(editRequest?.liveMutationBinding).toEqual(designBinding);
    expect(editRequest?.args).toMatchObject({
      sessionToken: "server-validated-live-session",
      documentVersion: designBinding.documentVersion,
      __canonicalContent: "{\\\"kind\\\":\\\"design\\\"}",
    });
    expect(editRequest?.args).not.toHaveProperty("baseRevision");
    expect(JSON.stringify(editRequest?.args)).not.toContain(token);

    const inspect = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__inspect_open_design",
    );
    await inspect!.invoke({
      sessionToken: token,
      documentVersion: designBinding.documentVersion,
    });
    const inspectRequest = received.get("inspect-open-design");
    expect(inspectRequest?.liveMutationBinding).toBeUndefined();
    expect(inspectRequest?.args).toMatchObject({
      sessionToken: "server-validated-live-session",
      documentVersion: designBinding.documentVersion,
      __canonicalContent: "{\\\"kind\\\":\\\"design\\\"}",
    });
    expect(inspectRequest?.args).not.toHaveProperty("baseRevision");
    expect(JSON.stringify(inspectRequest?.args)).not.toContain(token);
  });

  test("enforces Design op branches at the catalog boundary before invoking the worker", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root, true, true);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const designBinding = { ...binding, appId: "nautilo-design" as const };
    const { token } = registry.issue(designBinding);
    let invokes = 0;
    let workerOperations: unknown;
    let workerArgs: Record<string, unknown> | undefined;
    const workerIdempotencyKeys: string[] = [];
    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: "{}" }),
      invoke: async (request): Promise<AppToolInvokeResult> => {
        invokes += 1;
        workerArgs = request.args as Record<string, unknown>;
        workerIdempotencyKeys.push(String(workerArgs["idempotencyKey"]));
        workerOperations = (request.args as Record<string, unknown>)["operations"];
        return {
          ok: true,
          result: {
            ok: true,
            documentVersion: designBinding.documentVersion,
            receipt: { outcome: "applied" },
          },
        };
      },
    });
    const edit = catalog.getToolsForActor(runnerContext({
      toolCallId: "design-tool-call-1",
      liveMiniAppSession: {
        appId: "nautilo-design",
        sessionToken: token,
        sessionId: "trusted-context-session",
        documentVersion: designBinding.documentVersion,
        instructions: "Inspect before editing.",
      },
    })).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    const base = {
      preconditions: [{ handle: "page:page-1", semanticVersion: `s1:${"a".repeat(64)}` }],
    };
    let rejected: unknown;
    try {
      await edit.invoke({
        ...base,
        operations: [{
          op: "create",
          ref: "$card",
          pageId: "page:page-1",
          parentId: null,
          nodeId: "$card",
          node: { type: "text" },
        }],
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(invokes).toBe(0);

    const operations = [
      { op: "create", ref: "$card", pageId: "page:page-1", parentId: null, node: { type: "text" } },
      { op: "style", nodeIds: ["$card"], patch: { fills: [{ kind: "solid", color: "#2563eb" }] } },
      { op: "rename", nodeId: "$card", name: "Launch card" },
      { op: "text", nodeId: "$card", patch: { text: "Ship it" } },
    ];
    expect(JSON.parse(String(await edit.invoke({ ...base, operations })))).toMatchObject({
      ok: true,
    });
    expect(invokes).toBe(1);
    expect(workerOperations).toEqual(operations);
    expect(workerArgs).toMatchObject({
      sessionToken: "server-validated-live-session",
      documentVersion: designBinding.documentVersion,
    });
    expect(workerArgs?.["idempotencyKey"]).toBeString();
    expect(workerArgs?.["idempotencyKey"] as string).toMatch(/^host-[a-f0-9]{64}$/);
    expect(JSON.stringify(workerArgs)).not.toContain(token);

    const secondEdit = catalog.getToolsForActor(runnerContext({
      toolCallId: "design-tool-call-2",
      liveMiniAppSession: {
        appId: "nautilo-design",
        sessionToken: token,
        sessionId: "trusted-context-session",
        documentVersion: designBinding.documentVersion,
        instructions: "Inspect before editing.",
      },
    })).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    expect(JSON.parse(String(await secondEdit.invoke({ ...base, operations })))).toMatchObject({
      ok: true,
    });
    expect(invokes).toBe(2);
    expect(workerIdempotencyKeys).toHaveLength(2);
    expect(workerIdempotencyKeys[1]).not.toBe(workerIdempotencyKeys[0]);
    await edit.invoke({ ...base, operations });
    expect(invokes).toBe(2);
  });

  test("advances a host-owned Design binding across edit then inspect in one agent turn", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root, true, true);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const designBinding = { ...binding, appId: "nautilo-design" as const };
    const { token } = registry.issue(designBinding);
    const revision8 = { kind: "artifact_revision" as const, revision: 8 };
    const canonicalReadVersions: unknown[] = [];
    const workerVersions: unknown[] = [];

    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async (bound) => {
        canonicalReadVersions.push(bound.documentVersion);
        return { ok: true, content: "{}" };
      },
      invoke: async (request): Promise<AppToolInvokeResult> => {
        const workerVersion = (request.args as Record<string, unknown>)["documentVersion"];
        workerVersions.push(workerVersion);
        if (request.tool.id === "edit-open-design") {
          return {
            ok: true,
            result: { ok: true, status: "saved", documentVersion: revision8 },
          };
        }
        return {
          ok: true,
          result: { ok: true, status: "inspected", documentVersion: workerVersion },
        };
      },
    });

    const staleTurnContext = runnerContext({
      toolCallId: "design-lifecycle-edit-1",
      liveMiniAppSession: {
        appId: "nautilo-design",
        sessionToken: token,
        sessionId: "trusted-context-session",
        documentVersion: designBinding.documentVersion,
        instructions: "Inspect before editing.",
      },
    });
    const tools = catalog.getToolsForActor(staleTurnContext);
    const edit = tools.find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design"
    )!;
    const inspect = tools.find((entry) =>
      entry.name === "app_nautilo_design__inspect_open_design"
    )!;

    expect(JSON.parse(String(await edit.invoke({
      preconditions: [],
      operations: [{
        op: "create",
        ref: "$card",
        pageId: "page:page-1",
        parentId: null,
        node: { type: "text" },
      }],
    })))).toMatchObject({ ok: true, status: "saved", documentVersion: revision8 });
    expect(JSON.parse(String(await inspect.invoke({})))).toMatchObject({
      ok: true,
      status: "inspected",
      documentVersion: revision8,
    });
    expect(canonicalReadVersions).toEqual([
      designBinding.documentVersion,
      revision8,
    ]);
    expect(workerVersions).toEqual([
      designBinding.documentVersion,
      revision8,
    ]);
  });

  test("replays an identical Design edit after version advance without a second read or write", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const designBinding = { ...binding, appId: "nautilo-design" as const };
    const { token } = registry.issue(designBinding);
    let invokes = 0;
    let canonicalReads = 0;

    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => {
        canonicalReads += 1;
        return { ok: true, content: "{\"kind\":\"design\"}" };
      },
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return {
          ok: true,
          result: {
            ok: true,
            documentVersion: { kind: "artifact_revision", revision: 8 },
            receiptId: "receipt-1",
          },
        };
      },
    });

    const edit = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    const request = {
      sessionToken: token,
      documentVersion: designBinding.documentVersion,
      idempotencyKey: "design-edit-retry-1",
      operations: [{ kind: "create_shape", style: { stroke: "#111", fill: "#fff" } }],
    };
    const first = String(await edit.invoke(request));
    expect(JSON.parse(first)).toEqual({
      ok: true,
      documentVersion: { kind: "artifact_revision", revision: 8 },
      receiptId: "receipt-1",
    });
    const replay = String(await edit.invoke({
      ...request,
      operations: [{ style: { fill: "#fff", stroke: "#111" }, kind: "create_shape" }],
    }));
    expect(replay).toBe(first);
    expect(invokes).toBe(1);
    expect(canonicalReads).toBe(1);

    expect(JSON.parse(String(await edit.invoke({
      ...request,
      operations: [{ kind: "delete", nodeHandle: "node:1" }],
    })))).toEqual({
      ok: false,
      status: "idempotency_conflict",
      code: "idempotency_conflict",
    });
    expect(invokes).toBe(1);
  });

  test("replays one host-owned Presentation mutation after revision advance", async () => {
    const root = await makeAppsRoot();
    await writeLivePresentationTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const presentationBinding = { ...binding, appId: "nautilo-presentation" as const };
    const { token } = registry.issue(presentationBinding);
    let canonicalReads = 0;
    let workerInvokes = 0;
    let canonicalWrites = 0;
    const workerIdempotencyKeys: string[] = [];

    await registerAppToolsForApp(root, "nautilo-presentation", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => {
        canonicalReads += 1;
        return { ok: true, content: "{\"kind\":\"presentation\"}" };
      },
      invoke: async (request): Promise<AppToolInvokeResult> => {
        workerInvokes += 1;
        canonicalWrites += 1;
        workerIdempotencyKeys.push(String((request.args as Record<string, unknown>)["idempotencyKey"]));
        return {
          ok: true,
          result: {
            ok: true,
            status: "saved",
            documentVersion: { kind: "artifact_revision", revision: 8 },
            receipt: { operationCount: 1 },
          },
        };
      },
    });

    const edit = catalog.getToolsForActor(runnerContext({
      toolCallId: "presentation-edit-call-1",
      liveMiniAppSession: {
        appId: "nautilo-presentation",
        sessionToken: token,
        sessionId: "trusted-context-session",
        documentVersion: presentationBinding.documentVersion,
        instructions: "Inspect before editing.",
      },
    })).find((entry) => entry.name === "app_nautilo_presentation__edit_open_presentation")!;
    const request = {
      expectedVersion: JSON.stringify(presentationBinding.documentVersion),
      operations: [{ op: "set-title", title: "Recovered deck" }],
    };

    const first = String(await edit.invoke(request));
    expect(JSON.parse(first)).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 8 },
    });
    const replay = String(await edit.invoke({
      expectedVersion: request.expectedVersion,
      operations: [{ title: "Recovered deck", op: "set-title" }],
    }));
    expect(replay).toBe(first);
    expect({ canonicalReads, workerInvokes, canonicalWrites }).toEqual({
      canonicalReads: 1,
      workerInvokes: 1,
      canonicalWrites: 1,
    });
    expect(workerIdempotencyKeys).toHaveLength(1);
    expect(workerIdempotencyKeys[0]).toMatch(/^host-[a-f0-9]{64}$/);
  });

  test("recovers canonical Design drift with the authoritative version without exposing session authority", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const revision4 = { kind: "artifact_revision" as const, revision: 4 };
    const revision5 = { kind: "artifact_revision" as const, revision: 5 };
    const designBinding = {
      ...binding,
      appId: "nautilo-design" as const,
      documentVersion: revision4,
    };
    const { token, sessionId } = registry.issue(designBinding);
    let canonicalReads = 0;
    let invokes = 0;

    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async (bound) => {
        canonicalReads += 1;
        if (
          bound.targetKind === "artifact" &&
          bound.documentVersion.revision === revision4.revision
        ) {
          return {
            ok: false,
            status: "stale_version",
            currentDocumentVersion: revision5,
            canonicalContent: "{\"kind\":\"design\"}",
          };
        }
        return { ok: true, content: "{\"kind\":\"design\"}" };
      },
      invoke: async (request): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return {
          ok: true,
          result: {
            ok: true,
            status: request.tool.id === "inspect-open-design" ? "inspected" : "applied",
            documentVersion: (request.args as { documentVersion: unknown }).documentVersion,
          },
        };
      },
    });

    const tools = new Map(catalog.getToolsForActor(runnerContext()).map((tool) => [tool.name, tool]));
    const edit = tools.get("app_nautilo_design__edit_open_design")!;
    const inspect = tools.get("app_nautilo_design__inspect_open_design")!;
    const stale = parseToolResult(await edit.invoke({
      sessionToken: token,
      documentVersion: revision4,
      idempotencyKey: "stale-v4",
      operations: [{ kind: "create_shape" }],
    })) as {
      ok: false;
      status: "stale_version";
      stateChanged: false;
      retrySafe: true;
      recovery: { action: "reinspect"; documentVersion: typeof revision5 };
    };
    expect(stale).toEqual({
      ok: false,
      status: "stale_version",
      stateChanged: false,
      retrySafe: true,
      recovery: { action: "reinspect", documentVersion: revision5 },
    });
    expect(JSON.stringify(stale)).not.toContain(token);
    expect(JSON.stringify(stale)).not.toContain(sessionId);
    expect(JSON.stringify(stale)).not.toContain(designBinding.artifactId);
    expect(JSON.stringify(stale)).not.toContain(designBinding.documentId);
    expect(registry.validateForSubject(token, {
      appId: designBinding.appId,
      userId: designBinding.userId,
      documentVersion: revision5,
    })).toMatchObject({ ok: true });
    expect(canonicalReads).toBe(1);
    expect(invokes).toBe(0);

    expect(parseToolResult(await inspect.invoke({
      sessionToken: token,
      documentVersion: stale.recovery.documentVersion,
    }))).toMatchObject({ ok: true, status: "inspected", documentVersion: revision5 });
    expect(parseToolResult(await edit.invoke({
      sessionToken: token,
      documentVersion: revision5,
      idempotencyKey: "retry-v5",
      operations: [{ kind: "create_shape" }],
    }))).toMatchObject({ ok: true, status: "applied", documentVersion: revision5 });
    expect(canonicalReads).toBe(3);
    expect(invokes).toBe(2);

    const second = registry.issue(designBinding);
    const inspectStale = parseToolResult(await inspect.invoke({
      sessionToken: second.token,
      documentVersion: revision4,
    })) as typeof stale;
    expect(inspectStale).toEqual(stale);
    expect(registry.validateForSubject(second.token, {
      appId: designBinding.appId,
      userId: designBinding.userId,
      documentVersion: revision5,
    })).toMatchObject({ ok: true });
    expect(canonicalReads).toBe(4);
    expect(invokes).toBe(2);

    const raced = registry.issue(designBinding);
    const revision6 = { kind: "artifact_revision" as const, revision: 6 };
    let raceRead = false;
    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async (bound) => {
        if (!raceRead && bound.targetKind === "artifact") {
          raceRead = true;
          registry.refresh(raced.token, revision6, bound);
          return {
            ok: false,
            status: "stale_version",
            currentDocumentVersion: revision5,
            canonicalContent: "{\"kind\":\"design\"}",
          };
        }
        return { ok: true, content: "{\"kind\":\"design\"}" };
      },
      invoke: async (): Promise<AppToolInvokeResult> => {
        throw new Error("canonical drift must not invoke the worker");
      },
    });
    const racedEdit = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    expect(parseToolResult(await racedEdit.invoke({
      sessionToken: raced.token,
      documentVersion: revision4,
      idempotencyKey: "race-v4",
      operations: [{ kind: "create_shape" }],
    }))).toEqual({
      ok: false,
      status: "stale_version",
      stateChanged: false,
      retrySafe: true,
      recovery: { action: "reinspect", documentVersion: revision6 },
    });
    expect(registry.validateForSubject(raced.token, {
      appId: designBinding.appId,
      userId: designBinding.userId,
      documentVersion: revision6,
    })).toMatchObject({ ok: true });
  });

  test("auto-rebases only trusted disjoint Design semantics and never downgrades a newer binding", async () => {
    const extension = getLiveAppSessionExtension("nautilo-design");
    if (!extension || !isDirectMutationLiveReviewExtension(extension)) {
      throw new Error("expected registered Design direct-mutation extension");
    }
    const originalRebase = extension.rebaseStaleDirectMutation;
    try {
      (extension as {
        rebaseStaleDirectMutation: NonNullable<typeof extension.rebaseStaleDirectMutation>;
      }).rebaseStaleDirectMutation = ({ frozenArgs }) => {
        const preconditions = frozenArgs["preconditions"] as Array<{ mode?: string }>;
        if (preconditions[0]?.mode === "conflict") {
          return {
            status: "semantic_conflict",
            conflicts: [{ handle: "node:target", propertyGroups: ["appearance"] }],
            conflictCount: 1,
            omittedConflictCount: 0,
          };
        }
        if (preconditions[0]?.mode === "hostile") {
          return {
            status: "semantic_conflict",
            conflicts: [
              ...Array.from({ length: 65 }, (_, index) => ({
                handle: `node:bounded-${index}`,
                propertyGroups: ["appearance"],
              })),
              { handle: "x".repeat(513), propertyGroups: ["appearance"] },
              { handle: "node:too-many-groups", propertyGroups: Array(17).fill("appearance") },
            ],
            conflictCount: Number.MAX_SAFE_INTEGER,
            omittedConflictCount: -1,
          } as never;
        }
        return { status: "allow_current_binding" };
      };

      const root = await makeAppsRoot();
      await writeLiveDesignTestApp(root);
      const catalog = new ToolCatalog();
      const registry = new LiveMiniAppSessionRegistry();
      const revision4 = { kind: "artifact_revision" as const, revision: 4 };
      const revision5 = { kind: "artifact_revision" as const, revision: 5 };
      const revision6 = { kind: "artifact_revision" as const, revision: 6 };
      const designBinding = {
        ...binding,
        appId: "nautilo-design" as const,
        documentVersion: revision4,
      };
      const disjoint = registry.issue(designBinding);
      const conflict = registry.issue(designBinding);
      const hostile = registry.issue(designBinding);
      const raced = registry.issue(designBinding);
      let raceNextRead = false;
      const invokes: unknown[] = [];

      await registerAppToolsForApp(root, "nautilo-design", {
        catalog,
        liveSessionRegistry: registry,
        readLiveCanonical: async (bound) => {
          if (bound.targetKind === "artifact" && bound.documentVersion.revision === revision4.revision) {
            if (raceNextRead) {
              raceNextRead = false;
              registry.refresh(raced.token, revision6, bound);
            }
            return {
              ok: false,
              status: "stale_version",
              currentDocumentVersion: revision5,
              canonicalContent: "trusted-current-canonical",
            };
          }
          return { ok: true, content: "trusted-current-canonical" };
        },
        invoke: async (request): Promise<AppToolInvokeResult> => {
          invokes.push(request.args);
          return { ok: true, result: { ok: true, status: "applied" } };
        },
      });
      const edit = catalog.getToolsForActor(runnerContext()).find((entry) =>
        entry.name === "app_nautilo_design__edit_open_design",
      )!;
      const disjointPreconditions = [{ mode: "disjoint", handle: "node:other" }];
      expect(parseToolResult(await edit.invoke({
        sessionToken: disjoint.token,
        documentVersion: revision4,
        idempotencyKey: "disjoint-v4",
        operations: [{ kind: "create_shape" }],
        preconditions: disjointPreconditions,
      }))).toEqual({ ok: true, status: "applied" });
      expect(invokes).toHaveLength(1);
      expect(invokes[0]).toMatchObject({
        sessionToken: "server-validated-live-session",
        documentVersion: revision5,
        operations: [{ kind: "create_shape" }],
        preconditions: disjointPreconditions,
      });

      const semanticConflict = parseToolResult(await edit.invoke({
        sessionToken: conflict.token,
        documentVersion: revision4,
        idempotencyKey: "conflict-v4",
        operations: [{ kind: "create_shape" }],
        preconditions: [{ mode: "conflict", handle: "node:target" }],
      }));
      expect(semanticConflict).toEqual({
        ok: false,
        status: "semantic_conflict",
        stateChanged: false,
        retrySafe: false,
        conflicts: [{ handle: "node:target", propertyGroups: ["appearance"] }],
        conflictCount: 1,
        omittedConflictCount: 0,
        recovery: { action: "ask_user", reason: "refresh_intent" },
      });
      expect(JSON.stringify(semanticConflict)).not.toContain(conflict.token);
      expect(JSON.stringify(semanticConflict)).not.toContain(designBinding.artifactId);
      expect(JSON.stringify(semanticConflict)).not.toContain(designBinding.documentId);
      expect(JSON.stringify(semanticConflict)).not.toContain("trusted-current-canonical");
      expect(invokes).toHaveLength(1);

      const hostileConflict = parseToolResult(await edit.invoke({
        sessionToken: hostile.token,
        documentVersion: revision4,
        idempotencyKey: "hostile-v4",
        operations: [{ kind: "create_shape" }],
        preconditions: [{ mode: "hostile", handle: "node:target" }],
      })) as {
        conflicts: Array<{ handle: string; propertyGroups: string[] }>;
        conflictCount: number;
        omittedConflictCount: number;
      };
      expect(hostileConflict).toMatchObject({
        ok: false,
        status: "semantic_conflict",
        stateChanged: false,
        retrySafe: false,
        conflictCount: 67,
        omittedConflictCount: 3,
        recovery: { action: "ask_user", reason: "refresh_intent" },
      });
      expect(hostileConflict.conflicts).toHaveLength(64);
      expect(hostileConflict.conflicts.every((entry) =>
        entry.handle.length <= 512 && entry.propertyGroups.length <= 16,
      )).toBe(true);
      expect(JSON.stringify(hostileConflict)).not.toContain(hostile.token);
      expect(JSON.stringify(hostileConflict)).not.toContain(designBinding.artifactId);
      expect(invokes).toHaveLength(1);

      raceNextRead = true;
      expect(parseToolResult(await edit.invoke({
        sessionToken: raced.token,
        documentVersion: revision4,
        idempotencyKey: "race-v4",
        operations: [{ kind: "create_shape" }],
        preconditions: disjointPreconditions,
      }))).toEqual({
        ok: false,
        status: "stale_version",
        stateChanged: false,
        retrySafe: true,
        recovery: { action: "reinspect", documentVersion: revision6 },
      });
      expect(invokes).toHaveLength(1);
    } finally {
      if (originalRebase) {
        (extension as {
          rebaseStaleDirectMutation: NonNullable<typeof extension.rebaseStaleDirectMutation>;
        }).rebaseStaleDirectMutation = originalRebase;
      } else {
        delete (extension as { rebaseStaleDirectMutation?: unknown }).rebaseStaleDirectMutation;
      }
    }
  });

  test("isolates Design idempotency keys by live session and bound document", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const firstBinding = { ...binding, appId: "nautilo-design" as const };
    const secondBinding = {
      ...firstBinding,
      artifactId: "artifact-2",
      documentId: "document-2",
    };
    const first = registry.issue(firstBinding);
    const second = registry.issue(secondBinding);
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: "{}" }),
      invoke: async (): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: { ok: true, invoke: ++invokes },
      }),
    });
    const edit = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    const common = {
      documentVersion: binding.documentVersion,
      idempotencyKey: "same-public-key",
      operations: [{ kind: "create_shape" }],
    };
    expect(JSON.parse(String(await edit.invoke({ ...common, sessionToken: first.token })))).toEqual({
      ok: true,
      invoke: 1,
    });
    expect(JSON.parse(String(await edit.invoke({ ...common, sessionToken: second.token })))).toEqual({
      ok: true,
      invoke: 2,
    });
  });

  test("releases Design idempotency claims after invoke failures and uncacheable results", async () => {
    const root = await makeAppsRoot();
    await writeLiveDesignTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const designBinding = { ...binding, appId: "nautilo-design" as const };
    const { token } = registry.issue(designBinding);
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-design", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: "{}" }),
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        if (invokes === 1) throw new Error("transport failed");
        if (invokes === 2) {
          return { ok: true, result: { ok: true, summary: "x".repeat(64 * 1024 + 1) } };
        }
        return { ok: true, result: { ok: true, receiptId: "receipt-retry" } };
      },
    });
    const edit = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_design__edit_open_design",
    )!;
    const request = {
      sessionToken: token,
      documentVersion: designBinding.documentVersion,
      idempotencyKey: "recoverable-edit",
      operations: [{ kind: "create_shape" }],
    };
    let thrown: unknown;
    try {
      await edit.invoke(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("transport failed");
    const oversized = String(await edit.invoke(request));
    expect(oversized.length).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(String(await edit.invoke(request)))).toEqual({
      ok: true,
      receiptId: "receipt-retry",
    });
    expect(invokes).toBe(3);
  });

  test("invokes for the bound subject with no or a different runner room and returns a compact token-free envelope", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token, sessionId } = registry.issue(binding);
    let invokes = 0;
    let canonicalReads = 0;
    let workerArgs: unknown;

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => {
        canonicalReads += 1;
        return { ok: true, content: liveWriterCanonical("fresh wording") };
      },
      invoke: async (request): Promise<AppToolInvokeResult> => {
        invokes += 1;
        workerArgs = request.args;
        return {
          ok: true,
          result: {
            ok: true,
            status: "proposal_ready",
            documentVersion: (request.args as { documentVersion: typeof ARTIFACT_VERSION }).documentVersion,
            operations: (request.args as { operations: unknown[] }).operations,
          },
        };
      },
    });

    const [tool] = catalog.getToolsForActor(runnerContext());
    const content = String(await tool!.invoke({
      sessionToken: token,
      documentVersion: binding.documentVersion,
      operations: [operation],
    }));
    expect(JSON.parse(content)).toMatchObject({
      ok: true,
      status: "proposal_ready",
      documentVersion: ARTIFACT_VERSION,
      operations: [operation],
      __nautiloLiveReview: {
        kind: "proposal_ready",
        appId: "nautilo-writer",
        sessionId,
        documentVersion: ARTIFACT_VERSION,
      },
    });
    const firstProposalId =
      (JSON.parse(content) as { __nautiloLiveReview: { proposalId: string } })
        .__nautiloLiveReview.proposalId;
    expect(firstProposalId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(content).not.toContain(token);
    expect(JSON.parse(content)).not.toHaveProperty("sessionToken");
    expect(content).not.toContain(binding.artifactId);
    expect(content).not.toContain(binding.documentId);
    expect(content).not.toContain(binding.namespaceIds[0]!);
    expect(content).not.toContain("\n");
    expect(JSON.stringify(workerArgs)).not.toContain(token);
    expect(workerArgs).not.toBeNull();
    expect(typeof workerArgs).toBe("object");
    const workerRecord = workerArgs as Record<string, unknown>;
    expect(typeof workerRecord["sessionToken"]).toBe("string");
    expect(workerRecord["sessionToken"]).not.toBe(token);
    expect(workerRecord).not.toHaveProperty("sessionId");
    expect(workerRecord["documentVersion"]).toEqual(binding.documentVersion);
    expect(workerRecord["baseRevision"]).toBe(ARTIFACT_VERSION.revision);
    expect(workerRecord["operations"]).toEqual([operation]);
    expect(registry.completeProposalReview({
      sessionId,
      proposalId: firstProposalId,
      outcome: "rejected",
    }).ok).toBe(true);
    const [differentRoomTool] = catalog.getToolsForActor({
      ...runnerContext(),
      roomId: "other-room",
    });
    expect(
      JSON.parse(String(await differentRoomTool!.invoke({
        sessionToken: token,
        documentVersion: binding.documentVersion,
        operations: [operation],
      }))),
    ).toMatchObject({ ok: true, status: "proposal_ready" });
    expect(invokes).toBe(2);
    expect(canonicalReads).toBe(2);
  });

  test("releases a proposal when its Task lifecycle binding cannot be registered", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("fresh wording") }),
      invoke: async (request): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: {
          ok: true,
          status: "proposal_ready",
          documentVersion: (request.args as { documentVersion: typeof ARTIFACT_VERSION }).documentVersion,
          operations: (request.args as { operations: unknown[] }).operations,
        },
      }),
    });

    const backgroundTool = catalog.getToolsForActor(runnerContext({
      currentTaskId: "missing-task-binding",
      currentTaskRunId: "missing-task-run",
    })).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    expect(JSON.parse(String(await backgroundTool.invoke({
      sessionToken: token,
      documentVersion: binding.documentVersion,
      operations: [operation],
    })))).toMatchObject({ ok: false, status: "session_closed" });

    const foregroundTool = catalog.getToolsForActor(runnerContext()).find((entry) =>
      entry.name === "app_nautilo_writer__edit_open_writer",
    )!;
    expect(JSON.parse(String(await foregroundTool.invoke({
      sessionToken: token,
      documentVersion: binding.documentVersion,
      operations: [operation],
    })))).toMatchObject({ ok: true, status: "proposal_ready" });
  });

  test("rejects an ambiguous direct Writer anchor before proposal transport", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    let invokes = 0;

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("ac then ac") }),
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true, status: "proposal_ready" } };
      },
    });

    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    const result = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: binding.documentVersion,
      operations: [{
        kind: "replace",
        blockId: "block-1",
        scope: { kind: "match", anchor: "ac" },
        text: "fixed",
      }],
    }));

    expect(result).toMatchObject({
      ok: false,
      status: "proposal_invalid",
      code: "anchor_ambiguous",
      operationIndex: 0,
    });
    if (!result || typeof result !== "object" || Array.isArray(result) || !("message" in result)) {
      throw new Error("expected proposal_invalid result with a message");
    }
    const { message } = result;
    expect(typeof message).toBe("string");
    if (typeof message === "string") {
      expect(message).toContain("live-review locator tool");
      expect(message).toContain("locator handle");
    }
    expect(invokes).toBe(0);
  });

  test("preflights invalid table proposals before transport and forwards valid ones", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterTableCanonical(true) }),
      invoke: async (request): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true, status: "proposal_ready", documentVersion: ARTIFACT_VERSION, operations: (request.args as { operations: unknown[] }).operations } };
      },
    });
    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    const invalid = parseToolResult(await tool.invoke({
      sessionToken: token, documentVersion: binding.documentVersion,
      operations: [{ kind: "merge-table-cells", tableBlockId: "table-1", start: { rowIndex: 0, colIndex: 0 }, end: { rowIndex: 0, colIndex: 1 } }],
    }));
    expect(invalid).toMatchObject({ ok: false, status: "proposal_invalid", code: "invalid_scope" });
    expect(invokes).toBe(0);

    const valid = parseToolResult(await tool.invoke({
      sessionToken: token, documentVersion: binding.documentVersion,
      operations: [{ kind: "delete-table", tableBlockId: "table-1" }],
    }));
    expect(valid).toMatchObject({ ok: true, status: "proposal_ready" });
    expect(invokes).toBe(1);
  });

  test("denies missing, stale, closed, wrong-user, and wrong-app sessions before invoke", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true } };
      },
    });

    const invokeAs = async (
      context: AppToolRunnerContext,
      sessionToken: string,
      baseRevision = ARTIFACT_VERSION.revision,
    ): Promise<unknown> => {
      const [tool] = catalog.getToolsForActor(context);
      return JSON.parse(String(await tool!.invoke({
        sessionToken,
        documentVersion: baseRevision === ARTIFACT_VERSION.revision
          ? ARTIFACT_VERSION
          : { kind: "artifact_revision", revision: baseRevision },
        operations: [operation],
      })));
    };

    const valid = registry.issue(binding).token;
    expect(await invokeAs(runnerContext(), valid, 8)).toEqual({
      ok: false,
      status: "stale_version",
      stateChanged: false,
      retrySafe: true,
      recovery: { action: "reinspect", documentVersion: ARTIFACT_VERSION },
    });
    expect(await invokeAs({ ...runnerContext(), userId: "other-user" }, valid)).toEqual({
      ok: false,
      status: "session_closed",
    });

    const revoked = registry.issue(binding).token;
    registry.revokeForSubject(revoked, { appId: binding.appId, userId: binding.userId });
    expect(await invokeAs(runnerContext(), revoked)).toEqual({
      ok: false,
      status: "session_closed",
    });

    const wrongApp = registry.issue({ ...binding, appId: "test-canvas" }).token;
    expect(await invokeAs(runnerContext(), wrongApp)).toEqual({
      ok: false,
      status: "session_closed",
    });
    expect(await invokeAs(runnerContext(), "missing-session-token")).toEqual({
      ok: false,
      status: "session_closed",
    });
    expect(invokes).toBe(0);
  });

  test("rejects forbidden operation fields at schema validation before invoke", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true } };
      },
    });
    const [tool] = catalog.getToolsForActor(runnerContext());
    let rejected = false;
    try {
      await tool!.invoke({
        sessionToken: token,
        documentVersion: binding.documentVersion,
        operations: [{ ...operation, oldString: "forbidden" }],
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(invokes).toBe(0);
  });

  test("leaves direct writes to the app-tool host choke point", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    registry.issue(binding);
    const resolvedPaths: string[] = [];
    let invokes = 0;

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      officeCliAvailable: () => true,
      resolveLiveReviewMutationTarget: async (path) => {
        resolvedPaths.push(path);
        return path === "open.html" ? binding.artifactId : "closed-artifact";
      },
      invoke: async (request): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { called: request.tool.id } };
      },
    });

    const tools = new Map(catalog.getToolsForActor(runnerContext()).map((tool) => [tool.name, tool]));
    const invoke = async (name: string, args: unknown) => {
      const tool = tools.get(name);
      expect(tool).toBeDefined();
      return JSON.parse(String(await tool!.invoke(args))) as unknown;
    };

    expect(await invoke("app_nautilo_writer__replace_text", {
      target: { surface: "workspace", path: "open.html" },
    })).toEqual({ called: "replace-text" });
    expect(invokes).toBe(1);

    expect(await invoke("app_nautilo_writer__import_docx", {
      targetPath: "open.html",
    })).toEqual({ called: "import-docx" });
    expect(invokes).toBe(2);

    expect(await invoke("app_nautilo_writer__inspect_document", {
      target: { surface: "workspace", path: "open.html" },
    })).toEqual({ called: "inspect-document" });
    expect(await invoke("app_nautilo_writer__replace_text", {
      target: { surface: "currentFolder", path: "open.html" },
    })).toEqual({ called: "replace-text" });
    expect(await invoke("app_nautilo_writer__replace_text", {
      target: { surface: "workspace", path: "closed.html" },
    })).toEqual({ called: "replace-text" });
    expect(await invoke("app_nautilo_writer__export_docx", {
      source: { surface: "workspace", path: "open.html" },
      target: { surface: "currentFolder", path: "export.docx" },
    })).toEqual({ called: "export-docx" });
    expect(await invoke("app_nautilo_writer__export_docx", {
      source: { surface: "workspace", path: "closed.html" },
      target: { surface: "workspace", path: "open.html" },
    })).toEqual({ called: "export-docx" });
    expect(resolvedPaths).toEqual([]);
    expect(invokes).toBe(7);
  });

  test("allows direct Writer mutations after session revocation or for a different user", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    let invokes = 0;

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      resolveLiveReviewMutationTarget: async () => binding.artifactId,
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true } };
      },
    });

    const args = { target: { surface: "workspace", path: "open.html" } };
    const toolFor = (context: AppToolRunnerContext) =>
      catalog.getToolsForActor(context).find((tool) => tool.name === "app_nautilo_writer__replace_text")!;

    expect(JSON.parse(String(await toolFor({ ...runnerContext(), userId: "other-user" }).invoke(args)))).toEqual({
      ok: true,
    });
    registry.revokeForSubject(token, { appId: binding.appId, userId: binding.userId });
    expect(JSON.parse(String(await toolFor(runnerContext()).invoke(args)))).toEqual({ ok: true });
    expect(invokes).toBe(2);
  });

  test("reads canonical bytes only after a valid bound session and hides locator ranges", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    let reads = 0;
    const seen: unknown[] = [];
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog, liveSessionRegistry: registry,
      readLiveCanonical: async (bound) => {
        reads += 1;
        expect(bound).toMatchObject({
          targetKind: "artifact",
          artifactId: binding.artifactId,
          documentVersion: binding.documentVersion,
        });
        return { ok: true, content: "<canonical>only-server</canonical>" };
      },
      invoke: async (request) => {
        seen.push(request.args);
        if (request.tool.id === "locate-open-writer-text") {
          return { ok: true, result: { ok: true, status: "locator_resolved", documentVersion: ARTIFACT_VERSION, blockId: "block-1", __range: { start: 2, end: 5 } } };
        }
        return { ok: true, result: { ok: true, status: "range_read", documentVersion: ARTIFACT_VERSION, blocks: [] } };
      },
    });
    const tools = new Map(catalog.getToolsForActor(runnerContext()).map((tool) => [tool.name, tool]));
    const range = parseToolResult(await tools.get("app_nautilo_writer__read_open_writer_range")!.invoke({
      sessionToken: token, documentVersion: ARTIFACT_VERSION, blockId: "block-1",
    }));
    expect(range).toMatchObject({ ok: true, status: "range_read" });
    expect(reads).toBe(1);
    expect(seen[0]).toMatchObject({ __canonicalContent: "<canonical>only-server</canonical>" });
    expect(seen[0]).not.toHaveProperty("target");

    const located = parseToolResult(await tools.get("app_nautilo_writer__locate_open_writer_text")!.invoke({
      sessionToken: token, documentVersion: ARTIFACT_VERSION, blockId: "block-1", target: "typo",
    }));
    expect(located).toMatchObject({ ok: true, status: "locator_resolved", blockId: "block-1" });
    expect(located).toHaveProperty("locatorHandle");
    expect(JSON.stringify(located)).not.toContain("__range");
    expect(JSON.stringify(located)).not.toContain("only-server");
  });

  test("records first-party range reread coverage only on the exact verification Task run", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const issued = registry.issue(binding);
    const liveContext = {
      ownerId: binding.userId,
      activeMiniApp: { appId: binding.appId, updatedAt: 1 },
      liveMiniAppSession: {
        appId: binding.appId,
        sessionToken: issued.token,
        sessionId: issued.sessionId,
        documentVersion: ARTIFACT_VERSION,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding("coverage-task", liveContext, () => {
      const current = registry.validateOpenForSubject(issued.token, {
        appId: binding.appId,
        userId: binding.userId,
      });
      return current.ok
        ? { ...liveContext.liveMiniAppSession, documentVersion: current.binding.documentVersion }
        : null;
    })).toBe(true);
    expect(beginTaskWriterReviewVerification({
      taskId: "coverage-task", taskRunId: "coverage-run", ownerId: binding.userId,
    })).toBe(true);
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("verified") }),
      invoke: async (): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: {
          ok: true,
          status: "range_read",
          documentVersion: ARTIFACT_VERSION,
          blocks: [{ id: "block-1", type: "paragraph", text: "verified" }],
        },
      }),
    });
    const tool = catalog.getToolsForActor(runnerContext({
      currentTaskId: "coverage-task",
      currentTaskRunId: "coverage-run",
    })).find((entry) => entry.name === "app_nautilo_writer__read_open_writer_range")!;
    expect(parseToolResult(await tool.invoke({
      sessionToken: issued.token,
      documentVersion: ARTIFACT_VERSION,
      blockId: "block-1",
    }))).toMatchObject({ ok: true, status: "range_read" });
    expect(taskWriterReviewVerificationCoverageState({
      taskId: "coverage-task", taskRunId: "coverage-run", ownerId: binding.userId,
    })).toBe("complete");
  });

  test("preserves typed Writer locator misses without closing the live session", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    const locatorResults = [
      { ok: false, status: "anchor_not_found" },
      { ok: false, status: "anchor_ambiguous" },
      {
        ok: true,
        status: "locator_resolved",
        documentVersion: ARTIFACT_VERSION,
        blockId: "block-1",
        __range: { start: 2, end: 5 },
      },
    ];
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("target") }),
      invoke: async (): Promise<AppToolInvokeResult> => {
        const result = locatorResults[invokes];
        invokes += 1;
        if (!result) throw new Error("unexpected locator invocation");
        return { ok: true, result };
      },
    });

    const tool = catalog.getToolsForActor(runnerContext())
      .find((entry) => entry.name === "app_nautilo_writer__locate_open_writer_text")!;
    const call = () => tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      blockId: "block-1",
      target: "target",
    });

    expect(parseToolResult(await call())).toEqual({ ok: false, status: "anchor_not_found" });
    expect(parseToolResult(await call())).toEqual({ ok: false, status: "anchor_ambiguous" });
    const resolved = parseToolResult(await call());
    expect(resolved).toMatchObject({ ok: true, status: "locator_resolved", blockId: "block-1" });
    expect(resolved).toHaveProperty("locatorHandle");
    expect(invokes).toBe(3);
  });

  test("rejects closed/stale before canonical read and substitutes only matching locator handles", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token, sessionId } = registry.issue(binding);
    const handle = registry.issueLocator(sessionId, ARTIFACT_VERSION, { blockId: "block-1", start: 2, end: 5 });
    let reads = 0;
    const operations: unknown[] = [];
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog, liveSessionRegistry: registry,
      readLiveCanonical: async () => { reads += 1; return { ok: true, content: liveWriterCanonical("fixed") }; },
      invoke: async (request) => {
        operations.push((request.args as { operations?: unknown[] }).operations?.[0]);
        return { ok: true, result: { ok: true, status: "proposal_ready", documentVersion: ARTIFACT_VERSION, operations: (request.args as { operations: unknown[] }).operations } };
      },
    });
    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    const call = (
      sessionToken: string,
      documentVersion: typeof ARTIFACT_VERSION | { kind: "artifact_revision"; revision: number },
      blockId = "block-1",
      locatorHandle = handle,
    ) =>
      tool.invoke({
        sessionToken,
        documentVersion,
        operations: [{ kind: "replace", blockId, scope: { kind: "locator", handle: locatorHandle }, text: "fixed" }],
      });
    expect(JSON.parse(String(await call(token, { kind: "artifact_revision", revision: 8 })))).toEqual({
      ok: false,
      status: "stale_version",
      stateChanged: false,
      retrySafe: true,
      recovery: { action: "reinspect", documentVersion: ARTIFACT_VERSION },
    });
    expect(reads).toBe(0);
    expect(JSON.parse(String(await call("forged-token", ARTIFACT_VERSION)))).toEqual({ ok: false, status: "session_closed" });
    expect(reads).toBe(0);
    const result = parseToolResult(await call(token, ARTIFACT_VERSION));
    expect(result).toMatchObject({ ok: true, status: "proposal_ready" });
    expect(operations[0]).toMatchObject({ scope: { kind: "range", start: 2, end: 5 } });
    expect(JSON.parse(String(await call(token, ARTIFACT_VERSION, "other-block")))).toEqual({ ok: false, status: "session_closed" });
    expect(JSON.parse(String(await call(token, ARTIFACT_VERSION, "block-1", "x".repeat(43))))).toEqual({ ok: false, status: "session_closed" });
  });

  test("preflights base ranges and permits independent same-block locator edits", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token, sessionId } = registry.issue(binding);
    const handle = registry.issueLocator(sessionId, ARTIFACT_VERSION, { blockId: "block-1", start: 1, end: 2 });
    let invokes = 0;
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("abcdef") }),
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true, status: "proposal_ready", documentVersion: ARTIFACT_VERSION } };
      },
    });
    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;

    const sequential = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      operations: [
        { kind: "replace", blockId: "block-1", scope: { kind: "range", start: 1, end: 2 }, text: "LONG" },
        { kind: "replace", blockId: "block-1", scope: { kind: "range", start: 4, end: 6 }, text: "X" },
      ],
    }));
    expect(sequential).toMatchObject({ ok: true, status: "proposal_ready" });
    expect(invokes).toBe(1);

    const locatorBatch = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      operations: [
        { kind: "replace", blockId: "block-1", scope: { kind: "range", start: 0, end: 1 }, text: "!" },
        { kind: "replace", blockId: "block-1", scope: { kind: "locator", handle }, text: "X" },
      ],
    }));
    expect(locatorBatch).toMatchObject({ ok: true, status: "proposal_ready" });
    expect(invokes).toBe(2);

    const conflict = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      operations: [
        { kind: "replace", blockId: "block-1", scope: { kind: "range", start: 0, end: 3 }, text: "!" },
        { kind: "replace", blockId: "block-1", scope: { kind: "range", start: 2, end: 4 }, text: "X" },
      ],
    }));
    expect(conflict).toMatchObject({
      ok: false,
      status: "proposal_invalid",
      code: "proposal_conflict",
      operationIndex: 1,
      conflictingOperationIndexes: [0, 1],
    });
    expect(invokes).toBe(2);
  });

  test("fails closed for a missing opt-in or an unregistered extension without invoking app semantics", async () => {
    const root = await makeAppsRoot();
    const catalog = new ToolCatalog();
    let invokes = 0;

    await writeLiveWriterTestApp(root, { liveReview: false });
    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true } };
      },
    });
    const missingOptIn = catalog.getToolsForActor(runnerContext())
      .find((tool) => tool.name === "app_nautilo_writer__edit_open_writer");
    expect(missingOptIn).toBeDefined();
    expect(parseToolResult(await missingOptIn!.invoke({
      sessionToken: "untrusted",
      documentVersion: binding.documentVersion,
      operations: [operation],
    }))).toEqual({ ok: false, status: "session_closed" });

    await writeLiveWriterTestApp(root, { appId: "unregistered-review" });
    await registerAppToolsForApp(root, "unregistered-review", {
      catalog,
      invoke: async (): Promise<AppToolInvokeResult> => {
        invokes += 1;
        return { ok: true, result: { ok: true } };
      },
    });
    const unregistered = catalog.getToolsForActor(runnerContext())
      .find((tool) => tool.name === "app_unregistered_review__edit_open_writer");
    expect(unregistered).toBeDefined();
    expect(parseToolResult(await unregistered!.invoke({
      sessionToken: "untrusted",
      documentVersion: binding.documentVersion,
      operations: [operation],
    }))).toEqual({ ok: false, status: "session_closed" });
    expect(invokes).toBe(0);
  });

  test("wraps extension exceptions as a compact platform gate failure before worker invocation", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);
    const extension = getLiveReviewExtension("nautilo-writer");
    if (!extension) throw new Error("expected registered live-review extension");
    const originalPreflight = extension.preflightProposal;
    let invokes = 0;

    try {
      (extension as { preflightProposal: typeof extension.preflightProposal }).preflightProposal = () => {
        throw new Error("extension implementation detail");
      };
      await registerAppToolsForApp(root, "nautilo-writer", {
        catalog,
        liveSessionRegistry: registry,
        readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("fresh wording") }),
        invoke: async (): Promise<AppToolInvokeResult> => {
          invokes += 1;
          return { ok: true, result: { ok: true } };
        },
      });
      const tool = catalog.getToolsForActor(runnerContext())
        .find((entry) => entry.name === "app_nautilo_writer__edit_open_writer");
      expect(parseToolResult(await tool!.invoke({
        sessionToken: token,
        documentVersion: binding.documentVersion,
        operations: [operation],
      }))).toEqual({ ok: false, status: "session_closed" });
      expect(invokes).toBe(0);
    } finally {
      (extension as { preflightProposal: typeof extension.preflightProposal }).preflightProposal = originalPreflight;
    }
  });

  test("preflights Current Folder sessions through the injected pinned canonical reader only", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(currentFileBinding);
    let localReads = 0;

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonicalCurrentFile: async (bound) => {
        localReads += 1;
        expect(bound.localTargetId).toBe(currentFileBinding.localTargetId);
        expect(bound.relayId).toBe(currentFileBinding.relayId);
        if (bound.documentVersion.sha256 !== LOCAL_VERSION.sha256) {
          return { ok: false, status: "stale_version" };
        }
        return { ok: true, content: liveWriterCanonical("local canonical") };
      },
      invoke: async (request): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: {
          ok: true,
          status: "proposal_ready",
          documentVersion: (request.args as { documentVersion: typeof LOCAL_VERSION }).documentVersion,
          operations: (request.args as { operations: unknown[] }).operations,
        },
      }),
    });

    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    const accepted = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: LOCAL_VERSION,
      operations: [{
        kind: "replace",
        blockId: "block-1",
        text: "updated local",
        scope: { kind: "match", anchor: "local canonical" },
      }],
    }));
    expect(accepted).toMatchObject({
      ok: true,
      status: "proposal_ready",
      __nautiloLiveReview: {
        documentVersion: LOCAL_VERSION,
      },
    });
    expect(localReads).toBe(1);
    expect(JSON.stringify(accepted)).not.toContain(currentFileBinding.canonicalPath);
    expect(JSON.stringify(accepted)).not.toContain(currentFileBinding.relayId);
    expect(JSON.stringify(accepted)).not.toContain(currentFileBinding.localTargetId);
  });

  test("rejects Current Folder SHA drift as stale_version", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(currentFileBinding);

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonicalCurrentFile: async () => ({
        ok: true,
        content: liveWriterCanonical("local canonical"),
      }),
      invoke: async (): Promise<AppToolInvokeResult> => ({ ok: true, result: { ok: true } }),
    });

    const tool = catalog.getToolsForActor(runnerContext()).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    expect(parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: { kind: "local_sha", sha256: "d".repeat(64) },
      operations: [operation],
    }))).toEqual({ ok: false, status: "stale_version" });
  });

  test("registers proposal lineage with the real Agent turn and omits authority fields from the stamp", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token, sessionId } = registry.issue(binding);

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("fresh wording") }),
      invoke: async (request): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: {
          ok: true,
          status: "proposal_ready",
          documentVersion: ARTIFACT_VERSION,
          operations: (request.args as { operations: unknown[] }).operations,
        },
      }),
    });

    const tool = catalog.getToolsForActor(runnerContext({ turnId: "turn-real-42" })).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    const parsed = parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      operations: [operation],
    })) as {
      __nautiloLiveReview?: { proposalId?: string };
    };
    const proposalId = parsed.__nautiloLiveReview?.proposalId;
    expect(typeof proposalId).toBe("string");
    const lookup = registry.lookupProposal({
      sessionId,
      proposalId: proposalId!,
      documentVersion: ARTIFACT_VERSION,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.record.agentId).toBe("agent-1");
    expect(lookup.record.turnId).toBe("turn-real-42");
    expect(lookup.record.operations.length).toBeGreaterThan(0);
    expect(lookup.record.operationMetadata.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed)).not.toContain(token);
    expect(JSON.stringify(parsed)).not.toContain(binding.artifactId);
    expect(JSON.stringify(parsed)).not.toContain(binding.namespaceIds[0]!);
    expect(JSON.stringify(parsed.__nautiloLiveReview)).not.toContain("turn-real-42");
  });

  test("fails closed when proposal registration lacks a non-empty Agent turnId", async () => {
    const root = await makeAppsRoot();
    await writeLiveWriterTestApp(root);
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const { token } = registry.issue(binding);

    await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: liveWriterCanonical("fresh wording") }),
      invoke: async (): Promise<AppToolInvokeResult> => ({
        ok: true,
        result: { ok: true, status: "proposal_ready", documentVersion: ARTIFACT_VERSION, operations: [operation] },
      }),
    });

    const tool = catalog.getToolsForActor(runnerContext({ turnId: "" })).find((entry) => entry.name === "app_nautilo_writer__edit_open_writer")!;
    expect(parseToolResult(await tool.invoke({
      sessionToken: token,
      documentVersion: ARTIFACT_VERSION,
      operations: [operation],
    }))).toEqual({ ok: false, status: "session_closed" });
  });
});

describe("jsonSchemaToZod", () => {
  test("converts required and optional object properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string" },
        includeCells: { type: "boolean" },
      },
      required: ["target"],
    });

    expect(schema.safeParse({ target: "Budget.html", includeCells: true }).success).toBe(true);
    expect(schema.safeParse({ includeCells: true }).success).toBe(false);
    expect(schema.safeParse({ target: "Budget.html", extra: true }).success).toBe(false);
  });

  test("converts strict discriminated oneOf branches and preserves bounds", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      additionalProperties: false,
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { const: "replace" },
                  text: { type: "string", maxLength: 5 },
                },
                required: ["kind", "text"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { const: "delete" },
                },
                required: ["kind"],
              },
            ],
          },
        },
      },
      required: ["operations"],
    });

    expect(schema.safeParse({ operations: [{ kind: "replace", text: "short" }] }).success).toBe(true);
    expect(schema.safeParse({ operations: [{ kind: "delete" }] }).success).toBe(true);
    expect(schema.safeParse({ operations: [{ kind: "replace", text: "too-long" }] }).success).toBe(false);
    expect(schema.safeParse({ operations: [{ kind: "delete", text: "extra" }] }).success).toBe(false);
    expect(schema.safeParse({ operations: [{ kind: "unknown" }] }).success).toBe(false);
    expect(schema.safeParse({ operations: [] }).success).toBe(false);
  });

  test("keeps the production Writer review replacement discriminator unambiguous", async () => {
    const manifest = await Bun.file(join(
      import.meta.dirname,
      "../../../first-party-apps/writer/app.json",
    )).json() as {
      agent: {
        instructions: string;
        tools: Array<{ id: string; description: string; inputSchema: Record<string, unknown> }>;
      };
    };
    const edit = manifest.agent.tools.find((tool) => tool.id === "edit-open-writer");
    if (!edit) throw new Error("expected Writer edit-open-writer tool");

    expect(edit.description).toContain('operations[].kind to exact "replace"');
    expect(edit.description).toContain('never "replace_text"');
    expect(manifest.agent.instructions).toContain(
      "When edit-open-writer returns proposal_ready, stop calling tools and end the current run",
    );
    expect(manifest.agent.instructions).toContain(
      "Never search for or call a separate apply/save tool",
    );
    expect((edit.inputSchema as {
      properties?: { operations?: { maxItems?: unknown } };
    }).properties?.operations?.maxItems).toBeUndefined();
    const schema = jsonSchemaToZod(edit.inputSchema);
    const base = {
      sessionToken: "writer-session",
      documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
      blockId: "paragraph-1",
      scope: { kind: "locator", handle: "h".repeat(32) },
      text: "corrected",
    };
    expect(schema.safeParse({
      sessionToken: base.sessionToken,
      documentVersion: base.documentVersion,
      operations: [{ kind: "replace", blockId: base.blockId, scope: base.scope, text: base.text }],
    }).success).toBe(true);
    // The production manifest is the actual model-facing catalog contract:
    // complete-document work must not regain the retired 20-op ceiling here.
    expect(schema.safeParse({
      sessionToken: base.sessionToken,
      documentVersion: base.documentVersion,
      operations: Array.from({ length: 21 }, () => ({
        kind: "replace", blockId: base.blockId, scope: base.scope, text: base.text,
      })),
    }).success).toBe(true);
    expect(schema.safeParse({
      sessionToken: base.sessionToken,
      documentVersion: base.documentVersion,
      operations: [{ kind: "replace_text", blockId: base.blockId, scope: base.scope, text: base.text }],
    }).success).toBe(false);
  });

  test("registers the Design create-file contract without path, room, or open authority", async () => {
    const manifest = await Bun.file(join(
      import.meta.dirname,
      "../../../first-party-apps/design/app.json",
    )).json() as {
      agent: { tools: Array<{ id: string; inputSchema: Record<string, unknown> }> };
    };
    const create = manifest.agent.tools.find((tool) => tool.id === "create-file");
    if (!create) throw new Error("expected Design create-file tool");
    const schema = jsonSchemaToZod(create.inputSchema);

    expect(schema.safeParse({
      targetSurface: "workspace",
      filename: "Hero.design.html",
    }).success).toBe(true);
    expect(schema.safeParse({
      targetSurface: "currentFolder",
      filename: "Hero.design.html",
      initialContent: "empty",
    }).success).toBe(true);
    for (const request of [
      { targetSurface: "workspace", filename: "Hero.design.html", roomId: "room-forged" },
      { targetSurface: "workspace", filename: "Hero.design.html", path: "forged/Hero.design.html" },
      { targetSurface: "workspace", filename: "Hero.design.html", openAfterCreate: true },
      { targetSurface: "workspace", filename: ".design.html" },
      { targetSurface: "workspace", filename: `${"x".repeat(256)}.design.html` },
      { targetSurface: "other", filename: "Hero.design.html" },
    ]) {
      expect(schema.safeParse(request).success).toBe(false);
    }
  });

  test("converts strict op-discriminated Design operations without accepting cross-family fields", async () => {
    const manifest = await Bun.file(join(
      import.meta.dirname,
      "../../../first-party-apps/design/app.json",
    )).json() as {
      agent: { tools: Array<{ id: string; inputSchema: Record<string, unknown> }> };
    };
    const edit = manifest.agent.tools.find((tool) => tool.id === "edit-open-design");
    if (!edit) throw new Error("expected Design edit-open-design tool");
    const schema = jsonSchemaToZod(edit.inputSchema);
    const base = {
      preconditions: [],
    };
    const operations = [
      { op: "create", ref: "$created", pageId: "page:page-1", parentId: null, node: { type: "rectangle" } },
      { op: "create", ref: "$shape", pageId: "page:page-1", parentId: null, node: { type: "diamond", x: 0, y: 0, width: 20, height: 20, name: "Diamond" } },
      { op: "path", ref: "$path", pageId: "page:page-1", parentId: null, commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }], bounds: { x: 0, y: 0, width: 20, height: 20 } },
      { op: "transform", updates: [{ nodeId: "$created", x: 10 }] },
      { op: "rotate", nodeIds: ["$created"], rotation: 15 },
      { op: "rename", nodeId: "$created", name: "Card" },
      { op: "text", nodeId: "$created", patch: { text: "Hello" } },
      { op: "style", nodeIds: ["$created"], patch: { fills: [{ kind: "solid", color: "#fff" }] } },
      { op: "align", nodeIds: ["$created", "$shape"], axis: "horizontal", mode: "center" },
      { op: "distribute", nodeIds: ["$created", "$shape", "$path"], axis: "vertical" },
      { op: "reorder", parentId: null, pageId: "page:page-1", orderedIds: ["$created"] },
      { op: "boolean", ref: "$combined", nodeIds: ["$created", "$shape"], opName: "union" },
      { op: "page", ref: "$page", name: "Second" },
      { op: "connector", ref: "$connector", pageId: "page:page-1", parentId: null, connector: { route: "straight", start: { x: 0, y: 0 }, end: { x: 20, y: 20 } } },
      { op: "connector-update", nodeId: "$connector", patch: { route: "elbow" } },
      { op: "delete", nodeIds: ["$created"] },
    ];

    for (const operation of operations) {
      expect(schema.safeParse({ ...base, operations: [operation] }).success).toBe(true);
    }
    expect(schema.safeParse({
      ...base,
      sessionToken: "model-visible-token",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      idempotencyKey: "model-visible-key",
      operations: [operations[0]],
    }).success).toBe(false);
    for (const operation of [
      { op: "rotate", nodeIds: [], rotation: 0 },
      { op: "style", nodeIds: [], patch: { opacity: 1 } },
      { op: "align", nodeIds: ["$created"], axis: "horizontal", mode: "center" },
      { op: "distribute", nodeIds: ["$created", "$shape"], axis: "vertical" },
      { op: "reorder", parentId: "$created", orderedIds: [] },
      { op: "boolean", nodeIds: ["$created"], opName: "union" },
      { op: "delete", nodeIds: [] },
    ]) {
      expect(schema.safeParse({ ...base, operations: [operation] }).success).toBe(false);
    }
    expect(schema.safeParse({
      ...base,
      operations: [
        { op: "create", ref: "$card", pageId: "page:page-1", parentId: null, node: { type: "text" } },
        { op: "style", nodeIds: ["$card"], patch: { fills: [{ kind: "solid", color: "#2563eb" }] } },
        { op: "rename", nodeId: "$card", name: "Launch card" },
        { op: "text", nodeId: "$card", patch: { text: "Ship it" } },
      ],
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      operations: [{
        op: "create",
        ref: "$created",
        pageId: "page:page-1",
        parentId: null,
        nodeId: "$created",
        node: { type: "rectangle" },
      }],
    }).success).toBe(false);
  });

  test("keeps OpenAI- and OpenRouter-shaped Design creation payloads schema/runtime equivalent", async () => {
    const manifest = await Bun.file(join(
      import.meta.dirname,
      "../../../first-party-apps/design/app.json",
    )).json() as {
      agent: { tools: Array<{ id: string; inputSchema: Record<string, unknown> }> };
    };
    const edit = manifest.agent.tools.find((tool) => tool.id === "edit-open-design");
    if (!edit) throw new Error("expected Design edit-open-design tool");
    const schema = jsonSchemaToZod(edit.inputSchema);
    const providerPayloads = [
      {
        provider: "openai-sol",
        payload: {
          preconditions: [],
          operations: [{
            op: "create",
            pageId: "page:page-1",
            parentId: null,
            node: {
              type: "ellipse",
              name: "Pelican wheel",
              x: 20,
              y: 30,
              width: 80,
              height: 80,
              style: { stroke: null },
            },
          }],
        },
      },
      {
        provider: "openrouter-claude",
        payload: {
          preconditions: [],
          operations: [{
            op: "create",
            pageId: "page:page-1",
            parentId: null,
            node: {
              type: "line",
              name: "Reverse spoke",
              start: { x: 200, y: 140 },
              end: { x: 80, y: 40 },
            },
          }],
        },
      },
    ] as const;

    for (const { provider, payload } of providerPayloads) {
      const wirePayload: unknown = JSON.parse(JSON.stringify(payload));
      expect(schema.safeParse(wirePayload).success).toBe(true);
      if (
        wirePayload === null ||
        typeof wirePayload !== "object" ||
        !Array.isArray((wirePayload as Record<string, unknown>)["operations"])
      ) {
        throw new Error(`${provider} payload did not survive JSON serialization`);
      }
      expect(editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${provider}-parity-v1`,
        operations: (wirePayload as Record<string, unknown>)["operations"],
      })).toMatchObject({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// OfficeCLI platform-gate: tools declaring officeTransform are hidden from the
// registered agent-tool set when OfficeCLI is unavailable on the host.
// ---------------------------------------------------------------------------

function docxToolManifest() {
  return {
    id: "nautilo-writer",
    name: "Writer",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: {
      document: {
        artifact: "readwrite",
        currentFolder: "readwrite",
      },
      state: "readwrite",
      office: "convert",
    },
    agent: {
      tools: [
        {
          id: "inspect-document",
          description: "Inspect a Writer document outline.",
          runtime: "server",
          module: "./agent-tools.ts",
          handler: "inspectDocument",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              target: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
            required: ["target"],
          },
          impact: "read-only",
          requiredCapability: null,
          resultScanPolicy: "never",
        },
        {
          id: "import-docx",
          description: "Import a .docx file from the current folder into the workspace.",
          runtime: "server",
          module: "./agent-tools.ts",
          handler: "importDocx",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: {
                type: "object",
                properties: { relativePath: { type: "string" } },
                required: ["relativePath"],
              },
              targetPath: { type: "string" },
            },
            required: ["source", "targetPath"],
          },
          impact: "high",
          requiredCapability: "use_project_content",
          resultScanPolicy: "on-suspicious",
          officeTransform: { format: "docx", operation: "import" },
        },
        {
          id: "export-docx",
          description: "Export a workspace Writer HTML artifact to a .docx file.",
          runtime: "server",
          module: "./agent-tools.ts",
          handler: "exportDocx",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
              target: {
                type: "object",
                properties: { relativePath: { type: "string" } },
                required: ["relativePath"],
              },
            },
            required: ["source", "target"],
          },
          impact: "high",
          requiredCapability: "use_project_content",
          resultScanPolicy: "on-suspicious",
          officeTransform: { format: "docx", operation: "export" },
        },
      ],
    },
  };
}

async function writeDocxTestApp(root: string): Promise<void> {
  const appDir = join(root, "nautilo-writer");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(docxToolManifest(), null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(
    join(appDir, "agent-tools.ts"),
    [
      "export function inspectDocument(args) { return { ok: true, args }; }",
      "export function importDocx(args) { return { ok: true, args }; }",
      "export function exportDocx(args) { return { ok: true, args }; }",
      "",
    ].join("\n"),
  );
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

async function writeGenericOfficeTransformTestApp(root: string): Promise<void> {
  const appDir = join(root, "workbook-tools");
  await mkdir(appDir, { recursive: true });
  const appManifest = manifest();
  Object.assign(appManifest, {
    id: "workbook-tools",
    name: "Workbook Tools",
    capabilities: { ...appManifest.capabilities, office: "convert" },
  });
  const baseTool = appManifest.agent.tools[0];
  if (!baseTool) throw new Error("test manifest requires its ordinary tool");
  const officeTool = {
    ...baseTool,
    id: "convert-workbook",
    description: "Import an XLSX workbook.",
    handler: "convertWorkbook",
  };
  Object.assign(officeTool, {
    officeTransform: { format: "xlsx", operation: "import" },
  });
  appManifest.agent.tools.push(officeTool);
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(appManifest, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(
    join(appDir, "agent-tools.ts"),
    [
      "export function inspectDocument(args) { return { ok: true, args }; }",
      "export function convertWorkbook(args) { return { ok: true, args }; }",
      "",
    ].join("\n"),
  );
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
}

describe("app tool registration — OfficeCLI platform-gate (D391)", () => {
  test("hides declared DOCX transformations when officeCliAvailable() is false; keeps ordinary tools", async () => {
    const root = await makeAppsRoot();
    await writeDocxTestApp(root);
    const catalog = new ToolCatalog();

    const result = await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      officeCliAvailable: () => false,
      invoke: async (request): Promise<AppToolInvokeResult> => {
        return { ok: true, result: { called: request.tool.id } };
      },
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.toolCount).toBe(1);
    expect(result.toolNames).toEqual(["app_nautilo_writer__inspect_document"]);

    expect(catalog.has("app_nautilo_writer__inspect_document")).toBe(true);
    expect(catalog.has("app_nautilo_writer__import_docx")).toBe(false);
    expect(catalog.has("app_nautilo_writer__export_docx")).toBe(false);
  });

  test("registers declared DOCX transformations when officeCliAvailable() is true", async () => {
    const root = await makeAppsRoot();
    await writeDocxTestApp(root);
    const catalog = new ToolCatalog();

    const result = await registerAppToolsForApp(root, "nautilo-writer", {
      catalog,
      officeCliAvailable: () => true,
      invoke: async (request): Promise<AppToolInvokeResult> => {
        return { ok: true, result: { called: request.tool.id } };
      },
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.toolCount).toBe(3);
    expect(result.toolNames).toContain("app_nautilo_writer__inspect_document");
    expect(result.toolNames).toContain("app_nautilo_writer__import_docx");
    expect(result.toolNames).toContain("app_nautilo_writer__export_docx");
    expect(catalog.has("app_nautilo_writer__import_docx")).toBe(true);
    expect(catalog.has("app_nautilo_writer__export_docx")).toBe(true);
  });

  test("gates an app-generic XLSX transformation by metadata rather than tool id", async () => {
    const root = await makeAppsRoot();
    await writeGenericOfficeTransformTestApp(root);
    const catalog = new ToolCatalog();

    const result = await registerAppToolsForApp(root, "workbook-tools", {
      catalog,
      officeCliAvailable: () => false,
    });

    expect(result).toMatchObject({
      status: "registered",
      toolCount: 1,
      toolNames: ["app_workbook_tools__inspect_document"],
    });
    expect(catalog.has("app_workbook_tools__convert_workbook")).toBe(false);
  });

  test("does not infer an OfficeCLI dependency from a DOCX-like tool id without metadata", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "sheet");
    await mkdir(appDir, { recursive: true });
    const appManifest = manifest();
    appManifest.agent.tools[0]!.id = "import-docx";
    await writeFile(join(appDir, "app.json"), `${JSON.stringify(appManifest, null, 2)}\n`);
    await writeFile(join(appDir, "main.ts"), "export {};\n");
    await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
    await writeFile(
      join(appDir, "agent-tools.ts"),
      "export function inspectDocument(args) { return { ok: true, args }; }\n",
    );
    await writeFile(join(appDir, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
    const catalog = new ToolCatalog();

    const result = await registerAppToolsForApp(root, "sheet", {
      catalog,
      officeCliAvailable: () => false,
    });

    expect(result).toMatchObject({
      status: "registered",
      toolCount: 1,
      toolNames: ["app_sheet__import_docx"],
    });
    expect(catalog.has("app_sheet__import_docx")).toBe(true);
  });

  test("does not gate non-docx apps when OfficeCLI is unavailable", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const catalog = new ToolCatalog();

    const result = await registerAppToolsForApp(root, "sheet", {
      catalog,
      officeCliAvailable: () => false,
      invoke: async (request): Promise<AppToolInvokeResult> => {
        return { ok: true, result: { called: request.tool.id } };
      },
    });

    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.toolCount).toBe(1);
    expect(result.toolNames).toEqual(["app_sheet__inspect_document"]);
    expect(catalog.has("app_sheet__inspect_document")).toBe(true);
  });
});
