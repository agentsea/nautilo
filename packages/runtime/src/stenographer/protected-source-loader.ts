import { createHash } from "node:crypto";
import type { ProcessorTransformInput } from "@nautilo/lattice-crypto";
import {
  assertRoomEventPayloadBindingV1,
  assertRoomEventRollupPayloadBindingV1,
  decodeMessagePayloadV2,
  decodeRoomEventPayloadV1,
  decodeRoomEventRollupPayloadV1,
  type MessagePayloadV2,
  type MessageRoleV2,
  type RoomEventPayloadBindingV1,
  type RoomEventPayloadV1,
  type RoomEventRollupPayloadBindingV1,
  type RoomEventRollupPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  assertStenographerRecordPayloadBinding,
  decodeDurableRecordEnvelope,
} from "@nautilo/reflection-bridge/server";

import {
  PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS,
} from "./protected-batch-planner";

export const PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS = 64;
export const PROTECTED_STENOGRAPHER_MAX_DISPLAY_LABEL_CODE_POINTS = 256;
export const PROTECTED_STENOGRAPHER_MAX_DISPLAY_LABEL_BYTES = 1_024;

export type ProtectedStenographerSourceLoaderFailureCode =
  | "invalid_metadata"
  | "input_mismatch"
  | "payload_invalid"
  | "binding_mismatch"
  | "participant_projection_invalid";

export class ProtectedStenographerSourceLoaderError extends Error {
  readonly code: ProtectedStenographerSourceLoaderFailureCode;

  constructor(code: ProtectedStenographerSourceLoaderFailureCode) {
    super(`Protected Stenographer source loading failed: ${code}`);
    this.name = "ProtectedStenographerSourceLoaderError";
    this.code = code;
  }
}

export interface ProtectedStenographerMessageBinding {
  readonly kind: "message";
  readonly objectId: string;
  readonly source: "current" | "prior";
  readonly messageId: number;
  readonly editRevision: number;
  readonly createdAt: Date;
  readonly participantId: string;
  readonly role: MessageRoleV2;
  readonly conversationalBoundary: boolean;
}

export interface ProtectedStenographerEventBinding {
  readonly kind: "event";
  readonly objectId: string;
  readonly status: "active" | "superseded" | "resolved";
  readonly binding: RoomEventPayloadBindingV1;
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

export interface ProtectedStenographerRollupBinding {
  readonly kind: "rollup";
  readonly objectId: string;
  readonly binding: RoomEventRollupPayloadBindingV1;
}

export type ProtectedStenographerSourceBinding =
  | ProtectedStenographerMessageBinding
  | ProtectedStenographerEventBinding
  | ProtectedStenographerRollupBinding;

export interface ProtectedStenographerParticipantDisplay {
  readonly participantId: string;
  readonly displayLabel: string;
}

export interface OpenedProtectedStenographerMessage {
  readonly kind: "message";
  readonly objectId: string;
  readonly source: "current" | "prior";
  readonly messageId: number;
  readonly editRevision: number;
  readonly createdAt: Date;
  readonly participantId: string;
  readonly displayLabel: string;
  readonly role: MessageRoleV2;
  readonly conversationalBoundary: boolean;
  readonly payload: MessagePayloadV2;
}

export interface OpenedProtectedStenographerEvent {
  readonly kind: "event";
  readonly objectId: string;
  readonly status: "active" | "superseded" | "resolved";
  readonly payload: RoomEventPayloadV1;
}

export interface OpenedProtectedStenographerRollup {
  readonly kind: "rollup";
  readonly objectId: string;
  readonly payload: RoomEventRollupPayloadV1;
}

export type OpenedProtectedStenographerSource =
  | OpenedProtectedStenographerMessage
  | OpenedProtectedStenographerEvent
  | OpenedProtectedStenographerRollup;

export interface OpenedProtectedStenographerSources {
  readonly orderedSources: readonly OpenedProtectedStenographerSource[];
  readonly currentMessages: readonly OpenedProtectedStenographerMessage[];
  readonly priorMessages: readonly OpenedProtectedStenographerMessage[];
  readonly events: readonly OpenedProtectedStenographerEvent[];
  readonly latestRollup: OpenedProtectedStenographerRollup | null;
}

export interface WithProtectedStenographerSourcesInput {
  readonly openedInputs: readonly ProcessorTransformInput[];
  readonly bindings: readonly ProtectedStenographerSourceBinding[];
  readonly resolveParticipantDisplays: (
    participantIds: readonly string[],
  ) => Promise<readonly ProtectedStenographerParticipantDisplay[]>;
  readonly use: (
    sources: OpenedProtectedStenographerSources,
  ) => void | Promise<void>;
}

const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const textEncoder = new TextEncoder();

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function runtimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  code: ProtectedStenographerSourceLoaderFailureCode,
): void {
  const expected = new Set(fields);
  if (Reflect.ownKeys(value).length !== fields.length) {
    throw new ProtectedStenographerSourceLoaderError(code);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new ProtectedStenographerSourceLoaderError(code);
    }
  }
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string" || !expected.has(field)) {
      throw new ProtectedStenographerSourceLoaderError(code);
    }
  }
}

function portableId(
  value: unknown,
  code: ProtectedStenographerSourceLoaderFailureCode,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !PORTABLE_ID.test(value)
  ) {
    throw new ProtectedStenographerSourceLoaderError(code);
  }
  return value;
}

function safeCounter(
  value: unknown,
  minimum: 0 | 1,
  code: ProtectedStenographerSourceLoaderFailureCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ProtectedStenographerSourceLoaderError(code);
  }
  return value as number;
}

function role(value: unknown): MessageRoleV2 {
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  return value;
}

function validateMessageBinding(
  value: Record<string, unknown>,
): ProtectedStenographerMessageBinding {
  assertExactFields(value, [
    "kind",
    "objectId",
    "source",
    "messageId",
    "editRevision",
    "createdAt",
    "participantId",
    "role",
    "conversationalBoundary",
  ], "invalid_metadata");
  if (
    value["kind"] !== "message"
    || (value["source"] !== "current" && value["source"] !== "prior")
    || !(value["createdAt"] instanceof Date)
    || !Number.isFinite(value["createdAt"].getTime())
    || typeof value["conversationalBoundary"] !== "boolean"
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  return Object.freeze({
    kind: "message",
    objectId: portableId(value["objectId"], "invalid_metadata"),
    source: value["source"],
    messageId: safeCounter(value["messageId"], 1, "invalid_metadata"),
    editRevision: safeCounter(
      value["editRevision"],
      0,
      "invalid_metadata",
    ),
    createdAt: new Date(value["createdAt"]),
    participantId: portableId(
      value["participantId"],
      "invalid_metadata",
    ),
    role: role(value["role"]),
    conversationalBoundary: value["conversationalBoundary"],
  });
}

function validateEventBinding(
  value: Record<string, unknown>,
): ProtectedStenographerEventBinding {
  const native = value["payloadFormat"] === "record_v1";
  assertExactFields(value, [
    "kind",
    "objectId",
    "status",
    "binding",
    ...(native ? ["payloadFormat", "recordMetadata"] : []),
  ], "invalid_metadata");
  if (
    value["kind"] !== "event"
    || (
      value["status"] !== "active"
      && value["status"] !== "superseded"
      && value["status"] !== "resolved"
    )
    || !ownRecord(value["binding"])
    || (native && !ownRecord(value["recordMetadata"]))
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  const recordMetadata = native
    ? value["recordMetadata"] as Record<string, unknown>
    : undefined;
  if (recordMetadata !== undefined) {
    assertExactFields(recordMetadata, [
      "lifecycle",
      "structuralHeight",
      "processingGeneration",
    ], "invalid_metadata");
  }
  if (
    recordMetadata !== undefined
    && (
      ![
        "current",
        "stale",
        "superseded",
        "resolved",
        "sunset",
      ].includes(String(recordMetadata["lifecycle"]))
      || !Number.isSafeInteger(recordMetadata["structuralHeight"])
      || Number(recordMetadata["structuralHeight"]) < 0
      || !Number.isSafeInteger(recordMetadata["processingGeneration"])
      || Number(recordMetadata["processingGeneration"]) < 0
    )
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  return Object.freeze({
    kind: "event",
    objectId: portableId(value["objectId"], "invalid_metadata"),
    status: value["status"],
    binding: value["binding"] as unknown as RoomEventPayloadBindingV1,
    ...(recordMetadata === undefined
      ? {}
      : {
        payloadFormat: "record_v1" as const,
        recordMetadata: Object.freeze({
          lifecycle: recordMetadata["lifecycle"] as NonNullable<
            ProtectedStenographerEventBinding["recordMetadata"]
          >["lifecycle"],
          structuralHeight: Number(recordMetadata["structuralHeight"]),
          processingGeneration: Number(
            recordMetadata["processingGeneration"],
          ),
        }),
      }),
  });
}

function validateRollupBinding(
  value: Record<string, unknown>,
): ProtectedStenographerRollupBinding {
  assertExactFields(
    value,
    ["kind", "objectId", "binding"],
    "invalid_metadata",
  );
  if (value["kind"] !== "rollup" || !ownRecord(value["binding"])) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  return Object.freeze({
    kind: "rollup",
    objectId: portableId(value["objectId"], "invalid_metadata"),
    binding:
      value["binding"] as unknown as RoomEventRollupPayloadBindingV1,
  });
}

function validateBindings(
  value: readonly ProtectedStenographerSourceBinding[],
): readonly ProtectedStenographerSourceBinding[] {
  if (
    !Array.isArray(value)
    || value.length > PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  const normalized = value.map((binding) => {
    if (!ownRecord(binding)) {
      throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
    }
    switch (binding["kind"]) {
      case "message":
        return validateMessageBinding(binding);
      case "event":
        return validateEventBinding(binding);
      case "rollup":
        return validateRollupBinding(binding);
      default:
        throw new ProtectedStenographerSourceLoaderError(
          "invalid_metadata",
        );
    }
  });
  const ids = normalized.map((binding) => binding.objectId);
  if (new Set(ids).size !== ids.length) {
    throw new ProtectedStenographerSourceLoaderError("input_mismatch");
  }
  if (
    normalized.filter((binding) => binding.kind === "rollup").length > 1
  ) {
    throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
  }
  return Object.freeze(normalized);
}

function bindingFingerprintTuple(
  binding: ProtectedStenographerSourceBinding,
): readonly unknown[] {
  if (binding.kind === "message") {
    return [
      "message",
      binding.objectId,
      binding.source,
      binding.messageId,
      binding.editRevision,
      binding.createdAt.toISOString(),
      binding.participantId,
      binding.role,
      binding.conversationalBoundary,
    ];
  }
  if (binding.kind === "event") {
    return [
      "event",
      binding.objectId,
      binding.status,
      binding.binding.eventId,
      binding.binding.roomId,
      binding.binding.namespaceId,
      binding.binding.sequence,
      binding.binding.kind,
      binding.binding.supersedesEventId,
      binding.binding.resolvesEventId,
      binding.binding.sourceMessageIds,
      binding.binding.sourceBatchId,
      binding.binding.batchLocalOrdinal,
      binding.binding.extractorVersion,
      binding.binding.createdAt,
      binding.payloadFormat ?? "room_event_v1",
      ...(binding.recordMetadata === undefined
        ? []
        : [
          binding.recordMetadata.lifecycle,
          binding.recordMetadata.structuralHeight,
          binding.recordMetadata.processingGeneration,
        ]),
    ];
  }
  return [
    "rollup",
    binding.objectId,
    binding.binding.rollupId,
    binding.binding.roomId,
    binding.binding.namespaceId,
    binding.binding.throughEventSequence,
    binding.binding.sourceEventCount,
    binding.binding.modelId,
    binding.binding.compactorVersion,
    binding.binding.createdAt,
  ];
}

/**
 * Canonical content-free digest that binds the complete ordered protected
 * source inventory. Descriptor construction and execution use this same
 * function so product metadata cannot be substituted after device approval.
 */
export function fingerprintProtectedStenographerSourceBindings(
  bindings: readonly ProtectedStenographerSourceBinding[],
): Uint8Array {
  const normalized = validateBindings(bindings);
  const canonical = JSON.stringify([
    "nautilo/stenographer/protected-source-bindings/v1",
    normalized.map(bindingFingerprintTuple),
  ]);
  return Uint8Array.from(
    createHash("sha256").update(canonical, "utf8").digest(),
  );
}

function validateOpenedInputs(
  value: readonly ProcessorTransformInput[],
  bindings: readonly ProtectedStenographerSourceBinding[],
): void {
  if (
    !runtimeArray(value)
    || value.length !== bindings.length
    || value.length > PROTECTED_STENOGRAPHER_MAX_INPUT_OBJECTS
  ) {
    throw new ProtectedStenographerSourceLoaderError("input_mismatch");
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!ownRecord(item)) {
      throw new ProtectedStenographerSourceLoaderError("input_mismatch");
    }
    assertExactFields(
      item,
      ["objectId", "plaintext"],
      "input_mismatch",
    );
    const objectId = portableId(item["objectId"], "input_mismatch");
    if (
      objectId !== bindings[index]!.objectId
      || seen.has(objectId)
      || !(item["plaintext"] instanceof Uint8Array)
      || item["plaintext"].length < 1
    ) {
      throw new ProtectedStenographerSourceLoaderError("input_mismatch");
    }
    seen.add(objectId);
  }
}

type OpenedWithoutDisplay =
  | Readonly<{
    kind: "message";
    binding: ProtectedStenographerMessageBinding;
    payload: MessagePayloadV2;
  }>
  | OpenedProtectedStenographerEvent
  | OpenedProtectedStenographerRollup;

function decodeSources(
  openedInputs: readonly ProcessorTransformInput[],
  bindings: readonly ProtectedStenographerSourceBinding[],
): readonly OpenedWithoutDisplay[] {
  return Object.freeze(bindings.map((binding, index) => {
    const plaintext = openedInputs[index]!.plaintext;
    if (binding.kind === "message") {
      let payload: MessagePayloadV2;
      try {
        payload = decodeMessagePayloadV2(plaintext);
      } catch {
        throw new ProtectedStenographerSourceLoaderError(
          "payload_invalid",
        );
      }
      if (payload.role !== binding.role) {
        throw new ProtectedStenographerSourceLoaderError(
          "binding_mismatch",
        );
      }
      return Object.freeze({ kind: "message", binding, payload });
    }
    if (binding.kind === "event") {
      let payload: RoomEventPayloadV1;
      if (binding.payloadFormat === "record_v1") {
        if (binding.recordMetadata === undefined) {
          throw new ProtectedStenographerSourceLoaderError(
            "invalid_metadata",
          );
        }
        try {
          const envelope = decodeDurableRecordEnvelope({
            recordRef: binding.binding.eventId,
            lifecycle: binding.recordMetadata.lifecycle,
            structuralHeight: binding.recordMetadata.structuralHeight,
            processingGeneration:
              binding.recordMetadata.processingGeneration,
            payloadBytes: plaintext,
          });
          assertStenographerRecordPayloadBinding(envelope, {
            eventId: binding.binding.eventId,
            roomId: binding.binding.roomId,
            namespaceId: binding.binding.namespaceId,
            kind: binding.binding.kind,
            status: binding.status,
            sourceMessageIds: binding.binding.sourceMessageIds,
            extractorVersion: binding.binding.extractorVersion,
          });
          payload = {
            ...binding.binding,
            statement: envelope.semantic.statement,
          };
        } catch {
          throw new ProtectedStenographerSourceLoaderError(
            "binding_mismatch",
          );
        }
      } else {
        try {
          payload = decodeRoomEventPayloadV1(plaintext);
        } catch {
          throw new ProtectedStenographerSourceLoaderError(
            "payload_invalid",
          );
        }
        try {
          assertRoomEventPayloadBindingV1(payload, binding.binding);
        } catch {
          throw new ProtectedStenographerSourceLoaderError(
            "binding_mismatch",
          );
        }
      }
      return Object.freeze({
        kind: "event",
        objectId: binding.objectId,
        status: binding.status,
        payload,
      });
    }
    let payload: RoomEventRollupPayloadV1;
    try {
      payload = decodeRoomEventRollupPayloadV1(plaintext);
    } catch {
      throw new ProtectedStenographerSourceLoaderError("payload_invalid");
    }
    try {
      assertRoomEventRollupPayloadBindingV1(payload, binding.binding);
    } catch {
      throw new ProtectedStenographerSourceLoaderError(
        "binding_mismatch",
      );
    }
    return Object.freeze({
      kind: "rollup",
      objectId: binding.objectId,
      payload,
    });
  }));
}

function codePointLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function validDisplayLabel(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length
      > PROTECTED_STENOGRAPHER_MAX_DISPLAY_LABEL_CODE_POINTS * 2
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return (
    codePointLength(value)
      <= PROTECTED_STENOGRAPHER_MAX_DISPLAY_LABEL_CODE_POINTS
    && textEncoder.encode(value).length
      <= PROTECTED_STENOGRAPHER_MAX_DISPLAY_LABEL_BYTES
  );
}

async function participantDisplays(
  decoded: readonly OpenedWithoutDisplay[],
  resolve: WithProtectedStenographerSourcesInput[
    "resolveParticipantDisplays"
  ],
): Promise<ReadonlyMap<string, string>> {
  const participantIds = [
    ...new Set(
      decoded.flatMap((source) =>
        source.kind === "message"
          ? [source.binding.participantId]
          : []
      ),
    ),
  ];
  if (participantIds.length > PROTECTED_STENOGRAPHER_MAX_PARTICIPANTS) {
    throw new ProtectedStenographerSourceLoaderError(
      "participant_projection_invalid",
    );
  }
  if (participantIds.length === 0) return new Map();

  let projection: readonly ProtectedStenographerParticipantDisplay[];
  try {
    projection = await resolve(Object.freeze(participantIds));
  } catch {
    throw new ProtectedStenographerSourceLoaderError(
      "participant_projection_invalid",
    );
  }
  if (
    !runtimeArray(projection)
    || projection.length !== participantIds.length
  ) {
    throw new ProtectedStenographerSourceLoaderError(
      "participant_projection_invalid",
    );
  }
  const result = new Map<string, string>();
  for (let index = 0; index < projection.length; index++) {
    const display = projection[index];
    if (!ownRecord(display)) {
      throw new ProtectedStenographerSourceLoaderError(
        "participant_projection_invalid",
      );
    }
    assertExactFields(
      display,
      ["participantId", "displayLabel"],
      "participant_projection_invalid",
    );
    if (
      display["participantId"] !== participantIds[index]
      || !validDisplayLabel(display["displayLabel"])
      || result.has(display["participantId"])
    ) {
      throw new ProtectedStenographerSourceLoaderError(
        "participant_projection_invalid",
      );
    }
    result.set(
      display["participantId"],
      display["displayLabel"],
    );
  }
  return result;
}

function completeSources(
  decoded: readonly OpenedWithoutDisplay[],
  displays: ReadonlyMap<string, string>,
): OpenedProtectedStenographerSources {
  const ordered = decoded.map((source): OpenedProtectedStenographerSource => {
    if (source.kind !== "message") return source;
    const displayLabel = displays.get(source.binding.participantId);
    if (displayLabel === undefined) {
      throw new ProtectedStenographerSourceLoaderError(
        "participant_projection_invalid",
      );
    }
    return Object.freeze({
      kind: "message",
      objectId: source.binding.objectId,
      source: source.binding.source,
      messageId: source.binding.messageId,
      editRevision: source.binding.editRevision,
      createdAt: new Date(source.binding.createdAt),
      participantId: source.binding.participantId,
      displayLabel,
      role: source.binding.role,
      conversationalBoundary: source.binding.conversationalBoundary,
      payload: source.payload,
    });
  });
  const currentMessages = ordered.filter(
    (source): source is OpenedProtectedStenographerMessage =>
      source.kind === "message" && source.source === "current",
  );
  const priorMessages = ordered.filter(
    (source): source is OpenedProtectedStenographerMessage =>
      source.kind === "message" && source.source === "prior",
  );
  const events = ordered.filter(
    (source): source is OpenedProtectedStenographerEvent =>
      source.kind === "event",
  );
  const latestRollup = ordered.find(
    (source): source is OpenedProtectedStenographerRollup =>
      source.kind === "rollup",
  ) ?? null;
  return Object.freeze({
    orderedSources: Object.freeze(ordered),
    currentMessages: Object.freeze(currentMessages),
    priorMessages: Object.freeze(priorMessages),
    events: Object.freeze(events),
    latestRollup,
  });
}

function wipeOpenedInputs(
  openedInputs: readonly ProcessorTransformInput[],
): void {
  for (const item of openedInputs) {
    if (item?.plaintext instanceof Uint8Array) item.plaintext.fill(0);
  }
}

/**
 * Opens one exact processor input inventory into transient typed sources.
 * Plaintext is available only to `use`; this boundary returns no value and
 * wipes the supplied processor-owned buffers on every exit path.
 */
export async function withProtectedStenographerSources(
  input: WithProtectedStenographerSourcesInput,
): Promise<void> {
  try {
    if (
      !ownRecord(input)
      || typeof input.resolveParticipantDisplays !== "function"
      || typeof input.use !== "function"
    ) {
      throw new ProtectedStenographerSourceLoaderError("invalid_metadata");
    }
    assertExactFields(input, [
      "openedInputs",
      "bindings",
      "resolveParticipantDisplays",
      "use",
    ], "invalid_metadata");
    const bindings = validateBindings(input.bindings);
    validateOpenedInputs(input.openedInputs, bindings);
    const decoded = decodeSources(input.openedInputs, bindings);
    const displays = await participantDisplays(
      decoded,
      input.resolveParticipantDisplays,
    );
    await input.use(completeSources(decoded, displays));
  } finally {
    if (ownRecord(input) && Array.isArray(input.openedInputs)) {
      wipeOpenedInputs(input.openedInputs);
    }
  }
}
