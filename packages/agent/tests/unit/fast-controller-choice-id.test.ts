import { expect, test } from "bun:test";
import { z } from "zod";
import type { ChatModel } from "../../src/providers/types";
import { createChoiceIdDecider } from "../../scripts/fast-controller/choice-model";
import type { Measurement, ModelRequest } from "../../scripts/fast-controller/model";
import { runControllerLab } from "../../scripts/fast-controller/lab";
import { selectBoundChoice } from "../../scripts/fast-controller/selection";
import { nextChoiceContinuation } from "../../src/graph/choice-coverage";

const request = (): ModelRequest => ({ role: "controller", instructions: "Choose the useful action.",
  signal: new AbortController().signal, schema: z.object({ choice: z.string() }).strict(),
  context: { choices: [{ id: "a1_0", description: "Insert the retained original value" },
    { id: "rebuild_choices", description: "No useful action: refresh bindings" }] } });
const fake = (response: unknown): ChatModel => ({ invoke: async () => response });

test("known incomplete menu is repaired before model selection, without replaying launch", async () => {
  const rows: Measurement[] = [];
  const model: ChatModel = { invoke: async messages => {
    const context = JSON.parse(String((messages[1] as { content: string }).content)) as {
      state: { currentUI: { applicationRunning: boolean }; candidateCoverage: { complete: boolean } };
      choices: Array<{ id: string; description: string }>;
    };
    if (context.state.currentUI.applicationRunning) expect(context.state.candidateCoverage.complete).toBe(true);
    return { content: context.choices.find(row => row.description.startsWith(context.state.currentUI.applicationRunning ? "Insert supplied" : "Open Fixture"))!.id };
  } };
  const result = await runControllerLab({ scenario: "incomplete_choices", entry: "controller", automaticCoverage: true, maxRequests: 2,
    signal: new AbortController().signal, decide: createChoiceIdDecider(model, rows) });
  expect(result.phase).toBe("complete"); expect(rows).toHaveLength(2);
  expect(result.actual.insertions).toBe(1); expect(result.state.receipts).toHaveLength(2);
  expect(result.transitions.map(row => row.decision)).toEqual(["act", "automatic_menu_repair", "act"]);
});

test("automatic repair requires an explicit unseen producer continuation, not just partial coverage", () => {
  expect(nextChoiceContinuation({ complete: false, continuation: null }, [])).toEqual({ kind: "none" });
  const continuation = { key: "snapshot:page2", request: { kind: "read" } };
  expect(nextChoiceContinuation({ complete: true, continuation }, [])).toEqual({ kind: "none" });
  expect(nextChoiceContinuation({ complete: false, continuation }, [continuation.key])).toEqual({ kind: "stalled" });
  expect(nextChoiceContinuation({ complete: false, continuation }, [])).toEqual({ kind: "continue", request: continuation.request, attempted: [continuation.key] });
});

test("one ID becomes a code-built decision without tools or generated arguments", async () => {
  const rows: Measurement[] = [];
  const model: ChatModel = { bindTools: () => { throw new Error("must not bind tools"); },
    invoke: async messages => {
      expect(JSON.stringify(messages)).toContain("No JSON");
      return { content: " a1_0\n", usage_metadata: { input_tokens: 120, output_tokens: 4, input_token_details: { cache_read: 100 } } };
    } };
  expect(await createChoiceIdDecider(model, rows)(request())).toEqual({ choice: "a1_0" });
  expect(rows[0]).toMatchObject({ outcome: "valid", inputTokens: 120, outputTokens: 4, cacheReadTokens: 100 });
});

for (const content of ["a0_0", "a1_0 rebuild_choices", '{"choice":"a1_0"}', "Choose a1_0", "`a1_0`", "", "NONE"]) {
  test(`rejects unissued or formatted output: ${JSON.stringify(content)}`, async () => {
    const rows: Measurement[] = [];
    expect(await createChoiceIdDecider(fake({ content }), rows)(request()).catch((error: Error) => error.message)).toBe("invalid_model_decision");
    expect(rows[0]?.outcome).toBe("invalid");
  });
}

test("rejects tools and nontext blocks; accepts only text-block ID", async () => {
  for (const response of [{ content: "a1_0", tool_calls: [{ name: "execute", args: {} }] },
    { content: [{ type: "image", text: "a1_0" }] }]) {
    expect(await createChoiceIdDecider(fake(response), [])(request()).catch((error: Error) => error.message)).toBe("invalid_model_decision");
  }
  expect(await createChoiceIdDecider(fake({ content: [{ type: "text", text: "a1_0" }] }), [])(request())).toEqual({ choice: "a1_0" });
});

test("late cancellation records usage but cannot select an action", async () => {
  const abort = new AbortController();
  const rows: Measurement[] = [];
  const model: ChatModel = { invoke: async () => { abort.abort(); return { content: "a1_0", usage_metadata: { input_tokens: 12 } }; } };
  expect(await createChoiceIdDecider(model, rows)({ ...request(), signal: abort.signal }).catch((error: Error) => error.message)).toBe("cancelled");
  expect(rows[0]).toMatchObject({ inputTokens: 12, outcome: "cancelled" });
});

test("invalid selection is repaired locally before dispatch; missing menu is rebuilt", async () => {
  let attempt = 0;
  const rows: Measurement[] = [];
  const model: ChatModel = { invoke: async messages => {
    const context = JSON.parse(String((messages[1] as { content: string }).content)) as {
      state: { currentUI: { applicationRunning: boolean }; choiceRebuilds: number };
      choices: Array<{ id: string; description: string }>;
    };
    if (attempt++ === 0) return { content: "I will open the editor." };
    const choice = context.choices.find(row => row.description.startsWith(context.state.currentUI.applicationRunning ? "Insert supplied" : "Open Fixture"));
    return { content: choice?.id ?? "rebuild_choices" };
  } };
  const result = await runControllerLab({ scenario: "incomplete_choices", entry: "controller", maxRequests: 4,
    signal: new AbortController().signal, decide: createChoiceIdDecider(model, rows) });
  expect(result.phase).toBe("complete");
  expect(result.requests).toBe(4);
  expect(result.choiceRebuilds).toBe(1);
  expect(result.actual.insertions).toBe(1);
  expect(result.state.receipts).toHaveLength(2);
  expect(rows.map(row => row.outcome)).toEqual(["invalid", "valid", "valid", "valid"]);
});

test("1000 choices retain late candidates and original Unicode/prose bytes without model copying", async () => {
  const original = 'A poem 🌊\n{"choice":"do not interpret this"}\n\tEnd.\r\n';
  const rows: Measurement[] = [];
  const decide = createChoiceIdDecider({ invoke: async messages => {
    expect(JSON.stringify(messages)).not.toContain(original);
    const context = JSON.parse(String((messages[1] as { content: string }).content)) as { choices: Array<{ id: string }> };
    return { content: context.choices.some(row => row.id === "a999") ? "a999" : "none_in_group" };
  } }, rows);
  const choices = Array.from({ length: 1000 }, (_, index) => ({ id: `a${index}`, description: `Insert supplied text into control ${index}`,
    value: { operation: "insert", target: `private-target-${index}`, text: original } }));
  const result = await selectBoundChoice({ modelId: "synthetic", instructions: "Select control 999", state: {},
    choices: [...choices, ...["reobserve", "defer_to_genie"].map(id => ({ id, description: id, control: true,
      value: { operation: id, target: "", text: "" } }))],
    maxChoices: 255, signal: new AbortController().signal,
    choose: async input => {
      const result = z.object({ choice: z.string() }).parse(await decide({ ...request(), signal: input.signal,
        instructions: input.instructions, context: { state: input.state, choices: input.choices } }));
      return { selectedId: result.choice, requestedModelId: input.modelId, resolvedModelId: null,
        usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null } };
    } });
  expect(result.value).toBe(choices[999]!.value);
  expect(Buffer.from(result.value.text)).toEqual(Buffer.from(original));
  expect(rows).toHaveLength(5);
});
