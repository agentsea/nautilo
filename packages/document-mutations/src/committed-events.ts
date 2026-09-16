import {
  applyAnchoredTextPatch,
  documentCommitPlanSchema,
  documentMutationCommittedEventSchema,
  parseDocumentMutationCommittedEvent,
  documentVersionSchema,
  type DocumentCommitPlan,
  type DocumentIdentity,
  type DocumentMutationCommittedEvent,
  type DocumentVersion,
  type WorkspaceArtifactMetadataTransition,
} from "@nautilo/types";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type AtomicDocumentMutationBackendKind = "workspace" | "desktop";
export type AtomicDocumentMutationOutcome = "applied" | "rebased";

interface AtomicCommittedEntryBase {
  readonly entryIndex: number;
  readonly revisionIds: readonly [string, ...string[]];
  readonly undoRecordIds: readonly [string, ...string[]];
}

export type AtomicDocumentMutationCommittedEntryReceipt<
  V extends DocumentVersion = DocumentVersion,
> =
  | (AtomicCommittedEntryBase & {
      readonly kind: "create";
      readonly after: V;
    })
  | (AtomicCommittedEntryBase & {
      readonly kind: "update";
      readonly before: V;
      readonly after: V;
      /** Backend-proven Workspace row metadata, never editor correlation. */
      readonly workspaceArtifactMetadata?: WorkspaceArtifactMetadataTransition;
    })
  | (AtomicCommittedEntryBase & {
      readonly kind: "move";
      readonly before: V;
      readonly destinationBefore?: V;
      readonly after: V;
    })
  | (AtomicCommittedEntryBase & {
      readonly kind: "delete";
      readonly before: V;
    });

/**
 * Backend-neutral receipt shape consumed by the committed-event builder.
 * Backends refine both the backend discriminant and version type.
 */
export interface AtomicDocumentMutationCommitReceipt<
  K extends AtomicDocumentMutationBackendKind = AtomicDocumentMutationBackendKind,
  V extends DocumentVersion = DocumentVersion,
> {
  readonly backend: K;
  readonly operationId: string;
  readonly revisionGroupId: string;
  readonly entries: readonly AtomicDocumentMutationCommittedEntryReceipt<V>[];
}

export interface AtomicDocumentMutationEventBatch {
  readonly operationId: string;
  readonly revisionGroupId: string;
  readonly idempotencyKey: string;
  readonly events: readonly DocumentMutationCommittedEvent[];
}

export interface BuildAtomicDocumentMutationEventBatchInput {
  readonly backend: AtomicDocumentMutationBackendKind;
  readonly plan: DocumentCommitPlan;
  readonly receipt: AtomicDocumentMutationCommitReceipt;
  readonly revisionGroupId: string;
  readonly outcome: AtomicDocumentMutationOutcome;
}

function identityEquals(left: DocumentIdentity, right: DocumentIdentity): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "workspace_artifact"
    ? right.kind === "workspace_artifact" &&
        left.artifactId === right.artifactId &&
        left.logicalPath === right.logicalPath
    : right.kind === "local_file" &&
        left.relayId === right.relayId &&
        left.canonicalPath === right.canonicalPath;
}

function versionEquals(left: DocumentVersion, right: DocumentVersion): boolean {
  const parsedLeft = documentVersionSchema.safeParse(left);
  const parsedRight = documentVersionSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) return false;
  const leftVersion = parsedLeft.data;
  const rightVersion = parsedRight.data;
  if (
    !identityEquals(leftVersion.identity, rightVersion.identity) ||
    leftVersion.sha256 !== rightVersion.sha256 ||
    leftVersion.backendVersion.kind !== rightVersion.backendVersion.kind
  ) {
    return false;
  }
  return leftVersion.backendVersion.kind === "artifact_revision"
    ? rightVersion.backendVersion.kind === "artifact_revision" &&
        leftVersion.backendVersion.revision ===
          rightVersion.backendVersion.revision
    : rightVersion.backendVersion.kind === "local_sha" &&
        leftVersion.backendVersion.sha256 ===
          rightVersion.backendVersion.sha256;
}

function versionMatchesBackend(
  backend: AtomicDocumentMutationBackendKind,
  version: DocumentVersion,
): boolean {
  return backend === "workspace"
    ? version.identity.kind === "workspace_artifact" &&
        version.backendVersion.kind === "artifact_revision"
    : version.identity.kind === "local_file" &&
        version.backendVersion.kind === "local_sha";
}

function versionMatchesPostImage(
  backend: AtomicDocumentMutationBackendKind,
  version: DocumentVersion,
  identity: DocumentIdentity,
  sha256: string,
): boolean {
  return (
    documentVersionSchema.safeParse(version).success &&
    versionMatchesBackend(backend, version) &&
    identityEquals(version.identity, identity) &&
    version.sha256 === sha256
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(bytes: Uint8Array): string {
  return bytesToHex(nobleSha256(bytes));
}

/**
 * Event deltas must be proven from the plan's actual commit base, not trusted
 * merely because an editor supplied a patch for its earlier loading base.
 */
function provenEditorSaveEventMetadata(plan: DocumentCommitPlan):
  | {
      readonly checkpoint: boolean;
      readonly requestId?: string;
      readonly clientMutationId?: string;
      readonly anchoredPatch?: NonNullable<
        NonNullable<DocumentCommitPlan["editorSave"]>["anchoredPatch"]
      >;
    }
  | undefined {
  const intent = plan.editorSave;
  const entry = plan.entries[0];
  if (intent === undefined) return undefined;
  if (
    plan.entries.length !== 1 ||
    plan.actor.kind !== "human" ||
    entry?.kind !== "update"
  ) {
    throw new TypeError("editor-save event metadata violates the shared plan contract");
  }

  const metadata = {
    checkpoint: intent.checkpoint,
    ...(intent.requestId === undefined ? {} : { requestId: intent.requestId }),
    ...(intent.clientMutationId === undefined
      ? {}
      : { clientMutationId: intent.clientMutationId }),
  };
  if (intent.anchoredPatch === undefined) return metadata;

  // These checks are deliberately local to the event builder. A valid receipt
  // cannot make a stale patch or false byte-hash claim safe to publish.
  if (
    sha256(entry.before.bytes) !== entry.before.expectedVersion.sha256 ||
    sha256(entry.after.bytes) !== entry.after.sha256
  ) {
    throw new TypeError("editor-save patch bytes violate the declared SHA-256 contract");
  }

  let beforeText: string;
  try {
    beforeText = new TextDecoder("utf-8", { fatal: true }).decode(entry.before.bytes);
  } catch {
    throw new TypeError("editor-save anchored patch requires UTF-8 before bytes");
  }
  const applied = applyAnchoredTextPatch(beforeText, intent.anchoredPatch);
  if (!applied.ok) {
    throw new TypeError("editor-save anchored patch does not apply to the actual before bytes");
  }
  if (!bytesEqual(new TextEncoder().encode(applied.text), entry.after.bytes)) {
    throw new TypeError("editor-save anchored patch does not prove the actual after bytes");
  }
  return { ...metadata, anchoredPatch: intent.anchoredPatch };
}

function nonemptyUniqueIds(
  values: unknown,
  seen: Set<string>,
): boolean {
  if (!Array.isArray(values) || values.length === 0) return false;
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      seen.has(value)
    ) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

function receiptMatchesPlan(
  input: BuildAtomicDocumentMutationEventBatchInput,
): boolean {
  const { backend, plan, receipt, revisionGroupId } = input;
  if (
    receipt.backend !== backend ||
    receipt.operationId !== plan.operationId ||
    receipt.revisionGroupId !== revisionGroupId ||
    receipt.entries.length !== plan.entries.length
  ) {
    return false;
  }

  const globallyUniqueIds = new Set<string>();
  return receipt.entries.every((committed, entryIndex) => {
    const entry = plan.entries[entryIndex]!;
    if (
      committed.entryIndex !== entryIndex ||
      committed.kind !== entry.kind ||
      !nonemptyUniqueIds(committed.revisionIds, globallyUniqueIds) ||
      !nonemptyUniqueIds(committed.undoRecordIds, globallyUniqueIds)
    ) {
      return false;
    }

    switch (entry.kind) {
      case "create":
        return (
          committed.kind === "create" &&
          versionMatchesPostImage(
            backend,
            committed.after,
            entry.after.identity,
            entry.after.sha256,
          )
        );
      case "update":
        return (
          committed.kind === "update" &&
          versionEquals(committed.before, entry.before.expectedVersion) &&
          versionMatchesPostImage(
            backend,
            committed.after,
            entry.after.identity,
            entry.after.sha256,
          )
        );
      case "move":
        return (
          committed.kind === "move" &&
          versionEquals(committed.before, entry.source.expectedVersion) &&
          (entry.destinationBefore === undefined
            ? committed.destinationBefore === undefined
            : committed.destinationBefore !== undefined &&
              versionEquals(
                committed.destinationBefore,
                entry.destinationBefore.expectedVersion,
              )) &&
          versionMatchesPostImage(
            backend,
            committed.after,
            entry.after.identity,
            entry.after.sha256,
          )
        );
      case "delete":
        return (
          committed.kind === "delete" &&
          versionEquals(committed.before, entry.before.expectedVersion)
        );
    }
  });
}

function buildEvents(
  input: BuildAtomicDocumentMutationEventBatchInput,
): readonly DocumentMutationCommittedEvent[] {
  const { plan, receipt, outcome } = input;
  const editorSave = provenEditorSaveEventMetadata(plan);
  return plan.entries.map((entry, sequence): DocumentMutationCommittedEvent => {
    const committed = receipt.entries[sequence]!;
    const base = {
      type: "document.mutation.committed" as const,
      operationId: plan.operationId,
      revisionGroupId: receipt.revisionGroupId,
      sequence,
      outcome,
      actor: plan.actor,
    };
    switch (entry.kind) {
      case "create":
        if (committed.kind !== "create") throw new TypeError("invalid receipt");
        return {
          ...base,
          mutation: "create",
          path: { kind: "create", after: entry.after.identity },
          after: committed.after,
        };
      case "update":
        if (committed.kind !== "update") throw new TypeError("invalid receipt");
        return {
          ...base,
          mutation: "update",
          path: {
            kind: "update",
            before: entry.before.identity,
            after: entry.after.identity,
          },
          before: committed.before,
          after: committed.after,
          ...(editorSave === undefined ? {} : { editorSave }),
          ...(committed.workspaceArtifactMetadata === undefined
            ? {}
            : { workspaceArtifactMetadata: committed.workspaceArtifactMetadata }),
        };
      case "move":
        if (committed.kind !== "move") throw new TypeError("invalid receipt");
        return entry.destinationBefore === undefined
          ? {
              ...base,
              mutation: "move",
              overwrite: false,
              path: {
                kind: "move",
                overwrite: false,
                before: entry.source.identity,
                after: entry.after.identity,
              },
              before: committed.before,
              after: committed.after,
            }
          : {
              ...base,
              mutation: "move",
              overwrite: true,
              path: {
                kind: "move",
                overwrite: true,
                before: entry.source.identity,
                destinationBefore: entry.destinationBefore.identity,
                after: entry.after.identity,
              },
              before: committed.before,
              destinationBefore: committed.destinationBefore!,
              after: committed.after,
            };
      case "delete":
        if (committed.kind !== "delete") throw new TypeError("invalid receipt");
        return {
          ...base,
          mutation: "delete",
          path: { kind: "delete", before: entry.before.identity },
          before: committed.before,
        };
    }
  });
}

/**
 * Builds the only valid durable event batch for an exact plan and prospective
 * commit receipt. It rejects malformed or mismatched receipts before a backend
 * can enlist events in its authoritative transaction.
 */
export function buildAtomicDocumentMutationEventBatch(
  input: BuildAtomicDocumentMutationEventBatchInput,
): AtomicDocumentMutationEventBatch {
  const parsedPlan = documentCommitPlanSchema.safeParse(input.plan);
  if (!parsedPlan.success) {
    throw new TypeError("mutation plan violates the shared plan contract");
  }
  const validatedInput = { ...input, plan: parsedPlan.data };
  let matches = false;
  try {
    matches = receiptMatchesPlan(validatedInput);
  } catch {
    matches = false;
  }
  if (!matches) {
    throw new TypeError("commit receipt does not exactly match the mutation plan");
  }
  const events = buildEvents(validatedInput);
  if (
    events.some(
      (event) => !documentMutationCommittedEventSchema.safeParse(event).success,
    )
  ) {
    throw new TypeError("committed event batch violates the shared event contract");
  }
  return {
    operationId: parsedPlan.data.operationId,
    revisionGroupId: input.revisionGroupId,
    idempotencyKey: deriveAtomicDocumentMutationBatchIdempotencyKey(
      parsedPlan.data.operationId,
      input.revisionGroupId,
    ),
    events,
  };
}

/**
 * Versioned canonical JSON tuple encoding. Unlike delimiter concatenation, it
 * is injective for arbitrary opaque IDs, including delimiters and Unicode.
 */
export function deriveAtomicDocumentMutationBatchIdempotencyKey(
  operationId: string,
  revisionGroupId: string,
): string {
  return `document-mutation:v1:${JSON.stringify([
    operationId,
    revisionGroupId,
  ])}`;
}

/**
 * Validates an already-durable committed-event envelope without requiring the
 * original plan or backend receipt. Outbox consumers use this before live
 * publication/replay: every event must parse as exact shared truth and agree
 * with the envelope's operation, revision group, idempotency key, and ordered
 * zero-based sequence. It deliberately does not regenerate the batch from a
 * plan—that remains `validateAtomicDocumentMutationEventBatch` below.
 */
export function validateAtomicDocumentMutationEventBatchEnvelope(
  value: unknown,
): value is AtomicDocumentMutationEventBatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const batch = value as Record<string, unknown>;
  const keys = Object.keys(batch).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "events" || keys[1] !== "idempotencyKey" ||
    keys[2] !== "operationId" || keys[3] !== "revisionGroupId"
  ) return false;
  if (
    typeof batch["operationId"] !== "string" || batch["operationId"].trim().length === 0 ||
    typeof batch["revisionGroupId"] !== "string" || batch["revisionGroupId"].trim().length === 0 ||
    typeof batch["idempotencyKey"] !== "string" ||
    !Array.isArray(batch["events"]) || batch["events"].length === 0 ||
    batch["idempotencyKey"] !== deriveAtomicDocumentMutationBatchIdempotencyKey(
      batch["operationId"],
      batch["revisionGroupId"],
    )
  ) return false;
  try {
    return batch["events"].every((raw, sequence) => {
      const event = parseDocumentMutationCommittedEvent(raw);
      return (
        event.operationId === batch["operationId"] &&
        event.revisionGroupId === batch["revisionGroupId"] &&
        event.sequence === sequence
      );
    });
  } catch {
    return false;
  }
}

function exactValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactValueEquals(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        exactValueEquals(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Independently validates that a backend returned the exact batch it was
 * required to transactionally enlist for the committed receipt.
 */
export function validateAtomicDocumentMutationEventBatch(
  input: BuildAtomicDocumentMutationEventBatchInput & {
    readonly batch: unknown;
  },
): input is BuildAtomicDocumentMutationEventBatchInput & {
  readonly batch: AtomicDocumentMutationEventBatch;
} {
  let expected: AtomicDocumentMutationEventBatch;
  try {
    expected = buildAtomicDocumentMutationEventBatch(input);
  } catch {
    return false;
  }
  try {
    return exactValueEquals(expected, input.batch);
  } catch {
    return false;
  }
}
