import { expect, test } from "bun:test";
import { selectBoundChoice, type BoundChoice } from "../../scripts/fast-controller/selection";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../../src/providers/choice";

function answer(input: ChoiceInput, id: string): ChoiceResult {
  return { selectedId: id, requestedModelId: input.modelId, resolvedModelId: input.modelId,
    usage: { inputTokens: 10, outputTokens: 1, actualCostUsd: 0.0001 } };
}
const controls: BoundChoice<unknown>[] = ["reobserve", "defer_to_genie", "rebuild_choices", "request_replan"]
  .map(id => ({ id, description: id, control: true, value: { kind: id } }));
const candidates = (count: number): BoundChoice<unknown>[] => Array.from({ length: count }, (_, index) => ({
  id: `a${index}`, description: `Activate synthetic tab ${index}`, evidence: { title: `Synthetic ${index}` },
  value: { privateAction: "activate", target: `private-target-${index}`, payload: "private-original-input" },
}));
const base = { modelId: "fixture-selector", maxChoices: 255, instructions: "Find the requested tab", state: { goal: "synthetic goal" } };

test("a control-only menu can use its full capacity to rebuild missing choices", async () => {
  const result = await selectBoundChoice({ ...base, maxChoices: controls.length, choices: controls,
    signal: new AbortController().signal, choose: async input => answer(input, "rebuild_choices") });
  expect(result.selectedId).toBe("rebuild_choices"); expect(result.choiceCalls).toBe(1);
});

test("1000 candidates: all screened in parallel, late winner retains exact bound value", async () => {
  const choices = [...candidates(1000), ...controls];
  const seen = new Set<string>();
  let active = 0;
  let peak = 0;
  const result = await selectBoundChoice({ ...base, choices, signal: new AbortController().signal, choose: async input => {
    expect(input.choices.length).toBeLessThanOrEqual(255);
    expect(JSON.stringify(input)).not.toContain("private-");
    active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1;
    const screening = input.choices.some(row => row.id === "none_in_group");
    const state = input.state as { candidateEvidence: Array<{ id: string }> };
    expect(state.candidateEvidence.map(row => row.id)).toEqual(input.choices.filter(row => row.id.startsWith("a")).map(row => row.id));
    if (screening) {
      for (const row of input.choices) if (row.id !== "none_in_group") seen.add(row.id);
    } else for (const control of controls) expect(input.choices.some(row => row.id === control.id)).toBe(true);
    return answer(input, input.choices.some(row => row.id === "a999") ? "a999" : "none_in_group");
  } });
  expect(seen.size).toBe(1000); expect(peak).toBe(4);
  expect(result.choiceCalls).toBe(5); expect(result.screeningRounds).toBe(1);
  expect(result.value).toBe(choices[999]!.value);
  expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 5, actualCostUsd: 0.0005 });
});

test("all-none keeps global rebuild/replan choices rather than declaring completion", async () => {
  const result = await selectBoundChoice({ ...base, choices: [...candidates(1000), ...controls], signal: new AbortController().signal,
    choose: async input => answer(input, input.choices.some(row => row.id === "none_in_group") ? "none_in_group" : "rebuild_choices") });
  expect(result.selectedId).toBe("rebuild_choices"); expect(result.choiceCalls).toBe(5);
});

test("multiple reduction rounds retain every original candidate and recovery choice", async () => {
  const seen = new Set<string>();
  const result = await selectBoundChoice({ ...base, maxChoices: 7, choices: [...candidates(1000), ...controls], signal: new AbortController().signal,
    choose: async input => {
      expect(input.choices.length).toBeLessThanOrEqual(7);
      for (const row of input.choices) if (row.id.startsWith("a")) seen.add(row.id);
      const candidate = input.choices.filter(row => row.id.startsWith("a")).at(-1);
      return answer(input, candidate?.id ?? "request_replan");
    } });
  expect(seen.size).toBe(1000); expect(result.screeningRounds).toBeGreaterThan(1); expect(result.selectedId).toBe("a999");
});

test("context overflow divides groups without resending unrelated evidence", async () => {
  const seen = new Set<string>();
  const result = await selectBoundChoice({ ...base, choices: [...candidates(20), ...controls], signal: new AbortController().signal,
    choose: async input => {
      if (input.choices.length > 8) throw new ChoiceRequestError("context_length_exceeded");
      for (const row of input.choices) if (row.id.startsWith("a")) seen.add(row.id);
      return answer(input, input.choices.some(row => row.id === "a19") ? "a19" : "none_in_group");
    } });
  expect(seen.size).toBe(20); expect(result.selectedId).toBe("a19");
});

test("failed screening cancels siblings, waits for them and never returns a partial winner", async () => {
  let started = 0; let finished = 0;
  const result = selectBoundChoice({ ...base, choices: [...candidates(1000), ...controls], signal: new AbortController().signal,
    choose: async input => {
      const ordinal = started++;
      try {
        if (ordinal === 0) { await Promise.resolve(); throw new ChoiceRequestError("provider_error"); }
        await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        return answer(input, input.choices[0]!.id);
      } finally { finished += 1; }
    } });
  expect(await result.then(() => null, (error: unknown) => error)).toMatchObject({ code: "provider_error" });
  expect(started).toBe(4); expect(finished).toBe(started);
});

test("invalid IDs and cancelled late results cannot resolve a private action", async () => {
  const choices = [...candidates(1), ...controls];
  expect(await selectBoundChoice({ ...base, choices, signal: new AbortController().signal,
    choose: async input => answer(input, "invented") }).then(() => null, (error: unknown) => error)).toMatchObject({ code: "invalid_response" });
  const abort = new AbortController();
  expect(await selectBoundChoice({ ...base, choices, signal: abort.signal,
    choose: async input => { abort.abort(); return answer(input, "a0"); } }).then(() => null, (error: unknown) => error)).toMatchObject({ code: "cancelled" });
});
