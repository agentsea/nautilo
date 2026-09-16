/**
 * discover_tools — meta-tool that lets the agent query the ToolCatalog.
 *
 * The agent can ask "what tools do I have?" or "find tools for file
 * operations" and get a structured, permission-filtered response.
 *
 * Trust tier: guest (everyone can discover).
 * Impact: read-only.
 * Category: meta.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getToolCatalog } from "@nautilo/catalog";
import {
  TOOL_CATEGORIES,
  type ToolCategory,
  type ToolModelCapability,
} from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { TOOL_EXPOSURE_MANIFEST, type ToolFamilyName } from "../exposure/manifest";
import { genieRecoveryResultFor } from "../genie-recovery";
import {
  hasAvailableTaskReportBackContinuation,
  type TaskReportBackContinuation,
} from "../../runtime/task-report-back-continuation";
import {
  toolPolicyWithRecallRecordsAvailability,
  type RecallRecordsToolContext,
} from "../memory/recall-records";

const LEGACY_CATEGORY_ALIASES = {
  memory: ["knowledge"],
  filesystem: ["files", "documents"],
  shell: ["development"],
  web: ["research"],
  config: ["settings", "administration", "integrations"],
  voice: ["media"],
  device: ["computer", "devices"],
  dev: ["development"],
  admin: ["administration", "identity"],
  productivity: ["documents", "integrations", "automation"],
  subagents: ["automation", "communication"],
  desktop: ["computer"],
} as const satisfies Record<string, readonly ToolCategory[]>;

const CATEGORY_INPUTS = [
  ...TOOL_CATEGORIES,
  ...Object.keys(LEGACY_CATEGORY_ALIASES),
] as const;
type CategoryInput = (typeof CATEGORY_INPUTS)[number];

const TOOL_FAMILY_BY_NAME = new Map<string, ToolFamilyName>(
  Object.entries(TOOL_EXPOSURE_MANIFEST.families).flatMap(([family, names]) =>
    names.map((name) => [name, family as ToolFamilyName] as const),
  ),
);

const RELATED_SEARCH_TERMS = "contact, share, artifact, document, email, calendar, proposal, review";
const REVIEW_WORKFLOW_TERMS = new Set([
  "proposal",
  "suggestion",
  "review",
  "reviewable",
  "track",
  "changes",
  "writer",
  "edit",
]);

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "could", "for", "from", "get", "i",
  "in", "is", "it", "me", "my", "of", "on", "our", "please", "take",
  "that", "the", "this", "to", "use", "want", "with", "would", "you",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !SEARCH_STOP_WORDS.has(token));
}

interface RankedEntry {
  score: number;
  reasons: string[];
  categoryHintMatch: boolean;
}

function resolveCategoryInput(input: CategoryInput): readonly ToolCategory[] {
  if ((TOOL_CATEGORIES as readonly string[]).includes(input)) {
    return [input as ToolCategory];
  }
  return LEGACY_CATEGORY_ALIASES[input as keyof typeof LEGACY_CATEGORY_ALIASES] ?? [];
}

function categorySetForEntry(entry: {
  category: ToolCategory;
  discoveryCategories?: readonly ToolCategory[] | undefined;
}): ReadonlySet<ToolCategory> {
  return new Set([entry.category, ...(entry.discoveryCategories ?? [])]);
}

function rankEntry(
  entry: {
    name: string;
    description: string;
    tags: string[];
    category: ToolCategory;
    discoveryCategories?: readonly ToolCategory[] | undefined;
    discovery?: { preferredReviewWorkflow?: boolean | undefined } | undefined;
  },
  queryTokens: readonly string[],
  requestedCategories: ReadonlySet<ToolCategory>,
): RankedEntry | null {
  const entryCategories = categorySetForEntry(entry);
  const categoryHintMatch = [...requestedCategories].some((category) => entryCategories.has(category));
  if (queryTokens.length === 0) {
    return { score: categoryHintMatch ? 8 : 0, reasons: [], categoryHintMatch };
  }

  const nameTokens = new Set(tokenize(entry.name));
  const explicitlyNamesTool = [...nameTokens].every((token) => queryTokens.includes(token));
  const tagTokens = new Set(entry.tags.flatMap(tokenize));
  const descriptionTokens = new Set(tokenize(entry.description));
  const categoryTokens = new Set(
    [...entryCategories].flatMap((category) => tokenize(category)),
  );
  let score = 0;
  const reasons = new Set<string>();

  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      score += 16;
      reasons.add(`name:${token}`);
    } else if (tagTokens.has(token)) {
      score += 10;
      reasons.add(`tag:${token}`);
    } else if (categoryTokens.has(token)) {
      score += 8;
      reasons.add(`category:${token}`);
    } else if (descriptionTokens.has(token)) {
      score += 2;
      reasons.add(`description:${token}`);
    } else if (
      token.length >= 4 &&
      [...nameTokens, ...tagTokens, ...descriptionTokens].some(
        (candidate) => candidate.length >= 4 &&
          (candidate.startsWith(token) || token.startsWith(candidate)),
      )
    ) {
      score += 1;
      reasons.add(`partial:${token}`);
    }
  }

  // Entity names and natural connective language may be unmatched. A query is
  // useful when any intent-bearing term matches; no unmatched token can veto a
  // strong tool/category/tag match.
  if (score < 3 && !explicitlyNamesTool) return null;
  if (explicitlyNamesTool) {
    score += 40;
    reasons.add("explicit-tool-name");
  }
  if (categoryHintMatch) {
    score += entry.category !== undefined && requestedCategories.has(entry.category) ? 8 : 5;
    reasons.add(`category-hint:${entry.category}`);
  }
  if (
    entry.discovery?.preferredReviewWorkflow &&
    queryTokens.some((token) => REVIEW_WORKFLOW_TERMS.has(token))
  ) {
    // This is presentation-only: the normal resolver has already decided
    // whether the real Office tool is eligible and activatable.
    score += 20;
    reasons.add("preferred-review-workflow");
  }
  return { score, reasons: [...reasons], categoryHintMatch };
}

interface DiscoverToolsContext extends RecallRecordsToolContext {
  /** Server-derived availability of the trusted Deep Research return route. */
  deepResearchForegroundAvailable?: boolean;
  actorRole?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  relayCapabilities?: Readonly<Record<string, boolean>>;
  readableNamespaces?: readonly string[];
  activeModelCapabilities?: readonly ToolModelCapability[];
  /** Server-stamped connected-app eligibility for the exact Human×Namespace. */
  connectedAppProviderIds?: readonly string[];
  toolWhitelist?: readonly string[];
  activatedToolNames?: readonly string[];
  taskReportBackContinuation?: TaskReportBackContinuation | null;
}

export function createDiscoverToolsTool(context?: DiscoverToolsContext) {
  return new DynamicStructuredTool({
    name: "discover_tools",
    description:
      "Search the tool catalog to find what tools are available. " +
      "Use this when you need to know what capabilities you have, " +
      "or when the user asks what you can do. Results are filtered " +
      "to only show tools available for the current actor and runtime.",
    schema: z.object({
      query: z.string().optional().describe("Keyword to search tool names and descriptions"),
      category: z
        .enum([...CATEGORY_INPUTS] as unknown as [string, ...string[]])
        .optional()
        .describe("Optional category hint. With a query it boosts matching tools and automatically broadens across all categories; without a query it browses that category."),
      categories: z
        .array(z.enum([...CATEGORY_INPUTS] as unknown as [string, ...string[]]))
        .optional()
        .describe("Optional category hints for natural cross-category discovery."),
    }),
    // LangChain DynamicStructuredTool requires func to return Promise<string>,
    // but this function is purely synchronous (queries an in-memory Map).
    // eslint-disable-next-line @typescript-eslint/require-await
    func: async ({ query, category, categories }): Promise<string> => {
      const catalog = getToolCatalog();
      if (!catalog) {
        return "Tool catalog is not available. I can still use my standard tools.";
      }

      // Runtime factories pass this explicitly; retaining the envelope fallback
      // keeps direct callers namespace-safe as well.
      const readableNamespaces =
        context?.readableNamespaces ??
        (context?.memoryAccessEnvelope && "readableNamespaces" in context.memoryAccessEnvelope
          ? context.memoryAccessEnvelope.readableNamespaces
          : undefined);
      const toolContext = context === undefined ? undefined : { ...context };
      const options = {
        toolPolicy: toolPolicyWithRecallRecordsAvailability(
          context?.memoryAccessEnvelope?.toolPolicy,
          context,
        ),
        relayCapabilities: context?.relayCapabilities,
        context: toolContext,
        readableNamespaces,
        activeModelCapabilities: context?.activeModelCapabilities,
        toolNameWhitelist: context?.toolWhitelist,
      };
      // First resolve the currently exposed set so discovery can accurately
      // report whether a tool is already callable. Then resolve every normally
      // eligible entry as selected: this applies the same whitelist and model
      // gates that activation uses without making catalog exposure itself a
      // discovery filter.
      const active = catalog.resolveProgressiveTools({
        ...options,
        activatedToolNames: context?.activatedToolNames,
      });
      const canOfferSshEnablement = context?.relayCapabilities?.["canConfigureStructuredSsh"] === true;
      const discoveryRelayCapabilities = canOfferSshEnablement
        ? {
            ...context?.relayCapabilities,
            canUseStructuredSsh: true,
            ...(context?.relayCapabilities?.["canConfigureStructuredSshCopy"] === true
              ? { canUseStructuredSshCopy: true }
              : {}),
          }
        : context?.relayCapabilities;
      const discoveryEligible = catalog.resolveProgressiveTools({
        ...options,
        relayCapabilities: discoveryRelayCapabilities,
        context: toolContext === undefined
          ? undefined
          : { ...toolContext, relayCapabilities: discoveryRelayCapabilities },
      });
      const discoverable = catalog.resolveProgressiveTools({
        ...options,
        relayCapabilities: discoveryRelayCapabilities,
        context: toolContext === undefined
          ? undefined
          : { ...toolContext, relayCapabilities: discoveryRelayCapabilities },
        activatedToolNames: discoveryEligible.eligible.entries.map((entry) => entry.name),
      });
      // Catalog metadata retains the context-free registration description;
      // use the resolved instances here so a route-narrowed schema is
      // discovered with the same supported action vocabulary it can execute.
      const contextualDescriptions = new Map(
        discoverable.tools.map((tool) => [tool.name, tool.description] as const),
      );
      const categoryInputs = [
        ...(category ? [category] : []),
        ...(categories ?? []),
      ];
      const requestedCategories = new Set<ToolCategory>(
        categoryInputs.flatMap((input) => [...resolveCategoryInput(input)]),
      );
      const keyword = query;
      const activeNames = new Set(active.snapshot.entries.map((entry) => entry.name));
      const queryTokens = keyword ? tokenize(keyword) : [];
      const rankedResults = discoverable.snapshot.entries
        .filter((entry) => queryTokens.length > 0 || requestedCategories.size === 0 ||
          [...requestedCategories].some((requested) => categorySetForEntry(entry).has(requested)))
        .map((entry) => ({ entry, rank: rankEntry(entry, queryTokens, requestedCategories) }))
        .filter((result): result is {
          entry: typeof discoverable.snapshot.entries[number];
          rank: RankedEntry;
        } => result.rank !== null,
        )
        .sort((a, b) => b.rank.score - a.rank.score || a.entry.name.localeCompare(b.entry.name));
      // Preferred workflows affect ranking, not capability discovery. Hiding
      // every other Writer tool strands create/populate/inspect workflows.
      // Eligibility and exact-open-document write guards remain authoritative.
      const results = rankedResults;

      if (results.length === 0) {
        const searchDesc = [
          query ? `matching "${query}"` : null,
          categoryInputs.length > 0 ? `with category hint "${categoryInputs.join(", ")}"` : null,
        ].filter(Boolean).join(" ");
        return `No tools found ${searchDesc || ""}. Try related terms: ${RELATED_SEARCH_TERMS}.`;
      }

      const formatted = results.map(({ entry, rank }) => {
        const family = TOOL_FAMILY_BY_NAME.get(entry.name) ?? null;
        const taskInternalUnavailable = entry.name === "security_scan"
          && !hasAvailableTaskReportBackContinuation(context?.taskReportBackContinuation);
        const needsHumanSshEnablement = family === "structured_ssh" &&
          entry.name !== "structured_ssh_output" &&
          canOfferSshEnablement &&
          context?.relayCapabilities?.["canUseStructuredSsh"] !== true;
        return {
          name: entry.name,
          description: contextualDescriptions.get(entry.name) ?? entry.description,
          category: entry.category,
          discoveryCategories: entry.discoveryCategories ?? [],
          matchReasons: rank.reasons,
          searchScope: requestedCategories.size > 0 && !rank.categoryHintMatch
            ? "broadened"
            : requestedCategories.size > 0 ? "category" : "all",
          family,
          impact: entry.impact,
          exposure: entry.exposure ?? "discoverable",
          active: activeNames.has(entry.name),
          activatable: !taskInternalUnavailable && !needsHumanSshEnablement && !activeNames.has(entry.name) && entry.exposure !== "core",
          availability: taskInternalUnavailable
            ? "task_only"
            : needsHumanSshEnablement
            ? "needs_human_enablement"
            : activeNames.has(entry.name) ? "active" : "activatable",
          approval: entry.approvalMode ??
            entry.approvalLevel ??
            (entry.requiresApproval ? "required" : "none"),
          requiredCapabilities: entry.requiredCapabilities,
          conditionalCapabilities: entry.conditionalCapabilities ?? [],
          ...(taskInternalUnavailable
            ? {
              guidance: "From a Room, call in_background with tools [\"file\", \"security_scan\"] and request codebase security research of the Desktop Current Folder.",
            }
            : needsHumanSshEnablement
            ? {
              guidance: "SSH access is off on the connected Mac. Ask the authorized Human to open SSH setup, turn it on with their PIN, then retry the request.",
              recovery: genieRecoveryResultFor({ target: "connections.ssh", requirement: "pin", domainTool: entry.name }, "SSH access is off on the connected Mac. Ask the authorized Human to open SSH setup, turn it on with their PIN, then retry the request."),
            }
            : entry.guidance ? { guidance: entry.guidance } : {}),
        };
      });

      return JSON.stringify(formatted, null, 2);
    },
  });
}
