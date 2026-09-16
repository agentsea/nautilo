import {
  CanonicalDecodingError,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "../format/v2-primitives.ts";
import {
  cryptoDomainId,
  domainEpoch,
  type CryptoDomainId,
  type DomainEpoch,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1 = 1 as const;
const PROCESSOR_CREDENTIAL_SECRET_DOMAIN_V1 =
  "nautilo/lattice-crypto/processor-credential-secret/v1";
export const MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1 = 512;

const HASH_BYTES = 32;
const ROOT_BYTES = 32;

export interface ProcessorCredentialSecretV1 {
  readonly formatVersion:
    typeof PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1;
  readonly workDescriptorHash: Uint8Array;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly aiRoot: Uint8Array;
  readonly processorSignerPrivateKey: Uint8Array;
}

const SECRET_FIELDS = Object.freeze([
  "formatVersion",
  "workDescriptorHash",
  "domainId",
  "domainEpoch",
  "aiRoot",
  "processorSignerPrivateKey",
] as const);

function assertObject(label: string, value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactFields(
  label: string,
  value: object,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length
    || actual.some((field, index) => field !== canonical[index])
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(
  label: string,
  value: unknown,
  length: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function destroyProcessorCredentialSecretV1(
  value: ProcessorCredentialSecretV1,
): void {
  value.workDescriptorHash.fill(0);
  value.aiRoot.fill(0);
  value.processorSignerPrivateKey.fill(0);
}

function normalizeSecret(
  value: ProcessorCredentialSecretV1,
): ProcessorCredentialSecretV1 {
  assertObject("Processor credential secret", value);
  assertExactFields(
    "Processor credential secret",
    value,
    SECRET_FIELDS,
  );
  if (
    value.formatVersion !== PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1
  ) {
    throw new TypeError(
      "Processor credential secret format version is invalid",
    );
  }
  let workDescriptorHash: Uint8Array | undefined;
  let aiRoot: Uint8Array | undefined;
  let processorSignerPrivateKey: Uint8Array | undefined;
  try {
    workDescriptorHash = exactBytes(
      "Processor credential secret work descriptor hash",
      value.workDescriptorHash,
      HASH_BYTES,
    );
    const domainId = cryptoDomainId(value.domainId);
    const checkedDomainEpoch = domainEpoch(value.domainEpoch);
    aiRoot = exactBytes(
      "Processor credential secret AI root",
      value.aiRoot,
      ROOT_BYTES,
    );
    processorSignerPrivateKey = exactBytes(
      "Processor credential secret signer private key",
      value.processorSignerPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    return Object.freeze({
      formatVersion: PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
      workDescriptorHash,
      domainId,
      domainEpoch: checkedDomainEpoch,
      aiRoot,
      processorSignerPrivateKey,
    });
  } catch (error) {
    workDescriptorHash?.fill(0);
    aiRoot?.fill(0);
    processorSignerPrivateKey?.fill(0);
    throw error;
  }
}

function encodeNormalized(
  value: ProcessorCredentialSecretV1,
): Uint8Array {
  const encoded = concatV2(
    frameText(PROCESSOR_CREDENTIAL_SECRET_DOMAIN_V1),
    encodeU32(PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1),
    frame(value.workDescriptorHash),
    frameText(value.domainId),
    encodeU64(value.domainEpoch),
    frame(value.aiRoot),
    frame(value.processorSignerPrivateKey),
  );
  if (encoded.length > MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1) {
    encoded.fill(0);
    throw new RangeError(
      "Processor credential secret exceeds its wire limit",
    );
  }
  return encoded;
}

export function encodeProcessorCredentialSecretV1(
  value: ProcessorCredentialSecretV1,
): Uint8Array {
  const normalized = normalizeSecret(value);
  try {
    return encodeNormalized(normalized);
  } finally {
    destroyProcessorCredentialSecretV1(normalized);
  }
}

export function decodeProcessorCredentialSecretV1(
  bytes: Uint8Array,
): ProcessorCredentialSecretV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Processor credential secret bytes must be Uint8Array");
  }
  if (bytes.length > MAX_PROCESSOR_CREDENTIAL_SECRET_WIRE_BYTES_V1) {
    throw new RangeError(
      "Processor credential secret exceeds its wire limit",
    );
  }
  const raw = decodeExact(bytes, (reader): ProcessorCredentialSecretV1 => {
    const domain = reader.readText(
      utf8V2(PROCESSOR_CREDENTIAL_SECRET_DOMAIN_V1).length,
    );
    if (domain !== PROCESSOR_CREDENTIAL_SECRET_DOMAIN_V1) {
      throw new CanonicalDecodingError(
        "Processor credential secret domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1,
    ) as typeof PROCESSOR_CREDENTIAL_SECRET_FORMAT_VERSION_V1;
    return {
      formatVersion,
      workDescriptorHash: reader.readFrame(HASH_BYTES),
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      domainEpoch: domainEpoch(reader.readU64()),
      aiRoot: reader.readFrame(ROOT_BYTES),
      processorSignerPrivateKey:
        reader.readFrame(V2_LIMITS.signingPrivateKeyBytes),
    };
  });
  let normalized: ProcessorCredentialSecretV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeSecret(raw);
    canonical = encodeNormalized(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Processor credential secret is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyProcessorCredentialSecretV1(raw);
    if (normalized !== undefined) {
      destroyProcessorCredentialSecretV1(normalized);
    }
    canonical?.fill(0);
  }
}
