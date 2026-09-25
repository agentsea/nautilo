import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { z } from "zod";
import { COMPUTER_USE_NATIVE_CONTRACTS, windowStateObservationSchema } from "@nautilo/computer-use-contracts/native";
import type { NautiloState } from "../../src/agent/state";
import { shouldContinueAfterTools } from "../../src/agent/graph";
import { nativeDecisionPlanSchema, nativeDecisionHostArguments } from "../../src/graph/native-decision-plan";
import { nativeDecisionCandidates, nativeDecisionDispatchError, nativeDecisionEvidence, nativeDecisionResult, projectNativeDecisionScreen, projectNativeDecisionMenu, settleNativeDecision, type NativeDecisionState } from "../../src/graph/native-decision";
import { createNativeDecisionNode } from "../../src/nodes/native-decision";
import { resolveNativeDecisionModel } from "../../src/config/native-decision-model";
import { createComputerHostContractTool } from "../../src/tools/computer/computer-host-contract";
import { computerResultDurableSidecar, projectSemanticComputerResult } from "../../src/tools/computer/model-result-projector";
import { resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog, getActiveModelCatalogSync, hydrateRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { chooseBrowserAction } from "../../src/graph/browser-choice";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../../src/providers/choice";
import { withComputerUseContractSelection } from "../../src/config/computer-use-catalogue/selection";
import { bundledComputerUseContractCatalogue } from "../../src/config/computer-use-catalogue/catalog";

const modelId = "openrouter:typesafe/jev-1.13";
const context = `dctx_${"a".repeat(43)}`;
const target = { version: 1 as const, context, reference: `dtgt_${"b".repeat(43)}` };
const readOutcome = { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable", providerCondition: "ready", targetCondition: "current", recovery: [] };
function observation(count = 2, generation = 1) {
  return windowStateObservationSchema.parse({
    version: 1, operation: "window_state", target, evidence: { kind: "window", appLabel: "Fixture", windowLabel: "Draft" },
    completeness: "partial", degraded: false, verification: "indeterminate", outcome: readOutcome,
    controlCollection: { completeness: "partial", received: count, omitted: 0,
      controls: Array.from({ length: count }, (_, index) => ({ id: `c${index}`, role: index ? "slider" : "text_area", label: `Control ${index}`,
        target: { version: 1, context, reference: `detgt_${`${generation}_${index}`.padEnd(43, "x")}` },
        state: { completeness: "partial", value: "0" },
      })),
    },
  });
}
function decision(overrides: Partial<NativeDecisionState> = {}): NativeDecisionState {
  return { turnId: "turn-1", modelId, plan: nativeDecisionPlanSchema.parse({ goal: "Set the requested control to exactly 42", values: { amount: "42" } }),
    phase: "decide", observeArgs: { operation: "window_state", target }, observation: observation(), generation: 1,
    pending: null, reason: null, history: [], unresolved: [], recovery: { limit: 3, events: 0, transitions: [], before: null }, ...overrides };
}
function state(nativeDecision: NativeDecisionState | null, messages: NautiloState["messages"] = []): NautiloState {
  return { turnId: "turn-1", userId: "human-fixture", roomId: "room-fixture", agentId: "genie-fixture", messages,
    approvedToolCalls: [], nativeDecision } as unknown as NautiloState;
}
function result(call: ToolCall, payload: unknown, settlement = "completed") {
  const raw = JSON.stringify({ kind: "result", protocol: { major: 3, minor: 0 }, requestId: call.id,
    fence: { hostGeneration: "host-fixture", driverGeneration: "driver-fixture", cancellationGeneration: 1 },
    contract: call.name === "computer_observe" ? COMPUTER_USE_NATIVE_CONTRACTS.observe : COMPUTER_USE_NATIVE_CONTRACTS.do,
    settlement, result: payload });
  return new ToolMessage({ name: call.name, tool_call_id: call.id!, content: projectSemanticComputerResult(call.name, raw),
    additional_kwargs: { ...computerResultDurableSidecar(call.name, raw), nautilo_tool_status: settlement === "completed" ? "success" : "error" } });
}
function answer(input: ChoiceInput, selectedId: string): ChoiceResult {
  return { selectedId, requestedModelId: input.modelId, resolvedModelId: input.modelId,
    usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 0 } } as ChoiceResult;
}
function controlAnswer(input: ChoiceInput, selectedId: string) {
  return { selectedId, requestedModelId: input.modelId, usage: { inputTokens: 1, outputTokens: 1,
    cacheReadTokens: null, cacheWriteTokens: null, actualCostUsd: null } };
}

test("native menu commands are bound from complete ancestry without removing generic controls or replay fences", () => {
  const d = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Create a document", actions: [
    { purpose: "Create", target: "each_control", operation: { kind: "click" } },
  ] }) });
  const controls = [
    { id: "bar", role: "menu_bar", label: "" },
    { id: "file", parent: "bar", role: "menu_bar_item", label: "File" },
    { id: "submenu", parent: "file", role: "menu", label: "" },
    { id: "command", parent: "submenu", role: "menu_item", label: "New Document" },
  ].map((row, i) => ({ ...row, target: { ...target, reference: `detgt_${String(i).padEnd(43, "x")}` },
    state: { completeness: "partial" as const } }));
  d.observation!.controlCollection = { completeness: "partial", received: controls.length, omitted: 0, controls };
  const choices = nativeDecisionCandidates(d);
  const typed = choices.find(row => (row.call?.args["operation"] as { kind?: string })?.kind === "invoke_menu")!;
  const clicked = choices.find(row => row.controlId === "command" && (row.call?.args["operation"] as { kind?: string })?.kind === "click")!;
  expect(typed.call?.args).toEqual({ operation: { kind: "invoke_menu", target, menuPath: ["File", "New Document"] } });
  expect(clicked).toBeDefined();
  expect(typed.replayKey).toBe(clicked.replayKey);
  d.unresolved = [{ callId: "uncertain", operation: clicked.call!.args["operation"], receipt: {}, replayKey: clicked.replayKey! }];
  expect(nativeDecisionCandidates(d).some(row => row.controlId === "command")).toBe(false);
  d.unresolved = [];
  controls[1]!.parent = "missing";
  expect(nativeDecisionCandidates(d).some(row => (row.call?.args["operation"] as { kind?: string })?.kind === "invoke_menu")).toBe(false);
});
function boundChoice(input: ChoiceInput, kind: string, control: string) {
  const templates = (input.state as { actionTemplates: Array<{ id: string; operation: { kind: string } }> }).actionTemplates;
  return input.choices.find(choice => {
    if (!choice.description.startsWith("{")) return false;
    const row = JSON.parse(choice.description) as { action: string; control: string };
    return row.control === control && templates.some(template => template.id === row.action && template.operation.kind === kind);
  })!.id;
}

test("factored menu preserves exact calls and per-group semantic evidence without repeated templates", () => {
  const segment = decision({ observation: observation(600), plan: nativeDecisionPlanSchema.parse({ goal: "Set control 599",
    values: { amount: "42" }, actions: [{ purpose: "Set supplied exact value", target: "each_control", operation: { kind: "set_value" } }] }) });
  const candidates = nativeDecisionCandidates(segment);
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "Choose",
    state: { observation: nativeDecisionEvidence(segment.observation!), suppliedValues: segment.plan.values },
    choices: candidates.map(({ id, description }) => ({ id, description })) };
  const projected = projectNativeDecisionMenu(input, segment, candidates);
  const data = projected.state as { actionTemplates: unknown[] };
  expect(data.actionTemplates).toHaveLength(1);
  expect(boundChoice(projected, "set_value", "c599")).toBe("a1_599");
  expect(candidates[599]!.call?.args).toMatchObject({ operation: { kind: "set_value", value: "42", target: segment.observation!.controlCollection!.controls[599]!.target } });
  expect(JSON.stringify(projected)).not.toContain("detgt_");
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)));
  const final = projectNativeDecisionMenu({ ...input, choices: [input.choices[599]!, ...input.choices.filter(row => row.id === "reobserve")] }, segment, candidates);
  expect(final.state).toMatchObject({ observation: { collection: { projection: { included: 1, omittedCandidateControls: 599 } } } });
  expect((final.state as typeof data).actionTemplates).toHaveLength(1);
});
let priorKey: string | undefined;
beforeEach(() => {
  priorKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENROUTER_API_KEY"] = "synthetic-native-choice";
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
});
afterEach(() => {
  if (priorKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = priorKey;
  resetRuntimeModelCatalog();
});

test("delegation is optional on the same observation tool and absent without a runnable key or egress", () => {
  const schema = (fullEncryptionOnly: boolean) => JSON.stringify(createComputerHostContractTool("computer_observe", { turnId: "turn-1", fullEncryptionOnly }).schema);
  expect(schema(false)).toContain('"decisionPlan"');
  expect(schema(true)).not.toContain('"decisionPlan"');
  delete process.env["OPENROUTER_API_KEY"];
  expect(schema(false)).not.toContain('"decisionPlan"');
  expect(resolveComputerUseHostToolRequest("computer_observe", { operation: "window_state", target })).not.toBeNull();
});

test("workflow schema remains exposed with eligible Choice and unavailable Middle", async () => {
  const catalog = structuredClone(getActiveModelCatalogSync().catalog);
  for (const entry of catalog.entries) if (entry.id === "openrouter:deepseek/deepseek-v4.1-flash") entry.defaultEnabled = false;
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false, fetchedAt: "2026-09-25T00:00:00.000Z",
      originUrl: "https://catalog.invalid/native-test.json", reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
  expect(resolveNativeDecisionModel({ turnId: "turn-1", fullEncryptionOnly: false })?.id).toBe(modelId);
  const schema = JSON.stringify(createComputerHostContractTool("computer_observe", { turnId: "turn-1", fullEncryptionOnly: false }).schema);
  expect(schema).toContain('"decisionPlan"');
  expect(schema).toContain('"workflow"');
  expect(createComputerHostContractTool("computer_observe", { turnId: "turn-1", fullEncryptionOnly: false }).description)
    .toContain("interpreter is optional");
});

test("plan stays server-side while the signed Host argument schema remains authoritative", () => {
  const args = { operation: "window_state", target, decisionPlan: { goal: "Adjust the control" } };
  expect(nativeDecisionHostArguments("computer_observe", args)).toEqual({ operation: "window_state", target });
  expect(resolveComputerUseHostToolRequest("computer_observe", args)?.arguments).toEqual({ operation: "window_state", target });
  for (const invalid of [{ ...args, surprise: true }, { ...args, selector: { role: "slider" } }, { ...args, decisionPlan: { goal: "" } }]) {
    expect(resolveComputerUseHostToolRequest("computer_observe", invalid)).toBeNull();
  }
});

test("a runnable Jev key does not expose native delegation to a baseline Host", () => {
  const contracts = bundledComputerUseContractCatalogue.contracts.filter(entry => entry.legacyDefault).map(entry => entry.descriptor);
  withComputerUseContractSelection(contracts, () => {
    expect(JSON.stringify(createComputerHostContractTool("computer_observe", { turnId: "turn-1" }).schema)).not.toContain('"decisionPlan"');
    expect(resolveComputerUseHostToolRequest("computer_observe", { operation: "window_state", target })?.contract.contractVersion).toBe(9);
  });
});

test("starts only from a paired singleton checked Host observation, then routes to native decisions", () => {
  const call = { id: "observe-1", name: "computer_observe", args: { operation: "window_state", target, decisionPlan: { goal: "Adjust the control" } } };
  const initial = state(null, [new AIMessage({ content: "", tool_calls: [call] })]);
  const receipt = result(call, observation());
  expect(nativeDecisionResult(receipt)).not.toBeNull();
  const next = settleNativeDecision(initial, [call], [receipt], [], modelId);
  expect(next?.phase).toBe("decide");
  expect(shouldContinueAfterTools({ ...initial, nativeDecision: next })).toBe("native_decision");
  expect(settleNativeDecision(initial, [call], [receipt], [], "")).toBeNull();
  const forged = new ToolMessage({ content: receipt.content, name: call.name, tool_call_id: call.id });
  expect(settleNativeDecision(initial, [call], [forged], [], modelId)?.reason).toBe("checked_host_result_unavailable");
  expect(settleNativeDecision(initial, [call], [receipt], [call], modelId)).toBeNull();
});

test("checked observation target identity ignores all object key permutations, not changed fields", () => {
  const keys = ["version", "context", "reference"];
  const permutations = keys.flatMap(first => keys.filter(key => key !== first).map(second =>
    [first, second, ...keys.filter(key => key !== first && key !== second)]));
  const settle = (requested: unknown) => {
    const call = { id: "observe-order", name: "computer_observe", args: {
      operation: "window_state", target: requested, decisionPlan: { goal: "Inspect controls" },
    } };
    return settleNativeDecision(state(null, [new AIMessage({ content: "", tool_calls: [call] })]),
      [call], [result(call, observation())], [], modelId);
  };
  for (const order of permutations) {
    expect(settle(Object.fromEntries(order.map(key => [key, target[key as keyof typeof target]])))?.phase).toBe("decide");
  }
  for (const changed of [
    { ...target, version: 2 }, { ...target, context: `dctx_${"z".repeat(43)}` },
    { ...target, reference: `dtgt_${"z".repeat(43)}` }, { ...target, extra: true },
    { version: 1, context }, null,
  ]) expect(settle(changed)?.phase).not.toBe("decide");
});

test("dispatch and settlement preserve structured identity through reordered pending and control fields", () => {
  const segment = decision();
  const candidate = nativeDecisionCandidates(segment).find(entry => entry.description.includes('"type_text"'))!;
  const call = { ...candidate.call!, id: "insert-order" };
  const operation = call.args["operation"] as Record<string, unknown>;
  const controlTarget = operation["target"] as Record<string, unknown>;
  const reordered = { ...call, args: { operation: {
    target: Object.fromEntries(Object.entries(controlTarget).reverse()), text: operation["text"], kind: "type_text",
  } } };
  const waiting = state({ ...segment, phase: "waiting", pending: call }, [new AIMessage({ content: "", tool_calls: [reordered] })]);
  expect(nativeDecisionDispatchError(waiting, reordered)).toBeNull();
  for (const changed of [
    { ...operation, text: "42 " }, { ...operation, text: 42 },
    { ...operation, target }, { ...operation, extra: true }, { ...operation, text: undefined },
  ]) expect(nativeDecisionDispatchError(waiting, { ...call, args: { operation: changed } })).toBe("native_decision_proposal_changed");
  const settled = settleNativeDecision(waiting, [reordered],
    [result(reordered, { status: "host_rejected", reason: "host_failure" }, "unknown_completion")], [], modelId)!;
  expect(settled.phase).toBe("observe");
  expect(settled.history[0]!.evidence).toMatchObject({ source: { control: { id: candidate.controlId } } });
  expect(settled.unresolved[0]!.replayKey).toBe(candidate.replayKey!);
  expect(nativeDecisionCandidates({ ...settled, observation: observation(2, 2) })
    .some(entry => /type_text|set_value/.test(entry.description))).toBe(false);
});

test("replay identity ignores operation key order while dispatch preserves ordered key sequences", () => {
  const make = (operation: Record<string, unknown>) => decision({ plan: nativeDecisionPlanSchema.parse({
    goal: "Use the requested shortcut", actions: [{ purpose: "Shortcut", target: "window", operation }],
  }) });
  const first = make({ kind: "hotkey", keys: ["CMD", "a"] });
  const second = make({ keys: ["CMD", "a"], kind: "hotkey" });
  const selected = nativeDecisionCandidates(first).find(entry => entry.call?.name === "computer_do")!;
  expect(selected).toBeDefined();
  expect(nativeDecisionCandidates(second).find(entry => entry.call?.name === "computer_do")!.replayKey).toBe(selected.replayKey);
  const call = { ...selected.call!, id: "shortcut-order" };
  const operation = call.args["operation"] as Record<string, unknown>;
  expect(nativeDecisionDispatchError(state({ ...first, phase: "waiting", pending: call }),
    { ...call, args: { operation: { ...operation, keys: ["a", "CMD"] } } })).toBe("native_decision_proposal_changed");
  expect(nativeDecisionCandidates({ ...second, unresolved: [{ callId: call.id, operation, receipt: {}, replayKey: selected.replayKey! }] })
    .some(entry => entry.call?.name === "computer_do")).toBe(false);
  const { target: _target, ...legacyOperation } = operation;
  const legacyKey = createHash("sha256").update(JSON.stringify([legacyOperation, null])).digest("hex");
  expect(nativeDecisionCandidates({ ...second, unresolved: [{ callId: call.id, operation, receipt: {}, replayKey: legacyKey }] })
    .some(entry => entry.call?.name === "computer_do")).toBe(false);
});

test("legacy click checkpoints preserve lineage while permitting an unrelated recovery control", () => {
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Activate requested control", actions: [
    { purpose: "Activate", target: "each_control", operation: { kind: "click", deliveryMode: "background" } },
  ] }) });
  const row = segment.observation!.controlCollection!.controls[0]!;
  const operation = { kind: "click", target: row.target, deliveryMode: "background" };
  const legacyKey = createHash("sha256").update(JSON.stringify([{ kind: "click" }, [{ role: row.role, label: row.label }]])).digest("hex");
  const unresolved = [{ callId: "legacy-click", operation, receipt: {}, replayKey: legacyKey }];
  const choices = nativeDecisionCandidates({ ...segment, observation: observation(2, 2), unresolved });
  expect(choices.some(entry => entry.controlId === "c0")).toBe(false);
  expect(choices.some(entry => entry.controlId === "c1")).toBe(true);
});

test("600 choices retain all controls, use compact groups plus NONE, then compare nominees", async () => {
  const segment = decision({ observation: observation(300), plan: nativeDecisionPlanSchema.parse({ goal: "Set Control 287 to 42", actions: [
    { purpose: "Activate", target: "each_control", operation: { kind: "click" } },
    { purpose: "Set 42", target: "each_control", operation: { kind: "set_value", value: "42" } },
  ] }) });
  const candidates = nativeDecisionCandidates(segment);
  expect(candidates.filter((candidate) => candidate.call?.name === "computer_do")).toHaveLength(600);
  const wanted = candidates.find((candidate) => candidate.controlId === "c287" && candidate.description.includes('"set_value"'))!;
  let groups = 0;
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "Select the exact control", state: { observation: nativeDecisionEvidence(segment.observation!) }, choices: candidates.map(({ id, description }) => ({ id, description })) };
  const chosen = await chooseBrowserAction(input, 255, async (request) => {
    const projected = projectNativeDecisionScreen(request, segment, candidates);
    expect(projected.choices.length).toBeLessThanOrEqual(255);
    expect(JSON.stringify(projected.state)).not.toContain("detgt_");
    if (request.choices.some((choice) => choice.id === "none_in_group")) {
      groups++;
      expect(JSON.stringify(projected.state).length).toBeLessThan(JSON.stringify(input.state).length);
      return answer(request, request.choices.some((choice) => choice.id === wanted.id) ? wanted.id : "none_in_group");
    }
    expect(projected.state).toMatchObject({ observation: { collection: { projection: { kind: "finalists" } } } });
    expect(JSON.stringify(projected.state).length).toBeLessThan(JSON.stringify(input.state).length);
    return answer(request, wanted.id);
  }, { controlIds: candidates.filter(candidate => candidate.call === null || candidate.id === "reobserve").map(candidate => candidate.id) });
  expect(groups).toBe(3);
  expect(chosen.selectedId).toBe(wanted.id);
});

test("production node proposes an exact ordinary action, preserving usage and admission", async () => {
  const segment = decision();
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (request) => {
    expect(z.json().safeParse(request.state).success).toBe(true);
    expect(JSON.stringify(request.state)).not.toContain("detgt_");
    return answer(request, boundChoice(request, "set_value", "c1"));
  } })(state(segment), { signal: new AbortController().signal });
  const pending = next.nativeDecision!.pending!;
  expect(pending.name).toBe("computer_do");
  expect(pending.args).toEqual({ operation: { kind: "set_value", value: "42", target: segment.observation!.controlCollection!.controls[1]!.target } });
  expect(nativeDecisionDispatchError({ ...state(segment), ...next }, pending)).toBeNull();
  expect(nativeDecisionDispatchError({ ...state(segment), ...next }, { ...pending, args: { operation: { kind: "launch_app", app: { name: "Another App" } } } })).toBe("native_decision_proposal_changed");
  expect(next.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({ choiceCalls: 1, usage: { inputTokens: 1 } });
});

test("selector and controller share evidence-first recovery instructions without removing actions or escapes", async () => {
  for (const controller of [false, true]) {
    const segment = decision({ ...(controller ? { controller: { modelId: "openrouter:deepseek/deepseek-v4.1-flash", active: true, attemptedGeneration: 1 } } : {}) });
    const select = async (input: ChoiceInput) => {
      expect(input.instructions).toContain("Do not route ordinary chat or author content");
      expect(input.instructions).toContain("before selecting another action");
      expect(input.instructions).toContain("supersede an earlier refusal");
      expect(input.instructions).toContain("indistinguishable controls");
      expect(input.instructions).toContain("An empty document is not a completed composition request");
      expect(input.instructions).toContain("routine enabling action");
      expect(input.instructions).toContain("consent/security dialogs");
      expect(input.choices.map(choice => choice.id)).toEqual(nativeDecisionCandidates(segment).map(choice => choice.id));
      return answer(input, "needs_input");
    };
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: select,
      control: async input => { const result = await select(input); return controlAnswer(input, result.selectedId); },
    })(state(segment), { signal: new AbortController().signal });
    expect(next.nativeDecision).toMatchObject({ phase: "handoff", reason: "needs_input", pending: null });
  }
});

test("large native evidence fits the final comparison as well as every screening group", async () => {
  const observed = observation(469);
  for (const row of observed.controlCollection!.controls) row.state.value = "Synthetic contextual value. ".repeat(20);
  observed.controlCollection!.controls[0]!.enabled = false;
  observed.controlCollection!.controls[0]!.label = "Global warning: preserve the existing document";
  const segment = decision({ observation: observed, plan: nativeDecisionPlanSchema.parse({
    goal: "Insert the supplied text into Control 468", values: { text: "Original supplied text" },
    actions: [{ purpose: "Insert", target: "each_control", operation: { kind: "type_text" } }],
  }) });
  const candidates = nativeDecisionCandidates(segment);
  const wanted = candidates.find(candidate => candidate.controlId === "c468")!;
  const covered = new Set<string>();
  const fullBytes = JSON.stringify(nativeDecisionEvidence(observed)).length;
  let finals = 0;
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async input => {
    // Simulate a provider whose context fits either screen, not the full collection.
    if (JSON.stringify(input.state).length > fullBytes * 0.8) throw new ChoiceRequestError("context_length_exceeded");
    const rows = (input.state as { observation: { collection: { controls: Array<{ id: string; label: string }> } } }).observation.collection.controls;
    expect(rows.some(row => row.label.startsWith("Global warning"))).toBe(true);
    if (input.choices.some(choice => choice.id === "none_in_group")) {
      for (const choice of input.choices) if (choice.id !== "none_in_group") covered.add(choice.id);
      return answer(input, input.choices.some(choice => choice.id === wanted.id) ? wanted.id : input.choices[0]!.id);
    }
    finals++;
    expect(rows.some(row => row.id === "c468")).toBe(true);
    expect(input.choices.some(choice => choice.id === "request_replan")).toBe(true);
    return answer(input, wanted.id);
  } })(state(segment), { signal: new AbortController().signal });
  expect(covered.size).toBe(468);
  expect(finals).toBe(1);
  expect(next.nativeDecision?.pending?.args).toEqual(wanted.call!.args);
  expect(next.nativeDecision?.observation).toEqual(observed);
});

test("classifier handoff checkpoints the same plan and effects; controller rebuild returns mechanically", async () => {
  const segment = decision({ history: [{ action: "launch", settlement: "completed", evidence: { ready: true } }],
    unresolved: [{ callId: "earlier", operation: { kind: "key" }, receipt: { settlement: "unknown_completion" }, replayKey: "other_effect" }] });
  const signal = new AbortController().signal;
  let controllerCalls = 0;
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    choose: async input => answer(input, "defer_to_genie"),
    control: async input => { controllerCalls++; return controlAnswer(input, "rebuild_choices"); },
  });
  const handed = await node(state(segment), { signal });
  expect(handed.nativeDecision?.phase).toBe("decide");
  expect(handed.nativeDecision?.pending).toBeNull();
  expect(handed.nativeDecision?.controller?.active).toBe(true);
  expect(handed.nativeDecision?.plan).toBe(segment.plan);
  expect(handed.nativeDecision?.history).toBe(segment.history);
  expect(handed.nativeDecision?.unresolved).toBe(segment.unresolved);
  const rebuilt = await node({ ...state(segment), ...handed }, { signal });
  const pending = rebuilt.nativeDecision!.pending!;
  expect(pending.name).toBe("computer_observe");
  expect(nativeDecisionDispatchError({ ...state(segment), ...rebuilt }, pending)).toBeNull();
  const fresh = settleNativeDecision({ ...state(segment), ...rebuilt }, [pending], [result(pending, observation(2, 2))], [], modelId)!;
  expect(fresh.controller?.active).toBe(false);
  expect(fresh.history).toMatchObject(segment.history);
  expect(fresh.history).toHaveLength(1);
  expect(fresh.unresolved).toEqual(segment.unresolved);
  expect(controllerCalls).toBe(1);
  expect(shouldContinueAfterTools(state(fresh))).toBe("native_decision");
});

test("exhausted classifier context gives the eligible controller the same bindings once", async () => {
  const value = "Keep this exact 🐙 input\nincluding newlines.";
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Insert the supplied value", values: { text: value } }),
    history: [{ action: "earlier input", settlement: "completed", evidence: { confirmed: true } }],
    unresolved: [{ callId: "earlier", operation: { kind: "key" }, receipt: { settlement: "unknown_completion" }, replayKey: "unrelated_effect" }],
  });
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    choose: async () => { throw new ChoiceRequestError("context_length_exceeded"); },
    control: async input => controlAnswer(input, boundChoice(input, "type_text", "c0")),
  });
  const config = { signal: new AbortController().signal };
  const routed = await node(state(segment), config);
  expect(routed.nativeDecision?.phase).toBe("decide");
  expect(routed.nativeDecision?.controller?.active).toBe(true);
  expect(routed.nativeDecision?.plan).toBe(segment.plan);
  expect(routed.nativeDecision?.history).toBe(segment.history);
  expect(routed.nativeDecision?.unresolved).toBe(segment.unresolved);
  expect(routed.messages?.at(-1)?.additional_kwargs["nautilo_native_decision"]).toMatchObject({
    operation: "controller_transition", reason: "choice_context_length_exceeded",
  });
  const next = await node({ ...state(segment), ...routed }, config);
  expect(next.nativeDecision?.pending?.args["operation"]).toMatchObject({ kind: "type_text", text: value });
  // A failed controller or a selector return cannot loop on unchanged evidence.
  const retried = await node(state({ ...routed.nativeDecision!, controller: { ...routed.nativeDecision!.controller!, active: false } }), config);
  expect(retried.nativeDecision?.phase).toBe("handoff");
  expect(retried.nativeDecision?.reason).toBe("choice_context_length_exceeded");
});

test("classifier errors do not bypass cancellation, egress, intervention or model eligibility", async () => {
  for (const mode of ["cancel", "egress", "intervention", "model_removed", "invalid_response"] as const) {
    const controller = new AbortController();
    let controllerCalls = 0;
    const current = state(decision(mode === "model_removed" ? {
      controller: { modelId: "openrouter:removed/controller", attemptedGeneration: 0, active: false },
    } : {}));
    if (mode === "intervention") current.approvalDenied = true;
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => mode === "egress",
      choose: async () => {
        if (mode === "cancel") controller.abort();
        throw new ChoiceRequestError(mode === "invalid_response" ? "invalid_response" : "context_length_exceeded");
      },
      control: async input => { controllerCalls++; return controlAnswer(input, "completion_ready"); },
    })(current, { signal: controller.signal });
    expect(next.nativeDecision?.phase).toBe("handoff");
    expect(next.nativeDecision?.pending).toBeNull();
    expect(next.nativeDecision?.controller?.active ?? false).toBe(false);
    expect(controllerCalls).toBe(0);
  }
});

test("a controller-only checkpoint cannot bypass the required Choice model", async () => {
  const value = "Original 🐙\nDo not rewrite me.";
  const segment = decision({ modelId: "openrouter:deepseek/deepseek-v4.1-flash", plan: nativeDecisionPlanSchema.parse({
    goal: "Insert the supplied content", values: { content: value }, actions: [{ purpose: "Insert", target: "each_control", operation: { kind: "type_text" } }],
  }) });
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    choose: async () => { throw new Error("must not call classifier"); },
    control: async () => { throw new Error("must not call controller without Choice eligibility"); },
  });
  const next = await node(state(segment), { signal: new AbortController().signal });
  expect(next.nativeDecision?.pending).toBeNull();
  expect(next.nativeDecision?.reason).toBe("decision_model_unavailable");
});

test("controller handback cannot ping-pong on the same observation", async () => {
  const segment = decision({ controller: { modelId: "openrouter:deepseek/deepseek-v4.1-flash", active: true, attemptedGeneration: 1 } });
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    choose: async input => answer(input, "defer_to_genie"),
    control: async input => controlAnswer(input, "return_to_selector"),
  });
  const config = { signal: new AbortController().signal };
  const handed = await node(state(segment), config);
  expect(handed.nativeDecision?.controller?.active).toBe(false);
  const next = await node({ ...state(segment), ...handed }, config);
  expect(next.nativeDecision?.phase).toBe("handoff");
  expect(next.nativeDecision?.reason).toBe("defer_to_genie");
});

test("controller replan preserves unknown effects and never proposes replay", async () => {
  const segment = decision({ controller: { modelId: "openrouter:deepseek/deepseek-v4.1-flash", active: true, attemptedGeneration: 1 } });
  const candidate = nativeDecisionCandidates(segment).find(candidate => candidate.description.includes('"type_text"'))!;
  segment.unresolved = [{ callId: "uncertain", operation: candidate.call!.args["operation"], receipt: { settlement: "unknown_completion" }, replayKey: candidate.replayKey! }];
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, control: async input => {
    expect(input.choices.some(choice => /type_text|set_value/.test(choice.description))).toBe(false);
    return controlAnswer(input, "request_replan");
  } })(state(segment), { signal: new AbortController().signal });
  expect(next.nativeDecision?.reason).toBe("request_replan");
  expect(next.nativeDecision?.unresolved).toEqual(segment.unresolved);
  expect(next.nativeDecision?.pending).toBeNull();
});

test("controller cancellation is fenced and retained-Middle removal continues through Choice without actions", async () => {
  const segment = decision({ controller: { modelId: "openrouter:deepseek/deepseek-v4.1-flash", active: true, attemptedGeneration: 1 } });
  const abort = new AbortController();
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, control: async input => {
    abort.abort(); return controlAnswer(input, input.choices[0]!.id);
  } });
  const cancelled = await node(state(segment), { signal: abort.signal });
  expect(cancelled.nativeDecision?.reason).toBe("run_cancelled");
  expect(cancelled.nativeDecision?.pending).toBeNull();
  let choiceCalls = 0;
  const withoutMiddle = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false,
    control: async () => { throw new Error("removed Middle must not run"); },
    choose: async input => { choiceCalls++; return answer(input, "defer_to_genie"); },
  });
  const unavailable = await withoutMiddle(state({ ...segment, controller: { ...segment.controller!, modelId: "openrouter:removed/controller" } }),
    { signal: new AbortController().signal });
  expect(choiceCalls).toBe(1);
  expect(unavailable.nativeDecision?.reason).toBe("defer_to_genie");
  expect(unavailable.nativeDecision?.pending).toBeNull();
  expect(unavailable.nativeDecision?.controller?.active).toBe(false);
});

test("ordinary Computer Use stays available but acceleration is absent without a Choice route", async () => {
  const catalog = structuredClone(getActiveModelCatalogSync().catalog);
  for (const entry of catalog.entries) if ("workload" in entry && entry.workload === "decision") entry.defaultEnabled = false;
  configureRuntimeModelCatalog({ loader: {
    get: async () => ({ catalog, source: "remote-fresh", stale: false, fetchedAt: "2026-09-20T00:00:00.000Z",
      originUrl: "https://catalog.invalid/native-test.json", reason: "", catalogVersion: catalog.catalogVersion }),
    refresh: async () => {}, clearCache: () => {},
  } });
  await hydrateRuntimeModelCatalog();
  const model = resolveNativeDecisionModel({ turnId: "turn-1", fullEncryptionOnly: false });
  expect(model).toBeNull();
  const tool = createComputerHostContractTool("computer_observe", { turnId: "turn-1", fullEncryptionOnly: false });
  expect(JSON.stringify(tool.schema)).not.toContain('"decisionPlan"');
  expect(JSON.stringify(tool.schema)).toContain('"window_state"');
  expect(resolveNativeDecisionModel({ turnId: "turn-1", fullEncryptionOnly: true })).toBeNull();
});

test("an explicit replacement plan does not offer insertion or duplicate the same operation", () => {
  const segment = decision({ observation: observation(320), plan: nativeDecisionPlanSchema.parse({
    goal: "Replace the requested value", values: { replacement: "42" }, actions: [
      { purpose: "Replace", target: "each_control", operation: { kind: "set_value", value: "42" } },
      { purpose: "Same replacement with a different label", target: "each_control", operation: { value: "42", kind: "set_value" } },
    ],
  }) });
  const mutations = nativeDecisionCandidates(segment).filter(candidate => candidate.call?.name === "computer_do");
  expect(mutations).toHaveLength(320);
  for (const candidate of mutations) expect(candidate.call!.args).toMatchObject({ operation: { kind: "set_value" } });
  expect(mutations.at(-1)!.controlId).toBe("c319");
});

test("explicit empty action scope stays read-only even when named values are supplied", () => {
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Inspect", values: { text: "42" }, actions: [] }) });
  expect(nativeDecisionCandidates(segment).filter(candidate => candidate.call?.name === "computer_do")).toHaveLength(0);
});

test("candidate dedup preserves distinct delivery modes and includes them in named-value descriptions", () => {
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Insert supplied text", values: { text: "42" }, actions: [
    { purpose: "Background insertion", target: "each_control", operation: { kind: "type_text", deliveryMode: "background" } },
    { purpose: "Foreground insertion", target: "each_control", operation: { kind: "type_text", deliveryMode: "foreground" } },
  ] }) });
  const mutations = nativeDecisionCandidates(segment).filter(candidate => candidate.call?.name === "computer_do");
  expect(mutations).toHaveLength(4);
  expect(mutations.map(candidate => (JSON.parse(candidate.description) as { operation: { deliveryMode: string } }).operation.deliveryMode)).toEqual(["background", "background", "foreground", "foreground"]);
});

test("an insertion template binds named values without inventing replacement or overriding exact text", () => {
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Insert supplied text", values: { text: "42" }, actions: [
    { purpose: "Insert supplied text", target: "each_control", operation: { kind: "type_text" } },
    { purpose: "Insert a literal", target: "each_control", operation: { kind: "type_text", text: "literal" } },
  ] }) });
  const mutations = nativeDecisionCandidates(segment).filter(candidate => candidate.call?.name === "computer_do");
  expect(mutations).toHaveLength(4);
  expect(mutations.map(candidate => (candidate.call!.args["operation"] as Record<string, unknown>)["text"])).toEqual(["42", "42", "literal", "literal"]);
  for (const candidate of mutations) expect(candidate.call!.args).toMatchObject({ operation: { kind: "type_text" } });
});

test("uncertain insertion cannot replay through fresh handles or replacement, but other recovery controls remain", async () => {
  const segment = decision();
  const insertion = nativeDecisionCandidates(segment).find((candidate) => candidate.description.includes('"type_text"'))!;
  const call = { ...insertion.call!, id: "insert-1" };
  const waiting = { ...segment, phase: "waiting" as const, pending: call };
  const initial = state(waiting, [new AIMessage({ content: "", tool_calls: [call] })]);
  const unknown = result(call, { status: "host_rejected", reason: "host_failure" }, "unknown_completion");
  const settled = settleNativeDecision(initial, [call], [unknown], [], modelId)!;
  expect(settled.phase).toBe("observe");
  expect(settled.unresolved).toHaveLength(1);
  const read = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async () => { throw new Error("read must not spend Choice"); } })(state(settled), { signal: new AbortController().signal });
  expect(read.nativeDecision!.pending!.name).toBe("computer_observe");
  const readCall = read.nativeDecision!.pending!;
  const fresh = settleNativeDecision({ ...state(settled), ...read }, [readCall], [result(readCall, observation(2, 2))], [], modelId)!;
  expect(fresh.phase).toBe("decide");
  const available = nativeDecisionCandidates(fresh);
  expect(available.some((candidate) => /type_text|set_value/.test(candidate.description))).toBe(false);
  expect(available.some((candidate) => candidate.description.includes('"click"'))).toBe(true);
  const changedHandle = { ...call, args: { operation: { kind: "type_text", text: "42", target: fresh.observation!.controlCollection!.controls[0]!.target } } };
  expect(nativeDecisionDispatchError(state({ ...fresh, phase: "waiting", pending: changedHandle }), changedHandle)).toBe("native_decision_action_not_current_or_replay_fenced");
  const restartedCall = { id: "replan", name: "computer_observe", args: { ...fresh.observeArgs, decisionPlan: fresh.plan } };
  const restarted = settleNativeDecision(state({ ...fresh, phase: "handoff" }, [new AIMessage({ content: "", tool_calls: [restartedCall] })]), [restartedCall], [result(restartedCall, observation(2, 3))], [], modelId)!;
  expect(nativeDecisionCandidates(restarted).some((candidate) => /type_text|set_value/.test(candidate.description))).toBe(false);
});

test("fresh settlement compacts reindexed history while preserving receipts, targets and screening coverage", () => {
  const segment = decision({ observation: observation(600) });
  const insertion = nativeDecisionCandidates(segment).find(candidate => candidate.description.includes('"type_text"'))!;
  const call = { ...insertion.call!, id: "uncertain-input" };
  const waiting = state({ ...segment, phase: "waiting", pending: call }, [new AIMessage({ content: "", tool_calls: [call] })]);
  const settled = settleNativeDecision(waiting, [call], [result(call, { status: "host_rejected", reason: "host_failure" }, "unknown_completion")], [], modelId)!;
  const retainedEvidence = structuredClone(settled.history[0]!.evidence);
  const retainedUnresolved = structuredClone(settled.unresolved);
  const after = observation(600, 2);
  after.controlCollection!.controls.forEach((row, index) => { row.id = `c${index + 1000}`; });
  after.controlCollection!.controls[1]!.state.value = "42";
  const read = { id: "fresh-read", name: "computer_observe", args: segment.observeArgs };
  const fresh = settleNativeDecision(state({ ...settled, phase: "waiting", pending: read }), [read], [result(read, after)], [], modelId)!;
  expect(fresh.observation).toEqual(after);
  expect(fresh.unresolved).toEqual(retainedUnresolved);
  expect(fresh.history[0]!.evidence).toMatchObject(retainedEvidence as Record<string, unknown>);
  expect(fresh.history[0]!.evidence).toMatchObject({ observed: {
    comparison: "semantic_multiset", identity: "not_inferred", sameSemanticOccurrences: 599,
    beforeCompleteness: "partial", completeness: "partial",
    addedOrChanged: [{ id: "c1001", state: { value: "42" } }],
    removedOrChanged: [{ id: "c1", state: { value: "0" } }],
  } });
  const candidates = nativeDecisionCandidates(fresh);
  expect(candidates.some(candidate => /type_text|set_value/.test(candidate.description))).toBe(false);
  expect(new Set(candidates.flatMap(candidate => candidate.controlId ? [candidate.controlId] : [])).size).toBe(600);
  const chosen = candidates.find(candidate => candidate.controlId === "c1001")!;
  expect(chosen.call!.args["operation"]).toMatchObject({ target: after.controlCollection!.controls[1]!.target });
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "goal",
    state: { observation: nativeDecisionEvidence(after), recentActions: fresh.history, unresolved: fresh.unresolved },
    choices: [chosen, { id: "none_in_group", description: "none" }] };
  const projected = projectNativeDecisionScreen(input, fresh, candidates);
  expect(projected.state).toMatchObject({ recentActions: fresh.history, unresolved: retainedUnresolved });
  const final = { ...input, choices: [chosen] };
  expect(projectNativeDecisionScreen(final, fresh, candidates).state).toMatchObject({
    recentActions: fresh.history, unresolved: retainedUnresolved,
    observation: { collection: { projection: { kind: "finalists" } } },
  });
});

test("revoked model, encrypted egress, cancellation and visual handback never propose input", async () => {
  for (const kind of ["encrypted", "cancelled", "missing_key", "visual"] as const) {
    process.env["OPENROUTER_API_KEY"] = "synthetic-native-choice";
    if (kind === "missing_key") delete process.env["OPENROUTER_API_KEY"];
    const controller = new AbortController();
    if (kind === "cancelled") controller.abort();
    const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => kind === "encrypted", choose: async (input) => {
      expect(kind).toBe("visual"); return answer(input, "needs_visual_evidence");
    } })(state(decision()), { signal: controller.signal });
    expect(next.nativeDecision?.phase).toBe("handoff");
    expect(next.nativeDecision?.pending).toBeNull();
  }
});

test("controls are not filtered by roles, while disabled rows retain evidence without execution", () => {
  const observed = observation();
  observed.controlCollection!.controls[0]!.role = "custom_widget";
  observed.controlCollection!.controls[1]!.enabled = false;
  const segment = decision({ observation: observed });
  expect(nativeDecisionCandidates(segment).filter((candidate) => candidate.controlId === "c0")).toHaveLength(3);
  expect(nativeDecisionCandidates(segment).filter((candidate) => candidate.controlId === "c1")).toHaveLength(0);
  expect(nativeDecisionEvidence(observed).collection!.controls).toHaveLength(2);
});

test("verified action is followed by a free fresh read and completion returns to Genie", async () => {
  const segment = decision();
  let choices = 0;
  const node = createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (input) => {
    choices++;
    return answer(input, choices === 1 ? boundChoice(input, "set_value", "c1") : "completion_ready");
  } });
  const config = { signal: new AbortController().signal };
  let current = { ...state(segment), ...await node(state(segment), config) };
  const call = current.nativeDecision!.pending!;
  const receipt = result(call, { version: 1, timing: "immediate", action: "set_value",
    target: segment.observation!.controlCollection!.controls[1]!.target,
    resolvedTarget: { kind: "element", role: "slider", action: "set_value", enabled: true },
    provider: "cua", deliveryMode: "background", completionCertainty: "completed", verification: "verified",
    unexecutedRemainder: { count: 0, reason: "none" },
    providerAction: { effect: "confirmed", route: "accessibility", delivery: { mode: "background" }, evidenceKinds: ["value_readback"], escalation: null },
    outcome: { ...readOutcome, phase: "post_effect_verification", stateChangeCertainty: "changed" },
  });
  expect(nativeDecisionResult(receipt)).not.toBeNull();
  current.nativeDecision = settleNativeDecision(current, [call], [receipt], [], modelId);
  expect(current.nativeDecision?.phase).toBe("observe");
  current = { ...current, ...await node(current, config) };
  expect(choices).toBe(1);
  const read = current.nativeDecision!.pending!;
  const after = observation(2, 2);
  after.controlCollection!.controls[1]!.state.value = "42";
  current.nativeDecision = settleNativeDecision(current, [read], [result(read, after)], [], modelId);
  expect(current.nativeDecision!.history[0]!.evidence).toMatchObject({ observed: { addedOrChanged: [{ id: "c1", state: { value: "42" } }] } });
  current = { ...current, ...await node(current, config) };
  expect(current.nativeDecision?.reason).toBe("completion_ready");
  expect(shouldContinueAfterTools(current)).toBe("pre_model");
  expect(choices).toBe(2);
});

test("known non-delivery recovers, while human interference hands back", async () => {
  for (const interference of [false, true]) {
    const segment = decision();
    const selected = nativeDecisionCandidates(segment).find((candidate) => candidate.description.includes('"type_text"'))!;
    const call = { ...selected.call!, id: "refused-input" };
    const receipt = result(call, { version: 1, timing: "immediate", action: "type_text", target: segment.observation!.controlCollection!.controls[0]!.target,
      resolvedTarget: { kind: "element", state: "unavailable" }, provider: "cua", deliveryMode: "not_delivered",
      completionCertainty: "not_completed", verification: "unavailable", unexecutedRemainder: { count: 1, reason: "failed" },
      textDelivery: { requestedCharacters: 2, deliveredCharacters: 0 },
      outcome: { ...readOutcome, phase: "resolve_target", retrySafety: "observe_before_retry", stateChangeCertainty: "not_changed", targetCondition: "stale", recovery: ["observe_again"],
        ...(interference ? { externalInterference: "user_input" } : {}) },
    }, "not_completed");
    expect(nativeDecisionResult(receipt)).not.toBeNull();
    const settled = settleNativeDecision(state({ ...segment, phase: "waiting", pending: call }, [new AIMessage({ content: "", tool_calls: [call] })]), [call], [receipt], [], modelId)!;
    expect(settled.unresolved).toHaveLength(0);
    expect(settled.phase).toBe(interference ? "handoff" : "observe");
    if (interference) expect(settled.reason).toBe("human_takeover");
  }
});

test("workflow redelegation retains same-surface recovery instead of restarting its budget", () => {
  const plan = nativeDecisionPlanSchema.parse({ execution: "workflow", goal: "Create a document" });
  let segment = decision({ plan, execution: { request: plan.goal, tools: ["computer_observe", "computer_do"],
    observation: null, observationCallId: null, freshRead: false, mustObserve: false, question: null } });
  const call = { id: "delegate", name: "computer_observe", args: { operation: "window_state", target, decisionPlan: plan } };
  for (let index = 0; index <= segment.recovery.limit; index++) {
    const nextCall = { ...call, id: `delegate-${index}` };
    const current = state(segment, [new AIMessage({ content: "", tool_calls: [nextCall] })]);
    current.toolNames = ["computer_observe", "computer_do"];
    segment = settleNativeDecision(current, [nextCall], [result(nextCall, observation(2, index + 1))], [], modelId)!;
    expect(segment.recovery.events).toBe(index);
  }
  expect(segment.reason).toBe("native_decision_no_progress");
});

test("ordinary Genie recovery retains a reported input takeover after the fast workflow hands off", () => {
  const segment = decision({ phase: "handoff", reason: "native_decision_no_progress",
    execution: { request: "Edit a draft", tools: ["computer_observe", "computer_do"], observation: null,
      observationCallId: null, freshRead: false, mustObserve: false, question: null } });
  const call = { id: "ordinary-observe", name: "computer_observe", args: { operation: "window_state", target } };
  const observed = observation();
  const receipt = result(call, { ...observed, outcome: { ...readOutcome, externalInterference: "user_input" } });
  expect(nativeDecisionResult(receipt)).not.toBeNull();
  const settled = settleNativeDecision(state(segment), [call], [receipt], [], modelId)!;
  expect(settled.humanTakeover).toBe(true);
  expect(settled.reason).toBe("human_takeover");
  expect(nativeDecisionDispatchError(state(settled), { ...call, id: "fresh-retry" })).toBe("native_human_takeover_wait_for_user");
});

test("screening keeps ancestors and final-state evidence, including duplicate labels", () => {
  const observed = observation(3);
  observed.controlCollection!.controls[1]!.parent = "c0";
  observed.controlCollection!.controls[2]!.parent = "c0";
  observed.controlCollection!.controls[1]!.label = "Same label";
  observed.controlCollection!.controls[2]!.label = "Same label";
  const segment = decision({ observation: observed });
  const candidates = nativeDecisionCandidates(segment);
  const chosen = candidates.find((candidate) => candidate.controlId === "c2")!;
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "goal", state: { observation: nativeDecisionEvidence(observed) }, choices: [chosen, { id: "none_in_group", description: "none" }] };
  const projected = projectNativeDecisionScreen(input, segment, candidates);
  const rows = (projected.state as { observation: { collection: { controls: Array<{ id: string }> } } }).observation.collection.controls;
  expect(rows.map((row) => row.id)).toEqual(["c0", "c2"]);
  expect(candidates.filter((candidate) => candidate.controlId === "c1")).toHaveLength(3);
  expect(candidates.filter((candidate) => candidate.controlId === "c2")).toHaveLength(3);
});

test("final comparison retains context-only rows, ancestry and escape routes without changing canonical evidence", () => {
  const observed = observation(5);
  const rows = observed.controlCollection!.controls;
  rows[0]!.enabled = false;
  rows[0]!.label = "Unsaved changes";
  rows[2]!.parent = "c1";
  rows[3]!.target = undefined;
  rows[3]!.label = "Document state";
  const segment = decision({ observation: observed });
  const candidates = nativeDecisionCandidates(segment);
  const chosen = candidates.find(candidate => candidate.controlId === "c2")!;
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "goal",
    state: { observation: nativeDecisionEvidence(observed), unresolved: segment.unresolved },
    choices: [chosen, ...candidates.filter(candidate => candidate.controlId === undefined)],
  };
  const before = JSON.stringify(observed);
  const projected = projectNativeDecisionScreen(input, segment, candidates);
  expect(projected.choices).toBe(input.choices);
  expect(projected.state).toMatchObject({ unresolved: segment.unresolved, observation: { collection: {
    controls: [{ id: "c0" }, { id: "c1" }, { id: "c2" }, { id: "c3" }],
    projection: { kind: "finalists", total: 5, included: 4, omittedCandidateControls: 1 },
  } } });
  expect(JSON.stringify(projected.state)).not.toContain("detgt_");
  expect(JSON.stringify(observed)).toBe(before);
});

test("window-wide operations, control-only decisions and broken ancestry retain complete evidence", () => {
  const observed = observation(3);
  const segment = decision({ observation: observed, plan: nativeDecisionPlanSchema.parse({
    goal: "Inspect and focus", actions: [
      { purpose: "Focus window", target: "window", operation: { kind: "focus" } },
      { purpose: "Activate control", target: "each_control", operation: { kind: "click" } },
    ],
  }) });
  const candidates = nativeDecisionCandidates(segment);
  const window = candidates.find(candidate => candidate.call?.name === "computer_do" && !candidate.controlId)!;
  expect(window).toBeDefined();
  const input: ChoiceInput = { modelId, signal: new AbortController().signal, instructions: "goal",
    state: { observation: nativeDecisionEvidence(observed) }, choices: [window],
  };
  expect(projectNativeDecisionScreen(input, segment, candidates)).toBe(input);
  const controlOnly = { ...input, choices: candidates.filter(candidate => candidate.call === null) };
  expect(projectNativeDecisionScreen(controlOnly, segment, candidates)).toBe(controlOnly);
  observed.controlCollection!.controls[2]!.parent = "missing";
  const missingParent = { ...input, choices: [candidates.find(candidate => candidate.controlId === "c2")!] };
  expect(projectNativeDecisionScreen(missingParent, segment, candidates)).toBe(missingParent);
});

test("unchanged observations trigger the existing caller-policy intervention threshold", async () => {
  const segment = decision({ recovery: { limit: 2, events: 0, transitions: [], before: null } });
  const current = state(segment);
  for (let index = 0; index < 3; index++) {
    const call = { id: `read-${index}`, name: "computer_observe", args: segment.observeArgs };
    current.nativeDecision = { ...current.nativeDecision!, phase: "waiting", pending: call };
    current.nativeDecision = settleNativeDecision(current, [call], [result(call, observation(2, index + 1))], [], modelId);
  }
  expect(current.nativeDecision?.reason).toBe("native_decision_no_progress");
});

test("exact supplied text is retained once in context instead of copied into every choice", async () => {
  const poem = "The sky unfolds a quiet thought.".repeat(30);
  const segment = decision({ plan: nativeDecisionPlanSchema.parse({ goal: "Insert the supplied poem", values: { poem } }) });
  const candidates = nativeDecisionCandidates(segment);
  expect(JSON.stringify(candidates.map(({ description }) => description))).not.toContain(poem);
  expect(candidates.find((candidate) => candidate.description.includes('"type_text"'))?.call?.args).toMatchObject({ operation: { text: poem } });
  await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (input) => {
    expect((input.state as { suppliedValues: { poem: string } }).suppliedValues.poem).toBe(poem);
    return answer(input, "defer_to_genie");
  } })(state(segment), { signal: new AbortController().signal });
});

test("cancellation after a billed choice never creates a tool proposal", async () => {
  const controller = new AbortController();
  const next = await createNativeDecisionNode({ fullEncryptionOnlyForState: () => false, choose: async (input) => {
    controller.abort(); return answer(input, input.choices[0]!.id);
  } })(state(decision()), { signal: controller.signal });
  expect(next.nativeDecision?.phase).toBe("handoff");
  expect(next.nativeDecision?.pending).toBeNull();
  expect(next.messages?.some((message) => AIMessage.isInstance(message) && message.tool_calls?.length)).toBe(false);
});
