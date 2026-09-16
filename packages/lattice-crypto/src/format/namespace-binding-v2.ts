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
  type NamespaceBindingV2,
} from "../namespace/types.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export const NAMESPACE_BINDING_DOMAIN =
  "nautilo/lattice-crypto/namespace-binding/v2";
export const NAMESPACE_BINDING_FORMAT_VERSION = 2 as const;

const NAMESPACE_BINDING_PURPOSE = "namespace-binding";
const MAX_BINDING_WIRE_BYTES = 4 * 1024;

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

export function assertNamespaceBinding(
  binding: NamespaceBindingV2,
): void {
  if (typeof binding !== "object" || binding === null) {
    throw new TypeError("Namespace binding must be an object");
  }
  assertExactFields("Namespace binding", binding, [
    "formatVersion",
    "namespaceId",
    "domainId",
    "domainEpoch",
    "accessRevision",
    "humanCurrentGeneration",
    "aiCurrentGeneration",
    "previousBindingHash",
    "humanKeyringEnvelopeHash",
    "aiKeyringEnvelopeHash",
    "committerDeviceId",
    "signature",
  ]);
  if (binding.formatVersion !== NAMESPACE_BINDING_FORMAT_VERSION) {
    throw new RangeError("Namespace binding version is unsupported");
  }
  namespaceId(binding.namespaceId);
  cryptoDomainId(binding.domainId);
  domainEpoch(binding.domainEpoch);
  accessRevision(binding.accessRevision);
  namespaceGeneration(binding.humanCurrentGeneration);
  namespaceGeneration(binding.aiCurrentGeneration);
  cryptoDeviceId(binding.committerDeviceId);
  if (binding.previousBindingHash !== null) {
    assertBytes(
      "Previous binding hash",
      binding.previousBindingHash,
      HASH_BYTES,
    );
  }
  if (
    (binding.accessRevision === 0 && binding.previousBindingHash !== null)
    || (binding.accessRevision > 0 && binding.previousBindingHash === null)
  ) {
    throw new RangeError(
      "Previous binding hash must be empty only at access revision zero",
    );
  }
  assertBytes(
    "Human keyring envelope hash",
    binding.humanKeyringEnvelopeHash,
    HASH_BYTES,
  );
  assertBytes(
    "AI keyring envelope hash",
    binding.aiKeyringEnvelopeHash,
    HASH_BYTES,
  );
  assertBytes(
    "Namespace binding signature",
    binding.signature,
    V2_LIMITS.signatureBytes,
  );
}

export function namespaceBindingSigningBytes(
  binding: NamespaceBindingV2,
): Uint8Array {
  assertNamespaceBinding(binding);
  return concatV2(
    frameText(NAMESPACE_BINDING_DOMAIN),
    frameText(NAMESPACE_BINDING_PURPOSE),
    encodeU32(NAMESPACE_BINDING_FORMAT_VERSION),
    frameText(binding.namespaceId),
    frameText(binding.domainId),
    encodeU64(binding.domainEpoch),
    encodeU64(binding.accessRevision),
    encodeU64(binding.humanCurrentGeneration),
    encodeU64(binding.aiCurrentGeneration),
    frame(binding.previousBindingHash ?? new Uint8Array()),
    frame(binding.humanKeyringEnvelopeHash),
    frame(binding.aiKeyringEnvelopeHash),
    frameText(binding.committerDeviceId),
  );
}

export function serializeNamespaceBinding(
  binding: NamespaceBindingV2,
): Uint8Array {
  return concatV2(
    namespaceBindingSigningBytes(binding),
    frame(binding.signature),
  );
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

export function parseNamespaceBinding(
  bytes: Uint8Array,
): NamespaceBindingV2 {
  if (bytes.length > MAX_BINDING_WIRE_BYTES) {
    throw new CanonicalDecodingError(
      "Namespace binding exceeds its wire limit",
    );
  }
  const binding = decodeExact(bytes, (reader) => {
    readExactText(reader, NAMESPACE_BINDING_DOMAIN, "Namespace binding domain");
    readExactText(
      reader,
      NAMESPACE_BINDING_PURPOSE,
      "Namespace binding purpose",
    );
    reader.readVersion(NAMESPACE_BINDING_FORMAT_VERSION);
    const decodedNamespaceId = namespaceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const decodedDomainId = cryptoDomainId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const decodedDomainEpoch = domainEpoch(reader.readU64());
    const decodedAccessRevision = accessRevision(reader.readU64());
    const humanCurrentGeneration = namespaceGeneration(reader.readU64());
    const aiCurrentGeneration = namespaceGeneration(reader.readU64());
    const previousBytes = reader.readFrame(HASH_BYTES);
    const previousBindingHash =
      previousBytes.length === 0 ? null : previousBytes;
    if (
      previousBindingHash !== null
      && previousBindingHash.length !== HASH_BYTES
    ) {
      throw new CanonicalDecodingError(
        "Previous binding hash must contain exactly 32 bytes",
      );
    }
    const humanKeyringEnvelopeHash = reader.readFrame(HASH_BYTES);
    const aiKeyringEnvelopeHash = reader.readFrame(HASH_BYTES);
    const committerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    const value: NamespaceBindingV2 = {
      formatVersion: NAMESPACE_BINDING_FORMAT_VERSION,
      namespaceId: decodedNamespaceId,
      domainId: decodedDomainId,
      domainEpoch: decodedDomainEpoch,
      accessRevision: decodedAccessRevision,
      humanCurrentGeneration,
      aiCurrentGeneration,
      previousBindingHash,
      humanKeyringEnvelopeHash,
      aiKeyringEnvelopeHash,
      committerDeviceId,
      signature,
    };
    assertNamespaceBinding(value);
    return value;
  });
  return Object.freeze(binding);
}
