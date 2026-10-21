import type { RoomSummaryDto } from "@nautilo/types";

function createdAtMillis(room: RoomSummaryDto): number {
  const value = Date.parse(room.createdAt);
  return Number.isNaN(value) ? 0 : value;
}

function isOwnedPersonalRoom(
  room: RoomSummaryDto,
  viewerActorId: string,
  ownedAgentId: string,
): boolean {
  if (
    room.type !== "private"
    || room.kind !== "private"
    || room.memberCount !== 2
    || room.roster?.length !== 2
  ) {
    return false;
  }

  const first = room.roster[0];
  const second = room.roster[1];
  const user = first.kind === "user" ? first : second.kind === "user" ? second : null;
  const agent = first.kind === "agent" ? first : second.kind === "agent" ? second : null;
  return user?.actorId === viewerActorId && agent?.agentId === ownedAgentId;
}

/**
 * Resolve the existing strict Human/owned-Genie Personal chat using the same
 * preference order as the server's default-room resolver.
 */
export function resolveOwnedPersonalRoom(
  rooms: readonly RoomSummaryDto[],
  viewerActorId: string,
  ownedAgentId: string,
): RoomSummaryDto | null {
  const candidates = rooms.filter((room) =>
    isOwnedPersonalRoom(room, viewerActorId, ownedAgentId),
  );
  candidates.sort((a, b) => {
    const legacyDifference = Number(b.graphThreadId === "app:default")
      - Number(a.graphThreadId === "app:default");
    if (legacyDifference !== 0) return legacyDifference;
    const createdDifference = createdAtMillis(a) - createdAtMillis(b);
    return createdDifference !== 0 ? createdDifference : a.id.localeCompare(b.id);
  });
  return candidates[0] ?? null;
}
