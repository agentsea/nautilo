/**
 * Server-owned commit executor for agent-produced Workspace mutation plans.
 *
 * Producers may build only exact, candidate-byte plans. This module owns the
 * authority refreshes, namespace admission, durable replay proof, backend,
 * coordinator, shared lock domain, and post-commit outbox handoff common to
 * every Workspace agent producer.
 */
import { createHash } from "node:crypto";
import { mimeFromExtensionOr } from "@nautilo/attachments";
import {
  acquireWorkspaceDocumentMutationOperationLock,
  findArtifactByInternalIdForNamespaces,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findArtifactByPathForNamespaces,
  findOwnedWorkspaceHistoryByRevisionId,
  findWorkspaceDocumentMutationForRecovery,
  lockWorkspaceArtifactForCurrentRoomAuthority,
  lockWorkspaceArtifactIncludingDeletedForCurrentRoomAuthority,
  lockWorkspaceRoomMutationAuthority,
  resolveWorkspaceRoomMutationAuthority,
  type Artifact,
  type DirectDatabase,
  type LockedWorkspaceRoomMutationAuthority,
  type WorkspaceDocumentMutationTx,
} from "@nautilo/db";
import {
  createDocumentMutationCoordinator,
  createHumanEditAdmission,
  type BackendCommitPlan,
  type DocumentLockManager,
  type DocumentMutationCoordinator,
  type DocumentMutationCoordinatorOutcome,
  HumanEditLeaseRegistry,
} from "@nautilo/document-mutations";
import { assertCanWriteArtifacts } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import {
  WorkspaceArtifactMutationBackend,
  type AuthorizedWorkspaceArtifact,
  type WorkspaceBatchMutationAuthority,
  type WorkspaceBatchReplayAuthority,
  type WorkspaceArtifactMutationBackendDependencies,
  type WorkspaceMutationLane,
} from "./workspace-artifact-mutation-backend";
import { workspaceDocumentMutationLockManager } from "./workspace-document-mutation-lock-manager";
import { emitCreatedDocumentArtifacts } from "../event-feed/document-artifact-producer";

/**
 * The authenticated tuple retained by a producer after it validates its own
 * turn context. Plans never carry any of these authority fields.
 */
export type WorkspaceAgentMutationAuthority = Readonly<{
  humanActorId: string;
  ownerId: string;
  agentId: string;
  roomId: string;
}>;

export type WorkspaceAgentMutationCoordinatorDependencies = {
  readonly humanEditLeases: HumanEditLeaseRegistry;
  readonly lockManager?: DocumentLockManager;
  readonly db?: DirectDatabase;
  readonly newOpaqueId?: () => string;
  readonly onCommitted?: () => void;
  /** Hermetic unit seam; production always executes the real coordinator. */
  readonly executeCoordinator?: DocumentMutationCoordinator["execute"];
  /** Hermetic unit seam; production re-reads the durable committed receipt. */
  readonly lookupCommittedRevisionIds?: (input: {
    readonly operationId: string;
    readonly plan: BackendCommitPlan<"workspace">;
  }) => Promise<readonly (readonly [string, ...string[]])[] | null>;
  /** Hermetic seam for exact immutable postimages retained by receipts. */
  readonly lookupCommittedPostimages?: (input: {
    readonly operationId: string;
    readonly plan: BackendCommitPlan<"workspace">;
  }) => Promise<readonly (Readonly<{
    revision: number;
    sha256: string;
    size: number;
    storageUri: string;
  }> | null)[] | null>;
  /** Hermetic seam for the read-only current-Room authority lookup. */
  readonly resolveRoomAuthority?: (input: {
    readonly humanActorId: string;
    readonly agentId: string;
    readonly roomId: string;
  }) => Promise<LockedWorkspaceRoomMutationAuthority | null>;
  /** Hermetic seam; production always performs a fresh Human Capability read. */
  readonly assertCanWriteArtifacts?: typeof assertCanWriteArtifacts;
  /**
   * Hermetic storage/persistence seams only. Production leaves this absent;
   * authority resolvers are always installed by this module.
   */
  readonly backendTestDependencies?: Pick<
    WorkspaceArtifactMutationBackendDependencies,
    "readContent" | "writeCandidate" | "writeLiveCandidate" | "helpers"
  >;
};

export type WorkspaceAgentMutationExecutionInput = Readonly<{
  authority: WorkspaceAgentMutationAuthority;
  operationId: string;
  revisionGroupId: string;
  lane: Extract<WorkspaceMutationLane, "apply_patch" | "file_tool" | "officecli">;
  /** Trusted producer operation recorded on every durable history entry. */
  historyOperation?: string;
  /** Content consumers need exact committed bytes; other lanes retain receipt-only behavior. */
  includeCommittedPostimages?: true;
  /** Trusted public IDs for create entries whose plan identity is internal. */
  createdArtifactPublicIds?: Readonly<Record<string, string>>;
  /** Exact soft-deleted identities a canonical restore may revive. */
  restoreDeletedArtifactIds?: readonly string[];
  /** Canonical receipt entry inverted by this restore. */
  restoreFromEntryId?: string;
  /** Exact plan-entry-aligned canonical receipts inverted by a batch restore. */
  restoreFromEntryIds?: readonly string[];
  plan: BackendCommitPlan<"workspace">;
}>;

export type WorkspaceAgentMutationExecutionResult =
  | Readonly<{
      kind: "committed";
      outcome: "completed" | "recovery_required";
      /** Present only when stale authoritative text was composed automatically. */
      rebased?: true;
      /** Durable receipt fact, ordered exactly like the plan entries. */
      revisionIds: readonly (readonly [string, ...string[]])[];
      /**
       * The exact post-image identity for each committed entry, or null for a
       * delete. This lets a producer project a newly created artifact's
       * internal identity without guessing from a user-visible path.
       */
      outputArtifactIds: readonly (string | null)[];
      /** Exact receipt postimage for each entry, or null for a delete. */
      postimages?: readonly (Readonly<{
        revision: number;
        sha256: string;
        size: number;
        storageUri: string;
      }> | null)[];
    }>
  | Readonly<{
      kind: "rejected";
      outcome: Extract<
        DocumentMutationCoordinatorOutcome,
        { kind: "rejected" }
      >;
      /** Content-free admission, prepare, and commit classification. */
      diagnosticCodes: readonly string[];
    }>
  | Readonly<{
      kind: "unknown";
      outcome: Extract<
        DocumentMutationCoordinatorOutcome,
        { kind: "completed" | "recovery_required" }
      >;
    }>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorized(row: Artifact): AuthorizedWorkspaceArtifact {
  return {
    id: row.id,
    logicalPath: row.path,
    storageUri: row.storageUri,
    revision: row.revision,
    size: row.size,
    mimeType: row.mimeType,
  };
}

function existingIds(plan: BackendCommitPlan<"workspace">): readonly string[] {
  const fromEntries = plan.entries.flatMap((entry) => {
    if (entry.kind === "create") return [];
    if (entry.kind === "move") {
      return [
        entry.source.identity.artifactId,
        ...(entry.destinationBefore === undefined
          ? []
          : [entry.destinationBefore.identity.artifactId]),
      ];
    }
    return [entry.before.identity.artifactId];
  });
  const fromPreconditions = (plan.preconditions ?? []).flatMap((snapshot) =>
    snapshot.identity.kind === "workspace_artifact"
      ? [snapshot.identity.artifactId]
      : [],
  );
  return [...new Set([...fromEntries, ...fromPreconditions])].sort();
}

function vacantPaths(plan: BackendCommitPlan<"workspace">): readonly string[] {
  return plan.entries.flatMap((entry) =>
    entry.kind === "create" ||
    (entry.kind === "move" && entry.destinationBefore === undefined)
      ? [entry.after.identity.logicalPath]
      : [],
  );
}

function nextMimeTypes(
  plan: BackendCommitPlan<"workspace">,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    plan.entries.flatMap((entry) =>
      entry.kind === "delete"
        ? []
        : [
            [
              entry.after.identity.artifactId,
              mimeFromExtensionOr(entry.after.identity.logicalPath),
            ],
          ],
    ),
  );
}

function workspaceAgentMutationCreateNamespace(
  plan: BackendCommitPlan<"workspace">,
  currentRoomAuthority: LockedWorkspaceRoomMutationAuthority,
): string | undefined {
  return plan.entries.some((entry) => entry.kind === "create")
    ? currentRoomAuthority.createNamespaceId
    : undefined;
}

function outputArtifactIds(
  plan: BackendCommitPlan<"workspace">,
): readonly (string | null)[] {
  return plan.entries.map((entry) =>
    entry.kind === "delete" ? null : entry.after.identity.artifactId,
  );
}

function replayAuthority(
  input: WorkspaceAgentMutationExecutionInput,
  roomAuthority: LockedWorkspaceRoomMutationAuthority,
): WorkspaceBatchReplayAuthority {
  const createNamespaceId = workspaceAgentMutationCreateNamespace(
    input.plan,
    roomAuthority,
  );
  return {
    actor: { kind: "agent", agentId: input.authority.agentId },
    lane: input.lane,
    ...(createNamespaceId === undefined ? {} : { createNamespaceId }),
    nextMimeTypes: nextMimeTypes(input.plan),
    ...(input.historyOperation === undefined
      ? {}
      : { historyOperation: input.historyOperation }),
    ...(input.createdArtifactPublicIds === undefined
      ? {}
      : { createdArtifactPublicIds: input.createdArtifactPublicIds }),
    ...(input.restoreDeletedArtifactIds === undefined
      ? {}
      : { restoreDeletedArtifactIds: input.restoreDeletedArtifactIds }),
    ...(input.restoreFromEntryId === undefined
      ? {}
      : { restoreFromEntryId: input.restoreFromEntryId }),
    ...(input.restoreFromEntryIds === undefined
      ? {}
      : { restoreFromEntryIds: input.restoreFromEntryIds }),
    ownerId: input.authority.ownerId,
    userId: input.authority.ownerId,
    agentId: input.authority.agentId,
    roomId: input.authority.roomId,
  };
}

async function currentRoomAuthority(
  input: WorkspaceAgentMutationExecutionInput,
  dependencies: WorkspaceAgentMutationCoordinatorDependencies,
  tx?: WorkspaceDocumentMutationTx,
): Promise<LockedWorkspaceRoomMutationAuthority | null> {
  const authorityInput = {
    humanActorId: input.authority.humanActorId,
    agentId: input.authority.agentId,
    roomId: input.authority.roomId,
  };
  if (tx !== undefined) {
    return lockWorkspaceRoomMutationAuthority(authorityInput, tx);
  }
  return dependencies.resolveRoomAuthority
    ? dependencies.resolveRoomAuthority(authorityInput)
    : resolveWorkspaceRoomMutationAuthority(
        authorityInput,
        dependencies.db ?? getServerDirectDb(),
      );
}

async function resolveBatchAuthority(
  input: WorkspaceAgentMutationExecutionInput,
  dependencies: WorkspaceAgentMutationCoordinatorDependencies,
  db: DirectDatabase,
  diagnosticCodes: Set<string>,
  tx?: WorkspaceDocumentMutationTx,
): Promise<WorkspaceBatchMutationAuthority | null> {
  const roomAuthority = await currentRoomAuthority(input, dependencies, tx);
  if (!roomAuthority) return null;

  const rows: Artifact[] = [];
  const restoreDeletedIds = new Set(input.restoreDeletedArtifactIds ?? []);
  for (const artifactId of existingIds(input.plan)) {
    const restoreDeleted = restoreDeletedIds.has(artifactId);
    const row =
      tx === undefined
        ? restoreDeleted
          ? await findArtifactByInternalIdForNamespacesIncludingDeleted(
              {
                internalId: artifactId,
                mutableNamespaceIds: [...roomAuthority.readableNamespaceIds],
              },
              db,
            )
          : await findArtifactByInternalIdForNamespaces(
              {
                internalId: artifactId,
                readableNamespaceIds: [...roomAuthority.readableNamespaceIds],
              },
              db,
            )
        : restoreDeleted
          ? await lockWorkspaceArtifactIncludingDeletedForCurrentRoomAuthority(
              {
                internalId: artifactId,
                humanActorId: input.authority.humanActorId,
                agentId: input.authority.agentId,
                roomId: input.authority.roomId,
              },
              tx,
            )
          : await lockWorkspaceArtifactForCurrentRoomAuthority(
              {
                internalId: artifactId,
                humanActorId: input.authority.humanActorId,
                agentId: input.authority.agentId,
                roomId: input.authority.roomId,
              },
              tx,
            );
    if (!row) return null;
    if (restoreDeleted !== (row.deletedAt !== null)) return null;
    rows.push(row);
  }

  for (const path of vacantPaths(input.plan)) {
    const occupied = await findArtifactByPathForNamespaces(
      {
        path,
        readableNamespaceIds: [...roomAuthority.readableNamespaceIds],
      },
      tx ?? db,
    );
    if (occupied) {
      // Deliberately keep the public authority result fail-closed. The code is
      // only a content-free producer diagnostic so OfficeCLI can tell an
      // occupied zero-clobber destination from a revoked Room authority.
      diagnosticCodes.add("occupied_target");
      return null;
    }
  }
  for (const entry of input.plan.entries) {
    if (
      entry.kind !== "update" ||
      !restoreDeletedIds.has(entry.before.identity.artifactId)
    ) continue;
    const occupied = await findArtifactByPathForNamespaces(
      {
        path: entry.after.identity.logicalPath,
        readableNamespaceIds: [...roomAuthority.readableNamespaceIds],
      },
      tx ?? db,
    );
    if (occupied) {
      diagnosticCodes.add("occupied_target");
      return null;
    }
  }

  const createNamespaceId = workspaceAgentMutationCreateNamespace(
    input.plan,
    roomAuthority,
  );
  return {
    actor: { kind: "agent", agentId: input.authority.agentId },
    lane: input.lane,
    artifacts: rows.map(authorized),
    ...(createNamespaceId === undefined ? {} : { createNamespaceId }),
    nextMimeTypes: nextMimeTypes(input.plan),
    ...(input.historyOperation === undefined
      ? {}
      : { historyOperation: input.historyOperation }),
    ...(input.createdArtifactPublicIds === undefined
      ? {}
      : { createdArtifactPublicIds: input.createdArtifactPublicIds }),
    ...(input.restoreDeletedArtifactIds === undefined
      ? {}
      : { restoreDeletedArtifactIds: input.restoreDeletedArtifactIds }),
    ...(input.restoreFromEntryId === undefined
      ? {}
      : { restoreFromEntryId: input.restoreFromEntryId }),
    ...(input.restoreFromEntryIds === undefined
      ? {}
      : { restoreFromEntryIds: input.restoreFromEntryIds }),
    ownerId: input.authority.ownerId,
    userId: input.authority.ownerId,
    agentId: input.authority.agentId,
    roomId: input.authority.roomId,
  };
}

async function resolveBatchAuthorityWithWriteAdmission(
  input: WorkspaceAgentMutationExecutionInput,
  dependencies: WorkspaceAgentMutationCoordinatorDependencies,
  db: DirectDatabase,
  diagnosticCodes: Set<string>,
  tx?: WorkspaceDocumentMutationTx,
): Promise<WorkspaceBatchMutationAuthority | null> {
  const authority = await resolveBatchAuthority(
    input,
    dependencies,
    db,
    diagnosticCodes,
    tx,
  );
  if (authority === null) return null;

  const singleArtifact =
    authority.artifacts.length === 1 ? authority.artifacts[0] : undefined;
  const admissionInput = {
    humanUserId: input.authority.ownerId,
    roomId: input.authority.roomId,
    ...(authority.createNamespaceId === undefined
      ? {}
      : { namespaceId: authority.createNamespaceId }),
    ...(singleArtifact === undefined
      ? {}
      : { artifactId: singleArtifact.id }),
  };
  if (dependencies.assertCanWriteArtifacts) {
    await dependencies.assertCanWriteArtifacts(admissionInput);
  } else {
    await assertCanWriteArtifacts(admissionInput);
  }
  return authority;
}

/**
 * Executes one fully constructed Workspace agent plan with the shared
 * authoritative machinery. A producer gets no direct backend, DB, or outbox
 * capability through this boundary.
 */
export async function executeWorkspaceAgentMutation(
  input: WorkspaceAgentMutationExecutionInput,
  dependencies: WorkspaceAgentMutationCoordinatorDependencies,
): Promise<WorkspaceAgentMutationExecutionResult> {
  const db = dependencies.db ?? getServerDirectDb();
  const lookupCommittedRevisionIds = async () =>
    dependencies.lookupCommittedRevisionIds
      ? dependencies.lookupCommittedRevisionIds({
          operationId: input.operationId,
          plan: input.plan,
        })
      : db.transaction(async (tx) => {
          const roomAuthority = await currentRoomAuthority(
            input,
            dependencies,
            tx,
          );
          if (!roomAuthority) return null;
          const operationLock =
            await acquireWorkspaceDocumentMutationOperationLock(
              tx,
              input.operationId,
            );
          const recovered = await findWorkspaceDocumentMutationForRecovery(
            tx,
            operationLock,
          );
          if (recovered === null) return null;

          const expectedArtifactIds = input.plan.entries.map((entry) =>
            entry.kind === "create"
              ? entry.after.identity.artifactId
              : entry.kind === "move"
                ? entry.source.identity.artifactId
                : entry.before.identity.artifactId
          );
          const expectedHistoryOperations = input.plan.entries.map(
            () => input.historyOperation ?? input.lane,
          );
          const expectedRestoreFromEntryIds =
            input.restoreFromEntryIds ??
            input.plan.entries.map(() => input.restoreFromEntryId ?? null);
          const expectedLogicalPaths = input.plan.entries.map((entry) =>
            entry.kind === "delete"
              ? entry.before.identity.logicalPath
              : entry.after.identity.logicalPath
          );
          const same = <T>(
            left: readonly T[],
            right: readonly T[],
          ): boolean =>
            left.length === right.length &&
            left.every((value, index) => value === right[index]);

          return (
            recovered.mutation.ownerId === input.authority.ownerId &&
            recovered.mutation.userId === input.authority.ownerId &&
            recovered.mutation.agentId === input.authority.agentId &&
            recovered.mutation.roomId === input.authority.roomId &&
            recovered.mutation.actorKind === "agent" &&
            recovered.mutation.actorId === input.authority.agentId &&
            recovered.mutation.lane === input.lane &&
            recovered.mutation.turnId === (input.plan.turnId ?? null) &&
            same(recovered.artifactInternalIds, expectedArtifactIds) &&
            same(recovered.outputArtifactIds, outputArtifactIds(input.plan)) &&
            same(recovered.historyOperations, expectedHistoryOperations) &&
            same(recovered.restoreFromEntryIds, expectedRestoreFromEntryIds) &&
            same(recovered.logicalPaths, expectedLogicalPaths)
          )
            ? recovered.revisionIds
            : null;
        });

  // Preserve only stable diagnostic codes. Producer boundaries never receive
  // candidate bytes, private paths, SQL details, or backend exception text.
  const diagnosticCodes = new Set<string>();
  let committedCreationNamespaceId: string | undefined;
  const resolveWriteAuthority = async (tx?: WorkspaceDocumentMutationTx) => {
    const authority = await resolveBatchAuthorityWithWriteAdmission(input, dependencies, db, diagnosticCodes, tx);
    committedCreationNamespaceId = authority?.createNamespaceId;
    return authority;
  };
  const recordDiagnostics = (
    diagnostics: readonly { readonly code: string }[],
  ) => {
    for (const diagnostic of diagnostics) diagnosticCodes.add(diagnostic.code);
  };
  const backend = new WorkspaceArtifactMutationBackend({
    ...dependencies.backendTestDependencies,
    db,
    authorityResolver: {
      resolve: () => Promise.resolve(null),
      resolveInTransaction: () => Promise.resolve(null),
    },
    batchAuthorityResolver: {
      resolveReplayInTransaction: async (tx, plan) => {
        if (plan !== input.plan && plan.operationId !== input.operationId) {
          return null;
        }
        const roomAuthority = await currentRoomAuthority(
          input,
          dependencies,
          tx,
        );
        return roomAuthority ? replayAuthority(input, roomAuthority) : null;
      },
      resolve: (plan) =>
        plan.operationId === input.operationId
          ? resolveWriteAuthority()
          : Promise.resolve(null),
      resolveInTransaction: (tx, plan) =>
        plan.operationId === input.operationId
          ? resolveWriteAuthority(tx)
          : Promise.resolve(null),
    },
    ...(dependencies.newOpaqueId === undefined
      ? {}
      : { newOpaqueId: dependencies.newOpaqueId }),
  });
  const coordinator =
    dependencies.executeCoordinator === undefined
      ? createDocumentMutationCoordinator({
          backend: {
            kind: backend.kind,
            prepare: async (plan) => {
              const prepared = await backend.prepare(plan);
              if (prepared.kind !== "prepared") {
                recordDiagnostics(prepared.diagnostics);
              }
              return prepared;
            },
            commitPrepared: async (commit) => {
              const committed = await backend.commitPrepared(commit);
              if (committed.kind !== "committed") {
                recordDiagnostics(committed.diagnostics);
              }
              return committed;
            },
            compensate: (commit) => backend.compensate(commit),
            disposePrepared: (prepared) => backend.disposePrepared(prepared),
          },
          hashBytes: sha256Hex,
          lockManager:
            dependencies.lockManager ?? workspaceDocumentMutationLockManager,
          allocateRevisionGroupId: () => input.revisionGroupId,
          onFreshCommit: async (events) => {
            // Restoring/undoing an existing object is not a new addition.
            if (committedCreationNamespaceId && !input.restoreFromEntryId && !input.restoreFromEntryIds
              && !input.restoreDeletedArtifactIds?.length) {
              await emitCreatedDocumentArtifacts(events, committedCreationNamespaceId);
            }
          },
          eventPublisher: {
            publishAtomic: () => Promise.resolve({ kind: "not_published" }),
          },
          humanEditAdmission: createHumanEditAdmission(
            dependencies.humanEditLeases,
          ),
        })
      : undefined;
  const outcome = await (
    dependencies.executeCoordinator ?? coordinator!.execute.bind(coordinator)
  )({
    operationId: input.operationId,
    lane: input.lane,
    plan: input.plan,
  });

  if (outcome.kind === "rejected") {
    return {
      kind: "rejected",
      outcome,
      diagnosticCodes: [...diagnosticCodes].sort(),
    };
  }

  const revisionIds = await lookupCommittedRevisionIds();
  if (!revisionIds || revisionIds.length !== input.plan.entries.length) {
    return { kind: "unknown", outcome };
  }
  dependencies.onCommitted?.();
  let postimages: readonly (Readonly<{
    revision: number;
    sha256: string;
    size: number;
    storageUri: string;
  }> | null)[] | undefined;
  try {
    postimages = input.includeCommittedPostimages !== true ? undefined : dependencies.lookupCommittedPostimages
      ? (await dependencies.lookupCommittedPostimages({
          operationId: input.operationId,
          plan: input.plan,
        })) ?? undefined
      : await Promise.all(revisionIds.map(async (ids) => {
          const record = await findOwnedWorkspaceHistoryByRevisionId(db, {
            ownerId: input.authority.ownerId,
            agentId: input.authority.agentId,
            revisionId: ids.at(-1)!,
          });
          if (
            record === null ||
            record.mutation.operationId !== input.operationId ||
            record.entry.afterRevision === null ||
            record.entry.afterSha256 === null ||
            record.entry.afterSize === null ||
            record.entry.afterStorageUri === null
          ) return null;
          return {
            revision: record.entry.afterRevision,
            sha256: record.entry.afterSha256,
            size: record.entry.afterSize,
            storageUri: record.entry.afterStorageUri,
          };
        }));
  } catch {
    // The commit is already durable. Descriptor lookup failure is an unknown
    // response boundary recoverable from the operation receipt, never a
    // generic thrown save failure.
    return { kind: "unknown", outcome };
  }
  return {
    kind: "committed",
    outcome: outcome.kind,
    ...(outcome.kind === "completed" && outcome.result.kind === "rebased"
      ? { rebased: true as const }
      : {}),
    revisionIds,
    outputArtifactIds: outputArtifactIds(input.plan),
    ...(postimages === undefined || postimages === null
      ? {}
      : { postimages }),
  };
}
