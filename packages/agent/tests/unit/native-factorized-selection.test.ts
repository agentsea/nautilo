import { expect, test } from "bun:test";
import { projectNativeFactors, selectNativeFactorized } from "../../scripts/native-factorized-selection";
import type { NativeDecisionCandidate } from "../../src/graph/native-decision";
import type { DecisionInput, DecisionResult } from "../../src/providers/decision";
import type { ChoiceInput } from "../../src/providers/choice";
import { ChoiceRequestError } from "../../src/providers/choice";

const receipt = { requestedModelId: "fixture", resolvedModelId: "fixture", usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null } };
function action(id: string, controlId: string, value: string, mode = "background"): NativeDecisionCandidate {
  return { id, controlId, description: JSON.stringify({ purpose: "Write the supplied input", control: controlId,
    operation: { kind: "type_text", deliveryMode: mode, suppliedValue: value } }),
    call: { name: "computer_do", args: { operation: { kind: "type_text", target: `private-${id}`, text: `literal-${value}` } } } };
}
const escapes = ["reobserve", "defer_to_genie", "request_replan"].map(id => ({ id, description: id, call: null }));
function setup(candidates: NativeDecisionCandidate[]) {
  const input: ChoiceInput = { modelId: "fixture", signal: new AbortController().signal, state: "fixture", instructions: "choose", choices: candidates };
  return { input, candidates, maxChoices: 255, supportsMultipleQuestions: true,
    choose: async (i: ChoiceInput) => ({ ...receipt, selectedId: i.choices.at(-1)!.id }),
    decide: async (_i: DecisionInput): Promise<DecisionResult> => { throw new Error("unexpected decision"); } };
}
function answers(candidates: NativeDecisionCandidate[], id: string): DecisionResult {
  const row = projectNativeFactors(candidates).bindings.find(row => row.id === id)!;
  return { ...receipt, answers: Object.fromEntries(["action", "target", "value"].map(axis => [axis, {
    type: "choice", choice: row[axis as "action"], confidence: 1, probabilities: {},
  }])) };
}
test("returns original candidate without reconstructing or changing exact input", async () => {
  const candidates = [action("a", "c1", "first"), action("b", "c2", "second"), ...escapes];
  const before = structuredClone(candidates);
  const result = await selectNativeFactorized({ ...setup(candidates), decide: async () => answers(candidates, "b") });
  expect(result).toEqual({ selectedId: "b", path: "factorized", fallbackReason: null });
  expect(candidates).toEqual(before);
  expect(JSON.stringify(projectNativeFactors(candidates))).not.toContain("private-b");
  expect(JSON.stringify(projectNativeFactors(candidates))).not.toContain("literal-second");
});
test("fixed delivery modes remain separate templates", () => {
  const p = projectNativeFactors([action("a", "c1", "x"), action("b", "c1", "x", "foreground")]);
  expect(p.bindings[0]!.action).not.toBe(p.bindings[1]!.action);
});
test("factor questions preserve the caller's exact action instructions", async () => {
  const candidates = [action("a", "c1", "x"), ...escapes]; const options = setup(candidates);
  await selectNativeFactorized({ ...options, input: { ...options.input, instructions: "The insertion itself focuses the field; do not pre-click." }, decide: async input => {
    for (const q of Object.values(input.questions)) expect(q.instructions).toContain("The insertion itself focuses the field; do not pre-click.");
    return answers(candidates, "a");
  } });
});
test("incompatible heads cannot create a new operation", async () => {
  const candidates = [action("a", "c1", "first"), action("b", "c2", "second"), ...escapes];
  const mixed = answers(candidates, "a");
  const result = await selectNativeFactorized({ ...setup(candidates), decide: async () => ({ ...mixed,
    answers: { ...mixed.answers, value: answers(candidates, "b").answers["value"]! } }) });
  expect(result.path).toBe("complete_choice");
  expect(result.fallbackReason).toBe("incompatible_or_ambiguous_factors");
});
test("ambiguous exact tuples fall back; no first-match shortcut", async () => {
  const candidates = [action("a", "c1", "first"), action("b", "c1", "first"), ...escapes];
  expect((await selectNativeFactorized({ ...setup(candidates), decide: async () => answers(candidates, "a") })).path).toBe("complete_choice");
});
test("recovery choices survive factorization", async () => {
  const candidates = [action("a", "c1", "x"), ...escapes];
  expect((await selectNativeFactorized({ ...setup(candidates), decide: async () => answers(candidates, "request_replan") })).selectedId).toBe("request_replan");
});
test("1000 controls retain late winner and screen every candidate within catalogue bound", async () => {
  const candidates = [...Array.from({ length: 1000 }, (_, n) => action(`a${n}`, `c${n}`, "text")), ...escapes];
  const seen = new Set<string>(); let calls = 0;
  const result = await selectNativeFactorized({ ...setup(candidates), choose: async input => {
    calls++; expect(input.choices.length).toBeLessThanOrEqual(255);
    input.choices.forEach(c => seen.add(c.id));
    return { ...receipt, selectedId: input.choices.some(c => c.id === "a999") ? "a999" : "none_in_group" };
  } });
  expect(result.selectedId).toBe("a999"); expect(calls).toBe(5);
  for (const c of candidates) expect(seen.has(c.id)).toBe(true);
});
test("all-NONE screening retains recovery rather than inventing completion", async () => {
  const candidates = [...Array.from({ length: 600 }, (_, n) => action(`a${n}`, `c${n}`, "text")), ...escapes];
  const result = await selectNativeFactorized({ ...setup(candidates), choose: async input => ({ ...receipt,
    selectedId: input.choices.some(c => c.id === "none_in_group") ? "none_in_group" : "defer_to_genie" }) });
  expect(result.selectedId).toBe("defer_to_genie");
});
test("unsupported batch and context overflow use complete selector", async () => {
  const candidates = [action("a", "c1", "x"), ...escapes];
  expect((await selectNativeFactorized({ ...setup(candidates), supportsMultipleQuestions: false })).fallbackReason).toBe("multiple_questions_unsupported");
  expect((await selectNativeFactorized({ ...setup(candidates), decide: async () => { throw new ChoiceRequestError("context_length_exceeded"); } })).fallbackReason).toBe("factor_context_overflow");
});
test("cancelled late answer cannot become a selected action", async () => {
  const candidates = [action("a", "c1", "x"), ...escapes]; const options = setup(candidates); const controller = new AbortController();
  expect(await selectNativeFactorized({ ...options, input: { ...options.input, signal: controller.signal }, decide: async () => {
    controller.abort(); return answers(candidates, "a");
  } }).catch((error: unknown) => error)).toMatchObject({ code: "cancelled" });
});
test("different candidate descriptions cannot replace the original selector menu", async () => {
  const candidates = [action("a", "c1", "x"), ...escapes]; const options = setup(candidates);
  expect(await selectNativeFactorized({ ...options, input: { ...options.input, choices: options.input.choices.map(c => ({ ...c, description: "changed" })) } }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_request" });
});
