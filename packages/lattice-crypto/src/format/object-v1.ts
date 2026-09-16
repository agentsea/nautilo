import type { Epoch, NamespaceId, ObjectId } from "../types/index.ts";
import { concat, utf8 } from "../util/bytes.ts";

/** Clean-break encrypted-object format. Missing/unknown versions are rejected. */
export const ENCRYPTED_OBJECT_FORMAT_VERSION = 1 as const;

const AAD_SCHEMA = utf8("nautilo/lattice-crypto/encrypted-object-aad/v1");
const RECORD_TYPE = utf8("nautilo/lattice-crypto/encrypted-object");
const PAYLOAD_PURPOSE = utf8("payload");
const WRAPPED_DEK_PURPOSE = utf8("wrapped-dek");
const MAX_U32 = 0xffff_ffff;

export interface ObjectCryptoContext {
  formatVersion: number;
  objectId: ObjectId;
  namespaceId: NamespaceId;
  epoch: Epoch;
}

export interface ObjectPayloadContext extends ObjectCryptoContext {
  createdAt: number;
}

function u32(value: number): Uint8Array | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) return null;
  const bytes = new Uint8Array(4);
  bytes[0] = (value >>> 24) & 0xff;
  bytes[1] = (value >>> 16) & 0xff;
  bytes[2] = (value >>> 8) & 0xff;
  bytes[3] = value & 0xff;
  return bytes;
}

function frame(value: Uint8Array): Uint8Array | null {
  const length = u32(value.length);
  return length ? concat(length, value) : null;
}

function framedText(value: string): Uint8Array | null {
  return frame(utf8(value));
}

function framedUnsigned(value: number): Uint8Array | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return framedText(value.toString(10));
}

function objectAad(
  purpose: Uint8Array,
  context: ObjectCryptoContext,
  trailingFields: Uint8Array[],
): Uint8Array | null {
  if (context.formatVersion !== ENCRYPTED_OBJECT_FORMAT_VERSION) return null;
  const schema = frame(AAD_SCHEMA);
  const framedPurpose = frame(purpose);
  const recordType = frame(RECORD_TYPE);
  const version = framedUnsigned(context.formatVersion);
  const objectId = framedText(context.objectId);
  const namespaceId = framedText(context.namespaceId);
  const epoch = framedUnsigned(context.epoch);
  if (
    !schema ||
    !framedPurpose ||
    !recordType ||
    !version ||
    !objectId ||
    !namespaceId ||
    !epoch
  ) {
    return null;
  }
  return concat(
    schema,
    framedPurpose,
    recordType,
    version,
    objectId,
    namespaceId,
    epoch,
    ...trailingFields,
  );
}

/**
 * Canonical payload AAD field order:
 * schema, purpose, record type, version, object id, namespace id, epoch,
 * creation timestamp. Every variable-length field is u32-length-prefixed.
 */
export function objectPayloadAad(
  context: ObjectPayloadContext,
): Uint8Array | null {
  const createdAt = framedUnsigned(context.createdAt);
  if (!createdAt) return null;
  return objectAad(PAYLOAD_PURPOSE, context, [createdAt]);
}

/**
 * Canonical wrapped-DEK AAD field order:
 * schema, purpose, record type, version, object id, namespace id, epoch.
 */
export function wrappedDekAad(
  context: ObjectCryptoContext,
): Uint8Array | null {
  return objectAad(WRAPPED_DEK_PURPOSE, context, []);
}
