import { expect, test } from "bun:test";
import { nativeBindingOperations, selectNativeOperation, type NativeBindingCapability } from "../../src/graph/native-operation-binding";
import { activeComputerUseHostToolDefinitions, resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";
import { bindNativeExecutionValue, nativeExecutionStringsBound, type NativeExecutionReply } from "../../src/graph/native-execution";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";
import { ChoiceRequestError } from "../../src/providers/choice";
import { CUA_MACOS_KEY_NAMES, CUA_MACOS_KEY_PATTERN } from "@nautilo/computer-use-contracts/native";
import type { DecisionInput, DecisionResult } from "../../src/providers/decision";

const pairedCapability: NativeBindingCapability = { name: "paired_inputs", description: "Bind two exact values", effectClass: "write",
  schema: { type: "object", properties: { mode: { const: "insert" }, title: { type: "string" }, body: { type: "string" } },
    required: ["mode", "title", "body"], additionalProperties: false } };
const pairedRoots = { request: "Use the supplied title and body", values: { title: "Title 🌊", body: "Exact\r\nbody — do not rewrite" }, observation: null };

test("missing opaque target never becomes context or reference binding questions", async () => {
  const capability: NativeBindingCapability = { name: "fixture_control", description: "Control an observed target", effectClass: "write",
    schema: { type: "object", properties: { target: { type: "object", properties: {
      context: { type: "string", pattern: "^ctx_" }, reference: { type: "string", pattern: "^target_" },
    }, required: ["context", "reference"], additionalProperties: false } }, required: ["target"], additionalProperties: false } };
  let calls = 0;
  const reply = await selectNativeOperation({ capabilities: [capability], roots: {
    request: "Activate the intended target", values: {}, observation: { context: "ctx_root", label: "target_not_authority" },
  }, state: {}, modelId: "fixture", signal: new AbortController().signal, choose: async input => {
    calls++;
    expect(calls).toBe(1);
    expect(JSON.stringify(input)).not.toContain("Bind fixture_control.target.context");
    return answer(input, input.choices.find(row => row.description.includes("select/customize inputs"))!.id);
  } });
  expect(reply).toMatchObject({ kind: "genie", reason: "missing_capability" });
  expect(calls).toBe(1);
});

test("missing native authority chooses a supported acquisition route without a Genie round trip", async () => {
  const capabilities: NativeBindingCapability[] = [{ name: "fixture_action", description: "Click a fresh control", effectClass: "write",
    schema: { type: "object", properties: { target: { type: "object", properties: { context: { type: "string" }, reference: { type: "string" } },
      required: ["context", "reference"] } }, required: ["target"] } },
  { name: "fixture_read", description: "Acquire current controls", effectClass: "read",
    schema: { type: "object", properties: { operation: { const: "discover" } }, required: ["operation"] } }];
  let calls = 0;
  const result = await selectNativeOperation({ capabilities, roots: { request: "Activate the requested control", values: {}, observation: null },
    state: {}, modelId: "fixture", signal: new AbortController().signal, choose: async input => {
      calls++;
      const prefix = calls === 1 ? "fixture_action:" : "fixture_read:";
      expect(calls).toBeLessThanOrEqual(2);
      if (calls === 2) expect(JSON.stringify(input.state)).toContain("Acquire missing target evidence");
      return answer(input, input.choices.find(row => row.description.startsWith(prefix))!.id);
    } });
  expect(result).toEqual({ kind: "call", tool: "fixture_read", arguments: { operation: "discover" } });
  expect(calls).toBe(2);
});
function pairedAnswer(input: DecisionInput, override?: string): DecisionResult {
  const state = input.state as { bindingSources: Record<string, string> };
  return { requestedModelId: input.modelId, resolvedModelId: input.modelId, usage: { inputTokens: 7, outputTokens: 2, actualCostUsd: 0.01 },
    answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      if (question.type !== "choice") throw new Error("expected choice");
      if (typeof question.instructions !== "string") throw new Error("expected text instructions");
      const field = question.instructions.includes(".title ") ? "title" : "body";
      const selected = override ?? Object.keys(question.criteria).find(key => {
        if (!key.startsWith("input_")) return false;
        const presentation = JSON.parse(question.criteria[key] as string) as { bindings: Record<string, string> };
        return Object.values(presentation.bindings).some(source => state.bindingSources[source] === `supplied ${field}`);
      })!;
      return [id, { type: "choice", choice: selected, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === selected ? 1 : 0])) }];
    })) };
}

test("typed multi-input selection forwards exact originals with no Cartesian product or content copying", async () => {
  let calls = 0; let batches = 0;
  const result = await selectNativeOperation({ capabilities: [pairedCapability], roots: pairedRoots, state: {}, modelId: "flash", signal: new AbortController().signal,
    choose: async input => { calls++; return answer(input, input.choices.find(row => row.description.startsWith("paired_inputs:"))!.id); },
    inputDecision: { modelId: "jev", maxChoices: 256, decide: async input => {
      batches++;
      expect(Object.keys(input.questions)).toHaveLength(2);
      expect(JSON.stringify(input)).not.toContain("do not rewrite");
      expect(JSON.stringify(input)).not.toContain("Title 🌊");
      for (const question of Object.values(input.questions)) if (question.type === "choice") expect(Object.keys(question.criteria)).toHaveLength(5);
      return pairedAnswer(input);
    } } });
  expect(calls).toBe(1); expect(batches).toBe(1);
  if (result.kind !== "call") throw new Error("expected bound call");
  expect(bindNativeExecutionValue(result.arguments, pairedRoots)).toEqual({ mode: "insert", ...pairedRoots.values });
  expect(nativeExecutionStringsBound(result.arguments, bindNativeExecutionValue(result.arguments, pairedRoots), pairedCapability.schema)).toBe(true);
});

test("joint typed binding shares one semantic template across fields while retaining optional and exact supplied inputs", async () => {
  const localRoots = { request: "Insert the supplied title and body; use the supplied note only when requested",
    values: { title: "Title 🌊", body: "Exact\r\nbody — keep every byte", note: "Optional 🐙\nline" }, observation: null };
  const capability: NativeBindingCapability = { name: "paired_inputs", description: "Insert supplied fields", effectClass: "write",
    schema: { type: "object", properties: { mode: { const: "insert" }, title: { type: "string" }, body: { type: "string" },
      note: { type: "string" } }, required: ["mode", "title", "body"], additionalProperties: false } };
  for (const includeNote of [false, true]) {
    let operationCalls = 0;
    let typedCalls = 0;
    const result = await selectNativeOperation({ capabilities: [capability], roots: localRoots, state: {}, modelId: "flash",
      signal: new AbortController().signal,
      choose: async () => { throw new Error("text-grounded binding must not use Middle"); },
      operationDecision: { modelId: "jev", maxChoices: 256, choose: async input => {
        operationCalls++;
        expect((input.state as Record<string, unknown>)["decisionStage"]).toBe("operation");
        const selected = input.choices.find(row => row.description.includes("select/customize inputs"));
        expect(selected).toBeDefined();
        const evidence = (input.state as { candidateEvidence: { id: string; evidence: Record<string, unknown> }[] }).candidateEvidence
          .find(row => row.id === selected!.id)?.evidence;
        expect(evidence).toMatchObject({ suppliedValueNames: ["title", "body", "note"], observedTargetCount: 0 });
        expect(evidence?.["nextStep"]).toContain("separate exact selection");
        return answer(input, selected!.id);
      } },
      inputDecision: { modelId: "jev", maxChoices: 256, decide: async input => {
        typedCalls++;
        const state = input.state as { actionTemplates: { id: string; tool: string; arguments: unknown }[];
          bindingSources: Record<string, string>; decisionStage: string; evidenceMode: string };
        expect(state.decisionStage).toBe("binding");
        expect(state.evidenceMode).toBe("text");
        expect(Object.keys(input.questions)).toHaveLength(3);
        expect(state.actionTemplates).toHaveLength(1);
        expect(state.actionTemplates[0]).toMatchObject({ arguments: { boundInput: "input0" } });
        expect(state.actionTemplates[0]!.tool.startsWith("paired_inputs:")).toBe(true);
        expect(JSON.stringify(input)).not.toContain(localRoots.values.title);
        expect(JSON.stringify(input)).not.toContain(localRoots.values.body);
        expect(JSON.stringify(input)).not.toContain(localRoots.values.note);
        const fields = ["title", "body", "note"];
        const answers = Object.fromEntries(Object.entries(input.questions).map(([id, question], index) => {
          if (question.type !== "choice") throw new Error("expected typed Choice question");
          const field = fields[index]!;
          if (field === "note" && !includeNote) return [id, { type: "choice" as const, choice: "omit", confidence: 1,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === "omit" ? 1 : 0])) }];
          const option = Object.entries(question.criteria).find(([candidate, criterion]) => {
            if (!candidate.startsWith("input_")) return false;
            const presentation = JSON.parse(criterion as string) as { action: string; bindings: Record<string, string> };
            expect(presentation.action).toBe(state.actionTemplates[0]!.id);
            return Object.values(presentation.bindings).some(source => state.bindingSources[source] === `supplied ${field}`);
          })?.[0];
          expect(option).toBeDefined();
          return [id, { type: "choice" as const, choice: option!, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === option ? 1 : 0])) }];
        }));
        return { requestedModelId: input.modelId, resolvedModelId: input.modelId,
          usage: { inputTokens: 7, outputTokens: 2, actualCostUsd: 0.01 }, answers };
      } },
    });
    expect(operationCalls).toBe(1);
    expect(typedCalls).toBe(1);
    if (result.kind !== "call") throw new Error("expected bound call");
    expect(bindNativeExecutionValue(result.arguments, localRoots)).toEqual({ mode: "insert", title: localRoots.values.title,
      body: localRoots.values.body, ...(includeNote ? { note: localRoots.values.note } : {}) });
    expect(nativeExecutionStringsBound(result.arguments, bindNativeExecutionValue(result.arguments, localRoots), capability.schema)).toBe(true);
  }
});

test("operation selection exposes tool purpose once and distinguishes binding from missing composition", async () => {
  const result = await selectNativeOperation({ capabilities: [pairedCapability], roots: pairedRoots, state: {}, modelId: "fixture",
    signal: new AbortController().signal, choose: async input => {
      expect(input.instructions).toContain("not an immediate execution");
      expect(input.instructions).toContain("Named supplied values already exist privately");
      expect(input.instructions).toContain("Missing authored content still requires Genie");
      expect((input.state as Record<string, unknown>)["toolSemantics"]).toEqual({ paired_inputs: {
        description: pairedCapability.description, effectClass: "write",
      } });
      expect(JSON.stringify(input).split(pairedCapability.description)).toHaveLength(2);
      expect(JSON.stringify(input)).not.toContain(pairedRoots.values.body);
      expect(input.choices.map(row => row.id)).toContain("defer_to_genie");
      return answer(input, "defer_to_genie");
    } });
  expect(result.kind).toBe("genie");
});

test("typed input selection rejects incomplete, foreign, incompatible and cancelled answers before dispatch", async () => {
  for (const scenario of ["missing", "foreign", "incompatible", "cancelled"] as const) {
    const controller = new AbortController();
    const capability = scenario === "incompatible" ? { ...pairedCapability, schema: { ...pairedCapability.schema as object,
      not: { properties: { title: { const: pairedRoots.values.title }, body: { const: pairedRoots.values.body } }, required: ["title", "body"] } } } : pairedCapability;
    const pending = selectNativeOperation({ capabilities: [capability], roots: pairedRoots, state: {}, modelId: "flash", signal: controller.signal,
      choose: async input => answer(input, input.choices.find(row => row.description.startsWith("paired_inputs:"))!.id),
      inputDecision: { modelId: "jev", maxChoices: 256, decide: async input => {
        const result = pairedAnswer(input, scenario === "foreign" ? "invented" : undefined);
        if (scenario === "missing") return { ...result, answers: {} };
        if (scenario === "cancelled") controller.abort();
        return result;
      } } });
    expect((await Promise.allSettled([pending]))[0].status).toBe("rejected");
  }
});

test("typed input recovery, capacity and context fallback preserve the ordinary binder", async () => {
  for (const mode of ["unsupported", "capacity", "context", "customize", "reobserve", "defer_to_genie", "provider_failure"] as const) {
    let batches = 0; let ordinary = 0;
    const pending = selectNativeOperation({ capabilities: [pairedCapability], roots: pairedRoots, state: {}, modelId: "flash", signal: new AbortController().signal,
      choose: async input => {
        ordinary++;
        const field = (input.state as Record<string, string>)["field"];
        return answer(input, input.choices.find(row => row.description.includes(field ? `supplied ${field.split(".").at(-1)}` : "paired_inputs:"))!.id);
      }, ...(mode === "unsupported" ? {} : { inputDecision: { modelId: "jev", maxChoices: mode === "capacity" ? 4 : 256,
        decide: async (input: DecisionInput) => {
          batches++;
          if (mode === "context" || mode === "provider_failure") throw new ChoiceRequestError(mode === "context" ? "context_length_exceeded" : "provider_error");
          return pairedAnswer(input, mode);
        } } }) });
    const [settled] = await Promise.allSettled([pending]);
    if (mode === "provider_failure") expect(settled.status).toBe("rejected");
    else {
      if (settled.status !== "fulfilled") throw new Error(`unexpected failure ${mode}`);
      const result = settled.value;
      if (mode === "reobserve" || mode === "defer_to_genie") expect(result.kind).toBe("genie");
      else {
        if (result.kind !== "call") throw new Error("expected ordinary bound call");
        expect(bindNativeExecutionValue(result.arguments, pairedRoots)).toEqual({ mode: "insert", ...pairedRoots.values });
        expect(ordinary).toBe(3);
      }
    }
    expect(batches).toBe(mode === "unsupported" || mode === "capacity" ? 0 : 1);
  }
});

const capabilities = (): NativeBindingCapability[] => activeComputerUseHostToolDefinitions().map(tool => ({
  name: tool.name, description: tool.entry.projection.modelDescription, effectClass: tool.entry.descriptor.effectClass, schema: tool.entry.publicSchemas.input.jsonSchema,
}));
const roots = { request: "Open Sketchpad", values: {}, observation: null };
const signal = new AbortController().signal;
const answer = (input: ChoiceInput, selectedId: string): ChoiceResult => ({ selectedId, requestedModelId: input.modelId, resolvedModelId: input.modelId,
  usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: 0 } });
const chooseBy = (select: (input: ChoiceInput) => string) => async (input: ChoiceInput) => {
  const description = select(input);
  return answer(input, input.choices.find(row => row.description.includes(description))!.id);
};
function readyChoices(input: ChoiceInput) {
  const state = input.state as { actionTemplates?: { id: string; tool: string; arguments: unknown }[];
    bindingSources?: Record<string, string> };
  return input.choices.flatMap(choice => {
    if (!choice.description.startsWith("{")) return [];
    const { action, ...inputs } = JSON.parse(choice.description) as Record<string, string>;
    const template = state.actionTemplates?.find(row => row.id === action);
    if (!template) throw new Error("missing action template");
    const sources = Object.values(inputs).map(id => {
      const source = state.bindingSources?.[id];
      if (!source) throw new Error("missing source evidence");
      return source;
    });
    return [{ id: choice.id, description: `Ready: ${template.tool}: ${JSON.stringify(template.arguments)} ${sources.join(" ")}` }];
  });
}

test("completion is independently reviewed against the whole request before returning done", async () => {
  const draft = "Exact authored 🌊\r\nDo not regenerate this.";
  const local = { request: "Insert the supplied draft in the document body", values: { draft }, observation: {
    evidence: { appLabel: "Sketchpad", windowLabel: "Draft" },
    controls: [{ role: "text_area", label: "Document body", state: { value: draft } }],
  } };
  const completion: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["controls", 0, "state", "value"], comparison: "equals", expected: { $valueRef: { source: "values", path: ["draft"] } } },
  ] };
  const requests: ChoiceInput[] = [];
  const result = await selectNativeOperation({ capabilities: [], roots: local, state: { request: local.request }, completion,
    modelId: "fixture", signal, choose: async input => {
      requests.push(input);
      if (requests.length === 1) return answer(input, input.choices.find(row => row.description.startsWith("Complete ONLY"))!.id);
      expect(input.instructions).toContain("entire original request");
      expect(input.instructions).toContain("intermediate");
      const serialized = JSON.stringify(input);
      expect(serialized).toContain("Document body");
      expect(serialized).toContain("text_area");
      expect(serialized).toContain("windowLabel");
      expect(serialized).not.toContain(JSON.stringify(draft).slice(1, -1));
      return answer(input, "goal_satisfied");
    } });
  expect(result).toEqual(completion);
  expect(requests).toHaveLength(2);
});

test("Choice completion review can request visual interpretation without losing checked facts", async () => {
  const local = { ...roots, observation: { evidence: { appLabel: "Sketchpad" } } };
  const completion: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["evidence", "appLabel"], comparison: "equals", expected: { $valueRef: { source: "request", path: [], slice: { start: 5, end: 14 } } } },
  ] };
  let calls = 0;
  let reviewFacts: unknown;
  const result = await selectNativeOperation({ capabilities: [], roots: local, state: {}, completion, completionNominated: true,
    modelId: "flash", signal, operationDecision: { modelId: "jev", maxChoices: 256, choose: async input => {
      calls++;
      expect((input.state as Record<string, unknown>)["evidenceMode"]).toBe("text");
      reviewFacts = (input.state as Record<string, unknown>)["review"];
      return answer(input, "interpret_with_middle");
    } }, choose: async input => {
      calls++;
      expect((input.state as Record<string, unknown>)["evidenceMode"]).toBe("visual");
      expect((input.state as Record<string, unknown>)["review"]).toEqual(reviewFacts);
      expect(input.choices.map(row => row.id)).not.toContain("interpret_with_middle");
      return answer(input, "goal_satisfied");
    } });
  expect(result).toEqual(completion);
  expect(calls).toBe(2);
});

test("an intermediate match can resume ordinary selection without a Genie trip or repeated completion", async () => {
  const local = { ...roots, request: "Open Sketchpad and create a blank document", observation: { evidence: { appLabel: "Sketchpad" } } };
  const completion: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["evidence", "appLabel"], comparison: "equals", expected: { $valueRef: { source: "request", path: [], slice: { start: 5, end: 14 } } } },
  ] };
  const custom: NativeBindingCapability = { name: "future_native_action", description: "Create a document", effectClass: "write",
    schema: { type: "object", properties: { operation: { const: "create_document" } }, required: ["operation"], additionalProperties: false } };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: { request: local.request }, completion,
    modelId: "fixture", signal, choose: async input => {
      calls++;
      if (calls === 1) return answer(input, input.choices.find(row => row.description.startsWith("Complete ONLY"))!.id);
      if (calls === 2) return answer(input, "goal_incomplete");
      expect(input.choices.some(row => row.description.startsWith("Complete ONLY"))).toBe(false);
      return answer(input, readyChoices(input)[0]!.id);
    } });
  expect(result).toEqual({ kind: "call", tool: custom.name, arguments: { operation: "create_document" } });
  expect(calls).toBe(3);
});

test("a bound completion nomination skips only renomination, never review or missing evidence", async () => {
  const local = { ...roots, observation: { evidence: { appLabel: "Sketchpad" } } };
  const completion: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["evidence", "appLabel"], comparison: "equals", expected: { $valueRef: { source: "request", path: [], slice: { start: 5, end: 14 } } } },
  ] };
  for (const mode of ["complete", "continue", "missing_facts", "changed_facts", "cancelled"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const result = selectNativeOperation({ capabilities: [], roots: mode === "changed_facts"
      ? { ...local, observation: { evidence: { appLabel: "Wrong app" } } } : local,
    state: {}, completion: mode === "missing_facts" ? undefined : completion, completionNominated: true,
    modelId: "fixture", signal: controller.signal, choose: async input => {
      calls++;
      if (mode !== "missing_facts" && calls === 1) {
        expect(input.choices.map(row => row.id)).toEqual(["goal_satisfied", "goal_incomplete", "defer_to_genie"]);
        if (mode === "cancelled") controller.abort();
        return answer(input, mode === "continue" ? "goal_incomplete" : "goal_satisfied");
      }
      expect(input.choices.some(row => row.description.startsWith("Complete ONLY"))).toBe(false);
      return answer(input, "defer_to_genie");
    } });
    const [settled] = await Promise.allSettled([result]);
    if (mode === "changed_facts" || mode === "cancelled") expect(settled.status).toBe("rejected");
    else {
      expect(settled.status).toBe("fulfilled");
      if (settled.status === "fulfilled") expect(settled.value.kind).toBe(mode === "complete" ? "complete" : "genie");
    }
    expect(calls).toBe(mode === "changed_facts" ? 0 : mode === "continue" ? 2 : 1);
  }
});

test("completion review can escalate ambiguity and cancellation never returns success", async () => {
  const local = { ...roots, observation: { evidence: { appLabel: "Sketchpad" } } };
  const completion: Extract<NativeExecutionReply, { kind: "complete" }> = { kind: "complete", summary: "Done", checks: [
    { path: ["evidence", "appLabel"], comparison: "equals", expected: { $valueRef: { source: "request", path: [], slice: { start: 5, end: 14 } } } },
  ] };
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const pending = selectNativeOperation({ capabilities: [], roots: local, state: { request: local.request }, completion,
      modelId: "fixture", signal: controller.signal, choose: async input => {
        calls++;
        if (calls === 1) return answer(input, input.choices.find(row => row.description.startsWith("Complete ONLY"))!.id);
        if (cancel) controller.abort();
        return answer(input, cancel ? "goal_satisfied" : "defer_to_genie");
      } });
    const [settled] = await Promise.allSettled([pending]);
    if (cancel) expect(settled.status).toBe("rejected");
    else {
      expect(settled.status).toBe("fulfilled");
      if (settled.status === "fulfilled") expect(settled.value).toMatchObject({ kind: "genie", reason: "reasoning" });
    }
    expect(calls).toBe(2);
  }
});

test("real catalogue operation selection and exact input binding assemble an admitted launch", async () => {
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: capabilities(), roots, state: { request: roots.request }, modelId: "fixture", signal,
    choose: chooseBy(input => {
      calls++;
      const state = input.state as Record<string, string>;
      if (state["field"]) return Object.hasOwn(state, "start") ? 'End immediately before character 14' : 'Start input at character 5:';
      if (state["question"]?.startsWith("Optional")) return "omit remaining";
      if (state["question"]?.startsWith("Choose the input shape")) return '"name"';
      return '"launch_app"';
    }) });
  expect(result.kind).toBe("call");
  if (result.kind !== "call") throw new Error("expected call");
  const args = bindNativeExecutionValue(result.arguments, roots);
  expect(args).toEqual({ operation: { kind: "launch_app", app: { name: "Sketchpad" } } });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
  expect(nativeExecutionStringsBound(result.arguments, args, capabilities().find(row => row.name === result.tool)!.schema)).toBe(true);
  expect(calls).toBeGreaterThan(1);
});

test("schema operations remain discoverable without an action-name allowlist", () => {
  const custom = { name: "future_tool", description: "future", effectClass: "read", schema: { anyOf: [
    { type: "object", properties: { action: { const: "future_a" } }, required: ["action"] },
    { type: "object", properties: { action: { const: "future_b" } }, required: ["action"] },
  ] } };
  expect(nativeBindingOperations([custom], false)).toHaveLength(2);
  expect(nativeBindingOperations([{ ...custom, effectClass: "write" }], true)).toEqual([]);
  expect(nativeBindingOperations(capabilities(), false).every(row => row.description.length > 0)).toBe(true);
});

test("a complete observed click is one selection, with exact private target and ordinary admission", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `detgt_${"b".repeat(43)}` };
  const local = { ...roots, request: "Click Export", observation: { controls: [{ label: "Export", target }] } };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: capabilities(), roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      calls++;
      expect(JSON.stringify(input)).not.toContain(target.reference);
      expect(JSON.stringify(input)).not.toContain(target.context);
      const ready = readyChoices(input).find(row => row.description.startsWith("Ready: computer_do:")
        && row.description.includes('"click"') && row.description.includes("Export"));
      expect(ready).toBeDefined();
      return answer(input, ready!.id);
    } });
  expect(calls).toBe(1);
  if (result.kind !== "call") throw new Error("expected bound click");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ operation: { kind: "click", target } });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
  let compatibilityCalls = 0;
  const compatibility = await selectNativeOperation({ capabilities: capabilities(), roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      compatibilityCalls++;
      const state = input.state as Record<string, string>;
      const candidate = state["field"] ? input.choices.find(row => row.description.includes("Export"))
        : state["question"]?.startsWith("Optional") ? input.choices.find(row => row.description.includes("omit remaining"))
        : input.choices.find(row => row.description.startsWith("computer_do:") && row.description.includes('"click"') && row.description.includes("detgt_"));
      return answer(input, candidate!.id);
    } });
  if (compatibility.kind !== "call") throw new Error("expected compatibility click");
  expect(bindNativeExecutionValue(compatibility.arguments, local)).toEqual(args);
  expect(compatibilityCalls).toBe(3);
});

test("complete choices do not infer intent from a unique source or combine independent fields", async () => {
  const custom: NativeBindingCapability = { name: "future_write", description: "Set two independent fields", effectClass: "write",
    schema: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } }, required: ["first", "second"], additionalProperties: false } };
  const result = await selectNativeOperation({ capabilities: [custom], roots: { ...roots, values: { exact: "Do not copy me twice implicitly" } },
    state: {}, modelId: "fixture", signal, choose: async input => {
      expect(readyChoices(input)).toEqual([]);
      expect(input.choices.some(row => row.description.startsWith("future_write:"))).toBe(true);
      return answer(input, "defer_to_genie");
    } });
  expect(result.kind).toBe("genie");
});

test("complete choices cover late targets through the existing reducer without Cartesian expansion", async () => {
  const controls = Array.from({ length: 1000 }, (_, index) => ({ label: `Control ${index}`,
    target: { reference: `private-${index}`, context: "private-context" } }));
  const custom: NativeBindingCapability = { name: "future_click", description: "Click a control", effectClass: "write",
    schema: { type: "object", properties: { action: { const: "click" }, target: { type: "object",
      properties: { reference: { type: "string" }, context: { type: "string" } }, required: ["reference", "context"], additionalProperties: false } },
    required: ["action", "target"], additionalProperties: false } };
  const local = { ...roots, request: "Click Control 999", observation: { controls } };
  const screened = new Set<string>();
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal, maxChoices: 256,
    choose: async input => {
      expect(input.choices.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(input)).not.toContain("private-");
      const ready = readyChoices(input);
      for (const row of ready) screened.add(row.id);
      const choice = ready.find(row => row.description.includes("Control 999"));
      const state = input.state as { actionTemplates: unknown[]; bindingSources?: Record<string, string> };
      expect(state.actionTemplates).toHaveLength(1);
      expect(Object.keys(state.bindingSources ?? {})).toHaveLength(ready.length);
      return answer(input, choice?.id ?? "none_in_group");
    } });
  expect(screened.size).toBe(1000);
  if (result.kind !== "call") throw new Error("expected late target");
  expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ action: "click", target: controls[999]!.target });
});

test("Choice-first operation selection bypasses Middle for exact actions and explicit Genie handoff", async () => {
  for (const route of ["action", "genie"] as const) {
    const content = "Original 🌊\r\nDo not reconstruct these bytes.";
    const local = { ...roots, request: "Insert the supplied draft", values: { draft: content } };
    const custom: NativeBindingCapability = { name: "future_insert", description: "Insert supplied content", effectClass: "write",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };
    let calls = 0;
    const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "middle", signal,
      choose: async () => { throw new Error("must not call Middle"); },
      operationDecision: { modelId: "little", maxChoices: 256, choose: async input => {
        calls++;
        expect(input.modelId).toBe("little");
        expect(input.instructions).toContain("text-only Little Brain");
        expect(JSON.stringify(input)).not.toContain(content);
        expect(input.choices.some(row => row.id === "interpret_with_middle")).toBe(true);
        return answer(input, route === "genie" ? "defer_to_genie" : readyChoices(input)[0]!.id);
      } } });
    expect(calls).toBe(1);
    if (route === "genie") expect(result.kind).toBe("genie");
    else {
      if (result.kind !== "call") throw new Error("expected bound action");
      expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ text: content });
    }
  }
});

test("Choice-first screening covers every group and visual escape restores candidates rejected by Jev", async () => {
  for (const capacity of [8, 256]) {
    const controls = Array.from({ length: 1000 }, (_, index) => ({ label: `Control ${index}`,
      target: { reference: `private-${index}`, context: "private-context" } }));
    const custom: NativeBindingCapability = { name: "future_click", description: "Click a control", effectClass: "write",
      schema: { type: "object", properties: { target: { type: "object", properties: { reference: { type: "string" }, context: { type: "string" } },
        required: ["reference", "context"], additionalProperties: false } }, required: ["target"], additionalProperties: false } };
    const local = { ...roots, request: "Click the visually identified control", observation: { controls } };
    const screened = new Set<string>();
    let middleCalls = 0;
    const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "middle", signal,
      operationDecision: { modelId: "little", maxChoices: capacity, choose: async input => {
        expect(input.choices.length).toBeLessThanOrEqual(capacity);
        expect(JSON.stringify(input)).not.toContain("private-");
        if (input.choices.some(row => row.id === "none_in_group")) {
          for (const row of readyChoices(input)) screened.add(row.id);
          return answer(input, "none_in_group");
        }
        expect(screened.size).toBe(1000);
        return answer(input, "interpret_with_middle");
      } }, choose: async input => {
        middleCalls++;
        expect(input.modelId).toBe("middle");
        expect(input.choices.some(row => row.id === "interpret_with_middle")).toBe(false);
        const all = readyChoices(input);
        expect(all).toHaveLength(1000);
        return answer(input, all.find(row => row.description.includes("Control 999"))!.id);
      } });
    expect(middleCalls).toBe(1);
    if (result.kind !== "call") throw new Error("expected recovered action");
    expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ target: controls[999]!.target });
  }
});

test("Choice-first route rejects foreign or cancelled selections without interpretation or effects", async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const pending = selectNativeOperation({ capabilities: [], roots, state: {}, modelId: "middle", signal: controller.signal,
      choose: async () => { throw new Error("must not interpret"); }, operationDecision: { modelId: "little", maxChoices: 256, choose: async input => {
        if (cancelled) controller.abort();
        return answer(input, cancelled ? "interpret_with_middle" : "invented");
      } } });
    expect((await Promise.allSettled([pending]))[0].status).toBe("rejected");
  }
});

test("whole authored input stays private and exact in a complete operation", async () => {
  const content = "Original 🌊\r\nKeep every byte.\n";
  const local = { ...roots, request: "Insert the supplied draft", values: { draft: content } };
  const custom: NativeBindingCapability = { name: "future_insert", description: "Insert already authored content", effectClass: "write",
    schema: { type: "object", properties: { text: { type: "string" }, mode: { enum: ["insert"] } }, required: ["text", "mode"], additionalProperties: false } };
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      expect(JSON.stringify(input)).not.toContain(content);
      return answer(input, readyChoices(input).find(row => row.description.includes("supplied draft"))!.id);
    } });
  if (result.kind !== "call") throw new Error("expected bound content");
  expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ text: content, mode: "insert" });
  expect(nativeExecutionStringsBound(result.arguments, bindNativeExecutionValue(result.arguments, local), custom.schema)).toBe(true);
});

test("multiple actions share source evidence once without including unrelated sources", async () => {
  const targetSchema = { type: "object", properties: { reference: { type: "string" }, context: { type: "string" } },
    required: ["reference", "context"], additionalProperties: false };
  const custom: NativeBindingCapability = { name: "future_control", description: "Interact with observed control", effectClass: "write",
    schema: { anyOf: ["inspect", "press"].map(action => ({ type: "object", properties: { action: { const: action }, target: targetSchema },
      required: ["action", "target"], additionalProperties: false })) } };
  const local = { ...roots, values: { draft: "private draft contents" }, observation: { controls: ["First", "Second"].map(label => ({ label,
    target: { reference: `private-${label}`, context: "private-context" } })) } };
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      const ready = readyChoices(input);
      const state = input.state as { actionTemplates: unknown[]; bindingSources: Record<string, string> };
      expect(state.actionTemplates).toHaveLength(2);
      expect(ready).toHaveLength(4);
      expect(Object.values(state.bindingSources)).toHaveLength(2);
      expect(ready.filter(row => row.description.includes("First"))).toHaveLength(2);
      expect(ready.filter(row => row.description.includes("Second"))).toHaveLength(2);
      expect(JSON.stringify(input)).not.toContain("supplied draft");
      expect(JSON.stringify(input)).not.toContain("private-");
      return answer(input, "defer_to_genie");
    } });
  expect(result.kind).toBe("genie");
});

test("complete operations preserve root constraints and explicit optional customization", async () => {
  const custom: NativeBindingCapability = { name: "future_read", description: "Read named resource", effectClass: "read", schema: {
    type: "object", properties: { resource: { type: "string" }, detail: { type: "boolean" } }, required: ["resource"], additionalProperties: false,
    not: { properties: { resource: { const: "forbidden" } }, required: ["resource"] },
  } };
  const local = { ...roots, values: { forbidden: "forbidden", intended: "retained resource" } };
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
    choose: chooseBy(input => {
      expect(readyChoices(input).some(row => row.description.includes("supplied forbidden"))).toBe(false);
      const state = input.state as Record<string, string>;
      if (state["field"]) return "supplied intended";
      if (state["question"]?.startsWith("Optional")) return "Set optional field";
      if (state["question"] === "Choose future_read.detail") return "true";
      return "select/customize inputs";
    }) });
  if (result.kind !== "call") throw new Error("expected customized operation");
  expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ resource: "retained resource", detail: true });
});

test("operation selection does not promote every observed label into a free-form input, but binding retains them", async () => {
  const custom: NativeBindingCapability = { name: "future_named_action", description: "Operate on a named resource", effectClass: "write",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } };
  const local = { ...roots, observation: { controls: Array.from({ length: 600 }, (_,index) => ({ label: `Resource ${index}` })) } };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      calls++;
      if (calls === 1) {
        expect(readyChoices(input)).toHaveLength(0);
        expect(input.choices).toHaveLength(3); // Operation plus two recovery choices, not 600 speculative inputs.
        return answer(input, input.choices.find(row => row.description.includes("select/customize inputs"))!.id);
      }
      for (let index = 0; index < 600; index++) expect(input.choices.some(row => row.description.includes(`"Resource ${index}"`))).toBe(true);
      return answer(input, input.choices.find(row => row.description.includes('"Resource 599"'))!.id);
    } });
  expect(calls).toBe(2);
  if (result.kind !== "call") throw new Error("expected exact bound action");
  expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ name: "Resource 599" });
});

test("schema-fixed optional capture is a directly selectable alternative, not a forced default", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
  const local = { ...roots, observation: { target, evidence: { appLabel: "Sketchpad", windowLabel: "Document" } } };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: capabilities(), roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      calls++;
      const reads = readyChoices(input).filter(row => row.description.includes('"operation":"window_state"'));
      expect(reads).toHaveLength(2);
      expect(reads.some(row => !row.description.includes('"capture"'))).toBe(true);
      return answer(input, reads.find(row => row.description.includes('"capture":"window_snapshot"'))!.id);
    } });
  expect(calls).toBe(1);
  if (result.kind !== "call") throw new Error("expected snapshot read");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ operation: "window_state", target, capture: "window_snapshot" });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
});

test("the exact driver key vocabulary is selectable without Genie-authored key text", async () => {
  const custom: NativeBindingCapability = { name: "future_key_action", description: "Press a physical key", effectClass: "write",
    schema: { type: "object", properties: { key: { type: "string", pattern: CUA_MACOS_KEY_PATTERN.source } }, required: ["key"], additionalProperties: false } };
  const local = { ...roots, request: "Start a new paragraph", values: {}, observation: null };
  const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
    choose: async input => {
      const choices = readyChoices(input);
      for (const key of CUA_MACOS_KEY_NAMES) expect(choices.some(row => row.description.includes(JSON.stringify({ key })))).toBe(true);
      return answer(input, choices.find(row => row.description.includes('"key":"return"'))!.id);
    } });
  if (result.kind !== "call") throw new Error("expected bound key");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ key: "return" });
  expect(nativeExecutionStringsBound(result.arguments, args, custom.schema)).toBe(true);
});

test("ordered protocol lists are assembled from selected IDs without generated JSON or a new length cap", async () => {
  for (const keys of [["cmd", "end"], Array.from({ length: 12 }, (_, index) => `f${index + 1}`)]) {
    let index = 0;
    const custom: NativeBindingCapability = { name: "future_ordered_input", description: "Perform the requested ordered input", effectClass: "write",
      schema: { type: "object", properties: { keys: { type: "array", items: { type: "string", pattern: CUA_MACOS_KEY_PATTERN.source }, minItems: 2 } },
        required: ["keys"], additionalProperties: false } };
    const local = { ...roots, request: "Perform the requested ordered input", observation: null };
    const result = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal,
      choose: chooseBy(input => {
        const question = (input.state as Record<string, string>)["question"] ?? "";
        if (question.startsWith("Choose future_ordered_input.keys[")) {
          if (index) expect((input.state as { selectedLists: Record<string, { template: { arguments: unknown } }> }).selectedLists["future_ordered_input.keys"]?.template.arguments)
            .toEqual(keys.slice(0, index));
          return `Protocol value "${keys[index++]}"`;
        }
        if (question.startsWith("Finish or extend")) return index < keys.length ? "Add another item" : "Use the selected list";
        return "select/customize inputs";
      }) });
    if (result.kind !== "call") throw new Error("expected bound ordered input");
    const args = bindNativeExecutionValue(result.arguments, local);
    expect(args).toEqual({ keys });
    expect(nativeExecutionStringsBound(result.arguments, args, custom.schema)).toBe(true);
  }
});

test("list construction honors schema cardinality, exact source bytes and cancellation before dispatch", async () => {
  const custom: NativeBindingCapability = { name: "future_list", description: "Use exact selected entries", effectClass: "write",
    schema: { type: "object", properties: { entries: { type: "array", minItems: 2, maxItems: 2, items: { type: "string" } } }, required: ["entries"] } };
  const local = { ...roots, values: { first: "Exact 🌊\r\nfirst", second: "Second — unchanged" } };
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let items = 0;
    const promise = selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal: controller.signal,
      choose: chooseBy(input => {
        const state = input.state as Record<string, string>;
        if (state["field"]?.startsWith("future_list.entries[")) {
          items++;
          if (cancelled && items === 2) controller.abort();
          return `Use the whole supplied source: supplied ${items === 1 ? "first" : "second"}`;
        }
        expect(state["question"]).not.toContain("Finish or extend");
        return "select/customize inputs";
      }) });
    if (cancelled) expect((await Promise.allSettled([promise]))[0].status).toBe("rejected");
    else {
      const result = await promise;
      if (result.kind !== "call") throw new Error("expected exact list");
      expect(bindNativeExecutionValue(result.arguments, local)).toEqual({ entries: [local.values.first, local.values.second] });
    }
    expect(items).toBe(2);
  }
});

test("the real native hotkey contract binds an exact window and ordered keys through ordinary admission", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
  const local = { ...roots, request: "Move to the end of the current document", observation: {
    target, evidence: { appLabel: "Editor", windowLabel: "Document" },
  } };
  const result = await selectNativeOperation({ capabilities: capabilities(), roots: local, state: {}, modelId: "fixture", signal,
    choose: chooseBy(input => {
      const state = input.state as Record<string, string>;
      if (state["field"]?.endsWith(".target")) return '"windowLabel":"Document"';
      if (state["question"] === "Choose computer_do.operation.keys[0]") return 'Protocol value "cmd"';
      if (state["question"] === "Choose computer_do.operation.keys[1]") return 'Protocol value "end"';
      if (state["question"]?.startsWith("Finish or extend")) return "Use the selected list";
      if (state["question"]?.startsWith("Optional")) return "omit remaining";
      return input.choices.find(choice => choice.description.startsWith("computer_do:")
        && choice.description.includes('"kind":"hotkey"') && choice.description.includes("^dtgt_"))!.description;
    }) });
  if (result.kind !== "call") throw new Error("expected native hotkey proposal");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ operation: { kind: "hotkey", target, keys: ["cmd", "end"] } });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
  expect(nativeExecutionStringsBound(result.arguments, args, capabilities().find(tool => tool.name === result.tool)!.schema)).toBe(true);
});

test("cancelled complete choices and read-only recovery cannot expose a mutation", async () => {
  const local = { ...roots, values: { intended: "retained resource" } };
  const custom: NativeBindingCapability = { name: "future_write", description: "Write", effectClass: "write",
    schema: { type: "object", properties: { resource: { type: "string" } }, required: ["resource"] } };
  const controller = new AbortController();
  const failure: unknown = await selectNativeOperation({ capabilities: [custom], roots: local, state: {}, modelId: "fixture", signal: controller.signal,
    choose: async input => {
      const ready = readyChoices(input)[0]!;
      controller.abort();
      return answer(input, ready.id);
    } }).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  for (const state of [{ mustObserve: true }, { unresolvedEffects: [{ completion: "unknown" }] }]) {
    const result = await selectNativeOperation({ capabilities: [custom], roots: local, state, modelId: "fixture", signal,
      choose: async input => {
        expect(input.choices.some(row => row.description.includes("future_write"))).toBe(false);
        return answer(input, "defer_to_genie");
      } });
    expect(result.kind).toBe("genie");
  }
});

test("a schema-fixed value needs no separate model decision", async () => {
  const fixed: NativeBindingCapability = { name: "future_read", description: "Read the current resource", effectClass: "read",
    schema: { type: "object", properties: { operation: { enum: ["inspect"] },
      options: { type: "object", properties: { fresh: { enum: [true] } }, required: ["fresh"], additionalProperties: false } },
    required: ["operation", "options"], additionalProperties: false } };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: [fixed], roots, state: {}, modelId: "fixture", signal,
    choose: async input => {
      calls++;
      if (calls > 1) throw new Error("schema-fixed input spent an unnecessary model call");
      return answer(input, input.choices.find(row => row.description.startsWith("future_read:"))!.id);
    } });
  expect(result).toEqual({ kind: "call", tool: "future_read", arguments: { operation: "inspect", options: { fresh: true } } });
  expect(calls).toBe(1);
});

test("uncertain effects expose reads only; the model cannot choose a mutation", async () => {
  const result = await selectNativeOperation({ capabilities: capabilities(), roots, state: { mustObserve: true }, modelId: "fixture", signal,
    choose: async input => {
      expect(input.choices.some(row => row.description.startsWith("computer_do:"))).toBe(false);
      return answer(input, "defer_to_genie");
    } });
  expect(result.kind).toBe("genie");
});

test("target and authored payload are bound as private exact values, not regenerated", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `detgt_${"b".repeat(43)}` };
  const poem = "Original 🌊\r\nNever rewrite me.\n";
  const local = { request: "Insert the supplied poem", values: { poem }, observation: { control: { target, label: "Document body" } } };
  const result = await selectNativeOperation({ capabilities: capabilities().filter(row => row.name === "computer_do"), roots: local, state: {}, modelId: "fixture", signal,
    choose: chooseBy(input => {
      expect(JSON.stringify(input)).not.toContain(target.reference);
      expect(JSON.stringify(input)).not.toContain(poem);
      const state = input.state as Record<string, string>;
      if (state["field"]?.endsWith(".text")) return "Use the whole supplied source: supplied poem";
      if (state["field"]?.endsWith(".target")) return "Document body";
      if (state["question"]?.startsWith("Optional")) return "omit remaining";
      return '"type_text"';
    }) });
  if (result.kind !== "call") throw new Error("expected call");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ operation: { kind: "type_text", target, text: poem } });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
});

test("cancellation and invented IDs cannot produce arguments", async () => {
  for (const cancelled of [true, false]) {
    const controller = new AbortController();
    expect(selectNativeOperation({ capabilities: capabilities(), roots, state: {}, modelId: "fixture", signal: controller.signal,
      choose: async input => { if (cancelled) controller.abort(); return answer(input, "not_issued"); } })).rejects.toThrow();
  }
});

test("catalogue type_text jointly binds a native target and authored value without exposing their bytes", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `detgt_${"b".repeat(43)}` };
  const poem = "Original 🌊\r\nNever rewrite me.\n";
  const local = { request: "Insert the supplied poem into Document body", values: { poem }, observation: { control: { target, label: "Document body" } } };
  let batches = 0;
  const result = await selectNativeOperation({ capabilities: capabilities().filter(row => row.name === "computer_do"), roots: local, state: {}, modelId: "flash", signal,
    choose: chooseBy(input => (input.state as Record<string, string>)["question"]?.startsWith("Optional") ? "omit remaining" : '"type_text"'),
    inputDecision: { modelId: "jev", maxChoices: 256, decide: async input => {
      batches++;
      expect(JSON.stringify(input)).not.toContain(target.reference);
      expect(JSON.stringify(input)).not.toContain(poem);
      const sources = (input.state as { bindingSources: Record<string, string> }).bindingSources;
      return { requestedModelId: input.modelId, resolvedModelId: input.modelId, usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null },
        answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
          if (question.type !== "choice" || typeof question.instructions !== "string") throw new Error("expected choice");
          const text = question.instructions.includes(".text ");
          const choice = Object.keys(question.criteria).find(key => key.startsWith("input_") && Object.values(
            (JSON.parse(question.criteria[key] as string) as { bindings: Record<string, string> }).bindings)
            .some(source => text ? sources[source] === "supplied poem" : sources[source]?.includes("Document body")))!;
          return [id, { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } }];
        })) };
    } } });
  expect(batches).toBe(1);
  if (result.kind !== "call") throw new Error("expected ordinary proposal");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual({ operation: { kind: "type_text", target, text: poem } });
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
});

test("refresh is one local bound read, not a Genie handoff or copied target", async () => {
  const target = { version: 1, context: `dctx_${"a".repeat(43)}`, reference: `dtgt_${"b".repeat(43)}` };
  const readArguments = { operation: "window_state", target };
  const local = { ...roots, observation: { target }, readArguments };
  let calls = 0;
  const result = await selectNativeOperation({ capabilities: capabilities(), roots: local,
    state: { lastRead: { tool: "computer_observe" } }, modelId: "fixture", signal,
    choose: async input => {
      calls++;
      expect(JSON.stringify(input)).not.toContain(target.reference);
      return answer(input, "reobserve");
    } });
  expect(calls).toBe(1);
  expect(result).toEqual({ kind: "call", tool: "computer_observe",
    arguments: { $valueRef: { source: "readArguments", path: [] } } });
  if (result.kind !== "call") throw new Error("expected local refresh");
  const args = bindNativeExecutionValue(result.arguments, local);
  expect(args).toEqual(readArguments);
  expect(resolveComputerUseHostToolRequest(result.tool, args)).not.toBeNull();
});

test("refresh cannot reuse a mutation, withdrawn read, incompatible schema or absent scope", async () => {
  const read = capabilities().find(row => row.name === "computer_observe")!;
  for (const [exposed, prior, readArguments] of [
    [capabilities(), "computer_do", { operation: { kind: "launch_app", app: { name: "Sketchpad" } } }],
    [capabilities().filter(row => row.name !== "computer_observe"), "computer_observe", { operation: "desktop_state" }],
    [[read], "computer_observe", { operation: "made_up" }],
    [[read], "computer_observe", undefined],
  ] as const) {
    const result = await selectNativeOperation({ capabilities: exposed, roots: { ...roots, ...(readArguments ? { readArguments } : {}) },
      state: { lastRead: { tool: prior } }, modelId: "fixture", signal, choose: async input => answer(input, "reobserve") });
    expect(result.kind).toBe("genie");
  }
});

test("refresh remains a supported read for future schemas without an operation allowlist", async () => {
  const readArguments = { resource: "retained exact scope", mode: "inspect" };
  const custom: NativeBindingCapability = { name: "future_read", description: "Inspect a future resource", effectClass: "read",
    schema: { type: "object", properties: { resource: { type: "string" }, mode: { const: "inspect" } }, required: ["resource", "mode"], additionalProperties: false } };
  const result = await selectNativeOperation({ capabilities: [custom], roots: { ...roots, readArguments },
    state: { lastRead: { tool: custom.name }, unresolvedEffects: [{ completion: "unknown" }] }, modelId: "fixture", signal,
    choose: async input => answer(input, "reobserve") });
  expect(result.kind).toBe("call");
  if (result.kind !== "call") throw new Error("expected local refresh");
  expect(result.tool).toBe(custom.name);
  expect(bindNativeExecutionValue(result.arguments, { ...roots, readArguments })).toEqual(readArguments);
});
