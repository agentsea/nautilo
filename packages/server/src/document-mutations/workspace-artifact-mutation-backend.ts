/**
 * D448 Phase 8.2 — the Workspace implementation of the coordinator backend.
 *
 * This module deliberately owns no route-level authority.  A caller installs a
 * trusted resolver that is closed over its authenticated request context; the
 * plan is only checked against the resolver's result and can never grant
 * access to an artifact by itself.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import {
  acquireWorkspaceArtifactMutationLock,
  acquireWorkspaceDocumentMutationOperationLock,
  casDeleteWorkspaceArtifactForMutation,
  casRestoreDeletedWorkspaceArtifactForMutation,
  casWorkspaceArtifactContentPointer,
  createWorkspaceArtifactForMutation,
  findWorkspaceDocumentMutationForIdempotency,
  insertWorkspaceDocumentMutationReceipt,
  type DirectDatabase,
  type WorkspaceDocumentMutationCommitReplay,
  type WorkspaceDocumentMutationTx,
  type WorkspaceMutationReceiptEntryInput,
} from "@nautilo/db";
import {
  type BackendCommitOutcome,
  type BackendCommitPlan,
  type BackendCommitReceipt,
  type BackendCompensationOutcome,
  type BackendPrepareOutcome,
  type CommitPreparedInput,
  type CompensateCommitInput,
  type WorkspaceArtifactMutationBackend as WorkspaceArtifactMutationBackendContract,
} from "@nautilo/document-mutations";
import {
  documentCommitPlanSchema,
  type DocumentExpectedSnapshot,
  type DocumentMutationActor,
  type WorkspaceDocumentIdentity,
  type WorkspaceDocumentVersion,
} from "@nautilo/types";
import {
  writeWorkspaceDocumentMutationContent,
  writeWorkspaceDocumentMutationLiveContent,
  type WorkspaceDocumentMutationContent,
  type WorkspaceDocumentMutationLiveContent,
} from "../lib/workspace-document-mutation-content";
import { getServerDirectDb } from "../lib/server-direct-db";

export type WorkspaceMutationLane =
  | "editor_save"
  | "apply_patch"
  | "file_tool"
  | "officecli"
  | "artifact_lifecycle"
  | "desktop_files_ui";

/** A resolver-owned projection of an authorized, live artifact row. */
export type AuthorizedWorkspaceArtifact = {
  readonly id: string;
  readonly logicalPath: string;
  readonly storageUri: string;
  readonly revision: number;
  readonly size: number;
  readonly mimeType: string;
};

/**
 * All fields here originate in trusted request context or a live authority
 * lookup.  In particular, this is not accepted from a commit plan.
 */
export type WorkspaceMutationAuthority = {
  readonly actor: DocumentMutationActor;
  readonly lane: WorkspaceMutationLane;
  readonly artifact: AuthorizedWorkspaceArtifact;
  readonly ownerId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly roomId?: string;
  readonly clientMutationId?: string;
  readonly requestId?: string;
  /** SHA-256 of exact editor request semantics, computed server-side. */
  readonly editorRequestFingerprint?: string;
  /**
   * Trusted compatibility metadata for editor saves. When omitted, the live
   * artifact MIME is retained. This is resolver context, never plan authority.
   */
  readonly nextMimeType?: string;
};

/** Trusted all-at-once authority for a non-editor Workspace mutation plan. */
export type WorkspaceBatchMutationAuthority = Omit<
  WorkspaceMutationAuthority,
  "artifact" | "nextMimeType"
> & {
  readonly artifacts: readonly AuthorizedWorkspaceArtifact[];
  /** Current Room Namespace proven by the resolver for create entries. */
  readonly createNamespaceId?: string;
  /** Trusted MIME for every postimage-bearing artifact identity. */
  readonly nextMimeTypes: Readonly<Record<string, string>>;
  /** Trusted user-facing operation for canonical Workspace history. */
  readonly historyOperation?: string;
  /** Optional public artifact IDs keyed by create-entry internal identity. */
  readonly createdArtifactPublicIds?: Readonly<Record<string, string>>;
  readonly restoreDeletedArtifactIds?: readonly string[];
  readonly restoreFromEntryId?: string;
  readonly restoreFromEntryIds?: readonly string[];
};

export type WorkspaceBatchReplayAuthority = Omit<
  WorkspaceBatchMutationAuthority,
  "artifacts"
>;

export interface WorkspaceMutationAuthorityResolver {
  /** Read-only prepare-time admission and identity resolution. */
  resolve(
    plan: BackendCommitPlan<"workspace">,
  ): Promise<WorkspaceMutationAuthority | null>;
  /** Re-run the same live authority decision inside the commit transaction. */
  resolveInTransaction(
    tx: WorkspaceDocumentMutationTx,
    plan: BackendCommitPlan<"workspace">,
  ): Promise<WorkspaceMutationAuthority | null>;
}

export interface WorkspaceBatchMutationAuthorityResolver {
  /**
   * Current Room/actor authority plus digest metadata, proven inside the same
   * transaction as the durable operation lookup. It deliberately does not
   * require structural pre-state rows that a successful prior commit changed.
   */
  resolveReplayInTransaction(
    tx: WorkspaceDocumentMutationTx,
    plan: BackendCommitPlan<"workspace">,
  ): Promise<WorkspaceBatchReplayAuthority | null>;
  resolve(
    plan: BackendCommitPlan<"workspace">,
  ): Promise<WorkspaceBatchMutationAuthority | null>;
  resolveInTransaction(
    tx: WorkspaceDocumentMutationTx,
    plan: BackendCommitPlan<"workspace">,
  ): Promise<WorkspaceBatchMutationAuthority | null>;
}

type PreparedWorkspaceBatchEntry = {
  readonly entryIndex: number;
  readonly beforeCandidate?: WorkspaceDocumentMutationContent;
  readonly destinationBeforeCandidate?: WorkspaceDocumentMutationContent;
  readonly candidate?: WorkspaceDocumentMutationContent;
  readonly liveCandidate?: WorkspaceDocumentMutationLiveContent;
};

export type PreparedWorkspaceArtifactMutation =
  | {
      readonly kind: "candidate";
      readonly requestDigest: string;
      /** Immutable preimage; the mutable live pointer URI can be overwritten. */
      readonly beforeCandidate: WorkspaceDocumentMutationContent;
      /** Immutable postimage retained by the durable receipt. */
      readonly candidate: WorkspaceDocumentMutationContent;
      /** Per-save mutable object; only this URI may become the live pointer. */
      readonly liveCandidate: WorkspaceDocumentMutationLiveContent;
    }
  | {
      readonly kind: "batch_candidate";
      readonly requestDigest: string;
      readonly entries: readonly PreparedWorkspaceBatchEntry[];
    }
  | {
      /** Read-only discovery prevents a retry from being rejected as stale. */
      readonly kind: "replay";
      readonly authorityScope: "single_update" | "batch";
      readonly requestDigest: string;
      readonly replay: WorkspaceDocumentMutationCommitReplay;
    };

export type WorkspaceArtifactMutationBackendDependencies = {
  readonly authorityResolver: WorkspaceMutationAuthorityResolver;
  readonly batchAuthorityResolver?: WorkspaceBatchMutationAuthorityResolver;
  /** Defaults to the server's process-wide direct database handle. */
  readonly db?: DirectDatabase;
  /** Test seam; production writes immutable content-addressed candidate bytes. */
  readonly writeCandidate?: (input: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }) => Promise<WorkspaceDocumentMutationContent>;
  /** Writes one unique mutable live object for this attempted artifact save. */
  readonly writeLiveCandidate?: (input: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }) => Promise<WorkspaceDocumentMutationLiveContent>;
  /** Test/storage seam. It must return the exact bytes addressed by storageUri. */
  readonly readContent?: (storageUri: string) => Promise<Uint8Array>;
  /** Opaque global IDs for revision and undo receipt records. */
  readonly newOpaqueId?: () => string;
  /** Persistence seams keep unit tests hermetic; production uses DB helpers. */
  readonly helpers?: Partial<WorkspaceMutationPersistenceHelpers>;
};

type WorkspaceMutationPersistenceHelpers = {
  readonly acquireOperationLock: typeof acquireWorkspaceDocumentMutationOperationLock;
  readonly findReplay: typeof findWorkspaceDocumentMutationForIdempotency;
  readonly acquireArtifactLock: typeof acquireWorkspaceArtifactMutationLock;
  readonly casPointer: typeof casWorkspaceArtifactContentPointer;
  readonly casRestoreDeleted: typeof casRestoreDeletedWorkspaceArtifactForMutation;
  readonly createArtifact: typeof createWorkspaceArtifactForMutation;
  readonly casDelete: typeof casDeleteWorkspaceArtifactForMutation;
  readonly insertReceipt: typeof insertWorkspaceDocumentMutationReceipt;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function actorId(actor: DocumentMutationActor): string {
  return actor.kind === "human" ? actor.humanId : actor.agentId;
}

function storagePathFromUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const path = storageUri.slice("file://".length);
  return path.startsWith("/") ? path : null;
}

function isCanonicalMutationContent(
  content: WorkspaceDocumentMutationContent,
): boolean {
  const digestDirectory = dirname(content.absolutePath);
  const shaDirectory = dirname(digestDirectory);
  const contentDirectory = dirname(shaDirectory);
  return (
    isAbsolute(content.absolutePath) &&
    content.storageUri === `file://${content.absolutePath}` &&
    basename(content.absolutePath) === content.sha256 &&
    basename(digestDirectory) === content.sha256.slice(0, 2) &&
    basename(shaDirectory) === "sha256" &&
    basename(contentDirectory) === "workspace-document-mutation-content"
  );
}

function isCanonicalLiveMutationContent(
  content: WorkspaceDocumentMutationLiveContent,
): boolean {
  const digestDirectory = dirname(content.absolutePath);
  const liveDirectory = dirname(digestDirectory);
  const contentDirectory = dirname(liveDirectory);
  return (
    isAbsolute(content.absolutePath) &&
    content.storageUri === `file://${content.absolutePath}` &&
    basename(digestDirectory) === content.sha256.slice(0, 2) &&
    basename(liveDirectory) === "live" &&
    basename(contentDirectory) === "workspace-document-mutation-content" &&
    basename(content.absolutePath).startsWith(`${content.sha256}.`)
  );
}

export async function readWorkspaceDocumentMutationContent(
  storageUri: string,
): Promise<Uint8Array> {
  const path = storagePathFromUri(storageUri);
  if (!path)
    throw new Error(
      "Workspace artifact storage URI is not a readable local file URI",
    );
  return readFile(path);
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/** Exact deterministic request identity; revisionGroupId is intentionally separate. */
export function workspaceMutationRequestDigest(
  plan: BackendCommitPlan<"workspace">,
  metadata: {
    readonly nextMimeType?: string;
    readonly nextMimeTypes?: Readonly<Record<string, string>>;
    readonly createNamespaceId?: string;
    readonly editorRequestFingerprint?: string;
    readonly ownerId?: string;
    readonly userId?: string;
    readonly agentId?: string;
    readonly roomId?: string;
    readonly lane?: WorkspaceMutationLane;
    readonly historyOperation?: string;
    readonly restoreDeletedArtifactIds?: readonly string[];
    readonly restoreFromEntryId?: string;
  },
): string {
  const { createNamespaceId, ...sharedMetadata } = metadata;
  const digestMetadata = {
    ...sharedMetadata,
    ...(planHasCreate(plan) && createNamespaceId !== undefined
      ? { createNamespaceId }
      : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ plan, metadata: digestMetadata })))
    .digest("hex");
}

function artifactMap(
  authority: WorkspaceBatchMutationAuthority,
): ReadonlyMap<string, AuthorizedWorkspaceArtifact> {
  return new Map(
    authority.artifacts.map((artifact) => [artifact.id, artifact]),
  );
}

function existingIdentities(
  plan: BackendCommitPlan<"workspace">,
): readonly WorkspaceDocumentIdentity[] {
  const entries = plan.entries.flatMap((entry) => {
    if (entry.kind === "create") return [];
    if (entry.kind === "move") {
      return [
        entry.source.identity,
        ...(entry.destinationBefore === undefined
          ? []
          : [entry.destinationBefore.identity]),
      ];
    }
    return [entry.before.identity];
  });
  const preconditions = (plan.preconditions ?? []).flatMap((precondition) =>
    precondition.identity.kind === "workspace_artifact"
      ? [precondition.identity]
      : [],
  );
  return [...entries, ...preconditions];
}

function planHasCreate(plan: BackendCommitPlan<"workspace">): boolean {
  return plan.entries.some((entry) => entry.kind === "create");
}

function createdArtifactPublicIdsMatchPlan(
  authority: WorkspaceBatchReplayAuthority,
  plan: BackendCommitPlan<"workspace">,
): boolean {
  if (authority.createdArtifactPublicIds === undefined) return true;
  const createIds = new Set(
    plan.entries.flatMap((entry) =>
      entry.kind === "create" ? [entry.after.identity.artifactId] : []
    ),
  );
  const entries = Object.entries(authority.createdArtifactPublicIds);
  return (
    entries.length > 0 &&
    entries.every(([internalId, publicId]) =>
      createIds.has(internalId) && publicId.trim().length > 0
    ) &&
    new Set(entries.map(([, publicId]) => publicId)).size === entries.length
  );
}

function restorePointersMatchPlan(
  authority: WorkspaceBatchReplayAuthority,
  plan: BackendCommitPlan<"workspace">,
): boolean {
  if (
    authority.restoreFromEntryId !== undefined &&
    authority.restoreFromEntryIds !== undefined
  ) return false;
  if (authority.restoreFromEntryId !== undefined) {
    return (
      plan.entries.length === 1 &&
      authority.restoreFromEntryId.trim().length > 0
    );
  }
  if (authority.restoreFromEntryIds === undefined) return true;
  return (
    authority.restoreFromEntryIds.length === plan.entries.length &&
    authority.restoreFromEntryIds.every((entryId) => entryId.trim().length > 0)
  );
}

function batchAuthorityMatchesPlan(
  authority: WorkspaceBatchMutationAuthority,
  plan: BackendCommitPlan<"workspace">,
): boolean {
  if (
    authority.actor.kind !== plan.actor.kind ||
    actorId(authority.actor) !== actorId(plan.actor)
  )
    return false;
  const byId = artifactMap(authority);
  if (byId.size !== authority.artifacts.length) return false;
  if (
    (authority.restoreDeletedArtifactIds ?? []).some(
      (artifactId) => !byId.has(artifactId),
    )
  ) {
    return false;
  }
  if (!createdArtifactPublicIdsMatchPlan(authority, plan)) return false;
  if (!restorePointersMatchPlan(authority, plan)) return false;
  for (const identity of existingIdentities(plan)) {
    const artifact = byId.get(identity.artifactId);
    if (!artifact || artifact.logicalPath !== identity.logicalPath)
      return false;
  }
  for (const entry of plan.entries) {
    if (entry.kind === "create" && !authority.createNamespaceId) return false;
    if (entry.kind !== "delete") {
      const identity = entry.after.identity;
      if (!authority.nextMimeTypes[identity.artifactId]?.trim()) return false;
    }
  }
  return true;
}

function replayAuthorityMatchesPlan(
  authority: WorkspaceBatchReplayAuthority,
  plan: BackendCommitPlan<"workspace">,
): boolean {
  const isAgentProducerLane =
    authority.lane === "apply_patch" ||
    authority.lane === "file_tool" ||
    authority.lane === "officecli";
  if (
    authority.actor.kind !== plan.actor.kind ||
    actorId(authority.actor) !== actorId(plan.actor) ||
    !isAgentProducerLane ||
    plan.actor.kind !== "agent" ||
    authority.agentId !== plan.actor.agentId ||
    !authority.ownerId ||
    authority.userId !== authority.ownerId ||
    !authority.roomId ||
    (planHasCreate(plan) && !authority.createNamespaceId)
  )
    return false;
  if (!createdArtifactPublicIdsMatchPlan(authority, plan)) return false;
  if (!restorePointersMatchPlan(authority, plan)) return false;
  return plan.entries.every(
    (entry) =>
      entry.kind === "delete" ||
      Boolean(authority.nextMimeTypes[entry.after.identity.artifactId]?.trim()),
  );
}

export function workspaceBatchMutationRequestDigest(
  plan: BackendCommitPlan<"workspace">,
  authority: WorkspaceBatchReplayAuthority,
): string {
  return workspaceMutationRequestDigest(plan, {
    nextMimeTypes: authority.nextMimeTypes,
    ...(authority.ownerId === undefined ? {} : { ownerId: authority.ownerId }),
    ...(authority.userId === undefined ? {} : { userId: authority.userId }),
    ...(authority.agentId === undefined ? {} : { agentId: authority.agentId }),
    ...(authority.roomId === undefined ? {} : { roomId: authority.roomId }),
    lane: authority.lane,
    ...(authority.historyOperation === undefined
      ? {}
      : { historyOperation: authority.historyOperation }),
    ...(authority.createdArtifactPublicIds === undefined
      ? {}
      : { createdArtifactPublicIds: authority.createdArtifactPublicIds }),
    ...(authority.restoreDeletedArtifactIds === undefined
      ? {}
      : { restoreDeletedArtifactIds: authority.restoreDeletedArtifactIds }),
    ...(authority.restoreFromEntryId === undefined
      ? {}
      : { restoreFromEntryId: authority.restoreFromEntryId }),
    ...(authority.restoreFromEntryIds === undefined
      ? {}
      : { restoreFromEntryIds: authority.restoreFromEntryIds }),
    ...(!planHasCreate(plan) || authority.createNamespaceId === undefined
      ? {}
      : { createNamespaceId: authority.createNamespaceId }),
  });
}

function expectedSnapshotFor(
  plan: BackendCommitPlan<"workspace">,
  artifactId: string,
): WorkspaceExpectedSnapshot | undefined {
  for (const precondition of plan.preconditions ?? []) {
    if (
      isWorkspaceExpectedSnapshot(precondition) &&
      precondition.identity.artifactId === artifactId
    )
      return precondition;
  }
  for (const entry of plan.entries) {
    if (entry.kind === "update" || entry.kind === "delete") {
      if (entry.before.identity.artifactId === artifactId) return entry.before;
    } else if (entry.kind === "move") {
      if (entry.source.identity.artifactId === artifactId) return entry.source;
      if (entry.destinationBefore?.identity.artifactId === artifactId) {
        return entry.destinationBefore;
      }
    }
  }
  return undefined;
}

type WorkspaceExpectedSnapshot = Omit<
  DocumentExpectedSnapshot,
  "identity" | "expectedVersion"
> & {
  readonly identity: WorkspaceDocumentIdentity;
  readonly expectedVersion: WorkspaceDocumentVersion;
};

function isWorkspaceExpectedSnapshot(
  snapshot: DocumentExpectedSnapshot,
): snapshot is WorkspaceExpectedSnapshot {
  return (
    snapshot.identity.kind === "workspace_artifact" &&
    snapshot.expectedVersion.identity.kind === "workspace_artifact" &&
    snapshot.expectedVersion.backendVersion.kind === "artifact_revision"
  );
}

function mutationPathForArtifact(
  plan: BackendCommitPlan<"workspace">,
  artifactId: string,
) {
  for (const entry of plan.entries) {
    if (
      entry.kind === "update" &&
      entry.before.identity.artifactId === artifactId
    ) {
      return {
        kind: "update" as const,
        before: entry.before.identity,
        after: entry.after.identity,
      };
    }
    if (
      entry.kind === "delete" &&
      entry.before.identity.artifactId === artifactId
    ) {
      return { kind: "delete" as const, before: entry.before.identity };
    }
    if (
      entry.kind === "move" &&
      (entry.source.identity.artifactId === artifactId ||
        entry.destinationBefore?.identity.artifactId === artifactId)
    ) {
      return entry.destinationBefore === undefined
        ? {
            kind: "move" as const,
            overwrite: false as const,
            before: entry.source.identity,
            after: entry.after.identity,
          }
        : {
            kind: "move" as const,
            overwrite: true as const,
            before: entry.source.identity,
            destinationBefore: entry.destinationBefore.identity,
            after: entry.after.identity,
          };
    }
  }
  return undefined;
}

function versionMatchesSnapshot(
  artifact: AuthorizedWorkspaceArtifact,
  snapshot: NonNullable<ReturnType<typeof expectedSnapshotFor>>,
  currentSha256: string,
): boolean {
  const expected = snapshot.expectedVersion;
  return (
    artifact.id === expected.identity.artifactId &&
    artifact.logicalPath === expected.identity.logicalPath &&
    artifact.revision === expected.backendVersion.revision &&
    artifact.storageUri.length > 0 &&
    artifact.size === snapshot.bytes.byteLength &&
    currentSha256 === expected.sha256
  );
}

function trustedNextMimeType(authority: WorkspaceMutationAuthority): string {
  const nextMimeType = authority.nextMimeType ?? authority.artifact.mimeType;
  if (nextMimeType.trim().length === 0) {
    throw new Error("Workspace mutation MIME type must be nonempty");
  }
  return nextMimeType;
}

function trustedEditorRequestFingerprint(
  authority: WorkspaceMutationAuthority,
): string | undefined {
  const fingerprint = authority.editorRequestFingerprint;
  if (fingerprint === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(
      "Workspace editor request fingerprint must be a SHA-256 hex digest",
    );
  }
  return fingerprint;
}

function invalidPlanDiagnostics(
  plan: BackendCommitPlan<"workspace">,
): string | null {
  if (!documentCommitPlanSchema.safeParse(plan).success)
    return "plan violates the shared mutation contract";
  for (const precondition of plan.preconditions ?? []) {
    if (
      !isWorkspaceExpectedSnapshot(precondition) ||
      sha256Hex(precondition.bytes) !== precondition.expectedVersion.sha256
    )
      return "Workspace precondition bytes do not match their declared SHA-256";
  }
  for (const entry of plan.entries) {
    const snapshots =
      entry.kind === "create"
        ? []
        : entry.kind === "move"
          ? [
              entry.source,
              ...(entry.destinationBefore === undefined
                ? []
                : [entry.destinationBefore]),
            ]
          : [entry.before];
    const postimages = entry.kind === "delete" ? [] : [entry.after];
    if (
      snapshots.some(
        (snapshot) =>
          snapshot.identity.kind !== "workspace_artifact" ||
          sha256Hex(snapshot.bytes) !== snapshot.expectedVersion.sha256,
      ) ||
      postimages.some(
        (postimage) =>
          postimage.identity.kind !== "workspace_artifact" ||
          sha256Hex(postimage.bytes) !== postimage.sha256,
      )
    ) {
      return "Workspace plan bytes do not match their declared SHA-256";
    }
  }
  return null;
}

function isSingleUpdatePlan(
  plan: BackendCommitPlan<"workspace">,
): plan is BackendCommitPlan<"workspace"> & {
  readonly entries: readonly [
    Extract<
      BackendCommitPlan<"workspace">["entries"][number],
      { kind: "update" }
    >,
  ];
} {
  return plan.entries.length === 1 && plan.entries[0]?.kind === "update";
}

function authorityMatchesPlan(
  authority: WorkspaceMutationAuthority,
  plan: BackendCommitPlan<"workspace">,
): boolean {
  const entry = plan.entries[0];
  if (!entry || entry.kind !== "update") return false;
  return (
    authority.actor.kind === plan.actor.kind &&
    actorId(authority.actor) === actorId(plan.actor) &&
    authority.artifact.id === entry.before.identity.artifactId &&
    authority.artifact.logicalPath === entry.before.identity.logicalPath
  );
}

function versionFor(
  identity: WorkspaceDocumentIdentity,
  artifact: AuthorizedWorkspaceArtifact,
  sha256: string,
): WorkspaceDocumentVersion {
  return {
    identity,
    backendVersion: { kind: "artifact_revision", revision: artifact.revision },
    sha256,
  };
}

function staleEvidence(
  plan: BackendCommitPlan<"workspace">,
  current: WorkspaceDocumentVersion,
) {
  const entry = plan.entries[0]!;
  if (entry.kind !== "update")
    throw new Error("validated plan lost its update entry");
  return [
    {
      path: {
        kind: "update" as const,
        before: entry.before.identity,
        after: entry.after.identity,
      },
      currentVersion: current,
    },
  ] as const;
}

function exactCurrentMatchesPlan(
  authority: WorkspaceMutationAuthority,
  plan: BackendCommitPlan<"workspace">,
  currentSha256: string,
): boolean {
  const entry = plan.entries[0]!;
  if (entry.kind !== "update") return false;
  const expected = entry.before.expectedVersion;
  return (
    authority.artifact.id === expected.identity.artifactId &&
    authority.artifact.logicalPath === expected.identity.logicalPath &&
    authority.artifact.revision === expected.backendVersion.revision &&
    authority.artifact.storageUri.length > 0 &&
    currentSha256 === expected.sha256
  );
}

function failed(
  message: string,
  code: "backend_failure" | "inconsistent_outcome" = "backend_failure",
): Extract<
  BackendCommitOutcome<"workspace", BackendCommitReceipt<"workspace">>,
  { kind: "failed" }
> {
  return code === "inconsistent_outcome"
    ? {
        kind: "failed",
        code,
        requiresCompensation: true,
        diagnostics: [{ code, message }],
      }
    : {
        kind: "failed",
        code,
        requiresCompensation: false,
        diagnostics: [{ code, message }],
      };
}

/**
 * Production Workspace backend for editor updates and atomic apply_patch
 * batches. Structural entries use the same authority, receipt, and outbox
 * transaction as ordinary updates.
 */
export class WorkspaceArtifactMutationBackend implements WorkspaceArtifactMutationBackendContract<PreparedWorkspaceArtifactMutation> {
  readonly kind = "workspace" as const;

  private readonly db: DirectDatabase;
  private readonly readContent: (storageUri: string) => Promise<Uint8Array>;
  private readonly writeCandidate: NonNullable<
    WorkspaceArtifactMutationBackendDependencies["writeCandidate"]
  >;
  private readonly writeLiveCandidate: NonNullable<
    WorkspaceArtifactMutationBackendDependencies["writeLiveCandidate"]
  >;
  private readonly newOpaqueId: () => string;
  private readonly helpers: WorkspaceMutationPersistenceHelpers;
  /**
   * Candidate preparation is an in-process capability, not a structural DTO.
   * This prevents a direct backend caller from fabricating an arbitrary
   * storage URI while reusing the publicly computable request digest.
   */
  private readonly preparedCandidates = new WeakSet<object>();

  constructor(
    private readonly dependencies: WorkspaceArtifactMutationBackendDependencies,
  ) {
    this.db = dependencies.db ?? getServerDirectDb();
    this.readContent =
      dependencies.readContent ?? readWorkspaceDocumentMutationContent;
    this.writeCandidate =
      dependencies.writeCandidate ??
      ((input) => writeWorkspaceDocumentMutationContent(input));
    this.writeLiveCandidate =
      dependencies.writeLiveCandidate ??
      (dependencies.writeCandidate
        ? // Existing hermetic writer seams predate live objects. They do not touch
          // disk, so derive a distinct canonical URI for their in-memory store.
          async (input) => {
            const immutable = await this.writeCandidate(input);
            const absolutePath = `${dirname(dirname(dirname(immutable.absolutePath)))}/live/${input.sha256.slice(0, 2)}/${input.sha256}.${randomUUID()}`;
            return {
              sha256: input.sha256,
              size: input.bytes.byteLength,
              absolutePath,
              storageUri: `file://${absolutePath}`,
            };
          }
        : (input) => writeWorkspaceDocumentMutationLiveContent(input));
    this.newOpaqueId = dependencies.newOpaqueId ?? randomUUID;
    this.helpers = {
      acquireOperationLock:
        dependencies.helpers?.acquireOperationLock ??
        acquireWorkspaceDocumentMutationOperationLock,
      findReplay:
        dependencies.helpers?.findReplay ??
        findWorkspaceDocumentMutationForIdempotency,
      acquireArtifactLock:
        dependencies.helpers?.acquireArtifactLock ??
        acquireWorkspaceArtifactMutationLock,
      casPointer:
        dependencies.helpers?.casPointer ?? casWorkspaceArtifactContentPointer,
      casRestoreDeleted:
        dependencies.helpers?.casRestoreDeleted ??
        casRestoreDeletedWorkspaceArtifactForMutation,
      createArtifact:
        dependencies.helpers?.createArtifact ??
        createWorkspaceArtifactForMutation,
      casDelete:
        dependencies.helpers?.casDelete ??
        casDeleteWorkspaceArtifactForMutation,
      insertReceipt:
        dependencies.helpers?.insertReceipt ??
        insertWorkspaceDocumentMutationReceipt,
    };
  }

  private async immutableContent(
    bytes: Uint8Array,
    expectedSha256: string,
    label: string,
  ): Promise<WorkspaceDocumentMutationContent> {
    const content = await this.writeCandidate({
      bytes,
      sha256: expectedSha256,
    });
    if (
      content.sha256 !== expectedSha256 ||
      content.size !== bytes.byteLength ||
      !isCanonicalMutationContent(content)
    ) {
      throw new Error(`${label} writer returned non-exact content evidence`);
    }
    return Object.freeze({ ...content });
  }

  private async liveContent(
    bytes: Uint8Array,
    expectedSha256: string,
    immutableStorageUri: string,
  ): Promise<WorkspaceDocumentMutationLiveContent> {
    const content = await this.writeLiveCandidate({
      bytes,
      sha256: expectedSha256,
    });
    if (
      content.sha256 !== expectedSha256 ||
      content.size !== bytes.byteLength ||
      !isCanonicalLiveMutationContent(content) ||
      content.storageUri === immutableStorageUri
    ) {
      throw new Error(
        "Live Workspace candidate must be unique exact-byte storage",
      );
    }
    return Object.freeze({ ...content });
  }

  private async prepareBatch(
    plan: BackendCommitPlan<"workspace">,
  ): Promise<
    BackendPrepareOutcome<"workspace", PreparedWorkspaceArtifactMutation>
  > {
    const resolver = this.dependencies.batchAuthorityResolver;
    if (!resolver) {
      return {
        kind: "failed",
        code: "backend_unavailable",
        diagnostics: [
          {
            code: "batch_authority_unavailable",
            message: "Workspace batch authority resolver is unavailable",
          },
        ],
      };
    }
    try {
      const replayProbe = await this.db.transaction(async (tx) => {
        const replayAuthority = await resolver.resolveReplayInTransaction(
          tx,
          plan,
        );
        if (
          !replayAuthority ||
          !replayAuthorityMatchesPlan(replayAuthority, plan)
        ) {
          return { kind: "not_authorized" as const };
        }
        const requestDigest = workspaceBatchMutationRequestDigest(
          plan,
          replayAuthority,
        );
        const lock = await this.helpers.acquireOperationLock(
          tx,
          plan.operationId,
        );
        const replay = await this.helpers.findReplay(tx, lock, requestDigest);
        return { kind: "probed" as const, requestDigest, replay };
      });
      if (replayProbe.kind === "not_authorized") {
        return {
          kind: "failed",
          code: "backend_unavailable",
          diagnostics: [
            {
              code: "not_authorized",
              message: "Workspace Room replay authority is absent or revoked",
            },
          ],
        };
      }
      if (replayProbe.replay.kind === "digest_mismatch") {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "digest_mismatch",
              message:
                "Operation ID is already bound to a different request digest",
            },
          ],
        };
      }
      if (replayProbe.replay.kind === "match") {
        return {
          kind: "prepared",
          prepared: Object.freeze({
            kind: "replay",
            authorityScope: "batch",
            requestDigest: replayProbe.requestDigest,
            replay: replayProbe.replay.replay,
          }),
          revisionGroupIdHint:
            replayProbe.replay.replay.receipt.revisionGroupId,
        };
      }

      const authority = await resolver.resolve(plan);
      if (!authority || !batchAuthorityMatchesPlan(authority, plan)) {
        return {
          kind: "failed",
          code: "backend_unavailable",
          diagnostics: [
            {
              code: "not_authorized",
              message:
                "Workspace batch authority is absent or no longer matches this plan",
            },
          ],
        };
      }
      const requestDigest = workspaceBatchMutationRequestDigest(
        plan,
        authority,
      );
      if (requestDigest !== replayProbe.requestDigest) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "authority_metadata_changed",
              message:
                "Workspace batch digest metadata changed after replay admission",
            },
          ],
        };
      }

      const byId = artifactMap(authority);
      for (const identity of existingIdentities(plan)) {
        const artifact = byId.get(identity.artifactId)!;
        const snapshot = expectedSnapshotFor(plan, identity.artifactId)!;
        const currentBytes = await this.readContent(artifact.storageUri);
        if (
          !versionMatchesSnapshot(artifact, snapshot, sha256Hex(currentBytes))
        ) {
          const current = versionFor(
            identity,
            artifact,
            sha256Hex(currentBytes),
          );
          const path = mutationPathForArtifact(plan, identity.artifactId);
          if (!path) {
            return {
              kind: "failed",
              code: "backend_failure",
              diagnostics: [
                {
                  code: "stale_precondition",
                  message:
                    "A read-only Workspace precondition no longer matches its exact source snapshot",
                },
              ],
            };
          }
          return {
            kind: "conflict",
            code: "stale_version",
            evidence: [
              {
                path,
                currentVersion: current,
              },
            ],
            currentSnapshots: [{
              identity: current.identity,
              currentVersion: current,
              bytes: currentBytes,
            }],
            diagnostics: [
              {
                code: "stale_version",
                message:
                  "Workspace artifact identity, version, size, or bytes changed before prepare",
              },
            ],
          };
        }
      }

      const preparedEntries: PreparedWorkspaceBatchEntry[] = [];
      for (const [entryIndex, entry] of plan.entries.entries()) {
        const before =
          entry.kind === "create"
            ? undefined
            : entry.kind === "move"
              ? entry.source
              : entry.before;
        const destinationBefore =
          entry.kind === "move" ? entry.destinationBefore : undefined;
        const after = entry.kind === "delete" ? undefined : entry.after;
        const beforeCandidate =
          before === undefined
            ? undefined
            : await this.immutableContent(
                before.bytes,
                before.expectedVersion.sha256,
                "Immutable preimage",
              );
        const destinationBeforeCandidate =
          destinationBefore === undefined
            ? undefined
            : await this.immutableContent(
                destinationBefore.bytes,
                destinationBefore.expectedVersion.sha256,
                "Immutable overwrite preimage",
              );
        const candidate =
          after === undefined
            ? undefined
            : await this.immutableContent(
                after.bytes,
                after.sha256,
                "Immutable candidate",
              );
        const liveCandidate =
          after === undefined
            ? undefined
            : await this.liveContent(
                after.bytes,
                after.sha256,
                candidate!.storageUri,
              );
        preparedEntries.push(
          Object.freeze({
            entryIndex,
            ...(beforeCandidate === undefined ? {} : { beforeCandidate }),
            ...(destinationBeforeCandidate === undefined
              ? {}
              : { destinationBeforeCandidate }),
            ...(candidate === undefined ? {} : { candidate }),
            ...(liveCandidate === undefined ? {} : { liveCandidate }),
          }),
        );
      }
      const prepared = Object.freeze({
        kind: "batch_candidate" as const,
        requestDigest,
        entries: Object.freeze(preparedEntries),
      });
      this.preparedCandidates.add(prepared);
      return { kind: "prepared", prepared };
    } catch (error) {
      return {
        kind: "failed",
        code: "backend_failure",
        diagnostics: [
          {
            code: "prepare_failed",
            message:
              error instanceof Error
                ? error.message
                : "Workspace batch prepare failed",
          },
        ],
      };
    }
  }

  async prepare(
    plan: BackendCommitPlan<"workspace">,
  ): Promise<
    BackendPrepareOutcome<"workspace", PreparedWorkspaceArtifactMutation>
  > {
    const invalid = invalidPlanDiagnostics(plan);
    if (invalid) {
      return {
        kind: "failed",
        code: "backend_failure",
        diagnostics: [{ code: "invalid_plan", message: invalid }],
      };
    }
    if (!isSingleUpdatePlan(plan) || this.dependencies.batchAuthorityResolver) {
      return this.prepareBatch(plan);
    }
    try {
      // Resolve trusted authority before touching operation-id persistence so a
      // guessed operation ID cannot become a digest/receipt existence oracle.
      // This match deliberately checks only actor + live artifact identity;
      // a committed retry is expected to have post-image version/SHA bytes.
      const authority = await this.dependencies.authorityResolver.resolve(plan);
      if (!authority || !authorityMatchesPlan(authority, plan)) {
        return {
          kind: "failed",
          code: "backend_unavailable",
          diagnostics: [
            {
              code: "not_authorized",
              message:
                "Workspace authority is absent or no longer matches this plan",
            },
          ],
        };
      }
      const editorFingerprint = trustedEditorRequestFingerprint(authority);
      const requestDigest = workspaceMutationRequestDigest(plan, {
        nextMimeType: trustedNextMimeType(authority),
        ...(editorFingerprint === undefined
          ? {}
          : { editorRequestFingerprint: editorFingerprint }),
      });
      // A successful prior commit naturally has the post-image revision and
      // SHA, so checking current bytes first would falsely reject its retry.
      // The operation advisory lock keeps this discovery race-free with the
      // later commit lookup without changing any authoritative state.
      const replay = await this.db.transaction(async (tx) => {
        const lock = await this.helpers.acquireOperationLock(
          tx,
          plan.operationId,
        );
        return this.helpers.findReplay(tx, lock, requestDigest);
      });
      if (replay.kind === "digest_mismatch") {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "digest_mismatch",
              message:
                "Operation ID is already bound to a different request digest",
            },
          ],
        };
      }
      if (replay.kind === "match") {
        return {
          kind: "prepared",
          prepared: Object.freeze({
            kind: "replay",
            authorityScope: "single_update",
            requestDigest,
            replay: replay.replay,
          }),
          revisionGroupIdHint: replay.replay.receipt.revisionGroupId,
        };
      }
      const entry = plan.entries[0];
      if (entry.kind !== "update")
        throw new Error("validated plan lost its update entry");
      const currentBytes = await this.readContent(
        authority.artifact.storageUri,
      );
      const currentSha256 = sha256Hex(currentBytes);
      if (authority.artifact.size !== currentBytes.byteLength) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "storage_drift",
              message:
                "Artifact row size does not prove the bytes read during prepare",
            },
          ],
        };
      }
      const current = versionFor(
        entry.before.identity,
        authority.artifact,
        currentSha256,
      );
      if (!exactCurrentMatchesPlan(authority, plan, currentSha256)) {
        return {
          kind: "conflict",
          code: "stale_version",
          evidence: staleEvidence(plan, current),
          currentSnapshots: [{
            identity: current.identity,
            currentVersion: current,
            bytes: currentBytes,
          }],
          diagnostics: [
            {
              code: "stale_version",
              message:
                "Artifact version, identity, or bytes changed before prepare",
            },
          ],
        };
      }
      const beforeCandidate = await this.writeCandidate({
        bytes: currentBytes,
        sha256: currentSha256,
      });
      if (
        beforeCandidate.sha256 !== currentSha256 ||
        beforeCandidate.size !== currentBytes.byteLength ||
        !isCanonicalMutationContent(beforeCandidate)
      ) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "preimage_mismatch",
              message:
                "Immutable preimage writer returned non-exact content evidence",
            },
          ],
        };
      }
      const candidate = await this.writeCandidate({
        bytes: entry.after.bytes,
        sha256: entry.after.sha256,
      });
      if (
        candidate.sha256 !== entry.after.sha256 ||
        candidate.size !== entry.after.bytes.byteLength ||
        !isCanonicalMutationContent(candidate)
      ) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "candidate_mismatch",
              message:
                "Immutable candidate writer returned non-exact content evidence",
            },
          ],
        };
      }
      const liveCandidate = await this.writeLiveCandidate({
        bytes: entry.after.bytes,
        sha256: entry.after.sha256,
      });
      if (
        liveCandidate.sha256 !== entry.after.sha256 ||
        liveCandidate.size !== entry.after.bytes.byteLength ||
        !isCanonicalLiveMutationContent(liveCandidate) ||
        liveCandidate.storageUri === candidate.storageUri
      ) {
        return {
          kind: "failed",
          code: "backend_failure",
          diagnostics: [
            {
              code: "live_candidate_mismatch",
              message:
                "Live Workspace candidate must be unique exact-byte storage",
            },
          ],
        };
      }
      const prepared = Object.freeze({
        kind: "candidate" as const,
        requestDigest,
        beforeCandidate: Object.freeze({ ...beforeCandidate }),
        candidate: Object.freeze({ ...candidate }),
        liveCandidate: Object.freeze({ ...liveCandidate }),
      });
      this.preparedCandidates.add(prepared);
      return {
        kind: "prepared",
        prepared,
      };
    } catch (error) {
      return {
        kind: "failed",
        code: "backend_failure",
        diagnostics: [
          {
            code: "prepare_failed",
            message:
              error instanceof Error
                ? error.message
                : "Workspace prepare failed",
          },
        ],
      };
    }
  }

  async commitPrepared(
    input: CommitPreparedInput<"workspace", PreparedWorkspaceArtifactMutation>,
  ): Promise<
    BackendCommitOutcome<"workspace", BackendCommitReceipt<"workspace">>
  > {
    const invalid = invalidPlanDiagnostics(input.plan);
    if (invalid) return failed(invalid);
    if (
      (input.prepared.kind === "candidate" ||
        input.prepared.kind === "batch_candidate") &&
      !this.preparedCandidates.has(input.prepared)
    ) {
      return failed(
        "Workspace candidate was not prepared by this backend instance",
        "backend_failure",
      );
    }
    if (input.prepared.kind === "batch_candidate") {
      return this.commitPreparedBatch(
        input as CommitPreparedInput<
          "workspace",
          Extract<
            PreparedWorkspaceArtifactMutation,
            { kind: "batch_candidate" }
          >
        >,
      );
    }
    if (
      input.prepared.kind === "replay" &&
      input.prepared.authorityScope === "batch"
    ) {
      const resolver = this.dependencies.batchAuthorityResolver;
      if (!resolver)
        return failed(
          "Workspace batch replay authority resolver is unavailable",
        );
      try {
        return await this.db.transaction(async (tx) => {
          const authority = await resolver.resolveReplayInTransaction(
            tx,
            input.plan,
          );
          if (
            !authority ||
            !replayAuthorityMatchesPlan(authority, input.plan)
          ) {
            return failed(
              "Workspace Room replay authority is absent or revoked at commit",
            );
          }
          const requestDigest = workspaceBatchMutationRequestDigest(
            input.plan,
            authority,
          );
          if (requestDigest !== input.prepared.requestDigest) {
            return failed(
              "Prepared Workspace replay does not belong to this exact plan and metadata",
            );
          }
          const operationLock = await this.helpers.acquireOperationLock(
            tx,
            input.plan.operationId,
          );
          const replay = await this.helpers.findReplay(
            tx,
            operationLock,
            requestDigest,
          );
          if (replay.kind !== "match") {
            return failed(
              replay.kind === "digest_mismatch"
                ? "Operation ID is already bound to a different request digest"
                : "Prepared replay receipt disappeared before commit",
              "inconsistent_outcome",
            );
          }
          if (replay.replay.receipt.revisionGroupId !== input.revisionGroupId) {
            return failed(
              "Operation replay used a different revision group",
              "inconsistent_outcome",
            );
          }
          return {
            kind: "committed",
            receipt: replay.replay.receipt,
            enlistedEventBatch: replay.replay.enlistedEventBatch,
          };
        });
      } catch (error) {
        return failed(
          error instanceof Error
            ? error.message
            : "Workspace batch replay lookup failed",
        );
      }
    }
    const prepared = input.prepared;
    let casAttempted = false;
    try {
      return await this.db.transaction(async (tx) => {
        // Commit is a public backend boundary. Re-run trusted admission before
        // probing operation persistence so a forged prepared value cannot use
        // operation IDs as a receipt/corruption oracle.
        const authority =
          await this.dependencies.authorityResolver.resolveInTransaction(
            tx,
            input.plan,
          );
        if (!authority || !authorityMatchesPlan(authority, input.plan)) {
          return failed(
            "Workspace authority is absent or revoked at commit",
            "backend_failure",
          );
        }
        const nextMimeType = trustedNextMimeType(authority);
        const editorFingerprint = trustedEditorRequestFingerprint(authority);
        const requestDigest = workspaceMutationRequestDigest(input.plan, {
          nextMimeType,
          ...(editorFingerprint === undefined
            ? {}
            : { editorRequestFingerprint: editorFingerprint }),
        });
        if (requestDigest !== prepared.requestDigest) {
          return failed(
            "Prepared Workspace candidate does not belong to this exact plan and metadata",
            "backend_failure",
          );
        }
        const operationLock = await this.helpers.acquireOperationLock(
          tx,
          input.plan.operationId,
        );
        const replay = await this.helpers.findReplay(
          tx,
          operationLock,
          requestDigest,
        );
        if (replay.kind === "digest_mismatch")
          return failed(
            "Operation ID is already bound to a different request digest",
            "inconsistent_outcome",
          );

        if (replay.kind === "match") {
          if (replay.replay.receipt.revisionGroupId !== input.revisionGroupId) {
            return failed(
              "Operation replay used a different revision group",
              "inconsistent_outcome",
            );
          }
          return {
            kind: "committed",
            receipt: replay.replay.receipt,
            enlistedEventBatch: replay.replay.enlistedEventBatch,
          };
        }
        if (prepared.kind === "replay") {
          return failed(
            "Prepared replay receipt disappeared before commit",
            "inconsistent_outcome",
          );
        }

        const entry = input.plan.entries[0]!;
        if (entry.kind !== "update")
          return failed(
            "Validated plan lost its update entry",
            "inconsistent_outcome",
          );
        await this.helpers.acquireArtifactLock(
          tx,
          entry.before.identity.artifactId,
        );

        // The resolver runs a second time after the artifact lock. This closes
        // revocation/rename races between the first transaction lookup and CAS.
        const lockedAuthority =
          await this.dependencies.authorityResolver.resolveInTransaction(
            tx,
            input.plan,
          );
        if (
          !lockedAuthority ||
          !authorityMatchesPlan(lockedAuthority, input.plan)
        ) {
          return failed(
            "Workspace authority is absent or revoked after artifact lock",
          );
        }
        const lockedNextMimeType = trustedNextMimeType(lockedAuthority);
        if (lockedNextMimeType !== nextMimeType) {
          return failed(
            "Workspace mutation MIME metadata changed after artifact lock",
            "backend_failure",
          );
        }
        if (
          trustedEditorRequestFingerprint(lockedAuthority) !== editorFingerprint
        ) {
          return failed(
            "Workspace editor request fingerprint changed after artifact lock",
            "backend_failure",
          );
        }
        const currentBytes = await this.readContent(
          lockedAuthority.artifact.storageUri,
        );
        const currentSha256 = sha256Hex(currentBytes);
        if (lockedAuthority.artifact.size !== currentBytes.byteLength) {
          return failed(
            "Artifact row size does not prove the bytes read at commit",
            "inconsistent_outcome",
          );
        }
        const current = versionFor(
          entry.before.identity,
          lockedAuthority.artifact,
          currentSha256,
        );
        if (
          !exactCurrentMatchesPlan(lockedAuthority, input.plan, currentSha256)
        ) {
          return {
            kind: "conflict",
            code: "stale_version",
            evidence: staleEvidence(input.plan, current),
            currentSnapshots: [{
              identity: current.identity,
              currentVersion: current,
              bytes: currentBytes,
            }],
            diagnostics: [
              {
                code: "stale_version",
                message:
                  "Artifact version, identity, URI, or bytes drifted before CAS",
              },
            ],
          };
        }
        const candidateBytes = await this.readContent(
          prepared.candidate.storageUri,
        );
        if (
          candidateBytes.byteLength !== prepared.candidate.size ||
          sha256Hex(candidateBytes) !== entry.after.sha256
        ) {
          return failed(
            "Immutable Workspace candidate bytes no longer prove the planned postimage",
            "backend_failure",
          );
        }
        const liveCandidateBytes = await this.readContent(
          prepared.liveCandidate.storageUri,
        );
        if (
          liveCandidateBytes.byteLength !== prepared.liveCandidate.size ||
          sha256Hex(liveCandidateBytes) !== entry.after.sha256
        ) {
          return failed(
            "Live Workspace candidate bytes no longer prove the planned postimage",
            "backend_failure",
          );
        }
        const beforeCandidateBytes = await this.readContent(
          prepared.beforeCandidate.storageUri,
        );
        if (
          beforeCandidateBytes.byteLength !== prepared.beforeCandidate.size ||
          sha256Hex(beforeCandidateBytes) !==
            entry.before.expectedVersion.sha256
        ) {
          return failed(
            "Immutable Workspace preimage bytes no longer prove the planned preimage",
            "backend_failure",
          );
        }

        casAttempted = true;
        const updated = await this.helpers.casPointer(tx, {
          artifactInternalId: lockedAuthority.artifact.id,
          expectedRevision: lockedAuthority.artifact.revision,
          expectedStorageUri: lockedAuthority.artifact.storageUri,
          expectedSha256: currentSha256,
          callerVerifiedSha256: currentSha256,
          nextStorageUri: prepared.liveCandidate.storageUri,
          nextSize: prepared.liveCandidate.size,
          nextMimeType: lockedNextMimeType,
        });
        if (!updated)
          return {
            kind: "conflict",
            code: "stale_version",
            evidence: staleEvidence(input.plan, current),
            diagnostics: [
              {
                code: "cas_miss",
                message: "Artifact pointer CAS lost its exact expected row",
              },
            ],
          };
        if (
          updated.id !== lockedAuthority.artifact.id ||
          updated.path !== entry.after.identity.logicalPath ||
          updated.revision !== lockedAuthority.artifact.revision + 1 ||
          updated.storageUri !== prepared.liveCandidate.storageUri ||
          updated.size !== prepared.liveCandidate.size ||
          updated.mimeType !== lockedNextMimeType
        ) {
          throw new Error(
            "Artifact CAS returned a row inconsistent with the prospective receipt",
          );
        }

        const after: WorkspaceDocumentVersion = {
          identity: entry.after.identity,
          backendVersion: {
            kind: "artifact_revision",
            revision: updated.revision,
          },
          sha256: entry.after.sha256,
        };
        const receipt: BackendCommitReceipt<"workspace"> = {
          backend: "workspace",
          operationId: input.plan.operationId,
          revisionGroupId: input.revisionGroupId,
          entries: [
            {
              kind: "update",
              entryIndex: 0,
              revisionIds: [this.newOpaqueId()],
              undoRecordIds: [this.newOpaqueId()],
              before: current,
              after,
              workspaceArtifactMetadata: {
                beforeMimeType: lockedAuthority.artifact.mimeType,
                afterMimeType: lockedNextMimeType,
              },
            },
          ],
        };
        const batch = input.buildCommittedEventBatch(receipt);
        const receiptEntry: WorkspaceMutationReceiptEntryInput = {
          sequence: 0,
          kind: "update",
          revisionIds: receipt.entries[0]!.revisionIds,
          undoRecordIds: receipt.entries[0]!.undoRecordIds,
          artifactInternalId: lockedAuthority.artifact.id,
          beforeLogicalPath: current.identity.logicalPath,
          afterLogicalPath: after.identity.logicalPath,
          beforeRevision: current.backendVersion.revision,
          afterRevision: after.backendVersion.revision,
          beforeSha256: current.sha256,
          afterSha256: after.sha256,
          beforeSize: prepared.beforeCandidate.size,
          afterSize: prepared.candidate.size,
          beforeStorageUri: prepared.beforeCandidate.storageUri,
          afterStorageUri: prepared.candidate.storageUri,
          beforeMimeType: lockedAuthority.artifact.mimeType,
          afterMimeType: lockedNextMimeType,
          checkpoint: input.plan.editorSave?.checkpoint ?? false,
        };
        await this.helpers.insertReceipt(tx, operationLock, {
          operationId: input.plan.operationId,
          requestDigest,
          revisionGroupId: input.revisionGroupId,
          ...(lockedAuthority.ownerId === undefined
            ? {}
            : { ownerId: lockedAuthority.ownerId }),
          ...(lockedAuthority.userId === undefined
            ? {}
            : { userId: lockedAuthority.userId }),
          ...(lockedAuthority.agentId === undefined
            ? {}
            : { agentId: lockedAuthority.agentId }),
          ...(lockedAuthority.roomId === undefined
            ? {}
            : { roomId: lockedAuthority.roomId }),
          actorKind: lockedAuthority.actor.kind,
          actorId: actorId(lockedAuthority.actor),
          lane: lockedAuthority.lane,
          ...(lockedAuthority.clientMutationId === undefined
            ? {}
            : { clientMutationId: lockedAuthority.clientMutationId }),
          ...(lockedAuthority.requestId === undefined
            ? {}
            : { requestId: lockedAuthority.requestId }),
          ...(lockedAuthority.editorRequestFingerprint === undefined
            ? {}
            : {
                editorRequestFingerprint:
                  lockedAuthority.editorRequestFingerprint,
              }),
          entries: [receiptEntry],
          eventBatch: batch,
        });
        return { kind: "committed", receipt, enlistedEventBatch: batch, freshlyCommitted: true };
      });
    } catch (error) {
      // Candidate bytes may remain unreferenced, but a rejected DB transaction
      // normally cannot expose a partial pointer/receipt/outbox state. If the
      // exception followed a CAS attempt, however, this process cannot prove
      // transaction outcome across an injected/transport failure; fail closed
      // into coordinator recovery instead of claiming an ordinary failure.
      return failed(
        error instanceof Error
          ? error.message
          : "Workspace commit transaction failed",
        casAttempted ? "inconsistent_outcome" : "backend_failure",
      );
    }
  }

  private async commitPreparedBatch(
    input: CommitPreparedInput<
      "workspace",
      Extract<PreparedWorkspaceArtifactMutation, { kind: "batch_candidate" }>
    >,
  ): Promise<
    BackendCommitOutcome<"workspace", BackendCommitReceipt<"workspace">>
  > {
    const resolver = this.dependencies.batchAuthorityResolver;
    if (!resolver)
      return failed("Workspace batch authority resolver is unavailable");
    let mutationAttempted = false;
    try {
      return await this.db.transaction(async (tx) => {
        const initialAuthority = await resolver.resolveInTransaction(
          tx,
          input.plan,
        );
        if (
          !initialAuthority ||
          !batchAuthorityMatchesPlan(initialAuthority, input.plan)
        ) {
          return failed(
            "Workspace batch authority is absent or revoked at commit",
          );
        }
        const requestDigest = workspaceBatchMutationRequestDigest(
          input.plan,
          initialAuthority,
        );
        if (requestDigest !== input.prepared.requestDigest) {
          return failed(
            "Prepared Workspace batch does not belong to this exact plan and metadata",
          );
        }
        const operationLock = await this.helpers.acquireOperationLock(
          tx,
          input.plan.operationId,
        );
        const replay = await this.helpers.findReplay(
          tx,
          operationLock,
          requestDigest,
        );
        if (replay.kind === "digest_mismatch") {
          return failed(
            "Operation ID is already bound to a different request digest",
            "inconsistent_outcome",
          );
        }
        if (replay.kind === "match") {
          if (replay.replay.receipt.revisionGroupId !== input.revisionGroupId) {
            return failed(
              "Operation replay used a different revision group",
              "inconsistent_outcome",
            );
          }
          return {
            kind: "committed",
            receipt: replay.replay.receipt,
            enlistedEventBatch: replay.replay.enlistedEventBatch,
          };
        }

        const artifactIds = [
          ...new Set(
            existingIdentities(input.plan).map(
              (identity) => identity.artifactId,
            ),
          ),
        ].sort();
        for (const artifactId of artifactIds) {
          await this.helpers.acquireArtifactLock(tx, artifactId);
        }
        const authority = await resolver.resolveInTransaction(tx, input.plan);
        if (!authority || !batchAuthorityMatchesPlan(authority, input.plan)) {
          return failed(
            "Workspace batch authority is absent or revoked after artifact locks",
          );
        }
        if (
          JSON.stringify(authority.nextMimeTypes) !==
            JSON.stringify(initialAuthority.nextMimeTypes) ||
          JSON.stringify(authority.createdArtifactPublicIds ?? {}) !==
            JSON.stringify(initialAuthority.createdArtifactPublicIds ?? {}) ||
          JSON.stringify(authority.restoreDeletedArtifactIds ?? []) !==
            JSON.stringify(initialAuthority.restoreDeletedArtifactIds ?? []) ||
          authority.restoreFromEntryId !== initialAuthority.restoreFromEntryId ||
          JSON.stringify(authority.restoreFromEntryIds ?? []) !==
            JSON.stringify(initialAuthority.restoreFromEntryIds ?? []) ||
          (planHasCreate(input.plan) &&
            authority.createNamespaceId !== initialAuthority.createNamespaceId)
        ) {
          return failed(
            "Workspace batch mutation metadata changed after artifact locks",
          );
        }

        const currentById = artifactMap(authority);
        const currentVersions = new Map<string, WorkspaceDocumentVersion>();
        for (const identity of existingIdentities(input.plan)) {
          if (currentVersions.has(identity.artifactId)) continue;
          const artifact = currentById.get(identity.artifactId)!;
          const snapshot = expectedSnapshotFor(
            input.plan,
            identity.artifactId,
          )!;
          const bytes = await this.readContent(artifact.storageUri);
          const digest = sha256Hex(bytes);
          const current = versionFor(identity, artifact, digest);
          currentVersions.set(identity.artifactId, current);
          if (!versionMatchesSnapshot(artifact, snapshot, digest)) {
            const path = mutationPathForArtifact(
              input.plan,
              identity.artifactId,
            );
            if (!path) {
              return {
                kind: "failed",
                code: "backend_failure",
                requiresCompensation: false,
                diagnostics: [
                  {
                    code: "stale_precondition",
                    message:
                      "A read-only Workspace precondition no longer matches its exact source snapshot",
                  },
                ],
              };
            }
            return {
              kind: "conflict",
              code: "stale_version",
              evidence: [
                {
                  path,
                  currentVersion: current,
                },
              ],
              currentSnapshots: [{
                identity: current.identity,
                currentVersion: current,
                bytes,
              }],
              diagnostics: [
                {
                  code: "stale_version",
                  message:
                    "Workspace artifact identity, version, size, or bytes drifted before commit",
                },
              ],
            };
          }
        }

        for (const prepared of input.prepared.entries) {
          const entry = input.plan.entries[prepared.entryIndex]!;
          const proofs: Array<{
            content:
              | WorkspaceDocumentMutationContent
              | WorkspaceDocumentMutationLiveContent
              | undefined;
            bytes: Uint8Array | undefined;
            sha256: string | undefined;
          }> = [];
          if (entry.kind !== "create") {
            const before = entry.kind === "move" ? entry.source : entry.before;
            proofs.push({
              content: prepared.beforeCandidate,
              bytes: before.bytes,
              sha256: before.expectedVersion.sha256,
            });
          }
          if (entry.kind === "move" && entry.destinationBefore !== undefined) {
            proofs.push({
              content: prepared.destinationBeforeCandidate,
              bytes: entry.destinationBefore.bytes,
              sha256: entry.destinationBefore.expectedVersion.sha256,
            });
          }
          if (entry.kind !== "delete") {
            proofs.push(
              {
                content: prepared.candidate,
                bytes: entry.after.bytes,
                sha256: entry.after.sha256,
              },
              {
                content: prepared.liveCandidate,
                bytes: entry.after.bytes,
                sha256: entry.after.sha256,
              },
            );
          }
          for (const proof of proofs) {
            if (!proof.content || !proof.bytes || !proof.sha256) {
              return failed(
                "Prepared Workspace batch is missing exact content evidence",
              );
            }
            const bytes = await this.readContent(proof.content.storageUri);
            if (
              bytes.byteLength !== proof.bytes.byteLength ||
              bytes.byteLength !== proof.content.size ||
              sha256Hex(bytes) !== proof.sha256
            ) {
              return failed(
                "Prepared Workspace batch content no longer proves the plan",
              );
            }
          }
        }

        const receiptEntries: BackendCommitReceipt<"workspace">["entries"][number][] =
          [];
        const receiptInputs: WorkspaceMutationReceiptEntryInput[] = [];
        for (const [entryIndex, entry] of input.plan.entries.entries()) {
          const prepared = input.prepared.entries[entryIndex]!;
          // An overwrite-move is represented by two physical history facts:
          // destination delete first, then source move. The public normalizer
          // intentionally selects the final revision ID as the move result.
          const revisionIds = (
            entry.kind === "move" && entry.destinationBefore !== undefined
              ? [this.newOpaqueId(), this.newOpaqueId()]
              : [this.newOpaqueId()]
          ) as [string, ...string[]];
          const undoRecordIds = (
            entry.kind === "move" && entry.destinationBefore !== undefined
              ? [this.newOpaqueId(), this.newOpaqueId()]
              : [this.newOpaqueId()]
          ) as [string, ...string[]];
          if (entry.kind === "create") {
            mutationAttempted = true;
            const identity = entry.after.identity;
            const mimeType = authority.nextMimeTypes[identity.artifactId]!;
            const created = await this.helpers.createArtifact(tx, {
              internalId: identity.artifactId,
              artifactId:
                authority.createdArtifactPublicIds?.[identity.artifactId] ??
                identity.artifactId,
              logicalPath: identity.logicalPath,
              storageUri: prepared.liveCandidate!.storageUri,
              size: prepared.liveCandidate!.size,
              mimeType,
              namespaceId: authority.createNamespaceId!,
            });
            const after: WorkspaceDocumentVersion = {
              identity,
              backendVersion: {
                kind: "artifact_revision",
                revision: created.revision,
              },
              sha256: entry.after.sha256,
            };
            receiptEntries.push({
              kind: "create",
              entryIndex,
              revisionIds,
              undoRecordIds,
              after,
            });
            receiptInputs.push({
              sequence: entryIndex,
              kind: "create",
              revisionIds,
              undoRecordIds,
              artifactInternalId: identity.artifactId,
              afterLogicalPath: identity.logicalPath,
              afterRevision: after.backendVersion.revision,
              afterSha256: after.sha256,
              afterSize: prepared.candidate!.size,
              afterStorageUri: prepared.candidate!.storageUri,
              checkpoint: false,
            });
          } else if (entry.kind === "delete") {
            const identity = entry.before.identity;
            const artifact = currentById.get(identity.artifactId)!;
            const before = currentVersions.get(identity.artifactId)!;
            mutationAttempted = true;
            const deleted = await this.helpers.casDelete(tx, {
              artifactInternalId: artifact.id,
              expectedRevision: artifact.revision,
              expectedStorageUri: artifact.storageUri,
              expectedSha256: before.sha256,
              callerVerifiedSha256: before.sha256,
            });
            if (!deleted)
              throw new Error(
                "Workspace delete CAS lost its exact expected row",
              );
            receiptEntries.push({
              kind: "delete",
              entryIndex,
              revisionIds,
              undoRecordIds,
              before,
            });
            receiptInputs.push({
              sequence: entryIndex,
              kind: "delete",
              revisionIds,
              undoRecordIds,
              artifactInternalId: artifact.id,
              beforeLogicalPath: before.identity.logicalPath,
              beforeRevision: before.backendVersion.revision,
              beforeSha256: before.sha256,
              beforeSize: prepared.beforeCandidate!.size,
              beforeStorageUri: prepared.beforeCandidate!.storageUri,
              checkpoint: false,
            });
          } else if (entry.kind === "update") {
            const identity = entry.before.identity;
            const artifact = currentById.get(identity.artifactId)!;
            const before = currentVersions.get(identity.artifactId)!;
            const mimeType = authority.nextMimeTypes[identity.artifactId]!;
            mutationAttempted = true;
            const updated = authority.restoreDeletedArtifactIds?.includes(
              artifact.id,
            )
              ? await this.helpers.casRestoreDeleted(tx, {
                  artifactInternalId: artifact.id,
                  expectedRevision: artifact.revision,
                  expectedStorageUri: artifact.storageUri,
                  expectedSha256: before.sha256,
                  callerVerifiedSha256: before.sha256,
                  nextStorageUri: prepared.liveCandidate!.storageUri,
                  nextSize: prepared.liveCandidate!.size,
                  nextLogicalPath: entry.after.identity.logicalPath,
                  nextMimeType: mimeType,
                })
              : await this.helpers.casPointer(tx, {
                  artifactInternalId: artifact.id,
                  expectedRevision: artifact.revision,
                  expectedStorageUri: artifact.storageUri,
                  expectedSha256: before.sha256,
                  callerVerifiedSha256: before.sha256,
                  nextStorageUri: prepared.liveCandidate!.storageUri,
                  nextSize: prepared.liveCandidate!.size,
                  nextMimeType: mimeType,
                });
            if (!updated)
              throw new Error(
                "Workspace update CAS lost its exact expected row",
              );
            const after: WorkspaceDocumentVersion = {
              identity: entry.after.identity,
              backendVersion: {
                kind: "artifact_revision",
                revision: updated.revision,
              },
              sha256: entry.after.sha256,
            };
            receiptEntries.push({
              kind: "update",
              entryIndex,
              revisionIds,
              undoRecordIds,
              before,
              after,
              workspaceArtifactMetadata: {
                beforeMimeType: artifact.mimeType,
                afterMimeType: mimeType,
              },
            });
            receiptInputs.push({
              sequence: entryIndex,
              kind: "update",
              revisionIds,
              undoRecordIds,
              artifactInternalId: artifact.id,
              beforeLogicalPath: before.identity.logicalPath,
              afterLogicalPath: after.identity.logicalPath,
              beforeRevision: before.backendVersion.revision,
              afterRevision: after.backendVersion.revision,
              beforeSha256: before.sha256,
              afterSha256: after.sha256,
              beforeSize: prepared.beforeCandidate!.size,
              afterSize: prepared.candidate!.size,
              beforeStorageUri: prepared.beforeCandidate!.storageUri,
              afterStorageUri: prepared.candidate!.storageUri,
              beforeMimeType: artifact.mimeType,
              afterMimeType: mimeType,
              checkpoint: false,
            });
          } else {
            const sourceIdentity = entry.source.identity;
            const source = currentById.get(sourceIdentity.artifactId)!;
            const before = currentVersions.get(sourceIdentity.artifactId)!;
            let destinationBefore: WorkspaceDocumentVersion | undefined;
            if (entry.destinationBefore !== undefined) {
              const destinationIdentity = entry.destinationBefore.identity;
              const destination = currentById.get(
                destinationIdentity.artifactId,
              )!;
              destinationBefore = currentVersions.get(
                destinationIdentity.artifactId,
              )!;
              mutationAttempted = true;
              const deleted = await this.helpers.casDelete(tx, {
                artifactInternalId: destination.id,
                expectedRevision: destination.revision,
                expectedStorageUri: destination.storageUri,
                expectedSha256: destinationBefore.sha256,
                callerVerifiedSha256: destinationBefore.sha256,
              });
              if (!deleted)
                throw new Error(
                  "Workspace overwrite destination CAS lost its exact expected row",
                );
            }
            mutationAttempted = true;
            const updated = await this.helpers.casPointer(tx, {
              artifactInternalId: source.id,
              expectedRevision: source.revision,
              expectedStorageUri: source.storageUri,
              expectedSha256: before.sha256,
              callerVerifiedSha256: before.sha256,
              nextStorageUri: prepared.liveCandidate!.storageUri,
              nextSize: prepared.liveCandidate!.size,
              nextLogicalPath: entry.after.identity.logicalPath,
            });
            if (!updated)
              throw new Error("Workspace move CAS lost its exact expected row");
            const after: WorkspaceDocumentVersion = {
              identity: entry.after.identity,
              backendVersion: {
                kind: "artifact_revision",
                revision: updated.revision,
              },
              sha256: entry.after.sha256,
            };
            receiptEntries.push({
              kind: "move",
              entryIndex,
              revisionIds,
              undoRecordIds,
              before,
              ...(destinationBefore === undefined ? {} : { destinationBefore }),
              after,
            });
            receiptInputs.push({
              sequence: entryIndex,
              kind: "move",
              revisionIds,
              undoRecordIds,
              artifactInternalId: source.id,
              beforeLogicalPath: before.identity.logicalPath,
              afterLogicalPath: after.identity.logicalPath,
              beforeRevision: before.backendVersion.revision,
              afterRevision: after.backendVersion.revision,
              beforeSha256: before.sha256,
              afterSha256: after.sha256,
              beforeSize: prepared.beforeCandidate!.size,
              afterSize: prepared.candidate!.size,
              beforeStorageUri: prepared.beforeCandidate!.storageUri,
              afterStorageUri: prepared.candidate!.storageUri,
              ...(destinationBefore === undefined
                ? {}
                : {
                    destinationBeforeArtifactInternalId:
                      destinationBefore.identity.artifactId,
                    destinationBeforeLogicalPath:
                      destinationBefore.identity.logicalPath,
                    destinationBeforeRevision:
                      destinationBefore.backendVersion.revision,
                    destinationBeforeSha256: destinationBefore.sha256,
                    destinationBeforeSize:
                      prepared.destinationBeforeCandidate!.size,
                    destinationBeforeStorageUri:
                      prepared.destinationBeforeCandidate!.storageUri,
                  }),
              checkpoint: false,
            });
          }
        }
        const receipt: BackendCommitReceipt<"workspace"> = {
          backend: "workspace",
          operationId: input.plan.operationId,
          revisionGroupId: input.revisionGroupId,
          entries: receiptEntries,
        };
        const batch = input.buildCommittedEventBatch(receipt);
        const historyOperation = authority.historyOperation;
        const restoreFromEntryId = authority.restoreFromEntryId;
        const restoreFromEntryIds = authority.restoreFromEntryIds;
        await this.helpers.insertReceipt(tx, operationLock, {
          operationId: input.plan.operationId,
          requestDigest,
          revisionGroupId: input.revisionGroupId,
          ...(authority.ownerId === undefined
            ? {}
            : { ownerId: authority.ownerId }),
          ...(authority.userId === undefined
            ? {}
            : { userId: authority.userId }),
          ...(authority.agentId === undefined
            ? {}
            : { agentId: authority.agentId }),
          ...(authority.roomId === undefined
            ? {}
            : { roomId: authority.roomId }),
          actorKind: authority.actor.kind,
          actorId: actorId(authority.actor),
          lane: authority.lane,
          ...(input.plan.turnId === undefined
            ? {}
            : { turnId: input.plan.turnId }),
          entries:
            historyOperation === undefined &&
                restoreFromEntryId === undefined &&
                restoreFromEntryIds === undefined
              ? receiptInputs
              : receiptInputs.map((entry, entryIndex) => ({
                  ...entry,
                  ...(historyOperation === undefined
                    ? {}
                    : { historyOperation }),
                  ...(restoreFromEntryId === undefined
                    ? restoreFromEntryIds === undefined
                      ? {}
                      : {
                          restoreFromEntryId:
                            restoreFromEntryIds[entryIndex]!,
                        }
                    : { restoreFromEntryId }),
                })),
          eventBatch: batch,
        });
        return { kind: "committed", receipt, enlistedEventBatch: batch, freshlyCommitted: true };
      });
    } catch (error) {
      return failed(
        error instanceof Error
          ? error.message
          : "Workspace batch commit transaction failed",
        mutationAttempted ? "inconsistent_outcome" : "backend_failure",
      );
    }
  }

  compensate(
    input: CompensateCommitInput<
      "workspace",
      PreparedWorkspaceArtifactMutation,
      BackendCommitReceipt<"workspace">
    >,
  ): Promise<BackendCompensationOutcome> {
    // A committed Workspace transaction includes pointer, receipt, and outbox
    // atomically. Reversing a returned receipt would create a second mutation,
    // not compensation. Likewise, this backend cannot claim rollback after an
    // unknown caller/transport outcome. The coordinator maps this honest answer
    // to recovery_required where necessary.
    return Promise.resolve({
      kind: "failed",
      code: "inconsistent_outcome",
      diagnostics: [
        {
          code: "recovery_required",
          message: input.receipt
            ? "A committed Workspace receipt cannot be compensated outside its atomic transaction"
            : "Workspace commit outcome is unknown; durable receipt lookup is required before recovery",
        },
      ],
    });
  }

  disposePrepared(_prepared: PreparedWorkspaceArtifactMutation): void {
    // Immutable candidate objects are safe if unreferenced and intentionally
    // have no compensating delete path.
  }
}

export function createWorkspaceArtifactMutationBackend(
  dependencies: WorkspaceArtifactMutationBackendDependencies,
): WorkspaceArtifactMutationBackend {
  return new WorkspaceArtifactMutationBackend(dependencies);
}
