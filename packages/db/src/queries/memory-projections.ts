import type { AgentDatabase } from "../config/agent-database";
import { memories } from "../schema/memories";
import { rooms } from "../schema/rooms";
import { eq } from "drizzle-orm";

type MemoryProjectionQueryDb = Pick<AgentDatabase, "select">;

/**
 * Lightweight preflight for atomic projection replay. The serializable write
 * transaction performs the authoritative locked replay check; this lookup only
 * decides whether an embedding request can be skipped.
 */
export async function findMemoryIdByCreationKeyWith(
  handle: MemoryProjectionQueryDb,
  creationKey: string,
): Promise<string | null> {
  const [memory] = await handle
    .select({ id: memories.id })
    .from(memories)
    .where(eq(memories.creationKey, creationKey))
    .limit(1);
  return memory?.id ?? null;
}

/** Read the destination fields frozen into an atomic projection approval. */
export async function findProjectionRoomByIdWith(
  handle: MemoryProjectionQueryDb,
  roomId: string,
) {
  const [room] = await handle
    .select({
      id: rooms.id,
      namespaceId: rooms.namespaceId,
      label: rooms.label,
      kind: rooms.kind,
      archivedAt: rooms.archivedAt,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  return room ?? null;
}
