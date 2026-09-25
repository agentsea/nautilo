import { afterEach, beforeEach, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { createNativeDecisionNode } from "../../src/nodes/native-decision";
import { nativeExecutionObservation } from "../../src/nodes/native-execution";
import { nativeDecisionDispatchError, settleNativeDecision } from "../../src/graph/native-decision";
import { bindNativeExecutionValue, mergeNativeDesktopPage, nativeExecutionCompletion, nativeExecutionCompletionChoice, nativeExecutionCompletionEvidence,
  nativeExecutionStringsBound, projectNativeExecutionObservation, settleNativeExecution, type NativeExecutionReply } from "../../src/graph/native-execution";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { computerUseHostToolDefinition } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { nativeDecisionHostArguments, nativeDecisionPlanSchema } from "../../src/graph/native-decision-plan";
import { shouldContinueAfterTools } from "../../src/agent/graph";
import { COMPUTER_USE_NATIVE_CONTRACTS } from "@nautilo/computer-use-contracts/native";
import { computerResultDurableSidecar, projectSemanticComputerResult } from "../../src/tools/computer/model-result-projector";
import { invokeNativeExecution, type NativeExecutionInput } from "../../src/providers/native-execution";
import type { ChatModel } from "../../src/providers/types";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";

const selectedChoice = (input: ChoiceInput, selectedId: string): ChoiceResult => ({
  selectedId, requestedModelId: input.modelId, resolvedModelId: input.modelId,
  usage: { inputTokens: 7, outputTokens: 1, actualCostUsd: 0.01 },
});
// Existing interpreter fixtures explicitly exercise the Middle route. No live
// classifier transport or hidden provider call is permitted in unit tests.
const invokeThroughMiddle = (input: NativeExecutionInput, create: Parameters<typeof invokeNativeExecution>[1]) =>
  invokeNativeExecution(input, create, undefined, async request => selectedChoice(request, "interpret_with_middle"));

function recoveryWindow(revision: number, value = "unchanged") {
  return { version: 1, operation: "window_state", target, evidence: { kind: "window", appLabel: "Editor", windowLabel: "Draft" },
    completeness: "partial", degraded: false, verification: "indeterminate",
    controlCollection: { completeness: "partial", received: 1, omitted: 0, controls: [{
      id: `c${revision}`, role: "button", label: "New", target: { ...element, reference: `detgt_${String(revision).padEnd(43, "x")}` },
      state: { completeness: "partial", value },
    }] },
    outcome: { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] },
  };
}

test("workflow recovery compares semantic progress across fresh IDs and chooses another operation route", async () => {
  let decision = (await entered()).nativeDecision!;
  const read = (revision: number, value?: string) => ({ requestId: `read-${revision}`, settlement: "completed", result: recoveryWindow(revision, value) });
  const observe = { id: "observe", name: "computer_observe", args: { operation: "window_state", target } };
  decision = settleNativeExecution(decision, observe, read(0));
  for (let revision = 1; revision <= decision.recovery.limit; revision++) {
    const control = recoveryWindow(revision - 1).controlCollection.controls[0]!;
    decision = settleNativeExecution(decision, { id: `click-${revision}`, name: "computer_do", args: { operation: { kind: "click", target: control.target } } }, {
      requestId: `result-${revision}`, settlement: "not_completed", result: { action: "click", completionCertainty: "not_completed",
        deliveryMode: "not_delivered", outcome: { phase: "pre_effect_dispatch", stateChangeCertainty: "not_changed", targetCondition: "stale" } },
    });
    expect(decision.history.at(-1)?.evidence).toMatchObject({ source: { control: { role: "button", label: "New" } } });
    decision = settleNativeExecution(decision, { ...observe, id: `read-${revision}` }, read(revision));
    expect(decision.recovery.events).toBe(revision);
    if (revision === 1) {
      let calls = 0;
      const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
        control: async () => { throw new Error("must not re-enter the refused control subset"); },
        interpretNative: async () => { calls++; return response({ kind: "genie", reason: "missing_capability", question: "Use another route" }); },
      })({ ...state(), nativeDecision: decision }, config);
      expect(calls).toBe(1);
      expect(next.nativeDecision?.pending).toBeNull();
    }
  }
  expect(decision.reason).toBe("native_decision_no_progress");
  expect(decision.phase).toBe("handoff");
  const progressed = settleNativeExecution(decision, observe, read(9, "new content"));
  expect(progressed.recovery.events).toBe(0);
  expect(progressed.phase).toBe("interpret");
});

test("alternating read surfaces and rotating contexts do not reset no-progress recovery", async () => {
  let decision = (await entered()).nativeDecision!;
  const read = (operation: string, revision: number, count = 0) => {
    decision = settleNativeExecution(decision, { id: `read-${revision}`, name: "computer_observe", args: { operation } }, {
      settlement: "completed", result: { operation, context: `context-${revision}`, candidates: Array.from({ length: count }, () => ({ label: "New document" })) },
    });
  };
  read("application_windows", 0);
  read("desktop_state", 1);
  expect(decision.recovery.events).toBe(0);
  for (let index = 0; index < decision.recovery.limit; index++) {
    read(index % 2 ? "desktop_state" : "application_windows", index + 2);
    expect(decision.recovery.events).toBe(index + 1);
  }
  expect(decision.reason).toBe("native_decision_no_progress");
  read("application_windows", 10, 1);
  expect(decision.recovery.events).toBe(0);
});

test("reported Human takeover stays paused across reads and ordinary Genie dispatch until a new turn", async () => {
  const current = await entered();
  const read = { id: "observe", name: "computer_observe", args: { operation: "desktop_state" } };
  let decision = settleNativeExecution(current.nativeDecision!, read, {
    settlement: "not_completed", result: { outcome: { externalInterference: "user_input" } },
  });
  expect(decision.humanTakeover).toBe(true);
  decision = settleNativeExecution(decision, read, { settlement: "completed", result: inventoryPage(0, 0) });
  expect(decision.reason).toBe("human_takeover");
  const paused = { ...current, nativeDecision: decision };
  for (const call of [read, { id: "launch", name: "computer_do", args: { operation: { kind: "launch_app", app: { name: "Sketchpad" } } } }]) {
    expect(nativeDecisionDispatchError(paused, call)).toBe("native_human_takeover_wait_for_user");
    expect(nativeDecisionDispatchError({ ...paused, turnId: "next-human-turn" }, call)).toBeNull();
  }
  expect(nativeDecisionDispatchError(paused, { name: "search_memory", args: {} })).toBeNull();
  const next = await createNativeDecisionNode({ interpretNative: async () => { throw new Error("must remain paused"); } })(paused, config);
  expect(next.nativeDecision?.pending).toBeNull();
  expect(next.nativeDecision?.reason).toBe("human_takeover");
});

test("empty inventories for different exact app targets are not the same read scope", async () => {
  let decision = (await entered()).nativeDecision!;
  for (const app of ["first", "second"]) {
    const appTarget = { ...target, reference: app };
    decision = settleNativeExecution(decision, { id: app, name: "computer_observe", args: { operation: "application_windows", target: appTarget } }, {
      settlement: "completed", result: { operation: "application_windows", target: appTarget, candidates: [] },
    });
    expect(decision.recovery.events).toBe(0);
  }
});

test("workflow action history keeps input references instead of copying authored bodies and delegation", async () => {
  let decision = (await entered()).nativeDecision!;
  const text = "Exact original 🐙\nDo not recreate.";
  decision = { ...decision, plan: { ...decision.plan, values: { poem: text } } };
  decision = settleNativeExecution(decision, { id: "read", name: "computer_observe", args: {
    operation: "window_state", target, decisionPlan: decision.plan,
  } }, { settlement: "completed", result: recoveryWindow(0) });
  decision = settleNativeExecution(decision, { id: "write", name: "computer_do", args: {
    operation: { kind: "type_text", target: element, text },
  } }, { settlement: "completed", result: { completionCertainty: "completed", outcome: { stateChangeCertainty: "changed" } } });
  expect(JSON.stringify(decision.history)).not.toContain(text);
  expect(JSON.stringify(decision.history)).not.toContain("decisionPlan");
  expect(decision.history.at(-1)?.evidence).toMatchObject({ source: { arguments: {
    operation: { text: { suppliedValues: ["poem"] } },
  } } });
  expect(decision.plan.values["poem"]).toBe(text);
});

function inventoryPage(offset: number, remaining: number) {
  return { version: 1, operation: "desktop_state", context: target.context,
    completeness: remaining ? "partial" : "complete", discovered: 1 + remaining, returned: 1, omitted: remaining,
    boundary: { kind: remaining ? "response_limit" : "none", retryable: remaining > 0 }, uninspected: null,
    continuation: remaining ? { version: 1, reference: `dcont_${String(offset).padEnd(43, "x")}` } : null,
    alternatives: [], targets: [{ target: { ...target, reference: `dtgt_${String(offset).padEnd(43, "x")}` },
      evidence: { kind: "window", appLabel: "Editor", windowLabel: `Document ${offset}` } }],
    applicationTargets: { discovered: 0, returned: 0, omitted: 0, targets: [] },
    outcome: { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] },
  };
}

const modelId = "openrouter:deepseek/deepseek-v4.1-flash";
const signal = new AbortController().signal;
const config = { signal };
const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
const element = { ...target, reference: `detgt_${"c".repeat(43)}` };
const ref = (source: "request" | "values" | "observation", path: (string | number)[] = [], slice?: { start: number; end: number }) => ({ $valueRef: { source, path, ...(slice ? { slice } : {}) } });
const response = (decision: NativeExecutionReply) => ({ decision, modelId, usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } });
function state(request = "Open Sketchpad"): NautiloState {
  return { turnId: "turn-fixture", userId: "human-fixture", agentId: "genie-fixture", roomId: "room-fixture", actorRole: "owner",
    trustedExecutionEntrypoint: "foreground.main", messages: [new HumanMessage(request)], toolNames: ["computer_observe", "computer_do"], approvedToolCalls: [],
  } as unknown as NautiloState;
}
async function entered(request?: string) {
  const initial = state(request);
  // Unit fixture starts inside an explicitly delegated CUA workflow. Ordinary
  // conversation routing is exercised by the real graph suite, not this seed.
  initial.nativeDecision = { turnId: initial.turnId, modelId: "openrouter:typesafe/jev-1.13",
    plan: nativeDecisionPlanSchema.parse({ execution: "workflow", goal: request ?? "Open Sketchpad", actions: [] }),
    observeArgs: {}, observation: null, phase: "interpret", pending: null, reason: null, generation: 0,
    controller: { modelId, attemptedGeneration: 0, active: true }, history: [], unresolved: [],
    recovery: { limit: 3, events: 0, transitions: [], before: null },
    execution: { request: request ?? "Open Sketchpad", tools: initial.toolNames, observation: null, observationCallId: null, freshRead: false, mustObserve: false, question: null },
  };
  return initial;
}

test("delegated workflow returns to Genie when Choice eligibility is withdrawn despite Flash availability", async () => {
  const current = await entered();
  const catalog = structuredClone(getActiveModelCatalogSync().catalog);
  for (const entry of catalog.entries) if ("workload" in entry && entry.workload === "decision") entry.defaultEnabled = false;
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false, fetchedAt: "2026-09-22T00:00:00.000Z",
      originUrl: "https://catalog.invalid/native-test.json", reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { throw new Error("must not invoke Flash without Choice eligibility"); },
  })(current, config);
  expect(next.nativeDecision?.phase).toBe("handoff");
  expect(next.nativeDecision?.reason).toBe("decision_model_unavailable");
  expect(next.nativeDecision?.pending).toBeNull();
  expect(current.toolNames).toEqual(["computer_observe", "computer_do"]);
});

test("inventory continuation bypasses model selection and retains every same-snapshot page", async () => {
  let current = await entered();
  const screenSnapshot = { target: { ...target, reference: `dsnap_${"s".repeat(43)}` }, evidence: { kind: "screen" },
    metadata: { format: "png", nativeDimensions: { width: 800, height: 600 }, presentedDimensions: { width: 800, height: 600 },
      display: { coordinateSpace: "desktop_pixels", origin: { x: 0, y: 0 } } } };
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,synthetic" } };
  const first = { ...inventoryPage(0, 2), screenSnapshot };
  current.messages.push(new ToolMessage({ tool_call_id: "first", content: [{ type: "text", text: JSON.stringify(first) }, image] }));
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "first", name: "computer_observe", args: { operation: "desktop_state" } },
    { settlement: "completed", result: first });
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { throw new Error("must not spend model calls on a known continuation"); } });
  for (let offset = 1; offset <= 2; offset++) {
    current = { ...current, ...await node(current, config) };
    const call = current.nativeDecision!.pending!;
    expect(call.name).toBe("computer_observe");
    expect(call.args).toMatchObject({ operation: "desktop_state", continuation: { context: target.context } });
    expect(nativeDecisionDispatchError(current, call)).toBeNull();
    current.nativeDecision = settleNativeExecution(current.nativeDecision!, call, { settlement: "completed", result: inventoryPage(offset, 2 - offset) });
    expect(current.nativeDecision.phase).toBe("interpret");
  }
  expect(current.nativeDecision.execution!.observation).toMatchObject({ completeness: "complete", discovered: 3, returned: 3, omitted: 0, continuation: null });
  expect(current.nativeDecision.execution!.observation!["targets"]).toHaveLength(3);
  expect(current.nativeDecision.execution!.continued).toHaveLength(2);
  expect(current.nativeDecision.history).toHaveLength(3);
  expect(current.nativeDecision.execution!.lastRead).toEqual({ tool: "computer_observe", arguments: { operation: "desktop_state" } });
  expect(current.nativeDecision.execution!.observation!["screenSnapshot"]).toEqual(screenSnapshot);
  expect(current.nativeDecision.execution!.observationCallId).toBe("first");
  let selections = 0;
  const inspect = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async input => {
    selections++;
    expect(input.images).toEqual([image]);
    expect(input.roots?.observation?.["targets"]).toHaveLength(3);
    return response({ kind: "genie", reason: "reasoning", question: "Fixture inspection complete" });
  } });
  await inspect(current, config);
  expect(selections).toBe(1);
  // An unrelated fresh read cannot inherit the old desktop's pixels.
  current.nativeDecision = settleNativeExecution(current.nativeDecision, { id: "window", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: recoveryWindow(0) });
  expect(current.nativeDecision.execution!.observationCallId).toBe("window");
  expect(current.nativeDecision.execution!.observation!["screenSnapshot"]).toBeUndefined();
});

test("paginated inventory then windowless launch reads the minted app instead of replaying its old page", async () => {
  const current = await entered();
  let decision = settleNativeExecution(current.nativeDecision!, { id: "first", name: "computer_observe", args: { operation: "desktop_state" } },
    { settlement: "completed", result: inventoryPage(0, 1) });
  decision = settleNativeExecution(decision, { id: "page", name: "computer_observe", args: {
    operation: "desktop_state", continuation: { ...inventoryPage(0, 1).continuation, context: target.context },
  } }, { settlement: "completed", result: inventoryPage(1, 0) });
  const appTarget = { ...target, reference: `datgt_${"d".repeat(43)}` };
  decision = settleNativeExecution(decision, { id: "launch", name: "computer_do", args: { operation: { kind: "launch_app", app: { name: "Sketchpad" } } } }, {
    settlement: "completed", result: { version: 1, timing: "immediate", action: "launch_app", app: { name: "Sketchpad", target: appTarget },
      window: null, launchProgress: { processRunning: true, requested: true, windowReady: false }, windowSelection: "none",
      completionCertainty: "completed", verification: "not_applicable", outcome: { version: 1, phase: "post_effect_verification",
        providerCondition: "ready", targetCondition: "current", recovery: ["observe_again"], retrySafety: "observe_before_retry", stateChangeCertainty: "changed" } },
  });
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { throw new Error("exact launch reacquisition needs no model"); },
  })({ ...current, nativeDecision: decision }, config);
  expect(next.nativeDecision?.pending?.args).toEqual({ operation: "application_windows", target: appTarget });
  expect(nativeDecisionDispatchError({ ...current, ...next }, next.nativeDecision!.pending!)).toBeNull();
  expect(next.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({ modelCalls: 0 });
});

test("legacy page checkpoints reacquire a fresh root and failed readback yields to explicit recovery", async () => {
  const current = await entered();
  let decision = current.nativeDecision!;
  decision.execution = { ...decision.execution!, mustObserve: true, lastRead: { tool: "computer_observe", arguments: {
    operation: "desktop_state", maxWindows: 40, continuation: { ...inventoryPage(0, 1).continuation, context: target.context },
  } } };
  let modelCalls = 0;
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async input => {
    modelCalls++;
    expect(input.state["mustObserve"]).toBe(true);
    expect(input.state["readbackFailed"]).toBe(true);
    expect(input.roots?.readArguments).toEqual({ operation: "desktop_state", maxWindows: 40 });
    return response({ kind: "call", tool: "computer_observe", arguments: { operation: "desktop_state" } });
  } });
  const cancelled = await node({ ...current, nativeDecision: decision }, { signal: AbortSignal.abort() });
  expect(cancelled.nativeDecision?.pending).toBeNull();
  expect(cancelled.nativeDecision?.reason).toBe("run_signal_unavailable_or_cancelled");
  expect(modelCalls).toBe(0);
  let next = await node({ ...current, nativeDecision: decision }, config);
  expect(next.nativeDecision?.pending?.args).toEqual({ operation: "desktop_state", maxWindows: 40 });
  expect(modelCalls).toBe(0);
  decision = settleNativeExecution(next.nativeDecision!, next.nativeDecision!.pending!, {
    settlement: "not_completed", result: { outcome: { phase: "observe", targetCondition: "stale", providerCondition: "ready", recovery: ["observe_again"] } },
  });
  expect(decision.execution?.mustObserve).toBe(true);
  expect(decision.recovery.events).toBe(1);
  next = await node({ ...current, nativeDecision: decision }, config);
  expect(modelCalls).toBe(1);
  expect(next.nativeDecision?.pending?.id).toStartWith("native-execute:");
  decision = settleNativeExecution(next.nativeDecision!, next.nativeDecision!.pending!, { settlement: "completed", result: inventoryPage(0, 0) });
  expect(decision.execution?.mustObserve).toBe(false);
  expect(decision.execution?.readbackFailed).toBe(false);
  expect(decision.recovery.events).toBe(0);
});

test("failed reads cannot evade recovery or clear unknown-effect and mutation fences", async () => {
  const current = await entered();
  let decision = settleNativeExecution(current.nativeDecision!, { id: "read", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: recoveryWindow(0) });
  decision = settleNativeExecution(decision, { id: "write", name: "computer_do", args: { operation: { kind: "click", target: element } } },
    { settlement: "unknown_completion", result: { completionCertainty: "unknown_completion", outcome: { stateChangeCertainty: "unknown" } } });
  const observe = { id: "refused-read", name: "computer_observe", args: { operation: "window_state", target } };
  const refused = { settlement: "not_completed", result: { outcome: { targetCondition: "stale", providerCondition: "ready" } } };
  for (let count = 1; count <= decision.recovery.limit; count++) {
    decision = settleNativeExecution(decision, observe, refused);
    expect(decision.recovery.events).toBe(count);
    expect(decision.unresolved).toHaveLength(1);
    expect(decision.execution?.mustObserve).toBe(true);
    expect(decision.execution?.freshRead).toBe(false);
    if (count === 1) {
      const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
        interpretNative: async () => response({ kind: "call", tool: "computer_do", arguments: { operation: { kind: "launch_app", app: { name: ref("request", [], { start: 5, end: 14 }) } } } }),
      })({ ...current, nativeDecision: decision }, config);
      expect(next.nativeDecision?.reason).toBe("execution_fresh_verification_required");
      expect(next.nativeDecision?.pending).toBeNull();
    }
  }
  expect(decision.phase).toBe("handoff");
  expect(decision.reason).toBe("native_decision_no_progress");
});

test("inventory merge refuses changed contexts, repeated pages and stalled coverage", () => {
  const first = inventoryPage(0, 2);
  const token = { ...first.continuation, context: target.context };
  for (const next of [{ ...inventoryPage(1, 1), context: `dctx_${"z".repeat(43)}` },
    inventoryPage(0, 1), inventoryPage(1, 2),
    { ...inventoryPage(1, 2), targets: [], returned: 0, discovered: 2 }]) {
    expect(() => mergeNativeDesktopPage(first, next, token)).toThrow();
  }
});

function checkedRead(id: string, payload: unknown) {
  const raw = JSON.stringify({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: id,
    fence: { hostGeneration: "host", driverGeneration: "driver", cancellationGeneration: 1 },
    contract: COMPUTER_USE_NATIVE_CONTRACTS.observe, settlement: "completed", result: payload });
  return new ToolMessage({ name: "computer_observe", tool_call_id: id, content: projectSemanticComputerResult("computer_observe", raw),
    additional_kwargs: computerResultDurableSidecar("computer_observe", raw) });
}

test("wrong-window read retains all same-context sibling choices without old controls or pixels", async () => {
  const current = await entered();
  const window = recoveryWindow(0);
  const pages = [inventoryPage(0, 1), inventoryPage(1, 0)];
  current.messages.push(checkedRead("page0", pages[0]), checkedRead("page1", pages[1]), checkedRead("window", window));
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "window", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: window });
  const projected = nativeExecutionObservation(current, current.nativeDecision);
  expect(projected?.["availableWindows"]).toEqual([pages[1]!.targets[0], pages[0]!.targets[0]]);
  expect(projected?.["screenSnapshot"]).toBeUndefined();
  expect(projected?.["controlCollection"]).toEqual(window.controlCollection);
  expect(current.nativeDecision.execution?.observation?.["availableWindows"]).toBeUndefined();
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async input => {
    expect(input.roots?.observation).toEqual(projected);
    expect(input.images).toEqual([]);
    return response({ kind: "call", tool: "computer_observe", arguments: {
      operation: "window_state", target: ref("observation", ["availableWindows", 0, "target"]), capture: "window_snapshot",
    } });
  } })(current, config);
  expect(next.nativeDecision?.pending?.args).toEqual({ operation: "window_state", target: pages[1]!.targets[0]!.target, capture: "window_snapshot" });
  expect(nativeDecisionDispatchError({ ...current, ...next }, next.nativeDecision!.pending!)).toBeNull();
});

test("full workflow keeps screenshot choices instead of switching to a text-only control menu", async () => {
  const current = await entered();
  current.nativeDecision!.plan = nativeDecisionPlanSchema.parse({ execution: "workflow", goal: "Inspect the rendered document" });
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "window", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: recoveryWindow(0) });
  let interpretations = 0;
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    control: async () => { throw new Error("full workflow must retain its image-capable operation menu"); },
    interpretNative: async () => { interpretations++; return response({ kind: "call", tool: "computer_observe", arguments: {
      operation: "window_state", target: ref("observation", ["target"]), capture: "window_snapshot",
    } }); },
  })(current, config);
  expect(interpretations).toBe(1);
  expect(next.nativeDecision?.pending?.args).toEqual({ operation: "window_state", target, capture: "window_snapshot" });
  expect(next.nativeDecision?.phase).toBe("waiting");
});

test("sibling projection stops at turn, effect, failed-read and changed-context boundaries", async () => {
  const current = await entered();
  const window = recoveryWindow(0);
  const page = checkedRead("page", inventoryPage(0, 0));
  const latest = checkedRead("window", window);
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "window", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: window });
  const boundaries = [new HumanMessage("new turn"),
    new AIMessage({ content: "", tool_calls: [{ id: "write", name: "computer_do", args: { operation: { kind: "focus", target } } }] }),
    new ToolMessage({ name: "computer_observe", tool_call_id: "failed", content: "unavailable" }),
    checkedRead("context", { ...window, target: { ...target, context: `dctx_${"z".repeat(43)}` } }),
    checkedRead("takeover", { ...window, outcome: { ...window.outcome, externalInterference: "user_input" } }),
  ];
  for (const boundary of boundaries) {
    expect(nativeExecutionObservation({ ...current, messages: [page, boundary, latest] }, current.nativeDecision)).toEqual(window);
    expect(nativeExecutionObservation({ ...current, messages: [page, latest, boundary] }, current.nativeDecision)).toEqual(window);
  }
  expect(nativeExecutionObservation({ ...current, messages: [page] }, current.nativeDecision)).toEqual(window);
  expect(nativeExecutionObservation({ ...current, messages: [page, latest] }, { ...current.nativeDecision, humanTakeover: true })).toEqual(window);
  expect(nativeExecutionObservation({ ...current, messages: [page, latest] }, { ...current.nativeDecision,
    execution: { ...current.nativeDecision.execution!, mustObserve: true } })).toEqual(window);
});

test("consumed continuation and cancellation do not reread or run a model", async () => {
  const current = await entered();
  const first = inventoryPage(0, 1);
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "first", name: "computer_observe", args: { operation: "desktop_state" } },
    { settlement: "completed", result: first });
  current.nativeDecision.execution!.continued = [`${target.context}:${first.continuation!.reference}`];
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { throw new Error("must not call model"); } });
  expect((await node(current, config)).nativeDecision?.reason).toBe("native_inventory_continuation_stalled");
  expect((await node(current, { signal: AbortSignal.abort() })).nativeDecision?.pending).toBeNull();
});

test("partial coverage without a real continuation does not cause a blind refresh", async () => {
  const current = await entered();
  const page = { ...inventoryPage(0, 1), continuation: null };
  current.nativeDecision = settleNativeExecution(current.nativeDecision!, { id: "first", name: "computer_observe", args: { operation: "desktop_state" } },
    { settlement: "completed", result: page });
  let calls = 0;
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => { calls++; return response({ kind: "genie", reason: "missing_capability", question: "Inventory is partial without continuation" }); },
  })(current, config);
  expect(calls).toBe(1); expect(next.nativeDecision?.pending).toBeNull();
});
let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "synthetic-native-execution";
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
});
afterEach(() => {
  if (previousKey === undefined) delete process.env["OPENROUTER_API_KEY"]; else process.env["OPENROUTER_API_KEY"] = previousKey;
  resetRuntimeModelCatalog();
});

test("delegated CUA work proposes launch without another Genie plan or scan", async () => {
  const current = await entered();
  expect(current.nativeDecision?.phase).toBe("interpret");
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async input => {
    expect(input.state["request"]).toBe("Open Sketchpad");
    expect(input.state["observation"]).toBeNull();
    return response({ kind: "call", tool: "computer_do", arguments: { operation: { kind: "launch_app", app: { name: ref("request", [], { start: 5, end: 14 }) } } } });
  } })(current, config);
  const call = next.nativeDecision!.pending!;
  expect(call.args).toEqual({ operation: { kind: "launch_app", app: { name: "Sketchpad" } } });
  expect(nativeDecisionDispatchError({ ...current, ...next }, call)).toBeNull();
  expect(nativeDecisionDispatchError({ ...current, ...next, nativeDecision: { ...next.nativeDecision!, execution: { ...next.nativeDecision!.execution!, mustObserve: true } } }, call)).toBe("native_execution_effect_not_current");
  expect(nativeDecisionDispatchError({ ...current, ...next }, { ...call, args: { surprise: true } })).toBe("native_decision_proposal_changed");
});



test("all non-enum input strings must bind original bytes, including schema unions", () => {
  const schema = computerUseHostToolDefinition("computer_do")!.entry.publicSchemas.input.jsonSchema;
  const template = { operation: { kind: "launch_app", app: { name: ref("request", [], { start: 5, end: 14 }) } } };
  const roots = { request: "Open Sketchpad", values: {}, observation: null };
  const bound = bindNativeExecutionValue(template, roots);
  expect(nativeExecutionStringsBound(template, bound, schema)).toBe(true);
  expect(nativeExecutionStringsBound(bound, bound, schema)).toBe(false);
  const hotkey = { operation: { kind: "hotkey", target: ref("observation", ["target"]), keys: ["cmd", "n"] } };
  expect(nativeExecutionStringsBound(hotkey, bindNativeExecutionValue(hotkey, { ...roots, observation: { target } }), schema)).toBe(true);
  const original = "Exact 🐙\ntext — do not recreate.";
  expect(bindNativeExecutionValue(ref("values", ["poem"]), { ...roots, values: { poem: original } })).toBe(original);
  expect(() => bindNativeExecutionValue(ref("request", ["toString"]), roots)).toThrow();
  expect(() => bindNativeExecutionValue(ref("request", [], { start: 0, end: 999 }), roots)).toThrow();
  expect(() => bindNativeExecutionValue(ref("values", ["poem"], { start: 0, end: 7 }), { ...roots, values: { poem: original } })).toThrow();
  expect(projectNativeExecutionObservation({ target })).toEqual({ target: ref("observation", ["target"]) });
});

test("composition routes once to Genie and resumes through a checked workflow delegation", async () => {
  const current = await entered("Open an editor and write a poem about reality");
  const handed = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async () => response({ kind: "genie", reason: "composition", question: "Author the requested poem once, then delegate insertion." }),
  })(current, config);
  expect(handed.nativeDecision?.phase).toBe("handoff");
  expect(handed.nativeDecision?.reason).toBe("execution_composition");
  expect(handed.messages?.at(-1)?.content).toContain("decisionPlan.values");
  const afterGenie = { ...current, ...handed };
  const poem = "Original 🌊\nDo not rewrite.";
  const call = { id: "authored-once", name: "computer_observe", args: { operation: "window_state", target,
    decisionPlan: { execution: "workflow", goal: "Insert the poem and verify", values: { poem } } } };
  expect(nativeDecisionHostArguments(call.name, call.args)).toEqual({ operation: "window_state", target });
  const raw = JSON.stringify({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: call.id,
    fence: { hostGeneration: "host", driverGeneration: "driver", cancellationGeneration: 1 }, contract: COMPUTER_USE_NATIVE_CONTRACTS.observe,
    settlement: "completed", result: { version: 1, operation: "window_state", target, evidence: { kind: "window", appLabel: "Editor", windowLabel: "Draft" },
      completeness: "partial", degraded: false, verification: "indeterminate", controlCollection: { completeness: "partial", received: 1, omitted: 0,
        controls: [{ id: "c0", role: "text_area", label: "Body", target: element, state: { completeness: "partial", value: "" } }] },
      outcome: { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] } } });
  const result = new ToolMessage({ name: call.name, tool_call_id: call.id, content: projectSemanticComputerResult(call.name, raw),
    additional_kwargs: computerResultDurableSidecar(call.name, raw) });
  const delegated = settleNativeDecision({ ...afterGenie, messages: [...afterGenie.messages, new AIMessage({ content: "", tool_calls: [call] })] }, [call], [result], [], current.nativeDecision!.modelId)!;
  expect(delegated.phase).toBe("interpret");
  expect(delegated.plan.values["poem"]).toBe(poem);
  let selections = 0;
  let classifierSelections = 0;
  let reviewCalls = 0;
  const select = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: async input => {
      selections++;
      if (selections === 1) return response({ kind: "call", tool: "computer_do", arguments: { operation: {
        kind: "type_text", target: ref("observation", ["controlCollection", "controls", 0, "target"]), text: ref("values", ["poem"]),
      } } });
      return invokeThroughMiddle(input, () => Promise.resolve({ invoke: messages => {
      reviewCalls++;
      const content = (messages[1] as BaseMessage).content as { type: string; text: string }[];
      const request = JSON.parse(content[0]!.text) as { choices: { id: string; description: string }[] };
      if (reviewCalls === 1) {
        const complete = request.choices.find(choice => choice.description.startsWith("Complete ONLY"));
        expect(complete).toBeDefined();
        return Promise.resolve({ content: complete!.id, usage_metadata: { input_tokens: 10, output_tokens: 1 } });
      }
      expect(request.choices.map(row => row.id)).toEqual(["goal_satisfied", "goal_incomplete", "defer_to_genie"]);
      return Promise.resolve({ content: "goal_satisfied", usage_metadata: { input_tokens: 10, output_tokens: 1 } });
    } })); },
    choose: async () => {
      classifierSelections++;
      return { selectedId: "completion_ready", requestedModelId: current.nativeDecision!.modelId, resolvedModelId: null,
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } };
    },
    control: async () => { throw new Error("workflow must not switch to the window-only menu"); },
  });
  const changed = structuredClone(delegated);
  changed.execution!.lastRead!.arguments["target"] = { ...target, reference: `dtgt_${"z".repeat(43)}` };
  const refused = await select({ ...current, nativeDecision: changed }, config);
  expect(refused.nativeDecision?.reason).toBe("native_observation_target_changed");
  expect(selections).toBe(0);
  const next = await select({ ...current, nativeDecision: delegated }, config);
  expect(next.nativeDecision?.pending?.args).toEqual({ operation: { kind: "type_text", target: element, text: poem } });
  expect(next.nativeDecision?.execution?.request).toBe("Open an editor and write a poem about reality");
  expect(next.nativeDecision?.execution?.boundInputs).toEqual([ref("values", ["poem"])]);
  expect(reviewCalls).toBe(0);
  expect(nativeDecisionDispatchError({ ...current, ...next }, next.nativeDecision!.pending!)).toBeNull();
  const pending = next.nativeDecision!.pending!;
  const actionRaw = JSON.stringify({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: pending.id,
    fence: { hostGeneration: "host", driverGeneration: "driver", cancellationGeneration: 1 }, contract: COMPUTER_USE_NATIVE_CONTRACTS.do,
    settlement: "completed", result: { version: 1, timing: "immediate", action: "type_text", target: element,
      resolvedTarget: { kind: "element", role: "text_area", action: "type_text", enabled: true },
      provider: "cua", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
      unexecutedRemainder: { count: 0, reason: "none" },
      providerAction: { effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidenceKinds: ["value_readback"], escalation: null },
      outcome: { version: 1, phase: "post_effect_verification", retrySafety: "never", stateChangeCertainty: "changed",
        providerCondition: "ready", targetCondition: "current", recovery: [] } } });
  const actionResult = new ToolMessage({ name: pending.name, tool_call_id: pending.id, content: projectSemanticComputerResult(pending.name, actionRaw),
    additional_kwargs: computerResultDurableSidecar(pending.name, actionRaw) });
  const mutated = settleNativeDecision({ ...current, ...next }, [pending], [actionResult], [], modelId)!;
  expect(mutated.phase).toBe("interpret");
  expect(mutated.execution?.mustObserve).toBe(true);
  const freshRead = await select({ ...current, nativeDecision: mutated }, config);
  expect(freshRead.nativeDecision?.pending?.name).toBe("computer_observe");
  expect(freshRead.nativeDecision?.pending?.args).toEqual({ operation: "window_state", target });
  expect(selections).toBe(1);
  expect(reviewCalls).toBe(0);
  expect(freshRead.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({ operation: "verify_effect", modelCalls: 0 });
  const read = freshRead.nativeDecision!.pending!;
  const readPayload = JSON.parse(raw) as { requestId: string; result: { controlCollection: { controls: Array<{ state: { value: string } }> } } };
  readPayload.requestId = read.id;
  readPayload.result.controlCollection.controls[0]!.state.value = poem;
  const readRaw = JSON.stringify(readPayload);
  const readResult = new ToolMessage({ name: read.name, tool_call_id: read.id, content: projectSemanticComputerResult(read.name, readRaw),
    additional_kwargs: computerResultDurableSidecar(read.name, readRaw) });
  const observed = settleNativeDecision({ ...current, ...freshRead }, [read], [readResult], [], modelId)!;
  expect(observed.phase).toBe("interpret");
  const completed = await select({ ...current, nativeDecision: observed }, config);
  expect(completed.nativeDecision?.phase).toBe("complete");
  expect(completed.nativeDecision?.pending).toBeNull();
  expect(selections).toBe(2);
  expect(classifierSelections).toBe(0);
  expect(reviewCalls).toBe(2);
  expect(completed.nativeDecision?.history).toHaveLength(observed.history.length);
  expect(completed.messages?.some(message => typeof message.content === "string" && message.content.includes("native_decision_handoff"))).toBe(false);

  // The same transition must not dispatch a selected action after a source
  // change, cancellation, or loss of Choice eligibility.
  for (const mode of ["source_changed", "source_replaced", "cancelled", "choice_withdrawn"] as const) {
    const checkpoint = structuredClone(delegated);
    const cancellation = new AbortController();
    let calls = 0;
    if (mode === "choice_withdrawn") checkpoint.modelId = "not-an-eligible-choice-model";
    const stopped = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
      interpretNative: async () => {
        calls++;
        if (mode === "cancelled") cancellation.abort();
        if (mode === "source_changed") checkpoint.plan.values["poem"] = "changed";
        if (mode === "source_replaced") checkpoint.execution = { ...checkpoint.execution!, request: "Different request" };
        return response({ kind: "call", tool: "computer_observe", arguments: { operation: "window_state", target: ref("observation", ["target"]) } });
      },
    })({ ...current, nativeDecision: checkpoint }, { signal: cancellation.signal });
    expect(stopped.nativeDecision?.pending).toBeNull();
    expect(stopped.nativeDecision?.reason).toBe(mode === "source_changed" || mode === "source_replaced" ? "execution_sources_changed"
      : mode === "cancelled" ? "run_cancelled" : "decision_model_unavailable");
    expect(calls).toBe(mode === "choice_withdrawn" ? 0 : 1);
    if (calls) expect(stopped.messages?.at(-2)?.additional_kwargs["nautilo_native_decision"])
      .toMatchObject({ usage: { inputTokens: 20, outputTokens: 5 } });
  }

  const uncertain = settleNativeExecution(next.nativeDecision!, pending,
    { settlement: "unknown_completion", result: { completionCertainty: "unknown_completion" } });
  expect(uncertain.unresolved).toHaveLength(1);
  const verification = await select({ ...current, nativeDecision: uncertain }, config);
  expect(verification.nativeDecision?.pending?.args).toEqual({ operation: "window_state", target });
  const retained = settleNativeExecution(verification.nativeDecision!, verification.nativeDecision!.pending!,
    { settlement: "completed", result: readPayload.result });
  expect(retained.reason).toBe("unresolved_effect_requires_verification");
  expect(retained.unresolved).toHaveLength(1);
  expect(selections).toBe(2);
  expect(reviewCalls).toBe(2);
});

test("fresh verification stays in fast execution and completion evaluates real predicates", async () => {
  const current = await entered();
  const call = { id: "launch", name: "computer_do", args: { operation: { kind: "launch_app", app: { name: "Sketchpad" } } } };
  const action = settleNativeExecution(current.nativeDecision!, call, { settlement: "completed", result: { completionCertainty: "completed" } });
  expect(action.execution?.mustObserve).toBe(true);
  expect(shouldContinueAfterTools({ ...current, nativeDecision: action })).toBe("native_decision");
  const proof: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Sketchpad is open.",
    checks: [{ path: ["appName"], comparison: "equals", expected: ref("request", [], { start: 5, end: 14 }) }] };
  expect(nativeExecutionCompletion(proof, action)).toBe(false);
  const read = settleNativeExecution(action, { id: "read", name: "computer_observe", args: {} }, { settlement: "completed", result: { appName: "Sketchpad" } });
  expect(nativeExecutionCompletion(proof, read)).toBe(true);
  expect(nativeExecutionCompletion({ ...proof, checks: [{ path: ["appName"], comparison: "equals", expected: ref("observation", ["appName"]) }] }, read)).toBe(false);
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async () => response(proof) })({ ...current, nativeDecision: read }, config);
  expect(next.nativeDecision?.phase).toBe("complete");
  expect(next.messages?.at(-1)?.content).toBe("Sketchpad is open.");
});

test("unknown effects, cancelled work and human takeover cannot become repeated input", async () => {
  const current = await entered();
  const call = { id: "write", name: "computer_do", args: { operation: { kind: "type_text", target: element, text: "exact" } } };
  const unknown = settleNativeExecution(current.nativeDecision!, call, { settlement: "unknown_completion", result: { completionCertainty: "unknown_completion" } });
  expect(unknown.unresolved).toHaveLength(1);
  expect(settleNativeExecution(current.nativeDecision!, call, { settlement: "failed", result: {} }).unresolved).toHaveLength(1);
  expect(settleNativeExecution(current.nativeDecision!, call, { settlement: "failed", result: { completionCertainty: "not_completed", outcome: { stateChangeCertainty: "not_changed" } } }).unresolved).toHaveLength(0);
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async () => response({ kind: "call", tool: "computer_do", arguments: call.args }) });
  const blocked = await node({ ...current, nativeDecision: unknown }, config);
  expect(blocked.nativeDecision?.reason).toBe("execution_fresh_verification_required");
  const reread = settleNativeExecution(unknown, { id: "read", name: "computer_observe", args: {} }, { settlement: "completed", result: { value: "exact" } });
  expect(reread.phase).toBe("handoff");
  expect(reread.unresolved).toHaveLength(1);
  for (const settlement of ["cancelled", "revoked", "fenced"]) expect(settleNativeExecution(current.nativeDecision!, call, { settlement, result: {} }).phase).toBe("handoff");
  expect(settleNativeExecution(current.nativeDecision!, call, { settlement: "completed", result: { outcome: { externalInterference: "user_input" } } }).reason).toBe("human_takeover");
});


test("retained read inputs permit reacquisition but never mutation or completion proof", async () => {
  const current = await entered();
  const read = settleNativeExecution(current.nativeDecision!, { id: "read", name: "computer_observe", args: { operation: "window_state", target } },
    { settlement: "completed", result: { target } });
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async () => response({ kind: "call", tool: "computer_do",
    arguments: { operation: { kind: "focus", target: { $valueRef: { source: "readArguments", path: ["target"] } } } } }),
  })({ ...current, nativeDecision: read }, config);
  expect(next.nativeDecision?.reason).toBe("execution_historical_input_not_authority");
  expect(nativeExecutionCompletion({ kind: "complete", summary: "done", checks: [{ path: ["target"], comparison: "equals",
    expected: { $valueRef: { source: "readArguments", path: ["target"] } } }] }, read)).toBe(false);
});

test("post-effect readback is code-owned even for an unresolved mutation", async () => {
  for (const settlement of ["completed", "unknown_completion"]) {
    const current = await entered();
    const read = settleNativeExecution(current.nativeDecision!, { id: "read", name: "computer_observe", args: { operation: "window_state", target } },
      { settlement: "completed", result: { target } });
    const changed = settleNativeExecution(read, { id: "mutate", name: "computer_do", args: { operation: { kind: "focus", target } } },
      { settlement, result: { completionCertainty: settlement, outcome: { stateChangeCertainty: settlement === "completed" ? "changed" : "unknown" } } });
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
      interpretNative: async () => { throw new Error("no model needed for exact readback"); },
    })({ ...current, nativeDecision: changed }, config);
    expect(next.nativeDecision?.pending?.args).toEqual({ operation: "window_state", target });
    expect(next.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({ operation: "verify_effect", modelCalls: 0 });
    expect(next.nativeDecision?.unresolved.length).toBe(settlement === "completed" ? 0 : 1);
  }
});

test("source mutation during input selection retires the proposal before dispatch", async () => {
  const current = await entered();
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async input => {
    input.roots!.values["poem"] = "changed during selection";
    return response({ kind: "call", tool: "computer_do", arguments: { operation: { kind: "launch_app", app: { name: ref("request", [], { start: 5, end: 14 }) } } } });
  } })(current, config);
  expect(next.nativeDecision?.reason).toBe("execution_sources_changed");
  expect(next.nativeDecision?.pending).toBeNull();
});

test("completion IDs use code-built fresh equalities, not receipts or self-comparisons", async () => {
  const current = await entered();
  const d = current.nativeDecision!;
  d.execution!.boundInputs = [ref("request", [], { start: 5, end: 14 })];
  d.execution!.observation = { evidence: { appLabel: "Sketchpad" } };
  expect(nativeExecutionCompletionChoice(d)).toBeUndefined();
  d.execution!.freshRead = true;
  const completion = nativeExecutionCompletionChoice(d)!;
  expect(completion.checks).toEqual([{ path: ["evidence", "appLabel"], comparison: "equals", expected: ref("request", [], { start: 5, end: 14 }) }]);
  expect(nativeExecutionCompletion(completion, d)).toBe(true);
  d.execution!.observation = { evidence: { appLabel: "Wrong app" } };
  expect(nativeExecutionCompletion(completion, d)).toBe(false);
  expect(nativeExecutionCompletionChoice(d)).toBeUndefined();
  d.execution!.observation = { evidence: { appLabel: "Sketchpad" } };
  d.execution!.mustObserve = true;
  expect(nativeExecutionCompletionChoice(d)).toBeUndefined();
});

test("completion review retains semantic scope without copying native handles or authored bytes", () => {
  const body = "Exact body 🐙\nNo rewriting.";
  const roots = { request: "Insert the draft", values: { draft: body }, observation: {
    evidence: { appLabel: "Editor", windowLabel: "Draft" }, target,
    controls: [{ role: "text_area", label: "Body", target: element, state: { value: body } },
      { role: "button", label: "Unrelated private content" }],
  } };
  const proof: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["controls", 0, "state", "value"], comparison: "equals", expected: ref("values", ["draft"]) },
  ] };
  const evidence = nativeExecutionCompletionEvidence(proof, roots);
  expect(evidence.coverage).toBe("matching_fact_context_only");
  const serialized = JSON.stringify(evidence);
  for (const included of ["Body", "text_area", "appLabel", "matchesInputs"]) expect(serialized).toContain(included);
  for (const excluded of [body, target.reference, target.context, element.reference, "Unrelated private content"]) expect(serialized).not.toContain(excluded);
  expect(() => nativeExecutionCompletionEvidence({ ...proof, checks: [{ ...proof.checks[0]!, expected: ref("observation", ["controls", 0, "state", "value"]) }] }, roots)).toThrow("native_completion_expectation_invalid");
  roots.observation.controls[0]!.state!.value = "Not the requested content";
  expect(() => nativeExecutionCompletionEvidence(proof, roots)).toThrow("native_completion_fact_changed");
});

test("production completion review counts all calls and cannot bypass source or cancellation fences", async () => {
  for (const mode of ["complete", "continue", "source_changed", "cancelled", "invalid_id"] as const) {
    const current = await entered(mode === "continue" ? "Open Sketchpad and create a blank document" : "Open Sketchpad");
    const execution = current.nativeDecision!.execution!;
    execution.boundInputs = [ref("request", [], { start: 5, end: 14 })];
    execution.freshRead = true;
    execution.observation = { evidence: { appLabel: "Sketchpad", windowLabel: "Welcome" }, target };
    execution.lastRead = { tool: "computer_observe", arguments: { operation: "window_state", target } };
    const controller = new AbortController();
    let calls = 0;
    const model: ChatModel = { invoke: messages => {
      calls++;
      const content = (messages[1] as BaseMessage).content as { type: string; text: string }[];
      const input = JSON.parse(content[0]!.text) as { choices: { id: string; description: string }[] };
      let selectedId = "reobserve";
      if (calls === 1) selectedId = input.choices.find(row => row.description.startsWith("Complete ONLY"))!.id;
      if (calls === 2) {
        expect(input.choices.map(row => row.id)).toEqual(["goal_satisfied", "goal_incomplete", "defer_to_genie"]);
        expect(JSON.stringify(messages)).not.toContain(target.reference);
        if (mode === "source_changed") execution.observation = { evidence: { appLabel: "Different app" } };
        if (mode === "cancelled") controller.abort();
        selectedId = mode === "continue" ? "goal_incomplete" : mode === "invalid_id" ? "invented" : "goal_satisfied";
      }
      return Promise.resolve({ content: selectedId, usage_metadata: { input_tokens: 10, output_tokens: 1 } });
    } };
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
      interpretNative: input => invokeThroughMiddle(input, () => Promise.resolve(model)),
    })(current, { signal: controller.signal });
    expect(calls).toBe(mode === "continue" ? 3 : 2);
    const telemetry = [...next.messages ?? []].reverse().find(message => message.additional_kwargs["nautilo_native_decision"])?.additional_kwargs["nautilo_native_decision"];
    expect(telemetry).toMatchObject({ modelCalls: calls + 1, usage: { inputTokens: 10 * calls + 7, outputTokens: calls + 1 } });
    if (mode === "complete") expect(next.nativeDecision?.phase).toBe("complete");
    else if (mode === "continue") {
      expect(next.nativeDecision?.phase).toBe("waiting");
      expect(next.nativeDecision?.pending).toMatchObject({ name: "computer_observe", args: execution.lastRead.arguments });
      expect(nativeDecisionDispatchError({ ...current, ...next }, next.nativeDecision!.pending!)).toBeNull();
    } else {
      expect(next.nativeDecision?.phase).toBe("handoff");
      expect(next.nativeDecision?.pending).toBeNull();
      if (mode === "source_changed") expect(next.nativeDecision?.reason).toBe("execution_sources_changed");
    }
  }
});

test("production provider has a stable prefix, actual image content and measured usage", async () => {
  const prefixes: unknown[] = [];
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,synthetic" } };
  const input: NativeExecutionInput = { modelId, signal, capabilities: [{ name: "computer_observe", description: "Inspect", effectClass: "read", schema: { type: "object" } }],
    roots: { request: "Inspect the image", values: { supplied: "Exact 🐙" }, observation: null },
    state: { request: "Inspect the image", values: { supplied: "Exact 🐙" } }, images: [image] };
  const model: ChatModel = {
    bindTools: () => { throw new Error("must not ask the model to build a tool call"); },
    invoke: (messages, config) => {
        expect(config).toMatchObject({ metadata: { nautilo_output_visibility: "internal_decision" } });
        prefixes.push((messages[0] as BaseMessage).content);
        expect(((messages[1] as BaseMessage).content as unknown[])[1]).toEqual(image);
        expect(JSON.stringify(messages)).not.toContain("Exact 🐙");
        return Promise.resolve({ content: "defer_to_genie",
          usage_metadata: { input_tokens: 80, output_tokens: 10, input_token_details: { cache_read: 60 } } });
    },
  };
  for (const request of ["Inspect the image", "Inspect the second state"]) {
    input.state["request"] = request;
    const result = await invokeNativeExecution(input, (id, options) => {
      expect(id).toBe(modelId);
      expect(options).toEqual({ reasoningEffort: "off", reasoningOutput: false });
      return Promise.resolve(model);
    });
    expect(result.usage).toEqual({ inputTokens: 80, outputTokens: 10, cacheReadTokens: 60, cacheWriteTokens: null, actualCostUsd: null });
    expect(result.modelCalls).toBe(1);
  }
  expect(prefixes[0]).toEqual(prefixes[1]);
  expect(JSON.stringify(prefixes)).not.toContain("Exact 🐙");
  const invalid: ChatModel = { invoke: () => Promise.resolve({ tool_calls: [
    { name: "run_shell", args: {} },
  ] }) };
  expect(invokeNativeExecution(input, () => Promise.resolve(invalid))).rejects.toThrow();
});

test("the production Choice-first path emits an admitted action with no Flash and retains source/cancellation fences", async () => {
  for (const mode of ["act", "source_changed", "cancelled"] as const) {
    const current = await entered("Click Export");
    current.nativeDecision!.execution!.observation = { controls: [{ label: "Export", target: element }] };
    current.nativeDecision!.execution!.freshRead = true;
    current.nativeDecision!.plan.constraints = ["Do not close the document"];
    current.nativeDecision!.history = [{ action: "computer_observe", settlement: "completed", evidence: { window: "Draft", outcome: "Export is visible" } }];
    current.nativeDecision!.execution!.question = "Continue after finding the Export button";
    const controller = new AbortController();
    let choiceCalls = 0;
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
      interpretNative: input => invokeNativeExecution(input,
        async () => { throw new Error("complete action must not initialize Flash"); },
        async () => { throw new Error("complete action must not bind fields"); }, async request => {
          choiceCalls++;
          expect(request.modelId).toBe(current.nativeDecision!.modelId);
          expect(request.choices.length).toBeLessThanOrEqual(256);
          expect(request.state).toMatchObject({ request: "Click Export", constraints: ["Do not close the document"],
            recentActions: current.nativeDecision!.history,
            continuation: { freshRead: true, question: "Continue after finding the Export button" },
            decisionRoles: { selector: { input: "text evidence and supplied choices only" },
              interpreter: { modelId, suppliedImages: 0 }, genie: { role: "existing user-selected Genie" } } });
          expect(JSON.stringify(request)).not.toContain(element.reference);
          const state = request.state as { actionTemplates: { id: string; tool: string; arguments: unknown }[]; bindingSources: Record<string, string> };
          const candidate = request.choices.find(row => {
            if (!row.description.startsWith("{")) return false;
            const { action, ...inputs } = JSON.parse(row.description) as Record<string, string>;
            const template = state.actionTemplates.find(row => row.id === action);
            return template?.tool === "computer_do" && JSON.stringify(template.arguments).includes('"click"')
              && Object.values(inputs).some(id => state.bindingSources[id]?.includes("Export"));
          });
          expect(candidate).toBeDefined();
          if (mode === "source_changed") input.roots!.observation = { controls: [] };
          if (mode === "cancelled") controller.abort();
          return selectedChoice(request, candidate!.id);
        }),
    })(current, { signal: controller.signal });
    expect(choiceCalls).toBe(1);
    if (mode === "act") {
      expect(next.nativeDecision?.pending?.args).toEqual({ operation: { kind: "click", target: element } });
      expect(nativeDecisionDispatchError({ ...current, ...next }, next.nativeDecision!.pending!)).toBeNull();
    } else {
      expect(next.nativeDecision?.pending).toBeNull();
      expect(next.nativeDecision?.reason).toBe(mode === "source_changed" ? "execution_sources_changed" : "run_cancelled");
    }
    const telemetry = [...next.messages ?? []].reverse().find(message => message.additional_kwargs["nautilo_native_decision"])?.additional_kwargs["nautilo_native_decision"];
    expect(telemetry).toMatchObject({ modelCalls: 1, modelUsage: [{ modelId: current.nativeDecision!.modelId, modelCalls: 1 }] });
  }
});

test("Jev selects an issued visual route, not prose; only Middle receives the image and all calls are measured", async () => {
  const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,synthetic-visual-route" } };
  const decisionModelId = "openrouter:typesafe/jev-1.13";
  let middleCalls = 0;
  const result = await invokeNativeExecution({ modelId, decisionModelId, signal,
    capabilities: [], roots: { request: "Inspect the unusual dialog", values: {}, observation: { label: "Dialog" } }, state: {}, images: [image],
  }, async () => ({ invoke: async messages => {
    middleCalls++;
    const content = (messages[1] as BaseMessage).content as unknown[];
    expect(content[1]).toEqual(image);
    const packet = JSON.parse((content[0] as { text: string }).text) as { state: Record<string, unknown>; choices: { id: string }[] };
    expect(packet.choices.some(row => row.id === "interpret_with_middle")).toBe(false);
    expect(packet.state["interpretationContext"]).toMatchObject({ selectedRoute: "interpret_with_middle", fromModelId: decisionModelId,
      priorEffect: "none_from_selection", choiceCoverage: "complete_original_menu_restored" });
    return { content: "defer_to_genie", usage_metadata: { input_tokens: 10, output_tokens: 1 } };
  } }), undefined, async input => {
    expect(input.choices.map(row => row.id)).toEqual(["reobserve", "defer_to_genie", "interpret_with_middle"]);
    expect(JSON.stringify(input)).not.toContain("data:image");
    expect(input.state).toMatchObject({ request: "Inspect the unusual dialog", visualEvidenceAvailable: true });
    expect(input.state).toMatchObject({ decisionRoles: { interpreter: { suppliedImages: 1 } } });
    return selectedChoice(input, "interpret_with_middle");
  });
  expect(middleCalls).toBe(1);
  expect(result.decision.kind).toBe("genie");
  expect(result.modelCalls).toBe(2);
  expect(result.modelUsage?.map(row => [row.modelId, row.modelCalls])).toEqual([[decisionModelId, 1], [modelId, 1]]);
  expect(result.usage).toMatchObject({ inputTokens: 17, outputTokens: 2, actualCostUsd: null, cacheReadTokens: null });
});

test("rejected or failed classifier choices never fall through to Flash and preserve usage uncertainty", async () => {
  for (const failed of [false, true]) {
    const progress: unknown[] = [];
    const pending = invokeNativeExecution({ modelId, decisionModelId: "openrouter:typesafe/jev-1.13", signal,
      capabilities: [], roots: { request: "Inspect", values: {}, observation: null }, state: {}, onProgress: value => progress.push(value),
    }, async () => { throw new Error("must not initialize Flash"); }, undefined, async input => {
      if (failed) throw new Error("synthetic transport failure");
      return selectedChoice(input, "I think you should click this");
    });
    expect((await Promise.allSettled([pending]))[0].status).toBe("rejected");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ modelCalls: 1, usage: { inputTokens: failed ? null : 7, actualCostUsd: failed ? null : 0.01 } });
  }
});

test("production selection refreshes retained state through ordinary admission without a Genie turn", async () => {
  const current = await entered("Inspect the current editor again");
  const readArguments = { operation: "window_state", target };
  current.nativeDecision!.execution!.lastRead = { tool: "computer_observe", arguments: readArguments };
  current.nativeDecision!.execution!.observation = { target, evidence: { windowLabel: "Editor" } };
  let calls = 0;
  const model: ChatModel = { invoke: messages => {
    calls++;
    expect(JSON.stringify(messages)).not.toContain(target.reference);
    return Promise.resolve({ content: "reobserve", usage_metadata: { input_tokens: 20, output_tokens: 1 } });
  } };
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: input => invokeThroughMiddle(input, () => Promise.resolve(model)),
  })(current, config);
  expect(calls).toBe(1);
  expect(next.nativeDecision?.phase).toBe("waiting");
  const pending = next.nativeDecision!.pending!;
  expect(pending.name).toBe("computer_observe");
  expect(pending.args).toEqual(readArguments);
  expect(nativeDecisionDispatchError({ ...current, ...next }, pending)).toBeNull();
  expect(next.messages?.some(message => message.additional_kwargs["nautilo_native_decision_handoff"])).toBe(false);
});

test("production node admits one-ID complete actions and still fences changed sources", async () => {
  for (const changeSources of [false, true]) {
    const current = await entered("Click Export");
    current.nativeDecision!.execution!.observation = { controls: [{ label: "Export", target: element }] };
    current.nativeDecision!.execution!.freshRead = true;
    let calls = 0;
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
      interpretNative: input => invokeThroughMiddle(input, () => Promise.resolve({ invoke: messages => {
        calls++;
        const content = (messages[1] as BaseMessage).content as { type: string; text: string }[];
        const request = JSON.parse(content[0]!.text) as { choices: { id: string; description: string }[];
          state: { actionTemplates: { id: string; tool: string; arguments: unknown }[]; bindingSources: Record<string, string> } };
        const choice = request.choices.find(row => {
          if (!row.description.startsWith("{")) return false;
          const { action, ...inputs } = JSON.parse(row.description) as Record<string, string>;
          const template = request.state.actionTemplates.find(item => item.id === action);
          return template?.tool === "computer_do" && JSON.stringify(template.arguments).includes('"click"')
            && Object.values(inputs).some(id => request.state.bindingSources[id]?.includes("Export"));
        });
        expect(choice).toBeDefined();
        expect(JSON.stringify(messages)).not.toContain(element.reference);
        if (changeSources) input.roots!.observation = { controls: [] };
        return Promise.resolve({ content: choice!.id, usage_metadata: { input_tokens: 20, output_tokens: 1 } });
      } })),
    })(current, config);
    expect(calls).toBe(1);
    if (changeSources) {
      expect(next.nativeDecision?.pending).toBeNull();
      expect(next.nativeDecision?.reason).toBe("execution_sources_changed");
    } else {
      expect(next.nativeDecision?.phase).toBe("waiting");
      const call = next.nativeDecision!.pending!;
      expect(call.args).toEqual({ operation: { kind: "click", target: element } });
      expect(nativeDecisionDispatchError({ ...current, ...next }, call)).toBeNull();
      expect(next.messages?.some(message => message.additional_kwargs["nautilo_native_decision_handoff"])).toBe(false);
    }
  }
});

test("a late cancelled refresh selection retains effects and cannot dispatch", async () => {
  const current = await entered();
  current.nativeDecision!.execution!.lastRead = { tool: "computer_observe", arguments: { operation: "window_state", target } };
  const controller = new AbortController();
  const before = structuredClone(current.nativeDecision!.history);
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    interpretNative: input => invokeThroughMiddle(input, () => Promise.resolve({ invoke: () => {
      controller.abort();
      return Promise.resolve({ content: "reobserve", usage_metadata: { input_tokens: 20, output_tokens: 1 } });
    } })),
  })(current, { signal: controller.signal });
  expect(next.nativeDecision?.pending).toBeNull();
  expect(next.nativeDecision?.reason).toBe("run_cancelled");
  expect(next.nativeDecision?.history).toEqual(before);
  expect(next.nativeDecision?.unresolved).toEqual(current.nativeDecision!.unresolved);
});

test("failed selection calls preserve measured usage and mark missing accounting unknown", async () => {
  for (const hasResponse of [true, false]) {
    const progress: unknown[] = [];
    const input: NativeExecutionInput = { modelId, signal,
      capabilities: [{ name: "computer_observe", description: "Inspect", effectClass: "read", schema: { type: "object" } }],
      roots: { request: "Inspect", values: {}, observation: null }, state: {}, onProgress: value => progress.push(value) };
    const model: ChatModel = { invoke: () => hasResponse
      ? Promise.resolve({ content: "invented_id", usage_metadata: { input_tokens: 12, output_tokens: 2 } })
      : Promise.reject(new Error("transport failed without usage")) };
    const failure: unknown = await invokeNativeExecution(input, () => Promise.resolve(model)).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const usage = { inputTokens: hasResponse ? 12 : null, outputTokens: hasResponse ? 2 : null,
      cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null };
    expect(progress).toMatchObject([{ modelCalls: 1, usage, modelUsage: [{ modelId, modelCalls: 1, usage,
      attempts: [{ stage: "operation", route: "interpreter", candidateCount: 3,
        imageBytes: 0, outcome: hasResponse ? "returned" : "failed" }],
    }] }]);
    const attempt = (progress[0] as { modelUsage: { attempts: { textBytes: number; elapsedMs: number }[] }[] }).modelUsage[0]!.attempts[0]!;
    expect(attempt.textBytes).toBeGreaterThan(0);
    expect(attempt.elapsedMs).toBeGreaterThanOrEqual(0);
  }
});

test("multi-input production adapter gates typed questions and attributes each model's usage", async () => {
  for (const mode of ["typed", "ordinary", "unsupported", "failed"] as const) {
    const decisionModelId = "openrouter:typesafe/jev-1.13";
    if (mode === "unsupported") {
      const catalog = structuredClone(getActiveModelCatalogSync().catalog);
      const entry = catalog.entries.find(row => row.id === decisionModelId)!;
      if (!("workload" in entry) || entry.workload !== "decision") throw new Error("expected decision model");
      if (!entry.decision) throw new Error("expected decision capabilities");
      Object.assign(entry.decision, { supportsMultipleQuestions: false });
      configureRuntimeModelCatalog({ loader: { get: async () => ({ catalog, source: "remote-fresh", stale: false,
        fetchedAt: "2026-09-23T00:00:00.000Z", originUrl: "https://catalog.invalid/test.json", reason: "", catalogVersion: catalog.catalogVersion }),
        refresh: async () => {}, clearCache: () => {} } });
      await hydrateRuntimeModelCatalog();
    }
    const roots = { request: "Set supplied first and second", values: { first: "Keep 🌊", second: "Exact\r\ninput" }, observation: null };
    const progress: { modelCalls: number; modelUsage: unknown[]; usage: unknown }[] = [];
    let batches = 0;
    const pending = invokeNativeExecution({ modelId, ...(mode === "ordinary" ? {} : { decisionModelId }), signal,
      roots, state: {}, onProgress: value => progress.push(value), capabilities: [{ name: "synthetic_pair", effectClass: "write", description: "Pair",
        schema: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } }, required: ["first", "second"], additionalProperties: false } }],
    }, async () => ({ invoke: async messages => {
      const content = (messages[1] as BaseMessage).content as { text: string }[];
      const request = JSON.parse(content[0]!.text) as { state: { field?: string }; choices: { id: string; description: string }[] };
      const choice = request.choices.find(row => row.description.includes(request.state.field ? `supplied ${request.state.field.split(".").at(-1)}` : "synthetic_pair:"))!;
      return { content: choice.id, usage_metadata: { input_tokens: 10, output_tokens: 1 } };
    } }), async input => {
      batches++;
      if (mode === "failed") throw new Error("synthetic provider failure");
      const sources = (input.state as { bindingSources: Record<string, string> }).bindingSources;
      return { requestedModelId: decisionModelId, resolvedModelId: decisionModelId, usage: { inputTokens: 7, outputTokens: 2, actualCostUsd: 0.01 },
        answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
          if (question.type !== "choice") throw new Error("expected choice");
          if (typeof question.instructions !== "string") throw new Error("expected text instructions");
          const field = question.instructions.includes(".first ") ? "first" : "second";
          const choice = Object.keys(question.criteria).find(key => key.startsWith("input_")
            && Object.values((JSON.parse(question.criteria[key] as string) as { bindings: Record<string, string> }).bindings).some(source => sources[source] === `supplied ${field}`))!;
          return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
        })) };
    }, async input => {
      const field = (input.state as { field?: string }).field?.split(".").at(-1);
      const selected = input.choices.find(row => row.description.includes(field ? `supplied ${field}` : "synthetic_pair:"));
      expect(selected).toBeDefined();
      return selectedChoice(input, selected!.id);
    });
    if (mode === "failed") {
      expect((await Promise.allSettled([pending]))[0].status).toBe("rejected");
      expect(progress.at(-1)).toMatchObject({ modelCalls: 2, usage: { inputTokens: null, actualCostUsd: null },
        modelUsage: [{ modelId: decisionModelId, modelCalls: 2, usage: { inputTokens: null } }] });
    } else {
      const result = await pending;
      if (result.decision.kind !== "call") throw new Error("expected call");
      expect(bindNativeExecutionValue(result.decision.arguments, roots)).toEqual(roots.values);
      expect(result.modelCalls).toBe(mode === "typed" ? 2 : 3);
      expect(result.modelUsage?.map(row => [row.modelId, row.modelCalls])).toEqual(mode === "typed" || mode === "unsupported"
        ? [[decisionModelId, mode === "typed" ? 2 : 3]] : [[modelId, 3]]);
      expect(result.usage.inputTokens).toBe(mode === "typed" ? 14 : mode === "unsupported" ? 21 : 30);
    }
    expect(batches).toBe(mode === "typed" || mode === "failed" ? 1 : 0);
    configureRuntimeModelCatalog({ catalogPointerUrl: null });
  }
});

test("raw copied inputs, forged tools and late cancellation do not dispatch", async () => {
  for (const mode of ["copied", "tool", "cancel"] as const) {
    const current = await entered();
    const controller = new AbortController();
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: async () => {
      if (mode === "cancel") controller.abort();
      return response({ kind: "call", tool: mode === "tool" ? "run_shell" : "computer_do", arguments: { operation: { kind: "launch_app", app: { name: "Sketchpad" } } } });
    } })(current, { signal: controller.signal });
    expect(next.nativeDecision?.phase).toBe("handoff"); expect(next.nativeDecision?.pending).toBeNull();
    expect(next.nativeDecision?.reason).toBe(mode === "copied" ? "execution_unbound_input" : mode === "tool" ? "execution_tool_not_exposed" : "run_cancelled");
    const telemetry = next.messages?.find(message => message.additional_kwargs["nautilo_native_decision"])?.additional_kwargs["nautilo_native_decision"];
    expect(telemetry).toMatchObject({ role: "execution", operation: "call", usage: { inputTokens: 20, outputTokens: 5 } });
  }
});

test("provider failures retain classified attempt telemetry without raw errors or a desktop proposal", async () => {
  for (const [status, category] of [[429, "RATE_LIMIT"], [401, "AUTH_ERROR"], [503, "SERVICE_ERROR"]] as const) {
    const current = await entered();
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, interpretNative: () => {
      const error = Object.assign(new Error("synthetic-private-provider-detail"), { status });
      return Promise.reject(error);
    } })(current, config);
    expect(next.nativeDecision?.phase).toBe("handoff");
    expect(next.nativeDecision?.pending).toBeNull();
    expect(next.nativeDecision?.reason).toBe(`execution_provider_${category.toLowerCase()}`);
    const telemetry = next.messages?.find(message => message.additional_kwargs["nautilo_native_decision"])?.additional_kwargs["nautilo_native_decision"];
    expect(telemetry).toMatchObject({ role: "execution", operation: "error", modelId, errorCategory: category, usage: null });
    expect(JSON.stringify(next)).not.toContain("synthetic-private-provider-detail");
  }
});
