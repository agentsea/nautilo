import { resolveCatalogModel } from "../config/resolved-catalog";
import { invokeOpenRouterChoice } from "./openrouter-choice";
import { isSupportedChoiceProvider } from "./choice-provider-support";
import {
  ChoiceRequestError,
  type ChoiceDriver,
  type ChoiceInput,
  type ChoiceResult,
} from "./choice";

const openRouterChoiceDriver: ChoiceDriver = {
  invoke: invokeOpenRouterChoice,
};

/** Return only a locally implemented adapter; remote metadata cannot add one. */
export function resolveChoiceDriver(provider: string): ChoiceDriver | null {
  return isSupportedChoiceProvider(provider) ? openRouterChoiceDriver : null;
}

/** Resolve current catalog authority and dispatch through an implemented Choice adapter. */
export async function invokeChoice(input: ChoiceInput): Promise<ChoiceResult> {
  const row = resolveCatalogModel(input.modelId);
  const driver = resolveChoiceDriver(row.provider);
  if (!driver
    || row.workload !== "decision"
    || row.decision?.operations.length !== 1
    || row.decision.operations[0] !== "choice") {
    throw new ChoiceRequestError("unsupported_model");
  }

  return driver.invoke(input);
}

export {
  ChoiceRequestError,
  type ChoiceDriver,
  type ChoiceInput,
  type ChoiceRequestErrorCode,
  type ChoiceResult,
} from "./choice";
