import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { loadRoomRoster } from "@nautilo/trust";
import type { MemoryAccessEnvelope } from "@nautilo/trust";

interface GetRoomMembersContext {
  roomId?: string;
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
}

/**
 * M137 follow-up #5 — room-scoped roster. Unlike `list_my_users` (the
 * agent-wide directory of every human this agent knows), this lists the
 * participants of the CURRENT room — both humans and agents — so the agent
 * can resolve who is actually present (e.g. before mentioning or sharing
 * into this room).
 */
export function createGetRoomMembersTool(context?: GetRoomMembersContext) {
  return new DynamicStructuredTool({
    name: "get_room_members",
    description: `List the participants of the CURRENT room — both people and agents — with their handle, display name, kind, and role.

Use this to see who is actually in this room right now (e.g. to address someone, or before sharing something into this room). This is room-scoped: it does NOT list everyone you know across all rooms — use list_my_users for the agent-wide directory.`,
    schema: z.object({}),
    func: async () => {
      const roomId = context?.roomId ?? context?.memoryAccessEnvelope?.roomId ?? "";
      if (!roomId) {
        return "Cannot list room members: no room in this context.";
      }
      const roster = await loadRoomRoster(roomId);
      if (roster.length === 0) {
        return "No members found for this room.";
      }
      const members = roster.map((p) => ({
        handle: p.handle ?? null,
        displayName: p.displayName,
        kind: p.kind,
        roomRole: p.roomRole,
        ...(p.kind === "agent" ? { agentResponseMode: p.agentResponseMode ?? "active" } : {}),
      }));
      return JSON.stringify(members, null, 2);
    },
  });
}
