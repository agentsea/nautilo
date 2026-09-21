import { resolveCatalogModel } from "../config/resolved-catalog";
import { invokeProviderChoice } from "./provider-choice";
import { decisionProvider } from "./decision-transport";
import {
  ChoiceRequestError,
  type ChoiceDriver,
  type ChoiceInput,
  type ChoiceResult,
} from "./choice";

/** Remote metadata cannot install a provider transport. */
export function resolveChoiceDriver(provider: string): ChoiceDriver | null {
  const supported = decisionProvider(provider);
  return supported ? { invoke: (input) => invokeProviderChoice(supported, input) } : null;
}

/** Resolve current catalog authority and dispatch through an implemented Choice adapter. */
export async function invokeChoice(input: ChoiceInput): Promise<ChoiceResult> {
  const row = resolveCatalogModel(input.modelId);
  const driver = resolveChoiceDriver(row.provider);
  if (!driver
    || row.workload !== "decision"
    || !row.decision?.operations.includes("choice")) {
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
