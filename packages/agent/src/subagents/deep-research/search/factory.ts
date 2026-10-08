import type { Configuration } from "../shared/config";
import type { SearchResultItem, SearchResults } from "./types";
import { getUsageContext } from "../../../usage/usage-context";
import {
  beginToolProviderCostAttempt,
  createToolProviderCostRecorder,
  openProviderCostAttempt,
  providerToolEstimateReceipt,
  type ProviderCostReceipt,
  type ProviderCostRecorder,
} from "../../../usage/provider-cost-recorder";
import { ServerProviderCredentialsDeniedError } from "@nautilo/trust";
import { getCapabilityFundingSession } from "../../../runtime/capability-funding";
import { assertDeepResearchServerFunding, getDeepResearchFunding } from "../shared/funding";

export type SearchProvider = "tavily" | "openai" | "anthropic" | "duckduckgo" | "exa" | "none";

export type SearchTool = (
  query: string,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<SearchResults>;

export async function runRecordedDeepResearchTavilySearch(
  invoke: () => Promise<unknown>,
  recordProviderCost: ProviderCostRecorder,
  searchDepth: "basic" | "advanced",
  signal?: AbortSignal,
): Promise<unknown> {
  const costAttempt = await openProviderCostAttempt(recordProviderCost, {
    provider: "tavily",
    operation: "deep_research_search",
  });
  let settled = false;
  const settle = async (receipt: ProviderCostReceipt) => {
    if (!costAttempt || settled) return;
    settled = true;
    await costAttempt(receipt);
  };
  try {
    signal?.throwIfAborted();
    const rawResults = await invoke();
    signal?.throwIfAborted();
    await settle({
      provider: "tavily", operation: "deep_research_search",
      ...providerToolEstimateReceipt("tavily:credit", null,
        searchDepth === "advanced" ? 2 : 1, "credit"),
      attemptOutcome: "succeeded",
    });
    return rawResults;
  } catch (error) {
    const cancelled = signal?.aborted === true;
    await settle({
      provider: "tavily", operation: "deep_research_search",
      evidenceState: "unknown", attemptOutcome: cancelled ? "cancelled" : "unknown",
      failureCode: cancelled ? "request_cancelled" : "provider_transport_unknown",
    });
    throw error;
  }
}

export function buildSearchTool(cfg: Configuration, _callbacks?: unknown[]): SearchTool {
  const provider: SearchProvider = cfg.search_api;
  switch (provider) {
    case "tavily":
      return buildTavilySearch(cfg);
    case "duckduckgo":
      // Legacy deep-research has no invocation-bound Desktop execution port.
      // It must not revive a server-side scraper; ordinary run_web_search owns
      // the maintained Desktop-only keyless path.
      return (query: string) => Promise.resolve({ provider: "duckduckgo", query, items: [] });
    case "openai":
    case "anthropic":
      return (_query: string) => Promise.resolve({ provider, query: _query, items: [] });
    case "exa":
      return (_query: string) => Promise.resolve({ provider: "exa", query: _query, items: [] });
    case "none":
    default:
      return (query: string) => Promise.resolve({ provider, query, items: [] });
  }
}

function buildTavilySearch(cfg: Configuration): SearchTool {
  return async (query: string, options = {}): Promise<SearchResults> => {
    const funding = getDeepResearchFunding();
    try {
      const tavilyModule = await import("@langchain/tavily");
      const TavilySearchCtor = (tavilyModule as Record<string, unknown>)["TavilySearch"] as
        | (new (c: Record<string, unknown>) => {
          invoke: (input: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>;
        })
        | undefined;
      if (typeof TavilySearchCtor !== "function") {
        return { provider: "tavily", query, items: [] };
      }
      const usage = getUsageContext();
      const invoke = async (apiKey: string, recordProviderCost: ReturnType<typeof createToolProviderCostRecorder>) => {
        const tool = new TavilySearchCtor({
          apiKey,
          maxResults: cfg.search_max_results,
          searchDepth: cfg.search_depth,
          includeImages: false,
          includeAnswer: false,
          includeRawContent: false,
        });
        return runRecordedDeepResearchTavilySearch(
          () => tool.invoke({ query }, options.signal ? { signal: options.signal } : undefined),
          recordProviderCost,
          cfg.search_depth,
          options.signal,
        );
      };
      let rawResults: unknown;
      if (funding) {
        const capability = getCapabilityFundingSession();
        if (!capability) throw new Error("Admitted Deep Research Tavily authority is unavailable.");
        const service = await capability.openService("tavily", funding.tavilyFunding);
        rawResults = await service.runAttempt(async ({ apiKey, usageFunding }) => {
          const recorder = await beginToolProviderCostAttempt({
            userId: usage?.userId, roomId: usage?.roomId,
            agentId: usage?.metadata?.["agentId"], turnId: usage?.metadata?.["turnId"],
          }, { provider: "tavily", operation: "deep_research_search", usageFunding });
          return invoke(apiKey, recorder);
        });
      } else {
        await assertDeepResearchServerFunding("deep_research_tavily");
        const recordProviderCost = createToolProviderCostRecorder({
          userId: usage?.userId,
          roomId: usage?.roomId,
          agentId: usage?.metadata?.["agentId"],
          turnId: usage?.metadata?.["turnId"],
        });
        rawResults = await invoke(process.env["TAVILY_API_KEY"] ?? "", recordProviderCost);
      }
      return { provider: "tavily", query, items: parseTavilyResults(rawResults) };
    } catch (error) {
      if (options.signal?.aborted || funding || error instanceof ServerProviderCredentialsDeniedError) throw error;
      return { provider: "tavily", query, items: [] };
    }
  };
}

function parseTavilyResults(res: unknown): SearchResultItem[] {
  const arr = Array.isArray(res) ? res
    : res && typeof res === "object" && Array.isArray((res as { results?: unknown[] }).results)
      ? (res as { results: unknown[] }).results
      : [];
  return arr.map((entry) => {
    const record = entry as Record<string, unknown>;
    const item: SearchResultItem = { url: typeof record["url"] === "string" ? record["url"] : "" };
    if (typeof record["title"] === "string") item.title = record["title"];
    if (typeof record["snippet"] === "string") item.snippet = record["snippet"];
    else if (typeof record["content"] === "string") item.snippet = record["content"];
    return item;
  });
}
