import type { ChoiceInput, ChoiceResult } from "./choice";
import { invokeProviderChoice } from "./provider-choice";
import type { DecisionDependencies } from "./decision-transport";
export { ChoiceRequestError, type ChoiceRequestErrorCode } from "./choice";
export type OpenRouterChoiceInput = ChoiceInput;
export type OpenRouterChoiceResult = ChoiceResult;
export function invokeOpenRouterChoice(input: OpenRouterChoiceInput, deps: DecisionDependencies = {}): Promise<OpenRouterChoiceResult> {
  return invokeProviderChoice("openrouter", input, deps);
}
