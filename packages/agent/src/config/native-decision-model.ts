import { getEligibleModels } from "./eligible-models";
import { resolveBrowserDecisionModel } from "../tools/browser/browser-snapshot";

// Temporary experiment selection, not a new catalogue capability or chat default.
// Promote controller selection to reviewed catalogue policy after live qualification.
const PROTOTYPE_CONTROLLER_MODEL = "openrouter:qwen/qwen3.8-flash";

/** A pinned prototype still requires active catalogue admission and credentials.
 * No arbitrary chat-model fallback, catalogue insertion or picker mutation. */
export function resolveNativeControllerModel(modelId?: string) {
  const selected = modelId ?? PROTOTYPE_CONTROLLER_MODEL;
  if (selected !== PROTOTYPE_CONTROLLER_MODEL) return null;
  const eligible = getEligibleModels({ purpose: "chat-tools" });
  return eligible.find(model => model.id === selected) ?? null;
}

/** Native and browser delegation share Choice, but native selection can also use chat tools. */
export function resolveNativeDecisionModel(context?: { turnId?: string | undefined; fullEncryptionOnly?: boolean | undefined }, modelId?: string) {
  if (!context?.turnId || context.fullEncryptionOnly !== false) return null;
  return resolveBrowserDecisionModel(context, modelId) ?? resolveNativeControllerModel(modelId);
}
