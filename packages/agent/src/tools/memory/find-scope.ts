import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { findScopes, resolveSpeakerUserId } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

interface FindScopeContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

export function createFindScopeTool(ctx?: FindScopeContext) {
  return new DynamicStructuredTool({
    name: "find_scope",
    description: `List your open memory scopes or filter by name substring.

Omit the name argument (or pass an empty string) to list all scopes for you and the current user, newest first (up to 50). Pass a substring for a case-insensitive filter.`,
    schema: z.object({
      name: z
        .string()
        .optional()
        .describe(
          "Optional substring to filter by. Omit or pass empty string to list all your open scopes.",
        ),
    }),
    func: async ({ name }) => {
      const env = ctx?.memoryAccessEnvelope;
      const agentId = env?.agentId;
      const speakerUserId = await resolveSpeakerUserId(env);
      if (!agentId || !speakerUserId) {
        return "Cannot list scopes: agent or speaker identity missing in this context.";
      }
      const base = {
        parentAgentId: agentId,
        speakerUserId,
      };
      const rows = await findScopes(
        name !== undefined ? { ...base, nameQuery: name } : base,
      );
      if (rows.length === 0) {
        const q = name?.trim() ?? "";
        return q.length === 0
          ? "You have no open scopes."
          : `No scopes match '${q}'.`;
      }
      const payload = rows.map((r) => ({
        scope_id: r.scopeId,
        name: r.name,
        purpose: r.purpose,
        memory_count: r.memoryCount,
        created_at: r.createdAt.toISOString(),
      }));
      return JSON.stringify(payload, null, 2);
    },
  });
}
