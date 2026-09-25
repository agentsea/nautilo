import { getEligibleModels } from "./eligible-models";
import { resolveBrowserDecisionModel } from "../tools/browser/browser-snapshot";

// Temporary experiment selection, not a new catalogue capability or chat default.
// Promote controller selection to reviewed catalogue policy after live qualification.
const PROTOTYPE_CONTROLLER_MODEL = "openrouter:deepseek/deepseek-v4.1-flash";

// Routine interpretation uses the selected model's catalogued non-thinking mode.
// The provider factory still verifies that optional reasoning can be disabled.
export const NATIVE_CONTROLLER_MODEL_OPTIONS = { reasoningEffort: "off", reasoningOutput: false } as const;

/** A pinned prototype still requires active catalogue admission and credentials.
 * No arbitrary chat-model fallback, catalogue insertion or picker mutation. */
export function resolveNativeControllerModel(modelId?: string) {
  const selected = modelId ?? PROTOTYPE_CONTROLLER_MODEL;
  if (selected !== PROTOTYPE_CONTROLLER_MODEL) return null;
  const eligible = getEligibleModels({ purpose: "chat-tools" });
  return eligible.find(model => model.id === selected) ?? null;
}

/** Acceleration is optional inside Computer Use, and requires a runnable
 * catalogued Choice model. A chat credential alone must not enable it. */
export function resolveNativeDecisionModel(context?: { turnId?: string | undefined; fullEncryptionOnly?: boolean | undefined }, modelId?: string) {
  if (!context?.turnId || context.fullEncryptionOnly !== false) return null;
  return resolveBrowserDecisionModel(context, modelId);
}
