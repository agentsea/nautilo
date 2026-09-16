import type { LatticeCrypto } from "../crypto/index.ts";
import {
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  normalizeEncryptedPayloadContextV2,
  normalizeNamespaceObjectEnvelopeContextV2,
  type EncryptedPayloadContextV2,
  type ObjectKeyClassV2,
} from "../format/object-v2.ts";
import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  type AccessRevision,
  type NamespaceId,
  type NamespaceKeyGeneration,
} from "../v2-types/ids.ts";
import {
  V2_LIMITS,
  assertV2Limit,
} from "../v2-types/limits.ts";
import {
  decryptObjectThroughNamespaceV2,
  wrapObjectDekForNamespaceV2,
  type NamespaceObjectEnvelopeV2,
} from "./namespace-envelope.ts";
import {
  encryptObjectPayloadV2,
  type EncryptedPayloadV2,
} from "./payload.ts";

const KEY_BYTES = 32;

/**
 * One already-authorized Namespace generation loaded by the caller.
 *
 * Batch primitives deliberately have no Domain/group resolver. A bridge loads
 * a bounded unique table once, then every object operation is a local lookup.
 */
export interface NamespaceBatchKeyV2 {
  readonly namespaceId: NamespaceId;
  readonly keyClass: ObjectKeyClassV2;
  readonly keyGeneration: NamespaceKeyGeneration;
  readonly bindingRevision: AccessRevision;
  readonly key: Uint8Array;
}

export interface EncryptObjectBatchItemV2 {
  readonly context: EncryptedPayloadContextV2;
  readonly plaintext: Uint8Array;
  readonly targetNamespaceIds: readonly NamespaceId[];
}

export interface EncryptedObjectBatchItemV2 {
  readonly payload: EncryptedPayloadV2;
  readonly envelopes: readonly NamespaceObjectEnvelopeV2[];
}

export interface DecryptObjectBatchItemV2 {
  readonly payload: EncryptedPayloadV2;
  readonly envelope: NamespaceObjectEnvelopeV2;
}

export type DecryptObjectBatchResultV2 =
  | {
    readonly ok: true;
    readonly plaintext: Uint8Array;
  }
  | {
    readonly ok: false;
    readonly reason: "binding_key_unavailable" | "decrypt_failed";
  };

type CheckedBatchKey = Readonly<{
  namespaceId: NamespaceId;
  keyClass: ObjectKeyClassV2;
  keyGeneration: NamespaceKeyGeneration;
  bindingRevision: AccessRevision;
  key: Uint8Array;
}>;

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

function assertKeyClass(
  value: unknown,
): asserts value is ObjectKeyClassV2 {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("batch key class must be human or ai");
  }
}

function exactKeyCoordinate(
  namespace: NamespaceId,
  keyClass: ObjectKeyClassV2,
  generation: NamespaceKeyGeneration,
): string {
  return `${namespace}\u0000${keyClass}\u0000${generation}`;
}

function currentKeyCoordinate(
  namespace: NamespaceId,
  keyClass: ObjectKeyClassV2,
): string {
  return `${namespace}\u0000${keyClass}`;
}

function normalizeBatchKeys(
  bindings: readonly NamespaceBatchKeyV2[],
): readonly CheckedBatchKey[] {
  if (!Array.isArray(bindings as unknown)) {
    throw new TypeError("pre-resolved batch bindings must be an array");
  }
  assertV2Limit(
    "pre-resolved batch bindings",
    bindings.length,
    V2_LIMITS.bindingsPerBatch,
  );
  const coordinates = new Set<string>();
  return bindings.map((binding) => {
    if (typeof binding !== "object" || binding === null) {
      throw new TypeError("pre-resolved batch binding must be an object");
    }
    assertExactFields("pre-resolved batch binding", binding, [
      "namespaceId",
      "keyClass",
      "keyGeneration",
      "bindingRevision",
      "key",
    ]);
    assertKeyClass(binding.keyClass);
    const checked = Object.freeze({
      namespaceId: namespaceId(binding.namespaceId),
      keyClass: binding.keyClass,
      keyGeneration: namespaceGeneration(binding.keyGeneration),
      bindingRevision: accessRevision(binding.bindingRevision),
      key: binding.key,
    });
    if (
      !(checked.key instanceof Uint8Array)
      || checked.key.length !== KEY_BYTES
    ) {
      throw new TypeError(
        `pre-resolved Namespace key must be exactly ${KEY_BYTES} bytes`,
      );
    }
    const coordinate = exactKeyCoordinate(
      checked.namespaceId,
      checked.keyClass,
      checked.keyGeneration,
    );
    if (coordinates.has(coordinate)) {
      throw new Error("duplicate pre-resolved batch binding coordinate");
    }
    coordinates.add(coordinate);
    return checked;
  });
}

function assertBatchLength(label: string, length: number): void {
  assertV2Limit(label, length, V2_LIMITS.batchItems);
}

function normalizeEncryptItems(
  items: readonly EncryptObjectBatchItemV2[],
  currentBindings: ReadonlyMap<string, CheckedBatchKey>,
): readonly EncryptObjectBatchItemV2[] {
  if (!Array.isArray(items as unknown)) {
    throw new TypeError("object encryption batch must be an array");
  }
  assertBatchLength("object encryption batch", items.length);
  return items.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new TypeError("object encryption batch item must be an object");
    }
    assertExactFields("object encryption batch item", item, [
      "context",
      "plaintext",
      "targetNamespaceIds",
    ]);
    const context = normalizeEncryptedPayloadContextV2(item.context);
    if (!(item.plaintext instanceof Uint8Array)) {
      throw new TypeError("object batch plaintext must be Uint8Array");
    }
    assertV2Limit(
      "object batch plaintext bytes",
      item.plaintext.length,
      V2_LIMITS.plaintextBytes,
    );
    if (!Array.isArray(item.targetNamespaceIds as unknown)) {
      throw new TypeError("object batch target Namespaces must be an array");
    }
    assertV2Limit(
      "object batch target Namespaces",
      item.targetNamespaceIds.length,
      V2_LIMITS.namespaceEnvelopesPerManifest,
    );
    if (item.targetNamespaceIds.length === 0) {
      throw new Error("object batch requires a pre-resolved target binding");
    }
    const seen = new Set<string>();
    const targetNamespaceIds = item.targetNamespaceIds.map((value) => {
      const targetNamespaceId = namespaceId(value);
      const coordinate = currentKeyCoordinate(
        targetNamespaceId,
        context.keyClass,
      );
      if (seen.has(coordinate)) {
        throw new Error("duplicate object batch target Namespace");
      }
      seen.add(coordinate);
      if (!currentBindings.has(coordinate)) {
        throw new Error(
          "object batch target has no pre-resolved current binding",
        );
      }
      return targetNamespaceId;
    });
    return Object.freeze({
      context,
      plaintext: item.plaintext,
      targetNamespaceIds: Object.freeze(targetNamespaceIds),
    });
  });
}

function validateDecryptItems(
  items: readonly DecryptObjectBatchItemV2[],
): void {
  if (!Array.isArray(items as unknown)) {
    throw new TypeError("object decryption batch must be an array");
  }
  assertBatchLength("object decryption batch", items.length);
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      throw new TypeError("object decryption batch item must be an object");
    }
    assertExactFields("object decryption batch item", item, [
      "payload",
      "envelope",
    ]);
    if (
      typeof item.payload !== "object"
      || item.payload === null
      || item.payload.formatVersion !== ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2
      || !(item.payload.ciphertext instanceof Uint8Array)
    ) {
      throw new TypeError("object decryption batch payload is malformed");
    }
    normalizeEncryptedPayloadContextV2(item.payload.context);
    assertV2Limit(
      "object decryption batch ciphertext bytes",
      item.payload.ciphertext.length,
      V2_LIMITS.ciphertextBytes,
    );
    if (
      typeof item.envelope !== "object"
      || item.envelope === null
      || item.envelope.formatVersion
        !== NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2
      || !(item.envelope.wrappedDek instanceof Uint8Array)
    ) {
      throw new TypeError("object decryption batch envelope is malformed");
    }
    normalizeNamespaceObjectEnvelopeContextV2(item.envelope.context);
    assertV2Limit(
      "object decryption batch wrapped DEK bytes",
      item.envelope.wrappedDek.length,
      V2_LIMITS.wrappedDekBytes,
    );
  }
}

/**
 * Pure, write-free object encryption preparation. The complete batch is
 * validated before the first random DEK/nonce is requested.
 */
export function encryptObjectBatchV2(
  crypto: LatticeCrypto,
  bindings: readonly NamespaceBatchKeyV2[],
  items: readonly EncryptObjectBatchItemV2[],
): readonly EncryptedObjectBatchItemV2[] {
  const checkedBindings = normalizeBatchKeys(bindings);
  const currentBindings = new Map<string, CheckedBatchKey>();
  for (const binding of checkedBindings) {
    const coordinate = currentKeyCoordinate(
      binding.namespaceId,
      binding.keyClass,
    );
    if (currentBindings.has(coordinate)) {
      throw new Error(
        "duplicate current pre-resolved batch binding coordinate",
      );
    }
    currentBindings.set(coordinate, binding);
  }
  const checkedItems = normalizeEncryptItems(items, currentBindings);

  return Object.freeze(checkedItems.map((item) => {
    const encrypted = encryptObjectPayloadV2(
      crypto,
      item.context,
      item.plaintext,
    );
    try {
      const envelopes = item.targetNamespaceIds.map((targetNamespaceId) => {
        const binding = currentBindings.get(
          currentKeyCoordinate(targetNamespaceId, item.context.keyClass),
        )!;
        return wrapObjectDekForNamespaceV2(
          crypto,
          binding.key,
          {
            objectId: item.context.objectId,
            namespaceId: binding.namespaceId,
            keyClass: binding.keyClass,
            keyGeneration: binding.keyGeneration,
            bindingRevisionAtWrap: binding.bindingRevision,
          },
          encrypted.dek,
        );
      });
      return Object.freeze({
        payload: encrypted.payload,
        envelopes: Object.freeze(envelopes),
      });
    } finally {
      encrypted.dek.fill(0);
    }
  }));
}

/**
 * Decrypt a stable item list using only the caller's bounded, pre-resolved
 * Namespace-generation table. Authorization/key loading happens outside this
 * primitive once per unique binding, never once per object.
 */
export function decryptObjectBatchV2(
  crypto: LatticeCrypto,
  bindings: readonly NamespaceBatchKeyV2[],
  items: readonly DecryptObjectBatchItemV2[],
): readonly DecryptObjectBatchResultV2[] {
  const checkedBindings = normalizeBatchKeys(bindings);
  validateDecryptItems(items);
  const byCoordinate = new Map<string, CheckedBatchKey>(
    checkedBindings.map((binding) => [
      exactKeyCoordinate(
        binding.namespaceId,
        binding.keyClass,
        binding.keyGeneration,
      ),
      binding,
    ]),
  );

  return Object.freeze(items.map((item) => {
    const context = item.envelope.context;
    const binding = byCoordinate.get(
      exactKeyCoordinate(
        context.namespaceId,
        context.keyClass,
        context.keyGeneration,
      ),
    );
    if (binding === undefined) {
      return Object.freeze({
        ok: false as const,
        reason: "binding_key_unavailable" as const,
      });
    }
    const plaintext = decryptObjectThroughNamespaceV2(
      crypto,
      binding.key,
      item.envelope,
      item.payload,
    );
    return plaintext === null
      ? Object.freeze({
        ok: false as const,
        reason: "decrypt_failed" as const,
      })
      : Object.freeze({
        ok: true as const,
        plaintext,
      });
  }));
}
