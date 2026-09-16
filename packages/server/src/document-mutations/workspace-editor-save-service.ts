/**
 * D448 Phase 8.2 — one authoritative adapter for the two pre-existing
 * Workspace editor HTTP surfaces.  The routes retain their wire contracts;
 * this module constructs a single human editor plan and hands it to the
 * coordinator/Workspace backend.  It deliberately does not call the former
 * byte-write, revision, patch-cache, or patch-event helpers.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPatch } from "diff";
import {
  acquireWorkspaceDocumentMutationOperationLock,
  asc,
  eq,
  findArtifactByInternalIdForNamespaces,
  findTrustedWorkspaceDocumentMutationReplay,
  lockWorkspaceArtifactForCurrentRoomAuthority,
  type Artifact,
  type DirectDatabase,
  type WorkspaceDocumentMutationTx,
  workspaceDocumentMutationEntries,
} from "@nautilo/db";
import {
  createDocumentMutationCoordinator,
  type DocumentLockManager,
  type DocumentMutationCoordinator,
} from "@nautilo/document-mutations";
import {
  applyAnchoredTextPatch,
  type AnchoredTextPatch,
  type DocumentPatchApplied,
  type DocumentPatchRejected,
  type DocumentMutationCommittedEvent,
  type DocumentVersion,
  type WorkspaceDocumentVersion,
} from "@nautilo/types";
import {
  envelopeMutableNamespaces,
  envelopeReadableNamespaces,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { USER_SAVE_TEXT_LIMIT_BYTES } from "@nautilo/agent";
import { WorkspaceArtifactMutationBackend, type AuthorizedWorkspaceArtifact } from "./workspace-artifact-mutation-backend";
import { getServerDirectDb } from "../lib/server-direct-db";
import { workspaceDocumentMutationLockManager } from "./workspace-document-mutation-lock-manager";

export type WorkspaceEditorSaveAuthority = {
  readonly envelope: MemoryAccessEnvelope;
  readonly sessionUserId?: string;
  readonly artifact: Artifact;
  /** Parsed at the route boundary; omitted means retain the live row MIME. */
  readonly mimeType?: string;
  /** Internal server-computed request semantic digest; never accepted raw. */
  readonly editorRequestFingerprint?: string;
};

export type WorkspaceEditorSnapshotSaveInput = WorkspaceEditorSaveAuthority & {
  readonly newText: string;
  readonly baseRevision: number | null;
  readonly baseSha256: string | null;
  readonly checkpoint: boolean;
  readonly clientMutationId?: string;
};

export type WorkspaceEditorPatchSaveInput = WorkspaceEditorSaveAuthority & {
  readonly requestId: string;
  readonly baseRevision: number | null;
  readonly baseSha256: string;
  readonly patch: AnchoredTextPatch;
  readonly checkpoint: boolean;
  readonly clientMutationId?: string;
};

type WorkspaceEditorResolvedAuthority = WorkspaceEditorSaveAuthority & {
  readonly clientMutationId?: string;
  readonly requestId?: string;
};

export type WorkspaceEditorRecoveryRequired = {
  readonly ok: false;
  readonly code: "recovery_required";
  readonly retryable: true;
  readonly message: string;
};

export type WorkspaceEditorSnapshotSaveResult =
  | { readonly ok: true; readonly revision: number; readonly size: number; readonly sha256: string }
  | { readonly ok: false; readonly code: "conflict"; readonly currentSha256: string | null }
  | { readonly ok: false; readonly code: "not_found" | "forbidden" | "too_large" | "error"; readonly message: string }
  | WorkspaceEditorRecoveryRequired;

export type WorkspaceEditorPatchSaveResult =
  | { readonly ok: true; readonly applied: DocumentPatchApplied }
  | { readonly ok: false; readonly rejection: DocumentPatchRejected }
  | { readonly ok: false; readonly code: "not_found"; readonly message: string }
  | WorkspaceEditorRecoveryRequired;

export type WorkspaceEditorSaveServiceDependencies = {
  readonly db?: DirectDatabase;
  readonly lockManager?: DocumentLockManager;
  readonly newOpaqueId?: () => string;
  readonly onCommitted?: () => void;
  /** Hermetic test seam; production always performs the trusted DB lookup. */
  readonly lookupReplay?: (input: WorkspaceEditorReplayLookupInput) => Promise<WorkspaceEditorReplayLookup>;
  /** Hermetic test seam; production always executes the real coordinator. */
  readonly executeCoordinator?: DocumentMutationCoordinator["execute"];
};

export type WorkspaceEditorReplayLookupInput = {
  readonly authority: WorkspaceEditorSaveAuthority;
  readonly operationId: string;
  readonly correlation: { readonly requestId?: string; readonly clientMutationId?: string };
};

export type WorkspaceEditorReplayLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "replay";
      readonly event: Extract<DocumentMutationCommittedEvent, { mutation: "update" }>;
      readonly beforeStorageUri: string;
      readonly beforeSize: number;
      readonly afterStorageUri: string;
      readonly afterSize: number;
    };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const RECOVERY_REQUIRED_MESSAGE =
  "Mutation outcome requires recovery. Retry with identical requestId and clientMutationId values, including any omitted value.";

function recoveryRequired(): WorkspaceEditorRecoveryRequired {
  return {
    ok: false,
    code: "recovery_required",
    retryable: true,
    message: RECOVERY_REQUIRED_MESSAGE,
  };
}

function anchoredPatchEquals(
  left: AnchoredTextPatch | undefined,
  right: AnchoredTextPatch | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.kind === right.kind &&
    left.oldString === right.oldString &&
    left.newString === right.newString &&
    left.replaceAll === right.replaceAll &&
    left.scope?.from === right.scope?.from &&
    left.scope?.to === right.scope?.to
  );
}

function replayEventMatchesAuthority(
  event: Extract<DocumentMutationCommittedEvent, { mutation: "update" }>,
  input: WorkspaceEditorSaveAuthority,
): boolean {
  return (
    event.actor.kind === "human" &&
    event.actor.humanId === humanId(input) &&
    event.before.identity.kind === "workspace_artifact" &&
    event.after.identity.kind === "workspace_artifact" &&
    event.before.identity.artifactId === input.artifact.id &&
    event.after.identity.artifactId === input.artifact.id &&
    event.before.identity.logicalPath === input.artifact.path &&
    event.after.identity.logicalPath === input.artifact.path
  );
}

function storagePathFromUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const path = storageUri.slice("file://".length);
  return path.startsWith("/") ? path : null;
}

async function readArtifactBytes(row: Artifact): Promise<Uint8Array> {
  const path = storagePathFromUri(row.storageUri);
  if (!path) throw new Error(`Artifact ${row.artifactId} has unrecognized storage_uri scheme`);
  return readFile(path);
}

async function readStorageBytes(storageUri: string): Promise<Uint8Array> {
  const path = storagePathFromUri(storageUri);
  if (!path) throw new Error("Workspace mutation receipt has an unrecognized storage_uri scheme");
  return readFile(path);
}

function versionFor(row: Artifact, bytes: Uint8Array): WorkspaceDocumentVersion {
  const identity = {
    kind: "workspace_artifact" as const,
    artifactId: row.id,
    logicalPath: row.path,
  };
  return {
    identity,
    backendVersion: { kind: "artifact_revision", revision: row.revision },
    sha256: sha256Hex(bytes),
  };
}

function currentConflict(bytes: Uint8Array): WorkspaceEditorSnapshotSaveResult {
  return { ok: false, code: "conflict", currentSha256: sha256Hex(bytes) };
}

/**
 * A commit-time authority failure must preserve the initial route admission's
 * public contract. We re-run only the normal Namespace-gated lookups: still
 * readable but no longer mutable is forbidden; otherwise it is indistinguish-
 * able from a missing/deleted artifact. This never exposes the backend's
 * internal failed-recheck reason to a caller without readable authority.
 */
async function reclassifyAuthorityLoss(
  input: WorkspaceEditorSaveAuthority,
  dependencies: WorkspaceEditorSaveServiceDependencies,
): Promise<"forbidden" | "not_found" | "unknown"> {
  try {
    const db = dependencies.db;
    const mutable = await findArtifactByInternalIdForNamespaces({
      internalId: input.artifact.id,
      readableNamespaceIds: envelopeMutableNamespaces(input.envelope),
    }, db);
    if (mutable) return "unknown";
    const readable = await findArtifactByInternalIdForNamespaces({
      internalId: input.artifact.id,
      readableNamespaceIds: envelopeReadableNamespaces(input.envelope),
    }, db);
    return readable ? "forbidden" : "not_found";
  } catch {
    return "unknown";
  }
}

function isBackendAuthorityFailure(
  outcome: Awaited<ReturnType<DocumentMutationCoordinator["execute"]>>,
): boolean {
  return outcome.kind === "rejected" && outcome.result.kind === "failed" &&
    (outcome.result.code === "backend_failure" || outcome.result.code === "backend_unavailable");
}

function exactBaseMatches(input: {
  readonly row: Artifact;
  readonly bytes: Uint8Array;
  readonly baseRevision: number | null;
  readonly baseSha256: string | null;
}): boolean {
  if (input.baseRevision !== null && input.baseRevision !== input.row.revision) return false;
  return input.baseSha256 === null || input.baseSha256 === sha256Hex(input.bytes);
}

function asAuthorizedArtifact(row: Artifact): AuthorizedWorkspaceArtifact {
  return {
    id: row.id,
    logicalPath: row.path,
    storageUri: row.storageUri,
    revision: row.revision,
    size: row.size ?? 0,
    mimeType: row.mimeType ?? "application/octet-stream",
  };
}

function humanId(input: WorkspaceEditorSaveAuthority): string {
  return input.sessionUserId ?? input.envelope.actorId;
}

function operationId(input: {
  readonly artifactId: string;
  readonly humanId: string;
  readonly correlation?: string;
}): string {
  if (input.correlation === undefined) return `workspace-editor:${randomUUID()}`;
  // Browser correlations are only idempotency material. Hashing a
  // length-delimited canonical tuple keeps the durable key bounded and binds
  // it to trusted actor/artifact scope, so another collaborator cannot replay
  // or poison this actor's operation by reusing the same client string.
  return `workspace-editor:${sha256Hex(Buffer.from(JSON.stringify([
    "editor_save",
    input.artifactId,
    input.humanId,
    input.correlation,
  ])))}`;
}

/**
 * Deterministically names an editor-save operation before it is executed.
 * This exports no authority: callers must still pass the normal authenticated
 * editor-save envelope to actually read, write, or replay the receipt.
 */
export function createWorkspaceEditorSnapshotOperationId(input: {
  readonly artifactId: string;
  readonly humanId: string;
  readonly clientMutationId: string;
}): string {
  return operationId({
    artifactId: input.artifactId,
    humanId: input.humanId,
    correlation: input.clientMutationId,
  });
}

function patchIdForOperation(operation: string): string {
  const hex = sha256Hex(Buffer.from(operation));
  // Deterministic RFC-4122-shaped v5 identifier: existing patch consumers have
  // historically treated patchId as UUID-shaped, while replay needs stability.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    `89ab`[Number.parseInt(hex[16]!, 16) % 4]
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function editorRequestFingerprint(input: WorkspaceEditorSnapshotSaveInput | WorkspaceEditorPatchSaveInput): string {
  const base = {
    artifactId: input.artifact.id,
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
    checkpoint: input.checkpoint,
    // Explicit MIME and omitted MIME are distinct request semantics. The
    // backend separately binds the effective live MIME into its request digest.
    mimeIntent: input.mimeType ?? null,
    clientMutationId: input.clientMutationId ?? null,
  };
  if ("newText" in input) {
    return sha256Hex(Buffer.from(JSON.stringify({
      kind: "workspace_editor_snapshot_v1",
      ...base,
      contentSha256: sha256Hex(Buffer.from(input.newText, "utf8")),
    })));
  }
  return sha256Hex(Buffer.from(JSON.stringify({
    kind: "workspace_editor_patch_v1",
    ...base,
    requestId: input.requestId,
    patchSha256: sha256Hex(Buffer.from(JSON.stringify(input.patch))),
  })));
}

/**
 * Trusted retry discovery for editor saves.
 *
 * This deliberately admits the caller against a freshly locked mutable
 * Namespace attachment before it even probes an operation id. That ordering
 * prevents a browser correlation from becoming a receipt/existence oracle.
 * It also does not reconstruct a plan from current bytes: the operation is
 * already durably committed, so re-applying an anchored patch to its own
 * postimage would turn a valid retry into `anchor_not_found`.
 */
async function lookupTrustedWorkspaceEditorReplay(
  input: WorkspaceEditorReplayLookupInput,
  dependencies: WorkspaceEditorSaveServiceDependencies,
): Promise<WorkspaceEditorReplayLookup> {
  const db = dependencies.db ?? getServerDirectDb();
  return db.transaction(async (tx) => {
    const live = await lockWorkspaceArtifactForCurrentRoomAuthority({
      internalId: input.authority.artifact.id,
      humanActorId: input.authority.envelope.actorId,
      agentId: input.authority.envelope.agentId,
      roomId: input.authority.envelope.roomId,
    }, tx);
    if (!live || live.path !== input.authority.artifact.path) return { kind: "absent" };

    const operationLock = await acquireWorkspaceDocumentMutationOperationLock(tx, input.operationId);
    const trustedReplay = await findTrustedWorkspaceDocumentMutationReplay(tx, operationLock);
    if (trustedReplay.kind === "absent") return { kind: "absent" };
    const { mutation, replay } = trustedReplay;

    // These comparisons are exact, including absent optional correlation
    // fields. The hashed operation id is only an index; header evidence is the
    // authority binding that makes a replay safe.
    if (
      mutation.actorKind !== "human" ||
      mutation.actorId !== humanId(input.authority) ||
      mutation.lane !== "editor_save" ||
      mutation.requestId !== input.correlation.requestId ||
      mutation.clientMutationId !== input.correlation.clientMutationId ||
      mutation.editorRequestFingerprint !== input.authority.editorRequestFingerprint
    ) return { kind: "invalid" };

    const entries = await tx
      .select()
      .from(workspaceDocumentMutationEntries)
      .where(eq(workspaceDocumentMutationEntries.mutationId, mutation.id))
      .orderBy(asc(workspaceDocumentMutationEntries.sequence));
    const event = replay.enlistedEventBatch.events[0];
    const entry = entries[0];
    if (
      entries.length !== 1 || !entry ||
      entry.sequence !== 0 || entry.mutationKind !== "update" ||
      entry.artifactInternalId !== live.id ||
      entry.beforeStorageUri === null || entry.beforeSize === null ||
      entry.afterStorageUri === null || entry.afterSize === null
    ) return { kind: "invalid" };
    if (
      !event ||
      event.mutation !== "update" ||
      event.operationId !== mutation.operationId || event.sequence !== 0 ||
      event.actor.kind !== "human" || event.actor.humanId !== humanId(input.authority) ||
      event.before.identity.kind !== "workspace_artifact" ||
      event.after.identity.kind !== "workspace_artifact" ||
      event.before.identity.artifactId !== live.id || event.after.identity.artifactId !== live.id ||
      event.before.sha256 !== entry.beforeSha256 || event.after.sha256 !== entry.afterSha256
    ) return { kind: "invalid" };
    return {
      kind: "replay",
      event,
      beforeStorageUri: entry.beforeStorageUri,
      beforeSize: entry.beforeSize,
      afterStorageUri: entry.afterStorageUri,
      afterSize: entry.afterSize,
    };
  });
}

async function lookupEditorReplay(
  input: WorkspaceEditorReplayLookupInput,
  dependencies: WorkspaceEditorSaveServiceDependencies,
): Promise<WorkspaceEditorReplayLookup> {
  return dependencies.lookupReplay?.(input) ?? lookupTrustedWorkspaceEditorReplay(input, dependencies);
}

async function readProvenReplayBytes(input: {
  readonly storageUri: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
}): Promise<Uint8Array> {
  const bytes = await readStorageBytes(input.storageUri);
  if (bytes.byteLength !== input.expectedSize || sha256Hex(bytes) !== input.expectedSha256) {
    throw new Error("Workspace mutation replay bytes no longer prove the committed receipt");
  }
  return bytes;
}

function coordinatorFor(
  input: WorkspaceEditorResolvedAuthority,
  dependencies: WorkspaceEditorSaveServiceDependencies,
): DocumentMutationCoordinator {
  const resolveLive = async (conn?: WorkspaceDocumentMutationTx) => {
    const prove = (tx: WorkspaceDocumentMutationTx) => lockWorkspaceArtifactForCurrentRoomAuthority({
      internalId: input.artifact.id,
      humanActorId: input.envelope.actorId,
      agentId: input.envelope.agentId,
      roomId: input.envelope.roomId,
    }, tx);
    // Prepare deliberately performs the same fresh trusted proof in a
    // read-only transaction. Commit repeats it under the mutation tx and
    // retains row locks through the artifact CAS.
    const live = conn
      ? await prove(conn)
      : await (dependencies.db ?? getServerDirectDb()).transaction(prove);
    if (!live || live.path !== input.artifact.path) return null;
    return {
      actor: { kind: "human" as const, humanId: humanId(input) },
      lane: "editor_save" as const,
      artifact: asAuthorizedArtifact(live),
      ...(input.mimeType ? { nextMimeType: input.mimeType } : {}),
      ...(input.envelope.ownerId ? { ownerId: input.envelope.ownerId } : {}),
      userId: humanId(input),
      ...(input.envelope.agentId ? { agentId: input.envelope.agentId } : {}),
      ...(input.envelope.roomId ? { roomId: input.envelope.roomId } : {}),
      ...(input.clientMutationId
        ? { clientMutationId: input.clientMutationId }
        : {}),
      ...(input.requestId
        ? { requestId: input.requestId }
        : {}),
      ...(input.editorRequestFingerprint
        ? { editorRequestFingerprint: input.editorRequestFingerprint }
        : {}),
    };
  };
  const backend = new WorkspaceArtifactMutationBackend({
    ...(dependencies.db ? { db: dependencies.db } : {}),
    ...(dependencies.newOpaqueId ? { newOpaqueId: dependencies.newOpaqueId } : {}),
    authorityResolver: {
      resolve: () => resolveLive(),
      resolveInTransaction: (tx) => resolveLive(tx),
    },
  });
  return createDocumentMutationCoordinator({
    backend,
    hashBytes: sha256Hex,
    lockManager: dependencies.lockManager ?? workspaceDocumentMutationLockManager,
    allocateRevisionGroupId: ({ operationId: id }) => `workspace-editor-group:${id}`,
    // Workspace's backend enlists durable outbox truth in its commit
    // transaction. Live delivery is exclusively owned by the outbox runtime;
    // returning not_published here prevents coordinator live-publish plus
    // outbox replay from emitting duplicate committed events.
    eventPublisher: { publishAtomic: () => Promise.resolve({ kind: "not_published" as const }) },
  });
}

function mutationFailureMessage(outcome: Awaited<ReturnType<DocumentMutationCoordinator["execute"]>>): string {
  if (outcome.kind === "rejected") {
    return outcome.result.kind === "failed"
      ? outcome.result.code
      : outcome.result.code;
  }
  return outcome.kind === "recovery_required" ? outcome.code : "unexpected completed mutation";
}

async function executeUpdate(input: {
  readonly authority: WorkspaceEditorResolvedAuthority;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
  readonly baseVersion: DocumentVersion;
  readonly checkpoint: boolean;
  readonly requestId?: string;
  readonly clientMutationId?: string;
  readonly anchoredPatch?: AnchoredTextPatch;
  readonly operationId: string;
  readonly dependencies: WorkspaceEditorSaveServiceDependencies;
}) {
  const beforeVersion = versionFor(input.authority.artifact, input.before);
  const identity = beforeVersion.identity;
  const plan = {
    operationId: input.operationId,
    actor: { kind: "human" as const, humanId: humanId(input.authority) },
    editorSave: {
      kind: "editor_save" as const,
      checkpoint: input.checkpoint,
      baseVersion: input.baseVersion,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
      ...(input.anchoredPatch ? { anchoredPatch: input.anchoredPatch } : {}),
    },
    entries: [{
      kind: "update" as const,
      before: { identity, expectedVersion: beforeVersion, bytes: input.before },
      after: { identity, bytes: input.after, sha256: sha256Hex(input.after) },
    }],
  };
  const coordinator = input.dependencies.executeCoordinator === undefined
    ? coordinatorFor(input.authority, input.dependencies)
    : undefined;
  const execute = input.dependencies.executeCoordinator ??
    coordinator!.execute.bind(coordinator);
  const outcome = await execute({
    operationId: input.operationId,
    lane: "editor_save",
    plan,
  });
  if (outcome.kind === "completed") input.dependencies.onCommitted?.();
  return outcome;
}

export async function saveWorkspaceEditorSnapshot(
  input: WorkspaceEditorSnapshotSaveInput,
  dependencies: WorkspaceEditorSaveServiceDependencies = {},
): Promise<WorkspaceEditorSnapshotSaveResult> {
  const after = Buffer.from(input.newText, "utf8");
  if (after.byteLength > USER_SAVE_TEXT_LIMIT_BYTES) {
    return { ok: false, code: "too_large", message: `content exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit` };
  }
  const fingerprint = editorRequestFingerprint(input);
  const id = operationId({
    artifactId: input.artifact.id,
    humanId: humanId(input),
    correlation: input.clientMutationId ?? `request-fingerprint:${fingerprint}`,
  });
  const authority = { ...input, editorRequestFingerprint: fingerprint };
  // The canonical fingerprint is also the implicit retry correlation. Thus a
  // snapshot without a caller-provided client ID can still recover the same
  // unknown commit by repeating the exact request rather than minting a new
  // operation identity.
  const replay = await lookupEditorReplay({
    authority,
    operationId: id,
    correlation: {
      ...(input.clientMutationId === undefined
        ? {}
        : { clientMutationId: input.clientMutationId }),
    },
  }, dependencies);
  if (replay.kind === "invalid") {
    return recoveryRequired();
  }
  if (replay.kind === "replay") {
    try {
      const metadata = replay.event.editorSave;
      if (
        replay.event.after.backendVersion.kind !== "artifact_revision" ||
        !replayEventMatchesAuthority(replay.event, input) ||
        metadata === undefined ||
        metadata.checkpoint !== input.checkpoint ||
        metadata.requestId !== undefined ||
        metadata.clientMutationId !== input.clientMutationId ||
        metadata.anchoredPatch !== undefined
      ) {
        throw new Error("Saved editor operation has an invalid Workspace receipt");
      }
      const afterBytes = await readProvenReplayBytes({
        storageUri: replay.afterStorageUri,
        expectedSize: replay.afterSize,
        expectedSha256: replay.event.after.sha256,
      });
      if (!Buffer.from(afterBytes).equals(Buffer.from(input.newText, "utf8"))) {
        throw new Error("Saved editor operation postimage does not match this request");
      }
      return {
        ok: true,
        revision: replay.event.after.backendVersion.revision,
        size: afterBytes.byteLength,
        sha256: replay.event.after.sha256,
      };
    } catch {
      return recoveryRequired();
    }
  }
  let before: Uint8Array;
  try {
    before = await readArtifactBytes(input.artifact);
  } catch (error) {
    return { ok: false, code: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (!exactBaseMatches({
    row: input.artifact,
    bytes: before,
    baseRevision: input.baseRevision,
    baseSha256: input.baseSha256,
  })) return currentConflict(before);

  const beforeVersion = versionFor(input.artifact, before);
  const outcome = await executeUpdate({
    authority,
    before,
    after,
    baseVersion: beforeVersion,
    checkpoint: input.checkpoint,
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    operationId: id,
    dependencies,
  });
  if (outcome.kind === "completed") {
    const committed = outcome.events[0];
    if (committed?.mutation !== "update") return { ok: false, code: "error", message: "Coordinator returned no Workspace update receipt" };
    return {
      ok: true,
      revision: committed.after.backendVersion.kind === "artifact_revision" ? committed.after.backendVersion.revision : input.artifact.revision,
      size: after.byteLength,
      sha256: committed.after.sha256,
    };
  }
  if (outcome.kind === "recovery_required") return recoveryRequired();
  if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
    const evidence = outcome.result.evidence[0]?.currentVersion;
    return { ok: false, code: "conflict", currentSha256: evidence?.sha256 ?? null };
  }
  if (isBackendAuthorityFailure(outcome)) {
    const classification = await reclassifyAuthorityLoss(input, dependencies);
    if (classification === "forbidden") {
      return { ok: false, code: "forbidden", message: "Artifact is not writable in this context" };
    }
    if (classification === "not_found") {
      return { ok: false, code: "not_found", message: "Not found" };
    }
  }
  return { ok: false, code: "error", message: mutationFailureMessage(outcome) };
}

export async function saveWorkspaceEditorPatch(
  input: WorkspaceEditorPatchSaveInput,
  dependencies: WorkspaceEditorSaveServiceDependencies = {},
): Promise<WorkspaceEditorPatchSaveResult> {
  // Compatibility rule from the former patch adapter: each side of the
  // anchored patch is bounded independently. This reuses the existing shared
  // editor/Writer limit rather than creating a D448-specific ceiling.
  const oldBytes = Buffer.byteLength(input.patch.oldString, "utf8");
  const newBytes = Buffer.byteLength(input.patch.newString, "utf8");
  if (oldBytes > USER_SAVE_TEXT_LIMIT_BYTES || newBytes > USER_SAVE_TEXT_LIMIT_BYTES) {
    return { ok: false, rejection: { kind: "too_large", reason: `patch payload exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit` } };
  }
  const correlation = input.clientMutationId ?? input.requestId;
  const id = operationId({
    artifactId: input.artifact.id,
    humanId: humanId(input),
    correlation,
  });
  const fingerprint = editorRequestFingerprint(input);
  const authority = { ...input, editorRequestFingerprint: fingerprint };
  const replay = await lookupEditorReplay({
    authority,
    operationId: id,
    correlation: {
      requestId: input.requestId,
      ...(input.clientMutationId === undefined ? {} : { clientMutationId: input.clientMutationId }),
    },
  }, dependencies);
  if (replay.kind === "invalid") {
    return recoveryRequired();
  }
  if (replay.kind === "replay") {
    try {
      const metadata = replay.event.editorSave;
      if (
        replay.event.after.backendVersion.kind !== "artifact_revision" ||
        replay.event.after.identity.kind !== "workspace_artifact" ||
        !replayEventMatchesAuthority(replay.event, input) ||
        metadata === undefined ||
        metadata.requestId !== input.requestId ||
        metadata.clientMutationId !== input.clientMutationId ||
        metadata.checkpoint !== input.checkpoint ||
        metadata.anchoredPatch === undefined ||
        !anchoredPatchEquals(metadata.anchoredPatch, input.patch)
      ) {
        throw new Error("Saved editor operation has an invalid patch receipt");
      }
      const [before, after] = await Promise.all([
        readProvenReplayBytes({
          storageUri: replay.beforeStorageUri,
          expectedSize: replay.beforeSize,
          expectedSha256: replay.event.before.sha256,
        }),
        readProvenReplayBytes({
          storageUri: replay.afterStorageUri,
          expectedSize: replay.afterSize,
          expectedSha256: replay.event.after.sha256,
        }),
      ]);
      const beforeText = Buffer.from(before).toString("utf8");
      const afterText = Buffer.from(after).toString("utf8");
      const provenApply = applyAnchoredTextPatch(beforeText, input.patch);
      if (!provenApply.ok || provenApply.text !== afterText) {
        throw new Error("Saved patch postimage does not match its anchored patch");
      }
      const responseMimeType = replay.event.workspaceArtifactMetadata?.afterMimeType;
      return {
        ok: true,
        applied: {
          kind: "applied",
          target: {
            kind: "artifact",
            artifactInternalId: input.artifact.id,
            path: replay.event.after.identity.logicalPath,
            ...(input.envelope.roomId ? { roomId: input.envelope.roomId } : {}),
            ...(responseMimeType ? { mimeType: responseMimeType } : {}),
          },
          patchId: patchIdForOperation(id),
          requestId: input.requestId,
          revision: replay.event.after.backendVersion.revision,
          sha256: replay.event.after.sha256,
          content: afterText,
          author: { kind: "human", displayName: input.sessionUserId ?? input.envelope.ownerId ?? "User" },
          patch: metadata.anchoredPatch,
          unifiedDiff: createPatch(replay.event.after.identity.logicalPath, beforeText, afterText, "before", "after", { context: 3 }),
          rebased: replay.event.outcome === "rebased",
        },
      };
    } catch {
      return recoveryRequired();
    }
  }
  let before: Uint8Array;
  try {
    before = await readArtifactBytes(input.artifact);
  } catch (error) {
    return { ok: false, rejection: { kind: "unsupported", reason: error instanceof Error ? error.message : String(error) } };
  }
  const currentSha256 = sha256Hex(before);
  const text = Buffer.from(before).toString("utf8");
  const applied = applyAnchoredTextPatch(text, input.patch);
  if (!applied.ok) {
    const stale = input.baseSha256 !== currentSha256;
    return {
      ok: false,
      rejection: {
        kind: applied.reason === "anchor_ambiguous"
          ? "anchor_ambiguous"
          : stale ? "stale_base_unrebaseable" : "anchor_not_found",
        latestRevision: input.artifact.revision,
        latestSha256: currentSha256,
      },
    };
  }
  const after = Buffer.from(applied.text, "utf8");
  if (after.byteLength > USER_SAVE_TEXT_LIMIT_BYTES) {
    return { ok: false, rejection: { kind: "too_large", reason: `resulting content exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit` } };
  }
  const currentVersion = versionFor(input.artifact, before);
  const baseVersion: DocumentVersion = {
    identity: currentVersion.identity,
    backendVersion: { kind: "artifact_revision", revision: input.baseRevision ?? input.artifact.revision },
    sha256: input.baseSha256,
  };
  const outcome = await executeUpdate({
    authority,
    before,
    after,
    baseVersion,
    checkpoint: input.checkpoint,
    requestId: input.requestId,
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    anchoredPatch: input.patch,
    operationId: id,
    dependencies,
  });
  if (outcome.kind === "completed") {
    const committed = outcome.events[0];
    if (committed?.mutation !== "update" || committed.after.backendVersion.kind !== "artifact_revision") {
      return { ok: false, rejection: { kind: "unsupported", reason: "Coordinator returned no Workspace update receipt" } };
    }
    const rebased = committed.outcome === "rebased";
    const responseMimeType = committed.workspaceArtifactMetadata?.afterMimeType;
    return {
      ok: true,
      applied: {
        kind: "applied",
        target: {
          kind: "artifact",
          artifactInternalId: input.artifact.id,
          path: input.artifact.path,
          ...(input.envelope.roomId ? { roomId: input.envelope.roomId } : {}),
          ...(responseMimeType ? { mimeType: responseMimeType } : {}),
        },
        patchId: patchIdForOperation(id),
        requestId: input.requestId,
        revision: committed.after.backendVersion.revision,
        sha256: committed.after.sha256,
        content: applied.text,
        author: {
          kind: "human",
          displayName: input.sessionUserId ?? input.envelope.ownerId ?? "User",
        },
        patch: input.patch,
        unifiedDiff: createPatch(input.artifact.path, text, applied.text, "before", "after", { context: 3 }),
        rebased,
      },
    };
  }
  if (outcome.kind === "recovery_required") return recoveryRequired();
  if (outcome.kind === "rejected" && outcome.result.kind === "conflict") {
    const current = outcome.result.evidence[0]?.currentVersion;
    return {
      ok: false,
      rejection: {
        kind: input.baseSha256 !== currentSha256 ? "stale_base_unrebaseable" : "anchor_not_found",
        latestRevision: current?.backendVersion.kind === "artifact_revision" ? current.backendVersion.revision : input.artifact.revision,
        latestSha256: current?.sha256 ?? currentSha256,
      },
    };
  }
  if (isBackendAuthorityFailure(outcome)) {
    const classification = await reclassifyAuthorityLoss(input, dependencies);
    if (classification === "forbidden") {
      return { ok: false, rejection: { kind: "forbidden", reason: "Artifact is not writable in this context" } };
    }
    if (classification === "not_found") {
      return { ok: false, code: "not_found", message: "Not found" };
    }
  }
  return { ok: false, rejection: { kind: "unsupported", reason: mutationFailureMessage(outcome) } };
}
