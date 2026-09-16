/**
 * M180 — file revision query helpers.
 *
 * Lightweight lookups for checkpoint coalescing and provenance-aware
 * revision resolution. Behavior-free substrate — callers decide what
 * to do with the returned row id.
 */
import { and, desc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import {
  fileRevisions,
  type FileRevisionAuthor,
  type NewFileRevision,
} from "../schema/file-revisions";

/**
 * D448 — resolve a Workspace history row by its logical before/after path.
 * This is used only when ordinary Workspace resolution cannot see a
 * soft-deleted artifact. Agent scoping is retained; Namespace authorization
 * is revalidated by the artifact-store caller before any byte or row change.
 */
export async function findLatestWorkspaceRevisionForLogicalPath(
  db: DirectDatabase,
  input: { agentId: string; ownerId: string; roomId?: string; logicalPath: string },
): Promise<typeof fileRevisions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(fileRevisions)
    .where(
      and(
        eq(fileRevisions.agentId, input.agentId),
        eq(fileRevisions.ownerId, input.ownerId),
        input.roomId === undefined
          ? isNull(fileRevisions.roomId)
          : eq(fileRevisions.roomId, input.roomId),
        isNotNull(fileRevisions.workspaceOperationId),
        or(
          eq(fileRevisions.workspacePathBefore, input.logicalPath),
          eq(fileRevisions.workspacePathAfter, input.logicalPath),
        ),
      ),
    )
    .orderBy(desc(fileRevisions.createdAt), desc(fileRevisions.id))
    .limit(1);
  return rows[0] ?? null;
}

export interface FindRecentRevisionInput {
  agentId: string;
  absolutePath: string;
  authoredBy: FileRevisionAuthor;
  /** Match NULL distinctly from a specific user id. */
  userId?: string | null | undefined;
  since?: Date | undefined;
}

export interface FindRecentRevisionResult {
  id: string;
  createdAt: Date;
}

/**
 * D448 — metadata carried by every revision emitted while reconciling one
 * Workspace logical/native operation group. An overwrite-move can produce two
 * linked revisions with this same id. The fields are nullable so the
 * established local-file history path remains unchanged.
 */
export interface WorkspaceFileRevisionMetadata {
  workspaceArtifactId: string | null;
  workspacePathBefore: string | null;
  workspacePathAfter: string | null;
  workspaceOperationId: string;
}

/**
 * Attach validated D448 grouping metadata to an existing typed revision insert
 * row. The hot/cold backup lanes retain ownership of payload selection; their
 * Workspace caller uses this helper so the logical-history fields cannot be
 * accidentally split between two ad-hoc object literals.
 */
export function withWorkspaceFileRevisionMetadata(
  row: NewFileRevision,
  metadata: WorkspaceFileRevisionMetadata,
): NewFileRevision {
  if (!metadata.workspaceOperationId) {
    throw new Error("Workspace revision metadata requires workspaceOperationId");
  }
  return {
    ...row,
    workspaceArtifactId: metadata.workspaceArtifactId,
    workspacePathBefore: metadata.workspacePathBefore,
    workspacePathAfter: metadata.workspacePathAfter,
    workspaceOperationId: metadata.workspaceOperationId,
  };
}

/**
 * Find the newest revision matching provenance filters for checkpoint
 * coalescing. Uses `idx_file_revisions_path_newest` for the
 * `(agentId, absolutePath, createdAt DESC)` ordering; `authoredBy` and
 * `userId` are filtered post-index.
 */
export async function findRecentRevision(
  db: DirectDatabase,
  input: FindRecentRevisionInput,
): Promise<FindRecentRevisionResult | null> {
  const conditions = [
    eq(fileRevisions.agentId, input.agentId),
    eq(fileRevisions.absolutePath, input.absolutePath),
    eq(fileRevisions.authoredBy, input.authoredBy),
  ];

  if (input.userId === null || input.userId === undefined) {
    conditions.push(isNull(fileRevisions.userId));
  } else {
    conditions.push(eq(fileRevisions.userId, input.userId));
  }

  if (input.since) {
    conditions.push(gte(fileRevisions.createdAt, input.since));
  }

  const rows = await db
    .select({ id: fileRevisions.id, createdAt: fileRevisions.createdAt })
    .from(fileRevisions)
    .where(and(...conditions))
    .orderBy(desc(fileRevisions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
