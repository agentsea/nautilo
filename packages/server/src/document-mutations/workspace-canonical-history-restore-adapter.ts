import { createHash } from "node:crypto";
import type {
  WorkspaceCanonicalHistoryRestoreExecution,
  WorkspaceCanonicalHistoryRestoreRequest,
  WorkspaceCanonicalHistoryRestoreResult,
} from "@nautilo/agent";
import {
  and,
  eq,
  fileRevisions,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findOwnedWorkspaceHistoryByEntryId,
  findOwnedWorkspaceHistoryByRevisionId,
  resolveWorkspaceDocumentHistoryLineage,
  resolveWorkspaceRoomMutationAuthority,
  type DirectDatabase,
  type WorkspaceDocumentHistoryRecord,
} from "@nautilo/db";
import type { BackendCommitPlan } from "@nautilo/document-mutations";
import type {
  WorkspaceDocumentIdentity,
  WorkspaceDocumentVersion,
} from "@nautilo/types";
import {
  executeWorkspaceAgentMutation,
  type WorkspaceAgentMutationCoordinatorDependencies,
} from "./workspace-agent-mutation-coordinator";
import { readWorkspaceDocumentMutationContent } from "./workspace-artifact-mutation-backend";
import { getServerDirectDb } from "../lib/server-direct-db";
import { workspaceFileMutationOperationId } from "./workspace-file-content-coordinator-adapter";

export type WorkspaceCanonicalHistoryRestoreDependencies =
  WorkspaceAgentMutationCoordinatorDependencies & {
    readonly readContent?: (storageUri: string) => Promise<Uint8Array>;
  };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorityMatches(request: WorkspaceCanonicalHistoryRestoreRequest): boolean {
  const { authority } = request;
  return (
    authority.ownerId.length > 0 &&
    authority.agentId.length > 0 &&
    authority.roomId.length > 0 &&
    authority.turnId.length > 0 &&
    authority.envelope.ownerId === authority.ownerId &&
    authority.envelope.agentId === authority.agentId &&
    authority.envelope.roomId === authority.roomId
  );
}

function recordPath(record: WorkspaceDocumentHistoryRecord): string {
  return (
    record.entry.afterLogicalPath ??
    record.entry.beforeLogicalPath ??
    ""
  );
}

async function selectRecord(
  db: DirectDatabase,
  request: WorkspaceCanonicalHistoryRestoreRequest,
): Promise<
  | {
      readonly kind: "canonical";
      readonly record: WorkspaceDocumentHistoryRecord;
      readonly currentRecord: WorkspaceDocumentHistoryRecord;
    }
  | { readonly kind: "legacy" }
  | { readonly kind: "missing" }
  | { readonly kind: "broken" }
> {
  const scope = {
    ownerId: request.authority.ownerId,
    agentId: request.authority.agentId,
  };
  const lineage = await resolveWorkspaceDocumentHistoryLineage(db, {
    ...scope,
    logicalPath: request.logicalPath,
  });
  if (lineage.kind === "broken") return { kind: "broken" };
  const canonicalSelection = (
    record: WorkspaceDocumentHistoryRecord,
  ): {
    readonly kind: "canonical";
    readonly record: WorkspaceDocumentHistoryRecord;
    readonly currentRecord: WorkspaceDocumentHistoryRecord;
  } | { readonly kind: "missing" } =>
    lineage.current
      ? { kind: "canonical", record, currentRecord: lineage.current }
      : { kind: "missing" };

  if (request.revisionId) {
    const canonical = await findOwnedWorkspaceHistoryByRevisionId(db, {
      ...scope,
      revisionId: request.revisionId,
    });
    if (canonical) {
      return (
        recordPath(canonical) === request.logicalPath &&
        lineage.undo.at(-1)?.entry.id === canonical.entry.id
      )
        ? canonicalSelection(canonical)
        : { kind: "missing" };
    }
    const [legacy] = await db
      .select({ id: fileRevisions.id })
      .from(fileRevisions)
      .where(and(
        eq(fileRevisions.id, request.revisionId),
        eq(fileRevisions.ownerId, scope.ownerId),
        eq(fileRevisions.agentId, scope.agentId),
      ))
      .limit(1);
    return legacy ? { kind: "legacy" } : { kind: "missing" };
  }
  if (request.command === "redo") {
    const record = lineage.redo.at(-1);
    return record ? canonicalSelection(record) : { kind: "missing" };
  }
  if (request.targetTurnId) {
    const record = lineage.undo.at(-1);
    return record?.mutation.turnId === request.targetTurnId
      ? canonicalSelection(record)
      : { kind: "missing" };
  }
  const record = lineage.undo.at(-1);
  return record ? canonicalSelection(record) : { kind: "missing" };
}

function identity(
  artifactId: string,
  logicalPath: string,
): WorkspaceDocumentIdentity {
  return { kind: "workspace_artifact", artifactId, logicalPath };
}

function version(
  artifactId: string,
  logicalPath: string,
  revision: number,
  sha256: string,
): WorkspaceDocumentVersion {
  return {
    identity: identity(artifactId, logicalPath),
    backendVersion: { kind: "artifact_revision", revision },
    sha256,
  };
}

async function exactBytes(
  readContent: (storageUri: string) => Promise<Uint8Array>,
  input: { storageUri: string | null; sha256: string | null; size: number | null },
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!input.storageUri || !input.sha256 || input.size === null) return null;
  const bytes = await readContent(input.storageUri);
  return bytes.byteLength === input.size && sha256Hex(bytes) === input.sha256
    ? new Uint8Array([...bytes])
    : null;
}

async function inversePlan(input: {
  operationId: string;
  turnId: string;
  agentId: string;
  record: WorkspaceDocumentHistoryRecord;
  currentRecord: WorkspaceDocumentHistoryRecord;
  restoreSource: WorkspaceDocumentHistoryRecord | null;
  readContent: (storageUri: string) => Promise<Uint8Array>;
}): Promise<{
  plan: BackendCommitPlan<"workspace">;
  restoreDeletedArtifactIds?: readonly string[];
} | null> {
  const entry = input.record.entry;
  const currentEntry = input.currentRecord.entry;
  const artifactId = entry.artifactInternalId;
  if (
    entry.destinationBeforeArtifactInternalId !== null ||
    currentEntry.artifactInternalId !== artifactId
  ) return null;

  const invertRestoreOfDelete =
    entry.mutationKind === "update" &&
    input.restoreSource?.entry.mutationKind === "delete";
  if (entry.mutationKind === "create" || invertRestoreOfDelete) {
    const currentBytes = await exactBytes(input.readContent, {
      storageUri: currentEntry.afterStorageUri,
      sha256: currentEntry.afterSha256,
      size: currentEntry.afterSize,
    });
    if (
      currentBytes === null ||
      currentEntry.afterLogicalPath === null ||
      currentEntry.afterRevision === null ||
      currentEntry.afterSha256 === null
    ) return null;
    return {
      plan: {
        operationId: input.operationId,
        actor: { kind: "agent", agentId: input.agentId },
        turnId: input.turnId,
        entries: [{
          kind: "delete",
          before: {
            identity: identity(artifactId, currentEntry.afterLogicalPath),
            expectedVersion: version(
              artifactId,
              currentEntry.afterLogicalPath,
              currentEntry.afterRevision,
              currentEntry.afterSha256,
            ),
            bytes: currentBytes,
          },
        }],
      },
    };
  }

  if (entry.mutationKind === "delete") {
    const targetBytes = await exactBytes(input.readContent, {
      storageUri: entry.beforeStorageUri,
      sha256: entry.beforeSha256,
      size: entry.beforeSize,
    });
    if (
      targetBytes === null ||
      entry.beforeLogicalPath === null ||
      entry.beforeRevision === null ||
      entry.beforeSha256 === null
    ) return null;
    const currentRevision = entry.beforeRevision + 1;
    return {
      plan: {
        operationId: input.operationId,
        actor: { kind: "agent", agentId: input.agentId },
        turnId: input.turnId,
        entries: [{
          kind: "update",
          before: {
            identity: identity(artifactId, entry.beforeLogicalPath),
            expectedVersion: version(
              artifactId,
              entry.beforeLogicalPath,
              currentRevision,
              entry.beforeSha256,
            ),
            bytes: targetBytes,
          },
          after: {
            identity: identity(artifactId, entry.beforeLogicalPath),
            bytes: targetBytes,
            sha256: entry.beforeSha256,
          },
        }],
      },
      restoreDeletedArtifactIds: [artifactId],
    };
  }

  const currentBytes = await exactBytes(input.readContent, {
    storageUri: currentEntry.afterStorageUri,
    sha256: currentEntry.afterSha256,
    size: currentEntry.afterSize,
  });
  const targetBytes = await exactBytes(input.readContent, {
    storageUri: entry.beforeStorageUri,
    sha256: entry.beforeSha256,
    size: entry.beforeSize,
  });
  if (
    currentBytes === null ||
    targetBytes === null ||
    currentEntry.afterLogicalPath === null ||
    entry.beforeLogicalPath === null ||
    currentEntry.afterRevision === null ||
    currentEntry.afterSha256 === null ||
    entry.beforeSha256 === null
  ) return null;
  const before = {
    identity: identity(artifactId, currentEntry.afterLogicalPath),
    expectedVersion: version(
      artifactId,
      currentEntry.afterLogicalPath,
      currentEntry.afterRevision,
      currentEntry.afterSha256,
    ),
    bytes: currentBytes,
  };
  const after = {
    identity: identity(artifactId, entry.beforeLogicalPath),
    bytes: targetBytes,
    sha256: entry.beforeSha256,
  };
  return {
    plan: {
      operationId: input.operationId,
      actor: { kind: "agent", agentId: input.agentId },
      turnId: input.turnId,
      entries: [entry.mutationKind === "move"
        ? { kind: "move" as const, source: before, after }
        : { kind: "update" as const, before, after }],
    },
  };
}

export function createWorkspaceCanonicalHistoryRestoreExecution(
  dependencies: WorkspaceCanonicalHistoryRestoreDependencies,
): WorkspaceCanonicalHistoryRestoreExecution {
  return async (request): Promise<WorkspaceCanonicalHistoryRestoreResult> => {
    if (!authorityMatches(request)) {
      return {
        ok: false,
        code: "missing_context",
        message: "Canonical Workspace restore authority is unavailable.",
      };
    }
    const db = dependencies.db ?? getServerDirectDb();
    const operationId = workspaceFileMutationOperationId(
      request.mutationRequestId,
    );
    const authorityInput = {
      humanActorId: request.authority.envelope.actorId,
      agentId: request.authority.agentId,
      roomId: request.authority.roomId,
    };
    const currentAuthority = dependencies.resolveRoomAuthority
      ? await dependencies.resolveRoomAuthority(authorityInput)
      : await resolveWorkspaceRoomMutationAuthority(authorityInput, db);
    if (!currentAuthority) {
      return {
        ok: false,
        code: "reapply_required",
        message: "Current Room authority no longer permits this restore.",
      };
    }

    const selected = await selectRecord(db, request);
    if (selected.kind === "legacy") {
      return {
        ok: false,
        code: "legacy_history_unverifiable",
        message:
          "This read-only legacy Workspace revision has no provable current version.",
      };
    }
    if (selected.kind === "broken") {
      return {
        ok: false,
        code: "reapply_required",
        message: "Canonical Workspace history lineage is inconsistent.",
      };
    }
    if (selected.kind === "missing") {
      return {
        ok: false,
        code:
          request.command === "redo"
            ? "nothing_to_redo"
            : request.revisionId
              ? "revision_not_found"
              : "no_revisions",
        message: "No eligible canonical Workspace history entry was found.",
      };
    }
    const authorizedArtifact =
      await findArtifactByInternalIdForNamespacesIncludingDeleted(
        {
          internalId: selected.record.entry.artifactInternalId,
          mutableNamespaceIds: [
            ...currentAuthority.readableNamespaceIds,
          ],
        },
        db,
      );
    if (!authorizedArtifact) {
      return {
        ok: false,
        code: "reapply_required",
        message:
          "The canonical history target is outside current Room authority.",
      };
    }
    const restoreSource = selected.record.entry.restoreFromEntryId
      ? await findOwnedWorkspaceHistoryByEntryId(db, {
          ownerId: request.authority.ownerId,
          agentId: request.authority.agentId,
          entryId: selected.record.entry.restoreFromEntryId,
        })
      : null;
    const inverse = await inversePlan({
      operationId,
      turnId: request.authority.turnId,
      agentId: request.authority.agentId,
      record: selected.record,
      currentRecord: selected.currentRecord,
      restoreSource,
      readContent:
        dependencies.readContent ?? readWorkspaceDocumentMutationContent,
    });
    if (!inverse) {
      return {
        ok: false,
        code: "reapply_required",
        message:
          selected.record.entry.destinationBeforeArtifactInternalId !== null
            ? "Canonical overwrite-move restore is not yet supported atomically."
            : "Canonical restore receipt is incomplete or its immutable bytes are unavailable.",
      };
    }
    const outcome = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: request.authority.envelope.actorId,
          ownerId: request.authority.ownerId,
          agentId: request.authority.agentId,
          roomId: request.authority.roomId,
        },
        operationId,
        revisionGroupId: `workspace-history-turn:${request.authority.turnId}`,
        lane: "file_tool",
        historyOperation: request.command,
        restoreFromEntryId: selected.record.entry.id,
        ...(inverse.restoreDeletedArtifactIds === undefined
          ? {}
          : {
              restoreDeletedArtifactIds:
                inverse.restoreDeletedArtifactIds,
            }),
        plan: inverse.plan,
      },
      dependencies,
    );
    if (outcome.kind === "unknown") {
      return {
        ok: false,
        code: "unknown",
        message: "Canonical Workspace restore outcome is unknown.",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      };
    }
    if (outcome.kind === "rejected") {
      const conflict =
        outcome.outcome.result.kind === "conflict" ||
        outcome.diagnosticCodes.includes("stale_precondition");
      return {
        ok: false,
        code: conflict ? "human_edit_conflict" : "reapply_required",
        message: conflict
          ? "The Workspace artifact changed after this history entry; the human edit wins."
          : "Canonical Workspace restore was rejected by current authority or version checks.",
      };
    }
    const artifactId = selected.record.entry.artifactInternalId;
    return {
      ok: true,
      revisionId: outcome.revisionIds[0]!.at(-1)!,
      artifactId,
      artifactInternalId: artifactId,
    };
  };
}
