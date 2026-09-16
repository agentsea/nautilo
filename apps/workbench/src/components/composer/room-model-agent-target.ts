import type { RoomMemberDto } from "@nautilo/types";
import type { FocusRing } from "../../modes/rooms/shape/members-panel-model";

/**
 * Resolves the exact owned Agent whose Room-level model controls may be
 * changed. Room focus is a useful disambiguator only when the viewer owns
 * more than one Agent in this Room; other members' Agents must not make a
 * sole owned Agent ambiguous.
 */
export function resolveRoomModelAgentTarget({
  members,
  ownedAgentIds,
  ring,
}: {
  readonly members: readonly RoomMemberDto[];
  readonly ownedAgentIds: ReadonlySet<string>;
  readonly ring: FocusRing;
}): string | null {
  const ownedRoomAgents = members.filter(
    (member): member is RoomMemberDto & { kind: "agent"; agentId: string } =>
      member.kind === "agent" &&
      typeof member.agentId === "string" &&
      ownedAgentIds.has(member.agentId),
  );

  if (ownedRoomAgents.length === 1) return ownedRoomAgents[0].agentId;
  if (ownedRoomAgents.length === 0 || ring.kind !== "single") return null;

  const focusedOwnedAgent = ownedRoomAgents.find(
    (member) => member.actorId === ring.botActorId,
  );
  return focusedOwnedAgent?.agentId ?? null;
}
