import type { MemoryDetail } from "@nautilo/agent";

/** Keep internal funding evidence out of the existing ordinary Memory DTO. */
export function projectOrdinaryMemoryDetail(
  row: MemoryDetail,
): Omit<MemoryDetail, "contentRevision" | "modelExposureDependencies"> {
  return {
    id: row.id, type: row.type, content: row.content, importance: row.importance,
    tier: row.tier, createdAt: row.createdAt, updatedAt: row.updatedAt,
    demotedAt: row.demotedAt, demotedFrom: row.demotedFrom,
    namespaceIds: row.namespaceIds,
  };
}
