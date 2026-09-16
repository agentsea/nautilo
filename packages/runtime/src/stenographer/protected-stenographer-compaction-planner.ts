import {
  encodeRoomEventPayloadV1,
  encodeRoomEventRollupPayloadV1,
  type RoomEventPayloadBindingV1,
  type RoomEventPayloadKindV1,
  type RoomEventRollupPayloadBindingV1,
} from "@nautilo/lattice-bridge";

import { EVENT_COMPACTION_PROTECTED_TAIL } from "@nautilo/reflection";
import {
  fingerprintProtectedStenographerSourceBindings,
  type ProtectedStenographerSourceBinding,
} from "./protected-source-loader";

/**
 * At 500 code points per event, 80 active events can reach the existing
 * 40,000-code-point trigger. Protected discovery cannot read statements, so
 * it conservatively requests authorization at this content-free count.
 */
export const PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER = 80;
/**
 * One of the transform's 256 input slots is reserved for the prior cumulative
 * rollup. Keeping a uniform 255-event bound makes descriptor construction
 * independent of whether the rollup exists.
 */
export const PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS = 255;

export interface ProtectedStenographerCompactionEventMetadata
  extends RoomEventPayloadBindingV1 {
  readonly objectId: string | null;
  readonly status: "active" | "superseded" | "resolved";
  readonly payloadFormat?: "record_v1";
  readonly recordMetadata?: Readonly<{
    readonly lifecycle:
      | "current"
      | "stale"
      | "superseded"
      | "resolved"
      | "sunset";
    readonly structuralHeight: number;
    readonly processingGeneration: number;
  }>;
}

export interface ProtectedStenographerCompactionRollupMetadata
  extends RoomEventRollupPayloadBindingV1 {
  readonly objectId: string | null;
}

export type ProtectedStenographerCompactionPlanningResult =
  | Readonly<{
    readonly status: "authorize";
    readonly bindings: readonly ProtectedStenographerSourceBinding[];
    readonly inputObjectIds: readonly string[];
    readonly sourceBindingFingerprint: Uint8Array;
    readonly activeEventCount: number;
    readonly selectedEventCount: number;
    readonly hasDeferredMiddle: boolean;
  }>
  | Readonly<{
    readonly status: "wait";
    readonly reason: "not_due";
  }>
  | Readonly<{
    readonly status: "blocked";
    readonly reason:
      | "invalid_metadata"
      | "protected_source_unavailable"
      | "duplicate_identity"
      | "out_of_order";
  }>;

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

function objectId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new TypeError("protected compaction object ID is invalid");
  }
  return value;
}

function validateEvent(
  event: ProtectedStenographerCompactionEventMetadata,
): ProtectedStenographerCompactionEventMetadata {
  if (
    event.status !== "active"
    && event.status !== "superseded"
    && event.status !== "resolved"
  ) {
    throw new TypeError("protected compaction event status is invalid");
  }
  objectId(event.objectId);
  encodeRoomEventPayloadV1({
    eventId: event.eventId,
    roomId: event.roomId,
    namespaceId: event.namespaceId,
    sequence: event.sequence,
    kind: event.kind,
    statement: "metadata-validation",
    supersedesEventId: event.supersedesEventId,
    resolvesEventId: event.resolvesEventId,
    sourceMessageIds: event.sourceMessageIds,
    sourceBatchId: event.sourceBatchId,
    batchLocalOrdinal: event.batchLocalOrdinal,
    extractorVersion: event.extractorVersion,
    createdAt: event.createdAt,
  }).fill(0);
  return event;
}

function validateRollup(
  rollup: ProtectedStenographerCompactionRollupMetadata,
): ProtectedStenographerCompactionRollupMetadata {
  objectId(rollup.objectId);
  encodeRoomEventRollupPayloadV1({
    rollupId: rollup.rollupId,
    roomId: rollup.roomId,
    namespaceId: rollup.namespaceId,
    throughEventSequence: rollup.throughEventSequence,
    content: "metadata-validation",
    sourceEventCount: rollup.sourceEventCount,
    modelId: rollup.modelId,
    compactorVersion: rollup.compactorVersion,
    createdAt: rollup.createdAt,
  }).fill(0);
  return rollup;
}

function eventBinding(
  event: ProtectedStenographerCompactionEventMetadata,
): ProtectedStenographerSourceBinding {
  if (
    (event.payloadFormat === "record_v1")
    !== (event.recordMetadata !== undefined)
  ) {
    throw new TypeError("protected compaction Record metadata is invalid");
  }
  const binding: RoomEventPayloadBindingV1 = Object.freeze({
    eventId: event.eventId,
    roomId: event.roomId,
    namespaceId: event.namespaceId,
    sequence: event.sequence,
    kind: event.kind,
    supersedesEventId: event.supersedesEventId,
    resolvesEventId: event.resolvesEventId,
    sourceMessageIds: Object.freeze([...event.sourceMessageIds]),
    sourceBatchId: event.sourceBatchId,
    batchLocalOrdinal: event.batchLocalOrdinal,
    extractorVersion: event.extractorVersion,
    createdAt: event.createdAt,
  });
  return Object.freeze({
    kind: "event",
    objectId: event.objectId!,
    status: event.status,
    binding,
    ...(event.payloadFormat === "record_v1"
      ? {
        payloadFormat: event.payloadFormat,
        recordMetadata: event.recordMetadata!,
      }
      : {}),
  });
}

function rollupBinding(
  rollup: ProtectedStenographerCompactionRollupMetadata,
): ProtectedStenographerSourceBinding {
  const binding: RoomEventRollupPayloadBindingV1 = Object.freeze({
    rollupId: rollup.rollupId,
    roomId: rollup.roomId,
    namespaceId: rollup.namespaceId,
    throughEventSequence: rollup.throughEventSequence,
    sourceEventCount: rollup.sourceEventCount,
    modelId: rollup.modelId,
    compactorVersion: rollup.compactorVersion,
    createdAt: rollup.createdAt,
  });
  return Object.freeze({
    kind: "rollup",
    objectId: rollup.objectId!,
    binding,
  });
}

function selectedBoundedEvents(
  events: readonly ProtectedStenographerCompactionEventMetadata[],
): readonly ProtectedStenographerCompactionEventMetadata[] {
  if (events.length <= PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS) {
    return events;
  }
  const prefixCount =
    PROTECTED_STENOGRAPHER_COMPACTION_MAX_EVENT_INPUTS
    - EVENT_COMPACTION_PROTECTED_TAIL;
  return Object.freeze([
    ...events.slice(0, prefixCount),
    ...events.slice(-EVENT_COMPACTION_PROTECTED_TAIL),
  ]);
}

export function planProtectedStenographerCompaction(input: Readonly<{
  readonly events: readonly ProtectedStenographerCompactionEventMetadata[];
  readonly latestRollup: ProtectedStenographerCompactionRollupMetadata | null;
  readonly force?: boolean;
}>): ProtectedStenographerCompactionPlanningResult {
  try {
    if (
      !Array.isArray(input.events)
      || (
        input.force !== undefined
        && typeof input.force !== "boolean"
      )
    ) {
      return Object.freeze({
        status: "blocked",
        reason: "invalid_metadata",
      });
    }
    const latestRollup = input.latestRollup === null
      ? null
      : validateRollup(input.latestRollup);
    const validated = input.events.map(validateEvent);
    for (let index = 1; index < validated.length; index++) {
      if (validated[index]!.sequence <= validated[index - 1]!.sequence) {
        return Object.freeze({
          status: "blocked",
          reason: validated[index]!.sequence
              === validated[index - 1]!.sequence
            ? "duplicate_identity"
            : "out_of_order",
        });
      }
    }
    const roomId = latestRollup?.roomId ?? validated[0]?.roomId ?? null;
    const namespaceId =
      latestRollup?.namespaceId ?? validated[0]?.namespaceId ?? null;
    if (
      roomId === null
      || namespaceId === null
      || validated.some((event) =>
        event.roomId !== roomId || event.namespaceId !== namespaceId
      )
      || (
        latestRollup !== null
        && (
          latestRollup.roomId !== roomId
          || latestRollup.namespaceId !== namespaceId
        )
      )
    ) {
      return Object.freeze({
        status: "blocked",
        reason: "invalid_metadata",
      });
    }
    const active = validated.filter(
      (event) =>
        event.status === "active"
        && event.sequence > (latestRollup?.throughEventSequence ?? 0),
    );
    if (
      input.force !== true
      && active.length < PROTECTED_STENOGRAPHER_COMPACTION_EVENT_TRIGGER
    ) {
      return Object.freeze({ status: "wait", reason: "not_due" });
    }
    const selected = selectedBoundedEvents(active);
    const bindings = Object.freeze([
      ...(latestRollup === null ? [] : [rollupBinding(latestRollup)]),
      ...selected.map(eventBinding),
    ]);
    const inputObjectIds = Object.freeze(
      bindings.map((binding) => binding.objectId),
    );
    if (new Set(inputObjectIds).size !== inputObjectIds.length) {
      return Object.freeze({
        status: "blocked",
        reason: "duplicate_identity",
      });
    }
    return Object.freeze({
      status: "authorize",
      bindings,
      inputObjectIds,
      sourceBindingFingerprint:
        fingerprintProtectedStenographerSourceBindings(bindings),
      activeEventCount: active.length,
      selectedEventCount: selected.length,
      hasDeferredMiddle: selected.length < active.length,
    });
  } catch {
    return Object.freeze({
      status: "blocked",
      reason: "protected_source_unavailable",
    });
  }
}

export type {
  RoomEventPayloadKindV1 as ProtectedStenographerCompactionEventKind,
};
