import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { listAgentUsers } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

interface ListMyUsersContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

export function createListMyUsersTool(context?: ListMyUsersContext) {
  return new DynamicStructuredTool({
    name: "list_my_users",
    description: `List every local Human member seated on this Server. There is no per-Agent contact roster: any Agent can use the returned handle to contact any listed member through ask_peer, subject to the caller's normal invoke_agents permission.

Use this when the user mentions another person by name and you need to resolve which member they mean (for example before ask_peer, share_artifact, or share_memory). Returns each member's handle, display name, and highest Server role.`,
    schema: z.object({}),
    func: async () => {
      const agentId = context?.memoryAccessEnvelope?.agentId;
      if (!agentId) {
        return "Cannot list users: agent identity not available in this context.";
      }
      const rows = await listAgentUsers(agentId);
      if (rows.length === 0) {
        return "No users found for this agent.";
      }
      return JSON.stringify(rows, null, 2);
    },
  });
}
