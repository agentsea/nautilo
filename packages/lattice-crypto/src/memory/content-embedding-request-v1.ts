import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
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
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2 =
  2 as const;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2 =
  "nautilo/lattice-crypto/human-memory-content-embedding-request/v2";
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2 =
  "memory.content_embedding" as const;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2 =
  1536 as const;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2 =
  1 as const;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2 =
  64 * 1024;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2 = 30_000;
export const HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2 =
  V2_LIMITS.namespaceEnvelopesPerManifest;
export const MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2 =
  160 * 1024;

const HASH_BYTES = 32;
const MAX_TYPE_BYTES = 256;
const MEMORY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HumanMemoryContentEmbeddingProviderV2 =
  | "openai"
  | "openrouter"
  | "venice";

export interface HumanMemoryContentEmbeddingNamespaceEnvelopeV2 {
  readonly namespaceId: NamespaceId;
  readonly envelopeHash: Uint8Array;
}

export interface HumanMemoryContentEmbeddingRequestUnsignedV2 {
  readonly formatVersion:
    typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2;
  readonly purpose:
    typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2;
  readonly subjectHumanId: HumanId;
  readonly requestId: string;
  readonly memoryId: string;
  readonly expectedProductRevision: number;
  readonly nextProductRevision: number;
  readonly cryptoObjectId: ObjectId;
  readonly ciphertextPayloadHash: Uint8Array;
  readonly genesisManifestHash: Uint8Array;
  readonly namespaceEnvelopes:
    readonly HumanMemoryContentEmbeddingNamespaceEnvelopeV2[];
  readonly type: string;
  readonly content: string;
  readonly importance?: number;
  readonly requestedProvider: HumanMemoryContentEmbeddingProviderV2;
  readonly requestedModel: string;
  readonly dimensions:
    typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2;
  readonly processorContractVersion:
    typeof HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanMemoryContentEmbeddingRequestV2
  extends HumanMemoryContentEmbeddingRequestUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanMemoryContentEmbeddingRequestInputV2
  extends Omit<
    HumanMemoryContentEmbeddingRequestUnsignedV2,
    "formatVersion" | "purpose"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanMemoryContentEmbeddingRequestV2 {
  readonly request: HumanMemoryContentEmbeddingRequestV2;
  readonly bytes: Uint8Array;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "purpose",
  "subjectHumanId",
  "requestId",
  "memoryId",
  "expectedProductRevision",
  "nextProductRevision",
  "cryptoObjectId",
  "ciphertextPayloadHash",
  "genesisManifestHash",
  "namespaceEnvelopes",
  "type",
  "content",
  "importance",
  "requestedProvider",
  "requestedModel",
  "dimensions",
  "processorContractVersion",
  "issuedAt",
  "deadlineAt",
  "committerDeviceId",
  "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const ENVELOPE_FIELDS = Object.freeze(["namespaceId", "envelopeHash"]);

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
  ) throw new TypeError(`${label} has an invalid field set`);
}

function assertUnsignedFields(value: object): void {
  const actual = Object.keys(value).sort();
  const withoutImportance = UNSIGNED_FIELDS.filter(
    (field) => field !== "importance",
  ).sort();
  const withImportance = [...UNSIGNED_FIELDS].sort();
  if (![withoutImportance, withImportance].some((expected) =>
    actual.length === expected.length
    && actual.every((field, index) => field === expected[index])
  )) throw new TypeError("Human Memory content-embedding request has an invalid field set");
}

function assertSignedFields(value: object): void {
  const actual = Object.keys(value).sort();
  const withoutImportance = SIGNED_FIELDS.filter(
    (field) => field !== "importance",
  ).sort();
  const withImportance = [...SIGNED_FIELDS].sort();
  if (![withoutImportance, withImportance].some((expected) =>
    actual.length === expected.length
    && actual.every((field, index) => field === expected[index])
  )) throw new TypeError("Human Memory content-embedding request has an invalid field set");
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function wipeBytes(...values: readonly (Uint8Array | undefined)[]): void {
  for (const value of values) value?.fill(0);
}

function exactProductRevisionStep(
  expectedValue: unknown,
  nextValue: unknown,
): readonly [expected: number, next: number] {
  if (
    !Number.isSafeInteger(expectedValue)
    || (expectedValue as number) < 0
    || (expectedValue as number) >= 2_147_483_647
  ) {
    throw new RangeError(
      "Memory content-embedding expected product revision is invalid",
    );
  }
  const expectedProductRevision = expectedValue as number;
  const nextProductRevision = expectedProductRevision + 1;
  if (nextValue !== nextProductRevision) {
    throw new RangeError(
      "Memory content-embedding product revision must advance exactly once",
    );
  }
  return [expectedProductRevision, nextProductRevision];
}

function assertMemoryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MEMORY_ID.test(value)) {
    throw new TypeError("Memory content-embedding Memory ID is invalid");
  }
}

function normalizeNamespaceEnvelopes(
  value: unknown,
): readonly HumanMemoryContentEmbeddingNamespaceEnvelopeV2[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length
      > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2
  ) {
    throw new RangeError(
      "Memory content-embedding Namespace envelope inventory is not bounded",
    );
  }
  const normalized: HumanMemoryContentEmbeddingNamespaceEnvelopeV2[] = [];
  try {
    let previous: string | null = null;
    for (const raw of value) {
      assertObject("Memory content-embedding Namespace envelope", raw);
      assertExactFields(
        "Memory content-embedding Namespace envelope",
        raw,
        ENVELOPE_FIELDS,
      );
      const entry = raw as HumanMemoryContentEmbeddingNamespaceEnvelopeV2;
      const id = namespaceId(entry.namespaceId);
      if (previous !== null && compareUnsignedUtf8(previous, id) >= 0) {
        throw new TypeError(
          "Memory content-embedding Namespace envelope inventory must be unique and sorted",
        );
      }
      previous = id;
      normalized.push(Object.freeze({
        namespaceId: id,
        envelopeHash: exactBytes(
          "Memory content-embedding Namespace envelope hash",
          entry.envelopeHash,
          HASH_BYTES,
        ),
      }));
    }
    return Object.freeze(normalized);
  } catch (error) {
    wipeBytes(...normalized.map((entry) => entry.envelopeHash));
    throw error;
  }
}

function assertContent(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("Memory content-embedding plaintext must be text");
  }
  const bytes = utf8V2(value);
  try {
    if (
      bytes.length < 1
      || bytes.length
        > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2
    ) {
      throw new RangeError(
        "Memory content-embedding plaintext is outside its byte bound",
      );
    }
  } finally {
    wipeBytes(bytes);
  }
}

function assertType(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("Memory content-embedding type must be text");
  }
  const bytes = utf8V2(value);
  try {
    if (bytes.length < 1 || bytes.length > MAX_TYPE_BYTES) {
      throw new RangeError("Memory content-embedding type is outside its byte bound");
    }
  } finally {
    wipeBytes(bytes);
  }
}

function assertImportance(value: unknown): asserts value is number | undefined {
  if (value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value)
      || value < 0 || value > 1)) {
    throw new RangeError("Memory content-embedding importance is invalid");
  }
}

function normalizeUnsigned(
  value: HumanMemoryContentEmbeddingRequestUnsignedV2,
): HumanMemoryContentEmbeddingRequestUnsignedV2 {
  assertObject("Human Memory content-embedding request", value);
  assertUnsignedFields(value);
  if (
    value.formatVersion
      !== HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2
    || value.purpose !== HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2
  ) throw new TypeError("Human Memory content-embedding request kind is invalid");
  const subjectHumanId = humanId(value.subjectHumanId);
  assertPortableId("Memory content-embedding request id", value.requestId);
  assertMemoryId(value.memoryId);
  const [expectedProductRevision, nextProductRevision] =
    exactProductRevisionStep(
    value.expectedProductRevision,
    value.nextProductRevision,
  );
  const cryptoObjectId = objectId(value.cryptoObjectId);
  let ciphertextPayloadHash: Uint8Array | undefined;
  let genesisManifestHash: Uint8Array | undefined;
  let namespaceEnvelopes:
    | readonly HumanMemoryContentEmbeddingNamespaceEnvelopeV2[]
    | undefined;
  try {
    ciphertextPayloadHash = exactBytes(
      "Memory content-embedding ciphertext payload hash",
      value.ciphertextPayloadHash,
      HASH_BYTES,
    );
    genesisManifestHash = exactBytes(
      "Memory content-embedding genesis manifest hash",
      value.genesisManifestHash,
      HASH_BYTES,
    );
    namespaceEnvelopes = normalizeNamespaceEnvelopes(
      value.namespaceEnvelopes,
    );
    assertType(value.type);
    assertContent(value.content);
    assertImportance(value.importance);
    if (
      value.requestedProvider !== "openai"
      && value.requestedProvider !== "openrouter"
      && value.requestedProvider !== "venice"
    ) throw new TypeError("Memory content-embedding provider is unsupported");
    assertPortableId(
      "Memory content-embedding requested model",
      value.requestedModel,
    );
    if (
      value.dimensions
        !== HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2
      || value.processorContractVersion
        !== HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2
    ) throw new TypeError("Memory content-embedding processor contract is invalid");
    const issuedAt = unixTimestamp(value.issuedAt);
    const deadlineAt = unixTimestamp(value.deadlineAt);
    if (
      deadlineAt <= issuedAt
      || deadlineAt - issuedAt
        > HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2
    ) throw new RangeError("Memory content-embedding deadline is invalid");
    const committerDeviceId = cryptoDeviceId(value.committerDeviceId);
    const hostAuthorizationRevision = authorizationRevision(
      value.hostAuthorizationRevision,
    );
    return Object.freeze({
      formatVersion:
        HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2,
      purpose: HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2,
      subjectHumanId,
      requestId: value.requestId,
      memoryId: value.memoryId,
      expectedProductRevision,
      nextProductRevision,
      cryptoObjectId,
      ciphertextPayloadHash,
      genesisManifestHash,
      namespaceEnvelopes,
      type: value.type,
      content: value.content,
      ...(value.importance === undefined ? {} : { importance: value.importance }),
      requestedProvider: value.requestedProvider,
      requestedModel: value.requestedModel,
      dimensions: HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2,
      processorContractVersion:
        HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2,
      issuedAt,
      deadlineAt,
      committerDeviceId,
      hostAuthorizationRevision,
    });
  } catch (error) {
    wipeBytes(
      ciphertextPayloadHash,
      genesisManifestHash,
      ...(namespaceEnvelopes?.map((entry) => entry.envelopeHash) ?? []),
    );
    throw error;
  }
}

function normalizeRequest(
  value: HumanMemoryContentEmbeddingRequestV2,
): HumanMemoryContentEmbeddingRequestV2 {
  assertObject("Human Memory content-embedding request", value);
  assertSignedFields(value);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  try {
    return Object.freeze({
      ...unsigned,
      signature: exactBytes(
        "Human Memory content-embedding signature",
        rawSignature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function destroyUnsigned(
  value: HumanMemoryContentEmbeddingRequestUnsignedV2,
): void {
  wipeBytes(
    value.ciphertextPayloadHash,
    value.genesisManifestHash,
    ...value.namespaceEnvelopes.map((entry) => entry.envelopeHash),
  );
}

function destroyRequest(value: HumanMemoryContentEmbeddingRequestV2): void {
  destroyUnsigned(value);
  wipeBytes(value.signature);
}

function signingBytesFromNormalized(
  value: HumanMemoryContentEmbeddingRequestUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2),
    encodeU32(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2),
    frameText(value.purpose),
    frameText(value.subjectHumanId),
    frameText(value.requestId),
    frameText(value.memoryId),
    encodeU64(value.expectedProductRevision),
    encodeU64(value.nextProductRevision),
    frameText(value.cryptoObjectId),
    frame(value.ciphertextPayloadHash),
    frame(value.genesisManifestHash),
    encodeU32(value.namespaceEnvelopes.length),
    ...value.namespaceEnvelopes.flatMap((entry) => [
      frameText(entry.namespaceId),
      frame(entry.envelopeHash),
    ]),
    frameText(value.type),
    frameText(value.content),
    encodeU32(value.importance === undefined ? 0 : 1),
    ...(value.importance === undefined
      ? [] : [frameText(String(value.importance))]),
    frameText(value.requestedProvider),
    frameText(value.requestedModel),
    encodeU32(value.dimensions),
    encodeU32(value.processorContractVersion),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId),
    encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanMemoryContentEmbeddingRequestSigningBytesV2(
  value: HumanMemoryContentEmbeddingRequestUnsignedV2,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytesFromNormalized(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeHumanMemoryContentEmbeddingRequestV2(
  value: HumanMemoryContentEmbeddingRequestV2,
): Uint8Array {
  const normalized = normalizeRequest(value);
  try {
    const bytes = concatV2(
      signingBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (
      bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2
    ) {
      wipeBytes(bytes);
      throw new RangeError(
        "Human Memory content-embedding request exceeds its wire limit",
      );
    }
    return bytes;
  } finally {
    destroyRequest(normalized);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function decodeHumanMemoryContentEmbeddingRequestV2(
  bytes: Uint8Array,
): HumanMemoryContentEmbeddingRequestV2 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(
      "Human Memory content-embedding request bytes must be Uint8Array",
    );
  }
  if (
    bytes.length > MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2
  ) {
    throw new RangeError(
      "Human Memory content-embedding request exceeds its wire limit",
    );
  }
  const raw = decodeExact(bytes, (reader): HumanMemoryContentEmbeddingRequestV2 => {
    const domain = reader.readText(
      utf8V2(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2).length,
    );
    if (domain !== HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2) {
      throw new CanonicalDecodingError(
        "Human Memory content-embedding request domain mismatch",
      );
    }
    const formatVersion = reader.readVersion(
      HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2,
    ) as typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2;
    const purpose = reader.readText(
      utf8V2(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2).length,
    ) as typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2;
    const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const requestId = reader.readText(V2_LIMITS.idBytes);
    const memoryId = reader.readText(36);
    const expectedProductRevision = reader.readU64();
    const nextProductRevision = reader.readU64();
    const cryptoObjectId = objectId(reader.readText(V2_LIMITS.idBytes));
    const ciphertextPayloadHash = reader.readFrame(HASH_BYTES);
    const genesisManifestHash = reader.readFrame(HASH_BYTES);
    const namespaceEnvelopeCount = reader.readCount(
      HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_NAMESPACE_ENVELOPES_V2,
    );
    const namespaceEnvelopes = Array.from(
      { length: namespaceEnvelopeCount },
      (): HumanMemoryContentEmbeddingNamespaceEnvelopeV2 => ({
        namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
        envelopeHash: reader.readFrame(HASH_BYTES),
      }),
    );
    return {
      formatVersion,
      purpose,
      subjectHumanId,
      requestId,
      memoryId,
      expectedProductRevision,
      nextProductRevision,
      cryptoObjectId,
      ciphertextPayloadHash,
      genesisManifestHash,
      namespaceEnvelopes,
      type: reader.readText(MAX_TYPE_BYTES),
      content: reader.readText(
        HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2,
      ),
      ...(() => {
        const present = reader.readU32();
        if (present === 0) return {};
        if (present !== 1) throw new CanonicalDecodingError(
          "Human Memory content-embedding importance marker is invalid",
        );
        const encoded = reader.readText(32);
        const importance = Number(encoded);
        if (String(importance) !== encoded) throw new CanonicalDecodingError(
          "Human Memory content-embedding importance is noncanonical",
        );
        return { importance };
      })(),
      requestedProvider: (
        reader.readText(V2_LIMITS.idBytes)
      ) as HumanMemoryContentEmbeddingProviderV2,
      requestedModel: reader.readText(V2_LIMITS.idBytes),
      dimensions: (
        reader.readU32()
      ) as typeof HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DIMENSIONS_V2,
      processorContractVersion: (
        reader.readU32()
      ) as typeof HUMAN_MEMORY_CONTENT_EMBEDDING_PROCESSOR_CONTRACT_VERSION_V2,
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: HumanMemoryContentEmbeddingRequestV2 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeRequest(raw);
    canonical = encodeHumanMemoryContentEmbeddingRequestV2(normalized);
    if (!equalBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Human Memory content-embedding request is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyRequest(raw);
    if (normalized !== undefined) destroyRequest(normalized);
    wipeBytes(canonical);
  }
}

export function prepareHumanMemoryContentEmbeddingRequestV2(
  crypto: LatticeCrypto,
  input: PrepareHumanMemoryContentEmbeddingRequestInputV2,
): CreatedHumanMemoryContentEmbeddingRequestV2 {
  const {
    committerSigningPublicKey: rawPublicKey,
    committerSigningPrivateKey: rawPrivateKey,
    ...rawUnsigned
  } = input;
  const unsigned = normalizeUnsigned({
    ...rawUnsigned,
    formatVersion: HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2,
    purpose: HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_PURPOSE_V2,
  });
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    publicKey = exactBytes(
      "Human Memory content-embedding signing public key",
      rawPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    privateKey = exactBytes(
      "Human Memory content-embedding signing private key",
      rawPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    signingBytes = signingBytesFromNormalized(unsigned);
    signature = exactBytes(
      "Human Memory content-embedding signature",
      crypto.sign(privateKey, signingBytes),
      V2_LIMITS.signatureBytes,
    );
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError(
        "Human Memory content-embedding signing keys do not match",
      );
    }
    const bytes = encodeHumanMemoryContentEmbeddingRequestV2({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      request: decodeHumanMemoryContentEmbeddingRequestV2(bytes),
      bytes,
    });
  } finally {
    destroyUnsigned(unsigned);
    wipeBytes(publicKey, privateKey, signingBytes, signature);
  }
}

export function verifyHumanMemoryContentEmbeddingRequestV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    readonly requestBytes: Uint8Array;
    readonly committerSigningPublicKey: Uint8Array;
    readonly now: UnixTimestamp;
  }>,
): HumanMemoryContentEmbeddingRequestV2 {
  const request = decodeHumanMemoryContentEmbeddingRequestV2(
    input.requestBytes,
  );
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let verified = false;
  try {
    publicKey = exactBytes(
      "Human Memory content-embedding signing public key",
      input.committerSigningPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signingBytes = signingBytesFromNormalized(request);
    if (!crypto.verify(publicKey, signingBytes, request.signature)) {
      throw new TypeError(
        "Human Memory content-embedding request signature is invalid",
      );
    }
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt) {
      throw new TypeError(
        "Human Memory content-embedding request is not currently valid",
      );
    }
    verified = true;
    return request;
  } finally {
    wipeBytes(publicKey, signingBytes);
    if (!verified) destroyRequest(request);
  }
}
