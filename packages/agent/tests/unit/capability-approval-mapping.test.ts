/**
 * Capability-scoped standing approval wiring in post-model.
 *
 * Tests pure helpers + the ask/auto match + persist paths without Postgres.
 */

import { afterAll, afterEach, beforeAll, describe, test, expect } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  ToolCatalog,
  clearToolCatalog,
  getToolCatalog,
  initToolCatalog,
} from "@nautilo/catalog";
import type { PolicyResolver, ToolAccessDecision } from "@nautilo/trust";
import {
  buildApprovalScopeInfo,
  buildAskPayload,
  capabilitySignatureKey,
  createPostModelNode,
  requiredCapabilityForTool,
  standingApprovalCapabilityForTool,
  standingApprovalScopeForVerb,
  type PostModelDeps,
} from "../../src/nodes/post-model";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

function tc(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "tc-1", name, args };
}

function makeState(
  messages: NautiloState["messages"],
  activatedToolNames: string[] = [],
): NautiloState {
  return {
    messages,
    threadId: 42,
    langgraphThreadId: "",
    model: null,
    userId: "test-owner",
    personaId: "owner",
    voiceMode: false,
    source: "tui",
    assistantName: "Genie",
    soulFile: "",
    memoryBrief: "",
    memoryDelta: "",
    currentThreadId: "",
    preparedMessages: [],
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "",
    roomId: "room-abc",
    roomRoster: [],
    approvalDenied: false,
    turnId: "",
    explicitlySelected: false,
    currentFolder: "",
    currentFolderRelayId: "",
    workspacePath: "",
    activeMiniApp: null,
    artifactRefs: [],
    userTimezone: "UTC",
    previousUserMessageAt: null,
    securityAuditClientMeta: null,
    toolWhitelist: undefined,
    activatedToolNames,
    relayCapabilities: undefined,
    subagentDepth: 0,
    subagentMaxDepth: MAX_SUBAGENT_DEPTH,
    suppressToolLifecycleEvents: false,
    subagentRun: false,
    taskRun: false,
    skills: [],
    engagedSkillNames: [],
    awaitResponse: false,
    awaitRoomId: "",
    awaitFromUserIds: [],
    awaitTaskId: "",
    awaitTaskRunId: "",
    awaitOwnerId: "",
  };
}

function makeMockResolver(
  decisions: Record<string, ToolAccessDecision>,
): PolicyResolver {
  return {
    resolveContext: async () => ({
      laneKey: "",
      actorId: "",
      agentId: "",
      roomId: "",
      roomType: "",
      graphThreadId: "",
      actorLabel: "",
      actorFederatedId: "",
      agentFederatedId: "",
      speakerTrust: "verified" as const,
      laneScope: "private" as const,
      actorRole: "owner",
      memoryAccess: {
        ownerId: "",
        actorId: "",
        agentId: "",
        roomId: "",
        readableNamespaces: [],
        mutableNamespaces: [],
        writableNamespaces: [],
        toolPolicy: {},
      },
    }),
    buildEnvelope: async () => ({
      toolPolicy: {} as Record<string, "allow" | "read_only" | "require_prove_it" | "forbidden">,
      ownerId: "",
      actorId: "",
      agentId: "",
      roomId: "",
      readableNamespaces: [],
      mutableNamespaces: [],
      writableNamespaces: [],
    }),
    checkToolAccess: async (_actorId, tool) =>
      decisions[tool.name] ?? { type: "allow" as const },
    routeApproval: async () => ({ type: "prove_it" as const, approvers: [] }),
  };
}

describe("requiredCapabilityForTool", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "cap_gated_tool",
      factory: () =>
        new DynamicStructuredTool({
          name: "cap_gated_tool",
          description: "capability test stub",
          schema: z.object({ action: z.string() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    catalog.register({
      name: "open_tool",
      factory: () =>
        new DynamicStructuredTool({
          name: "open_tool",
          description: "no capability stub",
          schema: z.object({}),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "low",
      requiredCapabilities: [],
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

  test("returns catalog requiredCapability when registered", () => {
    expect(requiredCapabilityForTool("cap_gated_tool")).toBe("control_desktop");
  });

  test("returns null when tool has no required capability", () => {
    expect(requiredCapabilityForTool("open_tool")).toBeNull();
  });

  test("unknown tool fails closed to the internal ungrantable sentinel", () => {
    expect(requiredCapabilityForTool("totally_unknown_xyz")).toBe("__unregistered_tool_forbidden__");
  });
});

describe("standing approval capability allowlist", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_action",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_action",
          description: "desktop stub",
          schema: z.object({}),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    catalog.register({
      name: "run_shell",
      factory: () =>
        new DynamicStructuredTool({
          name: "run_shell",
          description: "shell stub",
          schema: z.object({ command: z.string() }),
          func: async () => "ok",
        }),
      category: "development",
      trustTier: "admin",
      impact: "destructive",
      requiredCapabilities: ["use_workstation"],
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

  test("allows capability standing approvals only for control_desktop", () => {
    expect(standingApprovalCapabilityForTool("test_control_action")).toBe("control_desktop");
    expect(standingApprovalCapabilityForTool("run_shell")).toBeNull();
  });
});

describe("standingApprovalScopeForVerb", () => {
  test("does not silently widen room scope when no roomId exists", () => {
    expect(standingApprovalScopeForVerb("room", null)).toBeNull();
    expect(standingApprovalScopeForVerb("room", "")).toBeNull();
    expect(standingApprovalScopeForVerb("room", "room-1")).toBe("room");
    expect(standingApprovalScopeForVerb("always", null)).toBe("server");
    expect(standingApprovalScopeForVerb("once", "room-1")).toBeNull();
  });
});

describe("buildApprovalScopeInfo", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_action",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_action",
          description: "desktop stub",
          schema: z.object({ x: z.number(), y: z.number() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    catalog.register({
      name: "discover_tools",
      factory: () =>
        new DynamicStructuredTool({
          name: "discover_tools",
          description: "open stub",
          schema: z.object({}),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "read-only",
      requiredCapabilities: [],
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

  test("capability-gated tool surfaces capability grain for room/always", () => {
    const info = buildApprovalScopeInfo(tc("test_control_action", { x: 10, y: 20 }));
    expect(info.approvalKind).toBe("capability");
    expect(info.capabilitySlug).toBe("control_desktop");
    expect(info.generalizedDisplay).toBe("capability: control_desktop");
    expect(info.sameAsOnce).toBe(false);
    expect(info.onceDisplay).toContain("test_control_action");
  });

  test("tool without requiredCapability keeps exact-command grain", () => {
    const info = buildApprovalScopeInfo(tc("discover_tools", {}));
    expect(info.approvalKind).toBe("tool");
    expect(info.capabilitySlug).toBeUndefined();
    expect(info.generalizedDisplay).toBe("discover_tools");
    expect(info.sameAsOnce).toBe(true);
  });
});

describe("buildAskPayload — capability scopeInfo", () => {
  let catalogBefore: ReturnType<typeof getToolCatalog>;

  beforeAll(() => {
    catalogBefore = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_observation",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_observation",
          description: "desktop stub",
          schema: z.object({}),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
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

  test("includes capability scopeInfo index-aligned with tools", () => {
    const payload = buildAskPayload([
      {
        tc: tc("test_control_observation", {}),
        approval: { severity: "high-impact", verb: "ask", reason: "high-impact tool" },
      },
    ]);
    expect(payload.scopeInfo).toHaveLength(1);
    expect(payload.scopeInfo![0]).toEqual({
      onceDisplay: "test_control_observation",
      generalizedDisplay: "capability: control_desktop",
      sameAsOnce: false,
      approvalKind: "capability",
      capabilitySlug: "control_desktop",
    });
  });
});

describe("capabilitySignatureKey", () => {
  test("is deterministic per slug", () => {
    expect(capabilitySignatureKey("control_desktop")).toBe("capability:control_desktop");
  });
});

describe("post-model standing approval match order", () => {
  afterEach(() => {
    clearToolCatalog();
  });

  test.each(["allow", "require_approval"] as const)(
    "unavailable protected Memory preparation cannot enter %s execution or approval", async (decisionType) => {
      clearToolCatalog();
      let preparations = 0;
      let mutations = 0;
      const state = makeState([new AIMessage({ content: "", tool_calls: [{
        id: "protected-share", name: "share_memory", args: {
          mode: "attach", memory_id: "synthetic-memory", target_handle: "qa-recipient",
          sensitivity: "normal",
        },
      }] })]);
      state.memoryAccessEnvelope = {
        ownerId: state.userId, actorId: "qa-actor", agentId: "qa-agent", roomId: "qa-room",
        readableNamespaces: ["qa-namespace"], mutableNamespaces: ["qa-namespace"],
        writableNamespaces: ["qa-namespace"], toolPolicy: {},
      };
      const result = await createPostModelNode(makeMockResolver({
        share_memory: decisionType === "allow" ? { type: "allow" }
          : { type: "require_approval", route: { type: "prove_it", approvers: [state.userId] } },
      }), {
        protectedMemoryAccessPortForState: () => ({
          async prepareApproval() {
            preparations += 1;
            return { status: "unavailable", reason: "target_encryption_not_ready" };
          },
          async change() { mutations += 1; throw new Error("must not mutate"); },
        }),
      })(state);
      expect(preparations).toBe(1);
      expect(mutations).toBe(0);
      expect(result.approvedToolCalls).toEqual([]);
      expect(result.pendingApproval).toEqual([]);
      expect(result.messages?.at(-1)?.content).toContain("target Namespace encryption is not ready");
      expect(result.messages?.at(-1)?.additional_kwargs["nautilo_tool_status"]).toBe("error");
    },
  );

  test("capability match wins before exact command match", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_type",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_type",
          description: "desktop stub",
          schema: z.object({ text: z.string() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    initToolCatalog(catalog);

    let capabilityCalled = false;
    let commandCalled = false;
    const deps: PostModelDeps = {
      matchCapabilityApproval: async () => {
        capabilityCalled = true;
        return { id: "cap-rule", scope: "room" as const };
      },
      matchCommandApproval: async () => {
        commandCalled = true;
        return { id: "cmd-rule", scope: "server" as const };
      },
    };
    const resolver = makeMockResolver({
      test_control_type: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    const result = await node(
      makeState([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "test_control_type", args: { text: "hi" } }],
        }),
      ], ["test_control_type"]),
    );

    expect(result.approvedToolCalls).toHaveLength(1);
    expect(capabilityCalled).toBe(true);
    expect(commandCalled).toBe(false);
  });

  test("falls back to exact command match when capability misses", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_key",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_key",
          description: "desktop stub",
          schema: z.object({ key: z.string() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    initToolCatalog(catalog);

    let commandCalled = false;
    const deps: PostModelDeps = {
      matchCapabilityApproval: async () => null,
      matchCommandApproval: async () => {
        commandCalled = true;
        return { id: "cmd-rule", scope: "server" as const };
      },
    };
    const resolver = makeMockResolver({
      test_control_key: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    const result = await node(
      makeState([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "test_control_key", args: { key: "Enter" } }],
        }),
      ], ["test_control_key"]),
    );

    expect(result.approvedToolCalls).toHaveLength(1);
    expect(commandCalled).toBe(true);
  });

  test("capability auto-approval uses capability audit signature key", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "test_control_app",
      factory: () =>
        new DynamicStructuredTool({
          name: "test_control_app",
          description: "desktop stub",
          schema: z.object({ action: z.string() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "high",
      requiredCapabilities: ["control_desktop"],
    });
    initToolCatalog(catalog);

    const audit: Array<{ signatureKey: string }> = [];
    const deps: PostModelDeps = {
      matchCapabilityApproval: async () => ({ id: "cap-1", scope: "server" as const }),
      recordAutoApproval: (info) => audit.push({ signatureKey: info.signatureKey }),
    };
    const resolver = makeMockResolver({
      test_control_app: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    await node(
      makeState([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "test_control_app", args: { action: "focus" } }],
        }),
      ], ["test_control_app"]),
    );

    expect(audit).toEqual([{ signatureKey: "capability:control_desktop" }]);
  });

  test("tools without requiredCapability only consult exact command matcher", async () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: "session_search",
      factory: () =>
        new DynamicStructuredTool({
          name: "session_search",
          description: "open stub",
          schema: z.object({ query: z.string() }),
          func: async () => "ok",
        }),
      category: "meta",
      trustTier: "standard",
      impact: "read-only",
      requiredCapabilities: [],
    });
    initToolCatalog(catalog);

    let capabilityCalled = false;
    let commandCalled = false;
    const deps: PostModelDeps = {
      matchCapabilityApproval: async () => {
        capabilityCalled = true;
        return { id: "cap", scope: "server" as const };
      },
      matchCommandApproval: async () => {
        commandCalled = true;
        return { id: "cmd", scope: "server" as const };
      },
    };
    const resolver = makeMockResolver({
      session_search: {
        type: "require_approval",
        route: { type: "prove_it", approvers: ["owner-id"] },
      },
    });
    const node = createPostModelNode(resolver, deps);
    const result = await node(
      makeState([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "tc1", name: "session_search", args: { query: "x" } }],
        }),
      ], ["session_search"]),
    );

    expect(result.approvedToolCalls).toHaveLength(1);
    expect(capabilityCalled).toBe(false);
    expect(commandCalled).toBe(true);
  });
});
