import { expect, test } from "bun:test";
import type { NativeDecisionState } from "../../src/graph/native-decision";
import { nativeExecutionCompletion, nativeExecutionCompletionChoice, nativeExecutionCompletionEvidence,
  settleNativeExecution } from "../../src/graph/native-execution";

const context = `dctx_${"a".repeat(43)}`;
const windowTarget = { version: 1, context, reference: `dtgt_${"b".repeat(43)}` };
const elementTarget = { version: 1, context, reference: `detgt_${"c".repeat(43)}` };
const input = { $valueRef: { source: "values" as const, path: ["body"] } };
const outcome = { version: 1, phase: "observe", retrySafety: "never", stateChangeCertainty: "not_applicable",
  providerCondition: "ready", targetCondition: "current", recovery: [] };

function windowValue(value: string, options: { window?: typeof windowTarget; target?: typeof elementTarget; role?: string;
  parent?: string; duplicate?: boolean; missingParent?: boolean } = {}) {
  const controls = [
    { id: "c0", role: "group", label: options.parent ?? "Document", state: { completeness: "partial" } },
    { id: "c1", parent: options.missingParent ? "c9" : "c0", role: options.role ?? "text_area", label: "Body", target: options.target ?? elementTarget,
      state: { completeness: "partial", value } },
    ...(options.duplicate ? [{ id: "c2", parent: "c0", role: options.role ?? "text_area", label: "Body",
      state: { completeness: "partial", value } }] : []),
  ];
  return { version: 1, operation: "window_state", target: options.window ?? windowTarget,
    evidence: { kind: "window", appLabel: "Editor", windowLabel: "Draft" }, completeness: "partial", degraded: false,
    verification: "indeterminate", controlCollection: { completeness: "partial", received: controls.length, omitted: 0, controls }, outcome };
}

function decision(before: string, body: string): NativeDecisionState {
  return { turnId: "turn", modelId: "choice", plan: { execution: "workflow", goal: "Append the supplied body", constraints: [], actions: [], values: { body } },
    observeArgs: {}, observation: null, phase: "interpret", pending: null, reason: null, generation: 0,
    history: [], unresolved: [], recovery: { limit: 3, events: 0, transitions: [], before: null },
    execution: { request: "Append the supplied body", tools: ["computer_observe", "computer_do"], observation: windowValue(before),
      observationCallId: "before", freshRead: true, mustObserve: false, question: null, boundInputs: [input],
      lastRead: { tool: "computer_observe", arguments: { operation: "window_state", target: windowTarget } } },
  } as NativeDecisionState;
}

function writeAndRead(before: string, body: string, after: string, options: Parameters<typeof windowValue>[1] = {}, settlement = "completed",
  actionTarget = elementTarget, beforeOptions: Parameters<typeof windowValue>[1] = {}) {
  const start = decision(before, body);
  start.execution!.observation = windowValue(before, beforeOptions);
  const written = settleNativeExecution(start, { id: "write", name: "computer_do", args: {
    operation: { kind: "type_text", target: actionTarget, text: body },
  } }, { settlement, result: { completionCertainty: settlement, outcome: { stateChangeCertainty: settlement === "completed" ? "changed" : "unknown" } } });
  return settleNativeExecution(written, { id: "after", name: "computer_observe", args: { operation: "window_state", target: windowTarget } },
    { settlement: "completed", result: windowValue(after, options) });
}

test("same-window semantic append nominates review across rotated element references", () => {
  const before = "A previous paragraph.\n";
  const body = "🐙 exact\nbody";
  const after = before + body;
  const observed = writeAndRead(before, body, after, { target: { ...elementTarget, reference: `detgt_${"d".repeat(43)}` } });
  expect(observed.execution?.textMutation).toBeDefined();
  const choice = nativeExecutionCompletionChoice(observed);
  expect(choice?.checks).toEqual([{ path: ["controlCollection", "controls", 1, "state", "value"],
    comparison: "appends", expected: input, appendBefore: before }]);
  expect(nativeExecutionCompletion(choice!, observed)).toBe(true);
  const evidence = nativeExecutionCompletionEvidence(choice!, { request: observed.execution!.request,
    values: observed.plan.values, observation: observed.execution!.observation });
  const serialized = JSON.stringify(evidence);
  expect(serialized).toContain("identityContinuity");
  expect(serialized).toContain("unproven");
  expect(serialized).not.toContain(body);
  expect(serialized).not.toContain(before);
  expect(serialized).not.toContain(after);
  expect(serialized).not.toContain(elementTarget.reference);
});

test("pre-existing supplied text can be appended exactly once", () => {
  const observed = writeAndRead("prior prior", "prior", "prior priorprior");
  expect(nativeExecutionCompletionChoice(observed)?.checks[0]?.comparison).toBe("appends");
});

test("whole-value equality remains a review fact when no append baseline was observed", () => {
  const body = "exact whole value";
  const observed = writeAndRead("", body, body, {}, "completed",
    { ...elementTarget, reference: `detgt_${"f".repeat(43)}` });
  expect(observed.execution?.textMutation?.before).toBeNull();
  const choice = nativeExecutionCompletionChoice(observed);
  expect(choice?.checks).toEqual([{ path: ["controlCollection", "controls", 1, "state", "value"],
    comparison: "equals", expected: input }]);
  expect(nativeExecutionCompletion(choice!, observed)).toBe(true);
  const evidence = nativeExecutionCompletionEvidence(choice!, { request: observed.execution!.request,
    values: observed.plan.values, observation: observed.execution!.observation });
  expect(evidence.coverage).toBe("matching_fact_context_only");
  expect(evidence.facts[0]).not.toHaveProperty("outcome");
});

test("unusable pre-action scope retains only an ordinary current-value fact", () => {
  const body = "exact whole value";
  for (const beforeOptions of [{ duplicate: true }, { missingParent: true }]) {
    const observed = writeAndRead(body, body, body, {}, "completed", elementTarget, beforeOptions);
    expect(observed.execution?.textMutation?.scope).toBeNull();
    const choice = nativeExecutionCompletionChoice(observed);
    expect(choice?.checks).toEqual([{ path: ["controlCollection", "controls", 1, "state", "value"],
      comparison: "equals", expected: input }]);
    expect(nativeExecutionCompletion(choice!, observed)).toBe(true);
    const evidence = nativeExecutionCompletionEvidence(choice!, { request: observed.execution!.request,
      values: observed.plan.values, observation: observed.execution!.observation });
    expect(evidence.coverage).toBe("matching_fact_context_only");
    expect(evidence.facts[0]).not.toHaveProperty("outcome");
  }
});

test("wrong scope, ambiguous siblings, placement, partial and duplicate deltas cannot nominate append", () => {
  const body = "exact";
  const wrongWindow = { ...windowTarget, reference: `dtgt_${"e".repeat(43)}` };
  for (const [after, options] of [
    ["beforeexact", { window: wrongWindow }], ["beforeexact", { role: "text_field" }],
    ["beforeexact", { parent: "Sidebar" }], ["beforeexact", { duplicate: true }],
    ["exactbefore", {}], ["beforeexac", {}], ["beforeexactexact", {}], ["exact", {}],
  ] as Array<[string, Parameters<typeof windowValue>[1]]>) {
    const observed = writeAndRead("before", body, after, options);
    expect(nativeExecutionCompletionChoice(observed)).toBeUndefined();
  }
  const wrongTarget = writeAndRead("before", body, "beforeexact", {}, "completed",
    { ...elementTarget, reference: `detgt_${"f".repeat(43)}` });
  expect(nativeExecutionCompletionChoice(wrongTarget)).toBeUndefined();
  const missingParent = writeAndRead("before", body, "beforeexact", { missingParent: true });
  expect(nativeExecutionCompletionChoice(missingParent)).toBeUndefined();
});

test("a stale or fabricated append check cannot finish, and unknown effects remain unresolved", () => {
  const observed = writeAndRead("before", "exact", "beforeexact");
  const choice = nativeExecutionCompletionChoice(observed)!;
  expect(nativeExecutionCompletion({ ...choice, checks: [{ ...choice.checks[0]!, appendBefore: "different" }] }, observed)).toBe(false);
  observed.execution!.observation = windowValue("beforeexactexact");
  expect(nativeExecutionCompletion(choice, observed)).toBe(false);
  const unknown = writeAndRead("before", "exact", "beforeexact", {}, "unknown_completion");
  expect(unknown.unresolved).toHaveLength(1);
  expect(nativeExecutionCompletionChoice(unknown)).toBeUndefined();
});
