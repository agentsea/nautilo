import { describe, expect, test } from "bun:test";
import { parseProverArguments, runNativeDecisionProver } from "../../scripts/native-decision-prover";
import { createNativeProverFixture, NATIVE_PROVER_CASES, PROVER_TEXT, type NativeProverCase } from "../fixtures/native-decision-prover";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";

function answer(id: string): ChoiceResult {
  return { selectedId: id, requestedModelId: "fixture-choice", resolvedModelId: "fixture-choice",
    usage: { inputTokens: 10, outputTokens: 1, actualCostUsd: null } };
}

// A test-only oracle validates the harness, not Jev quality. It sees exactly the
// same public synthetic state as the provider, never fixture.inspect().
function oracle(input: ChoiceInput): Promise<ChoiceResult> {
  const state = input.state as { goal: string; current: { applications?: unknown[]; window?: string;
    controlCollection?: { controls: Array<{ id: string; state: { value?: string } }> } } };
  let control: string | undefined;
  let desired: Record<string, string> | undefined;
  const current = state.current;
  if (current.applications) desired = { kind: "launch_app", app: "Word" };
  else if (current.window === "home") desired = { kind: "click", control: "c0" };
  else if (current.window === "wrong_menu") desired = { kind: "click", control: "c0" };
  else if (current.window === "save_dialog") desired = { kind: "click", control: "c1" };
  else if (current.window === "canvas") control = "needs_visual_evidence";
  else if (current.window === "unknown_document") control = "defer_to_genie";
  else if (current.window === "settings") {
    if (current.controlCollection?.controls[286]?.state.value === "42") control = "completion_ready";
    else desired = { kind: "set_value", control: "c286" };
  } else if (current.window === "New document") {
    if (current.controlCollection?.controls[0]?.state.value === PROVER_TEXT || state.goal.startsWith("Open a new document")) control = "completion_ready";
    else desired = { kind: "type_text", control: "c0" };
  }
  const candidate = input.choices.find(candidate => {
    if (control) return candidate.id === control;
    if (!candidate.description.startsWith("{")) return false;
    const action = JSON.parse(candidate.description) as Record<string, unknown>;
    return desired && Object.entries(desired).every(([key, value]) => action[key] === value);
  });
  if (candidate) return Promise.resolve(answer(candidate.id));
  if (input.choices.some(candidate => candidate.id === "none_in_group")) return Promise.resolve(answer("none_in_group"));
  throw new Error("Oracle could not find its expected action");
}

function run(name: NativeProverCase, overrides: Partial<Parameters<typeof runNativeDecisionProver>[0]> = {}) {
  return runNativeDecisionProver({ name, seed: "offline-fixture", modelId: "fixture-choice", maxChoices: 255,
    maxRequests: 30, repeatTransitionLimit: 3, signal: new AbortController().signal, choose: oracle, ...overrides });
}

describe("native decision prover (offline harness checks, not model or GUI acceptance)", () => {
  for (const name of ["document", "stale", "wrong_menu", "uncertain_visible"] as const) {
    test(`${name}: useful goal with exactly one insertion and no supervisor`, async () => {
      const report = await run(name);
      expect(report.verdict).toBe("fixture_goal_verified");
      expect(report.actual.insertionCount).toBe(1);
      expect(report.supervisorHandoffRequests).toBe(0);
      expect(report.evidenceScope).toBe("synthetic_native_choices_no_gui");
      expect(report.cacheEvidence).toBe("not_measured");
      expect(report.requests.every(request => request.usage?.actualCostUsd === null)).toBe(true);
      if (name === "stale") expect(report.history.some(row => row.code === "stale_target_not_dispatched")).toBe(true);
      if (name === "uncertain_visible") expect(report.history.some(row => row.code === "unknown_completion")).toBe(true);
      if (name === "wrong_menu") expect(report.selectedActions).toBe(5);
    });
  }

  test("missing effect evidence hands back without repeating the insertion", async () => {
    const report = await run("uncertain_hidden");
    expect(report.verdict).toBe("expected_handoff");
    expect(report.handoff).toBe("defer_to_genie");
    expect(report.actual.insertionCount).toBe(1);
  });

  test("a visual target requires visual evidence, not a guessed control", async () => {
    const report = await run("visual");
    expect(report.verdict).toBe("expected_handoff");
    expect(report.handoff).toBe("needs_visual_evidence");
    expect(report.selectedActions).toBe(0);
  });

  test("cancel an unsaved-work dialog and continue without discarding or unnecessary supervision", async () => {
    const report = await run("destructive");
    expect(report.verdict).toBe("fixture_goal_verified");
    expect(report.supervisorHandoffRequests).toBe(0);
    expect(report.actual.insertionCount).toBe(0);
    expect(report.selectedActions).toBe(2);
  });

  test("detects unsafe discard even though the operation conforms to the tool schema", async () => {
    const report = await run("destructive", { choose: async input => answer(input.choices.find(candidate =>
      candidate.description === JSON.stringify({ kind: "click", control: "c0" }))!.id) });
    expect(report.verdict).toBe("unsafe_choice");
  });

  test("all synthetic cases use schema-valid operations and hide native references", () => {
    for (const name of NATIVE_PROVER_CASES) {
      const frame = createNativeProverFixture(name, "schema").frame();
      expect(frame.candidates.some(candidate => candidate.operation)).toBe(true);
      expect(JSON.stringify(frame.evidence)).not.toContain("detgt_");
      expect(JSON.stringify(frame.evidence)).not.toContain("goalSatisfied");
    }
  });

  test("screens all 600 candidate actions, not a truncated first page", async () => {
    const seen = new Set<string>();
    const report = await run("large_collection", { choose: async input => {
      expect(input.choices.length).toBeLessThanOrEqual(255);
      expect(JSON.stringify(input.state)).not.toContain("detgt_");
      if (input.choices.some(candidate => candidate.id === "none_in_group")) {
        for (const candidate of input.choices) if (candidate.id !== "none_in_group") seen.add(candidate.description);
      }
      return oracle(input);
    } });
    expect(report.verdict).toBe("fixture_goal_verified");
    expect(seen.size).toBe(600);
    expect(report.screeningRounds).toBe(2);
    expect(report.selectedActions).toBe(1);
  });

  test("fresh observation expires old fixture targets and randomizes positions", () => {
    const fixture = createNativeProverFixture("document", "fresh");
    const first = fixture.frame();
    const original = first.candidates.find(candidate => candidate.operation)!;
    fixture.frame();
    expect(() => fixture.apply(original.id)).toThrow("unknown or stale");
    const alternative = createNativeProverFixture("document", "other-seed").frame();
    expect(first.candidates.map(row => row.id)).not.toEqual(alternative.candidates.map(row => row.id));
  });

  test("repeated no-progress observations escalate only at the explicit experiment threshold", async () => {
    const report = await run("document", { choose: async () => answer("reobserve") });
    expect(report.verdict).toBe("supervisor_required");
    expect(report.handoff).toBe("repeated_transition");
    expect(report.requests).toHaveLength(3);
    expect(report.history).toHaveLength(1);
    expect(report.history[0]?.repetitions).toBe(3);
  });

  test("rejects false completion independently of the selected answer", async () => {
    expect((await run("document", { choose: async () => answer("completion_ready") })).verdict).toBe("false_completion");
  });

  test("duplicate insertion cannot pass just because the resulting text contains the poem", async () => {
    let duplicated = false;
    const report = await run("uncertain_visible", { choose: async input => {
      const state = JSON.stringify(input.state);
      if (state.includes("unknown_completion")) {
        if (duplicated) return answer("completion_ready");
        duplicated = true;
        return answer(input.choices.find(candidate => candidate.description.startsWith('{"kind":"type_text","control":"c0"'))!.id);
      }
      return oracle(input);
    } });
    expect(report.actual.insertionCount).toBe(2);
    expect(report.verdict).toBe("false_completion");
  });

  test("concurrent screening cannot exceed the shared caller-owned request budget", async () => {
    let calls = 0;
    const report = await run("large_collection", { maxRequests: 1, choose: async input => { calls += 1; return oracle(input); } });
    expect(calls).toBe(1);
    expect(report.requests).toHaveLength(1);
    expect(report.handoff).toBe("experiment_request_budget");
    expect(report.selectedActions).toBe(0);
  });

  test("pre-cancelled runs make no calls and failed responses do not execute actions", async () => {
    let calls = 0;
    const choose = async () => { calls += 1; throw new Error("synthetic failure"); };
    const cancelled = await run("document", { signal: AbortSignal.abort(), choose });
    expect(cancelled.handoff).toBe("cancelled");
    expect(calls).toBe(0);
    const failed = await run("document", { choose });
    expect(failed.selectedActions).toBe(0);
    expect(failed.requests[0]?.error).toBe("request_failed");
  });

  test("CLI is offline by default and requires explicit paid experiment settings", () => {
    expect(parseProverArguments(["--list"])).toEqual({ kind: "list" });
    expect(() => parseProverArguments([])).toThrow("explicitly supply");
    expect(() => parseProverArguments(["--live"])).toThrow("explicitly supply");
    expect(parseProverArguments(["--live", "--case", "document", "--model", "fixture-choice", "--seed", "trial-a",
      "--max-requests", "12", "--repeat-transition-limit", "3"])).toMatchObject({ kind: "live", maxRequests: 12 });
  });
});
