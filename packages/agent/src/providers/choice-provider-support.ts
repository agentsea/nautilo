/** Catalog metadata cannot install a Choice transport. */
export function isSupportedChoiceProvider(provider: string): boolean {
  return ["openrouter", "typesafe", "venice"].includes(provider.toLowerCase());
}
