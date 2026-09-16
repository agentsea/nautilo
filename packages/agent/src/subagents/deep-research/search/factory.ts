import { randomUUID } from "node:crypto";
import type { Configuration } from "../shared/config";
import type { SearchResultItem, SearchResults } from "./types";
import { getUsageContext } from "../../../usage/usage-context";
import {
  createToolProviderCostRecorder,
} from "../../../usage/provider-cost-recorder";
import { estimateProviderToolCostUsd } from "@nautilo/db";

export type SearchProvider = "tavily" | "openai" | "anthropic" | "duckduckgo" | "exa" | "none";

export type SearchTool = (query: string) => Promise<SearchResults>;

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
  return async (query: string): Promise<SearchResults> => {
    try {
      const tavilyModule = await import("@langchain/tavily");
      const TavilySearchCtor = (tavilyModule as Record<string, unknown>)["TavilySearch"] as
        | (new (c: Record<string, unknown>) => { invoke: (input: unknown) => Promise<unknown> })
        | undefined;
      if (typeof TavilySearchCtor !== "function") {
        return { provider: "tavily", query, items: [] };
      }
      const tool = new TavilySearchCtor({
        apiKey: process.env["TAVILY_API_KEY"],
        maxResults: cfg.search_max_results,
        searchDepth: cfg.search_depth,
        includeImages: false,
        includeAnswer: false,
        includeRawContent: false,
      });
      const rawResults = await tool.invoke({ query });
      const usage = getUsageContext();
      const estimatedCostUsd = estimateProviderToolCostUsd("tavily:credit", cfg.search_depth === "advanced" ? 2 : 1);
      if (estimatedCostUsd) {
        const recordProviderCost = createToolProviderCostRecorder({
          userId: usage?.userId,
          roomId: usage?.roomId,
          agentId: usage?.metadata?.["agentId"],
          turnId: usage?.metadata?.["turnId"],
        });
        await recordProviderCost({
          provider: "tavily",
          operation: "deep_research_search",
          receiptId: randomUUID(),
          estimatedCostUsd,
          evidenceState: "estimated",
        });
      }
      return { provider: "tavily", query, items: parseTavilyResults(rawResults) };
    } catch {
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
