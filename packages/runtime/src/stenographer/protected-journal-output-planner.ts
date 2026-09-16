import {decodeStenographerOutputRepairPlan} from "@nautilo/lattice-bridge";
import type { ProcessorTransformOutput } from "@nautilo/lattice-crypto";
import {STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2} from "@nautilo/lattice-crypto/background";
import {
  encodeRoomEventRollupPayloadV1,
  type RoomEventPayloadKindV1,
} from "@nautilo/lattice-bridge";
import {
  buildStenographerRecordPublication,
  encodeDurableRecordEnvelope,
  type StenographerMessageBinding,
} from "@nautilo/reflection-bridge/server";

import {
  planEventTransitions,
  type PlannedEventStatusUpdate,
} from "./event-transition-planner";
import type {
  EffectiveRoomEvent,
  StenographerOperation,
} from "./types";

export const PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1 = 1 as const;
export const PROTECTED_JOURNAL_ATTACHMENT_PLAN_MAX_BYTES_V1 = 128 * 1_024;
export const PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1 =
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2;
/**
 * A non-secret marker for legacy non-null product columns. Readers in
 * protected mode select the unique crypto mapping and never render this value.
 */
export const PROTECTED_JOURNAL_CONTENT_SENTINEL = "[protected:v1]";

export interface ProtectedJournalEventAttachmentV1 {
  readonly eventId: string;
  readonly objectId: string;
  readonly sequence: number;
  readonly kind: RoomEventPayloadKindV1;
  readonly status: "active";
  readonly supersedesEventId: string | null;
  readonly resolvesEventId: string | null;
  readonly sourceMessageIds: readonly number[];
  readonly sourceBatchId: string;
  readonly batchLocalOrdinal: number;
  readonly extractorVersion: string;
  readonly createdAt: string;
}

export interface ProtectedJournalRollupAttachmentV1 {
  readonly rollupId: string;
  readonly objectId: string;
  readonly throughEventSequence: number;
  readonly sourceEventCount: number;
  readonly modelId: string;
  readonly compactorVersion: string;
  readonly createdAt: string;
}

export interface ProtectedJournalAttachmentPlanV1 {
  readonly kind: "extraction" | "rollup";
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly sourceBatchId: string | null;
  readonly statusUpdates: readonly PlannedEventStatusUpdate[];
  readonly events: readonly ProtectedJournalEventAttachmentV1[];
  readonly foldedBatchLocalOrdinals: readonly number[];
  readonly rollup: ProtectedJournalRollupAttachmentV1 | null;
}

export interface ProtectedJournalPlannedOutputsV1 {
  readonly outputs: readonly ProcessorTransformOutput[];
  readonly attachmentPlan: ProtectedJournalAttachmentPlanV1;
  readonly attachmentPlanBytes: Uint8Array;
  readonly productPlaceholder: typeof PROTECTED_JOURNAL_CONTENT_SENTINEL;
}

export type ProtectedExtractionOutputPlanningResultV1 =
  | (Readonly<{ readonly status: "planned" }>
    & ProtectedJournalPlannedOutputsV1)
  | Readonly<{
    readonly status: "rejected";
    readonly reason:
      | "invalid_existing_graph"
      | "target_not_found"
      | "target_cross_room"
      | "target_not_active";
  }>;

interface ProtectedEventOutputSlotV1 {
  readonly eventId: string;
  readonly objectId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function portableId(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function integer(label: string, value: unknown, minimum: 0 | 1): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > 2_147_483_647
  ) {
    throw new RangeError(`${label} is out of bounds`);
  }
  return value as number;
}

function timestamp(label: string, value: unknown): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return value;
}

function eventKind(value: unknown): RoomEventPayloadKindV1 {
  if (
    value !== "decision"
    && value !== "commitment"
    && value !== "goal"
    && value !== "state_change"
    && value !== "fact"
    && value !== "preference_or_norm"
    && value !== "open_question"
    && value !== "risk"
  ) {
    throw new TypeError("protected journal event kind is invalid");
  }
  return value;
}

function sourceIds(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new RangeError("protected journal source IDs are out of bounds");
  }
  const ids = value.map((entry) =>
    integer("protected journal source ID", entry, 1)
  );
  if (
    ids.some((entry, index) =>
      index > 0 && entry <= ids[index - 1]!
    )
  ) {
    throw new TypeError(
      "protected journal source IDs must be ascending and unique",
    );
  }
  return Object.freeze(ids);
}

function normalizedStatusUpdate(
  value: unknown,
): PlannedEventStatusUpdate {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError("protected journal status update is malformed");
  }
  const fromStatus: unknown = value[1];
  const toStatus: unknown = value[2];
  if (
    fromStatus !== "active"
    || (toStatus !== "superseded" && toStatus !== "resolved")
  ) {
    throw new TypeError("protected journal status transition is invalid");
  }
  return Object.freeze({
    eventId: uuid("protected journal updated event", value[0]),
    fromStatus,
    toStatus,
  });
}

function normalizedEvent(
  value: unknown,
): ProtectedJournalEventAttachmentV1 {
  if (!Array.isArray(value) || value.length !== 12) {
    throw new TypeError("protected journal event attachment is malformed");
  }
  if (value[4] !== "active") {
    throw new TypeError("protected journal event attachment status is invalid");
  }
  const supersedes = value[5] === null
    ? null
    : uuid("protected journal superseded event", value[5]);
  const resolves = value[6] === null
    ? null
    : uuid("protected journal resolved event", value[6]);
  if (supersedes !== null && resolves !== null) {
    throw new TypeError("protected journal event has two transition links");
  }
  return Object.freeze({
    eventId: uuid("protected journal event", value[0]),
    objectId: portableId("protected journal object", value[1]),
    sequence: integer("protected journal event sequence", value[2], 1),
    kind: eventKind(value[3]),
    status: "active",
    supersedesEventId: supersedes,
    resolvesEventId: resolves,
    sourceMessageIds: sourceIds(value[7]),
    sourceBatchId: uuid("protected journal source batch", value[8]),
    batchLocalOrdinal: integer(
      "protected journal batch ordinal",
      value[9],
      0,
    ),
    extractorVersion: portableId(
      "protected journal extractor version",
      value[10],
    ),
    createdAt: timestamp("protected journal event timestamp", value[11]),
  });
}

function eventTuple(
  event: ProtectedJournalEventAttachmentV1,
): readonly unknown[] {
  return [
    event.eventId,
    event.objectId,
    event.sequence,
    event.kind,
    event.status,
    event.supersedesEventId,
    event.resolvesEventId,
    event.sourceMessageIds,
    event.sourceBatchId,
    event.batchLocalOrdinal,
    event.extractorVersion,
    event.createdAt,
  ];
}

function normalizedRollup(
  value: unknown,
): ProtectedJournalRollupAttachmentV1 | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 7) {
    throw new TypeError("protected journal rollup attachment is malformed");
  }
  return Object.freeze({
    rollupId: uuid("protected journal rollup", value[0]),
    objectId: portableId("protected journal rollup object", value[1]),
    throughEventSequence: integer(
      "protected journal rollup sequence",
      value[2],
      1,
    ),
    sourceEventCount: integer(
      "protected journal rollup source count",
      value[3],
      1,
    ),
    modelId: portableId("protected journal rollup model", value[4]),
    compactorVersion: portableId(
      "protected journal compactor version",
      value[5],
    ),
    createdAt: timestamp("protected journal rollup timestamp", value[6]),
  });
}

function rollupTuple(
  rollup: ProtectedJournalRollupAttachmentV1 | null,
): readonly unknown[] | null {
  if (rollup === null) return null;
  return [
    rollup.rollupId,
    rollup.objectId,
    rollup.throughEventSequence,
    rollup.sourceEventCount,
    rollup.modelId,
    rollup.compactorVersion,
    rollup.createdAt,
  ];
}

function planTuple(plan: ProtectedJournalAttachmentPlanV1): readonly unknown[] {
  return [
    "nautilo/protected-journal-attachment",
    PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1,
    plan.kind,
    plan.roomId,
    plan.namespaceId,
    plan.rebuildGeneration,
    plan.sourceBatchId,
    plan.statusUpdates.map((update) => [
      update.eventId,
      update.fromStatus,
      update.toStatus,
    ]),
    plan.events.map(eventTuple),
    plan.foldedBatchLocalOrdinals,
    rollupTuple(plan.rollup),
  ];
}

export function encodeProtectedJournalAttachmentPlanV1(
  plan: ProtectedJournalAttachmentPlanV1,
): Uint8Array {
  const normalized = normalizePlanTuple(planTuple(plan));
  const bytes = encoder.encode(JSON.stringify(planTuple(normalized)));
  if (
    bytes.length < 1
    || bytes.length > PROTECTED_JOURNAL_ATTACHMENT_PLAN_MAX_BYTES_V1
  ) {
    throw new RangeError("protected journal attachment plan is out of bounds");
  }
  return bytes;
}

function normalizePlanTuple(value: unknown): ProtectedJournalAttachmentPlanV1 {
  if (
    !Array.isArray(value)
    || value.length !== 11
    || value[0] !== "nautilo/protected-journal-attachment"
    || value[1] !== PROTECTED_JOURNAL_ATTACHMENT_PLAN_VERSION_V1
    || (value[2] !== "extraction" && value[2] !== "rollup")
    || !Array.isArray(value[7])
    || !Array.isArray(value[8])
    || !Array.isArray(value[9])
  ) {
    throw new TypeError("protected journal attachment plan is malformed");
  }
  const statusUpdates = value[7].map(normalizedStatusUpdate);
  const events = value[8].map(normalizedEvent);
  const folded = value[9].map((entry) =>
    integer("protected journal folded ordinal", entry, 0)
  );
  const rollup = normalizedRollup(value[10]);
  const kind: "extraction" | "rollup" =
    value[2] === "extraction" ? "extraction" : "rollup";
  const sourceBatchId = value[6] === null
    ? null
    : uuid("protected journal attachment source batch", value[6]);
  const operationOrdinals = [
    ...events.map((event) => event.batchLocalOrdinal),
    ...folded,
  ].sort((left, right) => left - right);
  const transitionTargets = events.flatMap((event) => [
    ...(event.supersedesEventId === null ? [] : [event.supersedesEventId]),
    ...(event.resolvesEventId === null ? [] : [event.resolvesEventId]),
  ]).sort();
  const updatedTargets = statusUpdates.map((update) => update.eventId).sort();
  if (
    statusUpdates.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
    || events.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
    || folded.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
    || new Set(events.map((event) => event.eventId)).size !== events.length
    || new Set(events.map((event) => event.objectId)).size !== events.length
    || new Set(folded).size !== folded.length
    || new Set(statusUpdates.map((update) => update.eventId)).size
      !== statusUpdates.length
    || events.some(
      (event, index) =>
        index > 0 && event.sequence <= events[index - 1]!.sequence,
    )
    || operationOrdinals.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
    || operationOrdinals.some((ordinal, index) => ordinal !== index)
    || transitionTargets.length !== updatedTargets.length
    || transitionTargets.some(
      (target, index) => target !== updatedTargets[index],
    )
    || (kind === "extraction" && (sourceBatchId === null || rollup !== null))
    || (
      kind === "rollup"
      && (
        sourceBatchId !== null
        || statusUpdates.length !== 0
        || events.length !== 0
        || folded.length !== 0
        || rollup === null
      )
    )
  ) {
    throw new TypeError("protected journal attachment plan is incoherent");
  }
  return Object.freeze({
    kind,
    roomId: uuid("protected journal attachment Room", value[3]),
    namespaceId: uuid(
      "protected journal attachment Namespace",
      value[4],
    ),
    rebuildGeneration: integer(
      "protected journal rebuild generation",
      value[5],
      0,
    ),
    sourceBatchId,
    statusUpdates: Object.freeze(statusUpdates),
    events: Object.freeze(events),
    foldedBatchLocalOrdinals: Object.freeze(folded),
    rollup,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function decodeProtectedJournalAttachmentPlanV1(
  bytes: Uint8Array,
): ProtectedJournalAttachmentPlanV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > PROTECTED_JOURNAL_ATTACHMENT_PLAN_MAX_BYTES_V1
  ) {
    throw new RangeError("protected journal attachment plan is out of bounds");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new TypeError("protected journal attachment plan is malformed");
  }
  const plan = normalizePlanTuple(parsed);
  if (!bytesEqual(bytes, encodeProtectedJournalAttachmentPlanV1(plan))) {
    throw new TypeError(
      "protected journal attachment plan encoding is not canonical",
    );
  }
  return plan;
}

function validateSlots(
  slots: readonly ProtectedEventOutputSlotV1[],
): readonly ProtectedEventOutputSlotV1[] {
  const rawSlots: unknown = slots;
  if (
    !Array.isArray(rawSlots)
    || slots.length > PROTECTED_JOURNAL_MAX_OUTPUT_OBJECTS_V1
  ) {
    throw new RangeError("protected journal output slots are out of bounds");
  }
  const normalized = slots.map((slot) => Object.freeze({
    eventId: uuid("protected journal output event", slot.eventId),
    objectId: portableId("protected journal output object", slot.objectId),
  }));
  if (
    new Set(normalized.map((slot) => slot.eventId)).size !== normalized.length
    || new Set(normalized.map((slot) => slot.objectId)).size
      !== normalized.length
  ) {
    throw new TypeError("protected journal output slots are not unique");
  }
  return Object.freeze(normalized);
}

export function planProtectedExtractionOutputs(input: Readonly<{
  readonly roomId: string;
  readonly namespaceId: string;
  readonly sourceBatchId: string;
  readonly rebuildGeneration: number;
  readonly extractorVersion: string;
  readonly createdAt: string;
  readonly existingEvents: readonly EffectiveRoomEvent[];
  readonly operations: readonly StenographerOperation[];
  readonly outputSlots: readonly ProtectedEventOutputSlotV1[];
  readonly messageBindings: readonly StenographerMessageBinding[];
}>): ProtectedExtractionOutputPlanningResultV1 {
  const roomId = uuid("protected extraction Room", input.roomId);
  const namespaceId = uuid(
    "protected extraction Namespace",
    input.namespaceId,
  );
  const sourceBatchId = uuid(
    "protected extraction source batch",
    input.sourceBatchId,
  );
  const rebuildGeneration = integer(
    "protected extraction rebuild generation",
    input.rebuildGeneration,
    0,
  );
  const extractorVersion = portableId(
    "protected extraction version",
    input.extractorVersion,
  );
  const createdAt = timestamp(
    "protected extraction timestamp",
    input.createdAt,
  );
  const slots = validateSlots(input.outputSlots);
  const messageBindings = new Map(
    input.messageBindings.map((binding) => [binding.messageId, binding]),
  );
  if (messageBindings.size !== input.messageBindings.length) {
    throw new TypeError("protected extraction Message bindings are not unique");
  }
  const transition = planEventTransitions({
    roomId,
    events: input.existingEvents,
    operations: input.operations,
  });
  if (!transition.ok) {
    return Object.freeze({
      status: "rejected" as const,
      reason: transition.reason,
    });
  }
  if (transition.plan.inserts.length > slots.length) {
    throw new RangeError(
      "protected extraction has fewer output slots than actual outputs",
    );
  }
  const events = transition.plan.inserts.map((insert, index) => {
    const slot = slots[index]!;
    return Object.freeze({
      eventId: slot.eventId,
      objectId: slot.objectId,
      sequence: insert.sequence,
      kind: insert.kind,
      status: "active" as const,
      supersedesEventId: insert.supersedesEventId,
      resolvesEventId: insert.resolvesEventId,
      sourceMessageIds: Object.freeze([...insert.sourceMessageIds]),
      sourceBatchId,
      batchLocalOrdinal: insert.batchLocalOrdinal,
      extractorVersion,
      createdAt,
    });
  });
  const outputs = events.map((event, index) => {
    const insert = transition.plan.inserts[index]!;
    const sources = insert.sourceMessageIds.map((messageId) => {
      const binding = messageBindings.get(messageId);
      if (binding === undefined) {
        throw new TypeError("protected extraction source binding is unavailable");
      }
      return binding;
    });
    const transitionInput = event.supersedesEventId !== null
      ? {
          operation: "supersede" as const,
          predecessorEventId: event.supersedesEventId,
        }
      : event.resolvesEventId !== null
        ? {
            operation: "resolve" as const,
            predecessorEventId: event.resolvesEventId,
          }
        : { operation: "append" as const };
    const publication = buildStenographerRecordPublication({
      eventId: event.eventId,
      roomId,
      namespaceId,
      kind: event.kind,
      statement: insert.statement,
      sources,
      sourceBatchId,
      batchLocalOrdinal: event.batchLocalOrdinal,
      extractorVersion,
      rebuildGeneration,
      transition: transitionInput,
      publicationBindingRef: `journal:namespace:${namespaceId}:protected:v1`,
    });
    return Object.freeze({
      objectId: slots[index]!.objectId,
      plaintext: encodeDurableRecordEnvelope(publication.record),
    });
  });
  const attachmentPlan = Object.freeze({
    kind: "extraction" as const,
    roomId,
    namespaceId,
    rebuildGeneration,
    sourceBatchId,
    statusUpdates: Object.freeze([...transition.plan.statusUpdates]),
    events: Object.freeze(events),
    foldedBatchLocalOrdinals: Object.freeze([
      ...transition.plan.foldedBatchLocalOrdinals,
    ]),
    rollup: null,
  });
  return Object.freeze({
    status: "planned" as const,
    outputs: Object.freeze(outputs),
    attachmentPlan,
    attachmentPlanBytes:
      encodeProtectedJournalAttachmentPlanV1(attachmentPlan),
    productPlaceholder: PROTECTED_JOURNAL_CONTENT_SENTINEL,
  });
}

export function planProtectedRollupOutput(input: Readonly<{
  readonly roomId: string;
  readonly namespaceId: string;
  readonly rebuildGeneration: number;
  readonly rollupId: string;
  readonly outputObjectId: string;
  readonly throughEventSequence: number;
  readonly content: string;
  readonly sourceEventCount: number;
  readonly modelId: string;
  readonly compactorVersion: string;
  readonly createdAt: string;
}>): ProtectedJournalPlannedOutputsV1 {
  const roomId = uuid("protected rollup Room", input.roomId);
  const namespaceId = uuid("protected rollup Namespace", input.namespaceId);
  const rebuildGeneration = integer(
    "protected rollup rebuild generation",
    input.rebuildGeneration,
    0,
  );
  const rollup = Object.freeze({
    rollupId: uuid("protected rollup", input.rollupId),
    objectId: portableId(
      "protected rollup output object",
      input.outputObjectId,
    ),
    throughEventSequence: integer(
      "protected rollup sequence",
      input.throughEventSequence,
      1,
    ),
    sourceEventCount: integer(
      "protected rollup source count",
      input.sourceEventCount,
      1,
    ),
    modelId: portableId("protected rollup model", input.modelId),
    compactorVersion: portableId(
      "protected rollup compactor version",
      input.compactorVersion,
    ),
    createdAt: timestamp("protected rollup timestamp", input.createdAt),
  });
  const attachmentPlan = Object.freeze({
    kind: "rollup" as const,
    roomId,
    namespaceId,
    rebuildGeneration,
    sourceBatchId: null,
    statusUpdates: Object.freeze([]),
    events: Object.freeze([]),
    foldedBatchLocalOrdinals: Object.freeze([]),
    rollup,
  });
  return Object.freeze({
    outputs: Object.freeze([Object.freeze({
      objectId: rollup.objectId,
      plaintext: encodeRoomEventRollupPayloadV1({
        rollupId: rollup.rollupId,
        roomId,
        namespaceId,
        throughEventSequence: rollup.throughEventSequence,
        content: input.content,
        sourceEventCount: rollup.sourceEventCount,
        modelId: rollup.modelId,
        compactorVersion: rollup.compactorVersion,
        createdAt: rollup.createdAt,
      }),
    })]),
    attachmentPlan,
    attachmentPlanBytes:
      encodeProtectedJournalAttachmentPlanV1(attachmentPlan),
    productPlaceholder: PROTECTED_JOURNAL_CONTENT_SENTINEL,
  });
}

/** Both receipt versions share cleanup, but repair owns only newly created objects. */
export function protectedJournalPublicationPlanMetadata(bytes: Uint8Array): Readonly<{
  version: 1 | 2; roomId: string; namespaceId: string; rebuildGeneration: number;
  sourceBatchId: string | null; outputObjectIds: readonly string[];
}> {
  if (bytes[0] === 123) {
    const {binding} = decodeStenographerOutputRepairPlan(bytes);
    return {version: 2, roomId: binding.receipt.roomId, namespaceId: binding.receipt.namespaceId,
      rebuildGeneration: binding.receipt.rebuildGeneration,
      sourceBatchId: binding.receipt.kind === "extraction" ? binding.receipt.id : null,
      outputObjectIds: binding.outputs.filter(output => output.disposition === "create").map(output => output.objectId)};
  }
  const plan = decodeProtectedJournalAttachmentPlanV1(bytes);
  return {version: 1, roomId: plan.roomId, namespaceId: plan.namespaceId, rebuildGeneration: plan.rebuildGeneration,
    sourceBatchId: plan.sourceBatchId,
    outputObjectIds: plan.kind === "extraction" ? plan.events.map(event => event.objectId) : [plan.rollup!.objectId]};
}
