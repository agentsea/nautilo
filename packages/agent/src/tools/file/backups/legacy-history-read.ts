import {
  agentDb as db,
  and,
  desc,
  eq,
  fileRevisions,
  type FileRevision,
} from "@nautilo/db";

/**
 * Read-only compatibility lookup for pre-D448 `file_revisions` rows.
 *
 * Legacy rows remain enumerable for migration/audit compatibility, but no
 * server-side restore mutation is exposed. Canonical Workspace and Desktop
 * coordinators own all new undo/redo execution.
 */
export async function findLatestRevisionForPath(
  agentId: string,
  absolutePath: string,
): Promise<FileRevision | null> {
  const rows = await db
    .select()
    .from(fileRevisions)
    .where(
      and(
        eq(fileRevisions.agentId, agentId),
        eq(fileRevisions.absolutePath, absolutePath),
      ),
    )
    .orderBy(desc(fileRevisions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
