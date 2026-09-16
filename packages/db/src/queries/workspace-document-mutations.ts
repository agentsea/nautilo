/**
 * D448 Phase 8.2 — transaction-bound Workspace mutation persistence.
 *
 * Callers own the transaction boundary: candidate bytes are written before
 * it begins, then pointer CAS, immutable receipts, and outbox rows commit
 * together. None of these helpers open a second transaction or provide an
 * unconditional artifact revision bump.
 */

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  parseDocumentMutationCommittedEvent,
  type DocumentMutationCommittedEvent,
  type WorkspaceDocumentVersion,
} from "@nautilo/types";
import type { DirectDatabase } from "../config/direct-database";
import { artifacts, type Artifact, type ArtifactRow } from "../schema/artifacts";
import { artifactNamespaces } from "../schema/artifact-namespaces";
import {
  workspaceDocumentMutationEntries,
  workspaceDocumentMutationEntryIdentities,
  workspaceDocumentMutationOutbox,
  workspaceDocumentMutations,
  type WorkspaceDocumentMutation,
  type WorkspaceDocumentMutationEntry,
  type WorkspaceDocumentMutationEntryIdentity,
  type WorkspaceDocumentMutationOutboxRow,
} from "../schema/workspace-document-mutations";

/** The exact transaction handle `DirectDatabase.transaction` supplies. */
export type WorkspaceDocumentMutationTx = Parameters<
  Parameters<DirectDatabase["transaction"]>[0]
>[0];

/** Exact actor union accepted by the committed coordinator contract. */
export type WorkspaceMutationActorKind = "human" | "agent";
export type WorkspaceMutationOutboxEventType = DocumentMutationCommittedEvent["type"];
export type WorkspaceMutationOutboxEvent = DocumentMutationCommittedEvent;

export type WorkspaceMutationReceiptEntryInput = {
  readonly sequence: number;
  readonly kind: "create" | "update" | "move" | "delete";
  readonly revisionIds: readonly [string, ...string[]];
  readonly undoRecordIds: readonly [string, ...string[]];
  readonly artifactInternalId: string;
  readonly beforeLogicalPath?: string | null;
  readonly afterLogicalPath?: string | null;
  readonly beforeRevision?: number | null;
  readonly afterRevision?: number | null;
  readonly beforeSha256?: string | null;
  readonly afterSha256?: string | null;
  readonly beforeSize?: number | null;
  readonly afterSize?: number | null;
  readonly beforeStorageUri?: string | null;
  readonly afterStorageUri?: string | null;
  readonly beforeMimeType?: string | null;
  readonly afterMimeType?: string | null;
  readonly destinationBeforeArtifactInternalId?: string | null;
  readonly destinationBeforeLogicalPath?: string | null;
  readonly destinationBeforeRevision?: number | null;
  readonly destinationBeforeSha256?: string | null;
  readonly destinationBeforeSize?: number | null;
  readonly destinationBeforeStorageUri?: string | null;
  /** Stable user-facing history operation; defaults from the trusted lane. */
  readonly historyOperation?: string;
  /** Defaults to agent mutations or requested human checkpoints. */
  readonly historyEligible?: boolean;
  /** Trusted restore provenance; never accepted from an unverified revision id. */
  readonly restoreFromEntryId?: string | null;
  /** True only when the coordinator commits a human editor checkpoint. */
  readonly checkpoint: boolean;
};

function legacyArtifact(row: ArtifactRow | undefined): Artifact | null {
  if (row === undefined) return null;
  if (row.path === null || row.mimeType === null
    || row.size === null || row.storageUri === null) {
    throw new Error("Workspace mutation repository received a protected Artifact");
  }
  return row as Artifact;
}

function ordinaryArtifactRowPredicate() {
  return and(
    isNotNull(artifacts.path),
    isNotNull(artifacts.mimeType),
    isNotNull(artifacts.size),
    isNotNull(artifacts.storageUri),
  );
}

/** Structural twin of the shared AtomicDocumentMutationEventBatch. */
export type WorkspaceMutationEventBatchInput = {
  readonly operationId: string;
  readonly revisionGroupId: string;
  readonly idempotencyKey: string;
  readonly events: readonly DocumentMutationCommittedEvent[];
};

export type InsertWorkspaceDocumentMutationInput = {
  /** Opaque nonempty coordinator ID, deliberately not narrowed to UUID. */
  readonly operationId: string;
  readonly requestDigest: string;
  /** Opaque nonempty coordinator correlation ID, deliberately not UUID-only. */
  readonly revisionGroupId: string;
  /** Trusted request context, supplied by the authority resolver. */
  readonly ownerId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly roomId?: string;
  readonly actorKind: WorkspaceMutationActorKind;
  readonly actorId: string;
  readonly lane: string;
  readonly clientMutationId?: string;
  readonly requestId?: string;
  readonly turnId?: string;
  readonly editorRequestFingerprint?: string;
  readonly pinned?: boolean;
  readonly entries: readonly WorkspaceMutationReceiptEntryInput[];
  readonly eventBatch: WorkspaceMutationEventBatchInput;
};

type WorkspaceCommittedEntryReplayBase = {
  readonly entryIndex: number;
  readonly revisionIds: readonly [string, ...string[]];
  readonly undoRecordIds: readonly [string, ...string[]];
};

export type WorkspaceCommittedEntryReplay =
  | (WorkspaceCommittedEntryReplayBase & {
      readonly kind: "create";
      readonly after: WorkspaceDocumentVersion;
    })
  | (WorkspaceCommittedEntryReplayBase & {
      readonly kind: "update";
      readonly before: WorkspaceDocumentVersion;
      readonly after: WorkspaceDocumentVersion;
      readonly workspaceArtifactMetadata?: {
        readonly beforeMimeType: string;
        readonly afterMimeType: string;
      };
    })
  | (WorkspaceCommittedEntryReplayBase & {
      readonly kind: "move";
      readonly before: WorkspaceDocumentVersion;
      readonly destinationBefore?: WorkspaceDocumentVersion;
      readonly after: WorkspaceDocumentVersion;
    })
  | (WorkspaceCommittedEntryReplayBase & {
      readonly kind: "delete";
      readonly before: WorkspaceDocumentVersion;
    });

export type WorkspaceDocumentMutationCommitReplay = {
  readonly receipt: {
    readonly backend: "workspace";
    readonly operationId: string;
    readonly revisionGroupId: string;
    readonly entries: readonly WorkspaceCommittedEntryReplay[];
  };
  readonly enlistedEventBatch: WorkspaceMutationEventBatchInput;
};

function assertContiguousOrderedSequences(
  rows: readonly { readonly sequence: number }[],
  label: string,
): void {
  rows.forEach((row, index) => {
    if (row.sequence !== index) {
      throw new Error(`${label} must be ordered with contiguous zero-based sequences`);
    }
  });
}

function assertNonemptyUniqueReceiptIds(
  ids: readonly string[],
  label: string,
  globallySeen: Set<string>,
): void {
  if (ids.length === 0) throw new Error(`${label} must be nonempty`);
  ids.forEach((id) => {
    if (id.trim().length === 0 || globallySeen.has(id)) {
      throw new Error(`${label} must contain globally unique nonempty opaque ids`);
    }
    globallySeen.add(id);
  });
}

function assertWorkspaceCommittedEvent(event: DocumentMutationCommittedEvent): void {
  const versions = (() => {
    switch (event.mutation) {
      case "create":
        return [event.after];
      case "update":
        return [event.before, event.after];
      case "move":
        return event.overwrite
          ? [event.before, event.destinationBefore, event.after]
          : [event.before, event.after];
      case "delete":
        return [event.before];
    }
  })();
  if (versions.some((version) => version.identity.kind !== "workspace_artifact")) {
    throw new Error("Workspace outbox event must contain only Workspace artifact versions");
  }
}

function entryVersionMatches(
  version: WorkspaceDocumentVersion,
  artifactInternalId: string | null | undefined,
  logicalPath: string | null | undefined,
  revision: number | null | undefined,
  sha256: string | null | undefined,
): boolean {
  return (
    version.identity.artifactId === artifactInternalId &&
    version.identity.logicalPath === logicalPath &&
    version.backendVersion.revision === revision &&
    version.sha256 === sha256
  );
}

type PersistedVersionProof = {
  readonly artifactInternalId: string | null | undefined;
  readonly logicalPath: string | null | undefined;
  readonly revision: number | null | undefined;
  readonly sha256: string | null | undefined;
  readonly size: number | null | undefined;
  readonly storageUri: string | null | undefined;
};

function hasCompleteVersionProof(input: PersistedVersionProof): boolean {
  return (
    input.artifactInternalId != null &&
    input.logicalPath != null &&
    input.revision != null &&
    input.sha256 != null &&
    typeof input.size === "number" &&
    Number.isSafeInteger(input.size) &&
    input.size >= 0 &&
    typeof input.storageUri === "string" &&
    input.storageUri.trim().length > 0
  );
}

function hasNoVersionProof(input: PersistedVersionProof): boolean {
  return Object.values(input).every((value) => value == null);
}

/** @internal focused receipt-proof test seam. */
export function assertWorkspaceMutationEntryEventProof(
  entry: WorkspaceMutationReceiptEntryInput,
  event: DocumentMutationCommittedEvent,
): void {
  const beforeProof = {
    artifactInternalId: entry.artifactInternalId,
    logicalPath: entry.beforeLogicalPath,
    revision: entry.beforeRevision,
    sha256: entry.beforeSha256,
    size: entry.beforeSize,
    storageUri: entry.beforeStorageUri,
  };
  const afterProof = {
    artifactInternalId: entry.artifactInternalId,
    logicalPath: entry.afterLogicalPath,
    revision: entry.afterRevision,
    sha256: entry.afterSha256,
    size: entry.afterSize,
    storageUri: entry.afterStorageUri,
  };
  const destinationProof = {
    artifactInternalId: entry.destinationBeforeArtifactInternalId,
    logicalPath: entry.destinationBeforeLogicalPath,
    revision: entry.destinationBeforeRevision,
    sha256: entry.destinationBeforeSha256,
    size: entry.destinationBeforeSize,
    storageUri: entry.destinationBeforeStorageUri,
  };

  const matchesBefore = (version: WorkspaceDocumentVersion) =>
    entryVersionMatches(
      version,
      entry.artifactInternalId,
      entry.beforeLogicalPath,
      entry.beforeRevision,
      entry.beforeSha256,
    );
  const matchesAfter = (version: WorkspaceDocumentVersion) =>
    entryVersionMatches(
      version,
      entry.artifactInternalId,
      entry.afterLogicalPath,
      entry.afterRevision,
      entry.afterSha256,
    );

  switch (entry.kind) {
    case "create":
      if (
        event.mutation !== "create" ||
        !hasNoVersionProof({ ...beforeProof, artifactInternalId: null }) ||
        !hasCompleteVersionProof(afterProof) ||
        !hasNoVersionProof(destinationProof) ||
        !matchesAfter(event.after as WorkspaceDocumentVersion)
      ) {
        throw new Error("create receipt proof must exactly match its committed event");
      }
      return;
    case "update":
      if (
        event.mutation !== "update" ||
        !hasCompleteVersionProof(beforeProof) ||
        !hasCompleteVersionProof(afterProof) ||
        !hasNoVersionProof(destinationProof) ||
        !matchesBefore(event.before as WorkspaceDocumentVersion) ||
        !matchesAfter(event.after as WorkspaceDocumentVersion)
      ) {
        throw new Error("update receipt proof must exactly match its committed event");
      }
      if (
        (entry.beforeMimeType == null) !== (entry.afterMimeType == null) ||
        (entry.beforeMimeType == null
          ? event.workspaceArtifactMetadata !== undefined
          : event.workspaceArtifactMetadata?.beforeMimeType !== entry.beforeMimeType ||
            event.workspaceArtifactMetadata?.afterMimeType !== entry.afterMimeType)
      ) {
        throw new Error("update MIME transition must exactly match its committed event");
      }
      return;
    case "move": {
      if (
        event.mutation !== "move" ||
        !hasCompleteVersionProof(beforeProof) ||
        !hasCompleteVersionProof(afterProof) ||
        !matchesBefore(event.before as WorkspaceDocumentVersion) ||
        !matchesAfter(event.after as WorkspaceDocumentVersion)
      ) {
        throw new Error("move receipt proof must exactly match its committed event");
      }
      if (event.overwrite) {
        if (
          !hasCompleteVersionProof(destinationProof) ||
          !entryVersionMatches(
            event.destinationBefore as WorkspaceDocumentVersion,
            entry.destinationBeforeArtifactInternalId,
            entry.destinationBeforeLogicalPath,
            entry.destinationBeforeRevision,
            entry.destinationBeforeSha256,
          )
        ) {
          throw new Error("overwrite move destination proof must exactly match its event");
        }
      } else if (!hasNoVersionProof(destinationProof)) {
        throw new Error("non-overwrite move cannot carry destination-before proof");
      }
      return;
    }
    case "delete":
      if (
        event.mutation !== "delete" ||
        !hasCompleteVersionProof(beforeProof) ||
        !hasNoVersionProof({ ...afterProof, artifactInternalId: null }) ||
        !hasNoVersionProof(destinationProof) ||
        !matchesBefore(event.before as WorkspaceDocumentVersion)
      ) {
        throw new Error("delete receipt proof must exactly match its committed event");
      }
  }
}

function assertEditorSaveReceiptCorrelation(
  header: {
    readonly lane: string;
    readonly actorKind: string;
    readonly requestId?: string | null;
    readonly clientMutationId?: string | null;
    readonly editorRequestFingerprint?: string | null;
  },
  entries: readonly Pick<WorkspaceMutationReceiptEntryInput, "kind" | "checkpoint">[],
  events: readonly DocumentMutationCommittedEvent[],
): void {
  if (header.lane !== "editor_save") {
    if (events.some((event) => "editorSave" in event && event.editorSave !== undefined)) {
      throw new Error("Non-editor Workspace mutation cannot carry editor-save event metadata");
    }
    return;
  }
  if (
    header.actorKind !== "human" ||
    entries.length !== 1 ||
    entries[0]?.kind !== "update" ||
    events.length !== 1 ||
    events[0]?.mutation !== "update"
  ) {
    throw new Error("Workspace editor save requires one human update receipt and event");
  }
  if (
    header.editorRequestFingerprint == null ||
    !/^[0-9a-f]{64}$/.test(header.editorRequestFingerprint)
  ) {
    throw new Error("Workspace editor save requires its canonical request fingerprint");
  }
  const metadata = events[0].editorSave;
  if (!metadata) {
    throw new Error("Workspace editor save event metadata is missing");
  }
  if (
    metadata.requestId !== (header.requestId ?? undefined) ||
    metadata.clientMutationId !== (header.clientMutationId ?? undefined) ||
    metadata.checkpoint !== entries[0].checkpoint
  ) {
    throw new Error("Workspace editor save header, entry, and event correlation is invalid");
  }
}

function assertExactCommittedReceipt(input: InsertWorkspaceDocumentMutationInput): string {
  if (input.actorKind !== "human" && input.actorKind !== "agent") {
    throw new Error("Committed Workspace mutation actor must be human or agent");
  }
  if (input.turnId !== undefined && input.turnId.trim().length === 0) {
    throw new Error("Workspace mutation turn id must be nonempty when provided");
  }
  if (input.entries.length === 0) {
    throw new Error("Committed Workspace mutation receipt must contain at least one entry");
  }
  if (input.eventBatch.events.length !== input.entries.length) {
    throw new Error("Committed Workspace mutation must persist one exact event per receipt entry");
  }
  assertContiguousOrderedSequences(input.entries, "Workspace mutation entries");
  assertContiguousOrderedSequences(input.eventBatch.events, "Workspace mutation committed events");
  const globallySeenIds = new Set<string>();
  const batchIdempotencyKey = input.eventBatch.idempotencyKey;
  if (batchIdempotencyKey.trim().length === 0) {
    throw new Error("Workspace event batch idempotency key must be nonempty");
  }
  if (
    input.eventBatch.operationId !== input.operationId ||
    input.eventBatch.revisionGroupId !== input.revisionGroupId
  ) {
    throw new Error("Workspace event batch must exactly correlate to its committed receipt");
  }
  // Validate, never regenerate, the shared coordinator's injective v1 key.
  // The verbatim supplied key is what is persisted on the mutation header.
  const expectedBatchIdempotencyKey =
    `document-mutation:v1:${JSON.stringify([input.operationId, input.revisionGroupId])}`;
  if (batchIdempotencyKey !== expectedBatchIdempotencyKey) {
    throw new Error("Workspace event batch idempotency key does not match the shared v1 contract");
  }
  const parsedEvents = input.eventBatch.events.map((event) => {
    const parsed = parseDocumentMutationCommittedEvent(event);
    assertWorkspaceCommittedEvent(parsed);
    return parsed;
  });
  assertEditorSaveReceiptCorrelation(input, input.entries, parsedEvents);
  input.entries.forEach((entry, index) => {
    if (
      entry.historyOperation !== undefined &&
      entry.historyOperation.trim().length === 0
    ) {
      throw new Error("Workspace history operation must be nonempty when provided");
    }
    assertNonemptyUniqueReceiptIds(entry.revisionIds, `entry ${index} revisionIds`, globallySeenIds);
    assertNonemptyUniqueReceiptIds(entry.undoRecordIds, `entry ${index} undoRecordIds`, globallySeenIds);
    const event = parsedEvents[index]!;
    if (
      event.operationId !== input.operationId ||
      event.revisionGroupId !== input.revisionGroupId ||
      event.sequence !== index ||
      event.mutation !== entry.kind
    ) {
      throw new Error("Workspace outbox event must exactly correlate to its committed receipt entry");
    }
    assertWorkspaceMutationEntryEventProof(entry, event);
    if (
      (input.actorKind === "human" &&
        (event.actor.kind !== "human" || event.actor.humanId !== input.actorId)) ||
      (input.actorKind === "agent" &&
        (event.actor.kind !== "agent" || event.actor.agentId !== input.actorId))
    ) {
      throw new Error("Workspace outbox event actor must equal the committed receipt actor");
    }
  });
  return batchIdempotencyKey;
}

const workspaceOperationLockBrand: unique symbol = Symbol(
  "workspaceDocumentMutationOperationLock",
);
export type WorkspaceDocumentMutationOperationLock = {
  readonly operationId: string;
  readonly [workspaceOperationLockBrand]: WorkspaceDocumentMutationTx;
};

function assertOperationLockTransaction(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
): void {
  if (lock[workspaceOperationLockBrand] !== tx) {
    throw new Error("Workspace operation lock belongs to a different transaction");
  }
}

/**
 * Acquires the operation-scoped transaction lock required by both lookup and
 * insertion. The branded return value makes lock-before-lookup/insert part of
 * the TypeScript contract rather than a comment susceptible to TOCTOU races.
 */
export async function acquireWorkspaceDocumentMutationOperationLock(
  tx: WorkspaceDocumentMutationTx,
  operationId: string,
): Promise<WorkspaceDocumentMutationOperationLock> {
  if (operationId.trim().length === 0) throw new Error("Workspace operation id must be nonempty");
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`workspace-document-mutation-operation:${operationId}`}::text, 0)
    )
  `);
  return Object.freeze({
    operationId,
    [workspaceOperationLockBrand]: tx,
  });
}

/**
 * Read the minimal durable receipt facts needed to recover a lost response.
 * The caller must independently revalidate current authority; unlike the
 * idempotency lookup this intentionally has no recomputed plan digest.
 */
export async function findWorkspaceDocumentMutationForRecovery(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
): Promise<{
  readonly mutation: WorkspaceDocumentMutation;
  readonly revisionIds: readonly (readonly [string, ...string[]])[];
  readonly artifactInternalIds: readonly string[];
  readonly outputArtifactIds: readonly (string | null)[];
  readonly historyOperations: readonly (string | null)[];
  readonly entryIds: readonly string[];
  readonly restoreFromEntryIds: readonly (string | null)[];
  readonly logicalPaths: readonly (string | null)[];
  readonly postimages: readonly (Readonly<{
    revision: number;
    sha256: string;
    size: number;
    storageUri: string;
  }> | null)[];
} | null> {
  assertOperationLockTransaction(tx, lock);
  const [mutation] = await tx
    .select()
    .from(workspaceDocumentMutations)
    .where(eq(workspaceDocumentMutations.operationId, lock.operationId))
    .limit(1);
  if (!mutation) return null;
  const entries = await tx
    .select()
    .from(workspaceDocumentMutationEntries)
    .where(eq(workspaceDocumentMutationEntries.mutationId, mutation.id))
    .orderBy(
      asc(workspaceDocumentMutationEntries.sequence),
      asc(workspaceDocumentMutationEntries.id),
    );
  if (entries.length === 0) {
    throw new Error("Committed Workspace mutation is missing durable receipt entries");
  }
  assertContiguousOrderedSequences(entries, "Persisted Workspace mutation entries");
  const identities = await tx
    .select()
    .from(workspaceDocumentMutationEntryIdentities)
    .where(inArray(
      workspaceDocumentMutationEntryIdentities.mutationEntryId,
      entries.map((entry) => entry.id),
    ));
  const revisionIds = entries.map((entry) => {
    const values = identities
      .filter((identity) =>
        identity.mutationEntryId === entry.id && identity.kind === "revision")
      .sort((left, right) => left.sequence - right.sequence)
      .map((identity) => identity.value);
    if (values.length === 0) {
      throw new Error("Committed Workspace entry is missing revision ids");
    }
    return values as [string, ...string[]];
  });
  return {
    mutation,
    revisionIds,
    artifactInternalIds: entries.map((entry) => entry.artifactInternalId),
    outputArtifactIds: entries.map((entry) =>
      entry.mutationKind === "delete" ? null : entry.artifactInternalId),
    historyOperations: entries.map((entry) => entry.historyOperation),
    entryIds: entries.map((entry) => entry.id),
    restoreFromEntryIds: entries.map((entry) => entry.restoreFromEntryId),
    logicalPaths: entries.map((entry) =>
      entry.afterLogicalPath ?? entry.beforeLogicalPath
    ),
    postimages: entries.map((entry) =>
      entry.afterRevision === null ||
        entry.afterSha256 === null ||
        entry.afterSize === null ||
        entry.afterStorageUri === null
        ? null
        : {
            revision: entry.afterRevision,
            sha256: entry.afterSha256,
            size: entry.afterSize,
            storageUri: entry.afterStorageUri,
          }
    ),
  };
}

/**
 * Operation-id idempotency lookup after acquiring the exact operation lock.
 * A reused id is usable only when its canonical request digest is equal.
 */
export async function findWorkspaceDocumentMutationForIdempotency(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
  requestDigest: string,
): Promise<
  | { readonly kind: "absent" }
  | {
      readonly kind: "match";
      readonly mutation: WorkspaceDocumentMutation;
      readonly replay: WorkspaceDocumentMutationCommitReplay;
    }
  | { readonly kind: "digest_mismatch"; readonly mutation: WorkspaceDocumentMutation }
> {
  assertOperationLockTransaction(tx, lock);
  const [mutation] = await tx
    .select()
    .from(workspaceDocumentMutations)
    .where(eq(workspaceDocumentMutations.operationId, lock.operationId))
    .limit(1);
  if (!mutation) return { kind: "absent" };
  if (mutation.actorKind !== "human" && mutation.actorKind !== "agent") {
    throw new Error("Committed Workspace mutation has an invalid persisted actor kind");
  }
  if (mutation.requestDigest !== requestDigest) {
    return { kind: "digest_mismatch", mutation };
  }
  const entries = await tx
    .select()
    .from(workspaceDocumentMutationEntries)
    .where(eq(workspaceDocumentMutationEntries.mutationId, mutation.id))
    .orderBy(asc(workspaceDocumentMutationEntries.sequence));
  if (entries.length === 0) {
    throw new Error("Committed Workspace mutation is missing durable receipt entries");
  }
  assertContiguousOrderedSequences(entries, "Persisted Workspace mutation entries");

  const identities = await tx
    .select()
    .from(workspaceDocumentMutationEntryIdentities)
    .where(inArray(
      workspaceDocumentMutationEntryIdentities.mutationEntryId,
      entries.map((entry) => entry.id),
    ));
  const outbox = await tx
    .select()
    .from(workspaceDocumentMutationOutbox)
    .where(eq(workspaceDocumentMutationOutbox.mutationId, mutation.id))
    .orderBy(asc(workspaceDocumentMutationOutbox.sequence));
  if (outbox.length !== entries.length) {
    throw new Error("Committed Workspace mutation has an incomplete durable event batch");
  }
  assertContiguousOrderedSequences(outbox, "Persisted Workspace mutation events");
  if (!mutation.outboxBatchIdempotencyKey) {
    throw new Error("Committed Workspace mutation is missing its batch idempotency key");
  }
  const expectedBatchIdempotencyKey =
    `document-mutation:v1:${JSON.stringify([mutation.operationId, mutation.revisionGroupId])}`;
  if (mutation.outboxBatchIdempotencyKey !== expectedBatchIdempotencyKey) {
    throw new Error("Committed Workspace mutation has a noncanonical batch idempotency key");
  }

  const receiptEntries = entries.map((entry): WorkspaceCommittedEntryReplay => {
    const idsFor = (kind: "revision" | "undo_record"): [string, ...string[]] => {
      const values = identities
        .filter((identity) =>
          identity.mutationEntryId === entry.id && identity.kind === kind)
        .sort((a, b) => a.sequence - b.sequence);
      assertContiguousOrderedSequences(values, `Persisted ${kind} ids`);
      if (values.length === 0) {
        throw new Error(`Committed Workspace entry is missing ${kind} ids`);
      }
      return values.map((identity) => identity.value) as [string, ...string[]];
    };
    const revisionIds = idsFor("revision");
    const undoRecordIds = idsFor("undo_record");
    const input: WorkspaceMutationReceiptEntryInput = {
      sequence: entry.sequence,
      kind: entry.mutationKind as WorkspaceMutationReceiptEntryInput["kind"],
      revisionIds,
      undoRecordIds,
      artifactInternalId: entry.artifactInternalId,
      beforeLogicalPath: entry.beforeLogicalPath,
      afterLogicalPath: entry.afterLogicalPath,
      beforeRevision: entry.beforeRevision,
      afterRevision: entry.afterRevision,
      beforeSha256: entry.beforeSha256,
      afterSha256: entry.afterSha256,
      beforeSize: entry.beforeSize,
      afterSize: entry.afterSize,
      beforeStorageUri: entry.beforeStorageUri,
      afterStorageUri: entry.afterStorageUri,
      beforeMimeType: entry.beforeMimeType,
      afterMimeType: entry.afterMimeType,
      destinationBeforeArtifactInternalId: entry.destinationBeforeArtifactInternalId,
      destinationBeforeLogicalPath: entry.destinationBeforeLogicalPath,
      destinationBeforeRevision: entry.destinationBeforeRevision,
      destinationBeforeSha256: entry.destinationBeforeSha256,
      destinationBeforeSize: entry.destinationBeforeSize,
      destinationBeforeStorageUri: entry.destinationBeforeStorageUri,
      historyOperation: entry.historyOperation,
      historyEligible: entry.historyEligible,
      restoreFromEntryId: entry.restoreFromEntryId,
      checkpoint: entry.checkpoint,
    };
    const event = parseDocumentMutationCommittedEvent(outbox[entry.sequence]!.payload);
    assertWorkspaceCommittedEvent(event);
    assertWorkspaceMutationEntryEventProof(input, event);

    const before = entry.beforeRevision == null ||
        entry.beforeLogicalPath == null ||
        entry.beforeSha256 == null
      ? undefined
      : {
          identity: {
            kind: "workspace_artifact" as const,
            artifactId: entry.artifactInternalId,
            logicalPath: entry.beforeLogicalPath,
          },
          backendVersion: {
            kind: "artifact_revision" as const,
            revision: entry.beforeRevision,
          },
          sha256: entry.beforeSha256,
        };
    const after = entry.afterRevision == null ||
        entry.afterLogicalPath == null ||
        entry.afterSha256 == null
      ? undefined
      : {
          identity: {
            kind: "workspace_artifact" as const,
            artifactId: entry.artifactInternalId,
            logicalPath: entry.afterLogicalPath,
          },
          backendVersion: {
            kind: "artifact_revision" as const,
            revision: entry.afterRevision,
          },
          sha256: entry.afterSha256,
        };
    const destinationBefore = entry.destinationBeforeArtifactInternalId == null ||
        entry.destinationBeforeLogicalPath == null ||
        entry.destinationBeforeRevision == null ||
        entry.destinationBeforeSha256 == null
      ? undefined
      : {
          identity: {
            kind: "workspace_artifact" as const,
            artifactId: entry.destinationBeforeArtifactInternalId,
            logicalPath: entry.destinationBeforeLogicalPath,
          },
          backendVersion: {
            kind: "artifact_revision" as const,
            revision: entry.destinationBeforeRevision,
          },
          sha256: entry.destinationBeforeSha256,
        };
    const base = { entryIndex: entry.sequence, revisionIds, undoRecordIds };
    switch (input.kind) {
      case "create":
        if (!after) throw new Error("Persisted create receipt is missing after version");
        return { ...base, kind: "create", after };
      case "update":
        if (!before || !after) throw new Error("Persisted update receipt is incomplete");
        if ((entry.beforeMimeType === null) !== (entry.afterMimeType === null)) {
          throw new Error("Persisted update MIME transition is incomplete");
        }
        return {
          ...base,
          kind: "update",
          before,
          after,
          ...(entry.beforeMimeType === null ? {} : {
            workspaceArtifactMetadata: {
              beforeMimeType: entry.beforeMimeType,
              afterMimeType: entry.afterMimeType!,
            },
          }),
        };
      case "move":
        if (!before || !after) throw new Error("Persisted move receipt is incomplete");
        return {
          ...base,
          kind: "move",
          before,
          ...(destinationBefore ? { destinationBefore } : {}),
          after,
        };
      case "delete":
        if (!before) throw new Error("Persisted delete receipt is missing before version");
        return { ...base, kind: "delete", before };
    }
  });

  const events = outbox.map((row, sequence) => {
    if (
      row.batchIdempotencyKey !== mutation.outboxBatchIdempotencyKey ||
      row.sequence !== sequence ||
      row.eventType !== "document.mutation.committed"
    ) {
      throw new Error("Committed Workspace mutation outbox correlation is invalid");
    }
    const event = parseDocumentMutationCommittedEvent(row.payload);
    if (
      event.operationId !== mutation.operationId ||
      event.revisionGroupId !== mutation.revisionGroupId ||
      event.sequence !== sequence ||
      (mutation.actorKind === "human" &&
        (event.actor.kind !== "human" || event.actor.humanId !== mutation.actorId)) ||
      (mutation.actorKind === "agent" &&
        (event.actor.kind !== "agent" || event.actor.agentId !== mutation.actorId))
    ) {
      throw new Error("Committed Workspace mutation event correlation is invalid");
    }
    return event;
  });
  assertEditorSaveReceiptCorrelation(
    mutation,
    entries.map((entry) => ({
      kind: entry.mutationKind as WorkspaceMutationReceiptEntryInput["kind"],
      checkpoint: entry.checkpoint,
    })),
    events,
  );
  const replay: WorkspaceDocumentMutationCommitReplay = {
    receipt: {
      backend: "workspace",
      operationId: mutation.operationId,
      revisionGroupId: mutation.revisionGroupId,
      entries: receiptEntries,
    },
    enlistedEventBatch: {
      operationId: mutation.operationId,
      revisionGroupId: mutation.revisionGroupId,
      idempotencyKey: mutation.outboxBatchIdempotencyKey,
      events,
    },
  };
  return { kind: "match", mutation, replay };
}

/**
 * Trusted replay-only receipt validation. Callers must first prove authority
 * and acquire the exact operation lock; this helper then reuses the canonical
 * digest/receipt/outbox validator with the persisted digest rather than
 * exposing an operation-id probe to untrusted input.
 */
export async function findTrustedWorkspaceDocumentMutationReplay(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "match"; readonly mutation: WorkspaceDocumentMutation; readonly replay: WorkspaceDocumentMutationCommitReplay }
> {
  assertOperationLockTransaction(tx, lock);
  const [mutation] = await tx
    .select()
    .from(workspaceDocumentMutations)
    .where(eq(workspaceDocumentMutations.operationId, lock.operationId))
    .limit(1);
  if (!mutation) return { kind: "absent" };
  const validated = await findWorkspaceDocumentMutationForIdempotency(
    tx,
    lock,
    mutation.requestDigest,
  );
  if (validated.kind !== "match") {
    throw new Error("Trusted Workspace replay receipt did not validate against its stored digest");
  }
  return validated;
}

/**
 * Internal-only recovery of one pre-reserved Writer editor save. The caller
 * obtains the opaque operation/client ids exclusively from the exact durable
 * Task marker; this helper must never back an HTTP receipt probe.
 */
export async function findWorkspaceEditorSaveForWriterReviewRecovery(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
  input: { readonly clientMutationId: string; readonly actorId: string; readonly artifactInternalId: string },
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "match"; readonly revision: number; readonly sha256: string }
> {
  const trusted = await findTrustedWorkspaceDocumentMutationReplay(tx, lock);
  if (trusted.kind === "absent") return trusted;
  const { mutation, replay } = trusted;
  const [entry] = replay.receipt.entries;
  if (
    mutation.actorKind !== "human" ||
    mutation.actorId !== input.actorId ||
    mutation.lane !== "editor_save" ||
    mutation.clientMutationId !== input.clientMutationId ||
    mutation.requestId !== null ||
    replay.receipt.entries.length !== 1 ||
    !entry ||
    entry.kind !== "update" ||
    entry.after.identity.kind !== "workspace_artifact" ||
    entry.after.identity.artifactId !== input.artifactInternalId ||
    entry.after.backendVersion.kind !== "artifact_revision"
  ) return { kind: "invalid" };
  return {
    kind: "match",
    revision: entry.after.backendVersion.revision,
    sha256: entry.after.sha256,
  };
}

/**
 * Serializes mutations for one authoritative artifact identity for the life
 * of the caller transaction. The UUID is not client input at this layer.
 */
export async function acquireWorkspaceArtifactMutationLock(
  tx: WorkspaceDocumentMutationTx,
  artifactInternalId: string,
): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`workspace-artifact-mutation:${artifactInternalId}`}::text, 0)
    )
  `);
}

/**
 * Conditional pointer/revision transition. The caller must have verified
 * the current bytes against `expectedSha256` before calling; artifacts does
 * not currently store a SHA column, so this helper refuses to proceed unless
 * the verifier reports the same digest. No unconditional bump is exposed.
 */
export async function casWorkspaceArtifactContentPointer(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly artifactInternalId: string;
    readonly expectedRevision: number;
    readonly expectedStorageUri: string;
    readonly expectedSha256: string;
    readonly callerVerifiedSha256: string;
    readonly nextStorageUri: string;
    readonly nextSize: number;
    readonly nextLogicalPath?: string;
    readonly nextMimeType?: string;
  },
): Promise<Artifact | null> {
  // This is a representation-safety check, not a product size ceiling.
  // Every exactly representable nonnegative byte count is accepted.
  if (!Number.isSafeInteger(input.nextSize) || input.nextSize < 0) {
    throw new Error("Workspace artifact CAS size must be a finite safe nonnegative integer");
  }
  if (
    input.expectedStorageUri.trim().length === 0 ||
    input.nextStorageUri.trim().length === 0
  ) {
    throw new Error("Workspace artifact CAS storage URIs must be nonempty");
  }
  if (input.expectedSha256 !== input.callerVerifiedSha256) {
    throw new Error("Workspace artifact CAS requires caller-verified expected SHA-256");
  }
  const [updated] = await tx
    .update(artifacts)
    .set({
      storageUri: input.nextStorageUri,
      size: input.nextSize,
      ...(input.nextLogicalPath === undefined ? {} : { path: input.nextLogicalPath }),
      ...(input.nextMimeType === undefined ? {} : { mimeType: input.nextMimeType }),
      revision: sql`${artifacts.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, input.artifactInternalId),
      ordinaryArtifactRowPredicate(),
      eq(artifacts.revision, input.expectedRevision),
      eq(artifacts.storageUri, input.expectedStorageUri),
      isNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * Creates one authoritative Workspace artifact and its Namespace attachment
 * inside the caller's mutation transaction. The caller must hold the current
 * Room authority lock that proves `namespaceId` and must have rechecked path
 * vacancy before invoking this helper.
 */
export async function createWorkspaceArtifactForMutation(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly internalId: string;
    readonly artifactId: string;
    readonly logicalPath: string;
    readonly storageUri: string;
    readonly size: number;
    readonly mimeType: string;
    readonly namespaceId: string;
  },
): Promise<Artifact> {
  if (
    input.internalId.trim().length === 0 ||
    input.artifactId.trim().length === 0 ||
    input.logicalPath.trim().length === 0 ||
    input.storageUri.trim().length === 0 ||
    input.mimeType.trim().length === 0 ||
    input.namespaceId.trim().length === 0
  ) {
    throw new Error("Workspace artifact create fields must be nonempty");
  }
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new Error("Workspace artifact create size must be a finite safe nonnegative integer");
  }
  const [created] = await tx
    .insert(artifacts)
    .values({
      id: input.internalId,
      artifactId: input.artifactId,
      path: input.logicalPath,
      storageUri: input.storageUri,
      size: input.size,
      mimeType: input.mimeType,
    })
    .returning();
  if (!created) throw new Error("Workspace artifact create returned no row");
  await tx.insert(artifactNamespaces).values({
    artifactId: created.id,
    namespaceId: input.namespaceId,
  });
  const legacy = legacyArtifact(created);
  if (legacy === null) throw new Error("Workspace artifact create returned no row");
  return legacy;
}

/** Exact canonical-history restore of one soft-deleted artifact row. */
export async function casRestoreDeletedWorkspaceArtifactForMutation(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly artifactInternalId: string;
    readonly expectedRevision: number;
    readonly expectedStorageUri: string;
    readonly expectedSha256: string;
    readonly callerVerifiedSha256: string;
    readonly nextStorageUri: string;
    readonly nextSize: number;
    readonly nextLogicalPath: string;
    readonly nextMimeType: string;
  },
): Promise<Artifact | null> {
  if (
    input.expectedSha256 !== input.callerVerifiedSha256 ||
    !input.expectedStorageUri ||
    !input.nextStorageUri ||
    !input.nextLogicalPath ||
    !input.nextMimeType
  ) {
    throw new Error("Workspace deleted restore requires exact nonempty evidence");
  }
  const [updated] = await tx
    .update(artifacts)
    .set({
      deletedAt: null,
      storageUri: input.nextStorageUri,
      size: input.nextSize,
      path: input.nextLogicalPath,
      mimeType: input.nextMimeType,
      revision: sql`${artifacts.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(artifacts.id, input.artifactInternalId),
      ordinaryArtifactRowPredicate(),
      eq(artifacts.revision, input.expectedRevision),
      eq(artifacts.storageUri, input.expectedStorageUri),
      isNotNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * Exact soft-delete transition for the mutation coordinator. Pointer identity,
 * revision, and caller-verified bytes are all required; ordinary artifact
 * delete helpers remain unchanged.
 */
export async function casDeleteWorkspaceArtifactForMutation(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly artifactInternalId: string;
    readonly expectedRevision: number;
    readonly expectedStorageUri: string;
    readonly expectedSha256: string;
    readonly callerVerifiedSha256: string;
  },
): Promise<Artifact | null> {
  if (
    input.artifactInternalId.trim().length === 0 ||
    input.expectedStorageUri.trim().length === 0
  ) {
    throw new Error("Workspace artifact delete identity must be nonempty");
  }
  if (input.expectedSha256 !== input.callerVerifiedSha256) {
    throw new Error("Workspace artifact delete requires caller-verified expected SHA-256");
  }
  const now = new Date();
  const [updated] = await tx
    .update(artifacts)
    .set({
      deletedAt: now,
      revision: sql`${artifacts.revision} + 1`,
      updatedAt: now,
    })
    .where(and(
      eq(artifacts.id, input.artifactInternalId),
      ordinaryArtifactRowPredicate(),
      eq(artifacts.revision, input.expectedRevision),
      eq(artifacts.storageUri, input.expectedStorageUri),
      isNull(artifacts.deletedAt),
    ))
    .returning();
  return legacyArtifact(updated);
}

/**
 * Inserts a complete durable receipt within the caller's transaction.
 * If the transaction rolls back, header, entries, and outbox all roll back.
 */
export async function insertWorkspaceDocumentMutationReceipt(
  tx: WorkspaceDocumentMutationTx,
  lock: WorkspaceDocumentMutationOperationLock,
  input: InsertWorkspaceDocumentMutationInput,
): Promise<{
  readonly mutation: WorkspaceDocumentMutation;
  readonly entries: readonly WorkspaceDocumentMutationEntry[];
  readonly identities: readonly WorkspaceDocumentMutationEntryIdentity[];
  readonly outbox: readonly WorkspaceDocumentMutationOutboxRow[];
}> {
  assertOperationLockTransaction(tx, lock);
  if (lock.operationId !== input.operationId) {
    throw new Error("Workspace operation lock does not match committed receipt operation");
  }
  const batchIdempotencyKey = assertExactCommittedReceipt(input);
  const [mutation] = await tx
    .insert(workspaceDocumentMutations)
    .values({
      operationId: input.operationId,
      requestDigest: input.requestDigest,
      revisionGroupId: input.revisionGroupId,
      ownerId: input.ownerId,
      userId: input.userId,
      agentId: input.agentId,
      roomId: input.roomId,
      actorKind: input.actorKind,
      actorId: input.actorId,
      lane: input.lane,
      clientMutationId: input.clientMutationId,
      requestId: input.requestId,
      turnId: input.turnId,
      editorRequestFingerprint: input.editorRequestFingerprint,
      pinned: input.pinned,
      outboxBatchIdempotencyKey: batchIdempotencyKey,
    })
    .returning();
  if (!mutation) throw new Error("Workspace mutation header insert returned no row");

  const entries = await tx
    .insert(workspaceDocumentMutationEntries)
    .values(input.entries.map((entry) => {
      const {
        revisionIds: _revisionIds,
        undoRecordIds: _undoRecordIds,
        kind,
        historyOperation,
        historyEligible,
        ...row
      } = entry;
      return {
        ...row,
        mutationKind: kind,
        mutationId: mutation.id,
        historyOperation: historyOperation ?? input.lane,
        historyEligible:
          historyEligible ?? (input.actorKind === "agent" || entry.checkpoint),
      };
    }))
    .returning();
  const entriesBySequence = new Map(entries.map((entry) => [entry.sequence, entry]));
  const identityValues = input.entries.flatMap((entry) => {
    const stored = entriesBySequence.get(entry.sequence);
    if (!stored) throw new Error("Workspace mutation entry insert omitted a receipt row");
    return [
      ...entry.revisionIds.map((value, sequence) => ({
        mutationEntryId: stored.id,
        kind: "revision" as const,
        sequence,
        value,
      })),
      ...entry.undoRecordIds.map((value, sequence) => ({
        mutationEntryId: stored.id,
        kind: "undo_record" as const,
        sequence,
        value,
      })),
    ];
  });
  const identities = await tx
    .insert(workspaceDocumentMutationEntryIdentities)
    .values(identityValues)
    .returning();
  const outbox = await tx
    .insert(workspaceDocumentMutationOutbox)
    .values(input.eventBatch.events.map((event, sequence) => ({
      mutationId: mutation.id,
      sequence,
      batchIdempotencyKey,
      eventType: event.type,
      payload: event,
    })))
    .returning();

  return { mutation, entries, identities, outbox };
}

/**
 * Claims every currently dispatchable event in the oldest available batch.
 * There is intentionally no batch-size cap: a committed mutation's event
 * sequence is an atomic durable truth, not a lossy notification ring.
 */
export async function claimNextWorkspaceDocumentMutationOutboxBatch(
  tx: WorkspaceDocumentMutationTx,
  input: { readonly workerId: string; readonly now: Date },
): Promise<readonly WorkspaceDocumentMutationOutboxRow[]> {
  const [candidate] = await tx
    .select({ batchIdempotencyKey: workspaceDocumentMutationOutbox.batchIdempotencyKey })
    .from(workspaceDocumentMutationOutbox)
    .where(and(
      eq(workspaceDocumentMutationOutbox.dispatchState, "pending"),
      lte(workspaceDocumentMutationOutbox.nextAttemptAt, input.now),
    ))
    .orderBy(asc(workspaceDocumentMutationOutbox.createdAt), asc(workspaceDocumentMutationOutbox.sequence))
    .limit(1);
  if (!candidate) return [];

  // Deliberately take NO row lock before the batch advisory lock. Two workers
  // that select different rows from one batch must not each hold a row while
  // waiting for this same advisory lock: that would either deadlock or make a
  // later SKIP LOCKED re-read split the batch. After this lock, same-function
  // workers cannot hold this batch's rows, so the complete re-read is safe.
  await acquireWorkspaceOutboxBatchLock(tx, candidate.batchIdempotencyKey);

  const rows = await tx
    .select()
    .from(workspaceDocumentMutationOutbox)
    .where(and(
      eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, candidate.batchIdempotencyKey),
      eq(workspaceDocumentMutationOutbox.dispatchState, "pending"),
    ))
    .orderBy(asc(workspaceDocumentMutationOutbox.sequence))
    .for("update");
  // Preserve ordering and avoid publishing the latter half of a backoff
  // batch ahead of its first retryable event.
  if (rows.length === 0 || rows.some((row) => row.nextAttemptAt > input.now)) return [];

  const ids = rows.map((row) => row.id);
  await tx
    .update(workspaceDocumentMutationOutbox)
    .set({
      dispatchState: "claimed",
      claimedBy: input.workerId,
      claimedAt: input.now,
      dispatchAttempts: sql`${workspaceDocumentMutationOutbox.dispatchAttempts} + 1`,
      updatedAt: input.now,
    })
    .where(inArray(workspaceDocumentMutationOutbox.id, ids));
  return tx
    .select()
    .from(workspaceDocumentMutationOutbox)
    .where(and(
      eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, candidate.batchIdempotencyKey),
      eq(workspaceDocumentMutationOutbox.dispatchState, "claimed"),
      eq(workspaceDocumentMutationOutbox.claimedBy, input.workerId),
    ))
    .orderBy(asc(workspaceDocumentMutationOutbox.sequence));
}

async function acquireWorkspaceOutboxBatchLock(
  tx: WorkspaceDocumentMutationTx,
  batchIdempotencyKey: string,
): Promise<void> {
  await tx.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`workspace-document-mutation-outbox:${batchIdempotencyKey}`}::text, 0)
    )
  `);
}

async function lockWorkspaceOutboxBatch(
  tx: WorkspaceDocumentMutationTx,
  batchIdempotencyKey: string,
): Promise<readonly WorkspaceDocumentMutationOutboxRow[]> {
  await acquireWorkspaceOutboxBatchLock(tx, batchIdempotencyKey);
  return tx
    .select()
    .from(workspaceDocumentMutationOutbox)
    .where(eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, batchIdempotencyKey))
    .orderBy(asc(workspaceDocumentMutationOutbox.sequence))
    .for("update");
}

function assertWholeBatchOwned(
  rows: readonly WorkspaceDocumentMutationOutboxRow[],
  workerId: string,
): void {
  if (rows.some((row) => row.dispatchState !== "claimed" || row.claimedBy !== workerId)) {
    throw new Error("Workspace outbox batch is not wholly claimed by this worker");
  }
}

/**
 * Finalizes the entire claimed batch or nothing. Publication is at-least-once:
 * if a process publishes part of a batch and crashes, the whole batch retries,
 * and each event's durable idempotency key lets consumers discard duplicates.
 */
export async function markWorkspaceDocumentMutationOutboxDispatched(
  tx: WorkspaceDocumentMutationTx,
  input: { readonly workerId: string; readonly batchIdempotencyKey: string; readonly now: Date },
): Promise<number> {
  const batch = await lockWorkspaceOutboxBatch(tx, input.batchIdempotencyKey);
  if (batch.length === 0 || batch.every((row) => row.dispatchState === "dispatched")) return 0;
  assertWholeBatchOwned(batch, input.workerId);
  const rows = await tx
    .update(workspaceDocumentMutationOutbox)
    .set({
      dispatchState: "dispatched",
      dispatchedAt: input.now,
      claimedBy: null,
      claimedAt: null,
      lastError: null,
      updatedAt: input.now,
    })
    .where(and(
      eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, input.batchIdempotencyKey),
      eq(workspaceDocumentMutationOutbox.dispatchState, "claimed"),
      eq(workspaceDocumentMutationOutbox.claimedBy, input.workerId),
    ))
    .returning({ id: workspaceDocumentMutationOutbox.id });
  return rows.length;
}

/**
 * Releases the whole batch this worker owns back to retryable pending state.
 * The next attempt is caller-scheduled; no hidden retry-count ceiling exists.
 */
export async function markWorkspaceDocumentMutationOutboxFailed(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly workerId: string;
    readonly batchIdempotencyKey: string;
    readonly now: Date;
    readonly nextAttemptAt: Date;
    readonly error: string;
  },
): Promise<number> {
  const batch = await lockWorkspaceOutboxBatch(tx, input.batchIdempotencyKey);
  if (batch.length === 0 || batch.every((row) => row.dispatchState === "pending")) return 0;
  assertWholeBatchOwned(batch, input.workerId);
  const rows = await tx
    .update(workspaceDocumentMutationOutbox)
    .set({
      dispatchState: "pending",
      claimedBy: null,
      claimedAt: null,
      nextAttemptAt: input.nextAttemptAt,
      lastError: input.error,
      updatedAt: input.now,
    })
    .where(and(
      eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, input.batchIdempotencyKey),
      eq(workspaceDocumentMutationOutbox.dispatchState, "claimed"),
      eq(workspaceDocumentMutationOutbox.claimedBy, input.workerId),
    ))
    .returning({ id: workspaceDocumentMutationOutbox.id });
  return rows.length;
}

/** Restart recovery for workers that died while holding a lease. */
export async function releaseStaleWorkspaceDocumentMutationOutboxClaims(
  tx: WorkspaceDocumentMutationTx,
  input: {
    readonly batchIdempotencyKey: string;
    readonly claimedBefore: Date;
    readonly now: Date;
  },
): Promise<number> {
  const batch = await lockWorkspaceOutboxBatch(tx, input.batchIdempotencyKey);
  if (batch.length === 0 || batch.every((row) => row.dispatchState !== "claimed")) return 0;
  if (batch.some((row) => row.dispatchState !== "claimed")) {
    throw new Error("Workspace outbox batch is not wholly stale and claimed");
  }
  if (batch.some((row) => row.claimedAt === null)) {
    throw new Error("Workspace outbox claimed batch is missing lease evidence");
  }
  // A competing recovery worker may have released and a live worker may have
  // reclaimed the complete batch after discovery. That is a safe no-op, not
  // corruption. A partly fresh batch remains an invalid split lease.
  if (batch.every((row) => row.claimedAt! > input.claimedBefore)) return 0;
  if (batch.some((row) => row.claimedAt! > input.claimedBefore)) {
    throw new Error("Workspace outbox batch mixes stale and fresh claims");
  }
  const rows = await tx
    .update(workspaceDocumentMutationOutbox)
    .set({
      dispatchState: "pending",
      claimedBy: null,
      claimedAt: null,
      nextAttemptAt: input.now,
      updatedAt: input.now,
    })
    .where(and(
      eq(workspaceDocumentMutationOutbox.batchIdempotencyKey, input.batchIdempotencyKey),
      eq(workspaceDocumentMutationOutbox.dispatchState, "claimed"),
      isNotNull(workspaceDocumentMutationOutbox.claimedAt),
      lte(workspaceDocumentMutationOutbox.claimedAt, input.claimedBefore),
    ))
    .returning({ id: workspaceDocumentMutationOutbox.id });
  return rows.length;
}

/**
 * Discovers every wholly stale claimed batch after a worker restart.
 *
 * This intentionally has no LIMIT: a durable committed-event batch must not
 * become permanently invisible because more than an arbitrary number of
 * workers died. `bool_and` excludes mixed, partially claimed, and partly fresh
 * batches. Callers must still use the exact per-batch release helper, which
 * locks and revalidates the batch to close the discovery/release race.
 */
export async function listStaleWorkspaceDocumentMutationOutboxBatchKeys(
  tx: WorkspaceDocumentMutationTx,
  claimedBefore: Date,
): Promise<readonly string[]> {
  if (!Number.isFinite(claimedBefore.getTime())) {
    throw new Error("Workspace outbox stale-claim cutoff must be a valid date");
  }
  const rows = await tx
    .select({
      batchIdempotencyKey:
        workspaceDocumentMutationOutbox.batchIdempotencyKey,
    })
    .from(workspaceDocumentMutationOutbox)
    .groupBy(workspaceDocumentMutationOutbox.batchIdempotencyKey)
    .having(sql`
      bool_and(${workspaceDocumentMutationOutbox.dispatchState} = 'claimed')
      and bool_and(
        ${workspaceDocumentMutationOutbox.claimedAt} is not null
        and ${workspaceDocumentMutationOutbox.claimedAt} <= ${claimedBefore.toISOString()}::timestamptz
      )
    `)
    .orderBy(asc(workspaceDocumentMutationOutbox.batchIdempotencyKey));
  return rows.map((row) => row.batchIdempotencyKey);
}
