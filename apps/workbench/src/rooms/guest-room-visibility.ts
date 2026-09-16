import type { RoomSummaryDto } from "@nautilo/types";

/**
 * A strict Human-Agent DM is execution chrome, not a safe Guest landing.
 * Summary rosters are authoritative server projections; unknown rosters are
 * retained until hydrated rather than guessed from labels or Room kind.
 */
export function isStrictHumanAgentRoom(
  room: RoomSummaryDto,
  viewerActorId: string | null,
): boolean {
  const roster = room.roster;
  if (!viewerActorId || !roster || roster.length !== 2) return false;
  return roster.some((member) =>
    member.kind === "user" && member.actorId === viewerActorId,
  ) && roster.some((member) => member.kind === "agent");
}

export function roomsVisibleToViewer(
  rooms: RoomSummaryDto[],
  input: { viewerActorId: string | null; canInvokeAgents: boolean },
): RoomSummaryDto[] {
  if (input.canInvokeAgents) return rooms;
  return rooms.filter((room) =>
    !isStrictHumanAgentRoom(room, input.viewerActorId),
  );
}
