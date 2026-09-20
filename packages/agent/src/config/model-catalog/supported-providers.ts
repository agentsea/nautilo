import { isSupportedChoiceProvider } from "../../providers/choice-provider-support";

/**
 * provider-adapter support gate for remote catalog rows.
 *
 * Only provider prefixes already routable by `createUniversalModel`
 * (`packages/agent/src/providers/universal.ts`) can become runnable from a
 * remote publishable row. Unknown provider prefixes remain non-runnable
 * until server support exists — remote metadata can never make an unsupported
 * provider runnable. This set is the single source of truth for the
 * reconciliation gate; update it only when `createUniversalModel` gains a new
 * routable prefix.
 */
export const SUPPORTED_MODEL_CATALOG_PROVIDER_PREFIXES: ReadonlySet<string> = Object.freeze(
  new Set([
    "anthropic",
    "openai",
    "openrouter",
    "gateway",
    "google",
    "xai",
    "fireworks",
    "together",
    "venice",
  ]),
);

export function isSupportedModelCatalogProvider(provider: string): boolean {
  return SUPPORTED_MODEL_CATALOG_PROVIDER_PREFIXES.has(provider.toLowerCase());
}

export function isSupportedModelCatalogWorkload(
  provider: string,
  workload: "chat" | "generation" | "decision" | "speech",
): boolean {
  if (workload === "speech") return provider === "elevenlabs";
  return isSupportedModelCatalogProvider(provider)
    && (workload !== "decision" || isSupportedChoiceProvider(provider));
}
