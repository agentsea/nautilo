/** Canonical, atomic Workspace undo_turn selection and commit adapter. */
import { createHash } from "node:crypto";
import type {
  WorkspaceCanonicalUndoTurnExecution,
  WorkspaceCanonicalUndoTurnOutcome,
  WorkspaceCanonicalUndoTurnRequest,
  WorkspaceCanonicalUndoTurnResult,
} from "@nautilo/agent";
import {
  acquireWorkspaceDocumentMutationOperationLock,
  and,
  eq,
  fileRevisions,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findOwnedWorkspaceHistoryByEntryId,
  findWorkspaceDocumentMutationForRecovery,
  listWorkspaceHistoryForTurn,
  resolveWorkspaceDocumentHistoryLineageForArtifact,
  resolveWorkspaceRoomMutationAuthority,
  type Artifact,
  type DirectDatabase,
  type WorkspaceDocumentHistoryLineage,
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
import { workspaceFileMutationOperationId } from "./workspace-file-content-coordinator-adapter";
import { getServerDirectDb } from "../lib/server-direct-db";

export type WorkspaceCanonicalUndoTurnDependencies =
  WorkspaceAgentMutationCoordinatorDependencies & {
    readonly readContent?: (storageUri: string) => Promise<Uint8Array>;
  };

export type WorkspaceUndoTurnArtifactSelection = Readonly<{
  artifactInternalId: string;
  current: WorkspaceDocumentHistoryRecord;
  earliest: WorkspaceDocumentHistoryRecord;
  restoreFromEntryId: string;
}>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorityMatches(request: WorkspaceCanonicalUndoTurnRequest): boolean {
  const { authority } = request;
  return (
    authority.ownerId.length > 0 &&
    authority.agentId.length > 0 &&
    authority.roomId.length > 0 &&
    authority.turnId.length > 0 &&
    request.targetTurnId.trim().length > 0 &&
    authority.envelope.ownerId === authority.ownerId &&
    authority.envelope.agentId === authority.agentId &&
    authority.envelope.roomId === authority.roomId
  );
}

export function workspaceUndoTurnTargetsCurrentTurn(
  request: WorkspaceCanonicalUndoTurnRequest,
): boolean {
  return request.targetTurnId === request.authority.turnId;
}

function isRestoreOperation(operation: string): boolean {
  return (
    operation === "undo" ||
    operation === "redo" ||
    operation === "undo_turn"
  );
}

export function selectWorkspaceUndoTurnArtifact(
  input: {
    readonly artifactInternalId: string;
    readonly targetTurnId: string;
    readonly targetRecords: readonly WorkspaceDocumentHistoryRecord[];
    readonly lineage: WorkspaceDocumentHistoryLineage;
  },
):
  | { readonly kind: "selected"; readonly selection: WorkspaceUndoTurnArtifactSelection }
  | { readonly kind: "ineligible" } {
  if (
    input.lineage.kind === "broken" ||
    input.targetRecords.length === 0 ||
    input.targetRecords.some((record) =>
      record.entry.artifactInternalId !== input.artifactInternalId ||
      record.mutation.turnId !== input.targetTurnId ||
      isRestoreOperation(record.entry.historyOperation) ||
      record.entry.destinationBeforeArtifactInternalId !== null
    )
  ) {
    return { kind: "ineligible" };
  }
  const { undo, redo, current } = input.lineage;
  if (
    current === null ||
    redo.some((record) => record.mutation.turnId === input.targetTurnId)
  ) {
    return { kind: "ineligible" };
  }
  let suffixStart = undo.length;
  while (
    suffixStart > 0 &&
    undo[suffixStart - 1]!.mutation.turnId === input.targetTurnId
  ) {
    suffixStart -= 1;
  }
  const suffix = undo.slice(suffixStart);
  const targetIds = new Set(input.targetRecords.map((record) => record.entry.id));
  if (
    suffix.length === 0 ||
    suffix.length !== targetIds.size ||
    suffix.some((record) =>
      !targetIds.has(record.entry.id) ||
      isRestoreOperation(record.entry.historyOperation)
    ) ||
    undo.slice(0, suffixStart).some(
      (record) => record.mutation.turnId === input.targetTurnId,
    )
  ) {
    return { kind: "ineligible" };
  }
  return {
    kind: "selected",
    selection: {
      artifactInternalId: input.artifactInternalId,
      current,
      earliest: suffix[0]!,
      restoreFromEntryId: suffix.at(-1)!.entry.id,
    },
  };
}

function identity(
  artifactInternalId: string,
  logicalPath: string,
): WorkspaceDocumentIdentity {
  return {
    kind: "workspace_artifact",
    artifactId: artifactInternalId,
    logicalPath,
  };
}

async function exactBytes(
  readContent: (storageUri: string) => Promise<Uint8Array>,
  input: {
    readonly storageUri: string | null;
    readonly sha256: string | null;
    readonly size: number | null;
  },
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!input.storageUri || !input.sha256 || input.size === null) return null;
  const bytes = await readContent(input.storageUri);
  return (
      bytes.byteLength === input.size &&
      sha256Hex(bytes) === input.sha256
    )
    ? new Uint8Array([...bytes])
    : null;
}

async function planEntryForSelection(input: {
  readonly selection: WorkspaceUndoTurnArtifactSelection;
  readonly artifact: Artifact;
  readonly readContent: (storageUri: string) => Promise<Uint8Array>;
}): Promise<{
  readonly entry: BackendCommitPlan<"workspace">["entries"][number];
  readonly restoreDeleted: boolean;
  readonly outputPath: string;
} | null> {
  const { artifact, selection } = input;
  const currentEntry = selection.current.entry;
  const earliestEntry = selection.earliest.entry;
  if (
    artifact.id !== selection.artifactInternalId ||
    currentEntry.artifactInternalId !== artifact.id ||
    earliestEntry.artifactInternalId !== artifact.id
  ) return null;

  const currentDeleted = currentEntry.afterLogicalPath === null;
  const currentPath = currentDeleted
    ? currentEntry.beforeLogicalPath
    : currentEntry.afterLogicalPath;
  const currentRevision = currentDeleted
    ? currentEntry.beforeRevision === null
      ? null
      : currentEntry.beforeRevision + 1
    : currentEntry.afterRevision;
  const currentSha256 = currentDeleted
    ? currentEntry.beforeSha256
    : currentEntry.afterSha256;
  const currentSize = currentDeleted
    ? currentEntry.beforeSize
    : currentEntry.afterSize;
  const currentStorageUri = currentDeleted
    ? currentEntry.beforeStorageUri
    : currentEntry.afterStorageUri;
  if (
    currentPath === null ||
    currentRevision === null ||
    currentSha256 === null ||
    artifact.path !== currentPath ||
    artifact.revision !== currentRevision ||
    artifact.size !== currentSize ||
    (artifact.deletedAt !== null) !== currentDeleted
  ) return null;
  const currentBytes = await exactBytes(input.readContent, {
    storageUri: currentStorageUri,
    sha256: currentSha256,
    size: currentSize,
  });
  if (currentBytes === null) return null;
  const beforeIdentity = identity(artifact.id, currentPath);
  const expectedVersion: WorkspaceDocumentVersion = {
    identity: beforeIdentity,
    backendVersion: {
      kind: "artifact_revision",
      revision: currentRevision,
    },
    sha256: currentSha256,
  };
  const before = {
    identity: beforeIdentity,
    expectedVersion,
    bytes: currentBytes,
  };

  if (earliestEntry.mutationKind === "create") {
    if (currentDeleted) return null;
    return {
      entry: { kind: "delete", before },
      restoreDeleted: false,
      outputPath: currentPath,
    };
  }
  const targetPath = earliestEntry.beforeLogicalPath;
  const targetSha256 = earliestEntry.beforeSha256;
  const targetBytes = await exactBytes(input.readContent, {
    storageUri: earliestEntry.beforeStorageUri,
    sha256: targetSha256,
    size: earliestEntry.beforeSize,
  });
  if (!targetPath || !targetSha256 || targetBytes === null) return null;
  const after = {
    identity: identity(artifact.id, targetPath),
    bytes: targetBytes,
    sha256: targetSha256,
  };
  if (currentDeleted) {
    return {
      entry: { kind: "update", before, after },
      restoreDeleted: true,
      outputPath: targetPath,
    };
  }
  return currentPath === targetPath
    ? {
        entry: { kind: "update", before, after },
        restoreDeleted: false,
        outputPath: targetPath,
      }
    : {
        entry: { kind: "move", source: before, after },
        restoreDeleted: false,
        outputPath: targetPath,
      };
}

async function recoverCommittedUndoTurn(input: {
  readonly db: DirectDatabase;
  readonly dependencies: WorkspaceCanonicalUndoTurnDependencies;
  readonly request: WorkspaceCanonicalUndoTurnRequest;
  readonly operationId: string;
}): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "recovered";
      readonly outcomes: readonly WorkspaceCanonicalUndoTurnOutcome[];
    }
> {
  const recovered = await input.db.transaction(async (tx) => {
    const operationLock =
      await acquireWorkspaceDocumentMutationOperationLock(tx, input.operationId);
    return findWorkspaceDocumentMutationForRecovery(tx, operationLock);
  });
  if (recovered === null) return { kind: "absent" };
  if (
    recovered.mutation.ownerId !== input.request.authority.ownerId ||
    recovered.mutation.agentId !== input.request.authority.agentId ||
    recovered.mutation.roomId !== input.request.authority.roomId ||
    recovered.mutation.actorKind !== "agent" ||
    recovered.mutation.actorId !== input.request.authority.agentId ||
    recovered.mutation.lane !== "file_tool" ||
    recovered.revisionIds.length === 0 ||
    recovered.artifactInternalIds.length !== recovered.revisionIds.length ||
    recovered.historyOperations.length !== recovered.revisionIds.length ||
    recovered.entryIds.length !== recovered.revisionIds.length ||
    recovered.restoreFromEntryIds.length !== recovered.revisionIds.length ||
    recovered.logicalPaths.length !== recovered.revisionIds.length ||
    recovered.historyOperations.some(
      (operation) => operation !== "undo_turn",
    ) ||
    recovered.restoreFromEntryIds.some((entryId) => entryId === null)
  ) {
    return { kind: "invalid" };
  }
  for (const entryId of recovered.restoreFromEntryIds) {
    const source = await findOwnedWorkspaceHistoryByEntryId(input.db, {
      ownerId: input.request.authority.ownerId,
      agentId: input.request.authority.agentId,
      entryId: entryId!,
    });
    if (
      source?.mutation.turnId !== input.request.targetTurnId ||
      isRestoreOperation(source.entry.historyOperation)
    ) {
      return { kind: "invalid" };
    }
  }
  const authorityInput = {
    humanActorId: input.request.authority.envelope.actorId,
    agentId: input.request.authority.agentId,
    roomId: input.request.authority.roomId,
  };
  const currentAuthority = input.dependencies.resolveRoomAuthority
    ? await input.dependencies.resolveRoomAuthority(authorityInput)
    : await resolveWorkspaceRoomMutationAuthority(authorityInput, input.db);
  if (!currentAuthority) return { kind: "invalid" };

  const outcomes: WorkspaceCanonicalUndoTurnOutcome[] = [];
  for (let index = 0; index < recovered.artifactInternalIds.length; index += 1) {
    const artifactInternalId = recovered.artifactInternalIds[index]!;
    const artifact = await findArtifactByInternalIdForNamespacesIncludingDeleted(
      {
        internalId: artifactInternalId,
        mutableNamespaceIds: [...currentAuthority.readableNamespaceIds],
      },
      input.db,
    );
    const revisionId = recovered.revisionIds[index]?.at(-1);
    const path = recovered.logicalPaths[index];
    if (!artifact || !revisionId || !path) return { kind: "invalid" };
    outcomes.push({
      revisionId,
      artifactId: artifact.artifactId,
      artifactInternalId: artifact.id,
      path,
    });
  }
  return { kind: "recovered", outcomes };
}

export function createWorkspaceCanonicalUndoTurnExecution(
  dependencies: WorkspaceCanonicalUndoTurnDependencies,
): WorkspaceCanonicalUndoTurnExecution {
  return async (request) => {
    if (!authorityMatches(request)) {
      return {
        ok: false,
        code: "missing_context",
        message: "Canonical Workspace undo_turn authority is unavailable.",
      };
    }
    if (workspaceUndoTurnTargetsCurrentTurn(request)) {
      return {
        ok: false,
        code: "ineligible_history",
        message:
          "Workspace undo_turn cannot target the turn recording the restore.",
      };
    }
    const db = dependencies.db ?? getServerDirectDb();
    const operationId = workspaceFileMutationOperationId(
      request.mutationRequestId,
    );
    const recovery = await recoverCommittedUndoTurn({
      db,
      dependencies,
      request,
      operationId,
    });
    if (recovery.kind === "recovered") {
      return { ok: true, outcomes: recovery.outcomes };
    }
    if (recovery.kind === "invalid") {
      return {
        ok: false,
        code: "reapply_required",
        message: "No matching committed Workspace undo_turn receipt was found.",
      };
    }
    const failAfterRecovery = async (
      failure: WorkspaceCanonicalUndoTurnResult,
    ): Promise<WorkspaceCanonicalUndoTurnResult> => {
      const raced = await recoverCommittedUndoTurn({
        db,
        dependencies,
        request,
        operationId,
      });
      return raced.kind === "recovered"
        ? { ok: true, outcomes: raced.outcomes }
        : failure;
    };

    const scope = {
      ownerId: request.authority.ownerId,
      agentId: request.authority.agentId,
    };
    const targetRecords = await listWorkspaceHistoryForTurn(db, {
      ...scope,
      turnId: request.targetTurnId,
    });
    if (targetRecords.length === 0) {
      const [legacy] = await db
        .select({ id: fileRevisions.id })
        .from(fileRevisions)
        .where(and(
          eq(fileRevisions.ownerId, scope.ownerId),
          eq(fileRevisions.agentId, scope.agentId),
          eq(fileRevisions.turnId, request.targetTurnId),
        ))
        .limit(1);
      return await failAfterRecovery(legacy
        ? {
            ok: false,
            code: "legacy_history_unverifiable",
            message:
              "This turn has only legacy Workspace history and cannot be restored canonically.",
          }
        : {
            ok: false,
            code: "no_revisions_for_turn",
            message: "No canonical Workspace revisions exist for this turn.",
          });
    }

    const byArtifact = new Map<string, WorkspaceDocumentHistoryRecord[]>();
    for (const record of targetRecords) {
      const records = byArtifact.get(record.entry.artifactInternalId);
      if (records) records.push(record);
      else byArtifact.set(record.entry.artifactInternalId, [record]);
    }
    const selections: WorkspaceUndoTurnArtifactSelection[] = [];
    for (const [artifactInternalId, records] of [...byArtifact.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const lineage =
        await resolveWorkspaceDocumentHistoryLineageForArtifact(db, {
          ...scope,
          artifactInternalId,
        });
      const selected = selectWorkspaceUndoTurnArtifact({
        artifactInternalId,
        targetTurnId: request.targetTurnId,
        targetRecords: records,
        lineage,
      });
      if (selected.kind === "ineligible") {
        return await failAfterRecovery({
          ok: false,
          code: "ineligible_history",
          message:
            "The target turn is no longer the contiguous active history suffix.",
        });
      }
      selections.push(selected.selection);
    }

    const authorityInput = {
      humanActorId: request.authority.envelope.actorId,
      agentId: request.authority.agentId,
      roomId: request.authority.roomId,
    };
    const currentAuthority = dependencies.resolveRoomAuthority
      ? await dependencies.resolveRoomAuthority(authorityInput)
      : await resolveWorkspaceRoomMutationAuthority(authorityInput, db);
    if (!currentAuthority) {
      return await failAfterRecovery({
        ok: false,
        code: "reapply_required",
        message: "Current Room authority no longer permits this undo_turn.",
      });
    }

    const entries: BackendCommitPlan<"workspace">["entries"][number][] = [];
    const restoreFromEntryIds: string[] = [];
    const restoreDeletedArtifactIds: string[] = [];
    const outputPaths: string[] = [];
    const readContent =
      dependencies.readContent ?? readWorkspaceDocumentMutationContent;
    for (const selection of selections) {
      const artifact =
        await findArtifactByInternalIdForNamespacesIncludingDeleted(
          {
            internalId: selection.artifactInternalId,
            mutableNamespaceIds: [...currentAuthority.readableNamespaceIds],
          },
          db,
        );
      if (!artifact) {
        return await failAfterRecovery({
          ok: false,
          code: "reapply_required",
          message:
            "A target artifact is outside current Room authority.",
        });
      }
      let planned;
      try {
        planned = await planEntryForSelection({
          selection,
          artifact,
          readContent,
        });
      } catch {
        planned = null;
      }
      if (!planned) {
        return await failAfterRecovery({
          ok: false,
          code: "reapply_required",
          message:
            "A target artifact chain cannot be represented as one exact canonical restore.",
        });
      }
      entries.push(planned.entry);
      restoreFromEntryIds.push(selection.restoreFromEntryId);
      outputPaths.push(planned.outputPath);
      if (planned.restoreDeleted) {
        restoreDeletedArtifactIds.push(selection.artifactInternalId);
      }
    }

    const plan: BackendCommitPlan<"workspace"> = {
      operationId,
      actor: { kind: "agent", agentId: request.authority.agentId },
      turnId: request.authority.turnId,
      entries,
    };
    const outcome = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: request.authority.envelope.actorId,
          ownerId: request.authority.ownerId,
          agentId: request.authority.agentId,
          roomId: request.authority.roomId,
        },
        operationId,
        revisionGroupId:
          `workspace-undo-turn:${request.authority.turnId}:${request.targetTurnId}`,
        lane: "file_tool",
        historyOperation: "undo_turn",
        restoreFromEntryIds,
        ...(restoreDeletedArtifactIds.length === 0
          ? {}
          : { restoreDeletedArtifactIds }),
        plan,
      },
      dependencies,
    );
    if (outcome.kind === "unknown") {
      return await failAfterRecovery({
        ok: false,
        code: "unknown",
        message: "Canonical Workspace undo_turn outcome is unknown.",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      });
    }
    if (outcome.kind === "rejected") {
      const humanEditConflict =
        outcome.outcome.result.kind === "conflict" &&
        outcome.outcome.result.code === "human_edit_conflict";
      return await failAfterRecovery({
        ok: false,
        code: humanEditConflict
          ? "human_edit_conflict"
          : "reapply_required",
        message: humanEditConflict
          ? "A human edit conflicts with this atomic Workspace undo_turn."
          : "The Workspace undo_turn was rejected without applying any entries.",
      });
    }
    const outcomes: WorkspaceCanonicalUndoTurnOutcome[] = [];
    for (let index = 0; index < selections.length; index += 1) {
      const selection = selections[index]!;
      const artifact =
        await findArtifactByInternalIdForNamespacesIncludingDeleted(
          {
            internalId: selection.artifactInternalId,
            mutableNamespaceIds: [...currentAuthority.readableNamespaceIds],
          },
          db,
        );
      const revisionId = outcome.revisionIds[index]?.at(-1);
      if (!artifact || !revisionId) {
        return await failAfterRecovery({
          ok: false,
          code: "unknown",
          message: "Canonical Workspace undo_turn receipt is incomplete.",
          retryable: true,
          mutationRequestId: request.mutationRequestId,
        });
      }
      outcomes.push({
        revisionId,
        artifactId: artifact.artifactId,
        artifactInternalId: artifact.id,
        path: outputPaths[index]!,
      });
    }
    return { ok: true, outcomes };
  };
}
