/**
 * D448 Phase 11 — normalized Workspace history reads.
 *
 * Canonical coordinator receipts are the only writable history source.
 * Historical `file_revisions` rows remain enumerable under an explicit,
 * read-only boundary so stable revision ids do not disappear at cutover.
 */

import {
  agentDb as db,
  and,
  desc,
  eq,
  fileRevisions,
  findOwnedWorkspaceHistoryByRevisionId,
  gte,
  listWorkspaceDocumentHistory,
  lte,
  setOwnedWorkspaceHistoryGroupPinned,
  type FileRevision,
  type SQL,
  type WorkspaceDocumentHistoryRecord,
} from "@nautilo/db";

export const LEGACY_WORKSPACE_HISTORY_UNVERIFIABLE =
  "legacy_history_unverifiable";
export const LEGACY_WORKSPACE_HISTORY_READ_ONLY =
  "legacy_history_read_only";

export type NormalizedWorkspaceHistorySource = "canonical" | "legacy";
export type NormalizedWorkspaceRestoreVerification =
  | "verified"
  | "unverifiable";

export interface NormalizedWorkspaceHistoryRevision {
  readonly revisionId: string;
  readonly turnId: string;
  readonly path: string;
  readonly operation: string;
  readonly kind: "canonical" | "diff" | "blob" | "tombstone";
  readonly preSize: number;
  readonly createdAt: string;
  readonly pinned: boolean;
  readonly summary: string;
  readonly historySource: NormalizedWorkspaceHistorySource;
  readonly restoreVerification: NormalizedWorkspaceRestoreVerification;
}

export interface ListNormalizedWorkspaceHistoryInput {
  readonly ownerId: string;
  readonly agentId: string;
  readonly logicalPath?: string;
  readonly legacyAbsolutePath?: string;
  readonly turnId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly pinnedOnly?: boolean;
  readonly limit: number;
}

export type WorkspaceHistoryRevisionTarget =
  | {
      readonly kind: "canonical";
      readonly record: WorkspaceDocumentHistoryRecord;
    }
  | {
      readonly kind: "legacy";
      readonly revision: FileRevision;
      readonly restoreVerification: "unverifiable";
    }
  | { readonly kind: "missing" };

function canonicalPath(
  record: WorkspaceDocumentHistoryRecord,
): string {
  return (
    record.entry.afterLogicalPath ??
    record.entry.beforeLogicalPath ??
    record.entry.destinationBeforeLogicalPath ??
    ""
  );
}

function canonicalPreSize(
  record: WorkspaceDocumentHistoryRecord,
): number {
  return (
    record.entry.beforeSize ??
    record.entry.destinationBeforeSize ??
    0
  );
}

function summarizeCanonical(
  record: WorkspaceDocumentHistoryRecord,
): NormalizedWorkspaceHistoryRevision {
  const path = canonicalPath(record);
  const createdAt = record.mutation.createdAt.toISOString();
  const preSize = canonicalPreSize(record);
  return {
    revisionId: record.revisionId,
    turnId: record.mutation.turnId ?? "",
    path,
    operation: record.entry.historyOperation,
    kind: "canonical",
    preSize,
    createdAt,
    pinned: record.mutation.pinned,
    summary:
      `${record.entry.historyOperation} on ${path} at ${createdAt} ` +
      `(canonical ${record.entry.mutationKind}; pre-size ${(preSize / 1024).toFixed(1)} KB)`,
    historySource: "canonical",
    restoreVerification: "verified",
  };
}

function summarizeLegacy(
  revision: FileRevision,
): NormalizedWorkspaceHistoryRevision {
  const createdAt = revision.createdAt.toISOString();
  const sizeKB = (revision.preSize / 1024).toFixed(1);
  const path =
    revision.workspacePathAfter ??
    revision.workspacePathBefore ??
    revision.workspacePath ??
    revision.absolutePath;
  return {
    revisionId: revision.id,
    turnId: revision.turnId,
    path,
    operation: revision.operation,
    kind: revision.kind as "diff" | "blob" | "tombstone",
    preSize: revision.preSize,
    createdAt,
    pinned: revision.pinned,
    summary:
      `${revision.operation} on ${path} at ${createdAt} ` +
      `(read-only legacy ${revision.kind}; pre-size ${sizeKB} KB)`,
    historySource: "legacy",
    restoreVerification: "unverifiable",
  };
}

async function listLegacyWorkspaceHistory(
  input: ListNormalizedWorkspaceHistoryInput,
): Promise<readonly FileRevision[]> {
  const clauses: SQL[] = [
    eq(fileRevisions.ownerId, input.ownerId),
    eq(fileRevisions.agentId, input.agentId),
  ];
  if (input.legacyAbsolutePath) {
    clauses.push(eq(fileRevisions.absolutePath, input.legacyAbsolutePath));
  }
  if (input.logicalPath) {
    clauses.push(eq(fileRevisions.workspacePath, input.logicalPath));
  }
  if (input.turnId) clauses.push(eq(fileRevisions.turnId, input.turnId));
  if (input.since) clauses.push(gte(fileRevisions.createdAt, input.since));
  if (input.until) clauses.push(lte(fileRevisions.createdAt, input.until));
  if (input.pinnedOnly) clauses.push(eq(fileRevisions.pinned, true));
  return await db
    .select()
    .from(fileRevisions)
    .where(and(...clauses))
    .orderBy(desc(fileRevisions.createdAt), desc(fileRevisions.id))
    .limit(input.limit + 1);
}

export async function listNormalizedWorkspaceHistory(
  input: ListNormalizedWorkspaceHistoryInput,
): Promise<{
  readonly revisions: readonly NormalizedWorkspaceHistoryRevision[];
  readonly truncated: boolean;
}> {
  const [canonical, legacy] = await Promise.all([
    input.legacyAbsolutePath
      ? Promise.resolve([])
      : listWorkspaceDocumentHistory(db, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          ...(input.logicalPath ? { logicalPath: input.logicalPath } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
          ...(input.pinnedOnly ? { pinnedOnly: true } : {}),
          limit: input.limit + 1,
        }),
    listLegacyWorkspaceHistory(input),
  ]);
  const combined = [
    ...canonical.map(summarizeCanonical),
    ...legacy.map(summarizeLegacy),
  ].sort((left, right) => {
    const timestamp =
      Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return timestamp !== 0
      ? timestamp
      : right.revisionId.localeCompare(left.revisionId);
  });
  return {
    revisions: combined.slice(0, input.limit),
    truncated: combined.length > input.limit,
  };
}

export async function resolveWorkspaceHistoryRevisionTarget(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly revisionId: string;
}): Promise<WorkspaceHistoryRevisionTarget> {
  const canonical = await findOwnedWorkspaceHistoryByRevisionId(db, input);
  if (canonical) return { kind: "canonical", record: canonical };
  const [legacy] = await db
    .select()
    .from(fileRevisions)
    .where(and(
      eq(fileRevisions.id, input.revisionId),
      eq(fileRevisions.ownerId, input.ownerId),
      eq(fileRevisions.agentId, input.agentId),
    ))
    .limit(1);
  return legacy
    ? {
        kind: "legacy",
        revision: legacy,
        restoreVerification: "unverifiable",
      }
    : { kind: "missing" };
}

export async function setCanonicalWorkspaceHistoryPinned(input: {
  readonly ownerId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly pinned: boolean;
}): Promise<
  | { readonly kind: "updated" }
  | { readonly kind: "legacy_read_only" }
  | { readonly kind: "missing" }
> {
  const target = await resolveWorkspaceHistoryRevisionTarget(input);
  if (target.kind === "legacy") return { kind: "legacy_read_only" };
  if (target.kind === "missing") return target;
  const updated = await setOwnedWorkspaceHistoryGroupPinned(db, input);
  return updated ? { kind: "updated" } : { kind: "missing" };
}

export function legacyWorkspaceRestoreFailure(revisionId: string): string {
  return JSON.stringify({
    error: LEGACY_WORKSPACE_HISTORY_UNVERIFIABLE,
    revisionId,
    hint:
      "This read-only legacy Workspace revision has no provable post-version. " +
      "Restoring it could erase a later human edit, so the restore is refused.",
  });
}
