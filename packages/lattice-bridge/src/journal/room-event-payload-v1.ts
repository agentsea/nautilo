import {
  assertCanonicalJournalPayload,
  assertExactFields,
  assertRequiredFields,
  boundedText,
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

export const ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const ROOM_EVENT_PAYLOAD_KIND_V1 = "room_event" as const;
export const ROOM_EVENT_PAYLOAD_MAX_SOURCE_MESSAGES_V1 = 16;
export const ROOM_EVENT_PAYLOAD_MAX_STATEMENT_CODE_POINTS_V1 = 500;
export const ROOM_EVENT_PAYLOAD_MAX_STATEMENT_BYTES_V1 = 2_000;

export const ROOM_EVENT_PAYLOAD_KINDS_V1 = [
  "decision",
  "commitment",
  "goal",
  "state_change",
  "fact",
  "preference_or_norm",
  "open_question",
  "risk",
] as const;

export type RoomEventPayloadKindV1 =
  (typeof ROOM_EVENT_PAYLOAD_KINDS_V1)[number];

/**
 * Immutable confidential Room-event payload. Mutable projection state such as
 * active/superseded/resolved status is intentionally not part of this object.
 */
export interface RoomEventPayloadV1 {
  readonly eventId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly sequence: number;
  readonly kind: RoomEventPayloadKindV1;
  readonly statement: string;
  readonly supersedesEventId: string | null;
  readonly resolvesEventId: string | null;
  readonly sourceMessageIds: readonly number[];
  readonly sourceBatchId: string;
  readonly batchLocalOrdinal: number;
  readonly extractorVersion: string;
  readonly createdAt: string;
}

export type RoomEventPayloadBindingV1 = Readonly<
  Omit<RoomEventPayloadV1, "statement">
>;

interface RoomEventPayloadWireV1 extends RoomEventPayloadV1 {
  readonly payloadKind: typeof ROOM_EVENT_PAYLOAD_KIND_V1;
  readonly payloadVersion: typeof ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1;
}

const EVENT_FIELDS = [
  "eventId",
  "roomId",
  "namespaceId",
  "sequence",
  "kind",
  "statement",
  "supersedesEventId",
  "resolvesEventId",
  "sourceMessageIds",
  "sourceBatchId",
  "batchLocalOrdinal",
  "extractorVersion",
  "createdAt",
] as const;

function eventKind(value: unknown): RoomEventPayloadKindV1 {
  if (
    typeof value !== "string"
    || !(ROOM_EVENT_PAYLOAD_KINDS_V1 as readonly string[]).includes(value)
  ) {
    throw new TypeError("room event kind is unsupported");
  }
  return value as RoomEventPayloadKindV1;
}

function sourceMessageIds(value: unknown): readonly number[] {
  const values = denseArray(
    "room event sourceMessageIds",
    value,
    1,
    ROOM_EVENT_PAYLOAD_MAX_SOURCE_MESSAGES_V1,
  );
  const normalized = values.map((item, index) =>
    postgresInteger(`room event sourceMessageIds[${index}]`, item, 1)
  );
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index]! <= normalized[index - 1]!) {
      throw new TypeError(
        "room event sourceMessageIds must be strictly ascending and unique",
      );
    }
  }
  return Object.freeze(normalized);
}

function normalizeEventPayload(
  value: unknown,
  expectsWireFields: boolean,
): RoomEventPayloadV1 {
  if (!ownRecord(value)) {
    throw new TypeError("room event payload must be an object");
  }
  const requiredFields = [
    ...(expectsWireFields ? ["payloadKind", "payloadVersion"] : []),
    ...EVENT_FIELDS,
  ];
  assertExactFields("room event payload", value, requiredFields);
  assertRequiredFields("room event payload", value, requiredFields);
  if (expectsWireFields) {
    if (value["payloadKind"] !== ROOM_EVENT_PAYLOAD_KIND_V1) {
      throw new TypeError("unsupported room event payload kind");
    }
    if (
      value["payloadVersion"] !== ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1
    ) {
      throw new TypeError("unsupported room event payload version");
    }
  }

  const supersedesEventId = nullableCanonicalUuid(
    "room event supersedesEventId",
    value["supersedesEventId"],
  );
  const resolvesEventId = nullableCanonicalUuid(
    "room event resolvesEventId",
    value["resolvesEventId"],
  );
  if (supersedesEventId !== null && resolvesEventId !== null) {
    throw new TypeError("room event must have at most one transition link");
  }

  return Object.freeze({
    eventId: canonicalUuid("room event eventId", value["eventId"]),
    roomId: canonicalUuid("room event roomId", value["roomId"]),
    namespaceId: canonicalUuid(
      "room event namespaceId",
      value["namespaceId"],
    ),
    sequence: postgresInteger(
      "room event sequence",
      value["sequence"],
      1,
    ),
    kind: eventKind(value["kind"]),
    statement: boundedText("room event statement", value["statement"], {
      maximumCodePoints: ROOM_EVENT_PAYLOAD_MAX_STATEMENT_CODE_POINTS_V1,
      maximumBytes: ROOM_EVENT_PAYLOAD_MAX_STATEMENT_BYTES_V1,
    }),
    supersedesEventId,
    resolvesEventId,
    sourceMessageIds: sourceMessageIds(value["sourceMessageIds"]),
    sourceBatchId: canonicalUuid(
      "room event sourceBatchId",
      value["sourceBatchId"],
    ),
    batchLocalOrdinal: postgresInteger(
      "room event batchLocalOrdinal",
      value["batchLocalOrdinal"],
      0,
    ),
    extractorVersion: portableIdentifier(
      "room event extractorVersion",
      value["extractorVersion"],
    ),
    createdAt: canonicalTimestamp(
      "room event createdAt timestamp",
      value["createdAt"],
    ),
  });
}

function eventWire(
  payload: RoomEventPayloadV1,
): RoomEventPayloadWireV1 {
  return Object.freeze({
    payloadKind: ROOM_EVENT_PAYLOAD_KIND_V1,
    payloadVersion: ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1,
    ...payload,
  });
}

export function encodeRoomEventPayloadV1(
  payload: RoomEventPayloadV1,
): Uint8Array {
  const normalized = normalizeEventPayload(payload, false);
  return encodeCanonicalJournalPayload(
    "room event payload",
    eventWire(normalized),
  );
}

export function decodeRoomEventPayloadV1(
  bytes: Uint8Array,
): RoomEventPayloadV1 {
  const parsed = parseCanonicalJournalPayload("room event payload", bytes);
  const normalized = normalizeEventPayload(parsed, true);
  assertCanonicalJournalPayload(
    "room event payload",
    bytes,
    encodeRoomEventPayloadV1(normalized),
  );
  return normalized;
}

function assertBindingRecord(
  expected: RoomEventPayloadBindingV1,
): RoomEventPayloadBindingV1 {
  if (!ownRecord(expected)) {
    throw new TypeError("room event binding must be an object");
  }
  assertExactFields(
    "room event binding",
    expected,
    EVENT_FIELDS.filter((field) => field !== "statement"),
  );
  assertRequiredFields(
    "room event binding",
    expected,
    EVENT_FIELDS.filter((field) => field !== "statement"),
  );
  const normalized = normalizeEventPayload(
    { ...expected, statement: "binding-placeholder" },
    false,
  );
  const { statement: _statement, ...binding } = normalized;
  return Object.freeze(binding);
}

export function assertRoomEventPayloadBindingV1(
  payload: RoomEventPayloadV1,
  expected: RoomEventPayloadBindingV1,
): void {
  const normalizedPayload = normalizeEventPayload(payload, false);
  const normalizedExpected = assertBindingRecord(expected);
  for (const field of EVENT_FIELDS) {
    if (field === "statement") continue;
    if (field === "sourceMessageIds") {
      const actualIds = normalizedPayload.sourceMessageIds;
      const expectedIds = normalizedExpected.sourceMessageIds;
      if (
        actualIds.length !== expectedIds.length
        || actualIds.some((id, index) => id !== expectedIds[index])
      ) {
        throw new TypeError("room event binding mismatch: sourceMessageIds");
      }
      continue;
    }
    if (normalizedPayload[field] !== normalizedExpected[field]) {
      throw new TypeError(`room event binding mismatch: ${field}`);
    }
  }
}
