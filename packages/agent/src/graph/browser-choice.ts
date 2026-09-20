import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../providers/choice";

const NONE_IN_GROUP = {
  id: "none_in_group",
  description: "None of this group's actions is an appropriate next step. Other groups may contain the right action; this does not declare the task complete.",
};
export const BROWSER_DECISION_CONTROL_IDS = ["reobserve", "defer_to_genie", "completion_ready", "needs_visual_evidence", "needs_input"] as const;

/** Screening never executes actions. All rounds share the original observation. */
export async function chooseBrowserAction(
  input: ChoiceInput,
  maxChoices: number,
  choose: (input: ChoiceInput) => Promise<ChoiceResult>,
  options?: { controlIds: readonly string[] },
): Promise<ChoiceResult & { choiceCalls: number; screeningRounds: number }> {
  const controlIds = new Set<string>(options?.controlIds ?? BROWSER_DECISION_CONTROL_IDS);
  const controls = input.choices.filter(({ id }) => controlIds.has(id));
  if (!Number.isSafeInteger(maxChoices) || maxChoices < 3 || maxChoices < controls.length
    || (maxChoices === controls.length && input.choices.length > maxChoices)) {
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
  for (;;) {
    if (finalists.length <= maxChoices) {
      try {
        const result = await invoke({ ...input, choices: finalists });
        return { ...result, usage: { inputTokens, outputTokens, actualCostUsd }, choiceCalls, screeningRounds };
      } catch (error) {
        if (!(error instanceof ChoiceRequestError) || error.code !== "context_length_exceeded") throw error;
      }
    }
    if (!controls.some(({ id }) => id === "reobserve") || !controls.some(({ id }) => id === "defer_to_genie")
      || input.choices.some(({ id }) => id === NONE_IN_GROUP.id)) throw new ChoiceRequestError("invalid_request");
    const nominees = finalists.filter(({ id }) => !controlIds.has(id));
    if (nominees.length <= 1) throw new ChoiceRequestError("context_length_exceeded");
    screeningRounds += 1;
    // Count overflow uses the catalog bound. Text overflow divides the rejected
    // candidate set; every candidate still gets screened against the same state.
    const groupWidth = finalists.length > maxChoices ? maxChoices - 1 : Math.ceil(nominees.length / 2);
    const roundController = new AbortController();
    const signal = AbortSignal.any([input.signal, roundController.signal]);
    let failed = false;
    let failure: unknown;
    const screen = async (group: ChoiceInput["choices"]): Promise<ChoiceInput["choices"]> => {
      try {
        try {
          const result = await invoke({ ...input, signal,
            instructions: `${input.instructions}\nThis is a screening group, not execution. Nominate the best appropriate next action from this group, or none_in_group if none is appropriate. Other groups may contain better choices. Do not nominate an action merely because it is the least bad option.`,
            choices: [...group, NONE_IN_GROUP],
          });
          const candidate = group.find(({ id }) => id === result.selectedId);
          return candidate ? [candidate] : [];
        } catch (error) {
          if (!(error instanceof ChoiceRequestError) || error.code !== "context_length_exceeded" || group.length <= 1) throw error;
          const midpoint = Math.ceil(group.length / 2);
          const halves = await Promise.allSettled([screen(group.slice(0, midpoint)), screen(group.slice(midpoint))]);
          if (failed) throw failure;
          return halves.flatMap((entry) => entry.status === "fulfilled" ? entry.value : []);
        }
      } catch (error) {
        if (!failed) { failed = true; failure = error; roundController.abort(); }
        throw error;
      }
    };
    const groups: ChoiceInput["choices"][] = [];
    for (let offset = 0; offset < nominees.length; offset += groupWidth) groups.push(nominees.slice(offset, offset + groupWidth));
    const settled = await Promise.allSettled(groups.map(screen));
    assertActive();
    if (failed) throw failure;
    const screened = settled.flatMap((entry) => entry.status === "fulfilled" ? entry.value : []);
    // No reduction means the provider cannot fit the necessary state/controls.
    // Do not loop indefinitely or discard candidates to fabricate a fit.
    if (screened.length >= nominees.length) throw new ChoiceRequestError("context_length_exceeded");
    finalists = [...screened, ...controls];
  }
}
