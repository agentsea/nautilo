import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { z } from "zod";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { NautiloState } from "../../src/agent/state";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import {
  browserDecisionPlanSchema,
  interpretBrowserDecisionCall,
  settleBrowserDecision,
  type BrowserDecisionObservation,
  type BrowserDecisionState,
} from "../../src/graph/browser-decision";
import { createBrowserDecisionNode } from "../../src/nodes/browser-decision";
import { projectBrowserHistory } from "../../src/tools/browser/browser-history";
import { createControlConnectedWebOperationTool } from "../../src/tools/connected-web-accounts/control-connected-web-operation";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebOperationDirectToolRuntime,
} from "../../src/tools/connected-web-accounts/runtime";

const JEV_ID = "openrouter:typesafe/jev-1.13";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";

const plan = browserDecisionPlanSchema.parse({
  goal: "Open the exact result",
  allowedOrigins: ["https://shop.example"],
  actions: [{ kind: "click_observed" }],
});

function observation(id: string, snapshot = `page ${id}`): BrowserDecisionObservation {
  return {
    version: 1,
    snapshot,
    refs: { e1: { role: "button", name: "Open details" } },
    pageUrl: "https://shop.example/results",
    browserSessionId: "connected-session",
    observationId: id,
  };
}

function connectedContent(value: BrowserDecisionObservation): string {
  return JSON.stringify({ ok: true, observation: value });
}

function call(id: string, args: Record<string, unknown>): ToolCall & { id: string } {
  return { id, name: "control_connected_web_operation", args, type: "tool_call" };
}

function result(toolCall: ToolCall & { id: string }, content: string, failure?: string): ToolMessage {
  return new ToolMessage({
    name: toolCall.name,
    tool_call_id: toolCall.id,
    content,
    additional_kwargs: {
      nautilo_tool_status: failure ? "error" : "success",
      ...(failure ? { nautilo_browser_failure: failure } : {}),
    },
  });
}

function state(overrides: Partial<NautiloState> = {}): NautiloState {
  return {
    turnId: "turn-connected",
    userId: "user-test",
    messages: [],
    browserDecision: null,
    noProgressPendingCorrection: null,
    noProgressPendingStop: null,
    approvalDenied: false,
    approvedToolCalls: [],
    ...overrides,
  } as unknown as NautiloState;
}

function activeDecision(overrides: Partial<BrowserDecisionState> = {}): BrowserDecisionState {
  return {
    turnId: "turn-connected",
    modelId: JEV_ID,
    target: { kind: "connected_web", operationId: OPERATION_ID, controlEpoch: 7 },
    plan,
    phase: "decide",
    observation: observation("observation-1"),
    pending: null,
    reason: null,
    recovery: {
      interventionLimit: 2,
      consecutiveEvents: 0,
      interventionAt: 2,
      progressSeen: [],
      assessNextObservation: false,
    },
    ...overrides,
  };
}

describe("connected browser decisions", () => {
  let priorKey: string | undefined;

  beforeEach(() => {
    priorKey = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "synthetic-connected-decision-test";
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
  });

  afterEach(() => {
    resetConnectedWebAccountReadToolRuntimeForTests();
    resetRuntimeModelCatalog();
    if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = priorKey;
  });

  test("the dynamic tool carries trusted observe and act authority through one connected episode", async () => {
    const controller = new AbortController();
    const controls: Array<{ actor: unknown; input: unknown; options: unknown }> = [];
    const nextObservation = observation("initial", "unique snapshot payload");
    setConnectedWebOperationDirectToolRuntime({
      control: async (actor, input, options) => {
        controls.push({ actor, input, options: options ?? {} });
        const isSnapshot = input.command.kind === "snapshot";
        return {
          ok: true as const,
          command: { text: isSnapshot ? nextObservation.snapshot : "clicked", truncated: false },
          ...(isSnapshot ? { observation: nextObservation } : {}),
          operation: {
            operationId: input.operationId,
            driver: "direct" as const,
            lifecycle: "running" as const,
            controlEpoch: input.expectedControlEpoch,
            activity: { phase: "working", code: "direct_browser_control", summary: "Connected website control is active." },
            receipt: null,
            result: null,
          },
        };
      },
    });
    const memoryAccessEnvelope: MemoryAccessEnvelope = {
      ownerId: OWNER_ID,
      actorId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      readableNamespaces: [], mutableNamespaces: [], writableNamespaces: [], toolPolicy: {},
    };
    const trusted = {
      userId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      callingRoomId: null,
      memoryAccessEnvelope,
      currentThreadId: "thread-connected",
      turnId: "turn-connected",
      laneKey: "lane-connected",
      fullEncryptionOnly: false,
      signal: controller.signal,
    };
    const initialCall = call("initial-tool", {
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      command: { kind: "snapshot" },
      decisionPlan: plan,
    });
    const initialTool = createControlConnectedWebOperationTool({ ...trusted, toolCallId: initialCall.id,
      browserDecisionSingleton: true, browserDecisionCall: initialCall });
    const schema = z.toJSONSchema(initialTool.schema);
    expect(schema.type).toBe("object");
    const initialContent = await initialTool.invoke(initialCall.args);
    const initialText = typeof initialContent === "string" ? initialContent : String(initialContent);
    expect(initialText.match(/unique snapshot payload/g)).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      actor: { userId: OWNER_ID, agentId: AGENT_ID, roomId: ROOM_ID, toolCallId: "initial-tool" },
      input: { operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "snapshot" } },
      options: { signal: controller.signal, decision: { kind: "observe" } },
    });

    const initialState = state({ messages: [new AIMessage({ content: "", tool_calls: [initialCall] })] });
    const settled = settleBrowserDecision(initialState, [initialCall], [result(initialCall, initialText)], [], JEV_ID);
    if (!settled) throw new Error("expected connected decision episode");
    const node = createBrowserDecisionNode({
      fullEncryptionOnlyForState: () => false,
      choose: async () => ({ selectedId: "action_0", requestedModelId: JEV_ID, resolvedModelId: JEV_ID,
        usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null }, choiceCalls: 1, screeningRounds: 0 }),
    });
    const proposed = await node(state({ browserDecision: settled, messages: initialState.messages }), { signal: controller.signal });
    const pendingCall = (proposed.messages?.at(-1) as AIMessage).tool_calls?.[0];
    if (!pendingCall?.id) throw new Error("expected connected action proposal");
    const waiting = proposed.browserDecision;
    if (!waiting) throw new Error("expected waiting decision episode");
    const pendingTool = createControlConnectedWebOperationTool({ ...trusted, toolCallId: pendingCall.id,
      browserDecision: waiting, browserDecisionCall: pendingCall, browserDecisionSingleton: true });
    await pendingTool.invoke(pendingCall.args);

    expect(controls[1]).toMatchObject({
      input: { operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "click", ref: "@e1" } },
      options: { signal: controller.signal, decision: { kind: "act", observationId: "initial" } },
    });
    expect(controls).toHaveLength(2);

    delete process.env["OPENROUTER_API_KEY"];
    const revoked = createControlConnectedWebOperationTool({ ...trusted, toolCallId: pendingCall.id,
      browserDecision: waiting, browserDecisionCall: pendingCall, browserDecisionSingleton: true });
    const revokedResult = await revoked.invoke(pendingCall.args);
    expect(JSON.parse(String(revokedResult))).toMatchObject({ ok: false, code: "conflict", browserFailure: "browser_authority_lost" });
    expect(controls).toHaveLength(2);

    process.env["OPENROUTER_API_KEY"] = "synthetic-connected-decision-test";
    const failures = ["browser_observation_stale", "browser_outcome_unknown"] as const;
    let failureCalls = 0;
    setConnectedWebOperationDirectToolRuntime({
      control: async () => ({ ok: false, code: "conflict", recovery: "none",
        browserFailure: failures[failureCalls++]!, detail: "Exact synthetic failure." }),
    });
    for (const [index, browserFailure] of failures.entries()) {
      const effect = call(`failed-effect-${index}`, {
        operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "click", ref: "@e1" },
      });
      const episode = activeDecision({ phase: "waiting", pending: {
        call: effect, browserSessionId: "connected-session", observationId: "initial",
      } });
      const failureTool = createControlConnectedWebOperationTool({ ...trusted, toolCallId: effect.id,
        browserDecision: episode, browserDecisionCall: effect, browserDecisionSingleton: true });
      expect(JSON.parse(String(await failureTool.invoke(effect.args)))).toMatchObject({
        ok: false, browserFailure,
      });
    }
    expect(failureCalls).toBe(2);

  });

  test("a connected snapshot starts an episode bound to the exact operation authority", () => {
    const snapshot = call("connected-plan", {
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      command: { kind: "snapshot" },
      decisionPlan: plan,
    });
    const initial = state({ messages: [new AIMessage({ content: "", tool_calls: [snapshot] })] });

    const settled = settleBrowserDecision(initial, [snapshot], [result(snapshot, connectedContent(observation("initial")))], [], JEV_ID);

    expect(settled?.phase).toBe("decide");
    expect(settled?.target).toEqual({ kind: "connected_web", operationId: OPERATION_ID, controlEpoch: 7 });
    expect(settled?.observation?.observationId).toBe("initial");
  });

  test("the decision node maps a semantic action to the connected operation and preserves ordinary embedded routing", async () => {
    const choose = async () => ({
      selectedId: "action_0",
      requestedModelId: JEV_ID,
      resolvedModelId: JEV_ID,
      usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null },
      choiceCalls: 1,
      screeningRounds: 0,
    });
    const node = createBrowserDecisionNode({ fullEncryptionOnlyForState: () => false, choose });
    const signal = new AbortController().signal;

    const connected = await node(state({ browserDecision: activeDecision() }), { signal });
    const connectedCall = (connected.messages?.at(-1) as AIMessage).tool_calls?.[0];
    expect(connectedCall).toMatchObject({
      name: "control_connected_web_operation",
      args: {
        operationId: OPERATION_ID,
        expectedControlEpoch: 7,
        command: { kind: "click", ref: "@e1" },
      },
    });

    const { target: _target, ...embeddedDecision } = activeDecision();
    const embedded = await node(state({ browserDecision: embeddedDecision }), { signal });
    expect((embedded.messages?.at(-1) as AIMessage).tool_calls?.[0]).toMatchObject({
      name: "browser_click",
      args: { ref: "@e1" },
    });
  });

  test("connected actions return to observation and stale observations reobserve without replay", () => {
    const action = call("connected-action", {
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      command: { kind: "click", ref: "@e1" },
    });
    const waiting = activeDecision({
      phase: "waiting",
      pending: { call: action, browserSessionId: "connected-session", observationId: "observation-1" },
    });

    const acted = settleBrowserDecision(state({ browserDecision: waiting }), [action], [result(action, JSON.stringify({ ok: true }))], [], JEV_ID);
    expect(acted?.phase).toBe("observe");
    expect(acted?.pending).toBeNull();

    const stale = settleBrowserDecision(state({ browserDecision: waiting }), [action], [result(action, "", "browser_observation_stale")], [], JEV_ID);
    expect(stale?.phase).toBe("observe");
    expect(stale?.recovery?.consecutiveEvents).toBe(1);

    const unknown = settleBrowserDecision(state({ browserDecision: waiting }), [action], [result(action, "", "browser_outcome_unknown")], [], JEV_ID);
    expect(unknown?.phase).toBe("handoff");
    expect(unknown?.reason).toBe("browser_outcome_unknown");
    expect(unknown?.pending).toBeNull();
  });

  test("missing credentials or protected policy hides decisionPlan while preserving ordinary commands", () => {
    const context = { turnId: "turn-connected", fullEncryptionOnly: false };
    const enabled = createControlConnectedWebOperationTool(context);
    expect(JSON.stringify(z.toJSONSchema(enabled.schema))).toContain('"decisionPlan"');
    expect(enabled.schema.safeParse({ operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "click", ref: "@e1" } }).success).toBe(true);

    delete process.env["OPENROUTER_API_KEY"];
    const noKey = createControlConnectedWebOperationTool(context);
    expect(JSON.stringify(z.toJSONSchema(noKey.schema))).not.toContain('"decisionPlan"');
    expect(noKey.schema.safeParse({ operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "click", ref: "@e1" } }).success).toBe(true);

    process.env["OPENROUTER_API_KEY"] = "synthetic-connected-decision-test";
    const disabled = createControlConnectedWebOperationTool({ ...context, fullEncryptionOnly: true });
    expect(JSON.stringify(z.toJSONSchema(disabled.schema))).not.toContain('"decisionPlan"');
  });

  test("malformed connected plans are rejected as repairable before an effect call exists", () => {
    const malformed = call("bad-plan", {
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      command: { kind: "snapshot" },
      decisionPlan: { goal: "", actions: [] },
    });
    const interpreted = interpretBrowserDecisionCall(malformed);

    expect(interpreted.kind).toBe("invalid");
    if (interpreted.kind !== "invalid") throw new Error("expected invalid plan");
    expect(interpreted.code).toBe("invalid_browser_decision_plan");
    expect(interpreted.instruction).toContain("No browser request was sent");
  });

  test("history projection compacts only old successful observations and retains canonical and error bytes", () => {
    const calls = ["old", "baseline", "current"].map((id) => call(id, {
      operationId: OPERATION_ID,
      expectedControlEpoch: 7,
      command: { kind: "snapshot" },
    }));
    const oldBytes = connectedContent(observation("old", "old full snapshot"));
    const baselineBytes = connectedContent(observation("baseline", "baseline full snapshot"));
    const currentBytes = connectedContent(observation("current", "current full snapshot"));
    const errorBytes = JSON.stringify({ ok: false, code: "conflict", detail: "exact diagnostic" });
    const errorCall = call("error", { operationId: OPERATION_ID, expectedControlEpoch: 7, command: { kind: "click", ref: "@e1" } });
    const messages = [
      new AIMessage({ content: "", tool_calls: [calls[0]!] }), result(calls[0]!, oldBytes),
      new AIMessage({ content: "", tool_calls: [calls[1]!] }), result(calls[1]!, baselineBytes),
      new AIMessage({ content: "", tool_calls: [errorCall] }), result(errorCall, errorBytes, "browser_authority_lost"),
      new AIMessage({ content: "", tool_calls: [calls[2]!] }), result(calls[2]!, currentBytes),
    ];

    const projected = projectBrowserHistory(messages);
    expect((projected.messages[1] as ToolMessage).content).not.toBe(oldBytes);
    expect((projected.messages[3] as ToolMessage).content).toBe(baselineBytes);
    expect((projected.messages[5] as ToolMessage).content).toBe(errorBytes);
    expect((projected.messages[7] as ToolMessage).content).toBe(currentBytes);
    expect(projected.originals.get("old")?.content).toBe(oldBytes);
  });
});
