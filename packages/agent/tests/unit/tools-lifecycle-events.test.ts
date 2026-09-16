/**
 * Unit tests for tool.start / tool.end event emission from the custom
 * tools node (D057 2a.1.11 / chrome-bundle follow-up).
 *
 * Why these tests exist — the D082 observability debug session
 * revealed that the Nautilo custom tools node (which dispatches via
 * the relay) was NOT emitting `tool.start` / `tool.end` events, even
 * though LangGraph's built-in `on_tool_start` / `on_tool_end` stream
 * events flow through `processStreamEvent`. The relay path bypassed
 * that entirely, so the workbench Activity tab, cited-paths glyph,
 * and future ToolCard primitive had NO lifecycle to render.
 *
 * The fix: explicit `eventBus.emit(toolTracker.toolStart/End(...))`
 * calls in tools.ts wrapping every dispatch.
 *
 * These tests guard that fix:
 *   - Every successful dispatch emits `tool.start` then `tool.end`
 *     with status "success"
 *   - Failing dispatches emit `tool.start` then `tool.end` with
 *     status "error" and an error message
 *   - The tool call ID is consistent across the start/end pair so
 *     the client can correlate
 *   - Pre-execution security blocks emit a synthetic start+end pair
 *     so the UI records the attempt
 *
 * If a future refactor silently drops these emits — e.g. a rewrite
 * that forgets to port them — the tests fail immediately.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ServerEvent } from "@nautilo/types";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import {
  createToolsNode,
  LiveShadowToolProtectionRequiredError,
  LiveShadowToolProtectionTerminalError,
  toolsNode,
  setRelayRegistry,
  type ToolRelayRegistry,
} from "../../src/nodes/tools";
import { AgentToolCallTracker, setAgentEventSink } from "../../src/runtime-hooks";
import type { NautiloState } from "../../src/agent/state";
import { MAX_SUBAGENT_DEPTH } from "../../src/agent/state";

// ---------------------------------------------------------------------------
// Fixtures (kept self-contained — unlike tools-relay-scan-parity.test.ts
// we're only asserting on event emission, not scan semantics.)
// ---------------------------------------------------------------------------

type RelayResult = {
  status: "ok" | "error";
  result?: unknown;
  error?: string;
  durationMs?: number;
};

function makeMockRelayRegistry(
  onDispatch: () => Promise<RelayResult>,
): ToolRelayRegistry {
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
    dispatch: () => onDispatch(),
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

function makeState(
  toolName: string,
  args: Record<string, unknown>,
  toolCallId = `tc-${toolName}-1`,
): NautiloState {
  return {
    messages: [
      new AIMessage({
        content: "",
        tool_calls: [{ id: toolCallId, name: toolName, args }],
      }),
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
    approvedToolCalls: [{ id: toolCallId, name: toolName, args, type: "tool_call" }],
    requiredHostRelays: { [toolCallId]: "mock-relay-1" },
    pendingApproval: [],
    memoryAccessEnvelope: null,
    // M042D — actorRole is now a group-role slug, not a bucket. "owner"
    // is still the owner-path slug in the new ownership-group model.
    // ownerActorId was removed from the state annotation (PIN-subject
    // actor now sourced via NAUTILO_OWNER_ACTOR_ID env at invocation).
    actorRole: "owner",
    agentId: "",
    // M042B — room abstraction state. Unused by the tool lifecycle
    // event path, but required for the NautiloState shape to satisfy
    // the graph's state annotation after rooms merged.
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
    activatedToolNames: [toolName],
    relayCapabilities: {
      use_high_impact_tools: true,
    },
    verifiedOrdinaryOrigin: {
      kind: "local_electron",
      userId: "test-owner",
      actorId: "actor-test-owner",
      relayId: "mock-relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "pairing-generation-1",
      requestId: "request-1",
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

function buildTestCatalog(): ToolCatalog {
  const catalog = new ToolCatalog();

  catalog.register({
    name: "run_shell",
    factory: () =>
      new DynamicStructuredTool({
        name: "run_shell",
        description: "stub",
        schema: z.object({ command: z.string() }),
        func: () => Promise.reject(new Error("relay tool — should not invoke locally")),
      }),
    category: "development",
    trustTier: "admin",
    executor: "relay",
    impact: "destructive",
    requiredCapabilities: ["use_high_impact_tools"],
    tags: [],
    resultScanPolicy: "never",
  });
  catalog.register({
    name: "search_memory",
    factory: () => new DynamicStructuredTool({
      name: "search_memory",
      description: "protected search stub",
      schema: z.object({ query: z.string() }),
      func: () => Promise.reject(new Error("ordinary search must not run")),
    }),
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    fullEncryptionSupport: "supported",
    requiredCapabilities: [],
    tags: [],
    resultScanPolicy: "never",
  });
  catalog.register({
    name: "recall_records",
    factory: () => new DynamicStructuredTool({
      name: "recall_records",
      description: "protected recall stub",
      schema: z.object({ query: z.string() }),
      func: () => Promise.reject(new Error("ordinary recall must not run")),
    }),
    category: "knowledge",
    trustTier: "standard",
    impact: "read-only",
    exposure: "core",
    fullEncryptionSupport: "supported",
    requiredCapabilities: [],
    tags: [],
    resultScanPolicy: "never",
  });

  return catalog;
}

// ---------------------------------------------------------------------------
// Capture helper — collect every event the tools node emits during one
// invocation through the injected agent event sink.
// ---------------------------------------------------------------------------

function captureEvents(): {
  start: () => void;
  stop: () => ServerEvent[];
} {
  const captured: ServerEvent[] = [];
  const handler = (event: ServerEvent) => {
    captured.push(event);
  };
  return {
    start: () => setAgentEventSink({ emit: handler }),
    stop: () => {
      setAgentEventSink(null);
      return captured;
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  initToolCatalog(buildTestCatalog());
});

beforeEach(() => {
  // Default security level is "standard". Previously this set
  // NAUTILO_SECURITY_LEVEL explicitly — env var deleted in D060
  // Sprint 1 (security ship plan v3, G5.6).
});

afterEach(() => {
  setRelayRegistry(null);
  setAgentEventSink(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tools node — lifecycle event emission (D082 follow-up)", () => {
  test("successful relay dispatch emits tool.start then tool.end(success)", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "ok output" }),
    );
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(makeState("run_shell", { command: "echo hi" }));
    const events = capture.stop();

    // Filter to tool.* events — other infrastructure (tts, memory,
    // etc.) may emit during the test; we only care about lifecycle.
    const toolEvents = events.filter(
      (e) => e.type === "tool.start" || e.type === "tool.end",
    );
    expect(toolEvents.length).toBe(2);
    const [startEv, endEv] = toolEvents;
    expect(startEv?.type).toBe("tool.start");
    expect(endEv?.type).toBe("tool.end");
    if (startEv?.type === "tool.start") {
      expect(startEv.toolName).toBe("run_shell");
      expect(startEv.toolCallId).toBe("tc-run_shell-1");
    }
    if (endEv?.type === "tool.end") {
      expect(endEv.toolName).toBe("run_shell");
      expect(endEv.toolCallId).toBe("tc-run_shell-1");
      expect(endEv.status).toBe("success");
      expect(endEv.duration).toBeGreaterThanOrEqual(0);
    }
  });

  test("relay-returned error emits tool.start then tool.end(error)", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "error", error: "disk full" }),
    );
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(makeState("run_shell", { command: "echo hi" }));
    const events = capture.stop();

    const toolEvents = events.filter(
      (e) => e.type === "tool.start" || e.type === "tool.end",
    );
    expect(toolEvents.length).toBe(2);
    const [startEv, endEv] = toolEvents;
    expect(startEv?.type).toBe("tool.start");
    expect(endEv?.type).toBe("tool.end");
    if (endEv?.type === "tool.end") {
      expect(endEv.status).toBe("error");
      // Error text should surface the underlying cause so the UI can
      // display "why" without opening a log.
      expect(endEv.error ?? "").toContain("disk full");
    }
  });

  test("dispatch throw emits tool.start then tool.end(error) — exception path", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.reject(new Error("relay crashed")),
    );
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(makeState("run_shell", { command: "echo hi" }));
    const events = capture.stop();

    const toolEvents = events.filter(
      (e) => e.type === "tool.start" || e.type === "tool.end",
    );
    expect(toolEvents.length).toBe(2);
    const [startEv, endEv] = toolEvents;
    expect(startEv?.type).toBe("tool.start");
    expect(endEv?.type).toBe("tool.end");
    if (endEv?.type === "tool.end") {
      expect(endEv.status).toBe("error");
    }
  });

  test("a dispatched run_shell with the stable unknown discriminant emits outcome_unknown", async () => {
    const uncertain = Object.assign(
      new Error("run_shell outcome unknown after relay dispatch (disconnect)"),
      { runShellOutcome: "unknown" as const },
    );
    const registry = makeMockRelayRegistry(() => Promise.reject(uncertain));
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(makeState("run_shell", { command: "echo hi" }));
    const events = capture.stop();
    const end = events.find((event) => event.type === "tool.end");
    expect(end?.type).toBe("tool.end");
    if (end?.type === "tool.end") expect(end.runShellOutcome).toBe("unknown");
  });

  test("outcome_unknown cannot be attached to another tool lifecycle", () => {
    const tracker = new AgentToolCallTracker();
    tracker.toolStart("shell", "run_shell");
    tracker.toolStart("file", "read_file");
    expect(
      tracker.toolEnd("shell", "run_shell", "error", "lost", undefined, "unknown").runShellOutcome,
    ).toBe("unknown");
    expect(
      tracker.toolEnd("file", "read_file", "error", "lost", undefined, "unknown").runShellOutcome,
    ).toBeUndefined();
  });

  test("connected website start events keep a valid account control projection", () => {
    const tracker = new AgentToolCallTracker();
    const start = tracker.toolStart("connected-1", "read_connected_web_account", {
      account: "console.nebius.com",
      request: "Read a deliberately long private-site request. ".repeat(20),
      delivery: "text",
    });

    expect(JSON.parse(start.argsSummary!)).toEqual({
      account: "console.nebius.com",
      delivery: "text",
    });
    expect(start.argsSummary).not.toContain("deliberately long");
  });

  test("long run_shell start events retain a valid adaptive command projection", () => {
    const tracker = new AgentToolCallTracker();
    const command = `git restore --source=HEAD -- ${Array.from(
      { length: 20 },
      (_, index) => `templates/path-${index}/.env.example`,
    ).join(" ")}`;
    const start = tracker.toolStart("shell-long", "run_shell", {
      command,
      timeout_seconds: 60,
    });

    const parsed = JSON.parse(start.argsSummary!) as { command?: unknown };
    expect(typeof parsed.command).toBe("string");
    expect(parsed.command).toStartWith("git restore --source=HEAD -- ");
    expect(parsed.command).toBe(command);
  });

  test("very large run_shell commands remain valid JSON and visibly ellipsize the display value", () => {
    const tracker = new AgentToolCallTracker();
    const start = tracker.toolStart("shell-huge", "run_shell", {
      command: `printf status ${"x".repeat(8_000)}`,
    });

    const parsed = JSON.parse(start.argsSummary!) as { command?: unknown };
    expect(typeof parsed.command).toBe("string");
    expect(parsed.command).toStartWith("printf status ");
    expect(parsed.command).toEndWith("…");
  });

  test("rejects retired raw Computer Use results before live tool.end publication", () => {
    const tracker = new AgentToolCallTracker();
    tracker.toolStart("computer-1", "computer_do");
    const raw = JSON.stringify({
      ok: false,
      code: "desktop_external_interference",
      error: "private HID diagnostic",
      outcome: {
        version: 1,
        phase: "post_effect_verification",
        retrySafety: "never",
        stateChangeCertainty: "unknown",
        providerCondition: "unknown",
        targetCondition: "unknown",
        externalInterference: "user_input",
        recovery: ["observe_again", "do_not_replay"],
      },
    });

    const event = tracker.toolEnd("computer-1", "computer_do", "error", undefined, raw);
    expect(event.result).toContain("Computer Use result was not recognized");
    expect(event.result).not.toContain("desktop_external_interference");
    expect(event.result).not.toContain("user_input");
    expect(event.result).not.toContain("private HID diagnostic");
  });

  test("tool.start and tool.end carry the same toolCallId so the UI can correlate", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "out" }),
    );
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(
      makeState("run_shell", { command: "ls" }, "tc-correlation-test-42"),
    );
    const events = capture.stop();

    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    if (start?.type === "tool.start" && end?.type === "tool.end") {
      expect(start.toolCallId).toBe("tc-correlation-test-42");
      expect(end.toolCallId).toBe("tc-correlation-test-42");
    }
  });

  test("tool.start / tool.end carry authorAgentId when the turn has an agentId (M155 follow-up)", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "out" }),
    );
    setRelayRegistry(registry);

    const state = makeState("run_shell", { command: "echo hi" });
    state.agentId = "agent-genie-006";

    const capture = captureEvents();
    capture.start();
    await toolsNode(state);
    const events = capture.stop();

    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    if (start?.type === "tool.start") expect(start.authorAgentId).toBe("agent-genie-006");
    if (end?.type === "tool.end") expect(end.authorAgentId).toBe("agent-genie-006");
  });

  test("tool.start / tool.end carry turnId when the turn has one (M178)", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "out" }),
    );
    setRelayRegistry(registry);

    const state = makeState("run_shell", { command: "echo hi" });
    state.turnId = "turn-m178-tools";

    const capture = captureEvents();
    capture.start();
    await toolsNode(state);
    const events = capture.stop();

    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    if (start?.type === "tool.start") expect(start.turnId).toBe("turn-m178-tools");
    if (end?.type === "tool.end") expect(end.turnId).toBe("turn-m178-tools");
  });

  test("tool events omit authorAgentId when the turn has no agentId", async () => {
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "out" }),
    );
    setRelayRegistry(registry);

    const capture = captureEvents();
    capture.start();
    await toolsNode(makeState("run_shell", { command: "echo hi" }));
    const events = capture.stop();

    const start = events.find((e) => e.type === "tool.start");
    if (start?.type === "tool.start") expect(start.authorAgentId).toBeUndefined();
  });

  test("sequencing — tool.start emits BEFORE the relay dispatch begins", async () => {
    const timeline: string[] = [];
    const registry = makeMockRelayRegistry(() => {
      timeline.push("dispatch-started");
      return Promise.resolve({ status: "ok", result: "out" });
    });
    setRelayRegistry(registry);

    const capture = captureEvents();
    const handler = (event: ServerEvent) => {
      if (event.type === "tool.start") timeline.push("tool.start-emitted");
      if (event.type === "tool.end") timeline.push("tool.end-emitted");
    };
    setAgentEventSink({ emit: handler });

    try {
      await toolsNode(makeState("run_shell", { command: "echo" }));
    } finally {
      setAgentEventSink(null);
      capture.stop();
    }

    // Order must be: start → dispatch → end. If start fires after
    // dispatch completes the UI can't show a "running" state.
    expect(timeline).toEqual([
      "tool.start-emitted",
      "dispatch-started",
      "tool.end-emitted",
    ]);
  });

  test("checkpoints one completed call and retains the later call's exact relay", async () => {
    const timeline: string[] = [];
    setRelayRegistry(makeMockRelayRegistry(async () => {
      timeline.push("first-dispatch");
      return { status: "ok", result: "first output" };
    }));
    const state = makeState("run_shell", { command: "echo first" }, "tc-first");
    const laterCall = {
      id: "tc-later",
      name: "run_shell",
      args: { command: "echo later" },
      type: "tool_call" as const,
    };
    state.approvedToolCalls = [
      { id: "tc-first", name: "run_shell", args: { command: "echo first" }, type: "tool_call" },
      laterCall,
    ];
    state.requiredHostRelays = {
      "tc-first": "mock-relay-1",
      "tc-later": "mock-relay-later",
    };

    const output = await toolsNode(state);

    expect(timeline).toEqual(["first-dispatch"]);
    expect(output.approvedToolCalls).toEqual([laterCall]);
    expect(output.requiredHostRelays).toEqual({ "tc-later": "mock-relay-later" });
    const completed = output.messages?.at(-1);
    expect(completed?.getType()).toBe("tool");
    expect((completed as { tool_call_id?: string }).tool_call_id).toBe("tc-first");
  });

  test("protects and checkpoints three ordered tool calls exactly once each", async () => {
    let dispatchCount = 0;
    let callProtections = 0;
    let resultProtections = 0;
    setRelayRegistry(makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: `result-${dispatchCount}` };
    }));
    const calls = [1, 2, 3].map((index) => ({
      id: `tc-ordered-${index}`,
      name: "run_shell",
      args: { command: `echo ${index}` },
      type: "tool_call" as const,
    }));
    const node = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => {
          callProtections += 1;
          return message;
        },
        protectToolResult: async (message) => {
          resultProtections += 1;
          return message;
        },
      }),
    });
    let state = makeState("run_shell", calls[0]!.args, calls[0]!.id);
    state.messages = [new AIMessage({ content: "", tool_calls: calls })];
    state.approvedToolCalls = calls;
    state.requiredHostRelays = Object.fromEntries(
      calls.map((call) => [call.id, "mock-relay-1"]),
    );

    for (let index = 0; index < calls.length; index++) {
      const output = await node(state);
      state = { ...state, ...output } as NautiloState;
      expect(state.approvedToolCalls).toEqual(calls.slice(index + 1));
    }

    expect(dispatchCount).toBe(3);
    expect(callProtections).toBe(3);
    expect(resultProtections).toBe(3);
  });

  test("Full encryption rejects unsupported tools before telemetry or effects and protects the error", async () => {
    let dispatchCount = 0;
    let resultProtections = 0;
    setRelayRegistry(makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: "must not run" };
    }));
    const capture = captureEvents();
    capture.start();
    const node = createToolsNode({
      fullEncryptionOnlyForState: () => true,
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: async (message) => {
          resultProtections += 1;
          if (typeof message.content !== "string") {
            throw new TypeError("expected string Full rejection");
          }
          return new ToolMessage({
            content: `protected:${message.content}`,
            tool_call_id: message.tool_call_id,
            ...(message.name === undefined ? {} : { name: message.name }),
            additional_kwargs: { ...message.additional_kwargs },
          });
        },
      }),
    });

    const output = await node(makeState("run_shell", { command: "echo forbidden" }));
    const events = capture.stop();
    const result = output.messages?.at(-1) as ToolMessage;
    expect(dispatchCount).toBe(0);
    expect(events).toEqual([]);
    expect(resultProtections).toBe(1);
    expect(result.content).toBe(
      "protected:Error: This tool is unavailable while Full encryption is active.",
    );
    expect(result.additional_kwargs?.["nautilo_tool_status"]).toBe("error");
  });

  test("Full encryption rejects supported Memory search when its protected port is missing", async () => {
    let resultProtections = 0;
    const node = createToolsNode({
      fullEncryptionOnlyForState: () => true,
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: async (message) => {
          resultProtections += 1;
          return message;
        },
      }),
    });

    const output = await node(makeState("search_memory", { query: "secret" }));
    const result = output.messages?.at(-1) as ToolMessage;
    expect(resultProtections).toBe(1);
    expect(result.content).toBe(
      "Error: Protected tool access is unavailable while Full encryption is active.",
    );
    expect(result.additional_kwargs?.["nautilo_tool_status"]).toBe("error");
  });

  test("Full encryption rejects supported Record recall when its protected port is missing", async () => {
    let resultProtections = 0;
    const node = createToolsNode({
      fullEncryptionOnlyForState: () => true,
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: async (message) => {
          resultProtections += 1;
          return message;
        },
      }),
    });

    const output = await node(makeState("recall_records", { query: "decision" }));
    const result = output.messages?.at(-1) as ToolMessage;
    expect(resultProtections).toBe(1);
    expect(result.content).toBe(
      "Error: Protected tool access is unavailable while Full encryption is active.",
    );
    expect(result.additional_kwargs?.["nautilo_tool_status"]).toBe("error");
  });

  test("invokes exactly the self-opened tool call and merges its opened result", async () => {
    let dispatchCount = 0;
    const dispatchedArgs: Record<string, unknown>[] = [];
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "ordinary result" })
    );
    registry.dispatch = async (_relayId, request) => {
      dispatchCount += 1;
      dispatchedArgs.push(request.args);
      return { status: "ok", result: "ordinary result" };
    };
    setRelayRegistry(registry);
    const node = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async () => new AIMessage({
          content: "",
          tool_calls: [{
            id: "tc-run_shell-1",
            name: "run_shell",
            args: { command: "echo opened" },
          }],
        }),
        protectToolResult: async (ordinary) => new ToolMessage({
          content: "opened result",
          tool_call_id: ordinary.tool_call_id,
          ...(ordinary.name === undefined ? {} : { name: ordinary.name }),
          additional_kwargs: { ...ordinary.additional_kwargs },
        }),
      }),
    });

    const output = await node(makeState("run_shell", {
      command: "echo model",
    }));

    expect(dispatchCount).toBe(1);
    expect(dispatchedArgs).toEqual([{ command: "echo opened" }]);
    expect(output.messages?.at(-1)?.content).toBe("opened result");
  });

  test("uses one ordinary call and result when either protected gate throws", async () => {
    let dispatchCount = 0;
    const registry = makeMockRelayRegistry(() =>
      Promise.resolve({ status: "ok", result: "ordinary result" })
    );
    registry.dispatch = async () => {
      dispatchCount += 1;
      return { status: "ok", result: "ordinary result" };
    };
    setRelayRegistry(registry);
    const node = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: () =>
          Promise.reject(new Error("assistant protection unavailable")),
        protectToolResult: () =>
          Promise.reject(new Error("result protection unavailable")),
      }),
    });

    const output = await node(makeState("run_shell", {
      command: "echo ordinary",
    }));

    expect(dispatchCount).toBe(1);
    expect(output.messages?.at(-1)?.content).toBe("ordinary result");
  });

  test("terminal Shadow failure stops before a tool call even in fallback mode", async () => {
    let dispatchCount = 0;
    const registry = makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: "must not execute" };
    });
    setRelayRegistry(registry);
    const node = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: () => Promise.reject(
          new LiveShadowToolProtectionTerminalError(),
        ),
        protectToolResult: async (message) => message,
      }),
    });

    expect(node(makeState("run_shell", {
      command: "echo must-not-run",
    }))).rejects.toBeInstanceOf(LiveShadowToolProtectionTerminalError);
    expect(dispatchCount).toBe(0);
  });

  test("terminal Shadow failure after a tool call stops before graph continuation", async () => {
    let dispatchCount = 0;
    const registry = makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: "executed exactly once" };
    });
    setRelayRegistry(registry);
    const node = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: () => Promise.reject(
          new LiveShadowToolProtectionTerminalError(),
        ),
      }),
    });

    const state = makeState("run_shell", { command: "echo once" }, "tc-first");
    const laterCall = {
      id: "tc-must-not-run",
      name: "run_shell",
      args: { command: "echo must-not-run" },
      type: "tool_call" as const,
    };
    state.messages = [new AIMessage({
      content: "",
      tool_calls: [state.approvedToolCalls[0]!, laterCall],
    })];
    state.approvedToolCalls = [state.approvedToolCalls[0]!, laterCall];
    state.requiredHostRelays = {
      "tc-first": "mock-relay-1",
      "tc-must-not-run": "mock-relay-1",
    };

    expect(node(state)).rejects.toBeInstanceOf(
      LiveShadowToolProtectionTerminalError,
    );
    expect(dispatchCount).toBe(1);
  });

  test("passes deadline expiry through both protected tool gates without fallback", async () => {
    let dispatchCount = 0;
    const registry = makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: "executed exactly once" };
    });
    setRelayRegistry(registry);
    const deadlineExpired = () => new StrictShadowEnforcementError({
      boundaryId: "conversation.write.runtime_persist",
      family: "message",
      operation: "write",
      actorClass: "tool",
      state: "failed",
      reason: "deadline_expired",
      retryable: false,
      policyRevision: 8,
    });

    const beforeInvokeError = deadlineExpired();
    const blockedBeforeInvoke = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: () => Promise.reject(beforeInvokeError),
        protectToolResult: async (message) => message,
      }),
    });
    expect(blockedBeforeInvoke(makeState("run_shell", {
      command: "echo must-not-run",
    }))).rejects.toBe(beforeInvokeError);
    expect(dispatchCount).toBe(0);

    const afterInvokeError = deadlineExpired();
    const blockedAfterInvoke = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: () => Promise.reject(afterInvokeError),
      }),
    });
    expect(blockedAfterInvoke(makeState("run_shell", {
      command: "echo once",
    }))).rejects.toBe(afterInvokeError);
    expect(dispatchCount).toBe(1);
  });

  test("Strict Shadow stops before a tool call and never retries an executed side effect", async () => {
    let dispatchCount = 0;
    const registry = makeMockRelayRegistry(async () => {
      dispatchCount += 1;
      return { status: "ok", result: "ordinary result" };
    });
    setRelayRegistry(registry);

    const blockedBeforeInvoke = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: () => Promise.reject(
          new LiveShadowToolProtectionRequiredError(),
        ),
        protectToolResult: async (message) => message,
      }),
    });
    expect(blockedBeforeInvoke(makeState("run_shell", {
      command: "echo blocked",
    }))).rejects.toBeInstanceOf(LiveShadowToolProtectionRequiredError);
    expect(dispatchCount).toBe(0);

    const blockedAfterInvoke = createToolsNode({
      liveShadowToolBoundaryForState: () => ({
        protectAssistantToolCall: async (message) => message,
        protectToolResult: () => Promise.reject(
          new LiveShadowToolProtectionRequiredError(),
        ),
      }),
    });
    expect(blockedAfterInvoke(makeState("run_shell", {
      command: "echo once",
    }))).rejects.toBeInstanceOf(LiveShadowToolProtectionRequiredError);
    expect(dispatchCount).toBe(1);
  });
});
