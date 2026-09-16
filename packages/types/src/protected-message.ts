import { z } from "zod";

export const PROTECTED_MESSAGE_DTO_VERSION_V2 = 2 as const;
export const PROTECTED_MESSAGE_PAYLOAD_VERSION_V2 = 2 as const;
export const PROTECTED_MESSAGE_MAX_BINARY_BYTES_V2 = 1_048_616;
export const PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2 = 1_048_576;
export const PROTECTED_MESSAGE_MAX_WIRE_CHARS_V2 = 4_300_000;

const PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_SERIAL_PATTERN = /^[1-9][0-9]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const textEncoder = new TextEncoder();

function boundedUtf8(maximumBytes: number): (value: string) => boolean {
  return (value) => textEncoder.encode(value).length <= maximumBytes;
}

const portableIdSchema = z.string()
  .min(1)
  .refine(boundedUtf8(128), {
    message: "portable identifier exceeds 128 UTF-8 bytes",
  })
  .regex(PORTABLE_ID_PATTERN, "invalid portable identifier");

const canonicalUuidSchema = z.string().regex(
  CANONICAL_UUID_PATTERN,
  "identity must be a canonical lowercase UUID",
);

const canonicalSerialSchema = z.string()
  .max(10, "message identity exceeds the PostgreSQL serial range")
  .regex(
    CANONICAL_SERIAL_PATTERN,
    "message identity must be a canonical positive decimal serial",
  )
  .refine((value) =>
    value.length < 10
    || value <= "2147483647", {
    message: "message identity exceeds the PostgreSQL serial range",
  });

const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "timestamp must be canonical UTC ISO-8601");

const safeCounterSchema = z.number().int().nonnegative().max(
  Number.MAX_SAFE_INTEGER,
);

function base64urlBytesSchema(maximumBytes: number) {
  return z.string()
    .min(2)
    .regex(BASE64URL_PATTERN, "bytes must use unpadded base64url")
    .refine((value) => value.length % 4 !== 1, {
      message: "base64url length is invalid",
    })
    .refine((value) => {
      const remainder = value.length % 4;
      if (remainder === 0) return true;
      const finalSextet = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
      if (finalSextet < 0) return false;
      return remainder === 2
        ? (finalSextet & 0b001111) === 0
        : (finalSextet & 0b000011) === 0;
    }, {
      message: "base64url bytes are not canonically encoded",
    })
    .refine(
      (value) => Math.floor(value.length * 3 / 4) <= maximumBytes,
      { message: "base64url bytes exceed the wire limit" },
    );
}

export const protectedMessageStructuralProjectionV2Schema = z.strictObject({
  messageId: canonicalSerialSchema,
  logicalMessageKey: portableIdSchema.optional(),
  sessionId: canonicalUuidSchema,
  roomId: canonicalUuidSchema,
  namespaceId: canonicalUuidSchema,
  role: z.enum(["user", "assistant", "tool", "system"]),
  createdAt: canonicalTimestampSchema,
  editedAt: canonicalTimestampSchema.nullable().optional(),
  editRevision: safeCounterSchema,
  replyToMessageId: canonicalSerialSchema.nullable().optional(),
  subthreadRoomId: canonicalUuidSchema.nullable().optional(),
  replyCount: safeCounterSchema.optional(),
  lastReplyAt: canonicalTimestampSchema.nullable().optional(),
  summaryRevision: safeCounterSchema.optional(),
  deliveredAt: canonicalTimestampSchema.nullable().optional(),
  readAt: canonicalTimestampSchema.nullable().optional(),
  sourceUserId: canonicalUuidSchema.optional(),
  authorAgentId: canonicalUuidSchema.optional(),
});

export type ProtectedMessageStructuralProjectionV2 = z.infer<
  typeof protectedMessageStructuralProjectionV2Schema
>;

export const protectedMessageEncryptedPayloadV2Schema = z.strictObject({
  status: z.literal("encrypted"),
  cryptoObjectId: portableIdSchema,
  payloadVersion: z.literal(PROTECTED_MESSAGE_PAYLOAD_VERSION_V2),
  keyClass: z.enum(["ai", "human"]),
  encryptedPayloadBytesBase64url: base64urlBytesSchema(
    PROTECTED_MESSAGE_MAX_BINARY_BYTES_V2,
  ),
  accessManifestBytesBase64url: base64urlBytesSchema(
    PROTECTED_MESSAGE_MAX_BINARY_BYTES_V2,
  ),
  namespaceEnvelopeBytesBase64url: base64urlBytesSchema(
    PROTECTED_MESSAGE_MAX_NAMESPACE_ENVELOPE_BYTES_V2,
  ),
});

export const protectedMessagePendingPayloadV2Schema = z.strictObject({
  status: z.literal("pending"),
  reason: z.enum(["shadow_pending", "backfill_pending"]),
});

export const protectedMessageUnavailableReasonV2Schema = z.enum([
  "missing_grant",
  "stale_grant",
  "unauthorized",
  "removed",
  "unsupported_version",
  "corrupt",
  "lost_key_material",
]);

export type ProtectedMessageUnavailableReasonV2 = z.infer<
  typeof protectedMessageUnavailableReasonV2Schema
>;

export const protectedMessageUnavailablePayloadV2Schema = z.strictObject({
  status: z.literal("unavailable"),
  reason: protectedMessageUnavailableReasonV2Schema,
  cryptoObjectId: portableIdSchema.optional(),
});

export const protectedMessagePayloadOutcomeV2Schema = z.discriminatedUnion(
  "status",
  [
    protectedMessageEncryptedPayloadV2Schema,
    protectedMessagePendingPayloadV2Schema,
    protectedMessageUnavailablePayloadV2Schema,
  ],
);

export type ProtectedMessagePayloadOutcomeV2 = z.infer<
  typeof protectedMessagePayloadOutcomeV2Schema
>;

export const protectedMessageDtoV2Schema = z.strictObject({
  dtoVersion: z.literal(PROTECTED_MESSAGE_DTO_VERSION_V2),
  projection: protectedMessageStructuralProjectionV2Schema,
  protectedPayload: protectedMessagePayloadOutcomeV2Schema,
});

export type ProtectedMessageDtoV2 = z.infer<
  typeof protectedMessageDtoV2Schema
>;

type JsonArray = readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonArray
  | JsonObject;

function canonicalJson(value: JsonValue): string {
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
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

export function parseProtectedMessageDtoV2(
  value: unknown,
): ProtectedMessageDtoV2 {
  return protectedMessageDtoV2Schema.parse(value);
}

export function encodeProtectedMessageDtoV2(
  value: ProtectedMessageDtoV2,
): string {
  const parsed = parseProtectedMessageDtoV2(value);
  const wire = canonicalJson(parsed as unknown as JsonValue);
  if (wire.length > PROTECTED_MESSAGE_MAX_WIRE_CHARS_V2) {
    throw new RangeError("protected message DTO exceeds the wire limit");
  }
  return wire;
}

export function decodeProtectedMessageDtoV2(
  wire: string,
): ProtectedMessageDtoV2 {
  if (
    typeof wire !== "string"
    || wire.length < 1
    || wire.length > PROTECTED_MESSAGE_MAX_WIRE_CHARS_V2
  ) {
    throw new RangeError("protected message DTO wire text is out of bounds");
  }
  let value: unknown;
  try {
    value = JSON.parse(wire);
  } catch {
    throw new TypeError("protected message DTO JSON is malformed");
  }
  const parsed = parseProtectedMessageDtoV2(value);
  if (encodeProtectedMessageDtoV2(parsed) !== wire) {
    throw new TypeError("protected message DTO JSON is not canonical");
  }
  return parsed;
}
