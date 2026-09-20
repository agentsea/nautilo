import { getEligibleModels } from "./eligible-models";
import { resolveBrowserDecisionModel } from "../tools/browser/browser-snapshot";

/** The active signed catalogue owns membership and priority. Exact selections
 * never silently switch models; credentials, capabilities and routing still apply. */
export function resolveNativeControllerModel(modelId?: string) {
  const eligible = getEligibleModels({ purpose: "chat-tools" });
  return (modelId === undefined ? eligible[0] : eligible.find(model => model.id === modelId)) ?? null;
}

/** Native and browser delegation share Choice, but native selection can also use chat tools. */
export function resolveNativeDecisionModel(context?: { turnId?: string | undefined; fullEncryptionOnly?: boolean | undefined }, modelId?: string) {
  if (!context?.turnId || context.fullEncryptionOnly !== false) return null;
  return resolveBrowserDecisionModel(context, modelId) ?? resolveNativeControllerModel(modelId);
}
