/** Catalog metadata cannot install a Choice transport. */
export function isSupportedChoiceProvider(provider: string): boolean {
  return provider.toLowerCase() === "openrouter";
}
