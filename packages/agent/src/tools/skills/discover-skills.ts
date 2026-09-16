/**
 * discover_skills — meta-tool to search the current speaker's enabled skills.
 *
 * Sibling of `discover_tools`: keyword match over name + description,
 * speaker-scoped, guest-withheld, R15 `requiresTools`-gated. Paginates
 * with explicit truncation hints (D272 — never a silent cutoff).
 *
 * Trust tier: guest (everyone can discover when skills are visible).
 * Impact: read-only.
 * Category: meta.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getToolCatalog } from "@nautilo/catalog";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { ToolModelCapability } from "@nautilo/types";
import { resolveEnabledBodies } from "../../skills/resolve-skills";
import { selectSkillsForTurn } from "../../skills/select-skills-for-turn";

const PAGE_SIZE = 25;

export interface DiscoverSkillsResult {
  name: string;
  description: string;
  requiresTools: string[];
  activationHint?: string;
}

export interface DiscoverSkillsResponse {
  results: DiscoverSkillsResult[];
  truncated: boolean;
  hint?: string;
  nextCursor?: string;
}

interface DiscoverSkillsContext {
  ownerId?: string;
  agentId?: string;
  actorRole?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  relayCapabilities?: Readonly<Record<string, boolean>>;
  /** When set on ToolContext (e.g. subagent runs), mirrors pre-model gating. */
  toolWhitelist?: readonly string[];
  activatedToolNames?: readonly string[];
  activeModelCapabilities?: readonly ToolModelCapability[];
  readableNamespaces?: readonly string[];
}

function parseOffset(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function resolveEligibleToolNames(context?: DiscoverSkillsContext): {
  active: Set<string>;
  eligible: Set<string>;
} {
  const catalog = getToolCatalog();
  if (!catalog) return { active: new Set(), eligible: new Set() };

  // Discovery needs catalog metadata, not freshly constructed tools. Creating
  // factories here would bind schemas merely to list a skill.
  const filtered = catalog.getFiltered(
    context?.memoryAccessEnvelope?.toolPolicy,
    context?.relayCapabilities,
    context?.readableNamespaces
      ? { readableNamespaces: context.readableNamespaces }
      : undefined,
  );
  const whitelist = context?.toolWhitelist ? new Set(context.toolWhitelist) : undefined;
  const modelCapabilities = new Set(context?.activeModelCapabilities ?? []);
  const eligibleEntries = filtered.entries.filter((entry) =>
    (!whitelist || whitelist.has(entry.name)) &&
    !entry.requiredModelCapabilities?.some((capability) => !modelCapabilities.has(capability)),
  );
  const activated = new Set(context?.activatedToolNames ?? []);

  return {
    active: new Set(
      eligibleEntries
        .filter((entry) => entry.exposure === "core" || activated.has(entry.name))
        .map((entry) => entry.name),
    ),
    eligible: new Set(eligibleEntries.map((entry) => entry.name)),
  };
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
  return `No skills found ${searchDesc || ""}. Try a different search term.`;
}

function emptyResponse(): string {
  return JSON.stringify({ results: [], truncated: false } satisfies DiscoverSkillsResponse);
}

export function createDiscoverSkillsTool(context?: DiscoverSkillsContext) {
  return new DynamicStructuredTool({
    name: "discover_skills",
    description:
      "Search your enabled on-demand skills by name or description. " +
      "Use this when the catalog is large or you need to find a skill " +
      "by topic. Results are scoped to your skills for this agent and " +
      "paginate when many match — follow nextCursor or narrow your query.",
    schema: z.object({
      query: z
        .string()
        .optional()
        .describe("Keyword to search skill names and descriptions"),
      filter: z
        .string()
        .optional()
        .describe("Optional filter (reserved for future catalog facets)"),
      cursor: z
        .string()
        .optional()
        .describe("Opaque pagination cursor from a previous discover_skills response"),
    }),
    func: async ({ query, filter, cursor }): Promise<string> => {
      const userId = context?.ownerId ?? "";
      const agentId = context?.agentId ?? "";

      if (context?.actorRole === "guest" || !userId || !agentId) {
        return emptyResponse();
      }

      try {
        const rows = await resolveEnabledBodies(agentId, userId, {
          isGuest: context?.actorRole === "guest",
        });
        const toolNames = resolveEligibleToolNames(context);
        const selected = selectSkillsForTurn({
          skills: rows,
          availableToolNames: [...toolNames.active],
          eligibleToolNames: [...toolNames.eligible],
          catalogBudgetChars: Number.MAX_SAFE_INTEGER,
        });
        const catalogByName = new Map(selected.catalog.map((skill) => [skill.name, skill]));

        const keyword = query?.trim() || undefined;
        const matched = rows
          .filter((skill) => catalogByName.has(skill.name))
          .filter((skill) => matchesKeyword(skill.name, skill.description, keyword))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (matched.length === 0) {
          return formatNoMatchMessage(keyword, filter?.trim() || undefined);
        }

        const offset = parseOffset(cursor);
        const page = matched.slice(offset, offset + PAGE_SIZE);
        const remaining = matched.length - (offset + page.length);

        const response: DiscoverSkillsResponse = {
          results: page.map((skill) => ({
            name: skill.name,
            description: skill.description,
            requiresTools: skill.requiresTools,
            ...(catalogByName.get(skill.name)?.activationHint
              ? { activationHint: catalogByName.get(skill.name)!.activationHint }
              : {}),
          })),
          truncated: remaining > 0,
        };

        if (remaining > 0) {
          response.hint = `narrow your query (${remaining} more match)`;
          response.nextCursor = String(offset + PAGE_SIZE);
        }

        return JSON.stringify(response);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `discover_skills failed: ${msg}`;
      }
    },
  });
}
