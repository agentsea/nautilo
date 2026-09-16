import {
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";
import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  assertPortableId,
  type AccessRevision,
  type NamespaceId,
  type NamespaceKeyGeneration,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import {
  V2_LIMITS,
  assertV2Limit,
  assertV2Range,
} from "../v2-types/limits.ts";

export const ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2 = 2 as const;
export const NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2 = 2 as const;
export const ENCRYPTED_PAYLOAD_DOMAIN_V2 =
  "nautilo/lattice-crypto/encrypted-payload/v2";
export const NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2 =
  "nautilo/lattice-crypto/namespace-object-envelope/v2";

/** Exact maxima of the framed V2 encoders below, including their AAD. */
export const MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2 =
  4 + utf8V2(ENCRYPTED_PAYLOAD_DOMAIN_V2).length + 4
  + 4 + V2_LIMITS.idBytes + 4 + "human".length
  + 4 + V2_LIMITS.schemeIdBytes + 8 + 4 + V2_LIMITS.ciphertextBytes;
export const MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2 =
  4 + utf8V2(NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2).length + 4
  + 2 * (4 + V2_LIMITS.idBytes) + 4 + "human".length
  + 8 + 8 + 4 + V2_LIMITS.wrappedDekBytes;

export type ObjectKeyClassV2 = "human" | "ai";

export interface EncryptedPayloadContextV2 {
  readonly objectId: ObjectId;
  readonly keyClass: ObjectKeyClassV2;
  readonly objectType: string;
  readonly createdAt: UnixTimestamp;
}

export interface NamespaceObjectEnvelopeContextV2 {
  readonly objectId: ObjectId;
  readonly namespaceId: NamespaceId;
  readonly keyClass: ObjectKeyClassV2;
  readonly keyGeneration: NamespaceKeyGeneration;
  readonly bindingRevisionAtWrap: AccessRevision;
}

export interface EncryptedPayloadRecordV2 {
  readonly formatVersion: typeof ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2;
  readonly context: EncryptedPayloadContextV2;
  readonly ciphertext: Uint8Array;
}

export interface NamespaceObjectEnvelopeRecordV2 {
  readonly formatVersion:
    typeof NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2;
  readonly context: NamespaceObjectEnvelopeContextV2;
  readonly wrappedDek: Uint8Array;
}

function assertExactFields(
  label: string,
  value: object,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
}

function assertKeyClass(value: unknown): asserts value is ObjectKeyClassV2 {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("object key class must be human or ai");
  }
}

export function normalizeEncryptedPayloadContextV2(
  context: EncryptedPayloadContextV2,
): EncryptedPayloadContextV2 {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("encrypted payload context must be an object");
  }
  assertExactFields("encrypted payload context", context, [
    "objectId",
    "keyClass",
    "objectType",
    "createdAt",
  ]);
  assertKeyClass(context.keyClass);
  assertPortableId("Object type", context.objectType);
  assertV2Limit(
    "Object type bytes",
    utf8V2(context.objectType).length,
    V2_LIMITS.schemeIdBytes,
  );
  return Object.freeze({
    objectId: objectId(context.objectId),
    keyClass: context.keyClass,
    objectType: context.objectType,
    createdAt: unixTimestamp(context.createdAt),
  });
}

export function normalizeNamespaceObjectEnvelopeContextV2(
  context: NamespaceObjectEnvelopeContextV2,
): NamespaceObjectEnvelopeContextV2 {
  if (typeof context !== "object" || context === null) {
    throw new TypeError("Namespace object envelope context must be an object");
  }
  assertExactFields("Namespace object envelope context", context, [
    "objectId",
    "namespaceId",
    "keyClass",
    "keyGeneration",
    "bindingRevisionAtWrap",
  ]);
  assertKeyClass(context.keyClass);
  return Object.freeze({
    objectId: objectId(context.objectId),
    namespaceId: namespaceId(context.namespaceId),
    keyClass: context.keyClass,
    keyGeneration: namespaceGeneration(context.keyGeneration),
    bindingRevisionAtWrap: accessRevision(context.bindingRevisionAtWrap),
  });
}

export function encryptedPayloadAadV2(
  context: EncryptedPayloadContextV2,
): Uint8Array {
  const normalized = normalizeEncryptedPayloadContextV2(context);
  return concatV2(
    frameText(ENCRYPTED_PAYLOAD_DOMAIN_V2),
    encodeU32(ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2),
    frameText(normalized.objectId),
    frameText(normalized.keyClass),
    frameText(normalized.objectType),
    encodeU64(normalized.createdAt),
  );
}

/**
 * Domain ID and Domain epoch are intentionally absent. A stable Namespace
 * retains this historical envelope across a valid Domain rebind.
 */
export function namespaceObjectEnvelopeAadV2(
  context: NamespaceObjectEnvelopeContextV2,
): Uint8Array {
  const normalized = normalizeNamespaceObjectEnvelopeContextV2(context);
  return concatV2(
    frameText(NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2),
    encodeU32(NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2),
    frameText(normalized.objectId),
    frameText(normalized.namespaceId),
    frameText(normalized.keyClass),
    encodeU64(normalized.keyGeneration),
    encodeU64(normalized.bindingRevisionAtWrap),
  );
}

export function encodeEncryptedPayloadV2(
  payload: EncryptedPayloadRecordV2,
): Uint8Array {
  if (payload.formatVersion !== ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2) {
    throw new TypeError("unsupported encrypted payload version");
  }
  if (!(payload.ciphertext instanceof Uint8Array)) {
    throw new TypeError("encrypted payload ciphertext must be Uint8Array");
  }
  assertV2Range(
    "encrypted payload bytes",
    payload.ciphertext.length,
    40,
    V2_LIMITS.ciphertextBytes,
  );
  return concatV2(
    encryptedPayloadAadV2(payload.context),
    frame(payload.ciphertext),
  );
}

export function encodeNamespaceObjectEnvelopeV2(
  envelope: NamespaceObjectEnvelopeRecordV2,
): Uint8Array {
  if (
    envelope.formatVersion !== NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2
  ) {
    throw new TypeError("unsupported Namespace object envelope version");
  }
  if (!(envelope.wrappedDek instanceof Uint8Array)) {
    throw new TypeError("wrapped DEK must be Uint8Array");
  }
  assertV2Range(
    "wrapped DEK bytes",
    envelope.wrappedDek.length,
    40,
    V2_LIMITS.wrappedDekBytes,
  );
  return concatV2(
    namespaceObjectEnvelopeAadV2(envelope.context),
    frame(envelope.wrappedDek),
  );
}

function readDomain(
  reader: StrictDecoder,
  expected: string,
): void {
  if (reader.readText(utf8V2(expected).length) !== expected) {
    throw new TypeError(`format domain mismatch; expected ${expected}`);
  }
}

function readKeyClass(reader: StrictDecoder): ObjectKeyClassV2 {
  const keyClass = reader.readText(5);
  assertKeyClass(keyClass);
  return keyClass;
}

export function decodeEncryptedPayloadV2(
  bytes: Uint8Array,
): EncryptedPayloadRecordV2 {
  return decodeExact(bytes, (reader) => {
    readDomain(reader, ENCRYPTED_PAYLOAD_DOMAIN_V2);
    const formatVersion = reader.readVersion(
      ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    ) as typeof ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2;
    const context = normalizeEncryptedPayloadContextV2({
      objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: readKeyClass(reader),
      objectType: reader.readText(V2_LIMITS.schemeIdBytes),
      createdAt: unixTimestamp(reader.readU64()),
    });
    const ciphertext = reader.readFrame(V2_LIMITS.ciphertextBytes);
    assertV2Range(
      "encrypted payload bytes",
      ciphertext.length,
      40,
      V2_LIMITS.ciphertextBytes,
    );
    return Object.freeze({
      formatVersion,
      context,
      ciphertext,
    });
  });
}

export function decodeNamespaceObjectEnvelopeV2(
  bytes: Uint8Array,
): NamespaceObjectEnvelopeRecordV2 {
  return decodeExact(bytes, (reader) => {
    readDomain(reader, NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2);
    const formatVersion = reader.readVersion(
      NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
    ) as typeof NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2;
    const context = normalizeNamespaceObjectEnvelopeContextV2({
      objectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: readKeyClass(reader),
      keyGeneration: namespaceGeneration(reader.readU64()),
      bindingRevisionAtWrap: accessRevision(reader.readU64()),
    });
    const wrappedDek = reader.readFrame(V2_LIMITS.wrappedDekBytes);
    assertV2Range(
      "wrapped DEK bytes",
      wrappedDek.length,
      40,
      V2_LIMITS.wrappedDekBytes,
    );
    return Object.freeze({
      formatVersion,
      context,
      wrappedDek,
    });
  });
}
