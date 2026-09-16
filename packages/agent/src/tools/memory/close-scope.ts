import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { closeScope, resolveSpeakerUserId } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { isScopeMemoryEnvelope } from "@nautilo/trust";
import { describeProtectedMemoryUnavailable } from "@nautilo/lattice-bridge";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  protectedMemoryToolRequestId,
  type ProtectedAgentMemoryScopeLifecyclePort,
} from "./protected-memory-ports";

interface CloseScopeContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  protectedMemoryScopeLifecyclePort?: ProtectedAgentMemoryScopeLifecyclePort;
}

export function createCloseScopeTool(ctx?: CloseScopeContext) {
  return new DynamicStructuredTool({
    name: "close_scope",
    description: `Close a memory scope and drop scope bookmarks.

Seed memories (attached with add_memory_to_scope) stay in their original rooms. Memories authored inside a subagent run (scope origin) are promoted into the current room's writable namespace when you close from the main room context.`,
    schema: z.object({
      scope_id: z.string().min(1).describe("The scope id to close."),
    }),
    func: async ({ scope_id }, runManager, runConfig) => {
      const env = ctx?.memoryAccessEnvelope;
      if (ctx?.protectedMemoryScopeLifecyclePort) {
        if (isScopeMemoryEnvelope(env)) {
          return "close_scope cannot be called from inside a subagent scope run. The parent agent must close the scope.";
        }
        const authority = protectedMemoryAuthorityFromEnvelope(env);
        const requestId = protectedMemoryToolRequestId(
          runManager?.runId,
          runConfig?.configurable?.["memoryToolMutationRequestId"],
        );
        if (!authority || !requestId) {
          return "Cannot close scope: current Memory authorization is unavailable.";
        }
        const result = await ctx.protectedMemoryScopeLifecyclePort.close({
          operationId: protectedMemoryToolOperationId({
            requestId,
            action: "scope_close",
            subjectId: scope_id,
          }),
          authority,
          scopeId: scope_id,
        });
        if (result.status === "unavailable") {
          return `Cannot close scope: ${
            describeProtectedMemoryUnavailable(result.reason)
          }.`;
        }
        return JSON.stringify({
          status: result.value.status,
          scope_id: result.value.scopeId,
          transition_count: result.value.transitionCount,
        });
      }
      const agentId = env?.agentId;
      const speakerUserId = await resolveSpeakerUserId(env);
      if (!agentId || !speakerUserId) {
        return "Cannot close scope: agent or speaker identity missing in this context.";
      }
      if (isScopeMemoryEnvelope(env)) {
        return "close_scope cannot be called from inside a subagent scope run. The parent agent must close the scope from the room where memories should be promoted.";
      }
      const writableNs = env.writableNamespaces[0]?.trim() ?? "";
      const result = await closeScope({
        scopeId: scope_id,
        parentAgentId: agentId,
        speakerUserId,
        promoteToNamespaceId: writableNs || null,
      });
      if ("error" in result) {
        if (result.error === "promote_blocked_missing_namespace") {
          return "Cannot close: this scope contains subagent-authored memories that must be promoted into a room namespace, but no writable namespace is available in this context. Open a room with memory write access and retry.";
        }
        return "Scope not found, or it doesn't belong to you.";
      }
      return JSON.stringify({
        closed: true,
        name: result.name,
        promoted_memory_count: result.promotedMemoryCount,
        target_namespace_id: result.targetNamespaceId,
      });
    },
  });
}
