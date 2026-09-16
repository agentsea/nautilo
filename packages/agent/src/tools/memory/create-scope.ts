import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createScope, resolveSpeakerUserId } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { describeProtectedMemoryUnavailable } from "@nautilo/lattice-bridge";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  protectedMemoryToolRequestId,
  type ProtectedAgentMemoryScopeLifecyclePort,
} from "./protected-memory-ports";

interface CreateScopeContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  protectedMemoryScopeLifecyclePort?: ProtectedAgentMemoryScopeLifecyclePort;
}

export function createCreateScopeTool(ctx?: CreateScopeContext) {
  return new DynamicStructuredTool({
    name: "create_scope",
    description: `Create a temporary memory scope you can use to bookmark a working set of memories.

A scope is private to you (this agent) and the user you're talking to. You can attach existing memories to it with add_memory_to_scope, list your scopes with find_scope, and close it with close_scope when done.

Scopes do NOT auto-expire — they live until you close them. Closing a scope drops your bookmarks but keeps every memory itself; memories survive in their original rooms.

Names must be unique among your open scopes for this user. Returns the scope id and name.`,
    schema: z.object({
      name: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "Short, unique label for this scope (e.g. 'researching-tea-vendors').",
        ),
      purpose: z
        .string()
        .max(280)
        .optional()
        .describe("Optional one-sentence note about why you created this scope."),
    }),
    func: async ({ name, purpose }, runManager, runConfig) => {
      const env = ctx?.memoryAccessEnvelope;
      if (ctx?.protectedMemoryScopeLifecyclePort) {
        const authority = protectedMemoryAuthorityFromEnvelope(env);
        const requestId = protectedMemoryToolRequestId(
          runManager?.runId,
          runConfig?.configurable?.["memoryToolMutationRequestId"],
        );
        if (!authority || !requestId) {
          return "Cannot create scope: current Memory authorization is unavailable.";
        }
        const result = await ctx.protectedMemoryScopeLifecyclePort.create({
          operationId: protectedMemoryToolOperationId({
            requestId,
            action: "scope_create",
            subjectId: name,
          }),
          authority,
          name,
          ...(purpose === undefined ? {} : { purpose }),
        });
        return result.status === "unavailable"
          ? `Cannot create scope: ${
            describeProtectedMemoryUnavailable(result.reason)
          }.`
          : JSON.stringify({
            scope_id: result.value.scopeId,
            name: result.value.name,
          });
      }
      const agentId = env?.agentId;
      const speakerUserId = await resolveSpeakerUserId(env);
      if (!agentId || !speakerUserId) {
        return "Cannot create scope: agent or speaker identity missing in this context.";
      }
      const base = {
        parentAgentId: agentId,
        speakerUserId,
        name,
      };
      const result = await createScope(
        purpose !== undefined ? { ...base, purpose } : base,
      );
      if ("error" in result) {
        return `A scope named '${name}' already exists. Choose a different name or use find_scope to locate the existing one.`;
      }
      return JSON.stringify({ scope_id: result.scopeId, name: result.name });
    },
  });
}
