const KEY_DISPLAY_ORDER = [
  "venice",
  "openrouter",
  "elevenlabs",
  "openai",
  "anthropic",
  "google",
  "fireworks",
  "groq",
] as const;

function displayOrder(providerId: string): number {
  if (providerId === "gateway") return KEY_DISPLAY_ORDER.length + 1;
  if (providerId === "nautilo-gateway") return KEY_DISPLAY_ORDER.length + 2;
  const index = KEY_DISPLAY_ORDER.indexOf(providerId as (typeof KEY_DISPLAY_ORDER)[number]);
  return index === -1 ? KEY_DISPLAY_ORDER.length : index;
}

/**
 * Keep provider-key surfaces aligned while retaining registry order for
 * providers that do not have an explicit product position.
 */
export function orderProviderKeys<T extends { id: string }>(providers: readonly T[]): T[] {
  return providers
    .map((provider, registryIndex) => ({ provider, registryIndex }))
    .sort((left, right) =>
      displayOrder(left.provider.id) - displayOrder(right.provider.id)
      || left.registryIndex - right.registryIndex)
    .map(({ provider }) => provider);
}
