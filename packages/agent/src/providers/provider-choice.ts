import { z } from "zod";
import { ChoiceRequestError, type ChoiceInput, type ChoiceResult } from "./choice";
import { requestDecisions, type DecisionDependencies, type DecisionProvider } from "./decision-transport";
import { decisionStateSchema } from "./decision";

const text = z.string().refine((value) => value.trim().length > 0);
const inputSchema = z.object({
  modelId: text, state: decisionStateSchema, instructions: text,
  choices: z.array(z.object({ id: text, description: text })).nonempty(),
});
const answerSchema = z.object({ type: z.literal("choice"), choice: z.string() });
const probability = z.number().min(0).max(1);

/** Preserve the existing Choice consumer's optional observational metadata contract. */
export async function invokeProviderChoice(
  provider: DecisionProvider, input: ChoiceInput, deps: DecisionDependencies = {},
): Promise<ChoiceResult> {
  if (input.signal.aborted) throw new ChoiceRequestError("cancelled");
  let request: z.infer<typeof inputSchema>;
  try { request = inputSchema.parse(input); }
  catch { throw new ChoiceRequestError("invalid_request"); }
  if (!request.modelId.startsWith(`${provider}:`)) throw new ChoiceRequestError("unsupported_model");
  const ids = new Set(request.choices.map((choice) => choice.id));
  if (ids.size !== request.choices.length) throw new ChoiceRequestError("invalid_request");
  const result = await requestDecisions({
    modelId: request.modelId, state: request.state, signal: input.signal,
    ...(input.tenantContext === undefined ? {} : { tenantContext: input.tenantContext }),
    questions: { candidate: {
      type: "choice", instructions: request.instructions,
      criteria: Object.fromEntries(request.choices.map(({ id, description }) => [id, description])),
    } },
  }, deps);
  const answers = z.record(z.string(), z.unknown()).safeParse(result.answers);
  const raw = answers.success ? answers.data["candidate"] : undefined;
  const answer = answerSchema.safeParse(raw);
  if (!result.hasResponseModel || !answer.success || !ids.has(answer.data.choice))
    throw new ChoiceRequestError("invalid_response");
  const metadata = raw as Record<string, unknown>;
  const confidence = probability.safeParse(metadata["confidence"]);
  const probabilities = z.record(z.string(), probability).safeParse(metadata["probabilities"]);
  return { ...result.receipt, selectedId: answer.data.choice,
    ...(confidence.success ? { confidence: confidence.data } : {}),
    ...(probabilities.success ? { probabilities: probabilities.data } : {}),
  };
}
