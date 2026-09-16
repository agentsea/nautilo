import type { LatticeCrypto } from "../crypto/index.ts";
import {
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  namespaceObjectEnvelopeAadV2,
  normalizeNamespaceObjectEnvelopeContextV2,
  type NamespaceObjectEnvelopeContextV2,
} from "../format/object-v2.ts";
import { V2_LIMITS, assertV2Limit } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  decryptObjectPayloadV2,
  type EncryptedPayloadV2,
} from "./payload.ts";

const KEY_BYTES = 32;

export interface NamespaceObjectEnvelopeV2 {
  readonly formatVersion:
    typeof NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2;
  readonly context: NamespaceObjectEnvelopeContextV2;
  readonly wrappedDek: Uint8Array;
}

function assertKey(label: string, key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new TypeError(`${label} must be exactly ${KEY_BYTES} bytes`);
  }
}

export function wrapObjectDekForNamespaceV2(
  crypto: LatticeCrypto,
  namespaceKey: Uint8Array,
  context: NamespaceObjectEnvelopeContextV2,
  dek: Uint8Array,
): NamespaceObjectEnvelopeV2 {
  assertKey("Namespace key", namespaceKey);
  assertKey("DEK", dek);
  const normalized = normalizeNamespaceObjectEnvelopeContextV2(context);
  const wrappedDek = crypto.aeadSeal(
    namespaceKey,
    dek,
    namespaceObjectEnvelopeAadV2(normalized),
  );
  assertV2Limit(
    "wrapped DEK bytes",
    wrappedDek.length,
    V2_LIMITS.wrappedDekBytes,
  );
  return Object.freeze({
    formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
    context: normalized,
    wrappedDek: copyOwnedBytesV2(wrappedDek),
  });
}

export function openObjectDekForNamespaceV2(
  crypto: LatticeCrypto,
  namespaceKey: Uint8Array,
  envelope: NamespaceObjectEnvelopeV2,
): Uint8Array | null {
  assertKey("Namespace key", namespaceKey);
  if (
    envelope === null
    || envelope.formatVersion !== NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2
    || !(envelope.wrappedDek instanceof Uint8Array)
  ) {
    return null;
  }
  assertV2Limit(
    "wrapped DEK bytes",
    envelope.wrappedDek.length,
    V2_LIMITS.wrappedDekBytes,
  );
  try {
    const context = normalizeNamespaceObjectEnvelopeContextV2(envelope.context);
    const dek = crypto.aeadOpen(
      namespaceKey,
      envelope.wrappedDek,
      namespaceObjectEnvelopeAadV2(context),
    );
    if (dek === null) return null;
    try {
      if (dek.length !== KEY_BYTES) return null;
      return copyOwnedBytesV2(dek);
    } finally {
      dek.fill(0);
    }
  } catch {
    return null;
  }
}

export function decryptObjectThroughNamespaceV2(
  crypto: LatticeCrypto,
  namespaceKey: Uint8Array,
  envelope: NamespaceObjectEnvelopeV2,
  payload: EncryptedPayloadV2,
): Uint8Array | null {
  if (
    envelope.context.objectId !== payload.context.objectId
    || envelope.context.keyClass !== payload.context.keyClass
  ) {
    return null;
  }
  const dek = openObjectDekForNamespaceV2(crypto, namespaceKey, envelope);
  if (dek === null) return null;
  try {
    return decryptObjectPayloadV2(crypto, dek, payload);
  } finally {
    dek.fill(0);
  }
}
