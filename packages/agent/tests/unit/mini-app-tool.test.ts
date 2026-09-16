import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import * as skillsDb from "@nautilo/db";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { getBundledSkill } from "../../src/skills/bundled";
import { registerAllTools } from "../../src/tools/register-all";
import {
  createMiniAppTool,
  dispatchMiniAppCommand,
  miniAppToolSchema,
  resolveMiniAppActorUserId,
} from "../../src/tools/apps/mini-app";
import {
  resetMiniAppToolRuntimeForTests,
  setMiniAppToolRuntime,
  type MiniAppToolRuntime,
} from "../../src/tools/apps/mini-app-runtime";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";

const READ_CTX = { userId: USER_ID };
const OWNER_CTX = { ownerId: OWNER_ID };

describe("mini_app tool (M189)", () => {
  const calls: string[] = [];

  afterEach(() => {
    resetMiniAppToolRuntimeForTests();
    calls.length = 0;
  });

  function stubRuntime(overrides: Partial<MiniAppToolRuntime> = {}): MiniAppToolRuntime {
    const runtime: MiniAppToolRuntime = {
      listApps: async () => {
        calls.push("listApps");
        return { ok: true, apps: [{ id: "sample-app", status: "ready" }] };
      },
      inspectApp: async (_ctx, input) => {
        calls.push(`inspectApp:${input.appId}`);
        return { ok: true, appId: input.appId, status: "ready" };
      },
      readSource: async (_ctx, input) => {
        calls.push(`readSource:${input.appId}:${input.path}`);
        return { ok: true, appId: input.appId, path: input.path, content: "console.log('hi');" };
      },
      createApp: async (_ctx, input) => {
        calls.push(`createApp:${input.appId}`);
        return {
          ok: true,
          command: "create_app",
          appId: input.appId,
          status: "ready",
          sourceHash: "abc",
          filesWritten: input.files.map((f) => f.path),
        };
      },
      applySourceBatch: async () => {
        calls.push("applySourceBatch");
        return { ok: true, command: "apply_source_batch", appId: "paint-lite", status: "ready" };
      },
      validateApp: async () => {
        calls.push("validateApp");
        return { ok: true, command: "validate_app", appId: "paint-lite", status: "ready" };
      },
      ...overrides,
    };
    setMiniAppToolRuntime(runtime);
    return runtime;
  }

  test("createMiniAppTool().name === 'mini_app'", () => {
    expect(createMiniAppTool().name).toBe("mini_app");
  });

  test("wire schema is a flat z.object (provider-friendly)", () => {
    expect(miniAppToolSchema instanceof z.ZodObject).toBe(true);
  });

  test("schema rejects unknown command", () => {
    expect(() => miniAppToolSchema.parse({ command: "delete_app" })).toThrow();
  });

  test("schema does not expose or accept sensitivity (stripped as unknown)", () => {
    expect("sensitivity" in miniAppToolSchema.shape).toBe(false);
    const parsed = miniAppToolSchema.parse({
      command: "create_app",
      appId: "paint-lite",
      files: [{ path: "app.json", content: "{}" }],
      sensitivity: "sensitive",
    });
    expect(parsed).not.toHaveProperty("sensitivity");
  });

  test("list_apps calls runtime and returns compact JSON", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand({ command: "list_apps" }, READ_CTX);
    const body = JSON.parse(raw) as { ok: boolean; apps: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    expect(body.apps[0]?.id).toBe("sample-app");
    expect(calls).toEqual(["listApps"]);
  });

  test("read_source calls runtime with its caller-owned byte range", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand(
      {
        command: "read_source",
        appId: "paint-lite",
        path: "main.ts",
        offsetBytes: 12,
        lengthBytes: 200,
        expectedSha256: "previous-sha",
      },
      READ_CTX,
    );
    const body = JSON.parse(raw) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("main.ts");
    expect(calls[0]).toBe("readSource:paint-lite:main.ts");
  });

  test("read_source returns an explicit response larger than the unrelated 24K JSON bound", async () => {
    const content = "💥".repeat(8_001);
    stubRuntime({
      readSource: async (_ctx, input) => ({
        ok: true,
        appId: input.appId,
        path: input.path,
        content,
        sha256: "source-sha",
        totalBytes: Buffer.byteLength(content, "utf8"),
        offsetBytes: 0,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        nextOffsetBytes: Buffer.byteLength(content, "utf8"),
        complete: true,
      }),
    });

    const raw = await dispatchMiniAppCommand(
      { command: "read_source", appId: "paint-lite", path: "main.ts" },
      READ_CTX,
    );
    const body = JSON.parse(raw) as {
      content: string;
      totalBytes: number;
      returnedBytes: number;
      complete: boolean;
    };

    expect(body.content).toBe(content);
    expect(body.totalBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(body.returnedBytes).toBe(body.totalBytes);
    expect(body.complete).toBe(true);
    expect("offsetBytes" in miniAppToolSchema.shape).toBe(true);
    expect("lengthBytes" in miniAppToolSchema.shape).toBe(true);
    expect("expectedSha256" in miniAppToolSchema.shape).toBe(true);
  });

  test("read_source rejects continuation without its prior source hash", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand(
      { command: "read_source", appId: "paint-lite", path: "main.ts", offsetBytes: 1 },
      READ_CTX,
    );
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: "invalid_range",
      message: "expectedSha256 is required for continuation beyond offsetBytes 0",
    });
    expect(calls).toEqual([]);
  });

  test("read_source exposes typed stale_source without content", async () => {
    stubRuntime({
      readSource: async () => ({
        ok: false,
        error: "stale_source",
        expectedSha256: "previous-sha",
        currentSha256: "current-sha",
      }),
    });
    const raw = await dispatchMiniAppCommand(
      {
        command: "read_source",
        appId: "paint-lite",
        path: "main.ts",
        offsetBytes: 4,
        expectedSha256: "previous-sha",
      },
      READ_CTX,
    );
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      error: "stale_source",
      expectedSha256: "previous-sha",
      currentSha256: "current-sha",
    });
    expect(body).not.toHaveProperty("content");
  });

  test("create_app calls runtime with files payload", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand(
      {
        command: "create_app",
        appId: "paint-lite",
        files: [
          { path: "app.json", content: "{}" },
          { path: "main.ts", content: "// app" },
        ],
      },
      OWNER_CTX,
    );
    const body = JSON.parse(raw) as { ok: boolean; appId: string; filesWritten: string[] };
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("paint-lite");
    expect(body.filesWritten).toEqual(["app.json", "main.ts"]);
    expect(calls[0]).toBe("createApp:paint-lite");
  });

  test("missing authenticated context fails closed", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand({ command: "list_apps" }, {});
    const body = JSON.parse(raw) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("authenticated user context");
    expect(calls).toEqual([]);
  });

  test("mutation without direct userId/ownerId fails closed", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand(
      {
        command: "create_app",
        appId: "paint-lite",
        files: [{ path: "app.json", content: "{}" }],
      },
      {
        memoryAccessEnvelope: {
          ownerId: USER_ID,
          actorId: "actor",
          agentId: "agent",
          roomId: "room",
          readableNamespaces: [],
          mutableNamespaces: [],
          writableNamespaces: [],
          toolPolicy: {},
        },
      },
    );
    const body = JSON.parse(raw) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("mutations require authenticated user context");
    expect(calls).toEqual([]);
  });

  test("missing runtime fails closed with clear error string", async () => {
    const raw = await dispatchMiniAppCommand({ command: "list_apps" }, READ_CTX);
    const body = JSON.parse(raw) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("runtime not set");
  });

  test("runtime errors become error JSON strings", async () => {
    stubRuntime({
      listApps: async () => {
        throw new Error("apps root unavailable");
      },
    });
    const raw = await dispatchMiniAppCommand({ command: "list_apps" }, READ_CTX);
    const body = JSON.parse(raw) as { ok: boolean; error: string; command?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("apps root unavailable");
  });

  test("handler rejects malformed command args (missing appId on read_source)", async () => {
    stubRuntime();
    const raw = await dispatchMiniAppCommand({ command: "read_source", path: "main.ts" }, READ_CTX);
    const body = JSON.parse(raw) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("requires appId and path");
    expect(calls).toEqual([]);
  });

  test("resolveMiniAppActorUserId prefers userId then ownerId then envelope", () => {
    expect(resolveMiniAppActorUserId({ userId: USER_ID, ownerId: OWNER_ID })).toBe(USER_ID);
    expect(resolveMiniAppActorUserId({ ownerId: OWNER_ID })).toBe(OWNER_ID);
    expect(
      resolveMiniAppActorUserId({
        memoryAccessEnvelope: {
          ownerId: USER_ID,
          actorId: "a",
          agentId: "g",
          roomId: "r",
          readableNamespaces: [],
          mutableNamespaces: [],
          writableNamespaces: [],
          toolPolicy: {},
        },
      }),
    ).toBe(USER_ID);
  });
});

describe("mini-app-authoring bundled skill gating", () => {
  test("requires mini_app tool", () => {
    const skill = getBundledSkill("mini-app-authoring");
    expect(skill).toBeDefined();
    expect(skill!.requiresTools).toEqual(["mini_app"]);
    expect(skill!.source).toBe("official");
    expect(skill!.version).toBe(1);
  });

  test("appears in discover_skills when mini_app is allowed", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    const sp = spyOn(skillsDb, "getEnabledBodies").mockImplementation(async () => []);

    try {
      const { createDiscoverSkillsTool } = await import("../../src/tools/skills/discover-skills");
      const tool = createDiscoverSkillsTool({
        ownerId: USER_ID,
        agentId: "20000000-0000-4000-8000-0000000000a1",
        actorRole: "owner",
        memoryAccessEnvelope: {
          ownerId: USER_ID,
          actorId: "actor-a",
          agentId: "20000000-0000-4000-8000-0000000000a1",
          roomId: "room-a",
          readableNamespaces: [],
          mutableNamespaces: [],
          writableNamespaces: [],
          toolPolicy: { mini_app: "allow" },
        },
      });

      const raw = await tool.invoke({});
      const parsed = JSON.parse(raw) as { results: Array<{ name: string }> };
      expect(parsed.results.map((r) => r.name)).toContain("mini-app-authoring");
    } finally {
      sp.mockRestore();
      clearToolCatalog();
    }
  });

  test("withheld when mini_app is not in tool policy", async () => {
    const sp = spyOn(skillsDb, "getEnabledBodies").mockImplementation(async () => [
      {
        id: "plain",
        name: "plain",
        description: "No deps",
        body: "# plain",
        requiresTools: [],
      },
    ]);

    try {
      const { createDiscoverSkillsTool } = await import("../../src/tools/skills/discover-skills");
      const tool = createDiscoverSkillsTool({
        ownerId: USER_ID,
        agentId: "20000000-0000-4000-8000-0000000000a1",
      });
      const raw = await tool.invoke({});
      const parsed = JSON.parse(raw) as { results: Array<{ name: string }> };
      const names = parsed.results.map((r) => r.name);
      expect(names).toContain("plain");
      expect(names).not.toContain("mini-app-authoring");
    } finally {
      sp.mockRestore();
    }
  });
});
