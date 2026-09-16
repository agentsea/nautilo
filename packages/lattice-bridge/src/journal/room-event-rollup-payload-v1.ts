import {
  assertCanonicalJournalPayload,
  assertExactFields,
  assertRequiredFields,
  boundedText,
  canonicalTimestamp,
  canonicalUuid,
  encodeCanonicalJournalPayload,
  ownRecord,
  parseCanonicalJournalPayload,
  portableIdentifier,
  postgresInteger,
} from "./journal-payload-codec.ts";

export const ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1 = 1 as const;
export const ROOM_EVENT_ROLLUP_PAYLOAD_KIND_V1 =
  "room_event_rollup" as const;
export const ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_CODE_POINTS_V1 = 12_000;
export const ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_BYTES_V1 = 48_000;

/** Immutable confidential cumulative Room-journal projection. */
export interface RoomEventRollupPayloadV1 {
  readonly rollupId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly throughEventSequence: number;
  readonly content: string;
  readonly sourceEventCount: number;
  readonly modelId: string;
  readonly compactorVersion: string;
  readonly createdAt: string;
}

export type RoomEventRollupPayloadBindingV1 = Readonly<
  Omit<RoomEventRollupPayloadV1, "content">
>;

interface RoomEventRollupPayloadWireV1 extends RoomEventRollupPayloadV1 {
  readonly payloadKind: typeof ROOM_EVENT_ROLLUP_PAYLOAD_KIND_V1;
  readonly payloadVersion:
    typeof ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1;
}

const ROLLUP_FIELDS = [
  "rollupId",
  "roomId",
  "namespaceId",
  "throughEventSequence",
  "content",
  "sourceEventCount",
  "modelId",
  "compactorVersion",
  "createdAt",
] as const;

function normalizeRollupPayload(
  value: unknown,
  expectsWireFields: boolean,
): RoomEventRollupPayloadV1 {
  if (!ownRecord(value)) {
    throw new TypeError("room event rollup payload must be an object");
  }
  const requiredFields = [
    ...(expectsWireFields ? ["payloadKind", "payloadVersion"] : []),
    ...ROLLUP_FIELDS,
  ];
  assertExactFields("room event rollup payload", value, requiredFields);
  assertRequiredFields("room event rollup payload", value, requiredFields);
  if (expectsWireFields) {
    if (value["payloadKind"] !== ROOM_EVENT_ROLLUP_PAYLOAD_KIND_V1) {
      throw new TypeError("unsupported room event rollup payload kind");
    }
    if (
      value["payloadVersion"]
        !== ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1
    ) {
      throw new TypeError("unsupported room event rollup payload version");
    }
  }
  return Object.freeze({
    rollupId: canonicalUuid(
      "room event rollup rollupId",
      value["rollupId"],
    ),
    roomId: canonicalUuid(
      "room event rollup roomId",
      value["roomId"],
    ),
    namespaceId: canonicalUuid(
      "room event rollup namespaceId",
      value["namespaceId"],
    ),
    throughEventSequence: postgresInteger(
      "room event rollup throughEventSequence",
      value["throughEventSequence"],
      1,
    ),
    content: boundedText(
      "room event rollup content",
      value["content"],
      {
        maximumCodePoints:
          ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_CODE_POINTS_V1,
        maximumBytes: ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_BYTES_V1,
      },
    ),
    sourceEventCount: postgresInteger(
      "room event rollup sourceEventCount",
      value["sourceEventCount"],
      1,
    ),
    modelId: portableIdentifier(
      "room event rollup modelId",
      value["modelId"],
    ),
    compactorVersion: portableIdentifier(
      "room event rollup compactorVersion",
      value["compactorVersion"],
    ),
    createdAt: canonicalTimestamp(
      "room event rollup createdAt timestamp",
      value["createdAt"],
    ),
  });
}

function rollupWire(
  payload: RoomEventRollupPayloadV1,
): RoomEventRollupPayloadWireV1 {
  return Object.freeze({
    payloadKind: ROOM_EVENT_ROLLUP_PAYLOAD_KIND_V1,
    payloadVersion: ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1,
    ...payload,
  });
}

export function encodeRoomEventRollupPayloadV1(
  payload: RoomEventRollupPayloadV1,
): Uint8Array {
  const normalized = normalizeRollupPayload(payload, false);
  return encodeCanonicalJournalPayload(
    "room event rollup payload",
    rollupWire(normalized),
  );
}

export function decodeRoomEventRollupPayloadV1(
  bytes: Uint8Array,
): RoomEventRollupPayloadV1 {
  const parsed = parseCanonicalJournalPayload(
    "room event rollup payload",
    bytes,
  );
  const normalized = normalizeRollupPayload(parsed, true);
  assertCanonicalJournalPayload(
    "room event rollup payload",
    bytes,
    encodeRoomEventRollupPayloadV1(normalized),
  );
  return normalized;
}

function assertBindingRecord(
  expected: RoomEventRollupPayloadBindingV1,
): RoomEventRollupPayloadBindingV1 {
  if (!ownRecord(expected)) {
    throw new TypeError("room event rollup binding must be an object");
  }
  assertExactFields(
    "room event rollup binding",
    expected,
    ROLLUP_FIELDS.filter((field) => field !== "content"),
  );
  assertRequiredFields(
    "room event rollup binding",
    expected,
    ROLLUP_FIELDS.filter((field) => field !== "content"),
  );
  const normalized = normalizeRollupPayload(
    { ...expected, content: "binding-placeholder" },
    false,
  );
  const { content: _content, ...binding } = normalized;
  return Object.freeze(binding);
}

export function assertRoomEventRollupPayloadBindingV1(
  payload: RoomEventRollupPayloadV1,
  expected: RoomEventRollupPayloadBindingV1,
): void {
  const normalizedPayload = normalizeRollupPayload(payload, false);
  const normalizedExpected = assertBindingRecord(expected);
  for (const field of ROLLUP_FIELDS) {
    if (field === "content") continue;
    if (normalizedPayload[field] !== normalizedExpected[field]) {
      throw new TypeError(`room event rollup binding mismatch: ${field}`);
    }
  }
}
