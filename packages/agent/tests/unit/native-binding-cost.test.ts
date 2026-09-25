import { expect, test } from "bun:test";
import { selectNativeOperation } from "../../src/graph/native-operation-binding";
import { bindNativeExecutionValue } from "../../src/graph/native-execution";
import { activeComputerUseHostToolDefinitions, resolveComputerUseHostToolRequest } from "../../src/config/computer-use-catalogue/host-tool-admission";
import type { ChoiceInput, ChoiceResult } from "../../src/providers/choice";
import type { DecisionAnswer, DecisionInput, DecisionResult } from "../../src/providers/decision";

const text = "Keep these exact bytes: café — 27% ✅\r\n";
const context = `dctx_${"a".repeat(43)}`;

function choiceResult(input: ChoiceInput, selectedId: string): ChoiceResult {
  return { selectedId, requestedModelId: input.modelId, resolvedModelId: input.modelId,
    usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null } };
}

function decisionResult(input: DecisionInput, answers: DecisionResult["answers"]): DecisionResult {
  return { requestedModelId: input.modelId, resolvedModelId: input.modelId,
    usage: { inputTokens: 1, outputTokens: 1, actualCostUsd: null }, answers };
}

function sourceIds(choice: ChoiceInput["choices"][number], input: ChoiceInput): string[] {
  try {
    const row = JSON.parse(choice.description) as Record<string, unknown>;
    return Object.entries(row).filter(([key, value]) => key !== "action" && typeof value === "string")
      .map(([, value]) => value as string)
      .filter(id => Object.hasOwn((input.state as { bindingSources?: Record<string, string> }).bindingSources ?? {}, id));
  } catch {
    return [];
  }
}

function targetIndex(choice: ChoiceInput["choices"][number], input: ChoiceInput): number | null {
  const sources = (input.state as { bindingSources?: Record<string, string> }).bindingSources ?? {};
  for (const id of sourceIds(choice, input)) {
    const match = sources[id]?.match(/"id":"control-(\d+)"/);
    if (match) return Number(match[1]);
  }
  return null;
}

function suppliedText(choice: ChoiceInput["choices"][number], input: ChoiceInput): boolean {
  const sources = (input.state as { bindingSources?: Record<string, string> }).bindingSources ?? {};
  return sourceIds(choice, input).some(id => sources[id] === "supplied text");
}

async function exercise(count: number) {
  const targets = Array.from({ length: count }, (_, index) => ({
    version: 1,
    context,
    reference: `detgt_${String(index).padStart(43, "0")}`,
  }));
  const roots = {
    request: "Insert the supplied text in the intended text area",
    values: { text },
    observation: { controlCollection: { controls: targets.map((target, index) => ({
      id: `control-${index}`,
      role: index % 2 === 0 ? "text_area" : "text_field",
      label: index === count - 1 ? "Target document body" : `Observed text surface ${index}`,
      target,
    })) } },
  };
  const capability = activeComputerUseHostToolDefinitions().find(row => row.name === "computer_do");
  if (!capability) throw new Error("active computer_do catalogue entry is required");

  const choiceStages: string[] = [];
  const screenedTargetIndices = new Set<number>();
  let decisionCalls = 0;
  let optionalQuestions = 0;
  const result = await selectNativeOperation({
    capabilities: [{ name: capability.name, description: capability.entry.projection.modelDescription,
      effectClass: capability.entry.descriptor.effectClass, schema: capability.entry.publicSchemas.input.jsonSchema }],
    roots,
    state: {},
    modelId: "flash-must-not-be-used",
    signal: new AbortController().signal,
    choose: async () => { throw new Error("Flash choose transport must not be called"); },
    operationDecision: { modelId: "jev-fixture", maxChoices: count > 256 ? 32 : 256, choose: async input => {
      const state = input.state as { question?: string };
      const question = state.question ?? "";
      choiceStages.push(question);
      if (question.startsWith("Select the next useful operation")) {
        const customize = input.choices.find(row => row.description.includes('"type_text"') && row.description.includes("select/customize inputs"));
        if (customize) return choiceResult(input, customize.id);
        if (input.instructions.includes("This is a screening group")) return choiceResult(input, "none_in_group");
        throw new Error("catalogue type_text customize operation not offered");
      }

      if (!question.startsWith("Bind computer_do.operation.target")) {
        const omitted = input.choices.find(row => row.description.startsWith("Omit this optional input"));
        if (omitted) return choiceResult(input, omitted.id);
        const textChoice = input.choices.find(row => suppliedText(row, input));
        if (textChoice) return choiceResult(input, textChoice.id);
        throw new Error(`unexpected Choice binding question: ${question}`);
      }

      const screening = input.instructions.includes("This is a screening group");
      for (const row of input.choices) {
        const index = targetIndex(row, input);
        if (index !== null) screenedTargetIndices.add(index);
      }
      const lastTarget = input.choices.find(row => targetIndex(row, input) === count - 1);
      if (lastTarget) return choiceResult(input, lastTarget.id);
      if (screening) return choiceResult(input, "none_in_group");
      throw new Error("late target was not retained through Choice reduction");
    } },
    inputDecision: { modelId: "jev-fixture", maxChoices: 256, decide: async input => {
      decisionCalls++;
      const state = input.state as { bindingSources: Record<string, string> };
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(input.questions)) {
        if (question.type !== "choice") throw new Error("expected typed choice question");
        if (typeof question.instructions !== "string") throw new Error("expected text choice instructions");
        if (question.instructions.includes(".delayMs ") || question.instructions.includes(".deliveryMode ")) optionalQuestions++;
        const criteria = question.criteria;
        const matchesSource = (key: string, predicate: (source: string) => boolean) => {
          const value = criteria[key];
          if (typeof value !== "string") return false;
          const bindings = (JSON.parse(value) as { bindings: Record<string, string> }).bindings;
          return Object.values(bindings).some(predicate);
        };
        let selected: string | undefined = Object.keys(criteria).find(key => key === "omit");
        if (question.instructions.includes(".target ")) {
          selected = Object.keys(criteria).find(key => key.startsWith("input_")
            && matchesSource(key, source => state.bindingSources[source]?.includes(`"id":"control-${count - 1}"`) === true));
        } else if (question.instructions.includes(".text ")) {
          selected = Object.keys(criteria).find(key => key.startsWith("input_")
            && matchesSource(key, source => state.bindingSources[source] === "supplied text"));
        }
        if (!selected) throw new Error(`no issued decision for ${question.instructions}`);
        answers[id] = { type: "choice", choice: selected, confidence: 1, probabilities: { [selected]: 1 } };
      }
      return decisionResult(input, answers);
    } },
  });

  expect(result.kind).toBe("call");
  if (result.kind !== "call") throw new Error("expected native proposal");
  const resolved = bindNativeExecutionValue(result.arguments, roots);
  expect(resolved).toEqual({ operation: { kind: "type_text", target: targets[count - 1], text } });
  expect(resolveComputerUseHostToolRequest(result.tool, resolved)).not.toBeNull();
  expect(decisionCalls).toBe(count <= 256 ? 1 : 0);
  if (count <= 256) {
    expect(optionalQuestions).toBe(2);
    expect(choiceStages.filter(question => question.startsWith("Bind computer_do.operation."))).toHaveLength(0);
  } else {
    expect([...screenedTargetIndices].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(choiceStages.some(question => question.startsWith("Bind computer_do.operation.target"))).toBe(true);
  }
  return { choiceStages, decisionCalls, optionalQuestions };
}

test("catalogue type_text binding cost stays routed and full coverage from one through six hundred targets", async () => {
  const small = await exercise(1);
  const enriched = await exercise(200);
  const reduced = await exercise(600);

  expect(small.decisionCalls).toBe(1);
  expect(enriched.decisionCalls).toBe(1);
  expect(reduced.decisionCalls).toBe(0);
  expect(enriched.optionalQuestions).toBe(2);
  expect(reduced.choiceStages.some(question => question.startsWith("Bind computer_do.operation.target"))).toBe(true);
});
