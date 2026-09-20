import { chooseBrowserAction } from "../../src/graph/browser-choice";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../../src/providers/choice";

export interface BoundChoice<T> {
  id: string;
  description: string;
  /** Only this candidate's public evidence, never its private arguments. */
  evidence?: unknown;
  value: T;
  /** Recovery choices survive every reduction, without competing in groups. */
  control?: boolean;
}

/** Reuses the existing parallel reducer. Selection cannot execute or rebuild
 * arguments. The caller still validates its captured snapshot before dispatch. */
export async function selectBoundChoice<T>(options: {
  modelId: string;
  maxChoices?: number;
  instructions: string;
  state: Record<string, unknown>;
  choices: readonly BoundChoice<T>[];
  signal: AbortSignal;
  choose: (input: ChoiceInput) => Promise<ChoiceResult>;
}) {
  const bindings = new Map(options.choices.map(choice => [choice.id, choice]));
  if (!bindings.size || bindings.size !== options.choices.length || bindings.has("none_in_group")) {
    throw new ChoiceRequestError("invalid_request");
  }
  const result = await chooseBrowserAction({
    modelId: options.modelId, instructions: options.instructions, state: options.state,
    choices: options.choices.map(({ id, description }) => ({ id, description })), signal: options.signal,
  }, options.maxChoices ?? Math.max(options.choices.length, 3), async input => {
    // Full candidate state must not be resent in every screening group.
    const evidence = input.choices.flatMap(({ id }) => {
      const candidate = bindings.get(id);
      return candidate?.evidence === undefined ? [] : [{ id, evidence: candidate.evidence }];
    });
    return options.choose({ ...input, state: { ...options.state, candidateEvidence: evidence } });
  }, { controlIds: options.choices.filter(choice => choice.control).map(choice => choice.id) });
  options.signal.throwIfAborted();
  const selected = bindings.get(result.selectedId);
  if (!selected) throw new ChoiceRequestError("invalid_response");
  return { ...result, value: selected.value };
}
