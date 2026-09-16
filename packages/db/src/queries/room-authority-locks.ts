import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Database } from "../config/database";
import { rooms } from "../schema/rooms";

const authorityFields = {
  id: rooms.id, namespaceId: rooms.namespaceId, kind: rooms.kind,
  parentRoomId: rooms.parentRoomId, humanActorIds: rooms.humanActorIds,
  namespaceAccessRevision: rooms.namespaceAccessRevision,
};
export type RoomAuthoritySnapshot = Pick<typeof rooms.$inferSelect, keyof typeof authorityFields>;
type RoomAuthorityTransaction = Pick<Database, "select">;

export class RoomAuthorityChangedError extends Error {
  override readonly name = "RoomAuthorityChangedError";
  constructor() { super("Room authority changed during lock discovery"); }
}

/** Structural discovery only: no row locks and no authored content. Include
 * the requested entry Rooms and their Namespace owners, never unrelated child
 * rosters. The returned candidates are not yet an authority proof. */
export async function discoverRoomAuthorityInTx(
  tx: RoomAuthorityTransaction, roomIds: readonly string[], namespaceIds: readonly string[] = [],
): Promise<RoomAuthoritySnapshot[]> {
  const requestedIds = [...new Set(roomIds)];
  const requested = requestedIds.length
    ? await tx.select(authorityFields).from(rooms).where(inArray(rooms.id, requestedIds)) : [];
  const namespaces = [...new Set([...namespaceIds, ...requested.map((room) => room.namespaceId)])];
  if (!namespaces.length) return requested;
  return tx.select(authorityFields).from(rooms).where(or(
    requestedIds.length ? inArray(rooms.id, requestedIds) : undefined,
    and(inArray(rooms.namespaceId, namespaces), ne(rooms.kind, "subthread")),
  ));
}

function commitment(room: RoomAuthoritySnapshot) {
  return JSON.stringify([room.id, room.namespaceId, room.kind, room.parentRoomId,
    [...new Set(room.humanActorIds)].sort(), room.namespaceAccessRevision]);
}

/** Canonical multi-Room lock order: every top-level owner before any child;
 * IDs sorted within each level. Call before member/Actor or object row locks.
 * Rediscovery after this phase must fail rather than take additional Rooms.
 * Per-row acquisition makes the actual SQL lock order explicit. */
export async function lockDiscoveredRoomAuthorityInTx(
  tx: RoomAuthorityTransaction, discovered: readonly RoomAuthoritySnapshot[], mode: "share" | "update",
): Promise<RoomAuthoritySnapshot[]> {
  const byId = new Map(discovered.map((room) => [room.id, room]));
  for (const room of byId.values()) {
    const parent = room.parentRoomId ? byId.get(room.parentRoomId) : undefined;
    if (room.kind === "subthread" && (!parent || parent.kind === "subthread"
      || parent.namespaceId !== room.namespaceId)) {
      throw new RoomAuthorityChangedError();
    }
  }
  const ordered = [...byId.values()].sort((a, b) =>
    Number(a.kind === "subthread") - Number(b.kind === "subthread") || a.id.localeCompare(b.id));
  const locked: RoomAuthoritySnapshot[] = [];
  for (const candidate of ordered) {
    const [current] = await tx.select(authorityFields).from(rooms)
      .where(eq(rooms.id, candidate.id)).for(mode);
    if (!current || commitment(current) !== commitment(candidate)) throw new RoomAuthorityChangedError();
    locked.push(current);
  }
  return locked;
}
