/**
 * M079 — hybrid approval: catalog `approvalMode: "hybrid"` + args.sensitivity
 * feed `resolveApproval` via `resolveApprovalForToolCall`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { ToolCall } from "@langchain/core/messages/tool";
import { z } from "zod";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import {
  buildAskPayload,
  readHybridSensitivity,
  resolveApprovalForToolCall,
} from "../../src/nodes/post-model";
import { interruptValueToServerEvent } from "../../src/graph/interrupt-mapping";

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "1", name, args };
}

describe("readHybridSensitivity", () => {
  test("normal and sensitive are valid", () => {
    expect(readHybridSensitivity({ sensitivity: "normal" })).toEqual({
      value: "normal",
      wasInvalid: false,
    });
    expect(readHybridSensitivity({ sensitivity: "sensitive" })).toEqual({
      value: "sensitive",
      wasInvalid: false,
    });
  });

  test("{} / null / garbage → sensitive + wasInvalid", () => {
    expect(readHybridSensitivity({})).toEqual({ value: "sensitive", wasInvalid: true });
    expect(readHybridSensitivity(null)).toEqual({ value: "sensitive", wasInvalid: true });
    expect(readHybridSensitivity(undefined)).toEqual({ value: "sensitive", wasInvalid: true });
    expect(readHybridSensitivity({ sensitivity: "maybe" })).toEqual({
      value: "sensitive",
      wasInvalid: true,
    });
  });
});

describe("resolveApprovalForToolCall — hybrid_test_tool", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "hybrid_test_tool",
      factory: () =>
        new DynamicStructuredTool({
          name: "hybrid_test_tool",
          description: "M079 hybrid test stub",
          schema: z.object({
            sensitivity: z.enum(["normal", "sensitive"]),
            note: z.string().optional(),
          }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "destructive",
      approvalMode: "hybrid",
    });
    initToolCatalog(catalog);
  });

  afterAll(() => {
    if (catalogBefore) {
      initToolCatalog(catalogBefore);
    } else {
      clearToolCatalog();
    }
  });

  test("sensitivity normal → ask @ standard", () => {
    const r = resolveApprovalForToolCall(
      tc("hybrid_test_tool", { sensitivity: "normal" }),
      "standard",
    );
    expect(r.verb).toBe("ask");
  });

  test("sensitivity sensitive → prove_it @ standard", () => {
    const r = resolveApprovalForToolCall(
      tc("hybrid_test_tool", { sensitivity: "sensitive" }),
      "standard",
    );
    expect(r.verb).toBe("prove_it");
  });

  test("missing sensitivity → prove_it @ standard", () => {
    const r = resolveApprovalForToolCall(tc("hybrid_test_tool", {}), "standard");
    expect(r.verb).toBe("prove_it");
    expect(r.reason).toContain("treated as sensitive");
  });

  test("garbage sensitivity → prove_it @ standard", () => {
    const r = resolveApprovalForToolCall(
      tc("hybrid_test_tool", { sensitivity: "maybe" }),
      "standard",
    );
    expect(r.verb).toBe("prove_it");
    expect(r.reason).toContain("treated as sensitive");
  });

  test("yolo → auto for normal and sensitive", () => {
    expect(
      resolveApprovalForToolCall(tc("hybrid_test_tool", { sensitivity: "normal" }), "yolo").verb,
    ).toBe("auto");
    expect(
      resolveApprovalForToolCall(tc("hybrid_test_tool", { sensitivity: "sensitive" }), "yolo").verb,
    ).toBe("auto");
  });
});

describe("resolveApprovalForToolCall — static high-impact app tool", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "app_sample_app__update_record",
      factory: () =>
        new DynamicStructuredTool({
          name: "app_sample_app__update_record",
          description: "Sample App record update tool",
          schema: z.object({
            target: z.object({ surface: z.string() }),
            recordId: z.string(),
            value: z.unknown(),
          }),
          func: async () => "ok",
        }),
      source: "plugin",
      sourceServer: "app:sample-app:test",
      category: "documents",
      trustTier: "standard",
      executor: "cloud",
      impact: "high",
      requiredCapabilities: ["use_high_impact_tools"],
      requiresApproval: true,
      resultScanPolicy: "on-suspicious",
    });
    initToolCatalog(catalog);
  });

  afterAll(() => {
    if (catalogBefore) {
      initToolCatalog(catalogBefore);
    } else {
      clearToolCatalog();
    }
  });

  test("high-impact static app tools do not require prove_it at standard", () => {
    const r = resolveApprovalForToolCall(
      tc("app_sample_app__update_record", {
        target: { surface: "workspace", path: "Records.html" },
        recordId: "record-1",
        value: "Updated",
      }),
      "standard",
    );
    expect(r.verb).toBe("auto");
  });
});

describe("resolveApprovalForToolCall — manage_local_mcp (D384 §5.4)", () => {
  // No catalog registration needed: the manage_local_mcp branch short-circuits
  // on the tool name + action before any catalog impact lookup matters.
  test("enable → ask @ standard (confirm, NOT prove_it/PIN)", () => {
    const r = resolveApprovalForToolCall(
      tc("manage_local_mcp", { action: "enable", name: "gh" }),
      "standard",
    );
    expect(r.verb).toBe("ask");
  });

  test("enable → auto @ yolo (never escalates), never prove_it at any level", () => {
    for (const level of ["yolo", "permissive", "standard", "cautious", "paranoid"] as const) {
      const verb = resolveApprovalForToolCall(
        tc("manage_local_mcp", { action: "enable", name: "gh" }),
        level,
      ).verb;
      expect(verb).not.toBe("prove_it");
      expect(verb).not.toBe("block");
    }
  });

  test("install → ask at every level; it never becomes a Full Workstation/YOLO auto approval", () => {
    for (const level of ["yolo", "permissive", "standard", "cautious", "paranoid"] as const) {
      expect(
        resolveApprovalForToolCall(
          tc("manage_local_mcp", { action: "install", request: { version: "local-mcp-install-v1" } }),
          level,
        ).verb,
      ).toBe("ask");
    }
  });

  test("remove → ask at every level with once / deny only", () => {
    const remove = tc("manage_local_mcp", { action: "remove", name: "filesystem", relayId: "relay-A" });
    for (const level of ["yolo", "permissive", "standard", "cautious", "paranoid"] as const) {
      expect(resolveApprovalForToolCall(remove, level).verb).toBe("ask");
    }
    const payload = buildAskPayload([
      { tc: remove, approval: resolveApprovalForToolCall(remove, "standard") },
    ], "user-1");
    expect(payload).toMatchObject({
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      tools: [{ name: "manage_local_mcp", args: { action: "remove", name: "filesystem", relayId: "relay-A" } }],
    });
  });

  test("register / disable / list / status → auto @ standard (no dock)", () => {
    for (const action of ["register", "disable", "list", "status"]) {
      expect(
        resolveApprovalForToolCall(tc("manage_local_mcp", { action }), "standard").verb,
      ).toBe("auto");
    }
  });

  test("install emits the exact-review payload and public event with only once / deny", () => {
    const install = tc("manage_local_mcp", {
      action: "install",
      request: { version: "local-mcp-install-v1" },
    });
    const preview = {
      version: "local-mcp-install-v1" as const,
      human: "You",
      machine: "Writer Mac",
      relayId: "relay-1",
      name: "github-mcp",
      transport: { kind: "stdio" as const, command: "npx", args: ["-y", "@modelcontextprotocol/server-github@2025.1.0"] },
      source: { label: "GitHub MCP docs", url: "https://github.com/modelcontextprotocol/servers" },
      package: { name: "@modelcontextprotocol/server-github", version: "2025.1.0" },
      mayDownloadOnFirstRun: true,
      unpinnedPackage: false,
      environment: [{ name: "GITHUB_TOKEN", present: true }],
      availabilitySummary: "Personal — only you can use tools from this MCP.",
      subprocessSandboxed: false as const,
      digest: "approved-digest",
    };
    const payload = buildAskPayload(
      [{ tc: install, approval: resolveApprovalForToolCall(install, "standard") }],
      "user-1",
      { version: "local-mcp-install-v1", digest: "approved-digest", preview },
      "local-mcp-install:thread:tool",
    );
    expect(payload).toMatchObject({
      approvalId: "local-mcp-install:thread:tool",
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      localMcpInstall: { digest: "approved-digest", preview },
    });
    const event = interruptValueToServerEvent(payload as unknown as Record<string, unknown>, "thread", "lane");
    expect(event).toMatchObject({
      type: "approval.ask",
      approvalId: "local-mcp-install:thread:tool",
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      localMcpInstall: { digest: "approved-digest", preview },
    });
  });

  test("never exposes the checkpoint-carried prepared receipt in the public ask tool args", () => {
    const install = tc("manage_local_mcp", {
      action: "install",
      approvalId: "local-mcp-install:thread:lane:call",
      digest: "approved-digest",
      prepared: {
        binding: { actorId: "must-not-leak", deviceSessionId: "must-not-leak" },
        request: { actorId: "must-not-leak", deviceSessionId: "must-not-leak" },
      },
    });
    const payload = buildAskPayload(
      [{ tc: install, approval: resolveApprovalForToolCall(install, "standard") }],
      "user-1",
    );
    expect(payload.tools).toEqual([
      { name: "manage_local_mcp", args: { action: "install" }, id: install.id },
    ]);
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });
});

describe("resolveApprovalForToolCall — mini_app (M189 static destructive)", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "mini_app",
      factory: () =>
        new DynamicStructuredTool({
          name: "mini_app",
          description: "M189 mini-app authoring stub",
          schema: z.object({
            command: z.enum(["list_apps", "create_app"]),
            appId: z.string().optional(),
            files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
          }),
          func: async () => "ok",
        }),
      category: "documents",
      trustTier: "high",
      impact: "destructive",
      requiredCapabilities: ["manage_server_operations"],
      resultScanPolicy: "always",
    });
    initToolCatalog(catalog);
  });

  afterAll(() => {
    if (catalogBefore) {
      initToolCatalog(catalogBefore);
    } else {
      clearToolCatalog();
    }
  });

  test("create_app → ask @ standard (never prove_it)", () => {
    const r = resolveApprovalForToolCall(
      tc("mini_app", {
        command: "create_app",
        appId: "paint-lite",
        files: [{ path: "app.json", content: "{}" }],
      }),
      "standard",
    );
    expect(r.verb).toBe("ask");
    expect(r.verb).not.toBe("prove_it");
  });

  test("legacy sensitivity: sensitive does not reintroduce hybrid prove_it", () => {
    const r = resolveApprovalForToolCall(
      tc("mini_app", {
        command: "create_app",
        appId: "paint-lite",
        files: [{ path: "app.json", content: "{}" }],
        sensitivity: "sensitive",
      }),
      "standard",
    );
    expect(r.verb).toBe("ask");
    expect(r.verb).not.toBe("prove_it");
  });
});

describe("resolveApprovalForToolCall — share_memory stub (M078 hybrid)", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "share_memory",
      factory: () =>
        new DynamicStructuredTool({
          name: "share_memory",
          description: "M078 hybrid stub",
          schema: z.object({
            memory_id: z.string(),
            target_handle: z.string(),
            sensitivity: z.enum(["normal", "sensitive"]),
          }),
          func: async () => "ok",
        }),
      category: "knowledge",
      trustTier: "high",
      impact: "destructive",
      approvalMode: "hybrid",
    });
    initToolCatalog(catalog);
  });

  afterAll(() => {
    if (catalogBefore) {
      initToolCatalog(catalogBefore);
    } else {
      clearToolCatalog();
    }
  });

  test("sensitivity normal → ask @ standard", () => {
    expect(
      resolveApprovalForToolCall(
        tc("share_memory", {
          memory_id: "m1",
          target_handle: "alice",
          sensitivity: "normal",
        }),
        "standard",
      ).verb,
    ).toBe("ask");
  });

  test("sensitivity sensitive → prove_it @ standard", () => {
    expect(
      resolveApprovalForToolCall(
        tc("share_memory", {
          memory_id: "m1",
          target_handle: "alice",
          sensitivity: "sensitive",
        }),
        "standard",
      ).verb,
    ).toBe("prove_it");
  });
});

describe("resolveApprovalForToolCall — ask_peer Artifact composition (D570 hybrid)", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "ask_peer",
      factory: () => new DynamicStructuredTool({
        name: "ask_peer",
        description: "D570 ask_peer stub",
        schema: z.object({}),
        func: async () => "ok",
      }),
      category: "communication",
      trustTier: "standard",
      impact: "destructive",
      approvalMode: "hybrid",
      requiredCapabilities: ["invoke_agents"],
    });
    initToolCatalog(catalog);
  });

  afterAll(() => {
    if (catalogBefore) initToolCatalog(catalogBefore);
    else clearToolCatalog();
  });

  test("ordinary peer contact keeps the established static ask", () => {
    expect(resolveApprovalForToolCall(
      tc("ask_peer", { peer_handle: "elias", message_to_peer: "Hello" }),
      "standard",
    ).verb).toBe("ask");
  });

  test("normal Artifact handoff uses one ask", () => {
    expect(resolveApprovalForToolCall(
      tc("ask_peer", {
        peer_handle: "elias",
        message_to_peer: "Review this",
        include_focused_artifacts: true,
        sensitivity: "normal",
      }),
      "standard",
    ).verb).toBe("ask");
  });

  test("sensitive Artifact handoff requires prove_it", () => {
    expect(resolveApprovalForToolCall(
      tc("ask_peer", {
        peer_handle: "elias",
        message_to_peer: "Review this",
        artifact_ids: ["doc-1"],
        sensitivity: "sensitive",
      }),
      "standard",
    ).verb).toBe("prove_it");
  });
});
