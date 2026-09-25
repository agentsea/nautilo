import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChoiceInput } from "./choice";
import type { ChatModel } from "./types";
import { createUniversalModel } from "./universal";
import { NATIVE_CONTROLLER_MODEL_OPTIONS, resolveNativeControllerModel } from "../config/native-decision-model";
import { CHOICE_ID_INSTRUCTIONS, parseChoiceIdResponse } from "./choice-id";
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Normal metered provider factory; no actuator, reconstructed arguments or extra credentials. */
export async function invokeNativeController(input: ChoiceInput, createModel: (id: string, options?: Record<string, unknown>) => Promise<ChatModel> = createUniversalModel) {
  input.signal.throwIfAborted();
  if (!resolveNativeControllerModel(input.modelId)) throw new Error("native_controller_unavailable");
  const model = await createModel(input.modelId, NATIVE_CONTROLLER_MODEL_OPTIONS);
  input.signal.throwIfAborted();
  // Stable instructions; dynamic IDs and current evidence live only in the tail.
  const response = record(await model.invoke([
    new SystemMessage(input.instructions + "\n" + CHOICE_ID_INSTRUCTIONS),
    new HumanMessage(JSON.stringify({ state: input.state, choices: input.choices })),
  ], { signal: input.signal, metadata: { nautilo_output_visibility: "internal_decision" } }));
  input.signal.throwIfAborted();
  let selectedId: string;
  try { selectedId = parseChoiceIdResponse(response, input.choices.map(choice => choice.id)); }
  catch { throw new Error("invalid_native_controller_selection"); }
  const usage = record(response["usage_metadata"]);
  const details = record(usage["input_token_details"]);
  const metadata = record(response["response_metadata"]);
  return { selectedId, requestedModelId: input.modelId,
    usage: { inputTokens: metric(usage["input_tokens"]), outputTokens: metric(usage["output_tokens"]),
      cacheReadTokens: metric(details["cache_read"]), cacheWriteTokens: metric(details["cache_creation"]),
      actualCostUsd: metric(record(metadata["usage"])["cost"]) },
  };
}
