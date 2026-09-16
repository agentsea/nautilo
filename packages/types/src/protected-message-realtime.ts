import { z } from "zod";

import {
  protectedMessageDtoV2Schema,
} from "./protected-message";

export const PROTECTED_MESSAGE_REALTIME_WIRE_VERSION_V2 = 2 as const;
export const PROTECTED_MESSAGE_REALTIME_MAX_WIRE_CHARS_V2 = 4_350_000;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const textEncoder = new TextEncoder();

const portableIdSchema = z.string()
  .min(1)
  .refine((value) => textEncoder.encode(value).length <= 128, {
    message: "portable identifier exceeds 128 UTF-8 bytes",
  })
  .regex(PORTABLE_ID_PATTERN, "invalid portable identifier");

const canonicalUuidSchema = z.string().regex(
  CANONICAL_UUID_PATTERN,
  "identity must be a canonical lowercase UUID",
);

const roomLaneSchema = z.templateLiteral([
  "room:",
  canonicalUuidSchema,
]);

const protectedMessageTokensSuppressedEventV2Schema = z.strictObject({
  wireVersion: z.literal(PROTECTED_MESSAGE_REALTIME_WIRE_VERSION_V2),
  type: z.literal("message.tokens"),
  protection: z.literal("protected"),
  laneKey: roomLaneSchema,
  streaming: z.literal("suppressed"),
  done: z.literal(true),
  turnId: portableIdSchema.optional(),
  authorAgentId: canonicalUuidSchema.optional(),
});

const protectedMessageNewEventV2Schema = z.strictObject({
  wireVersion: z.literal(PROTECTED_MESSAGE_REALTIME_WIRE_VERSION_V2),
  type: z.literal("message.new"),
  protection: z.literal("protected"),
  laneKey: roomLaneSchema,
  message: protectedMessageDtoV2Schema,
}).superRefine((event, context) => {
  if (event.laneKey !== `room:${event.message.projection.roomId}`) {
    context.addIssue({
      code: "custom",
      message: "protected message lane does not match its Room",
      path: ["laneKey"],
    });
  }
});

const protectedMessageUpdatedEventV2Schema = z.strictObject({
  wireVersion: z.literal(PROTECTED_MESSAGE_REALTIME_WIRE_VERSION_V2),
  type: z.literal("message.updated"),
  protection: z.literal("protected"),
  laneKey: roomLaneSchema,
  logicalMessageKey: portableIdSchema,
  editRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  message: protectedMessageDtoV2Schema,
}).superRefine((event, context) => {
  const projection = event.message.projection;
  if (event.laneKey !== `room:${projection.roomId}`) {
    context.addIssue({
      code: "custom",
      message: "protected message lane does not match its Room",
      path: ["laneKey"],
    });
  }
  if (projection.logicalMessageKey !== event.logicalMessageKey) {
    context.addIssue({
      code: "custom",
      message: "protected message logical key does not match its projection",
      path: ["logicalMessageKey"],
    });
  }
  if (projection.editRevision !== event.editRevision) {
    context.addIssue({
      code: "custom",
      message: "protected message revision does not match its projection",
      path: ["editRevision"],
    });
  }
  if (projection.editedAt === null || projection.editedAt === undefined) {
    context.addIssue({
      code: "custom",
      message: "protected message update requires an edited timestamp",
      path: ["message", "projection", "editedAt"],
    });
  }
});

export const protectedMessageRealtimeEventV2Schema = z.union([
  protectedMessageTokensSuppressedEventV2Schema,
  protectedMessageNewEventV2Schema,
  protectedMessageUpdatedEventV2Schema,
]);

export type ProtectedMessageRealtimeEventV2 = z.infer<
  typeof protectedMessageRealtimeEventV2Schema
>;

type CanonicalJsonArray = readonly CanonicalJsonValue[];
interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}
type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonArray
  | CanonicalJsonObject;

function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

export function parseProtectedMessageRealtimeEventV2(
  value: unknown,
): ProtectedMessageRealtimeEventV2 {
  return protectedMessageRealtimeEventV2Schema.parse(value);
}

export function encodeProtectedMessageRealtimeEventV2(
  value: ProtectedMessageRealtimeEventV2,
): string {
  const parsed = parseProtectedMessageRealtimeEventV2(value);
  const wire = canonicalJson(parsed as CanonicalJsonValue);
  if (wire.length > PROTECTED_MESSAGE_REALTIME_MAX_WIRE_CHARS_V2) {
    throw new RangeError(
      "protected message realtime wire text is out of bounds",
    );
  }
  return wire;
}

export function decodeProtectedMessageRealtimeEventV2(
  wire: string,
): ProtectedMessageRealtimeEventV2 {
  if (
    typeof wire !== "string"
    || wire.length < 1
    || wire.length > PROTECTED_MESSAGE_REALTIME_MAX_WIRE_CHARS_V2
  ) {
    throw new RangeError(
      "protected message realtime wire text is out of bounds",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(wire);
  } catch {
    throw new TypeError("protected message realtime JSON is malformed");
  }
  const parsed = parseProtectedMessageRealtimeEventV2(value);
  if (encodeProtectedMessageRealtimeEventV2(parsed) !== wire) {
    throw new TypeError("protected message realtime JSON is not canonical");
  }
  return parsed;
}
