import { AsyncLocalStorage } from "node:async_hooks";
import type { IntelligenceTier } from "@nautilo/trust";

const MIND_SWAPPER_PREFIX = "mindswapper:";

/** Provider default for model selection; individual discovery rows do not publish a reviewed tier. */
export const MINDSWAPPER_DEFAULT_INTELLIGENCE_TIER: IntelligenceTier = "frontier";

export interface MindSwapperChatOffer {
  readonly inputModalities: readonly ("text" | "image")[];
  readonly supportedParameters: readonly string[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/** Already validated by discovery and scoped by the caller's funding authority. */
export interface MindSwapperChatModel {
  readonly id: string;
  readonly displayName: string;
  readonly offers: readonly MindSwapperChatOffer[];
  readonly unavailableReason?: string;
  readonly indicativePrice?: { readonly inputPerMtok: number; readonly outputPerMtok: number };
}

export interface MindSwapperConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

const modelScope = new AsyncLocalStorage<ReadonlyMap<string, MindSwapperChatModel>>();
const connectionScope = new AsyncLocalStorage<MindSwapperConnection>();

export function isMindSwapperModelId(id: string): boolean {
  return id.startsWith(MIND_SWAPPER_PREFIX) && id.length > MIND_SWAPPER_PREFIX.length;
}

export function mindSwapperUpstreamModelId(id: string): string | undefined {
  return isMindSwapperModelId(id) ? id.slice(MIND_SWAPPER_PREFIX.length) : undefined;
}

export function withMindSwapperModels<T>(models: readonly MindSwapperChatModel[], run: () => T): T {
  return modelScope.run(new Map(models.filter(({ id }) => isMindSwapperModelId(id)).map((model) => [model.id, model])), run);
}

export function readMindSwapperModels(): readonly MindSwapperChatModel[] {
  return [...(modelScope.getStore()?.values() ?? [])];
}

export function findMindSwapperModel(id: string): MindSwapperChatModel | undefined {
  return modelScope.getStore()?.get(id);
}

export function withMindSwapperConnection<T>(connection: MindSwapperConnection, run: () => T): T {
  return connectionScope.run(connection, run);
}

export function readMindSwapperConnection(): MindSwapperConnection | undefined {
  return connectionScope.getStore();
}

/**
 * Advertise one coherent offer. Prefer tool-capable offers for ordinary Genie
 * chat, then prefer richer capabilities within that class. Runtime checks use
 * this same envelope, so the picker cannot promise an unsupported combination.
 */
export function mindSwapperOfferForModel(model: MindSwapperChatModel | undefined): MindSwapperChatOffer | undefined {
  if (!model || model.unavailableReason) return undefined;
  const offers = model.offers.filter((offer) => offer.inputModalities.includes("text"));
  const has = (offer: MindSwapperChatOffer, parameter: string) => Number(offer.supportedParameters.includes(parameter));
  return offers.sort((a, b) =>
    has(b, "tools") - has(a, "tools")
    || Number(b.inputModalities.includes("image")) - Number(a.inputModalities.includes("image"))
    || has(b, "response_format") - has(a, "response_format")
    || has(b, "reasoning") - has(a, "reasoning")
    || b.maxInputTokens - a.maxInputTokens
    || b.maxOutputTokens - a.maxOutputTokens
    || a.supportedParameters.join(",").localeCompare(b.supportedParameters.join(",")),
  )[0];
}
