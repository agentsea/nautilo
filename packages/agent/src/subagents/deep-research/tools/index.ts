import type { Configuration } from "../shared/config";
import { buildSearchTool, type SearchTool } from "../search/factory";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { withTimeout } from "../../../utils/time";
import { formatErrorBrief } from "../../../utils/errors";
import { log, warn } from "@nautilo/logger";
import { loadMcpTools } from "../mcp/client";

export type Tools = {
  search: SearchTool;
};

export function get_all_tools(cfg: Configuration, callbacks?: unknown[]): Tools {
  return {
    search: buildSearchTool(cfg, callbacks),
  };
}

type SearchItem = {
  title?: string;
  url?: string;
  snippet?: string;
  [key: string]: unknown;
};

export function formatSearchToolPrintable(items: SearchItem[], maxResults: number): string {
  const shown = items.slice(0, maxResults);
  const printable = shown
    .map((it: SearchItem, i: number) => `${i + 1}. ${it.title ?? it.url}\n${it.url}${it.snippet ? `\n${it.snippet}` : ""}`)
    .join("\n\n");
  if (!printable) return "No results";
  if (items.length > shown.length) {
    return `Showing ${shown.length} of ${items.length} results:\n\n${printable}`;
  }
  return printable;
}

export async function get_langchain_tools(cfg: Configuration, callbacks?: unknown[]): Promise<DynamicStructuredTool[]> {
  const searchFn = buildSearchTool(cfg, callbacks);
  const searchTool = new DynamicStructuredTool({
    name: "search",
    description: "Search the web and return top results with titles, urls, and snippets.",
    schema: z.object({ query: z.string() }),
    func: async ({ query }: { query: string }) => {
      try {
        const res = await withTimeout(Promise.resolve(searchFn(query)), 20000, "search tool");
        const items: SearchItem[] = Array.isArray(res.items) ? res.items : [];
        return formatSearchToolPrintable(items, cfg.search_max_results);
      } catch (e) {
        return `Error searching: ${formatErrorBrief(e)}`;
      }
    },
  });
  const tools: DynamicStructuredTool[] = [searchTool];
  try {
    const mcpTools = await loadMcpTools(cfg);
    if (Array.isArray(mcpTools) && mcpTools.length > 0) {
      tools.push(...mcpTools);
      log(`[mcp] Loaded ${mcpTools.length} MCP tools`);
    }
  } catch (e) {
    warn(`[mcp] MCP tool load failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return tools;
}
