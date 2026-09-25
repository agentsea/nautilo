import { createHash } from "node:crypto";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { ChatModel } from "../../src/providers/types";
import type { Decide, Measurement } from "./model";
import { CHOICE_ID_INSTRUCTIONS, parseChoiceIdResponse } from "../../src/providers/choice-id";

const contextSchema = z.object({ choices: z.array(z.object({ id: z.string().min(1), description: z.string() })).nonempty() });
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const metric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Experimental transport for the existing bound-choice lab. The model emits
 * one ID, not a function call or arguments. Code constructs the decision and
 * the existing admission/executor retains ownership of every effect. */
export function createChoiceIdDecider(model: ChatModel, measurements: Measurement[]): Decide {
  return async request => {
    request.signal.throwIfAborted();
    const choices = contextSchema.parse(request.context).choices;
    const ids = new Set(choices.map(choice => choice.id));
    if (ids.size !== choices.length || choices.some(choice => /\s/.test(choice.id))) throw new Error("invalid_choice_menu");
    const instructions = request.instructions + "\n" + CHOICE_ID_INSTRUCTIONS;
    const context = JSON.stringify(request.context);
    const row: Measurement = { role: request.role, elapsedMs: 0,
      projectedPromptBytes: Buffer.byteLength(instructions + context),
      prefixHash: createHash("sha256").update(instructions).digest("hex"),
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      actualCostUsd: null, httpStatus: null, validationIssues: [], outcome: "pending" };
    measurements.push(row);
    const started = performance.now();
    try {
      const response = object(await model.invoke([new SystemMessage(instructions), new HumanMessage(context)], { signal: request.signal }));
      const usage = object(response["usage_metadata"]);
      const details = object(usage["input_token_details"]);
      row.inputTokens = metric(usage["input_tokens"]);
      row.outputTokens = metric(usage["output_tokens"]);
      row.cacheReadTokens = metric(details["cache_read"]);
      row.cacheWriteTokens = metric(details["cache_creation"]);
      row.actualCostUsd = metric(object(object(response["response_metadata"])["usage"])["cost"]);
      request.signal.throwIfAborted();
      row.outcome = "invalid";
      const choice = parseChoiceIdResponse(response, [...ids]);
      const decision: unknown = request.schema.parse({ choice });
      row.outcome = "valid";
      return decision;
    } catch (error) {
      row.httpStatus = metric(object(error)["status"]);
      if (request.signal.aborted) row.outcome = "cancelled";
      else if (row.outcome === "pending") row.outcome = "provider_error";
      throw new Error(row.outcome === "invalid" ? "invalid_model_decision" : row.outcome);
    } finally { row.elapsedMs = performance.now() - started; }
  };
}
