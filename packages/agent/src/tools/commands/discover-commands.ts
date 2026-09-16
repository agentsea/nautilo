/**
 * discover_commands — meta-tool to search the speaker's command catalog.
 *
 * Sibling of `discover_skills` (minus `requiresTools` gating — commands
 * have no tool-gating). Keyword match over name + description, speaker-
 * scoped, guest-withheld. Paginates with explicit truncation hints
 * (D272 — never a silent cutoff).
 *
 * Trust tier: guest (everyone can discover when commands are visible).
 * Impact: read-only.
 * Category: meta.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { listCommandCatalog } from "@nautilo/db";
import { OFFICIAL_COMMANDS } from "@nautilo/agent";

const PAGE_SIZE = 25;

export interface DiscoverCommandsResult {
  name: string;
  description: string;
}

export interface DiscoverCommandsResponse {
  results: DiscoverCommandsResult[];
  truncated: boolean;
  hint?: string;
  nextCursor?: string;
}

interface DiscoverCommandsContext {
  ownerId?: string;
  agentId?: string;
  actorRole?: string;
}

function parseOffset(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function matchesKeyword(
  name: string,
  description: string,
  keyword: string | undefined,
): boolean {
  if (!keyword) return true;
  const lower = keyword.toLowerCase();
  return (
    name.toLowerCase().includes(lower) ||
    description.toLowerCase().includes(lower)
  );
}

function formatNoMatchMessage(query?: string, filter?: string): string {
  const searchDesc = [
    query ? `matching "${query}"` : null,
    filter ? `with filter "${filter}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `No commands found ${searchDesc || ""}. Try a different search term.`;
}

function emptyResponse(): string {
  return JSON.stringify({ results: [], truncated: false } satisfies DiscoverCommandsResponse);
}

/**
 * Merge official bundled commands with speaker-scoped DB rows. DB shadows
 * official by name (copy-on-write); DB-only rows appended. Sorted by name
 * ascending with no duplicate names. Returns name + description only — the
 * catalog read never fetches bodies.
 */
function mergeCatalog(
  official: readonly { name: string; description: string }[],
  dbRows: { name: string; description: string }[],
): DiscoverCommandsResult[] {
  const byName = new Map<string, DiscoverCommandsResult>();
  for (const cmd of official) {
    byName.set(cmd.name, { name: cmd.name, description: cmd.description });
  }
  for (const row of dbRows) {
    byName.set(row.name, { name: row.name, description: row.description });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createDiscoverCommandsTool(context?: DiscoverCommandsContext) {
  return new DynamicStructuredTool({
    name: "discover_commands",
    description:
      "Search your enabled commands by name or description. " +
      "Use this when the catalog is large or you need to find a command " +
      "by topic. Results are scoped to your commands for this agent and " +
      "paginate when many match — follow nextCursor or narrow your query.",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe("Keyword to search command names and descriptions"),
      filter: z
        .string()
        .optional()
        .describe("Optional filter (reserved for future catalog facets)"),
      cursor: z
        .string()
        .optional()
        .describe("Opaque pagination cursor from a previous discover_commands response"),
    }),
    func: async ({ query, filter, cursor }): Promise<string> => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (context?.actorRole === "guest" || !userId || !agentId) {
        return emptyResponse();
      }

      try {
        const dbRows = await listCommandCatalog(agentId, userId);
        const merged = mergeCatalog(OFFICIAL_COMMANDS, dbRows);

        const keyword = query?.trim() || undefined;
        const matched = merged
          .filter((cmd) => matchesKeyword(cmd.name, cmd.description, keyword))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (matched.length === 0) {
          return formatNoMatchMessage(keyword, filter?.trim() || undefined);
        }

        const offset = parseOffset(cursor);
        const page = matched.slice(offset, offset + PAGE_SIZE);
        const remaining = matched.length - (offset + page.length);

        const response: DiscoverCommandsResponse = {
          results: page,
          truncated: remaining > 0,
        };

        if (remaining > 0) {
          response.hint = `narrow your query (${remaining} more match)`;
          response.nextCursor = String(offset + PAGE_SIZE);
        }

        return JSON.stringify(response);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `discover_commands failed: ${msg}`;
      }
    },
  });
}
