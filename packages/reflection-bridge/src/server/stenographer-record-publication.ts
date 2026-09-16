import {
  planStenographerObservationPublication,
  type RoomEventKind,
} from "@nautilo/reflection";
import type {
  DurableRecordEnvelope,
  DurableRecordPublication,
} from "@nautilo/reflection/durable";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface StenographerMessageBinding {
  readonly messageId: number;
  readonly editRevision: number;
  /** Fingerprint of the exact opened content/binding, retained only in payload. */
  readonly observedContentFingerprint: string;
}

export interface StenographerRecordPublicationInput {
  readonly eventId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly kind: RoomEventKind;
  readonly statement: string;
  readonly sources: readonly StenographerMessageBinding[];
  readonly sourceBatchId: string;
  readonly batchLocalOrdinal: number;
  readonly extractorVersion: string;
  readonly rebuildGeneration: number;
  readonly transition:
    | Readonly<{ operation: "append" }>
    | Readonly<{
        operation: "supersede" | "resolve";
        predecessorEventId: string;
      }>;
  readonly publicationBindingRef: string;
}

export interface StenographerRecordPayloadBinding {
  readonly eventId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly kind: RoomEventKind;
  readonly status: "active" | "superseded" | "resolved";
  readonly sourceMessageIds: readonly number[];
  readonly extractorVersion: string;
  /** Immutable expected generation when the caller has an original binding. */
  readonly publicationGeneration?: number;
}

const encoder = new TextEncoder();

function positiveCounter(label: string, value: number, minimum: 0 | 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function fingerprint(input: StenographerRecordPublicationInput): string {
  const canonical = JSON.stringify([
    "nautilo/stenographer/record-observation/v1",
    input.eventId,
    input.roomId,
    input.namespaceId,
    input.kind,
    input.statement,
    input.sources.map((source) => [
      source.messageId,
      source.editRevision,
      source.observedContentFingerprint,
    ]),
    input.extractorVersion,
    input.rebuildGeneration,
    input.transition.operation,
    input.transition.operation === "append"
      ? null
      : input.transition.predecessorEventId,
  ]);
  return `sha256:${bytesToHex(sha256(encoder.encode(canonical)))}`;
}

/**
 * Resolve bridge-owned Room/Message coordinates into the one canonical
 * representation-neutral Record publication. No repository mode enters the
 * payload or idempotency identity.
 */
export function buildStenographerRecordPublication(
  input: StenographerRecordPublicationInput,
): DurableRecordPublication {
  positiveCounter("batch-local ordinal", input.batchLocalOrdinal, 0);
  positiveCounter("rebuild generation", input.rebuildGeneration, 0);
  const orderedSources = [...input.sources].sort(
    (left, right) => left.messageId - right.messageId,
  );
  for (const source of orderedSources) {
    positiveCounter("Message ID", source.messageId, 1);
    positiveCounter("Message edit revision", source.editRevision, 0);
  }
  const transition = input.transition.operation === "append"
    ? input.transition
    : {
        operation: input.transition.operation,
        predecessorRecordRef: input.transition.predecessorEventId,
      };
  const planned = planStenographerObservationPublication({
    recordRef: input.eventId,
    kind: input.kind,
    statement: input.statement,
    roomAnchorRef: input.roomId,
    terminalAuthorityLeafHandle: input.namespaceId,
    sources: orderedSources.map((source) => ({
      logicalMessageRef: `message:${source.messageId}`,
      observedRevision: String(source.editRevision),
      observedContentFingerprint: source.observedContentFingerprint,
      terminalAuthorityLeafHandle: input.namespaceId,
    })),
    observedContentFingerprint: fingerprint({ ...input, sources: orderedSources }),
    producerRef: "stenographer",
    producerPolicyVersion: input.extractorVersion,
    processingGeneration: input.rebuildGeneration + 1,
    transition,
  });
  return {
    record: planned.record,
    ...(planned.predecessor === undefined
      ? {}
      : { predecessor: planned.predecessor }),
    idempotencyKey: `journal:${input.sourceBatchId}:${input.batchLocalOrdinal}`,
    publicationBindingRef: input.publicationBindingRef,
  };
}

/**
 * Authenticate every source-owned coordinate that remains outside protected
 * Record bytes. This is shared by foreground Journal reads and background
 * compaction so neither view can accept a semantically substituted payload.
 */
export function assertStenographerRecordPayloadBinding(
  envelope: DurableRecordEnvelope,
  binding: StenographerRecordPayloadBinding,
): void {
  const observedRevision = envelope.semantic.observedRevision;
  const publicationGeneration = observedRevision === undefined
    || !/^[1-9]\d*$/.test(observedRevision)
    ? undefined
    : Number(observedRevision);
  const publicationGenerationIsValid = publicationGeneration !== undefined
    && Number.isSafeInteger(publicationGeneration)
    && envelope.processingGeneration >= publicationGeneration
    && (
      binding.publicationGeneration === undefined
      || publicationGeneration === binding.publicationGeneration
    );
  const expectedLifecycle = binding.status === "active"
    ? "current"
    : binding.status;
  // A bounded legacy conversion may publish an older terminal projection
  // before the later legacy successor that supplies its immutable edge. Until
  // that successor converts in a later transaction, the Record is still
  // current while the Journal projection already carries the historical
  // terminal status. Accept only that one-way lag; every other lifecycle
  // mismatch remains an integrity failure.
  const lifecycleMatches = envelope.lifecycle === expectedLifecycle
    || (
      envelope.lifecycle === "current"
      && (expectedLifecycle === "superseded" || expectedLifecycle === "resolved")
    );
  const expectedSources = [...binding.sourceMessageIds]
    .sort((left, right) => left - right)
    .map((messageId) => `message:${messageId}`);
  const actualSources = envelope.semantic.sourceDependencies.map(
    (source) => source.logicalSourceRef,
  );
  const anchor = envelope.semantic.anchors[0];
  if (
    envelope.recordRef !== binding.eventId
    || !lifecycleMatches
    || envelope.structuralHeight !== 0
    || !publicationGenerationIsValid
    || envelope.semantic.posture !== "derived"
    || envelope.semantic.sourceOwnedKind !== `journal_event:${binding.kind}`
    || envelope.semantic.observedLogicalObjectRef !== binding.eventId
    || envelope.semantic.childRecordRefs.length !== 0
    || envelope.semantic.anchors.length !== 1
    || anchor?.kind !== "room"
    || anchor.anchorRef !== binding.roomId
    || anchor.role !== "origin"
    || envelope.semantic.producer.producerRef !== "stenographer"
    || envelope.semantic.producer.policyVersion !== binding.extractorVersion
    || envelope.semantic.terminalAuthorityLeafHandles.length !== 1
    || envelope.semantic.terminalAuthorityLeafHandles[0]
      !== binding.namespaceId
    || actualSources.length !== expectedSources.length
    || actualSources.some((source, index) => source !== expectedSources[index])
    || envelope.semantic.sourceDependencies.some((source) =>
      source.sourceKind !== "message"
      || source.terminalAuthorityLeafHandle !== binding.namespaceId
      || source.authorityBearing !== true
      || source.observedRevision === undefined
      || source.observedContentFingerprint === undefined
    )
  ) {
    throw new TypeError("Stenographer Record payload binding is invalid");
  }
}
