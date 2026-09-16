import {
  getSharedDirectDb,
  memories,
  memoryNamespaces,
  eq,
  and,
} from "@nautilo/db";

export type CascadeMemoriesOnNamespaceDeleteOptions = {
  /**
   * Integration-test hook: throw after detaching the doomed edge but before
   * counting remaining attachments / delete. Verifies per-memory
   * transactions roll back and never leave orphan memories (ISSUE-M076 #5).
   */
  testFaultAfterDetachForMemoryId?: string;
};

/**
 * Called BEFORE deleting a Namespace (or its Room). Detaches every memory from
 * the doomed namespace. For memories with no remaining Namespace edges after
 * detach, deletes the memory row (M081 — no owner-based re-home).
 *
 * Each memory is processed in its own DB transaction so a crash mid-batch cannot
 * leave an orphan memory (detached from all namespaces but row still present).
 *
 * No production caller yet — wire `deleteRoom` to call this before dropping the
 * Namespace row (FK `memory_namespaces.namespace_id` is ON DELETE RESTRICT).
 */
export async function cascadeMemoriesOnNamespaceDelete(
  namespaceId: string,
  options?: CascadeMemoriesOnNamespaceDeleteOptions,
): Promise<{ detached: number; fellBackTo: number; deleted: number }> {
  const db = getSharedDirectDb();
  let detached = 0;
  let deleted = 0;

  const pairs = await db
    .select({
      memoryId: memories.id,
    })
    .from(memoryNamespaces)
    .innerJoin(memories, eq(memories.id, memoryNamespaces.memoryId))
    .where(eq(memoryNamespaces.namespaceId, namespaceId));

  const seen = new Set<string>();
  for (const row of pairs) {
    const { memoryId } = row;
    if (seen.has(memoryId)) continue;
    seen.add(memoryId);

    const outcome = await db.transaction(async (tx) => {
      await tx
        .delete(memoryNamespaces)
        .where(
          and(
            eq(memoryNamespaces.memoryId, memoryId),
            eq(memoryNamespaces.namespaceId, namespaceId),
          ),
        );

      if (options?.testFaultAfterDetachForMemoryId === memoryId) {
        throw new Error("injected cascade fault");
      }

      const remaining = await tx
        .select({ memoryId: memoryNamespaces.memoryId })
        .from(memoryNamespaces)
        .where(eq(memoryNamespaces.memoryId, memoryId));
      if (remaining.length > 0) {
        return "still_attached" as const;
      }

      await tx.delete(memories).where(eq(memories.id, memoryId));
      return "deleted" as const;
    });

    detached++;
    if (outcome === "deleted") deleted++;
  }

  return { detached, fellBackTo: 0, deleted };
}
