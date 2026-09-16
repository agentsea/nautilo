import { sha256 } from "@noble/hashes/sha2.js";
import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  StrictDecoder,
} from "./v2-primitives.ts";
import {
  HASH_BYTES,
  NAMESPACE_KEY_BYTES,
  type NamespaceKeyClass,
  type NamespaceKeyEntryV2,
  type NamespaceKeyringEnvelopeV2,
  type NamespaceKeyringPlaintextV2,
} from "../namespace/types.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";

export const NAMESPACE_KEYRING_DOMAIN =
  "nautilo/lattice-crypto/namespace-keyring-envelope/v2";
export const NAMESPACE_KEYRING_FORMAT_VERSION = 2 as const;

const KEYRING_PLAINTEXT_PURPOSE = "namespace-keyring-plaintext";
const KEYRING_ENVELOPE_PURPOSE = "namespace-keyring";
const MIN_AEAD_CIPHERTEXT_BYTES = 40;

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

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function assertKeyClass(value: unknown): asserts value is NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new RangeError("Namespace key class is unsupported");
  }
}

function cloneKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): NamespaceKeyringPlaintextV2 {
  const generations = keyring.generations.map((entry) =>
    Object.freeze({
      generation: entry.generation,
      key: copyOwnedBytesV2(entry.key),
    })
  );
  return Object.freeze({
    ...keyring,
    generations: Object.freeze(generations),
  });
}

export function assertCanonicalNamespaceKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): void {
  if (typeof keyring !== "object" || keyring === null) {
    throw new TypeError("Namespace keyring must be an object");
  }
  assertExactFields("Namespace keyring", keyring, [
    "formatVersion",
    "namespaceId",
    "keyClass",
    "accessRevision",
    "currentGeneration",
    "generations",
  ]);
  if (keyring.formatVersion !== NAMESPACE_KEYRING_FORMAT_VERSION) {
    throw new RangeError("Namespace keyring version is unsupported");
  }
  namespaceId(keyring.namespaceId);
  assertKeyClass(keyring.keyClass);
  accessRevision(keyring.accessRevision);
  namespaceGeneration(keyring.currentGeneration);
  if (!Array.isArray(keyring.generations as unknown)) {
    throw new TypeError("Namespace keyring generations must be an array");
  }
  const generations: readonly NamespaceKeyEntryV2[] = keyring.generations;
  assertV2Range(
    "Namespace keyring generations",
    generations.length,
    1,
    V2_LIMITS.retainedNamespaceGenerations,
  );
  let previous = -1;
  for (const entry of generations) {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("Namespace keyring entry must be an object");
    }
    assertExactFields("Namespace keyring entry", entry, [
      "generation",
      "key",
    ]);
    namespaceGeneration(entry.generation);
    if (entry.generation <= previous) {
      throw new RangeError(
        "Namespace keyring generations must be strictly increasing",
      );
    }
    assertBytes("Namespace generation key", entry.key, NAMESPACE_KEY_BYTES);
    previous = entry.generation;
  }
  if (
    generations[generations.length - 1]!.generation
      !== keyring.currentGeneration
  ) {
    throw new RangeError(
      "Namespace keyring current generation must be the unique latest entry",
    );
  }
}

export function encodeNamespaceKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): Uint8Array {
  assertCanonicalNamespaceKeyring(keyring);
  const framedKeys = keyring.generations.map((entry) => frame(entry.key));
  try {
    const bytes = concatV2(
      frameText(NAMESPACE_KEYRING_DOMAIN),
      frameText(KEYRING_PLAINTEXT_PURPOSE),
      encodeU32(NAMESPACE_KEYRING_FORMAT_VERSION),
      frameText(keyring.namespaceId),
      frameText(keyring.keyClass),
      encodeU64(keyring.accessRevision),
      encodeU64(keyring.currentGeneration),
      encodeU32(keyring.generations.length),
      ...keyring.generations.flatMap((entry, index) => [
        encodeU64(entry.generation),
        framedKeys[index]!,
      ]),
    );
    return bytes;
  } finally {
    framedKeys.forEach((value) => value.fill(0));
  }
}

function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  const actual = reader.readText(expected.length);
  if (actual !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

export function decodeNamespaceKeyring(
  bytes: Uint8Array,
): NamespaceKeyringPlaintextV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalDecodingError("Namespace keyring bytes are invalid");
  }
  try {
    assertV2Range(
      NAMESPACE_KEYRING_DOMAIN,
      bytes.length,
      0,
      V2_LIMITS.namespaceKeyringBytes,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Namespace keyring exceeds the 256 KiB limit",
    );
  }
  const reader = new StrictDecoder(bytes);
  const generations: NamespaceKeyEntryV2[] = [];
  try {
    readExactText(reader, NAMESPACE_KEYRING_DOMAIN, "Namespace keyring domain");
    readExactText(
      reader,
      KEYRING_PLAINTEXT_PURPOSE,
      "Namespace keyring purpose",
    );
    reader.readVersion(NAMESPACE_KEYRING_FORMAT_VERSION);
    const decodedNamespaceId = namespaceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const keyClass = reader.readText(5);
    assertKeyClass(keyClass);
    const decodedAccessRevision = accessRevision(reader.readU64());
    const currentGeneration = namespaceGeneration(reader.readU64());
    const count = reader.readCount(V2_LIMITS.retainedNamespaceGenerations);
    for (let index = 0; index < count; index++) {
      generations.push({
        generation: namespaceGeneration(reader.readU64()),
        key: reader.readFrame(NAMESPACE_KEY_BYTES),
      });
    }
    const keyring: NamespaceKeyringPlaintextV2 = {
      formatVersion: NAMESPACE_KEYRING_FORMAT_VERSION,
      namespaceId: decodedNamespaceId,
      keyClass,
      accessRevision: decodedAccessRevision,
      currentGeneration,
      generations,
    };
    assertCanonicalNamespaceKeyring(keyring);
    reader.assertFinished();
    return cloneKeyring(keyring);
  } finally {
    generations.forEach((entry) => entry.key.fill(0));
    reader.destroy();
  }
}

function assertHashOrNull(
  label: string,
  value: Uint8Array | null,
): void {
  if (value !== null) assertBytes(label, value, HASH_BYTES);
}

export function assertNamespaceKeyringEnvelope(
  envelope: NamespaceKeyringEnvelopeV2,
): void {
  if (typeof envelope !== "object" || envelope === null) {
    throw new TypeError("Namespace keyring envelope must be an object");
  }
  assertExactFields("Namespace keyring envelope", envelope, [
    "formatVersion",
    "namespaceId",
    "keyClass",
    "domainId",
    "domainEpoch",
    "accessRevision",
    "currentGeneration",
    "previousBindingHash",
    "ciphertext",
    "committerDeviceId",
    "signature",
  ]);
  if (envelope.formatVersion !== NAMESPACE_KEYRING_FORMAT_VERSION) {
    throw new RangeError("Namespace keyring envelope version is unsupported");
  }
  namespaceId(envelope.namespaceId);
  assertKeyClass(envelope.keyClass);
  cryptoDomainId(envelope.domainId);
  domainEpoch(envelope.domainEpoch);
  accessRevision(envelope.accessRevision);
  namespaceGeneration(envelope.currentGeneration);
  cryptoDeviceId(envelope.committerDeviceId);
  assertHashOrNull("Previous binding hash", envelope.previousBindingHash);
  if (
    (envelope.accessRevision === 0 && envelope.previousBindingHash !== null)
    || (envelope.accessRevision > 0 && envelope.previousBindingHash === null)
  ) {
    throw new RangeError(
      "Previous binding hash must be empty only at access revision zero",
    );
  }
  if (
    !(envelope.ciphertext instanceof Uint8Array)
    || envelope.ciphertext.length < MIN_AEAD_CIPHERTEXT_BYTES
    || envelope.ciphertext.length > V2_LIMITS.namespaceKeyringBytes
  ) {
    throw new RangeError(
      "Namespace keyring ciphertext has an invalid length",
    );
  }
  assertBytes("Namespace keyring signature", envelope.signature, V2_LIMITS.signatureBytes);
}

function envelopeMetadataBytes(
  envelope: NamespaceKeyringEnvelopeV2,
): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_KEYRING_DOMAIN),
    frameText(KEYRING_ENVELOPE_PURPOSE),
    encodeU32(NAMESPACE_KEYRING_FORMAT_VERSION),
    frameText(envelope.namespaceId),
    frameText(envelope.keyClass),
    frameText(envelope.domainId),
    encodeU64(envelope.domainEpoch),
    encodeU64(envelope.accessRevision),
    encodeU64(envelope.currentGeneration),
    frame(envelope.previousBindingHash ?? new Uint8Array()),
    frameText(envelope.committerDeviceId),
  );
}

export function namespaceKeyringEnvelopeAad(
  envelope: NamespaceKeyringEnvelopeV2,
): Uint8Array {
  assertNamespaceKeyringEnvelope(envelope);
  return envelopeMetadataBytes(envelope);
}

export function namespaceKeyringEnvelopeSigningBytes(
  envelope: NamespaceKeyringEnvelopeV2,
): Uint8Array {
  assertNamespaceKeyringEnvelope(envelope);
  return concatV2(
    envelopeMetadataBytes(envelope),
    frame(sha256(envelope.ciphertext)),
  );
}

export function serializeNamespaceKeyringEnvelope(
  envelope: NamespaceKeyringEnvelopeV2,
): Uint8Array {
  assertNamespaceKeyringEnvelope(envelope);
  const bytes = concatV2(
    envelopeMetadataBytes(envelope),
    frame(envelope.ciphertext),
    frame(envelope.signature),
  );
  assertV2Range(
    "Namespace keyring envelope bytes",
    bytes.length,
    0,
    V2_LIMITS.namespaceKeyringBytes,
  );
  return bytes;
}

export function parseNamespaceKeyringEnvelope(
  bytes: Uint8Array,
): NamespaceKeyringEnvelopeV2 {
  try {
    assertV2Range(
      NAMESPACE_KEYRING_DOMAIN,
      bytes.length,
      0,
      V2_LIMITS.namespaceKeyringBytes,
    );
  } catch {
    throw new CanonicalDecodingError(
      "Namespace keyring envelope exceeds the 256 KiB limit",
    );
  }
  const envelope = decodeExact(bytes, (reader) => {
    readExactText(
      reader,
      NAMESPACE_KEYRING_DOMAIN,
      "Namespace keyring envelope domain",
    );
    readExactText(
      reader,
      KEYRING_ENVELOPE_PURPOSE,
      "Namespace keyring envelope purpose",
    );
    reader.readVersion(NAMESPACE_KEYRING_FORMAT_VERSION);
    const decodedNamespaceId = namespaceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const keyClass = reader.readText(5);
    assertKeyClass(keyClass);
    const decodedDomainId = cryptoDomainId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const decodedDomainEpoch = domainEpoch(reader.readU64());
    const decodedAccessRevision = accessRevision(reader.readU64());
    const currentGeneration = namespaceGeneration(reader.readU64());
    const previousBytes = reader.readFrame(HASH_BYTES);
    const previousBindingHash =
      previousBytes.length === 0 ? null : previousBytes;
    const committerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const ciphertext = reader.readFrame(V2_LIMITS.namespaceKeyringBytes);
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    const value: NamespaceKeyringEnvelopeV2 = {
      formatVersion: NAMESPACE_KEYRING_FORMAT_VERSION,
      namespaceId: decodedNamespaceId,
      keyClass,
      domainId: decodedDomainId,
      domainEpoch: decodedDomainEpoch,
      accessRevision: decodedAccessRevision,
      currentGeneration,
      previousBindingHash,
      ciphertext,
      committerDeviceId,
      signature,
    };
    assertNamespaceKeyringEnvelope(value);
    return value;
  });
  return Object.freeze(envelope);
}
