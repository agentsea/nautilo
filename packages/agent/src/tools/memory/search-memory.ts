import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { searchMemory } from "../../store/memory-store";
import { searchScopeMemory } from "../../store/scope-memory-store";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { isScopeMemoryEnvelope, envelopeReadableNamespaces, resolveSpeakerUserId } from "@nautilo/trust";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemorySearchPort,
} from "@nautilo/lattice-bridge";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import { ProtectedMemoryToolUnavailableError } from "./protected-memory-ports";

interface MemoryToolContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  /** Invocation-bound protected composition; ordinary mode leaves this absent. */
  protectedMemoryRepository?: ProtectedAgentMemoryRepository;
  /** Foreground read-only protection; never enables Memory mutation tools. */
  protectedMemorySearch?: ProtectedAgentMemorySearchPort;
}

/**
 * D476 provenance is accepted only from this versioned, producer-owned first
 * line. Older checkpointed ToolMessages are deliberately not retrofitted:
 * their content may include untrusted text that resembles a result header.
 */
export const SEARCH_MEMORY_PROVENANCE_HEADER = "Memory search results v2";

/**
 * D476 provenance bridge: a search result has exactly one physical line.
 * Memory bodies are untrusted data and may contain strings that resemble our
 * header grammar; collapsing whitespace prevents them from minting a second
 * apparent result header in the model-visible ToolMessage.
 */
export function formatSearchMemoryResultLine(
  memory: Pick<{ id: string; type: string; tier: number; content: string }, "id" | "type" | "tier" | "content">,
  index: number,
): string {
  const content = memory.content.replace(/\s+/gu, " ").trim();
  // Authored type is untrusted too: it cannot close the provenance label.
  const type = memory.type.replace(/\[/gu, "(").replace(/\]/gu, ")")
    .replace(/\s+/gu, " ").trim();
  return `${index}. [${type}] (id: ${memory.id}, tier: ${memory.tier}) ${content}`;
}

export function formatSearchMemoryResults(
  memories: readonly Pick<{ id: string; type: string; tier: number; content: string }, "id" | "type" | "tier" | "content">[],
): string {
  const count = memories.length;
  const formatted = memories
    .map((memory, index) => formatSearchMemoryResultLine(memory, index + 1))
    .join("\n");
  return `${SEARCH_MEMORY_PROVENANCE_HEADER} (${count} ${count === 1 ? "result" : "results"})\n${formatted}`;
}

export function createSearchMemoryTool(context?: MemoryToolContext) {
  return new DynamicStructuredTool({
    name: "search_memory",
    description: `Search persistent memory for information about the user from past conversations.

Use this when:
- The user references something from a past conversation ("remember when we discussed...")
- You need context about who the user is, what they're working on, or their preferences
- You're starting a complex task and want to check for relevant background

Returns matching memories ranked by relevance. If nothing is found, it means you haven't stored anything related yet — do NOT search again.`,

    schema: z.object({
      query: z.string().describe("Natural language search query — describe what you're looking for"),
      limit: z.number().optional().default(10).describe("Max results to return (default 10)"),
      include_archive: z.boolean().optional().default(false).describe("Include archived (tier 3) memories"),
    }),

    func: async ({ query, limit, include_archive }, _runManager, runConfig) => {
      try {
        const envelope = context?.memoryAccessEnvelope;

        // The repository owns structural selection and protected opening. The
        // legacy foreground port may coexist in restored graph state, but it
        // must never displace the production repository.
        const protectedSearch = context?.protectedMemoryRepository
          ?? context?.protectedMemorySearch;
        if (protectedSearch) {
          const authority = protectedMemoryAuthorityFromEnvelope(envelope);
          if (!authority) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const protectedResult = await protectedSearch.search({
            authority,
            query,
            limit: limit ?? 10,
            includeArchive: include_archive ?? false,
            mode: "vector",
            ...(runConfig?.signal === undefined
              ? {}
              : { signal: runConfig.signal }),
          });
          if (protectedResult.status === "unavailable") {
            throw new ProtectedMemoryToolUnavailableError(protectedResult.reason);
          }
          if (protectedResult.value.length === 0) {
            return isScopeMemoryEnvelope(envelope)
              ? "No memories found in this scope for this query."
              : "No memories found for this query. Proceed without memory context.";
          }
          return formatSearchMemoryResults(protectedResult.value);
        }

        const agentId = envelope?.agentId;
        if (isScopeMemoryEnvelope(envelope)) {
          const speakerUserId = await resolveSpeakerUserId(envelope);
          if (!speakerUserId) {
            return "Cannot perform scope memory operation: speaker identity missing in this context.";
          }
          const results = await searchScopeMemory({
            speakerUserId,
            agentId: envelope.agentId,
            scopeId: envelope.scopeId,
            query,
            limit: limit ?? 10,
            includeArchive: include_archive ?? false,
          });
          if (results.length === 0) {
            return "No memories found in this scope for this query.";
          }
          return formatSearchMemoryResults(results);
        }

        const results = await searchMemory({
          ...(envelope?.ownerId ? { userId: envelope.ownerId } : {}),
          ...(agentId ? { agentId } : {}),
          query,
          limit: limit ?? 10,
          includeArchive: include_archive ?? false,
          namespaceIds: envelopeReadableNamespaces(envelope),
        });

        if (results.length === 0) {
          return "No memories found for this query. Proceed with responding to the user. Save important information using manage_memory as you learn it.";
        }

        return formatSearchMemoryResults(results);
      } catch (error) {
        if (runConfig?.signal?.aborted === true) throw error;
        if (error instanceof StrictShadowEnforcementError) throw error;
        if (error instanceof ProtectedMemoryToolUnavailableError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        return `Memory search failed: ${msg}. Proceed without memory context.`;
      }
    },
  });
}
