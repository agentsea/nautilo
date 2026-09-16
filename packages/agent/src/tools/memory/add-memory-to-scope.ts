import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveSpeakerUserId, envelopeReadableNamespaces } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { attachMemoryToScope } from "../../store/agent-scope-store";
import { describeProtectedMemoryUnavailable } from "@nautilo/lattice-bridge";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  protectedMemoryToolRequestId,
  type ProtectedAgentMemoryScopeLifecyclePort,
} from "./protected-memory-ports";

interface AddMemoryToScopeContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  protectedMemoryScopeLifecyclePort?: ProtectedAgentMemoryScopeLifecyclePort;
}

export function createAddMemoryToScopeTool(ctx?: AddMemoryToScopeContext) {
  return new DynamicStructuredTool({
    name: "add_memory_to_scope",
    description: `Attach an existing memory to one of your scopes (bookmark).

The memory must already be visible to you through your readable namespaces and must belong to this agent (or be a legacy shared null-agent memory). The memory row itself is not modified — only the scope bookmark.`,
    schema: z.object({
      memory_id: z.string().min(1).describe("The memory id from search_memory or manage_memory."),
      scope_id: z.string().min(1).describe("The scope id from create_scope or find_scope."),
    }),
    func: async ({ memory_id, scope_id }, runManager, runConfig) => {
      const env = ctx?.memoryAccessEnvelope;
      if (ctx?.protectedMemoryScopeLifecyclePort) {
        const authority = protectedMemoryAuthorityFromEnvelope(env);
        const requestId = protectedMemoryToolRequestId(
          runManager?.runId,
          runConfig?.configurable?.["memoryToolMutationRequestId"],
        );
        if (!authority || !requestId) {
          return "Cannot attach memory: current Memory authorization is unavailable.";
        }
        const result = await ctx.protectedMemoryScopeLifecyclePort.attachSeed({
          operationId: protectedMemoryToolOperationId({
            requestId,
            action: "scope_attach_seed",
            subjectId: `${scope_id}:${memory_id}`,
          }),
          authority,
          memoryId: memory_id,
          scopeId: scope_id,
        });
        if (result.status === "unavailable") {
          return `Cannot attach memory: ${
            describeProtectedMemoryUnavailable(result.reason)
          }.`;
        }
        return result.value.status === "attached"
          ? `Attached memory ${memory_id} to scope '${result.value.scopeName}'.`
          : `Memory ${memory_id} was already in scope '${result.value.scopeName}'.`;
      }
      const agentId = env?.agentId;
      const speakerUserId = await resolveSpeakerUserId(env);
      const readableNamespaceIds = envelopeReadableNamespaces(env);
      if (!agentId || !speakerUserId || readableNamespaceIds.length === 0) {
        return "Cannot attach memory: speaker identity or namespace access missing in this context.";
      }
      const result = await attachMemoryToScope(memory_id, scope_id, {
        agentId,
        speakerUserId,
        readableNamespaceIds,
      });
      if ("error" in result) {
        if (result.error === "memory_not_found") {
          return `Memory ${memory_id} not found.`;
        }
        if (result.error === "memory_not_visible") {
          return `You don't have access to memory ${memory_id}, or it belongs to a different agent.`;
        }
        if (result.error === "scope_closing") {
          return "Cannot attach memory: this scope is already closing.";
        }
        return "Scope not found, or it doesn't belong to you.";
      }
      if (result.status === "attached") {
        return `Attached memory ${memory_id} to scope '${result.scopeName}'.`;
      }
      return `Memory ${memory_id} was already in scope '${result.scopeName}'.`;
    },
  });
}
