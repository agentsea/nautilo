/**
 * Stack 57 — run_shell tiered per-call timeout (Phase 0 of agent-waiting spec).
 *
 * Covers:
 *  - resolveRunShellTimeout (pure tier logic): omit / ≤soft / soft→hard with &
 *    without reason / >hard / invalid.
 *  - toolsNode integration: forwards ms timeout, omits key when absent, and
 *    returns a coherent error (without dispatching) on a tier violation.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { toolsNode, setRelayRegistry, type ToolRelayRegistry } from "../../src/nodes/tools";
import { createRunShellTool, resolveRunShellTimeout } from "../../src/tools/shell/run-shell";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

const CAPS = { soft: 1800, hard: 14400 } as const;

// ---------------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------------

describe("resolveRunShellTimeout — tiers", () => {
  test("omitted → ok with undefined (relay keeps 60s default)", () => {
    expect(resolveRunShellTimeout({ command: "x" }, CAPS)).toEqual({
      ok: true,
      timeoutMs: undefined,
      requiresReason: false,
    });
  });

  test("≤ soft → used as-is, no reason needed", () => {
    expect(resolveRunShellTimeout({ command: "x", timeout_seconds: 120 }, CAPS)).toEqual({
      ok: true,
      timeoutMs: 120_000,
      requiresReason: false,
    });
  });

  test("exactly soft → allowed", () => {
    expect(resolveRunShellTimeout({ command: "x", timeout_seconds: 1800 }, CAPS)).toEqual({
      ok: true,
      timeoutMs: 1_800_000,
      requiresReason: false,
    });
  });

  test("soft < t ≤ hard WITHOUT reason → error mentioning the soft cap", () => {
    const r = resolveRunShellTimeout({ command: "x", timeout_seconds: 3600 }, CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("1800s soft cap");
  });

  test("soft < t ≤ hard WITH a non-empty reason → allowed", () => {
    const r = resolveRunShellTimeout(
      { command: "x", timeout_seconds: 3600, timeout_reason: "full integration suite, ~45 min" },
      CAPS,
    );
    expect(r).toEqual({ ok: true, timeoutMs: 3_600_000, requiresReason: true });
  });

  test("short meaningful reason is accepted above the soft cap", () => {
    const r = resolveRunShellTimeout(
      { command: "x", timeout_seconds: 3600, timeout_reason: "slow" },
      CAPS,
    );
    expect(r).toEqual({ ok: true, timeoutMs: 3_600_000, requiresReason: true });
  });

  test("empty and whitespace-only reasons are rejected above the soft cap", () => {
    for (const timeout_reason of ["", "   ", "\n\t"]) {
      const r = resolveRunShellTimeout(
        { command: "x", timeout_seconds: 3600, timeout_reason },
        CAPS,
      );
      expect(r.ok).toBe(false);
    }
  });

  test("> hard → refused even with a reason, points away from blocking", () => {
    const r = resolveRunShellTimeout(
      { command: "x", timeout_seconds: 20000, timeout_reason: "a very thorough justification" },
      CAPS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("hard cap");
  });

  test("non-number / sub-1 are rejected", () => {
    expect(resolveRunShellTimeout({ command: "x", timeout_seconds: "120" as unknown as number }, CAPS).ok).toBe(false);
    expect(resolveRunShellTimeout({ command: "x", timeout_seconds: 0 }, CAPS).ok).toBe(false);
  });

  test("output artifact retrieval rejects timeout fields through the canonical resolver", () => {
    const r = resolveRunShellTimeout({
      output_artifact: { reference: "x" },
      timeout_seconds: 30,
    }, CAPS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("output_artifact retrieval");
  });
});

// ---------------------------------------------------------------------------
// toolsNode integration
// ---------------------------------------------------------------------------

type RelayDispatchRequest = {
  toolName: string;
  args: Record<string, unknown>;
  impact: "read-only" | "low" | "high" | "destructive";
  approvalObtained: boolean;
  allowedRoots?: string[] | undefined;
  timeout?: number;
  signal?: AbortSignal;
};

function makeCapturingRegistry(sink: { req?: RelayDispatchRequest }): ToolRelayRegistry {
  const registry = {
    findByCapabilityForUser: () => ["mock-relay-1"],
    getCapabilities: () => ({
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      canRunShell: true,
      allowedRoots: ["/tmp"],
      securityLevel: "standard",
    }),
    dispatch: (_relayId: string, req: RelayDispatchRequest) => {
      sink.req = req;
      return Promise.resolve({ status: "ok", result: "done" });
    },
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    updatePresence: () => {},
    resolveDispatch: () => {},
    cancelDispatch: () => {},
    listConnected: () => Promise.resolve(["mock-relay-1"]),
    findByCapability: () => ["mock-relay-1"],
    start: () => {},
    stop: () => {},
  };
  return registry as unknown as ToolRelayRegistry;
}

function makeState(args: Record<string, unknown>): NautiloState {
  return {
    messages: [
      new AIMessage({ content: "", tool_calls: [{ id: "tc-run_shell", name: "run_shell", args }] }),
    ],
    threadId: 0,
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
    approvedToolCalls: [{ id: "tc-run_shell", name: "run_shell", args, type: "tool_call" }],
    requiredHostRelays: { "tc-run_shell": "mock-relay-1" },
    pendingApproval: [],
    memoryAccessEnvelope: null,
    actorRole: "owner",
    agentId: "",
    roomId: "",
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
    // toolsNode executes only the progressive set. Direct execution fixtures
    // must model the earlier activation step explicitly.
    activatedToolNames: ["run_shell"],
    relayCapabilities: {
      use_high_impact_tools: true,
    },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "test-owner",
      actorId: "actor-1",
      relayId: "mock-relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "generation-1",
      requestId: "tc-run_shell",
    },
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

function buildCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "run_shell",
    factory: () =>
      new DynamicStructuredTool({
        name: "run_shell",
        description: "stub",
        schema: z.object({
          command: z.string(),
          timeout_seconds: z.number().optional(),
          timeout_reason: z.string().optional(),
        }),
        func: () => Promise.reject(new Error("relay tool — should not invoke locally")),
      }),
    category: "development",
    executor: "relay",
    trustTier: "admin",
    impact: "destructive",
    requiredCapabilities: ["use_high_impact_tools"],
    tags: [],
    resultScanPolicy: "on-suspicious",
  });
  return catalog;
}

function contentOf(msg: { content: unknown } | undefined): string {
  if (!msg) return "";
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

beforeAll(() => {
  initToolCatalog(buildCatalog());
});

describe("toolsNode — run_shell timeout threading", () => {
  test("forwards timeout_seconds as ms when within soft cap", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({ command: "sleep 100", timeout_seconds: 120 }));
    expect(sink.req?.timeout).toBe(120_000);
  });

  test("omits timeout key when absent (relay keeps 60s default)", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({ command: "echo hi" }));
    expect(sink.req).toBeDefined();
    expect("timeout" in (sink.req as object)).toBe(false);
  });

  test("forwards the enclosing graph AbortSignal for a raw command", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    const controller = new AbortController();
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({ command: "sleep 100" }), { signal: controller.signal });
    expect(sink.req?.signal).toBe(controller.signal);
  });

  test("over soft cap without reason → error returned, NOT dispatched", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    const out = await toolsNode(makeState({ command: "long", timeout_seconds: 3600 }));
    expect(sink.req).toBeUndefined(); // never dispatched
    expect(contentOf(out.messages?.slice(-1)[0]).toLowerCase()).toContain("soft cap");
  });

  test("over soft cap WITH a short meaningful reason → dispatched at the requested ms", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(
      makeState({ command: "suite", timeout_seconds: 3600, timeout_reason: "slow" }),
    );
    expect(sink.req?.timeout).toBe(3_600_000);
  });

  test("continuation retrieval dispatches in the run_shell family without a process timeout", async () => {
    const sink: { req?: RelayDispatchRequest } = {};
    setRelayRegistry(makeCapturingRegistry(sink));
    await toolsNode(makeState({
      output_artifact: { reference: "opaque-reference-that-is-long-enough", offset_bytes: 16_384 },
    }));
    expect(sink.req?.args).toEqual({
      output_artifact: { reference: "opaque-reference-that-is-long-enough", offset_bytes: 16_384 },
    });
    expect("timeout" in (sink.req as object)).toBeFalse();
  });

  test("continuation retrieval rejects shell timeout fields and mixed execution modes", async () => {
    for (const args of [
      {
        output_artifact: { reference: "opaque-reference-that-is-long-enough" },
        timeout_seconds: 10,
      },
      {
        command: "echo wrong",
        output_artifact: { reference: "opaque-reference-that-is-long-enough" },
      },
      {
        output_artifact: { reference: "opaque-reference-that-is-long-enough" },
        execution: "workstation",
      },
    ]) {
      const sink: { req?: RelayDispatchRequest } = {};
      setRelayRegistry(makeCapturingRegistry(sink));
      const out = await toolsNode(makeState(args));
      expect(sink.req).toBeUndefined();
      expect(contentOf(out.messages?.slice(-1)[0])).toContain("run_shell");
    }
  });
});

describe("run_shell output_artifact schema (D505)", () => {
  const reference = "opaque-reference-that-is-long-enough";

  test("accepts bounded literal search and preserves its explicit operation", () => {
    const parsed = createRunShellTool().schema.safeParse({
      output_artifact: {
        reference,
        operation: "search",
        query: "failing test name",
        max_matches: 20,
        context_bytes: 1024,
      },
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) {
      expect(parsed.data.output_artifact).toEqual({
        reference,
        operation: "search",
        query: "failing test name",
        max_matches: 20,
        context_bytes: 1024,
      });
    }
  });

  test("keeps legacy page retrieval valid while rejecting mixed or unbounded search fields", () => {
    const schema = createRunShellTool().schema;
    expect(schema.safeParse({
      output_artifact: { reference, offset_bytes: 16_384, max_bytes: 16_384 },
    }).success).toBeTrue();

    for (const output_artifact of [
      { reference, operation: "search", query: "needle", offset_bytes: 0 },
      { reference, operation: "search", query: "needle", delete_after_read: true },
      { reference, operation: "search", query: "", max_matches: 1 },
      { reference, operation: "search", query: "needle", max_matches: 21 },
      { reference, operation: "search", query: "needle", context_bytes: 1025 },
      { reference, operation: "search", query: "é".repeat(513) },
      { reference, operation: "search", query: "needle", unexpected: true },
    ]) {
      expect(schema.safeParse({ output_artifact }).success).toBeFalse();
    }
  });
});
