import { chooseBrowserAction } from "./browser-choice";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../providers/choice";
import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";

export interface ChoicePresentation {
  /** Public semantics only: never executable handles or authored payloads. */
  template: Record<string, unknown>;
  bindings?: Record<string, unknown>;
}

/** Share operation semantics once, including in reducer groups and finalists.
 * IDs still resolve to the caller's original private values. */
export function createChoiceMenuProjector(candidates: readonly { id: string; presentation?: ChoicePresentation }[]) {
  const templates = new Map<string, { id: string; value: Record<string, unknown> }>();
  const byId = new Map<string, { template: string; bindings: Record<string, unknown> }>();
  for (const candidate of candidates) {
    if (!candidate.presentation) continue;
    const key = JSON.stringify(canonicalizeComputerUseJson(candidate.presentation.template));
    let template = templates.get(key);
    if (!template) {
      template = { id: `t${templates.size}`, value: candidate.presentation.template };
      templates.set(key, template);
    }
    byId.set(candidate.id, { template: template.id, bindings: candidate.presentation.bindings ?? {} });
  }
  return (input: ChoiceInput): ChoiceInput => {
    if (!byId.size) return input;
    const used = new Set<string>();
    const choices = input.choices.map(choice => {
      const candidate = byId.get(choice.id);
      if (!candidate) return choice;
      used.add(candidate.template);
      return { id: choice.id, description: JSON.stringify({ ...candidate.bindings, action: candidate.template }) };
    });
    return { ...input, choices,
      instructions: input.instructions + " Each choice's action refers to actionTemplates; its remaining fields refer to the supplied state evidence. These are fully bound choices, not requests to compose arguments. Select the choice ID, never a template or input ID.",
      state: { ...(input.state as Record<string, unknown>),
        actionTemplates: [...templates.values()].filter(template => used.has(template.id)).map(({ id, value }) => ({ ...value, id })) },
    };
  };
}

export interface BoundChoice<T> {
  id: string;
  description: string;
  /** Only this candidate's public evidence, never its private arguments. */
  evidence?: unknown;
  presentation?: ChoicePresentation;
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
  const project = createChoiceMenuProjector(options.choices);
  const result = await chooseBrowserAction({
    modelId: options.modelId, instructions: options.instructions, state: options.state,
    choices: options.choices.map(({ id, description }) => ({ id, description })), signal: options.signal,
  }, options.maxChoices ?? Math.max(options.choices.length, 3), async input => {
    // Full candidate state must not be resent in every screening group.
    const evidence = input.choices.flatMap(({ id }) => {
      const candidate = bindings.get(id);
      return candidate?.evidence === undefined ? [] : [{ id, evidence: candidate.evidence }];
    });
    return options.choose(project({ ...input, state: { ...options.state, candidateEvidence: evidence } }));
  }, { controlIds: options.choices.filter(choice => choice.control).map(choice => choice.id) });
  options.signal.throwIfAborted();
  const selected = bindings.get(result.selectedId);
  if (!selected) throw new ChoiceRequestError("invalid_response");
  return { ...result, value: selected.value };
}
