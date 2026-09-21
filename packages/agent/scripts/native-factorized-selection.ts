import type { NativeDecisionCandidate } from "../src/graph/native-decision";
import { chooseBrowserAction } from "../src/graph/browser-choice";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "../src/providers/choice";
import type { DecisionInput, DecisionQuestion, DecisionResult } from "../src/providers/decision";

/** Lab-only representation experiment. No actuator and no production routing change. */
export function projectNativeFactors(candidates: readonly NativeDecisionCandidate[]) {
  const templates = new Map<string, string>();
  const targets = new Map<string, string>();
  const values = new Map<string, string>();
  const criteria: Record<string, Record<string, string>> = { action: {}, target: {}, value: {} };
  const bindings: Array<{ id: string; action: string; target: string; value: string }> = [];
  const factor = (axis: string, map: Map<string, string>, key: string, description: string) => {
    let id = map.get(key);
    if (!id) { id = `${axis[0]}${map.size}`; map.set(key, id); criteria[axis]![id] = description; }
    return id;
  };
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new ChoiceRequestError("invalid_request");
    ids.add(candidate.id);
    if (candidate.call?.name !== "computer_do") {
      bindings.push({ id: candidate.id,
        action: factor("action", templates, candidate.id, candidate.description),
        target: factor("target", targets, "none", "No action target: recovery or completion review"),
        value: factor("value", values, "none", "No supplied value"),
      });
      continue;
    }
    const description = JSON.parse(candidate.description) as { purpose: string; operation: Record<string, unknown>; control?: string };
    const { suppliedValue, ...operation } = description.operation;
    // Keep every fixed argument/delivery mode. Do not use action kind alone.
    const template = JSON.stringify({ purpose: description.purpose, operation });
    // Non-control operations can have distinct exact private targets. Conservatively
    // keep them separate rather than infer that identical human labels mean identity.
    const targetKey = candidate.controlId ?? `exact:${candidate.id}`;
    bindings.push({ id: candidate.id,
      action: factor("action", templates, template, template),
      target: factor("target", targets, targetKey, candidate.controlId ?? "This candidate's planned exact target"),
      value: factor("value", values, suppliedValue === undefined ? "none" : JSON.stringify(suppliedValue),
        suppliedValue === undefined ? "No supplied value" : `Use exact supplied value named ${JSON.stringify(suppliedValue)}`),
    });
  }
  const questions = Object.fromEntries(Object.entries(criteria).map(([axis, options]) => [axis, {
    type: "choice", criteria: options,
    instructions: `Choose the ${axis} for the same single best next step toward the goal. Do not invent an operation or input. Recovery/completion actions use no target and no supplied value. If no mutation is appropriate, select a recovery action.`,
  } satisfies DecisionQuestion]));
  return { questions, bindings };
}

export interface FactorizedSelectionOptions {
  input: ChoiceInput;
  candidates: readonly NativeDecisionCandidate[];
  maxChoices: number;
  supportsMultipleQuestions: boolean;
  decide: (input: DecisionInput) => Promise<DecisionResult>;
  choose: (input: ChoiceInput) => Promise<ChoiceResult>;
}

export async function selectNativeFactorized(options: FactorizedSelectionOptions): Promise<{
  selectedId: string; path: "factorized" | "complete_choice"; fallbackReason: string | null;
}> {
  const { input, candidates } = options;
  const active = () => { if (input.signal.aborted) throw new ChoiceRequestError("cancelled"); };
  active();
  // Selection always refers to the exact original candidate set, including escapes.
  if (new Set(candidates.map(c => c.id)).size !== candidates.length
    || candidates.length !== input.choices.length
    || candidates.some(c => !input.choices.some(choice => choice.id === c.id && choice.description === c.description)))
    throw new ChoiceRequestError("invalid_request");
  const fallback = async (reason: string) => {
    active();
    const result = await chooseBrowserAction(input, options.maxChoices, options.choose, {
      controlIds: candidates.filter(c => c.call?.name !== "computer_do").map(c => c.id),
    });
    return { selectedId: result.selectedId, path: "complete_choice" as const, fallbackReason: reason };
  };
  if (!options.supportsMultipleQuestions) return fallback("multiple_questions_unsupported");
  let projection: ReturnType<typeof projectNativeFactors>;
  try { projection = projectNativeFactors(candidates); }
  catch { return fallback("factor_projection_unavailable"); }
  if (Object.values(projection.questions).some(q => q.type === "choice" && Object.keys(q.criteria).length > options.maxChoices))
    return fallback("factor_count_requires_full_coverage_reduction");
  let result: DecisionResult;
  try {
    const questions = Object.fromEntries(Object.entries(projection.questions).map(([id, question]) => [id, {
      ...question, instructions: `${input.instructions}\n${question.instructions}`,
    }]));
    result = await options.decide({ modelId: input.modelId, state: input.state as DecisionInput["state"],
      questions, signal: input.signal, ...(input.tenantContext ? { tenantContext: input.tenantContext } : {}) });
  } catch (error) {
    active();
    if (error instanceof ChoiceRequestError && error.code === "context_length_exceeded") return fallback("factor_context_overflow");
    throw error;
  }
  active();
  const answer = (axis: string) => result.answers[axis]?.type === "choice" ? result.answers[axis].choice : null;
  const matches = projection.bindings.filter(row => row.action === answer("action") && row.target === answer("target") && row.value === answer("value"));
  // Never stitch a new executable tuple from independently plausible answers.
  if (matches.length !== 1) return fallback("incompatible_or_ambiguous_factors");
  return { selectedId: matches[0]!.id, path: "factorized", fallbackReason: null };
}
