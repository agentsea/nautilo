import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { ChoiceRequestError } from "./choice";
import { requestDecisions, type DecisionDependencies } from "./decision-transport";
import type { DecisionAnswer, DecisionInput, DecisionQuestion, DecisionResult } from "./decision";

export { ChoiceRequestError as DecisionRequestError } from "./choice";
const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: distribution }).strict(),
  z.object({ type: z.literal("noul"), noul: probability }).strict(),
  z.object({ type: z.literal("score"), score: z.number().finite(), confidence: probability,
    probabilities: distribution, legend: z.record(z.string(), z.unknown()) }).strict(),
]);
function sameKeys(a: object, b: object): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key));
}
function validateAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== question.type) throw new ChoiceRequestError("invalid_response");
  const answer = parsed.data;
  if (answer.type === "choice" && question.type === "choice") {
    if (!Object.hasOwn(question.criteria, answer.choice) || !sameKeys(question.criteria, answer.probabilities)
      || !(answer.probabilities[answer.choice]! > 0)
      || Object.values(answer.probabilities).some((value) => value > answer.probabilities[answer.choice]!))
      throw new ChoiceRequestError("invalid_response");
  }
  if (answer.type === "score" && question.type === "score") {
    const legend = Object.fromEntries(question.criteria.map((value, index) => [String(index), value]));
    if (answer.score < 0 || answer.score > question.criteria.length - 1
      || !sameKeys(legend, answer.probabilities) || !isDeepStrictEqual(legend, answer.legend)
      || !Object.values(answer.probabilities).some((value) => value > 0))
      throw new ChoiceRequestError("invalid_response");
  }
  // Providers may round distributions/scores. Preserve their reported numbers;
  // do not invent normalization precision or recalibrate confidence locally.
  return answer;
}

/** Full typed results; incomplete batches are failures, never partial successes. */
export async function invokeDecision(input: DecisionInput, deps: DecisionDependencies = {}): Promise<DecisionResult> {
  const response = await requestDecisions(input, deps);
  const parsed = z.record(z.string(), z.unknown()).safeParse(response.answers);
  if (!response.hasResponseModel || !parsed.success || !sameKeys(response.questions, parsed.data))
    throw new ChoiceRequestError("invalid_response");
  const answers = Object.fromEntries(Object.entries(response.questions).map(([id, question]) =>
    [id, validateAnswer(question, parsed.data[id])]));
  return { ...response.receipt, answers };
}
