import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { ToolCatalog } from "@nautilo/catalog";
import { buildMiniApp } from "../../src/apps/app-builder";
import { registerAppToolsForApp } from "../../src/apps/app-tool-registration";
import type { AppToolInvokeRequest, AppToolInvokeResult, AppToolRunnerContext } from "../../src/apps/app-tool-types";
import { computeAppSourceHash, scanInstalledApps } from "../../src/apps/app-registry";
import { LiveMiniAppSessionRegistry } from "../../src/apps/live-mini-app-session-registry";
import type { LiveMiniAppSessionBinding } from "../../src/apps/live-mini-app-session-registry";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";
import { buildBoardArtifacts } from "../../../../packaging/wafflebase/board-artifacts";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const BOARD_SOURCE = join(REPO_ROOT, "packages/first-party-apps/board");
const SOURCE_EXCLUSIONS = new Set(["engine", "node_modules", "dist"]);
let firstPartyRoot = "";
let sourceFixtureRoot = "";
let appsRoot = "";

beforeAll(async () => {
  sourceFixtureRoot = await mkdtemp(join(tmpdir(), "nautilo-board-source-"));
  firstPartyRoot = join(sourceFixtureRoot, "first-party-apps");
  const boardRoot = join(firstPartyRoot, "board");
  await mkdir(firstPartyRoot, { recursive: true });
  await cp(BOARD_SOURCE, boardRoot, {
    recursive: true,
    filter: (source) => !relative(BOARD_SOURCE, source).split(sep).some((part) => SOURCE_EXCLUSIONS.has(part)),
  });
  await buildBoardArtifacts(REPO_ROOT, join(boardRoot, "engine"), { build: false });
});

afterAll(async () => {
  if (sourceFixtureRoot) await rm(sourceFixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  if (appsRoot) await rm(appsRoot, { recursive: true, force: true });
  appsRoot = "";
});

async function seedBoard(): Promise<string> {
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-board-app-integration-"));
  expect(await seedFirstPartyApps({
    appsRoot,
    sourceRoot: firstPartyRoot,
    appIds: ["nautilo-board"],
  })).toEqual({ seeded: ["nautilo-board"] });
  return appsRoot;
}

function boardApp(apps: Awaited<ReturnType<typeof scanInstalledApps>>) {
  const app = apps.find((entry) => entry.id === "nautilo-board");
  if (!app) throw new Error("expected seeded Nautilo Board app");
  return app;
}

function runnerContext(overrides: Partial<AppToolRunnerContext> = {}): AppToolRunnerContext {
  return {
    ownerId: "user-1",
    userId: "user-1",
    agentId: "agent-1",
    turnId: "turn-board-1",
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

function parseToolResult(value: unknown): unknown {
  return JSON.parse(String(value)) as unknown;
}

type BoundWriteResult =
  | { kind: "saved"; sha256: string; revision?: number | null }
  | { kind: "conflict"; currentSha256: string | null }
  | { kind: "error"; message: string };

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function invokeBuiltBoardHandler(
  request: AppToolInvokeRequest,
  writeBound: (content: string) => Promise<BoundWriteResult>,
): Promise<AppToolInvokeResult> {
  const bundle = await import(request.bundlePath) as {
    __nautiloAppToolModules?: Record<string, Record<string, unknown>>;
  };
  const handler = bundle.__nautiloAppToolModules?.[request.tool.module]?.[request.tool.handler];
  if (typeof handler !== "function") return { ok: false, error: "built Board handler is unavailable", code: "handler" };
  const boardHandler = handler as (args: unknown, context: unknown) => unknown;
  const unavailable = async () => { throw new Error("unexpected Board host operation"); };
  try {
    return {
      ok: true,
      result: await boardHandler(request.args, {
        nautiloApp: {
          assets: { inspect: unavailable, read: unavailable },
          document: {
            createFromAction: unavailable,
            read: unavailable,
            write: unavailable,
            writeBound: async (next: { content: string }) => writeBound(next.content),
          },
        },
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), code: "handler" };
  }
}

function liveContext(
  token: string,
  documentVersion: LiveMiniAppSessionBinding["documentVersion"],
  toolCallId: string,
  turnId = "turn-board-1",
) {
  return runnerContext({
    toolCallId,
    turnId,
    liveMiniAppSession: {
      appId: "nautilo-board",
      sessionToken: token,
      sessionId: "untrusted-context-session-id",
      documentVersion,
      instructions: "Inspect before editing.",
    },
  });
}

describe("seeded Nautilo Board server integration", () => {
  test("seeds, scans and builds the complete prepared Board outside the monorepo", async () => {
    const root = await seedBoard();
    const app = boardApp(await scanInstalledApps(root));
    expect(app.status).toBe("ready");
    expect(app.manifest?.entry).toBe("./engine/main.js");
    expect(app.manifest?.createActions).toMatchObject([{
      id: "new-board",
      template: { kind: "file", path: "templates/empty-board.html" },
    }]);
    expect(app.manifest?.agent?.tools?.map((tool) => tool.id)).toEqual([
      "create-file",
      "describe-authoring",
      "inspect-board",
      "edit-board",
      "inspect-open-board",
      "edit-open-board",
    ]);
    expect((await stat(join(root, "nautilo-board", "templates", "empty-board.html"))).isFile()).toBe(true);
    expect(await readFile(join(root, "nautilo-board", "templates", "empty-board.html"), "utf8")).toContain('"documentType":"board"');

    const build = await buildMiniApp(app, root);
    expect(build.ok, build.ok ? undefined : build.message).toBe(true);
    if (!build.ok) return;
    expect(build.html).toContain('id="app"');
    expect(build.styles.some((style) => style.content.includes(".board-app"))).toBe(true);
    expect(build.bundleJs).not.toContain(root);
    expect(build.sourceHash).toBe(await computeAppSourceHash(join(root, "nautilo-board")));
    expect(build.agentToolsBuild.status, build.agentToolsBuild.status === "failed" ? build.agentToolsBuild.message : undefined).toBe("ok");
    if (build.agentToolsBuild.status !== "ok") return;
    expect(build.agentToolsBuild.toolNames).toEqual([
      "app_nautilo_board__create_file",
      "app_nautilo_board__describe_authoring",
      "app_nautilo_board__inspect_board",
      "app_nautilo_board__edit_board",
      "app_nautilo_board__inspect_open_board",
      "app_nautilo_board__edit_open_board",
    ]);
    expect((await stat(join(build.cacheDir, "agent-tools.mjs"))).isFile()).toBe(true);
  });

  test("registers Board create and direct-mutation tools with host-owned live authority", async () => {
    const root = await seedBoard();
    const catalog = new ToolCatalog();
    const registry = new LiveMiniAppSessionRegistry();
    const binding = {
      targetKind: "artifact" as const,
      appId: "nautilo-board",
      userId: "user-1",
      namespaceIds: ["ns-1"],
      artifactId: "artifact-1",
      documentId: "document-1",
      documentVersion: { kind: "artifact_revision" as const, revision: 4 },
    };
    const { token } = registry.issue(binding);
    const requests: AppToolInvokeRequest[] = [];
    const result = await registerAppToolsForApp(root, "nautilo-board", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({
        ok: true,
        content: await readFile(join(root, "nautilo-board", "templates", "empty-board.html"), "utf8"),
      }),
      invoke: async (request): Promise<AppToolInvokeResult> => {
        requests.push(request);
        if (request.tool.id === "create-file") {
          return {
            ok: true,
            result: {
              ok: true,
              status: "created",
              target: { surface: "workspace", path: "Launch.board.html" },
              displayPath: "Launch.board.html",
              opened: true,
            },
          };
        }
        return {
          ok: true,
          result: {
            ok: true,
            status: "saved",
            documentVersion: { kind: "artifact_revision", revision: 5 },
            receipt: { operationCount: 1 },
          },
        };
      },
    });
    expect(result).toMatchObject({
      status: "registered",
      appId: "nautilo-board",
      toolCount: 6,
    });

    const create = catalog.getToolsForActor(runnerContext()).find((tool) => tool.name === "app_nautilo_board__create_file");
    if (!create) throw new Error("expected registered Board create tool");
    expect(parseToolResult(await create.invoke({ targetSurface: "workspace", filename: "Launch.board.html" }))).toMatchObject({
      ok: true,
      status: "created",
      target: { surface: "workspace", path: "Launch.board.html" },
      opened: true,
    });
    expect(create.invoke({ targetSurface: "workspace", filename: "Launch.board.html", path: "forged" } as never)).rejects.toThrow();

    const edit = catalog.getToolsForActor(runnerContext({
      toolCallId: "board-live-edit-1",
      liveMiniAppSession: {
        appId: "nautilo-board",
        sessionToken: token,
        sessionId: "trusted-session-id",
        documentVersion: binding.documentVersion,
        instructions: "Inspect before editing.",
      },
    })).find((tool) => tool.name === "app_nautilo_board__edit_open_board");
    if (!edit) throw new Error("expected registered Board live edit tool");
    const saved = parseToolResult(await edit.invoke({
      expectedVersion: JSON.stringify(binding.documentVersion),
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }],
    }));
    expect(saved).toMatchObject({ ok: true, status: "saved", documentVersion: { kind: "artifact_revision", revision: 5 } });
    const liveRequest = requests.find((request) => request.tool.id === "edit-open-board");
    const liveArgs = liveRequest?.args as Record<string, unknown> | undefined;
    expect(liveArgs?.["sessionToken"]).toBe("server-validated-live-session");
    expect(liveArgs?.["sessionToken"]).not.toBe(token);
    expect(liveArgs?.["documentVersion"]).toEqual(binding.documentVersion);
    expect(typeof liveArgs?.["__canonicalContent"]).toBe("string");
    expect(String(liveArgs?.["idempotencyKey"])).toMatch(/^host-[a-f0-9]{64}$/);
    expect(edit.invoke({
      expectedVersion: JSON.stringify(binding.documentVersion),
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }],
      sessionToken: "forged-token",
      documentVersion: { kind: "artifact_revision", revision: 99 },
    } as never)).rejects.toThrow();
  });

  test("runs the bundled Board handler once for concurrent duplicates, replays the receipt and refuses stale or changed retries", async () => {
    const root = await seedBoard();
    const initialContent = await readFile(join(root, "nautilo-board", "templates", "empty-board.html"), "utf8");
    let canonicalContent = initialContent;
    let writeCount = 0;
    let releaseWrite!: () => void;
    let markWriteEntered!: () => void;
    const writeEntered = new Promise<void>((resolve) => { markWriteEntered = resolve; });
    const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const registry = new LiveMiniAppSessionRegistry();
    const binding: LiveMiniAppSessionBinding = {
      targetKind: "artifact",
      appId: "nautilo-board",
      userId: "user-1",
      namespaceIds: ["ns-1"],
      artifactId: "artifact-1",
      documentId: "document-1",
      documentVersion: { kind: "artifact_revision", revision: 4 },
    };
    const { token } = registry.issue(binding);
    const catalog = new ToolCatalog();
    await registerAppToolsForApp(root, "nautilo-board", {
      catalog,
      liveSessionRegistry: registry,
      readLiveCanonical: async () => ({ ok: true, content: canonicalContent }),
      invoke: async (request) => invokeBuiltBoardHandler(request, async (content) => {
        writeCount += 1;
        markWriteEntered();
        await writeRelease;
        canonicalContent = content;
        return { kind: "saved", sha256: sha256(content), revision: 4 + writeCount };
      }),
    });

    const edit = catalog.getToolsForActor(liveContext(token, binding.documentVersion, "board-edit-duplicate-1"))
      .find((tool) => tool.name === "app_nautilo_board__edit_open_board");
    if (!edit) throw new Error("expected registered Board live edit tool");
    const args = {
      expectedVersion: JSON.stringify(binding.documentVersion),
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }],
    };
    const firstPromise = edit.invoke(args);
    await writeEntered;
    expect(parseToolResult(await edit.invoke(args))).toEqual({
      ok: false,
      status: "idempotency_in_progress",
      code: "idempotency_in_progress",
    });
    expect(writeCount).toBe(1);
    releaseWrite();
    const first = String(await firstPromise);
    expect(parseToolResult(first)).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 5 },
      receipt: { operationCount: 1, changedPaths: ["/meta/title"] },
    });
    expect(String(await edit.invoke(args))).toBe(first);
    expect(writeCount).toBe(1);

    expect(parseToolResult(await edit.invoke({
      ...args,
      operations: [{ op: "replace", path: "/meta/title", value: "Changed retry" }],
    }))).toEqual({ ok: false, status: "idempotency_conflict", code: "idempotency_conflict" });
    expect(writeCount).toBe(1);

    const staleEdit = catalog.getToolsForActor(liveContext(token, binding.documentVersion, "board-edit-stale-2"))
      .find((tool) => tool.name === "app_nautilo_board__edit_open_board");
    if (!staleEdit) throw new Error("expected registered Board stale edit tool");
    expect(parseToolResult(await staleEdit.invoke(args))).toMatchObject({
      ok: false,
      status: "stale_version",
      code: "stale_version",
    });
    expect(writeCount).toBe(1);

    const nextTurnEdit = catalog.getToolsForActor(liveContext(
      token,
      { kind: "artifact_revision", revision: 5 },
      "board-edit-duplicate-1",
      "turn-board-2",
    )).find((tool) => tool.name === "app_nautilo_board__edit_open_board");
    if (!nextTurnEdit) throw new Error("expected registered Board next-turn edit tool");
    expect(parseToolResult(await nextTurnEdit.invoke({
      expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 5 }),
      operations: [{ op: "replace", path: "/meta/title", value: "Next turn" }],
    }))).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 6 },
    });
    expect(writeCount).toBe(2);
  });

  for (const targetKind of ["artifact", "currentFile"] as const) {
    test(`releases a failed ${targetKind} Board mutation claim for an exact retry through the bundled handler`, async () => {
      const root = await seedBoard();
      const initialContent = await readFile(join(root, "nautilo-board", "templates", "empty-board.html"), "utf8");
      const initialSha = sha256(initialContent);
      let canonicalContent = initialContent;
      let writeCount = 0;
      const binding: LiveMiniAppSessionBinding = targetKind === "artifact"
        ? {
            targetKind,
            appId: "nautilo-board",
            userId: "user-1",
            namespaceIds: ["ns-1"],
            artifactId: "artifact-1",
            documentId: "document-1",
            documentVersion: { kind: "artifact_revision", revision: 7 },
          }
        : {
            targetKind,
            appId: "nautilo-board",
            userId: "user-1",
            localTargetId: "local-target-1",
            relayId: "relay-1",
            canonicalPath: "/qualified/Ideas.board.html",
            currentFolderRoot: "/qualified",
            relativePath: "Ideas.board.html",
            documentVersion: { kind: "local_sha", sha256: initialSha },
          };
      const documentVersion = binding.documentVersion;
      const registry = new LiveMiniAppSessionRegistry();
      const { token } = registry.issue(binding);
      const catalog = new ToolCatalog();
      await registerAppToolsForApp(root, "nautilo-board", {
        catalog,
        liveSessionRegistry: registry,
        readLiveCanonical: async () => ({ ok: true, content: canonicalContent }),
        invoke: async (request) => invokeBuiltBoardHandler(request, async (content) => {
          writeCount += 1;
          if (writeCount === 1) return { kind: "error", message: "definite refusal before save" };
          canonicalContent = content;
          return targetKind === "artifact"
            ? { kind: "saved", sha256: sha256(content), revision: 8 }
            : { kind: "saved", sha256: sha256(content) };
        }),
      });
      const edit = catalog.getToolsForActor(liveContext(token, documentVersion, `board-${targetKind}-retry-1`))
        .find((tool) => tool.name === "app_nautilo_board__edit_open_board");
      if (!edit) throw new Error("expected registered Board retry tool");
      const args = {
        expectedVersion: JSON.stringify(documentVersion),
        operations: [{ op: "replace", path: "/meta/title", value: `Retried ${targetKind}` }],
      };
      expect(parseToolResult(await edit.invoke(args))).toMatchObject({
        ok: false,
        status: "error",
        code: "bound_write_failed",
        retrySafe: false,
        stateChanged: false,
      });
      const saved = String(await edit.invoke(args));
      expect(parseToolResult(saved)).toMatchObject({
        ok: true,
        status: "saved",
        documentVersion: targetKind === "artifact"
          ? { kind: "artifact_revision", revision: 8 }
          : { kind: "local_sha", sha256: sha256(canonicalContent) },
      });
      expect(String(await edit.invoke(args))).toBe(saved);
      expect(writeCount).toBe(2);
    });
  }
});
