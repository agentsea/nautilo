import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { liveAppCommandBroker } from "../../src/apps/live-app-command-broker";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueLiveMiniAppSessionRequest } from "@nautilo/types";
import {
  claimTaskWriterReviewAcceptance,
  failTaskWriterReviewAcceptedContinuation,
  failTaskWriterReviewsForSession,
  finishTaskWriterReviewModel,
  isPendingTaskWriterReviewProposal,
  registerTaskLiveMiniAppBinding,
  registerTaskWriterReviewProposal,
  releaseTaskWriterReviewAcceptanceClaim,
  resolveTaskWriterReviewProposal,
  taskWriterReviewProposalState,
  taskReturnBindingRegistryForTests,
} from "@nautilo/runtime";
import {
  appRoutes,
  type AppRoutesDeps,
  type LiveReviewLifecyclePort,
} from "../../src/apps/app-routes";
import { invokeAppTool } from "../../src/apps/app-tool-runner";
import { clearAppSourceEventListenersForTests } from "../../src/apps/app-source-events";
import { validateMiniAppManifest } from "../../src/apps/app-manifest";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { LiveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import { LiveLocalDocumentAuthority } from "../../src/apps/live-local-document-authority";
import { resetInstalledAppRegistryForTests } from "../../src/apps/installed-app-registry";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";
import { VideoHostAttestationRegistry } from "../../src/apps/video-host-attestation-registry";

const FIRST_PARTY_ROOT = join(import.meta.dirname, "../../../../packages/first-party-apps");

let appsRoot = "";
let app: FastifyInstance;
let liveSessionNow = 1_000;
let liveSessionRegistry: LiveMiniAppSessionRegistry;
let conversionInvoke: AppRoutesDeps["invokeAppTool"];

const USER_WITH_MANAGE = "user-manage";
const USER_WITHOUT_MANAGE = "user-readonly";
const USER_WITH_SETTINGS_ONLY = "user-settings-only";
const TEST_ROOM_ID = "33333333-3333-4333-8333-333333333333";

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function writerHtml(blocks: unknown[]): string {
  return `<!doctype html><html><head>
<script type="application/vnd.nautilo.document+json" id="manifest">${JSON.stringify({
    documentType: "document",
    editor: "wafflebase",
    payloadId: "wafflebase-document",
    payloadFormat: "application/vnd.wafflebase.document+json",
    version: "1.0",
  })}</script>
<script type="application/vnd.wafflebase.document+json" id="wafflebase-document">${JSON.stringify({ blocks })}</script>
</head><body></body></html>`;
}

function writerParagraph(id: string, text: string): unknown {
  return {
    id,
    type: "paragraph",
    inlines: [{ text, style: {} }],
    style: {},
  };
}

async function writeTestApp(root: string): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(join(appDir, "templates"), { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), '<!doctype html><div id="app"></div>\n');
  await writeFile(join(appDir, "styles.css"), "#app { display: block; }\n");
  await writeFile(
    join(appDir, "templates", "empty-canvas.html"),
    '<!doctype html><script type="application/vnd.nautilo.document+json" id="manifest">{"documentType":"canvas","editor":"test-canvas","payloadId":"test-canvas-document","payloadFormat":"application/vnd.nautilo.test-canvas+json","version":"1.0"}</script>\n',
  );
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await writeFile(
    join(appDir, "agent-tools.ts"),
    `export function createFile() { return { ok: true }; }
export function inspectDocument() { return { ok: true }; }
export function setCells() { return { ok: true }; }
`,
  );
}

async function writeDesignExportApp(root: string): Promise<void> {
  const appDir = join(root, "nautilo-design");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify({
    id: "nautilo-design",
    name: "Design",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: {},
    agent: {
      tools: [{
        id: "export-svg",
        description: "Export a Design SVG.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "exportSvg",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "object", additionalProperties: false, properties: { surface: { type: "string" }, path: { type: "string" } }, required: ["surface", "path"] },
            target: { type: "object", additionalProperties: false, properties: { surface: { type: "string" }, path: { type: "string" } }, required: ["surface", "path"] },
            overwrite: { type: "boolean" },
            scope: { type: "object", additionalProperties: false, properties: { pageHandle: { type: "string" }, nodeHandles: { type: "array", items: { type: "string" } } }, required: ["pageHandle"] },
          },
          required: ["source", "target"],
        },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "never",
      }, {
        id: "export-png",
        description: "Export a Design PNG.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "exportSvg",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "object", additionalProperties: false, properties: { surface: { type: "string" }, path: { type: "string" } }, required: ["surface", "path"] },
            target: { type: "object", additionalProperties: false, properties: { surface: { type: "string" }, path: { type: "string" } }, required: ["surface", "path"] },
            overwrite: { type: "boolean" },
            scope: { type: "object", additionalProperties: false, properties: { pageHandle: { type: "string" }, nodeHandles: { type: "array", items: { type: "string" } } }, required: ["pageHandle"] },
          },
          required: ["source", "target"],
        },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "never",
      }, {
        id: "export-pdf",
        description: "Export a generic PDF.",
        runtime: "server",
        module: "./agent-tools.ts",
        handler: "exportSvg",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        impact: "high",
        requiredCapability: "use_project_content",
        resultScanPolicy: "never",
      }],
    },
    conversions: {
      export: [{
        id: "export-svg",
        label: "SVG",
        to: { extension: ".svg", mimeType: "image/svg+xml" },
        tool: "export-svg",
        targetSurfaces: ["workspace", "currentFolder"],
      }, {
        id: "export-png",
        label: "PNG",
        to: { extension: ".png", mimeType: "image/png" },
        tool: "export-png",
        targetSurfaces: ["workspace", "currentFolder"],
      }, {
        id: "export-pdf",
        label: "PDF",
        to: { extension: ".pdf", mimeType: "application/pdf" },
        tool: "export-pdf",
        targetSurfaces: ["workspace", "currentFolder"],
      }],
    },
  }, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
  await writeFile(join(appDir, "agent-tools.ts"), "export function exportSvg(args: unknown) { return { ok: true, status: 'exported', args }; }\n");
}

async function writeWriterLiveReviewApp(root: string): Promise<void> {
  const appDir = join(root, "nautilo-writer");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify({
    id: "nautilo-writer",
    name: "Writer",
    version: "0.0.1",
    entry: "./main.ts",
    html: "./index.html",
    fileAssociations: {},
    capabilities: {},
    liveReview: { enabled: true },
  }, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><div id=\"app\"></div>\n");
}

async function writeVideoApp(root: string): Promise<void> {
  const appDir = join(root, "nautilo-video");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify({
    id: "nautilo-video", name: "Video", version: "0.1.0", entry: "./main.ts", html: "./index.html",
    styles: ["./styles.css"], fileAssociations: { extensions: [".video.html"], mimeTypes: ["text/html"] }, capabilities: {}, liveReview: { enabled: true },
  })}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(join(appDir, "index.html"), "<!doctype html><main></main>\n");
  await writeFile(join(appDir, "styles.css"), "main{}\n");
}

function installSessionPreHandler(instance: FastifyInstance): void {
  instance.decorateRequest("sessionUserId", null);
  instance.decorateRequest("memoryEnvelope", null);
  instance.addHook("preHandler", (request, _reply, done) => {
    const header = request.headers["x-test-user-id"];
    request.sessionUserId = typeof header === "string" ? header : null;
    if (request.sessionUserId && request.headers["x-test-no-envelope"] !== "true") {
      request.memoryEnvelope =
        request.headers["x-test-scope"] === "true"
          ? ({
              memoryMode: "scope",
              ownerId: request.sessionUserId,
              actorId: request.sessionUserId,
              agentId: "agent-1",
              roomId: TEST_ROOM_ID,
              scopeId: "scope-1",
              toolPolicy: {},
            } as never)
          : ({
              memoryMode: "namespace",
              ownerId: request.sessionUserId,
              actorId: request.sessionUserId,
              agentId: "agent-1",
              ...(request.headers["x-test-no-room"] === "true" ? {} : { roomId: TEST_ROOM_ID }),
              readableNamespaces: ["namespace-1"],
              mutableNamespaces:
                request.headers["x-test-no-mutable"] === "true" ? [] : ["namespace-1"],
              writableNamespaces: ["namespace-1"],
              toolPolicy: {},
            } as never);
    }
    done();
  });
}

beforeEach(async () => {
  taskReturnBindingRegistryForTests.clear();
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-"));
  await writeTestApp(appsRoot);
  await writeDesignExportApp(appsRoot);
  await writeWriterLiveReviewApp(appsRoot);

  app = Fastify({ logger: false });
  liveSessionNow = 1_000;
  liveSessionRegistry = new LiveMiniAppSessionRegistry(() => liveSessionNow, 500);
  conversionInvoke = undefined;
  installSessionPreHandler(app);
  appRoutes(app, {
    appsRoot,
    liveSessionRegistry,
    findArtifactForNamespaces: async ({ internalId, readableNamespaceIds }) =>
      internalId === "artifact-row-1" && readableNamespaceIds.includes("namespace-1")
        ? ({
            id: "artifact-row-1",
            artifactId: "artifact-public-1",
            path: "draft.html",
            storageUri: "file:///not-read",
            mimeType: "text/html",
            size: 10,
            revision: 7,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } as never)
        : null,
    getCapabilities: async (userId) => {
      if (userId === USER_WITH_MANAGE) return ["manage_server_operations"];
      if (userId === USER_WITHOUT_MANAGE) return ["read_server_settings"];
      if (userId === USER_WITH_SETTINGS_ONLY) return ["manage_server_settings"];
      return [];
    },
    invokeAppTool: async (request, options) =>
      conversionInvoke
        ? conversionInvoke(request, options)
        : invokeAppTool(request, options),
    liveReviewLifecycle: {
      isPendingReview: isPendingTaskWriterReviewProposal,
      reviewProposalState: taskWriterReviewProposalState,
      admitAcceptedProposal: claimTaskWriterReviewAcceptance,
      releaseAcceptanceClaim: (input) => {
        releaseTaskWriterReviewAcceptanceClaim(input);
      },
      recordAcceptedReceipt: async () => ({ status: "recorded" }),
      advanceAcceptedReviewContinuation: () => true,
      failAcceptedReviewContinuation: (binding) => {
        return failTaskWriterReviewAcceptedContinuation(
          binding as never,
          "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
        );
      },
      resolveReview: resolveTaskWriterReviewProposal,
      failReview: (input, code) => resolveTaskWriterReviewProposal({
        ...input,
        resolution: { outcome: "failed", code },
      }),
      finalizeReview: async () => {},
      failReviewsForSession: failTaskWriterReviewsForSession,
    },
  });
  await app.ready();
});

afterEach(async () => {
  taskReturnBindingRegistryForTests.clear();
  clearAppSourceEventListenersForTests();
  resetInstalledAppRegistryForTests();
  if (app) await app.close();
  if (appsRoot) await rm(appsRoot, { recursive: true, force: true });
});

describe("/api/apps routes", () => {
  test("workspace placement is forwarded only for opted-in Workspace export actions", async () => {
    const manifestPath = join(appsRoot, "nautilo-design", "app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      conversions: { export: Array<{ id: string; selectWorkspaceDestination?: boolean }> };
      agent: { tools: Array<{ id: string; inputSchema: { properties: Record<string, unknown> } }> };
    };
    manifest.conversions.export.find(entry => entry.id === "export-svg")!.selectWorkspaceDestination = true;
    manifest.agent.tools.find(entry => entry.id === "export-svg")!.inputSchema.properties["workspaceDestination"] = { type: "string", enum: ["current", "source"] };
    expect(validateMiniAppManifest(manifest)).toMatchObject({ ok: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    resetInstalledAppRegistryForTests();
    const payload = { actionId: "export-svg", direction: "export", source: { surface: "workspace", path: "Deck.html" }, target: { surface: "workspace", path: "Deck.svg" } };
    const post = (body: object) => app.inject({ method: "POST", url: "/api/apps/nautilo-design/conversions/run", headers: { "x-test-user-id": USER_WITH_MANAGE }, payload: body });
    for (const workspaceDestination of ["current", "source"]) {
      const result = await post({ ...payload, workspaceDestination });
      expect(result.statusCode).toBe(200);
      expect(result.json<{ result: { args: { workspaceDestination: string } } }>().result.args.workspaceDestination).toBe(workspaceDestination);
    }
    const legacy = await post(payload);
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json<{ result: { args: object } }>().result.args).not.toHaveProperty("workspaceDestination");
    for (const patch of [
      { workspaceDestination: "namespace-id" },
      { workspaceDestination: "current", source: { surface: "currentFolder", path: "Deck.html" } },
      { workspaceDestination: "current", target: { surface: "currentFolder", path: "Deck.svg" } },
      { workspaceDestination: "current", actionId: "export-pdf" },
      { workspaceDestination: "current", direction: "import" },
    ]) expect((await post({ ...payload, ...patch })).statusCode).toBe(400);
  });

  test("prepared exports require the declared action and complete matching bytes", async () => {
    const manifestPath = join(appsRoot, "nautilo-design", "app.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      conversions: { export: Array<{ id: string; prepareInApp?: boolean }> };
      agent: { tools: Array<{ id: string; inputSchema: { properties: Record<string, unknown> } }> };
    };
    manifest.conversions.export.find(entry => entry.id === "export-pdf")!.prepareInApp = true;
    const tool = structuredClone(manifest.agent.tools[0]!);
    tool.id = "export-pdf"; tool.inputSchema.properties["preparedExport"] = {
      type: "object", additionalProperties: false,
      properties: { content: { type: "string" }, encoding: { type: "string" }, mimeType: { type: "string" },
        byteLength: { type: "integer" }, sourceSha256: { type: "string" }, warnings: { type: "array", items: { type: "string" } } },
      required: ["content", "encoding", "mimeType", "byteLength", "sourceSha256", "warnings"],
    };
    manifest.agent.tools = manifest.agent.tools.map(entry => entry.id === "export-pdf" ? tool : entry);
    expect(validateMiniAppManifest(manifest)).toMatchObject({ ok: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    resetInstalledAppRegistryForTests();
    const bytes = Buffer.from("%PDF-placeholder");
    const preparedExport = { content: bytes.toString("base64"), encoding: "base64", mimeType: "application/pdf",
      byteLength: bytes.length, sourceSha256: "a".repeat(64), warnings: ["Raster PDF"] };
    const payload = { actionId: "export-pdf", direction: "export", source: { surface: "workspace", path: "Deck.html" },
      target: { surface: "workspace", path: "Deck.pdf" }, preparedExport };
    const post = (body: unknown) => app.inject({ method: "POST", url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE }, payload: body as object });
    const valid = await post(payload);
    expect(valid.statusCode).toBe(200);
    expect(valid.json<{ result: { args: { preparedExport: unknown } } }>().result.args.preparedExport).toEqual(preparedExport);
    for (const patch of [{ mimeType: "text/html" }, { byteLength: 1 }, { sourceSha256: "bad" }, { content: "%%%" }]) {
      expect((await post({ ...payload, preparedExport: { ...preparedExport, ...patch } })).statusCode).toBe(400);
    }
    expect((await post({ ...payload, preparedExport: undefined })).statusCode).toBe(400);
    expect((await post({ ...payload, actionId: "export-svg" })).statusCode).toBe(400);
    expect((await post({ ...payload, direction: "import" })).statusCode).toBe(400);
  });

  test("conversion rejects an invalid room id instead of falling back to the default namespace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-xlsx",
        direction: "export",
        roomId: "not-a-room",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "roomId must be a valid room id" });
  });

  test("conversion rejects a room id that does not match its authorized envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-xlsx",
        direction: "export",
        roomId: "44444444-4444-4444-8444-444444444444",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>()).toEqual({ error: "Requested room context is unavailable" });
  });

  test("conversion validates and forwards a source warning acknowledgement", async () => {
    const acknowledgedSourceSha256 = "a".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-svg",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.svg" },
        acknowledgedSourceSha256,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ result: { args: Record<string, unknown> } }>().result.args).toMatchObject({
      acknowledgedSourceSha256,
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-svg",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.svg" },
        acknowledgedSourceSha256: "A".repeat(64),
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>()).toEqual({
      error: "acknowledgedSourceSha256 must be a lowercase SHA-256",
    });
  }, 30_000);

  test("conversion forwards a typed Design SVG scope and no iframe-owned host fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-svg",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.svg" },
        scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown>()).toEqual({
      ok: true,
      result: {
        ok: true,
        status: "exported",
        args: {
          source: { surface: "workspace", path: "designs/Hero.design.html" },
          target: { surface: "workspace", path: "designs/Hero.svg" },
          overwrite: false,
          scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
        },
      },
    });
  }, 30_000);

  test("conversion forwards the same typed Design scope to PNG export", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.png" },
        scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown>()).toEqual({
      ok: true,
      result: {
        ok: true,
        status: "exported",
        args: {
          source: { surface: "workspace", path: "designs/Hero.design.html" },
          target: { surface: "workspace", path: "designs/Hero.png" },
          overwrite: false,
          scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
        },
      },
    });
  }, 30_000);

  test("conversion recovers an exported PNG only from one exact matching host mutation receipt", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker timed out after creating the PNG.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt: {
          ok: true,
          artifactPath: "designs/Hero.png",
          sha256: "png-sha",
          byteLength: 77,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs//Hero.png" },
        scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<unknown>()).toEqual({
      ok: true,
      result: {
        ok: true,
        status: "exported",
        artifactPath: "designs/Hero.png",
        displayPath: "designs/Hero.png",
        sha256: "png-sha",
        byteLength: 77,
        scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-7"] },
      },
    });
  });

  test("conversion reports a matching partial PNG write and never recovers it as exported", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker timed out while artifact metadata was being confirmed.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "PNG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Hero.png",
          bytesWritten: 77,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs//Hero.png" },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<unknown>()).toEqual({
      ok: false,
      status: "completed_host_mutation",
      error:
        "Output state changed at designs/Hero.png. Check this file before retrying. Worker timed out while artifact metadata was being confirmed.",
      code: "timeout",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "PNG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Hero.png",
          bytesWritten: 77,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
  });

  test("conversion recovers an exported SVG only from its exact create-document receipt", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker stopped after creating the SVG.",
      code: "runner",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Hero.svg" },
        receipt: {
          ok: true,
          artifactPath: "designs/Hero.svg",
          sha256: "svg-sha",
          byteLength: 123,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-svg",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.svg" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<unknown>()).toEqual({
      ok: true,
      result: {
        ok: true,
        status: "exported",
        artifactPath: "designs/Hero.svg",
        displayPath: "designs/Hero.svg",
        sha256: "svg-sha",
        byteLength: 123,
      },
    });
  });

  test("conversion reports a partial SVG write and never recovers it as exported", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker stopped while SVG artifact metadata was being confirmed.",
      code: "runner",
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Hero.svg" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "SVG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Hero.svg",
          bytesWritten: 123,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-svg",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs//Hero.svg" },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<unknown>()).toEqual({
      ok: false,
      status: "completed_host_mutation",
      error:
        "Output state changed at designs/Hero.svg. Check this file before retrying. Worker stopped while SVG artifact metadata was being confirmed.",
      code: "runner",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [{
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Hero.svg" },
        receipt: {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "SVG bytes were written but artifact metadata was not confirmed.",
          displayPath: "designs/Hero.svg",
          bytesWritten: 123,
          metadataConfirmed: false,
          stateChanged: true,
          retrySafe: false,
        },
      }],
    });
  });

  test("conversion reports changed state when a host mutation receipt targets a different path", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker timed out after an unexpected write.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Other.png" },
        receipt: {
          ok: true,
          artifactPath: "designs/Other.png",
          sha256: "other-sha",
          byteLength: 88,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.png" },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<unknown>()).toEqual({
      ok: false,
      status: "completed_host_mutation",
      error:
        "Confirmed output created at designs/Other.png. Check this file before retrying. Worker timed out after an unexpected write.",
      code: "timeout",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Other.png" },
        receipt: {
          ok: true,
          artifactPath: "designs/Other.png",
          sha256: "other-sha",
          byteLength: 88,
        },
      }],
    });
  });

  test("conversion does not recover when an otherwise matching receipt has an additional mutation", async () => {
    const receipt = {
      ok: true as const,
      artifactPath: "designs/Hero.png",
      sha256: "png-sha",
      byteLength: 77,
    };
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker failed after multiple writes.",
      code: "handler",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt,
      }, {
        method: "document.createDocument",
        target: { surface: "workspace", path: "designs/Unexpected.svg" },
        receipt: { ...receipt, artifactPath: "designs/Unexpected.svg" },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.png" },
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<Record<string, unknown>>()).toMatchObject({
      ok: false,
      status: "completed_host_mutation",
      stateChanged: true,
      retrySafe: false,
      completedHostMutations: [
        { method: "document.createRasterFromSvg" },
        { method: "document.createDocument" },
      ],
      error:
        "Confirmed output created at designs/Hero.png, designs/Unexpected.svg. Check these files before retrying. Worker failed after multiple writes.",
    });
  });

  test("conversion does not conflate whitespace-distinct valid output paths", async () => {
    conversionInvoke = async () => ({
      ok: false,
      error: "Worker timed out after creating an output.",
      code: "timeout",
      completedHostMutations: [{
        method: "document.createRasterFromSvg",
        target: { surface: "workspace", path: "designs/Hero.png" },
        receipt: {
          ok: true,
          artifactPath: "designs/Hero.png",
          sha256: "png-sha",
          byteLength: 77,
        },
      }],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-design/conversions/run",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        actionId: "export-png",
        direction: "export",
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: " designs/Hero.png " },
      },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: string } & Record<string, unknown>>();
    expect(body).toMatchObject({
      status: "completed_host_mutation",
      stateChanged: true,
      retrySafe: false,
    });
    expect(body.error).toContain("designs/Hero.png");
  });

  test("conversion rejects scope outside Design image export and malformed scope fields", async () => {
    const base = {
      method: "POST" as const,
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    };
    const nonDesign = await app.inject({
      ...base,
      url: "/api/apps/nautilo-design/conversions/run",
      payload: {
        actionId: "export-pdf",
        direction: "export",
        source: { surface: "workspace", path: "sheet.xlsx" },
        target: { surface: "workspace", path: "sheet.copy.xlsx" },
        scope: { pageHandle: "page:page-1" },
      },
    });
    expect(nonDesign.statusCode).toBe(400);
    expect(nonDesign.json<{ error: string }>().error).toContain("only supported");

    const importScope = await app.inject({
      ...base,
      url: "/api/apps/test-canvas/conversions/run",
      payload: {
        actionId: "import-csv",
        direction: "import",
        source: { surface: "workspace", path: "sheet.csv" },
        scope: { pageHandle: "page:page-1" },
      },
    });
    expect(importScope.statusCode).toBe(400);
    expect(importScope.json<{ error: string }>().error).toContain("only supported");

    for (const scope of [
      { pageHandle: "page:page-1", nodeHandles: [] },
      { pageHandle: "not-a-page", nodeHandles: ["node:node-1"] },
      { pageHandle: "page:page-1", nodeHandles: ["node:bad/path"] },
      { pageHandle: "page:page-1", target: { surface: "workspace", path: "iframe.svg" } },
    ]) {
      const res = await app.inject({
        ...base,
        url: "/api/apps/nautilo-design/conversions/run",
        payload: {
          actionId: "export-svg",
          direction: "export",
          source: { surface: "workspace", path: "designs/Hero.design.html" },
          target: { surface: "workspace", path: "designs/Hero.svg" },
          scope,
        },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  test("Video host attestation requires the distinct generation capability and exact loaded runtime hash", async () => {
    await writeVideoApp(appsRoot);
    const registry = new VideoHostAttestationRegistry();
    const runtimeApp = Fastify({ logger: false });
    let grantGeneration = false;
    installSessionPreHandler(runtimeApp);
    appRoutes(runtimeApp, {
      appsRoot,
      videoHostAttestationRegistry: registry,
      resolveHostCapabilities: async () => grantGeneration ? { mediaProxy: true, videoGeneration: true } : { mediaProxy: true },
      findArtifactByIdForNamespaces: async () => ({
        id: "artifact-row-video", artifactId: "artifact-video", path: "project.video.html", storageUri: "file:///private",
        mimeType: "text/html", size: 1, revision: 3, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      } as never),
    });
    await runtimeApp.ready();
    try {
      const runtime = await runtimeApp.inject({ method: "GET", url: "/api/apps/nautilo-video/runtime", headers: { "x-test-user-id": USER_WITHOUT_MANAGE } });
      expect(runtime.statusCode).toBe(200);
      const sourceHash = (JSON.parse(runtime.body) as { sourceHash: string }).sourceHash;
      const previewOnly = await runtimeApp.inject({ method: "POST", url: "/api/apps/nautilo-video/video-host-attestation", headers: { "x-test-user-id": USER_WITHOUT_MANAGE }, payload: { roomId: TEST_ROOM_ID, projectArtifactId: "artifact-video", sourceHash } });
      expect(previewOnly.statusCode).toBe(403);
      grantGeneration = true;
      const stale = await runtimeApp.inject({ method: "POST", url: "/api/apps/nautilo-video/video-host-attestation", headers: { "x-test-user-id": USER_WITHOUT_MANAGE }, payload: { roomId: TEST_ROOM_ID, projectArtifactId: "artifact-video", sourceHash: "0".repeat(64) } });
      expect(stale.statusCode).toBe(403);
      const issued = await runtimeApp.inject({ method: "POST", url: "/api/apps/nautilo-video/video-host-attestation", headers: { "x-test-user-id": USER_WITHOUT_MANAGE }, payload: { roomId: TEST_ROOM_ID, projectArtifactId: "artifact-video", sourceHash } });
      expect(issued.statusCode).toBe(200);
      expect((JSON.parse(issued.body) as { attestationToken: string }).attestationToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
    } finally {
      await runtimeApp.close();
    }
  });

  test("anonymous list returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/apps" });
    expect(res.statusCode).toBe(401);
  });

  test("anonymous detail returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/apps/test-canvas" });
    expect(res.statusCode).toBe(401);
  });

  test("verified user list includes test-canvas", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      apps: Array<Record<string, unknown>>;
    };
    const testCanvas = body.apps.find((entry) => entry["id"] === "test-canvas");
    expect(testCanvas).toBeDefined();
    expect(testCanvas?.["name"]).toBe("Test Canvas");
    expect(testCanvas?.["description"]).toBe(TEST_MINI_APP_MANIFEST.description ?? null);
    expect(testCanvas?.["installedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(testCanvas?.["status"]).toBe("ready");
    expect(testCanvas?.["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(testCanvas?.["canEditSource"]).toBe(false);
    expect(testCanvas?.["agentToolsDeclared"]).toBe(true);
    expect((testCanvas?.["createActions"] as Array<Record<string, unknown>>)[0]?.["id"]).toBe("new-canvas");
    expect(JSON.stringify(body)).not.toContain(appsRoot);
  });

  test("verified user detail returns test-canvas", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["id"]).toBe("test-canvas");
    expect(body["name"]).toBe("Test Canvas");
    expect(body["description"]).toBe(TEST_MINI_APP_MANIFEST.description ?? null);
    expect(body["installedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body["canEditSource"]).toBe(false);
    expect((body["createActions"] as Array<Record<string, unknown>>)[0]?.["label"]).toBe("New canvas");
  });

  test("unknown app id returns 404 for verified user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/missing",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(404);
  });

  test("canEditSource true when user has Admin-grade manage_server_operations", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["canEditSource"]).toBe(true);
  });

  test("canEditSource false when capability lookup returns empty", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": "unknown-user" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["canEditSource"]).toBe(false);
  });

  test("owner-only settings authority does not substitute for Admin app authority", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas",
      headers: { "x-test-user-id": USER_WITH_SETTINGS_ONLY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["canEditSource"]).toBe(false);
  });

  test("invalid manifest app serializes description as null", async () => {
    const badDir = join(appsRoot, "bad-manifest");
    await mkdir(badDir, { recursive: true });
    await writeFile(
      join(badDir, "app.json"),
      `${JSON.stringify({ ...TEST_MINI_APP_MANIFEST, id: "BAD" }, null, 2)}\n`,
    );
    await writeFile(join(badDir, "main.ts"), "export {};\n");

    const res = await app.inject({
      method: "GET",
      url: "/api/apps/bad-manifest",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["id"]).toBe("bad-manifest");
    expect(body["status"]).toBe("invalid_manifest");
    expect(body["description"]).toBeNull();
    expect(body["installedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body["name"]).toBeNull();
  });
});

describe("/api/apps/:appId/live-session", () => {
  const CLIENT_SESSION_ID = "11111111-1111-4111-8111-111111111111";

  test("Video command HTTP delivery and acknowledgement require the exact authenticated session", async () => {
    await writeVideoApp(appsRoot);
    liveSessionNow = Date.now();
    const binding = { targetKind: "artifact" as const, appId: "nautilo-video", userId: USER_WITHOUT_MANAGE, namespaceIds: ["namespace-1"], artifactId: "artifact-row-1", documentId: "video", documentVersion: { kind: "artifact_revision" as const, revision: 7 } };
    const issued = liveSessionRegistry.issue(binding);
    const controller = new AbortController();
    const payload = { sessionToken: issued.token };
    const headers = { "x-test-user-id": USER_WITHOUT_MANAGE };
    const receiveUrl = "/api/apps/nautilo-video/live-session/receive-command";
    const completeUrl = "/api/apps/nautilo-video/live-session/complete-command";
    expect((await app.inject({ method: "POST", url: receiveUrl, headers: { "x-test-user-id": USER_WITH_MANAGE }, payload })).statusCode).toBe(409);
    let announce: () => void = () => {};
    const listening = new Promise<void>((resolve) => { announce = resolve; });
    const original = liveAppCommandBroker.listen.bind(liveAppCommandBroker);
    const spy = spyOn(liveAppCommandBroker, "listen").mockImplementation((...args) => { const result = original(...args); announce(); return result; });
    try {
      const response = app.inject({ method: "POST", url: receiveUrl, headers, payload }).then((value) => value);
      await listening;
      const commandResult = liveAppCommandBroker.invoke(issued.sessionId, { documentVersion: binding.documentVersion, deadline: Date.now() + 500, command: { action: "pause" } }, controller.signal);
      const delivery = await response;
      expect(delivery.statusCode).toBe(200);
      const command = delivery.json<{ command: { requestId: string; command: unknown } }>().command;
      expect(command.command).toEqual({ action: "pause" });
      expect(delivery.body).not.toContain(issued.token);
      const result = { status: "rejected", code: "dirty_document", stateChanged: false, retrySafe: false };
      expect((await app.inject({ method: "POST", url: completeUrl, headers, payload: { ...payload, requestId: command.requestId, result: { url: "private" } } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: completeUrl, headers: { "x-test-user-id": USER_WITH_MANAGE }, payload: { ...payload, requestId: command.requestId, result } })).statusCode).toBe(409);
      const ack = await app.inject({ method: "POST", url: completeUrl, headers, payload: { ...payload, requestId: command.requestId, result } });
      expect(ack.json<{ accepted: boolean }>()).toEqual({ accepted: true });
      expect(await commandResult).toEqual({ status: "completed", result });
      expect((await app.inject({ method: "POST", url: completeUrl, headers, payload: { ...payload, requestId: command.requestId, result } })).json<{ accepted: boolean }>()).toEqual({ accepted: false });
    } finally {
      spy.mockRestore(); controller.abort(); liveSessionRegistry.revokeForSubject(issued.token, binding);
    }
  });

  const issuePayload: IssueLiveMiniAppSessionRequest = {
    targetKind: "artifact",
    artifactId: "artifact-row-1",
    documentVersion: { kind: "artifact_revision", revision: 7 },
  };

  test("rejects wrong apps and requests without authenticated namespace context", async () => {
    const wrongApp = await app.inject({
      method: "POST",
      url: "/api/apps/test-canvas/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    expect(wrongApp.statusCode).toBe(404);

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      payload: issuePayload,
    });
    expect(anonymous.statusCode).toBe(401);

    const noEnvelope = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "x-test-no-envelope": "true",
      },
      payload: issuePayload,
    });
    expect(noEnvelope.statusCode).toBe(401);

    const scoped = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "x-test-scope": "true",
      },
      payload: issuePayload,
    });
    expect(scoped.statusCode).toBe(403);
  });

  test("validates client cancellation ids and fences issuance cancelled before completion", async () => {
    const headers = { "x-test-user-id": USER_WITHOUT_MANAGE };
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/prepare",
      headers,
      payload: { clientSessionId: "not-a-uuid" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken: "invalid" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers,
      payload: { clientSessionId: "not-a-uuid" },
    })).statusCode).toBe(400);

    const prepared = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/prepare",
      headers,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    expect(prepared.statusCode).toBe(200);
    const { issuanceToken } = JSON.parse(prepared.body) as { issuanceToken: string };
    expect(issuanceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cancelled = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(JSON.parse(cancelled.body)).toEqual({ ok: true });

    const issueAfterCancel = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken },
    });
    expect(issueAfterCancel.statusCode).toBe(409);
    expect(JSON.parse(issueAfterCancel.body)).toEqual({ error: "session_closed" });
  });

  test("client cancellation is bound to the authenticated app owner", async () => {
    const ownerHeaders = { "x-test-user-id": USER_WITHOUT_MANAGE };
    const prepared = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/prepare",
      headers: ownerHeaders,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    const { issuanceToken } = JSON.parse(prepared.body) as { issuanceToken: string };
    const mismatchedUserIssue = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken },
    });
    expect(mismatchedUserIssue.statusCode).toBe(409);
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: ownerHeaders,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken },
    });
    expect(issued.statusCode).toBe(200);
    const capability = JSON.parse(issued.body) as { sessionToken: string };
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: ownerHeaders,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken },
    })).statusCode).toBe(409);

    const otherUserCancel = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    expect(otherUserCancel.statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/refresh",
      headers: ownerHeaders,
      payload: { ...issuePayload, sessionToken: capability.sessionToken },
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers: ownerHeaders,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/refresh",
      headers: ownerHeaders,
      payload: { ...issuePayload, sessionToken: capability.sessionToken },
    })).statusCode).toBe(409);
  });

  test("client cancellation remains available after the app is removed", async () => {
    const headers = { "x-test-user-id": USER_WITHOUT_MANAGE };
    const prepared = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/prepare",
      headers,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    const { issuanceToken } = JSON.parse(prepared.body) as { issuanceToken: string };
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers,
      payload: { ...issuePayload, clientSessionId: CLIENT_SESSION_ID, issuanceToken },
    });
    expect(issued.statusCode).toBe(200);
    const capability = JSON.parse(issued.body) as { sessionToken: string };

    await rm(join(appsRoot, "nautilo-writer"), { recursive: true, force: true });
    resetInstalledAppRegistryForTests();
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers,
      payload: { clientSessionId: CLIENT_SESSION_ID },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(liveSessionRegistry.validateOpenForSubject(capability.sessionToken, {
      appId: "nautilo-writer",
      userId: USER_WITHOUT_MANAGE,
    })).toEqual({ ok: false, code: "session_closed" });
  });

  test("rejects unreadable artifacts and stale revisions", async () => {
    const unreadable = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        targetKind: "artifact",
        artifactId: "not-readable",
        documentVersion: { kind: "artifact_revision", revision: 7 },
      },
    });
    expect(unreadable.statusCode).toBe(404);
    expect(JSON.parse(unreadable.body)).toEqual({ error: "session_closed" });

    const stale = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        targetKind: "artifact",
        artifactId: "artifact-row-1",
        documentVersion: { kind: "artifact_revision", revision: 6 },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ error: "stale_version" });
  });

  test("rejects a readable artifact when its namespace is not mutable", async () => {
    const readableOnly = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: {
        "x-test-user-id": USER_WITHOUT_MANAGE,
        "x-test-no-mutable": "true",
      },
      payload: issuePayload,
    });
    expect(readableOnly.statusCode).toBe(404);
    expect(JSON.parse(readableOnly.body)).toEqual({ error: "session_closed" });
  });

  test("issues, honestly refreshes, and revokes an authorized Writer capability without room binding", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: issuePayload,
    });
    expect(issued.statusCode).toBe(200);
    const issueBody = JSON.parse(issued.body) as {
      sessionToken: string;
      sessionId: string;
      documentVersion: { kind: "artifact_revision"; revision: number };
      expiresAt: number;
    };
    expect(issueBody.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issueBody.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issueBody.sessionId).not.toBe(issueBody.sessionToken);
    expect(issueBody.documentVersion).toEqual({ kind: "artifact_revision", revision: 7 });
    expect(issueBody.expiresAt).toBe(1_500);

    liveSessionNow = 1_200;
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/refresh",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: { ...issuePayload, sessionToken: issueBody.sessionToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(JSON.parse(refreshed.body)).toEqual({
      sessionToken: issueBody.sessionToken,
      sessionId: issueBody.sessionId,
      documentVersion: { kind: "artifact_revision", revision: 7 },
      expiresAt: 1_700,
    });

    const wrongSubject = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: { sessionToken: issueBody.sessionToken },
    });
    expect(wrongSubject.statusCode).toBe(409);
    expect(JSON.parse(wrongSubject.body)).toEqual({ error: "session_closed" });

    const revoked = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/revoke",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: { sessionToken: issueBody.sessionToken },
    });
    expect(revoked.statusCode).toBe(200);
    expect(JSON.parse(revoked.body)).toEqual({ ok: true });

    const refreshAfterRevoke = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/refresh",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: { ...issuePayload, sessionToken: issueBody.sessionToken },
    });
    expect(refreshAfterRevoke.statusCode).toBe(409);
    expect(JSON.parse(refreshAfterRevoke.body)).toEqual({ error: "session_closed" });
  });

  test("does not use advisory activeMiniApp fields to mint or rebind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        activeMiniApp: {
          appId: "nautilo-writer",
          artifactId: "artifact-row-1",
          baseRevision: 7,
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test("does not resolve acceptance from an unrelated Artifact revision advance", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    expect(issued.statusCode).toBe(200);
    const capability = JSON.parse(issued.body) as {
      sessionToken: string;
      sessionId: string;
    };
    const proposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: issuePayload.documentVersion,
      agentId: "agent-1",
      turnId: "turn-1",
      operations: [{ kind: "replace" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const beforePersistence = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/resolve-review",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        sessionToken: capability.sessionToken,
        proposalId: proposal.proposalId,
        documentVersion: issuePayload.documentVersion,
        outcome: "accepted",
        resultDocumentVersion: { kind: "artifact_revision", revision: 8 },
      },
    });
    expect(beforePersistence.statusCode).toBe(409);
    expect(JSON.parse(beforePersistence.body)).toEqual({ error: "stale_version" });

    expect(liveSessionRegistry.refresh(
      capability.sessionToken,
      { kind: "artifact_revision", revision: 8 },
      {
        targetKind: "artifact",
        appId: "nautilo-writer",
        userId: USER_WITHOUT_MANAGE,
        artifactId: "artifact-row-1",
        documentId: "artifact-row-1",
        documentVersion: issuePayload.documentVersion,
      },
    ).ok).toBe(true);
    const resolved = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/resolve-review",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        sessionToken: capability.sessionToken,
        proposalId: proposal.proposalId,
        documentVersion: issuePayload.documentVersion,
        outcome: "accepted",
        resultDocumentVersion: { kind: "artifact_revision", revision: 8 },
      },
    });
    expect(resolved.statusCode).toBe(409);
    expect(JSON.parse(resolved.body)).toEqual({ error: "stale_version" });
  });

  test("reconciles only the exact unresolved background Task proposal", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    expect(issued.statusCode).toBe(200);
    const capability = JSON.parse(issued.body) as {
      sessionToken: string;
      sessionId: string;
    };
    const liveContext = {
      ownerId: USER_WITHOUT_MANAGE,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: capability.sessionToken,
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      "task-review-reconcile",
      liveContext,
      () => liveContext.liveMiniAppSession,
    )).toBe(true);
    const proposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: issuePayload.documentVersion,
      agentId: "agent-review-reconcile",
      turnId: "task-run-reconcile",
      operations: [{ kind: "replace", text: "document" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(registerTaskWriterReviewProposal({
      taskId: "task-review-reconcile",
      taskRunId: "task-run-reconcile",
      ownerId: USER_WITHOUT_MANAGE,
      sessionId: capability.sessionId,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
    })).toBe(true);

    const pending = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/reviews",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: { sessionToken: capability.sessionToken },
    });
    expect(pending.statusCode).toBe(200);
    expect(JSON.parse(pending.body)).toEqual({
      proposals: [{
        proposalId: proposal.proposalId,
        appId: "nautilo-writer",
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        operations: [{ kind: "replace", text: "document" }],
      }],
    });

    expect(resolveTaskWriterReviewProposal({
      ownerId: USER_WITHOUT_MANAGE,
      sessionId: capability.sessionId,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
      resolution: { outcome: "rejected" },
    }).status).toBe("resolved");
    const resolved = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/reviews",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: { sessionToken: capability.sessionToken },
    });
    expect(JSON.parse(resolved.body)).toEqual({ proposals: [] });
  });

  test("replays an unresolved foreground proposal after iframe reload", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    expect(issued.statusCode).toBe(200);
    const capability = JSON.parse(issued.body) as {
      sessionToken: string;
      sessionId: string;
    };
    const proposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: issuePayload.documentVersion,
      agentId: "foreground-agent",
      turnId: "foreground-turn",
      operations: [{ kind: "replace", text: "foreground document" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const replayed = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/reviews",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: { sessionToken: capability.sessionToken },
    });
    expect(replayed.statusCode).toBe(200);
    expect(JSON.parse(replayed.body)).toEqual({
      proposals: [{
        proposalId: proposal.proposalId,
        appId: "nautilo-writer",
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        operations: [{ kind: "replace", text: "foreground document" }],
      }],
    });
  });

  test("reports an accepted Task review as pending verification, never completed", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    const capability = JSON.parse(issued.body) as { sessionToken: string; sessionId: string };
    const liveContext = {
      ownerId: USER_WITHOUT_MANAGE,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: capability.sessionToken,
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      "task-review-pending",
      liveContext,
      () => liveContext.liveMiniAppSession,
    )).toBe(true);
    const proposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: issuePayload.documentVersion,
      agentId: "agent-review-pending",
      turnId: "task-run-pending",
      operations: [{ kind: "replace", text: "document" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(registerTaskWriterReviewProposal({
      taskId: "task-review-pending",
      taskRunId: "task-run-pending",
      ownerId: USER_WITHOUT_MANAGE,
      sessionId: capability.sessionId,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
    })).toBe(true);
    expect(liveSessionRegistry.commitArtifactAcceptance(
      capability.sessionToken,
      {
        sessionId: capability.sessionId,
        proposalId: proposal.proposalId,
        documentVersion: issuePayload.documentVersion,
      },
      {
        requestId: "pending-review-request",
        acceptedContentSha256: "a".repeat(64),
        acceptedOperationIndexes: [0],
        result: {
          documentVersion: { kind: "artifact_revision", revision: 8 },
          contentSha256: "b".repeat(64),
        },
      },
    ).ok).toBe(true);
    expect(finishTaskWriterReviewModel("task-review-pending", "task-run-pending")).not.toBeNull();

    const resolved = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/resolve-review",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: {
        sessionToken: capability.sessionToken,
        proposalId: proposal.proposalId,
        documentVersion: issuePayload.documentVersion,
        outcome: "accepted",
        resultDocumentVersion: { kind: "artifact_revision", revision: 8 },
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(JSON.parse(resolved.body)).toEqual({ ok: true, taskStatus: "pending" });
  });

  test("invalidates an exact stale Writer review, releases its owner, and is idempotent", async () => {
    const issued = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: issuePayload,
    });
    const capability = JSON.parse(issued.body) as { sessionToken: string; sessionId: string };
    const liveContext = {
      ownerId: USER_WITHOUT_MANAGE,
      activeMiniApp: { appId: "nautilo-writer", updatedAt: 1 },
      liveMiniAppSession: {
        appId: "nautilo-writer",
        sessionToken: capability.sessionToken,
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        instructions: "Writer",
      },
    };
    expect(registerTaskLiveMiniAppBinding(
      "task-review-invalidated",
      liveContext,
      () => liveContext.liveMiniAppSession,
    )).toBe(true);
    const proposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: issuePayload.documentVersion,
      agentId: "agent-review-invalidated",
      turnId: "task-run-invalidated",
      operations: [{ kind: "replace", text: "document" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(registerTaskWriterReviewProposal({
      taskId: "task-review-invalidated",
      taskRunId: "task-run-invalidated",
      ownerId: USER_WITHOUT_MANAGE,
      sessionId: capability.sessionId,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
    })).toBe(true);
    expect(finishTaskWriterReviewModel("task-review-invalidated", "task-run-invalidated")).not.toBeNull();

    // The host may already have refreshed its current document version. The
    // invalidation still addresses the immutable original proposal base.
    expect(liveSessionRegistry.refresh(
      capability.sessionToken,
      { kind: "artifact_revision", revision: 8 },
      {
        targetKind: "artifact",
        appId: "nautilo-writer",
        userId: USER_WITHOUT_MANAGE,
        artifactId: "artifact-row-1",
        documentId: "artifact-row-1",
      },
    ).ok).toBe(true);
    const replayedStaleProposal = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/reviews",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: { sessionToken: capability.sessionToken },
    });
    expect(replayedStaleProposal.statusCode).toBe(200);
    expect(JSON.parse(replayedStaleProposal.body)).toEqual({
      proposals: [{
        proposalId: proposal.proposalId,
        appId: "nautilo-writer",
        sessionId: capability.sessionId,
        documentVersion: issuePayload.documentVersion,
        operations: [{ kind: "replace", text: "document" }],
      }],
    });
    const body = {
      sessionToken: capability.sessionToken,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
      reason: "remote_changed",
    };
    const invalidated = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/invalidate-review",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: body,
    });
    expect(invalidated.statusCode).toBe(200);
    expect(JSON.parse(invalidated.body)).toEqual({ ok: true, taskStatus: "failed" });
    expect(isPendingTaskWriterReviewProposal({
      ownerId: USER_WITHOUT_MANAGE,
      sessionId: capability.sessionId,
      proposalId: proposal.proposalId,
      documentVersion: issuePayload.documentVersion,
    })).toBe(false);
    const replay = await app.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session/invalidate-review",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({ ok: true, taskStatus: "failed" });
    const nextProposal = liveSessionRegistry.registerProposal({
      sessionId: capability.sessionId,
      documentVersion: { kind: "artifact_revision", revision: 8 },
      agentId: "agent-review-after-invalidation",
      turnId: "task-run-after-invalidation",
      operations: [{ kind: "replace", text: "new document" }],
      operationMetadata: [{ operationIndex: 0 }],
    });
    expect(nextProposal.ok).toBe(true);
  });
});

describe("/api/apps/:appId/live-session currentFile", () => {
  const CURRENT = "/Users/alice/project";
  const RELAY_ID = "relay-desktop-1";
  const RELATIVE = "docs/report.html";
  const CONTENT = "<html>writer</html>";
  const LOCAL_SHA = createHash("sha256").update(CONTENT).digest("hex");

  function makeCurrentFileDeps() {
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: {
        snapshotForFocusedResource(relayId: string, actorId: string) {
          if (relayId !== RELAY_ID || actorId !== USER_WITHOUT_MANAGE) return null;
          return {
            ownedByActor: true,
            protocolVersion: 4,
            profile: "desktop-agent" as const,
            localFileExecution: true,
            allowedRoots: [CURRENT],
          };
        },
      },
      localFileDispatch: {
        async fsDispatch(_relayId, req) {
          return { ok: true as const, realpath: req.path };
        },
        async localFileDispatch(_relayId, req) {
          if (req.operation.kind === "file" && req.operation.command === "stat") {
            return {
              ok: true,
              result: JSON.stringify({
                path: `${CURRENT}/${RELATIVE}`,
                size: Buffer.byteLength(CONTENT),
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              }),
            };
          }
          if (req.operation.kind === "file" && req.operation.command === "read") {
            return {
              ok: true,
              result: JSON.stringify({
                content: Buffer.from(CONTENT, "utf8").toString("base64"),
                binary: true,
              }),
            };
          }
          return { ok: false, message: "unexpected op" };
        },
      },
    });
    return { liveLocalDocumentAuthority: authority };
  }

  test("issues a currentFile capability without leaking private binding fields", async () => {
    const scopedApp = Fastify({ logger: false });
    installSessionPreHandler(scopedApp);
    appRoutes(scopedApp, {
      appsRoot,
      liveSessionRegistry,
      ...makeCurrentFileDeps(),
      findArtifactForNamespaces: async () => null,
    });

    const issued = await scopedApp.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: {
        targetKind: "currentFile",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      },
    });
    expect(issued.statusCode).toBe(200);
    const body = JSON.parse(issued.body) as Record<string, unknown>;
    expect(body["documentVersion"]).toEqual({ kind: "local_sha", sha256: LOCAL_SHA });
    expect(JSON.stringify(body)).not.toContain(CURRENT);
    expect(JSON.stringify(body)).not.toContain(RELAY_ID);
    expect(JSON.stringify(body)).not.toContain("localTargetId");
    await scopedApp.close();
  });

  test("rejects stale local SHA and wrong relay hints without fallback", async () => {
    const scopedApp = Fastify({ logger: false });
    installSessionPreHandler(scopedApp);
    appRoutes(scopedApp, {
      appsRoot,
      liveSessionRegistry,
      ...makeCurrentFileDeps(),
      findArtifactForNamespaces: async () => null,
    });

    const stale = await scopedApp.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: {
        targetKind: "currentFile",
        relayIdHint: RELAY_ID,
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: "d".repeat(64) },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ error: "stale_version" });

    const wrongRelay = await scopedApp.inject({
      method: "POST",
      url: "/api/apps/nautilo-writer/live-session",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE, "x-test-no-room": "true" },
      payload: {
        targetKind: "currentFile",
        relayIdHint: "relay-missing",
        currentFolder: CURRENT,
        relativePath: RELATIVE,
        documentVersion: { kind: "local_sha", sha256: LOCAL_SHA },
      },
    });
    expect(wrongRelay.statusCode).toBe(503);
    expect(JSON.parse(wrongRelay.body)).toEqual({ error: "relay_unavailable" });
    await scopedApp.close();
  });
});

describe("/api/apps/:appId/live-session/apply-accepted", () => {
  const CURRENT = "/Users/alice/project";
  const RELAY_ID = "relay-desktop-accept";
  const RELATIVE = "docs/report.html";

  async function setupAcceptance(options: {
    reportedSha256?: string;
    createLiveReviewLifecycle?: (input: {
      registry: LiveMiniAppSessionRegistry;
      binding: Parameters<LiveMiniAppSessionRegistry["issue"]>[0];
      issued: ReturnType<LiveMiniAppSessionRegistry["issue"]>;
      proposalId: string;
    }) => LiveReviewLifecyclePort;
  } = {}) {
    const canonical = writerHtml([
      writerParagraph("p1", "hello"),
      writerParagraph("p2", "second"),
    ]);
    let currentContent = canonical;
    let writeCount = 0;
    const registry = new LiveMiniAppSessionRegistry();
    const authority = new LiveLocalDocumentAuthority({
      relayRegistry: {
        snapshotForFocusedResource(relayId, actorId) {
          if (relayId !== RELAY_ID || actorId !== USER_WITHOUT_MANAGE) return null;
          return {
            ownedByActor: true,
            protocolVersion: 7,
            profile: "desktop-agent",
            localFileExecution: true,
            allowedRoots: [CURRENT],
          };
        },
      },
      readCanonical: async () => ({
        ok: true,
        bytes: Buffer.from(currentContent, "utf8"),
        sha256: sha256Hex(currentContent),
      }),
      localFileDispatch: {
        async fsDispatch(_relayId, req) {
          return { ok: true as const, realpath: req.path };
        },
        async localFileDispatch(relayId, req, opts) {
          expect(relayId).toBe(RELAY_ID);
          expect(opts).toEqual({ mutating: true, approvalObtained: true });
          expect(req.operation.kind).toBe("file");
          if (req.operation.kind !== "file") {
            return { ok: false as const, message: "unexpected transport" };
          }
          expect(req.operation.args).toMatchObject({
            path: RELATIVE,
            expectedSha256: sha256Hex(canonical),
            clientMutationId: "request-1",
            _routing: {
              ownerId: USER_WITHOUT_MANAGE,
              agentId: "agent-1",
              turnId: "agent-turn-1",
              currentFolder: CURRENT,
            },
          });
          const routing = req.operation.args["_routing"] as Record<string, unknown>;
          expect(routing["mutationRequestId"]).toMatch(
            /^d448:[a-f0-9]{64}:[a-f0-9]{64}$/,
          );
          const bytes = Buffer.from(req.operation.args["content"] as string, "base64");
          currentContent = bytes.toString("utf8");
          writeCount++;
          return {
            ok: true as const,
            result: JSON.stringify({
              applied: true,
              revisionId: "local:opaque-revision",
              sha256: options.reportedSha256 ?? sha256Hex(currentContent),
              path: RELATIVE,
              zone: "current",
              command: "write",
              stats: { additions: 1, deletions: 1 },
              summary: "changed",
              unifiedDiff: "",
            }),
          };
        },
      },
    });
    const binding = {
      targetKind: "currentFile" as const,
      appId: "nautilo-writer",
      userId: USER_WITHOUT_MANAGE,
      localTargetId: "opaque-local-target",
      relayId: RELAY_ID,
      canonicalPath: `${CURRENT}/${RELATIVE}`,
      currentFolderRoot: CURRENT,
      relativePath: RELATIVE,
      documentVersion: {
        kind: "local_sha" as const,
        sha256: sha256Hex(canonical),
      },
    };
    const issued = registry.issue(binding);
    const registered = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: binding.documentVersion,
      agentId: "agent-1",
      turnId: "agent-turn-1",
      operations: [
        {
          kind: "replace",
          blockId: "p1",
          scope: { kind: "range", start: 0, end: 5 },
          range: { start: 0, end: 5 },
          text: "world",
          operationIndex: 0,
        },
        {
          kind: "replace",
          blockId: "p2",
          scope: { kind: "range", start: 0, end: 6 },
          range: { start: 0, end: 6 },
          text: "changed",
          operationIndex: 1,
        },
      ],
      operationMetadata: [
        { operationIndex: 0, kind: "replace", blockId: "p1" },
        { operationIndex: 1, kind: "replace", blockId: "p2" },
      ],
    });
    if (!registered.ok) throw new Error(registered.code);

    const scopedApp = Fastify({ logger: false });
    installSessionPreHandler(scopedApp);
    appRoutes(scopedApp, {
      appsRoot,
      liveSessionRegistry: registry,
      liveLocalDocumentAuthority: authority,
      findArtifactForNamespaces: async () => null,
      ...(options.createLiveReviewLifecycle
        ? {
            liveReviewLifecycle: options.createLiveReviewLifecycle({
              registry,
              binding,
              issued,
              proposalId: registered.proposalId,
            }),
          }
        : {}),
    });
    await scopedApp.ready();
    return {
      scopedApp,
      registry,
      binding,
      issued,
      proposalId: registered.proposalId,
      canonical,
      acceptedOne: writerHtml([
        writerParagraph("p1", "world"),
        writerParagraph("p2", "second"),
      ]),
      acceptedBoth: writerHtml([
        writerParagraph("p1", "world"),
        writerParagraph("p2", "changed"),
      ]),
      setCurrentContent(value: string) {
        currentContent = value;
      },
      getCurrentContent() {
        return currentContent;
      },
      getWriteCount() {
        return writeCount;
      },
    };
  }

  test("accepts an independent partial subset, caches its retry, and closes changed duplicates", async () => {
    const setup = await setupAcceptance();
    try {
      const payload = {
        requestId: "request-1",
        sessionToken: setup.issued.token,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
        acceptedContent: setup.acceptedOne,
        acceptedOperationIndexes: [0],
      };
      const accepted = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({
        documentVersion: {
          kind: "local_sha",
          sha256: sha256Hex(setup.getCurrentContent()),
        },
        contentSha256: sha256Hex(setup.getCurrentContent()),
        localRevisionRef: "local:opaque-revision",
      });
      expect(JSON.stringify(JSON.parse(accepted.body))).not.toContain(CURRENT);
      expect(JSON.stringify(JSON.parse(accepted.body))).not.toContain(RELAY_ID);
      expect(setup.getWriteCount()).toBe(1);

      const retry = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.body).toBe(accepted.body);
      expect(setup.getWriteCount()).toBe(1);

      const changed = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: { ...payload, acceptedOperationIndexes: [0, 1] },
      });
      expect(changed.statusCode).toBe(409);
      expect(JSON.parse(changed.body)).toEqual({ error: "proposal_closed" });
      expect(setup.getWriteCount()).toBe(1);
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("records save before session advance, then server-closes the accepted review for callback-loss recovery", async () => {
    const events: string[] = [];
    let admissionCount = 0;
    const setup = await setupAcceptance({
      createLiveReviewLifecycle: ({ registry, binding, issued }) => ({
        isPendingReview: () => true,
        admitAcceptedProposal: () => ++admissionCount === 1
          ? { status: "pending", binding: { id: "task-review" } }
          : { status: "invalidated" },
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => {
          events.push("receipt");
          expect(registry.validateForSubject(issued.token, {
            appId: binding.appId,
            userId: binding.userId,
            documentVersion: binding.documentVersion,
          }).ok).toBe(true);
          return { status: "recorded" };
        },
        advanceAcceptedReviewContinuation: (_binding, resultDocumentVersion) => {
          events.push("advance");
          expect(resultDocumentVersion).not.toEqual(binding.documentVersion);
          expect(registry.validateForSubject(issued.token, {
            appId: binding.appId,
            userId: binding.userId,
            documentVersion: resultDocumentVersion,
          }).ok).toBe(true);
          return true;
        },
        failAcceptedReviewContinuation: () => ({ status: "conflict" }),
        failReview: () => ({ status: "conflict" }),
        resolveReview: () => {
          events.push("resolve");
          return {
            status: "resolved",
            binding: { id: "task-review-resolved" },
            finalizeNow: true,
          };
        },
        finalizeReview: async () => {
          events.push("finalize");
        },
        failReviewsForSession: () => [],
      }),
    });
    try {
      const payload = {
        requestId: "request-1",
        sessionToken: setup.issued.token,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
        acceptedContent: setup.acceptedOne,
        acceptedOperationIndexes: [0],
      };
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(events).toEqual(["receipt", "advance", "resolve", "finalize"]);
      expect(setup.getWriteCount()).toBe(1);
      const completed = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.record.reviewOutcome).toBe("accepted");
      const retryAfterTaskCleanup = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(retryAfterTaskCleanup.statusCode).toBe(200);
      expect(retryAfterTaskCleanup.body).toBe(response.body);
      expect(events).toEqual(["receipt", "advance", "resolve", "finalize"]);
      expect(setup.getWriteCount()).toBe(1);
      const retryCompleted = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(retryCompleted.ok).toBe(true);
      if (retryCompleted.ok) expect(retryCompleted.record.reviewOutcome).toBe("accepted");
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("closes a cached saved review when its Task lifecycle was already invalidated", async () => {
    const setup = await setupAcceptance({
      createLiveReviewLifecycle: () => ({
        isPendingReview: () => true,
        admitAcceptedProposal: () => ({ status: "invalidated" }),
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => ({ status: "recorded" }),
        advanceAcceptedReviewContinuation: () => false,
        failAcceptedReviewContinuation: () => ({ status: "conflict" }),
        resolveReview: () => ({ status: "conflict" }),
        failReview: () => ({ status: "conflict" }),
        finalizeReview: async () => {},
        failReviewsForSession: () => [],
      }),
    });
    try {
      const result = {
        documentVersion: { kind: "local_sha" as const, sha256: sha256Hex(setup.acceptedOne) },
        contentSha256: sha256Hex(setup.acceptedOne),
        localRevisionRef: "local:opaque-revision",
      };
      expect(setup.registry.commitCurrentFileAcceptance(
        setup.issued.token,
        {
          sessionId: setup.issued.sessionId,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
        },
        {
          requestId: "request-1",
          acceptedContentSha256: result.contentSha256,
          acceptedOperationIndexes: [0],
          result,
        },
      ).ok).toBe(true);
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(setup.getWriteCount()).toBe(0);
      const proposal = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(proposal.ok).toBe(true);
      if (proposal.ok) expect(proposal.record.reviewOutcome).toBe("accepted");
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("keeps the canonical save successful but fails Task continuation when version advance is unavailable", async () => {
    const events: string[] = [];
    const setup = await setupAcceptance({
      createLiveReviewLifecycle: () => ({
        isPendingReview: () => true,
        admitAcceptedProposal: () => ({ status: "pending", binding: { id: "task-review" } }),
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => {
          events.push("receipt");
          return { status: "recorded" };
        },
        advanceAcceptedReviewContinuation: () => {
          events.push("advance");
          return false;
        },
        failAcceptedReviewContinuation: () => {
          events.push("fail");
          return {
            status: "resolved",
            binding: { id: "task-review-failed" },
            finalizeNow: true,
          };
        },
        failReview: () => ({ status: "conflict" }),
        resolveReview: () => {
          events.push("resolve");
          return { status: "conflict" };
        },
        finalizeReview: async () => {
          events.push("finalize");
        },
        failReviewsForSession: () => [],
      }),
    });
    try {
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        documentVersion: { kind: "local_sha", sha256: sha256Hex(setup.getCurrentContent()) },
      });
      expect(events).toEqual(["receipt", "advance", "fail", "finalize"]);
      expect(setup.getWriteCount()).toBe(1);
      const completed = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.record.reviewOutcome).toBe("accepted");
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("keeps a saved Current Folder response truthful and advances its session when receipt and finalization throw", async () => {
    const events: string[] = [];
    const setup = await setupAcceptance({
      createLiveReviewLifecycle: () => ({
        isPendingReview: () => true,
        admitAcceptedProposal: () => ({ status: "pending", binding: { id: "task-review" } }),
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => {
          events.push("receipt");
          throw new Error("receipt unavailable after canonical save");
        },
        advanceAcceptedReviewContinuation: () => true,
        failAcceptedReviewContinuation: () => {
          events.push("fail");
          return { status: "resolved", binding: { id: "task-review-failed" }, finalizeNow: true };
        },
        resolveReview: () => ({ status: "conflict" }),
        failReview: () => ({ status: "conflict" }),
        finalizeReview: async () => {
          events.push("finalize");
          throw new Error("finalizer unavailable after canonical save");
        },
        failReviewsForSession: () => [],
      }),
    });
    try {
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        documentVersion: { kind: "local_sha", sha256: sha256Hex(setup.getCurrentContent()) },
      });
      expect(setup.getWriteCount()).toBe(1);
      expect(events).toEqual(["receipt", "fail", "finalize"]);
      const savedVersion = { kind: "local_sha" as const, sha256: sha256Hex(setup.getCurrentContent()) };
      expect(setup.registry.validateForSubject(setup.issued.token, {
        appId: "nautilo-writer",
        userId: USER_WITHOUT_MANAGE,
        documentVersion: savedVersion,
      }).ok).toBe(true);
      const next = setup.registry.registerProposal({
        sessionId: setup.issued.sessionId,
        documentVersion: savedVersion,
        agentId: "agent-next",
        turnId: "agent-turn-next",
        operations: [],
        operationMetadata: [],
      });
      expect(next.ok).toBe(true);
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("releases the visible review after a saved Current Folder write cannot commit its session postimage", async () => {
    const events: string[] = [];
    const setup = await setupAcceptance({
      createLiveReviewLifecycle: () => ({
        isPendingReview: () => true,
        admitAcceptedProposal: () => ({ status: "pending", binding: { id: "task-review" } }),
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => {
          events.push("receipt");
          return { status: "recorded" };
        },
        advanceAcceptedReviewContinuation: () => {
          events.push("advance");
          return true;
        },
        failAcceptedReviewContinuation: () => {
          events.push("fail");
          return { status: "resolved", binding: { id: "task-review-failed" }, finalizeNow: true };
        },
        resolveReview: () => ({ status: "conflict" }),
        failReview: () => ({ status: "conflict" }),
        finalizeReview: async () => { events.push("finalize"); },
        failReviewsForSession: () => [],
      }),
    });
    try {
      const registry = setup.registry as unknown as {
        commitCurrentFileAcceptance: () => { ok: false; code: "session_closed" };
      };
      registry.commitCurrentFileAcceptance = () => ({ ok: false, code: "session_closed" });
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(setup.getWriteCount()).toBe(1);
      expect(events).toEqual(["receipt", "fail", "finalize"]);
      const proposal = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(proposal.ok).toBe(true);
      if (proposal.ok) expect(proposal.record.reviewOutcome).toBe("accepted");
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("keeps a saved Artifact response truthful and releases its review when receipt recording fails", async () => {
    const registry = new LiveMiniAppSessionRegistry();
    const binding = {
      targetKind: "artifact" as const,
      appId: "nautilo-writer",
      userId: USER_WITHOUT_MANAGE,
      namespaceIds: ["namespace-1"],
      artifactId: "artifact-row-1",
      documentId: "document-1",
      documentVersion: { kind: "artifact_revision" as const, revision: 7 },
    };
    const issued = registry.issue(binding);
    const proposal = registry.registerProposal({
      sessionId: issued.sessionId,
      documentVersion: binding.documentVersion,
      agentId: "agent-1",
      turnId: "agent-turn-1",
      operations: [{ kind: "replace", blockId: "p1", scope: { kind: "range", start: 0, end: 5 }, text: "world" }],
      operationMetadata: [{ operationIndex: 0, kind: "replace", blockId: "p1" }],
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const events: string[] = [];
    let writes = 0;
    const scopedApp = Fastify({ logger: false });
    installSessionPreHandler(scopedApp);
    appRoutes(scopedApp, {
      appsRoot,
      liveSessionRegistry: registry,
      findArtifactForNamespaces: async () => ({
        id: "artifact-row-1", artifactId: "artifact-public-1", path: "draft.html",
      } as never),
      acceptLiveArtifactProposal: async () => {
        writes += 1;
        return {
          ok: true,
          result: {
            documentVersion: { kind: "artifact_revision", revision: 8 },
            contentSha256: "b".repeat(64),
          },
        };
      },
      liveReviewLifecycle: {
        isPendingReview: () => true,
        admitAcceptedProposal: () => ({ status: "pending", binding: { id: "task-review" } }),
        releaseAcceptanceClaim: () => {},
        recordAcceptedReceipt: async () => {
          events.push("receipt");
          return { status: "not_found" };
        },
        advanceAcceptedReviewContinuation: () => {
          events.push("advance");
          return true;
        },
        failAcceptedReviewContinuation: () => {
          events.push("fail");
          return { status: "resolved", binding: { id: "task-review-failed" }, finalizeNow: true };
        },
        resolveReview: () => ({ status: "conflict" }),
        failReview: () => ({ status: "conflict" }),
        finalizeReview: async () => { events.push("finalize"); },
        failReviewsForSession: () => [],
      },
    });
    await scopedApp.ready();
    try {
      const response = await scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: issued.token,
          proposalId: proposal.proposalId,
          documentVersion: binding.documentVersion,
          acceptedContent: writerHtml([writerParagraph("p1", "world")]),
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(writes).toBe(1);
      expect(events).toEqual(["receipt", "fail", "finalize"]);
      const saved = registry.lookupProposal({
        sessionId: issued.sessionId,
        proposalId: proposal.proposalId,
        documentVersion: binding.documentVersion,
      });
      expect(saved.ok).toBe(true);
      if (saved.ok) expect(saved.record.reviewOutcome).toBe("accepted");
      const savedVersion = { kind: "artifact_revision" as const, revision: 8 };
      expect(registry.validateForSubject(issued.token, {
        appId: "nautilo-writer",
        userId: USER_WITHOUT_MANAGE,
        documentVersion: savedVersion,
      }).ok).toBe(true);
      const next = registry.registerProposal({
        sessionId: issued.sessionId,
        documentVersion: savedVersion,
        agentId: "agent-next",
        turnId: "agent-turn-next",
        operations: [],
        operationMetadata: [],
      });
      expect(next.ok).toBe(true);
    } finally {
      await scopedApp.close();
    }
  });

  test("discards semantically invisible iframe wrapper markup", async () => {
    const setup = await setupAcceptance();
    try {
      const marker = "iframe-wrapper-injection";
      const updatedAt = "2026-07-18T08:45:00.000Z";
      const acceptedContent = setup.acceptedOne
        .replace(
          '"version":"1.0"',
          `"version":"1.0","metadata":{"updatedAt":"${updatedAt}"}`,
        )
        .replace(
          "<body>",
          `<body><aside data-marker="${marker}">untrusted</aside>`,
        );
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent,
          acceptedOperationIndexes: [0],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(setup.getCurrentContent()).not.toContain(marker);
      expect(setup.getCurrentContent()).toContain("<body></body>");
      expect(setup.getCurrentContent()).toContain(updatedAt);
      const body = JSON.parse(response.body) as {
        documentVersion: { sha256: string };
      };
      expect(body.documentVersion.sha256)
        .toBe(sha256Hex(setup.getCurrentContent()));
      expect(setup.getWriteCount()).toBe(1);
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("does not advance proposal state for a mismatched relay write SHA", async () => {
    const setup = await setupAcceptance({ reportedSha256: "f".repeat(64) });
    try {
      const payload = {
        requestId: "request-1",
        sessionToken: setup.issued.token,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
        acceptedContent: setup.acceptedOne,
        acceptedOperationIndexes: [0],
      };
      const response = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "relay_unavailable" });
      expect(setup.getWriteCount()).toBe(1);

      const proposal = setup.registry.lookupProposal({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        documentVersion: setup.binding.documentVersion,
      });
      expect(proposal.ok).toBe(true);
      if (proposal.ok) expect(proposal.record.acceptance).toBeUndefined();

      const retry = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload,
      });
      expect(retry.statusCode).toBe(409);
      expect(JSON.parse(retry.body)).toEqual({ error: "stale_version" });
      expect(setup.getWriteCount()).toBe(1);
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("rejects grouped and dependency-open subsets before writing", async () => {
    const setup = await setupAcceptance();
    try {
      expect(setup.registry.completeProposalReview({
        sessionId: setup.issued.sessionId,
        proposalId: setup.proposalId,
        outcome: "rejected",
      }).ok).toBe(true);
      const proposals = [
        {
          operations: [
            {
              kind: "format-inline",
              blockId: "p1",
              scope: { kind: "range", start: 0, end: 1 },
              range: { start: 0, end: 1 },
              style: { bold: true },
              operationIndex: 0,
            },
            {
              kind: "format-inline",
              blockId: "p1",
              scope: { kind: "range", start: 1, end: 2 },
              range: { start: 1, end: 2 },
              style: { italic: true },
              operationIndex: 1,
            },
          ],
          operationMetadata: [
            {
              operationIndex: 0,
              kind: "format-inline",
              blockId: "p1",
              groupId: "inline-style:p1",
            },
            {
              operationIndex: 1,
              kind: "format-inline",
              blockId: "p1",
              groupId: "inline-style:p1",
            },
          ],
          acceptedOperationIndexes: [0],
        },
        {
          operations: [
            {
              kind: "replace",
              blockId: "p1",
              scope: { kind: "range", start: 0, end: 5 },
              range: { start: 0, end: 5 },
              text: "world",
              operationIndex: 0,
            },
            {
              kind: "replace",
              blockId: "p2",
              scope: { kind: "range", start: 0, end: 6 },
              range: { start: 0, end: 6 },
              text: "changed",
              operationIndex: 1,
            },
          ],
          operationMetadata: [
            { operationIndex: 0, kind: "replace", blockId: "p1" },
            {
              operationIndex: 1,
              kind: "replace",
              blockId: "p2",
              dependencyOperationIndexes: [0],
            },
          ],
          acceptedOperationIndexes: [1],
        },
      ];

      for (const proposal of proposals) {
        const registered = setup.registry.registerProposal({
          sessionId: setup.issued.sessionId,
          documentVersion: setup.binding.documentVersion,
          agentId: "agent-1",
          turnId: "agent-turn-1",
          operations: proposal.operations,
          operationMetadata: proposal.operationMetadata,
        });
        if (!registered.ok) throw new Error(registered.code);
        const response = await setup.scopedApp.inject({
          method: "POST",
          url: "/api/apps/nautilo-writer/live-session/apply-accepted",
          headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
          payload: {
            requestId: "request-1",
            sessionToken: setup.issued.token,
            proposalId: registered.proposalId,
            documentVersion: setup.binding.documentVersion,
            acceptedContent: setup.canonical,
            acceptedOperationIndexes: proposal.acceptedOperationIndexes,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(JSON.parse(response.body)).toEqual({ error: "acceptance_conflict" });
        expect(setup.registry.completeProposalReview({
          sessionId: setup.issued.sessionId,
          proposalId: registered.proposalId,
          outcome: "rejected",
        }).ok).toBe(true);
      }
      const outOfRangeProposal = setup.registry.registerProposal({
        sessionId: setup.issued.sessionId,
        documentVersion: setup.binding.documentVersion,
        agentId: "agent-1",
        turnId: "agent-turn-1",
        operations: [{
          kind: "replace",
          blockId: "p1",
          scope: { kind: "range", start: 0, end: 5 },
          range: { start: 0, end: 5 },
          text: "world",
          operationIndex: 0,
        }],
        operationMetadata: [{ operationIndex: 0, kind: "replace", blockId: "p1" }],
      });
      if (!outOfRangeProposal.ok) throw new Error(outOfRangeProposal.code);
      const outOfRange = await setup.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: outOfRangeProposal.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.canonical,
          acceptedOperationIndexes: [2],
        },
      });
      expect(outOfRange.statusCode).toBe(409);
      expect(JSON.parse(outOfRange.body)).toEqual({ error: "acceptance_conflict" });
      expect(setup.getWriteCount()).toBe(0);
    } finally {
      await setup.scopedApp.close();
    }
  });

  test("refuses structural mismatch and external SHA drift without writing", async () => {
    const mismatch = await setupAcceptance();
    try {
      const response = await mismatch.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: mismatch.issued.token,
          proposalId: mismatch.proposalId,
          documentVersion: mismatch.binding.documentVersion,
          acceptedContent: mismatch.acceptedBoth,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ error: "acceptance_conflict" });
      expect(mismatch.getWriteCount()).toBe(0);
    } finally {
      await mismatch.scopedApp.close();
    }

    const drift = await setupAcceptance();
    try {
      drift.setCurrentContent(writerHtml([writerParagraph("p1", "external")]));
      const response = await drift.scopedApp.inject({
        method: "POST",
        url: "/api/apps/nautilo-writer/live-session/apply-accepted",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
        payload: {
          requestId: "request-1",
          sessionToken: drift.issued.token,
          proposalId: drift.proposalId,
          documentVersion: drift.binding.documentVersion,
          acceptedContent: drift.acceptedOne,
          acceptedOperationIndexes: [0],
        },
      });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({ error: "stale_version" });
      expect(drift.getWriteCount()).toBe(0);
    } finally {
      await drift.scopedApp.close();
    }
  });

  test("rejects malformed bodies and unknown fields", async () => {
    const setup = await setupAcceptance();
    try {
      for (const payload of [
        {},
        {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [],
        },
        {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [1, 0],
        },
        {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0, 0],
        },
        {
          requestId: "request-1",
          sessionToken: setup.issued.token,
          proposalId: setup.proposalId,
          documentVersion: setup.binding.documentVersion,
          acceptedContent: setup.acceptedOne,
          acceptedOperationIndexes: [0],
          relayId: RELAY_ID,
        },
      ]) {
        const response = await setup.scopedApp.inject({
          method: "POST",
          url: "/api/apps/nautilo-writer/live-session/apply-accepted",
          headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "invalid_request" });
      }
      expect(setup.getWriteCount()).toBe(0);
    } finally {
      await setup.scopedApp.close();
    }
  });
});

describe("/api/apps/:appId/create-templates/:actionId", () => {
  test("anonymous template read returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/create-templates/new-canvas",
    });
    expect(res.statusCode).toBe(401);
  });

  test("verified user can read declared create template", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/create-templates/new-canvas",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["appId"]).toBe("test-canvas");
    expect(body["actionId"]).toBe("new-canvas");
    expect(body["mimeType"]).toBe("text/html");
    expect(body["sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(body["content"]).toContain("application/vnd.nautilo.document+json");
    expect(JSON.stringify(body)).not.toContain(appsRoot);
  });

  test("unknown create action returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/create-templates/missing",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("/api/apps/:appId/runtime", () => {
  test("runtime exposes only the bounded live-review host flag", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/nautilo-writer/runtime",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(200);
    const manifest = (JSON.parse(res.body) as { manifest: Record<string, unknown> }).manifest;
    expect(manifest["liveReview"]).toEqual({ enabled: true });
    expect(JSON.stringify(manifest)).not.toContain("sessionToken");
    expect(JSON.stringify(manifest)).not.toContain("instructions");
  });

  test("anonymous runtime returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/apps/test-canvas/runtime" });
    expect(res.statusCode).toBe(401);
  });

  test("unknown app runtime returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/missing/runtime",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(404);
  });

  test("needs_dependencies app runtime returns 409 with sanitized body", async () => {
    await writeFile(
      join(appsRoot, "test-canvas", "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { lodash: "^4.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/runtime",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["error"]).toBe("app_runtime_unavailable");
    expect(body["status"]).toBe("needs_dependencies");
    expect(body["message"]).toBe("App dependencies are not installed.");
    expect(JSON.stringify(body)).not.toContain(appsRoot);
  });

  // Creates a neutral source fixture and performs a real runtime bundle, which can
  // exceed Bun's default 5s test deadline on local and CI startup.
  test("ready test-canvas runtime returns srcDoc and safe manifest", async () => {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-runtime-"));
    await writeTestApp(appsRoot);

    const runtimeApp = Fastify({ logger: false });
    installSessionPreHandler(runtimeApp);
    appRoutes(runtimeApp, {
      appsRoot,
      getCapabilities: async () => [],
    });
    await runtimeApp.ready();

    try {
      const res = await runtimeApp.inject({
        method: "GET",
        url: "/api/apps/test-canvas/runtime",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body["appId"]).toBe("test-canvas");
      expect(body["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);
      expect(body["hostCapabilities"]).toBeUndefined();
      expect(typeof body["srcDoc"]).toBe("string");
      expect((body["srcDoc"] as string).length).toBeGreaterThan(0);
      expect((body["srcDoc"] as string)).toContain("connect-src 'none'");
      expect((body["srcDoc"] as string)).toContain('appId:"test-canvas"');

      const manifest = body["manifest"] as Record<string, unknown>;
      expect(manifest["id"]).toBe("test-canvas");
      expect(manifest["name"]).toBe("Test Canvas");
      expect(manifest["version"]).toBe("1.0.0");
      expect(body["agentToolsBuild"]).toMatchObject({
        status: "ok",
        toolCount: 1,
        toolNames: ["app_test_canvas__inspect_document"],
      });
      expect(JSON.stringify(body)).not.toContain(appsRoot);
      expect(JSON.stringify(body)).not.toContain(join(appsRoot, ".cache"));
    } finally {
      await runtimeApp.close();
    }
  }, 30_000);

  test("runtime grants raster assets only to the exact canonical Design source", async () => {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-design-assets-"));
    await seedFirstPartyApps({
      appsRoot,
      sourceRoot: FIRST_PARTY_ROOT,
      appIds: ["nautilo-design"],
    });

    const runtimeApp = Fastify({ logger: false });
    installSessionPreHandler(runtimeApp);
    appRoutes(runtimeApp, { appsRoot, getCapabilities: async () => [] });
    await runtimeApp.ready();
    try {
      const exact = await runtimeApp.inject({
        method: "GET",
        url: "/api/apps/nautilo-design/runtime",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      });
      expect(exact.statusCode).toBe(200);
      expect(JSON.parse(exact.body)).toMatchObject({
        appId: "nautilo-design",
        hostCapabilities: { assets: true },
      });

      await writeFile(join(appsRoot, "nautilo-design", "main.ts"), "export {};\n");
      resetInstalledAppRegistryForTests();
      const modified = await runtimeApp.inject({
        method: "GET",
        url: "/api/apps/nautilo-design/runtime",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      });
      expect(modified.statusCode).toBe(200);
      const modifiedBody = JSON.parse(modified.body) as Record<string, unknown>;
      expect(modifiedBody["hostCapabilities"]).toBeUndefined();
    } finally {
      await runtimeApp.close();
    }
  }, 60_000);

  test("build failure returns sanitized 500 without app root path", async () => {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = await mkdtemp(join(tmpdir(), "nautilo-app-routes-buildfail-"));
    const appDir = join(appsRoot, "test-canvas");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "app.json"), `${JSON.stringify(TEST_MINI_APP_MANIFEST, null, 2)}\n`);
    await writeFile(join(appDir, "main.ts"), "this is not valid typescript @@@\n");
    await writeFile(
      join(appDir, "index.html"),
      `<!DOCTYPE html><html><body><div id="app"></div></body></html>\n`,
    );
    await writeFile(join(appDir, "styles.css"), `#app {}\n`);
    await writeFile(
      join(appDir, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );

    const failApp = Fastify({ logger: false });
    installSessionPreHandler(failApp);
    appRoutes(failApp, { appsRoot, getCapabilities: async () => [] });
    await failApp.ready();

    try {
      const res = await failApp.inject({
        method: "GET",
        url: "/api/apps/test-canvas/runtime",
        headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body["error"]).toBe("app_runtime_unavailable");
      expect(body["status"]).toBe("build_failed");
      expect(JSON.stringify(body)).not.toContain(appsRoot);
    } finally {
      await failApp.close();
    }
  });
});

describe("/api/apps/:appId/source", () => {
  test("anonymous tree returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/apps/test-canvas/source/tree" });
    expect(res.statusCode).toBe(401);
  });

  test("non-capable user tree returns 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/tree",
      headers: { "x-test-user-id": USER_WITHOUT_MANAGE },
    });
    expect(res.statusCode).toBe(403);
  });

  test("capable user can list tree and read file", async () => {
    const treeRes = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/tree",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(treeRes.statusCode).toBe(200);
    const tree = JSON.parse(treeRes.body) as {
      files: Array<{ path: string; kind: string }>;
    };
    expect(tree.files.some((entry) => entry.path === "main.ts" && entry.kind === "file")).toBe(
      true,
    );

    const readRes = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(readRes.statusCode).toBe(200);
    const body = JSON.parse(readRes.body) as { path: string; content: string; sha256: string };
    expect(body.path).toBe("main.ts");
    expect(body.sha256).toBe(sha256Hex(body.content));
  });

  test("bad path returns 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/file?path=../main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    expect(res.statusCode).toBe(400);
  });

  test("stale save returns 409 conflict", async () => {
    const readRes = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const readBody = JSON.parse(readRes.body) as { sha256: string };

    const saveRes = await app.inject({
      method: "PUT",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
      payload: {
        content: "export const stale = 1;\n",
        baseSha256: sha256Hex("wrong base"),
      },
    });
    expect(saveRes.statusCode).toBe(409);
    const conflict = JSON.parse(saveRes.body) as { error: string; currentSha256: string };
    expect(conflict.error).toBe("conflict");
    expect(conflict.currentSha256).toBe(readBody.sha256);

    const onDisk = await readFile(join(appsRoot, "test-canvas", "main.ts"), "utf8");
    expect(onDisk).toBe("export {};\n");
  });

  test("successful save returns sourceHash and emits changed event", async () => {
    const readRes = await app.inject({
      method: "GET",
      url: "/api/apps/test-canvas/source/file?path=main.ts",
      headers: { "x-test-user-id": USER_WITH_MANAGE },
    });
    const readBody = JSON.parse(readRes.body) as { content: string; sha256: string };
    const next = "export const saved = 1;\n";

    const events: unknown[] = [];
    const { subscribeAppSourceEvents } = await import("../../src/apps/app-source-events");
    const unsubscribe = subscribeAppSourceEvents((event) => {
      events.push(event);
    });

    try {
      const saveRes = await app.inject({
        method: "PUT",
        url: "/api/apps/test-canvas/source/file?path=main.ts",
        headers: { "x-test-user-id": USER_WITH_MANAGE },
        payload: {
          content: next,
          baseSha256: readBody.sha256,
        },
      });
      expect(saveRes.statusCode).toBe(200);
      const saveBody = JSON.parse(saveRes.body) as {
        ok: boolean;
        sha256: string;
        sourceHash: string;
        status: string;
      };
      expect(saveBody.ok).toBe(true);
      expect(saveBody.sha256).toBe(sha256Hex(next));
      expect(saveBody.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(saveBody.status).toBe("ready");
      expect(events).toContainEqual({
        type: "changed",
        appId: "test-canvas",
        sourceHash: saveBody.sourceHash,
      });
    } finally {
      unsubscribe();
    }
  });

  test("source-save, disable, and enable hot registration retain the canonical identity resolver", async () => {
    const scoped = Fastify({ logger: false });
    installSessionPreHandler(scoped);
    const registrationOptions: Array<Record<string, unknown>> = [];
    const authority = {
      async readCurrentFileCanonical() {
        return { ok: true as const, content: "canonical", sha256: "a".repeat(64) };
      },
      async resolveCanonicalTargetIdentity(input: {
        candidatePath: string;
      }) {
        return {
          ok: true as const,
          canonicalTargetIdentity: `${input.candidatePath}:canonical`,
        };
      },
    } as unknown as LiveLocalDocumentAuthority;
    appRoutes(scoped, {
      appsRoot,
      getCapabilities: async () => ["manage_server_operations"],
      getLiveLocalDocumentAuthority: () => authority,
      registerAppToolsForApp: async (_root, appId, options) => {
        registrationOptions.push(options as Record<string, unknown>);
        return { status: "none", appId };
      },
    });
    await scoped.ready();
    try {
      const read = await scoped.inject({
        method: "GET",
        url: "/api/apps/test-canvas/source/file?path=main.ts",
        headers: { "x-test-user-id": USER_WITH_MANAGE },
      });
      const baseSha256 = (JSON.parse(read.body) as { sha256: string }).sha256;
      const save = await scoped.inject({
        method: "PUT",
        url: "/api/apps/test-canvas/source/file?path=main.ts",
        headers: { "x-test-user-id": USER_WITH_MANAGE },
        payload: { content: "export const hot = true;\n", baseSha256 },
      });
      expect(save.statusCode).toBe(200);
      expect((await scoped.inject({
        method: "POST",
        url: "/api/apps/test-canvas/disable",
        headers: { "x-test-user-id": USER_WITH_MANAGE },
      })).statusCode).toBe(200);
      expect((await scoped.inject({
        method: "POST",
        url: "/api/apps/test-canvas/enable",
        headers: { "x-test-user-id": USER_WITH_MANAGE },
      })).statusCode).toBe(200);

      expect(registrationOptions).toHaveLength(3);
      const resolvers = registrationOptions.map(
        (options) => options["resolveLiveCurrentFileIdentity"],
      );
      expect(resolvers.every((resolver) => typeof resolver === "function")).toBe(true);
      expect(resolvers[1]).toBe(resolvers[0]);
      expect(resolvers[2]).toBe(resolvers[0]);
      const resolved = await (resolvers[0] as (
        input: { ownerId: string; relayId: string; candidatePath: string },
        context: unknown,
      ) => Promise<string | null>)(
        {
          ownerId: USER_WITH_MANAGE,
          relayId: "relay-1",
          candidatePath: "/project/open.doc.html",
        },
        {},
      );
      expect(resolved).toBe("/project/open.doc.html:canonical");
    } finally {
      await scoped.close();
    }
  });
});

describe("/api/apps/events", () => {
  test("anonymous SSE returns 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/apps/events" });
    expect(res.statusCode).toBe(401);
  });
});
