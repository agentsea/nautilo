import {LATTICE_LIMITS} from "@nautilo/lattice-crypto";
import {
  copyOutputRepairBindingV2,
  STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  type ProcessorOutputRepairBindingV2,
} from "@nautilo/lattice-crypto/background";
import {bytesToHex, hexToBytes} from "@noble/hashes/utils.js";

import type {
  ForegroundJournalProtectedMapping,
  ForegroundJournalSelectedEvent,
  ForegroundJournalSelectedRollup,
  ForegroundJournalSelectionSnapshot,
} from "./foreground-journal-selection.ts";
import {
  assertCanonicalJournalPayload,
  assertExactFields,
  assertRequiredFields,
  canonicalTimestamp,
  canonicalUuid,
  denseArray,
  encodeCanonicalJournalPayload,
  nullableCanonicalUuid,
  ownRecord,
  parseCanonicalJournalPayload,
  portableIdentifier,
  postgresInteger,
} from "./journal-payload-codec.ts";
import type {RoomEventPayloadKindV1} from "./room-event-payload-v1.ts";

export const STENOGRAPHER_OUTPUT_REPAIR_PLAN_VERSION = 2 as const;

// Matches the existing product attachment-plan receipt ceiling. This portable
// codec cannot import the server-owned database schema that enforces it.
const STENOGRAPHER_OUTPUT_REPAIR_PLAN_MAX_BYTES = 128 * 1_024;
const HEX_32 = /^[0-9a-f]{64}$/u;
const EVENT_KINDS = new Set<RoomEventPayloadKindV1>([
  "decision",
  "commitment",
  "goal",
  "state_change",
  "fact",
  "preference_or_norm",
  "open_question",
  "risk",
]);

export interface StenographerOutputRepairPlan {
  readonly version: 2;
  readonly binding: ProcessorOutputRepairBindingV2;
  readonly snapshot: ForegroundJournalSelectionSnapshot;
}

function record(
  label: string,
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!ownRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactFields(label, value, fields);
  assertRequiredFields(label, value, fields);
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function portableId(label: string, value: unknown): string {
  const result = portableIdentifier(label, value);
  if (new TextEncoder().encode(result).length > LATTICE_LIMITS.idBytes) {
    throw new RangeError(`${label} is too long`);
  }
  return result;
}

function exactFingerprint(value: unknown): Uint8Array {
  if (typeof value !== "string" || !HEX_32.test(value)) {
    throw new TypeError("Stenographer repair fingerprint is invalid");
  }
  return hexToBytes(value);
}

function parseReceipt(value: unknown): ProcessorOutputRepairBindingV2["receipt"] {
  const input = record("Stenographer repair receipt", value, [
    "fallbackReason",
    "id",
    "kind",
    "namespaceId",
    "ordinaryOutputFingerprint",
    "rebuildGeneration",
    "roomId",
  ]);
  const kind = input["kind"];
  const fallbackReason = input["fallbackReason"];
  if ((kind !== "extraction" && kind !== "compaction")
    || (fallbackReason !== "device" && fallbackReason !== "authority")) {
    throw new TypeError("Stenographer repair receipt authority is invalid");
  }
  return Object.freeze({
    kind,
    id: portableId("Stenographer repair receipt", input["id"]),
    roomId: canonicalUuid("Stenographer repair Room", input["roomId"]),
    namespaceId: canonicalUuid(
      "Stenographer repair Namespace",
      input["namespaceId"],
    ),
    rebuildGeneration: counter(
      "Stenographer repair rebuild generation",
      input["rebuildGeneration"],
    ),
    fallbackReason,
    ordinaryOutputFingerprint: exactFingerprint(
      input["ordinaryOutputFingerprint"],
    ),
  });
}

function parseOutputs(
  value: unknown,
): ProcessorOutputRepairBindingV2["outputs"] {
  const input = denseArray(
    "Stenographer repair outputs",
    value,
    1,
    STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  );
  const logicalIds = new Set<string>();
  const objectIds = new Set<string>();
  return Object.freeze(input.map((entry) => {
    const output = record("Stenographer repair output", entry, [
      "createdAt",
      "disposition",
      "logicalId",
      "objectId",
      "objectType",
      "ordinaryRepresentationGeneration",
      "representationGeneration",
    ]);
    const logicalId = portableId(
      "Stenographer repair logical output",
      output["logicalId"],
    );
    const objectId = portableId(
      "Stenographer repair crypto output",
      output["objectId"],
    );
    const objectType = output["objectType"];
    const disposition = output["disposition"];
    if (logicalIds.has(logicalId) || objectIds.has(objectId)
      || (objectType !== "nautilo.reflection.record.v1"
        && objectType !== "room_event_rollup")
      || (disposition !== "existing" && disposition !== "create")) {
      throw new TypeError("Stenographer repair output inventory is invalid");
    }
    logicalIds.add(logicalId);
    objectIds.add(objectId);
    const ordinary = output["ordinaryRepresentationGeneration"];
    return Object.freeze({
      logicalId,
      objectId,
      objectType,
      createdAt: counter("Stenographer repair output timestamp", output["createdAt"]),
      disposition,
      representationGeneration: counter(
        "Stenographer repair representation generation",
        output["representationGeneration"],
      ),
      ordinaryRepresentationGeneration: ordinary === null
        ? null
        : counter("Stenographer repair ordinary generation", ordinary),
    });
  }));
}

function parseBinding(value: unknown): ProcessorOutputRepairBindingV2 {
  const input = record("Stenographer repair binding", value, [
    "outputs",
    "receipt",
  ]);
  return copyOutputRepairBindingV2(Object.freeze({
    receipt: parseReceipt(input["receipt"]),
    outputs: parseOutputs(input["outputs"]),
  }));
}

function parseProtectedMapping(
  label: string,
  value: unknown,
  includeGeneration: boolean,
): ForegroundJournalProtectedMapping | Extract<
  ForegroundJournalSelectedEvent["payload"],
  Readonly<{kind: "reflection_record"}>
>["protectedMapping"] {
  if (!ownRecord(value) || value["status"] === undefined) {
    throw new TypeError(`${label} is invalid`);
  }
  if (value["status"] === "missing") {
    assertExactFields(label, value, ["status"]);
    assertRequiredFields(label, value, ["status"]);
    return Object.freeze({status: "missing" as const});
  }
  const fields = includeGeneration
    ? ["cryptoObjectId", "representationGeneration", "status"]
    : ["cryptoObjectId", "status"];
  assertExactFields(label, value, fields);
  assertRequiredFields(label, value, fields);
  if (value["status"] !== "mapped") {
    throw new TypeError(`${label} status is invalid`);
  }
  const common = {
    status: "mapped" as const,
    cryptoObjectId: portableId(`${label} object`, value["cryptoObjectId"]),
  };
  return includeGeneration
    ? Object.freeze({...common, representationGeneration: counter(
        `${label} generation`,
        value["representationGeneration"],
        1,
      )})
    : Object.freeze(common);
}

function parseEvent(value: unknown): ForegroundJournalSelectedEvent {
  const input = record("Stenographer repair event", value, [
    "binding",
    "kind",
    "payload",
    "rebuildGeneration",
    "status",
  ]);
  if (input["kind"] !== "event") {
    throw new TypeError("Stenographer repair event kind is invalid");
  }
  const status = input["status"];
  if (status !== "active" && status !== "superseded" && status !== "resolved") {
    throw new TypeError("Stenographer repair event status is invalid");
  }
  const binding = record("Stenographer repair event binding", input["binding"], [
    "batchLocalOrdinal",
    "createdAt",
    "eventId",
    "extractorVersion",
    "kind",
    "namespaceId",
    "resolvesEventId",
    "roomId",
    "sequence",
    "sourceBatchId",
    "sourceMessageIds",
    "supersedesEventId",
  ]);
  const kind = binding["kind"];
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind as RoomEventPayloadKindV1)) {
    throw new TypeError("Stenographer repair event payload kind is invalid");
  }
  const sourceIds = denseArray(
    "Stenographer repair event sources",
    binding["sourceMessageIds"],
    1,
    16,
  ).map((entry) => postgresInteger("Stenographer repair source Message", entry, 1));
  if (sourceIds.some((entry, index) => index > 0 && sourceIds[index - 1]! >= entry)) {
    throw new TypeError("Stenographer repair event sources are not canonical");
  }
  const payload = record("Stenographer repair Record", input["payload"], [
    "kind",
    "lifecycle",
    "ordinaryRepresentationGeneration",
    "processingGeneration",
    "protectedMapping",
    "recordId",
    "structuralHeight",
  ]);
  const lifecycle = payload["lifecycle"];
  if (payload["kind"] !== "reflection_record"
    || (lifecycle !== "current" && lifecycle !== "stale"
      && lifecycle !== "superseded" && lifecycle !== "resolved"
      && lifecycle !== "sunset")) {
    throw new TypeError("Stenographer repair native Record is invalid");
  }
  const eventId = canonicalUuid("Stenographer repair event", binding["eventId"]);
  const recordId = portableId("Stenographer repair Record", payload["recordId"]);
  if (recordId !== eventId) {
    throw new TypeError("Stenographer repair native Record identity changed");
  }
  return Object.freeze({
    kind: "event" as const,
    rebuildGeneration: counter(
      "Stenographer repair event rebuild generation",
      input["rebuildGeneration"],
    ),
    status,
    binding: Object.freeze({
      eventId,
      roomId: canonicalUuid("Stenographer repair event Room", binding["roomId"]),
      namespaceId: canonicalUuid(
        "Stenographer repair event Namespace",
        binding["namespaceId"],
      ),
      sequence: postgresInteger("Stenographer repair event sequence", binding["sequence"], 1),
      kind: kind as RoomEventPayloadKindV1,
      supersedesEventId: nullableCanonicalUuid(
        "Stenographer repair superseded event",
        binding["supersedesEventId"],
      ),
      resolvesEventId: nullableCanonicalUuid(
        "Stenographer repair resolved event",
        binding["resolvesEventId"],
      ),
      sourceMessageIds: Object.freeze(sourceIds),
      sourceBatchId: canonicalUuid(
        "Stenographer repair source batch",
        binding["sourceBatchId"],
      ),
      batchLocalOrdinal: postgresInteger(
        "Stenographer repair event ordinal",
        binding["batchLocalOrdinal"],
        0,
      ),
      extractorVersion: portableId(
        "Stenographer repair extractor",
        binding["extractorVersion"],
      ),
      createdAt: canonicalTimestamp(
        "Stenographer repair event timestamp",
        binding["createdAt"],
      ),
    }),
    payload: Object.freeze({
      kind: "reflection_record" as const,
      recordId,
      lifecycle,
      structuralHeight: postgresInteger(
        "Stenographer repair Record height",
        payload["structuralHeight"],
        0,
      ),
      processingGeneration: postgresInteger(
        "Stenographer repair Record processing generation",
        payload["processingGeneration"],
        1,
      ),
      ordinaryRepresentationGeneration: postgresInteger(
        "Stenographer repair ordinary Record generation",
        payload["ordinaryRepresentationGeneration"],
        1,
      ),
      protectedMapping: parseProtectedMapping(
        "Stenographer repair protected Record mapping",
        payload["protectedMapping"],
        true,
      ) as Extract<ForegroundJournalSelectedEvent["payload"],
        Readonly<{kind: "reflection_record"}>>["protectedMapping"],
    }),
  });
}

function parseRollup(value: unknown): ForegroundJournalSelectedRollup {
  const input = record("Stenographer repair rollup", value, [
    "binding",
    "kind",
    "protectedMapping",
    "rebuildGeneration",
  ]);
  if (input["kind"] !== "rollup") {
    throw new TypeError("Stenographer repair rollup kind is invalid");
  }
  const binding = record("Stenographer repair rollup binding", input["binding"], [
    "compactorVersion",
    "createdAt",
    "modelId",
    "namespaceId",
    "rollupId",
    "roomId",
    "sourceEventCount",
    "throughEventSequence",
  ]);
  return Object.freeze({
    kind: "rollup" as const,
    rebuildGeneration: counter(
      "Stenographer repair rollup rebuild generation",
      input["rebuildGeneration"],
    ),
    binding: Object.freeze({
      rollupId: canonicalUuid("Stenographer repair rollup", binding["rollupId"]),
      roomId: canonicalUuid("Stenographer repair rollup Room", binding["roomId"]),
      namespaceId: canonicalUuid(
        "Stenographer repair rollup Namespace",
        binding["namespaceId"],
      ),
      throughEventSequence: postgresInteger(
        "Stenographer repair rollup sequence",
        binding["throughEventSequence"],
        1,
      ),
      sourceEventCount: postgresInteger(
        "Stenographer repair rollup source count",
        binding["sourceEventCount"],
        1,
      ),
      modelId: portableId("Stenographer repair rollup model", binding["modelId"]),
      compactorVersion: portableId(
        "Stenographer repair rollup compactor",
        binding["compactorVersion"],
      ),
      createdAt: canonicalTimestamp(
        "Stenographer repair rollup timestamp",
        binding["createdAt"],
      ),
    }),
    protectedMapping: parseProtectedMapping(
      "Stenographer repair rollup mapping",
      input["protectedMapping"],
      false,
    ) as ForegroundJournalProtectedMapping,
  });
}

function parseSnapshot(value: unknown): ForegroundJournalSelectionSnapshot {
  const input = record("Stenographer repair snapshot", value, [
    "events",
    "namespaceId",
    "rebuildGeneration",
    "rollup",
    "roomId",
  ]);
  const events = denseArray(
    "Stenographer repair snapshot events",
    input["events"],
    0,
    STENOGRAPHER_BACKGROUND_MAX_OUTPUTS_V2,
  ).map(parseEvent);
  return Object.freeze({
    roomId: canonicalUuid("Stenographer repair snapshot Room", input["roomId"]),
    namespaceId: canonicalUuid(
      "Stenographer repair snapshot Namespace",
      input["namespaceId"],
    ),
    rebuildGeneration: counter(
      "Stenographer repair snapshot rebuild generation",
      input["rebuildGeneration"],
    ),
    rollup: input["rollup"] === null ? null : parseRollup(input["rollup"]),
    events: Object.freeze(events),
  });
}

function assertOutput(
  output: ProcessorOutputRepairBindingV2["outputs"][number],
  expected: Readonly<{
    logicalId: string;
    objectType: ProcessorOutputRepairBindingV2["outputs"][number]["objectType"];
    createdAt?: number;
    protectedMapping: ForegroundJournalProtectedMapping | Extract<
      ForegroundJournalSelectedEvent["payload"],
      Readonly<{kind: "reflection_record"}>
    >["protectedMapping"];
    representationGeneration: number;
    ordinaryRepresentationGeneration: number | null;
  }>,
): void {
  const mapping = expected.protectedMapping;
  if (output.logicalId !== expected.logicalId
    || output.objectType !== expected.objectType
    || (expected.createdAt !== undefined && output.createdAt !== expected.createdAt)
    || output.representationGeneration !== expected.representationGeneration
    || output.ordinaryRepresentationGeneration
      !== expected.ordinaryRepresentationGeneration
    || (mapping.status === "mapped"
      ? output.disposition !== "existing"
        || output.objectId !== mapping.cryptoObjectId
      : output.disposition !== "create")) {
    throw new TypeError("Stenographer repair binding differs from its snapshot");
  }
}

function assertBoundPlan(plan: StenographerOutputRepairPlan): void {
  const {receipt, outputs} = plan.binding;
  const snapshot = plan.snapshot;
  if (receipt.roomId !== snapshot.roomId
    || receipt.namespaceId !== snapshot.namespaceId
    || receipt.rebuildGeneration !== snapshot.rebuildGeneration) {
    throw new TypeError("Stenographer repair scope differs from its snapshot");
  }
  if (receipt.kind === "extraction") {
    if (snapshot.rollup !== null || outputs.length !== snapshot.events.length) {
      throw new TypeError("Stenographer extraction repair inventory changed");
    }
    let previousOrdinal = -1;
    let previousSequence = 0;
    for (const [index, event] of snapshot.events.entries()) {
      if (event.rebuildGeneration !== snapshot.rebuildGeneration
        || event.binding.roomId !== snapshot.roomId
        || event.binding.namespaceId !== snapshot.namespaceId
        || event.binding.sourceBatchId !== receipt.id
        || event.binding.batchLocalOrdinal <= previousOrdinal
        || (index > 0 && event.binding.sequence <= previousSequence)
        || event.payload.kind !== "reflection_record") {
        throw new TypeError("Stenographer extraction repair source changed");
      }
      previousOrdinal = event.binding.batchLocalOrdinal;
      previousSequence = event.binding.sequence;
      const mapping = event.payload.protectedMapping;
      assertOutput(outputs[index]!, {
        logicalId: event.payload.recordId,
        objectType: "nautilo.reflection.record.v1",
        // Native payload time is independent of the event observation time.
        // The current product validator binds it to the selected representation.
        protectedMapping: mapping,
        representationGeneration: mapping.status === "mapped"
          ? mapping.representationGeneration
          : 1,
        ordinaryRepresentationGeneration:
          event.payload.ordinaryRepresentationGeneration,
      });
    }
    return;
  }
  if (snapshot.events.length !== 0 || snapshot.rollup === null
    || outputs.length !== 1) {
    throw new TypeError("Stenographer compaction repair inventory changed");
  }
  const rollup = snapshot.rollup;
  if (rollup.rebuildGeneration !== snapshot.rebuildGeneration
    || rollup.binding.rollupId !== receipt.id
    || rollup.binding.roomId !== snapshot.roomId
    || rollup.binding.namespaceId !== snapshot.namespaceId) {
    throw new TypeError("Stenographer compaction repair source changed");
  }
  assertOutput(outputs[0]!, {
    logicalId: rollup.binding.rollupId,
    objectType: "room_event_rollup",
    createdAt: Date.parse(rollup.binding.createdAt),
    protectedMapping: rollup.protectedMapping,
    representationGeneration: snapshot.rebuildGeneration,
    ordinaryRepresentationGeneration: null,
  });
}

function normalizedPlan(value: unknown): StenographerOutputRepairPlan {
  const input = record("Stenographer output repair plan", value, [
    "binding",
    "snapshot",
    "version",
  ]);
  if (input["version"] !== STENOGRAPHER_OUTPUT_REPAIR_PLAN_VERSION) {
    throw new TypeError("Stenographer output repair plan version is invalid");
  }
  const plan: StenographerOutputRepairPlan = Object.freeze({
    version: STENOGRAPHER_OUTPUT_REPAIR_PLAN_VERSION,
    binding: parseBinding(input["binding"]),
    snapshot: parseSnapshot(input["snapshot"]),
  });
  assertBoundPlan(plan);
  return plan;
}

function wirePlan(plan: StenographerOutputRepairPlan): Readonly<object> {
  return {
    version: plan.version,
    binding: {
      receipt: {
        ...plan.binding.receipt,
        ordinaryOutputFingerprint: bytesToHex(
          plan.binding.receipt.ordinaryOutputFingerprint,
        ),
      },
      outputs: plan.binding.outputs.map((output) => ({...output})),
    },
    snapshot: plan.snapshot,
  };
}

export function encodeStenographerOutputRepairPlan(
  value: StenographerOutputRepairPlan,
): Uint8Array {
  const plan = normalizedPlan(wirePlan(value));
  const bytes = encodeCanonicalJournalPayload(
    "Stenographer output repair plan",
    wirePlan(plan),
  );
  if (bytes.length > STENOGRAPHER_OUTPUT_REPAIR_PLAN_MAX_BYTES) {
    throw new RangeError("Stenographer output repair plan bytes are excessive");
  }
  return bytes;
}

export function decodeStenographerOutputRepairPlan(
  bytes: Uint8Array,
): StenographerOutputRepairPlan {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1
    || bytes.length > STENOGRAPHER_OUTPUT_REPAIR_PLAN_MAX_BYTES) {
    throw new RangeError("Stenographer output repair plan bytes are out of bounds");
  }
  const plan = normalizedPlan(parseCanonicalJournalPayload(
    "Stenographer output repair plan",
    bytes,
  ));
  const canonical = encodeStenographerOutputRepairPlan(plan);
  try {
    assertCanonicalJournalPayload(
      "Stenographer output repair plan",
      bytes,
      canonical,
    );
  } finally {
    canonical.fill(0);
  }
  return plan;
}
