import { z } from "zod";
import type { TenantContext } from "../resolve-provider-key";

export const decisionStateSchema = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);
const description = decisionStateSchema;
const instructions = description;
const criterion = description.nullable();
const choice = z.object({
  type: z.literal("choice"), instructions,
  criteria: z.record(z.string().min(1), criterion).refine((value) => Object.keys(value).length > 0),
}).strict();
const noul = z.object({
  type: z.literal("noul"), instructions,
  criteria: z.object({ true: description, false: description }).strict().optional(),
}).strict();
const score = z.object({
  type: z.literal("score"), instructions, criteria: z.array(description).min(2),
}).strict();
export const decisionQuestionSchema = z.discriminatedUnion("type", [choice, noul, score]);
export const decisionQuestionsSchema = z.record(z.string().min(1), decisionQuestionSchema)
  .refine((questions) => Object.keys(questions).length > 0, "at least one question is required");
export type DecisionQuestion = z.infer<typeof decisionQuestionSchema>;
export interface DecisionInput {
  readonly modelId: string;
  readonly state: z.infer<typeof decisionStateSchema>;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal: AbortSignal;
  readonly tenantContext?: TenantContext;
}
export type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, unknown> };
export interface DecisionReceipt {
  readonly requestedModelId: string;
  readonly resolvedModelId: string | null;
  readonly responseId?: string;
  readonly provider?: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly actualCostUsd: number | null };
}
export interface DecisionResult extends DecisionReceipt {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
}
