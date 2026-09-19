import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../providers/choice";

const NONE_IN_GROUP = {
  id: "none_in_group",
  description: "None of this group's actions is an appropriate next step. Other groups may contain the right action; this does not declare the task complete.",
};
const CONTROL_IDS = new Set(["reobserve", "defer_to_genie"]);

/** Screening never executes actions. All rounds share the original observation. */
export async function chooseBrowserAction(
  input: ChoiceInput,
  maxChoices: number,
  choose: (input: ChoiceInput) => Promise<ChoiceResult>,
): Promise<ChoiceResult & { choiceCalls: number; screeningRounds: number }> {
  if (!Number.isSafeInteger(maxChoices) || maxChoices < CONTROL_IDS.size + 1) {
    throw new ChoiceRequestError("invalid_request");
  }
  let choiceCalls = 0;
  let screeningRounds = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let actualCostUsd: number | null = 0;
  const assertActive = () => {
    if (input.signal.aborted) throw new ChoiceRequestError("cancelled");
  };
  const invoke = async (request: ChoiceInput): Promise<ChoiceResult> => {
    assertActive();
    choiceCalls += 1;
    const result = await choose(request);
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    actualCostUsd = actualCostUsd === null || result.usage.actualCostUsd === null
      ? null : actualCostUsd + result.usage.actualCostUsd;
    assertActive();
    if (!request.choices.some(({ id }) => id === result.selectedId)) {
      throw new ChoiceRequestError("invalid_response");
    }
    return result;
  };
  let finalists = input.choices;
  if (finalists.length > maxChoices) {
    const controls = input.choices.filter(({ id }) => CONTROL_IDS.has(id));
    if (controls.length !== CONTROL_IDS.size || input.choices.some(({ id }) => id === NONE_IN_GROUP.id)) {
      throw new ChoiceRequestError("invalid_request");
    }
    let nominees = input.choices.filter(({ id }) => !CONTROL_IDS.has(id));
    const groupWidth = maxChoices - 1; // Reserve one slot for the local abstention.
    while (nominees.length + controls.length > maxChoices) {
      screeningRounds += 1;
      const groups: ChoiceInput["choices"][] = [];
      for (let offset = 0; offset < nominees.length; offset += groupWidth) {
        groups.push(nominees.slice(offset, offset + groupWidth));
      }
      const roundController = new AbortController();
      const signal = AbortSignal.any([input.signal, roundController.signal]);
      let failed = false;
      let failure: unknown;
      const settled = await Promise.allSettled(groups.map(async (group) => {
        try {
          const result = await invoke({
            ...input,
            signal,
            instructions: `${input.instructions}\nThis is a screening group, not execution. Nominate the best appropriate next action from this group, or none_in_group if none is appropriate. Other groups may contain better choices. Do not nominate an action merely because it is the least bad option.`,
            choices: [...group, NONE_IN_GROUP],
          });
          return group.find(({ id }) => id === result.selectedId);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
            roundController.abort();
          }
          throw error;
        }
      }));
      assertActive();
      if (failed) throw failure;
      nominees = settled.flatMap((entry) => entry.status === "fulfilled" && entry.value ? [entry.value] : []);
    }
    finalists = [...nominees, ...controls];
  }
  const result = await invoke({ ...input, choices: finalists });
  return {
    ...result,
    usage: { inputTokens, outputTokens, actualCostUsd },
    choiceCalls,
    screeningRounds,
  };
}
