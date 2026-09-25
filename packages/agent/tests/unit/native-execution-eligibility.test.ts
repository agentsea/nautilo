import { afterEach, beforeEach, expect, test } from "bun:test";
import { invokeNativeExecution } from "../../src/providers/native-execution";
import { settleNativeDecision } from "../../src/graph/native-decision";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import { computerResultDurableSidecar, projectSemanticComputerResult } from "../../src/tools/computer/model-result-projector";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";
import { nativeExecutionNode } from "../../src/nodes/native-execution";
import { resolveNativeDecisionModel } from "../../src/config/native-decision-model";
import { nativeDecisionPlanSchema } from "../../src/graph/native-decision-plan";
import type { NativeDecisionState } from "../../src/graph/native-decision";
import type { NautiloState } from "../../src/agent/state";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const decisionModelId = "openrouter:typesafe/jev-1.13";
let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "synthetic-native-eligibility";
});
afterEach(() => {
  if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = previousKey;
});
const signal = new AbortController().signal;
const chosen = (request: ChoiceInput, selectedId: string): ChoiceResult => ({
  selectedId, requestedModelId: request.modelId, resolvedModelId: request.modelId,
  usage: { inputTokens: 7, outputTokens: 1, actualCostUsd: 0.01 },
});
const read = { name: "computer_observe", description: "Read the current desktop", effectClass: "read",
  schema: { type: "object", properties: { operation: { const: "desktop_state" } }, required: ["operation"], additionalProperties: false } };

test("checked workflow delegation enters with Choice when a retained Middle pin is unavailable", () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
  const call = { id: "entry", name: "computer_observe", args: { operation: "window_state", target,
    decisionPlan: { execution: "workflow", goal: "Inspect the draft", actions: [] } } };
  const payload = { version: 1, operation: "window_state", target,
    evidence: { kind: "window", appLabel: "Editor", windowLabel: "Draft" }, completeness: "partial", degraded: false,
    verification: "indeterminate", controlCollection: { completeness: "partial", received: 0, omitted: 0, controls: [] },
    outcome: { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable",
      providerCondition: "ready", targetCondition: "current", recovery: [] } };
  const raw = JSON.stringify({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: call.id,
    fence: { hostGeneration: "host", driverGeneration: "driver", cancellationGeneration: 1 },
    contract: COMPUTER_USE_NATIVE_CONTRACTS.observe, settlement: "completed", result: payload });
  const result = new ToolMessage({ name: call.name, tool_call_id: call.id, content: projectSemanticComputerResult(call.name, raw),
    additional_kwargs: computerResultDurableSidecar(call.name, raw) });
  const old: NativeDecisionState = { turnId: "turn-fixture", modelId: decisionModelId,
    plan: nativeDecisionPlanSchema.parse({ execution: "workflow", goal: "Inspect the draft", actions: [] }),
    observeArgs: {}, observation: null, phase: "handoff", pending: null, reason: "prior_interpreter_unavailable", generation: 0,
    controller: { modelId: "not-an-admitted-interpreter", attemptedGeneration: 0, active: false },
    history: [], unresolved: [], recovery: { limit: 3, events: 0, transitions: [], before: null } };
  const state = { turnId: "turn-fixture", toolNames: ["computer_observe", "computer_do"], nativeDecision: old,
    messages: [new HumanMessage("Inspect the draft"), new AIMessage({ content: "", tool_calls: [call] })] } as unknown as NautiloState;
  const entered = settleNativeDecision(state, [call], [result], [], decisionModelId);
  expect(entered?.execution?.freshRead).toBe(true);
  expect(entered?.phase).toBe("interpret");
  expect(entered?.controller).toBeUndefined();
  expect(entered?.execution?.observation).toMatchObject({ operation: "window_state", target });

  const noChoice = settleNativeDecision({ ...state, nativeDecision: null }, [call], [result], [], "");
  expect(noChoice).toBeNull();
  const windowOnly = settleNativeDecision({ ...state, nativeDecision: null }, [{ ...call,
    args: { ...call.args, decisionPlan: { goal: "Inspect the draft", actions: [] } } }], [result], [], decisionModelId);
  expect(windowOnly?.execution).toBeUndefined();
});

test("Choice withdrawal during a pending selection fences the next effect without erasing receipts", async () => {
  const current = { turnId: "turn-fixture", userId: "human-fixture", agentId: "genie-fixture", roomId: "room-fixture",
    messages: [new HumanMessage("Open Sketchpad")], toolNames: ["computer_observe", "computer_do"] } as unknown as NautiloState;
  const retainedReceipt = { action: "computer_do", settlement: "completed", evidence: { effect: "prior work" } };
  const decision: NativeDecisionState = { turnId: current.turnId, modelId: decisionModelId,
    plan: nativeDecisionPlanSchema.parse({ execution: "workflow", goal: "Open Sketchpad", actions: [] }),
    observeArgs: {}, observation: null, phase: "interpret", pending: null, reason: null, generation: 1,
    history: [retainedReceipt], unresolved: [], recovery: { limit: 3, events: 0, transitions: [], before: null },
    execution: { request: "Open Sketchpad", tools: current.toolNames, observation: { operation: "desktop_state" },
      observationCallId: "prior-read", freshRead: true, mustObserve: false, question: null },
  };
  let selected!: () => void;
  let release!: () => void;
  const selectedPromise = new Promise<void>(resolve => { selected = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const pending = nativeExecutionNode(current, decision, { fullEncryptionOnlyForState: () => false,
    interpretNative: async () => {
      selected();
      await releasePromise;
      return { decision: { kind: "complete" as const, summary: "Open", checks: [{ path: ["operation"],
        comparison: "equals" as const, expected: { $valueRef: { source: "request" as const, path: [] } } }] },
        modelId: decisionModelId, modelCalls: 1,
        usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } };
    },
  }, { signal: new AbortController().signal });
  await selectedPromise;
  delete process.env["OPENROUTER_API_KEY"];
  expect(resolveNativeDecisionModel({ turnId: current.turnId, fullEncryptionOnly: false }, decisionModelId)).toBeNull();
  release();
  const result = await pending;
  expect(result.nativeDecision?.reason).toBe("decision_model_unavailable");
  expect(result.nativeDecision?.pending).toBeNull();
  expect(result.nativeDecision?.history).toEqual([retainedReceipt]);
  expect(result.messages?.some(message => AIMessage.isInstance(message) && message.tool_calls?.length)).toBe(false);
});

test("code-owned readback dispatches without Middle or any model call", async () => {
  const current = { turnId: "turn-fixture", userId: "human-fixture", agentId: "genie-fixture", roomId: "room-fixture",
    messages: [new HumanMessage("Inspect the desktop")], toolNames: ["computer_observe", "computer_do"] } as unknown as NautiloState;
  const decision: NativeDecisionState = { turnId: current.turnId, modelId: decisionModelId,
    plan: nativeDecisionPlanSchema.parse({ execution: "workflow", goal: "Inspect the desktop", actions: [] }),
    observeArgs: {}, observation: null, phase: "interpret", pending: null, reason: null, generation: 0,
    history: [], unresolved: [], recovery: { limit: 3, events: 0, transitions: [], before: null },
    execution: { request: "Inspect the desktop", tools: current.toolNames, observation: null, observationCallId: null,
      freshRead: false, mustObserve: true, question: null,
      lastRead: { tool: "computer_observe", arguments: { operation: "desktop_state" } } },
  };
  const result = await nativeExecutionNode(current, decision, { fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { throw new Error("No model should run for readback"); } }, { signal });
  expect(result.nativeDecision?.pending).toMatchObject({ name: "computer_observe", args: { operation: "desktop_state" } });
  expect(result.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({ modelCalls: 0 });
  let inspected = false;
  await nativeExecutionNode(current, { ...decision, execution: { ...decision.execution!, mustObserve: false, freshRead: true,
    observation: { operation: "desktop_state", evidence: { kind: "screen" } } } }, {
    fullEncryptionOnlyForState: () => false,
    interpretNative: async input => {
      inspected = true;
      expect(input.state["currentRoute"]).toEqual({ lastReadOperation: "desktop_state",
        observedOperation: "desktop_state", observedEvidenceKind: "screen" });
      return { decision: { kind: "genie", reason: "reasoning", question: "Fixture inspected" }, modelId: decisionModelId,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } };
    },
  }, { signal });
  expect(inspected).toBe(true);
});

test("Choice can select a complete native action with no available Middle and no Flash attempt", async () => {
  let choiceCalls = 0;
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,synthetic" } };
  const result = await invokeNativeExecution({ modelId: "", decisionModelId, signal, capabilities: [read], images: [image],
    roots: { request: "Inspect the desktop", values: {}, observation: null }, state: { goal: "Inspect the desktop" },
  }, async () => { throw new Error("Flash must not initialize"); }, undefined, async request => {
    choiceCalls++;
    expect(JSON.stringify(request)).not.toContain("data:image");
    const direct = request.choices.find(row => row.id.startsWith("option_"));
    expect(direct).toBeDefined();
    return chosen(request, direct!.id);
  });
  expect(result.decision).toEqual({ kind: "call", tool: "computer_observe", arguments: { operation: "desktop_state" } });
  expect(choiceCalls).toBe(1);
  expect(result.modelUsage?.map(row => [row.modelId, row.modelCalls])).toEqual([[decisionModelId, 1]]);
  expect(result.modelUsage?.[0]?.attempts[0]).toMatchObject({ stage: "operation", route: "choice",
    imageBytes: 0, outcome: "returned" });
  expect(result.modelUsage?.[0]?.attempts[0]?.candidateCount).toBeGreaterThan(0);
  expect(result.modelUsage?.[0]?.attempts[0]?.textBytes).toBeGreaterThan(0);
});

test("unavailable visual interpretation returns a precise Genie handoff without manufacturing a native action", async () => {
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,synthetic" } };
  const result = await invokeNativeExecution({ modelId: "", decisionModelId, signal, capabilities: [read], images: [image],
    roots: { request: "Inspect the unfamiliar dialog", values: {}, observation: { label: "Dialog" } },
    state: { goal: "Inspect the unfamiliar dialog" },
  }, async () => { throw new Error("Flash must not initialize"); }, undefined, async request => {
    expect(request.choices.some(row => row.id === "interpret_with_middle")).toBe(true);
    return chosen(request, "interpret_with_middle");
  });
  expect(result.decision).toMatchObject({ kind: "genie", reason: "missing_capability" });
  if (result.decision.kind !== "genie") throw new Error("expected Genie handoff");
  expect(result.decision.question.toLowerCase()).toContain("interpreter");
  expect(result.modelCalls).toBe(1);
  expect(result.modelUsage?.[0]?.attempts[0]).toMatchObject({ route: "choice", outcome: "returned", imageBytes: 0 });
});

test("rejected Choice attempt remains measured and does not fall through to optional Middle", async () => {
  const progress: unknown[] = [];
  const rejected = invokeNativeExecution({ modelId: "", decisionModelId, signal, capabilities: [read],
    roots: { request: "Inspect", values: {}, observation: null }, state: {}, onProgress: row => progress.push(row),
  }, async () => { throw new Error("Flash must not initialize"); }, undefined, async () => {
    throw new Error("synthetic rejected Choice");
  });
  const failure = await rejected.then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("synthetic rejected Choice");
  expect(progress).toHaveLength(1);
  expect(progress[0]).toMatchObject({ modelCalls: 1, usage: { inputTokens: null }, modelUsage: [{
    modelId: decisionModelId, modelCalls: 1, attempts: [{ route: "choice", outcome: "failed", imageBytes: 0 }],
  }] });
});

test("cancelled Choice response retains its measured attempt without dispatch", async () => {
  const controller = new AbortController();
  const progress: unknown[] = [];
  const pending = invokeNativeExecution({ modelId: "", decisionModelId, signal: controller.signal, capabilities: [read],
    roots: { request: "Inspect", values: {}, observation: null }, state: {}, onProgress: row => progress.push(row),
  }, async () => { throw new Error("Flash must not initialize"); }, undefined, async request => {
    controller.abort();
    return chosen(request, request.choices.find(row => row.id.startsWith("option_"))!.id);
  });
  const failure = await pending.then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(progress).toMatchObject([{ modelCalls: 1, modelUsage: [{ modelId: decisionModelId, modelCalls: 1,
    attempts: [{ outcome: "cancelled", route: "choice" }] }] }]);
});
