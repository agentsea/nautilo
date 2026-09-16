import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import type { NamespaceKeyClass } from "../namespace/types.ts";
import {
  accessRevision,
  assertPortableId,
  assertU64Counter,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  type AccessRevision,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type NamespaceKeyGeneration,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
  utf8V2,
} from "./v2-primitives.ts";

export const NAMESPACE_DELIVERY_FORMAT_VERSION_V1 = 1 as const;
export const NAMESPACE_GENERATION_FETCH_PROOF_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-fetch-proof/v1";
export const NAMESPACE_GENERATION_ACKNOWLEDGEMENT_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-acknowledgement/v1";
export const NAMESPACE_DELIVERY_MAX_TTL_MS_V1 = 30_000;
export const MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1 = 8 * 1024;

const FETCH_PURPOSE = "namespace.generation_fetch";
const ACKNOWLEDGEMENT_PURPOSE = "namespace.generation_acknowledge";
const HASH_BYTES = 32;

export interface NamespaceGenerationFetchProofUnsignedV1 {
  readonly formatVersion: typeof NAMESPACE_DELIVERY_FORMAT_VERSION_V1;
  readonly requestId: string;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly deviceSigningKeyGeneration: number;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface NamespaceGenerationFetchProofV1
  extends NamespaceGenerationFetchProofUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface NamespaceGenerationAcknowledgementUnsignedV1 {
  readonly formatVersion: typeof NAMESPACE_DELIVERY_FORMAT_VERSION_V1;
  readonly acknowledgementId: string;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly deviceSigningKeyGeneration: number;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly processedRevision: number;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface NamespaceGenerationAcknowledgementV1
  extends NamespaceGenerationAcknowledgementUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface PreparedNamespaceDeliveryRecordV1<Value> {
  readonly value: Value;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

const FETCH_FIELDS = Object.freeze([
  "formatVersion",
  "requestId",
  "humanId",
  "deviceId",
  "deviceSigningKeyGeneration",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "headDigest",
  "publicationDigest",
  "recipientKeyId",
  "recipientKeyGeneration",
  "issuedAt",
  "expiresAt",
] as const);

const ACKNOWLEDGEMENT_FIELDS = Object.freeze([
  "formatVersion",
  "acknowledgementId",
  "humanId",
  "deviceId",
  "deviceSigningKeyGeneration",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "headDigest",
  "publicationDigest",
  "envelopeDigest",
  "recipientKeyId",
  "recipientKeyGeneration",
  "processedRevision",
  "issuedAt",
  "expiresAt",
] as const);

function exactFields(
  label: string,
  value: object,
  fields: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((fieldName, index) => fieldName !== expected[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown): number {
  assertU64Counter(label, value);
  return value;
}

function keyClass(value: unknown): NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("Namespace delivery key class is unsupported");
  }
  return value;
}

function validWindow(issuedAt: UnixTimestamp, expiresAt: UnixTimestamp): void {
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > NAMESPACE_DELIVERY_MAX_TTL_MS_V1
  ) throw new RangeError("Namespace delivery validity window is invalid");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function readExactText(
  reader: StrictDecoder,
  expected: string,
  label: string,
): void {
  if (reader.readText(utf8V2(expected).length) !== expected) {
    throw new CanonicalDecodingError(`${label} is unsupported`);
  }
}

function normalizeFetch(
  value: NamespaceGenerationFetchProofUnsignedV1,
): NamespaceGenerationFetchProofUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation fetch proof must be an object");
  }
  exactFields("Namespace generation fetch proof", value, FETCH_FIELDS);
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation fetch proof version is unsupported");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  validWindow(issuedAt, expiresAt);
  return Object.freeze({
    formatVersion: 1,
    requestId: portable("Namespace generation fetch request ID", value.requestId),
    humanId: humanId(value.humanId),
    deviceId: cryptoDeviceId(value.deviceId),
    deviceSigningKeyGeneration: counter(
      "Namespace generation fetch device signing-key generation",
      value.deviceSigningKeyGeneration,
    ),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation: namespaceGeneration(value.generation),
    headDigest: exactBytes("Namespace generation fetch head digest", value.headDigest, HASH_BYTES),
    publicationDigest: exactBytes(
      "Namespace generation fetch publication digest",
      value.publicationDigest,
      HASH_BYTES,
    ),
    recipientKeyId: portable(
      "Namespace generation fetch recipient key ID",
      value.recipientKeyId,
    ),
    recipientKeyGeneration: counter(
      "Namespace generation fetch recipient key generation",
      value.recipientKeyGeneration,
    ),
    issuedAt,
    expiresAt,
  });
}

function destroyFetch(value: NamespaceGenerationFetchProofUnsignedV1): void {
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
}

function fetchSigningBytesFromNormalized(
  value: NamespaceGenerationFetchProofUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_FETCH_PROOF_DOMAIN_V1),
    frameText(FETCH_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.requestId),
    frameText(value.humanId),
    frameText(value.deviceId),
    encodeU64(value.deviceSigningKeyGeneration),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.headDigest),
    frame(value.publicationDigest),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function namespaceGenerationFetchProofSigningBytesV1(
  value: NamespaceGenerationFetchProofUnsignedV1,
): Uint8Array {
  const normalized = normalizeFetch(value);
  try {
    return fetchSigningBytesFromNormalized(normalized);
  } finally {
    destroyFetch(normalized);
  }
}

function normalizeSignedFetch(
  value: NamespaceGenerationFetchProofV1,
): NamespaceGenerationFetchProofV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation fetch proof must be an object");
  }
  exactFields(
    "Namespace generation fetch proof",
    value,
    [...FETCH_FIELDS, "signature"],
  );
  const { signature, ...unsigned } = value;
  const normalized = normalizeFetch(unsigned);
  try {
    return Object.freeze({
      ...normalized,
      signature: exactBytes(
        "Namespace generation fetch proof signature",
        signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyFetch(normalized);
    throw error;
  }
}

function destroySignedFetch(value: NamespaceGenerationFetchProofV1): void {
  destroyFetch(value);
  value.signature.fill(0);
}

export function encodeNamespaceGenerationFetchProofV1(
  value: NamespaceGenerationFetchProofV1,
): Uint8Array {
  const normalized = normalizeSignedFetch(value);
  try {
    const bytes = concatV2(
      fetchSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Namespace generation fetch proof exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroySignedFetch(normalized);
  }
}

function readFetch(reader: StrictDecoder): NamespaceGenerationFetchProofUnsignedV1 {
  readExactText(reader, NAMESPACE_GENERATION_FETCH_PROOF_DOMAIN_V1, "Fetch domain");
  readExactText(reader, FETCH_PURPOSE, "Fetch purpose");
  return {
    formatVersion: reader.readVersion(1) as 1,
    requestId: reader.readText(V2_LIMITS.idBytes),
    humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
    deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    deviceSigningKeyGeneration: reader.readU64(),
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    keyClass: reader.readText(5) as NamespaceKeyClass,
    accessRevision: accessRevision(reader.readU64()),
    generation: namespaceGeneration(reader.readU64()),
    headDigest: reader.readFrame(HASH_BYTES),
    publicationDigest: reader.readFrame(HASH_BYTES),
    recipientKeyId: reader.readText(V2_LIMITS.idBytes),
    recipientKeyGeneration: reader.readU64(),
    issuedAt: unixTimestamp(reader.readU64()),
    expiresAt: unixTimestamp(reader.readU64()),
  };
}

export function decodeNamespaceGenerationFetchProofV1(
  bytes: Uint8Array,
): NamespaceGenerationFetchProofV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1) {
    throw new TypeError("Namespace generation fetch proof bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationFetchProofV1 => ({
    ...readFetch(reader),
    signature: reader.readFrame(V2_LIMITS.signatureBytes),
  }));
  let normalized: NamespaceGenerationFetchProofV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeSignedFetch(raw);
    canonical = concatV2(
      fetchSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Namespace generation fetch proof is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroySignedFetch(raw);
    if (normalized) destroySignedFetch(normalized);
    canonical?.fill(0);
  }
}

function normalizeAcknowledgement(
  value: NamespaceGenerationAcknowledgementUnsignedV1,
): NamespaceGenerationAcknowledgementUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation acknowledgement must be an object");
  }
  exactFields(
    "Namespace generation acknowledgement",
    value,
    ACKNOWLEDGEMENT_FIELDS,
  );
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation acknowledgement version is unsupported");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  validWindow(issuedAt, expiresAt);
  return Object.freeze({
    formatVersion: 1,
    acknowledgementId: portable(
      "Namespace generation acknowledgement ID",
      value.acknowledgementId,
    ),
    humanId: humanId(value.humanId),
    deviceId: cryptoDeviceId(value.deviceId),
    deviceSigningKeyGeneration: counter(
      "Namespace generation acknowledgement signing-key generation",
      value.deviceSigningKeyGeneration,
    ),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation: namespaceGeneration(value.generation),
    headDigest: exactBytes("Namespace generation acknowledgement head digest", value.headDigest, HASH_BYTES),
    publicationDigest: exactBytes(
      "Namespace generation acknowledgement publication digest",
      value.publicationDigest,
      HASH_BYTES,
    ),
    envelopeDigest: exactBytes(
      "Namespace generation acknowledgement envelope digest",
      value.envelopeDigest,
      HASH_BYTES,
    ),
    recipientKeyId: portable(
      "Namespace generation acknowledgement recipient key ID",
      value.recipientKeyId,
    ),
    recipientKeyGeneration: counter(
      "Namespace generation acknowledgement recipient key generation",
      value.recipientKeyGeneration,
    ),
    processedRevision: counter(
      "Namespace generation acknowledgement processed revision",
      value.processedRevision,
    ),
    issuedAt,
    expiresAt,
  });
}

function destroyAcknowledgement(
  value: NamespaceGenerationAcknowledgementUnsignedV1,
): void {
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
  value.envelopeDigest.fill(0);
}

function acknowledgementSigningBytesFromNormalized(
  value: NamespaceGenerationAcknowledgementUnsignedV1,
): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_ACKNOWLEDGEMENT_DOMAIN_V1),
    frameText(ACKNOWLEDGEMENT_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.acknowledgementId),
    frameText(value.humanId),
    frameText(value.deviceId),
    encodeU64(value.deviceSigningKeyGeneration),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.headDigest),
    frame(value.publicationDigest),
    frame(value.envelopeDigest),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    encodeU64(value.processedRevision),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function namespaceGenerationAcknowledgementSigningBytesV1(
  value: NamespaceGenerationAcknowledgementUnsignedV1,
): Uint8Array {
  const normalized = normalizeAcknowledgement(value);
  try {
    return acknowledgementSigningBytesFromNormalized(normalized);
  } finally {
    destroyAcknowledgement(normalized);
  }
}

function normalizeSignedAcknowledgement(
  value: NamespaceGenerationAcknowledgementV1,
): NamespaceGenerationAcknowledgementV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation acknowledgement must be an object");
  }
  exactFields(
    "Namespace generation acknowledgement",
    value,
    [...ACKNOWLEDGEMENT_FIELDS, "signature"],
  );
  const { signature, ...unsigned } = value;
  const normalized = normalizeAcknowledgement(unsigned);
  try {
    return Object.freeze({
      ...normalized,
      signature: exactBytes(
        "Namespace generation acknowledgement signature",
        signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyAcknowledgement(normalized);
    throw error;
  }
}

function destroySignedAcknowledgement(
  value: NamespaceGenerationAcknowledgementV1,
): void {
  destroyAcknowledgement(value);
  value.signature.fill(0);
}

export function encodeNamespaceGenerationAcknowledgementV1(
  value: NamespaceGenerationAcknowledgementV1,
): Uint8Array {
  const normalized = normalizeSignedAcknowledgement(value);
  try {
    const bytes = concatV2(
      acknowledgementSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError(
        "Namespace generation acknowledgement exceeds its wire limit",
      );
    }
    return bytes;
  } finally {
    destroySignedAcknowledgement(normalized);
  }
}

function readAcknowledgement(
  reader: StrictDecoder,
): NamespaceGenerationAcknowledgementUnsignedV1 {
  readExactText(
    reader,
    NAMESPACE_GENERATION_ACKNOWLEDGEMENT_DOMAIN_V1,
    "Acknowledgement domain",
  );
  readExactText(reader, ACKNOWLEDGEMENT_PURPOSE, "Acknowledgement purpose");
  return {
    formatVersion: reader.readVersion(1) as 1,
    acknowledgementId: reader.readText(V2_LIMITS.idBytes),
    humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
    deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    deviceSigningKeyGeneration: reader.readU64(),
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    keyClass: reader.readText(5) as NamespaceKeyClass,
    accessRevision: accessRevision(reader.readU64()),
    generation: namespaceGeneration(reader.readU64()),
    headDigest: reader.readFrame(HASH_BYTES),
    publicationDigest: reader.readFrame(HASH_BYTES),
    envelopeDigest: reader.readFrame(HASH_BYTES),
    recipientKeyId: reader.readText(V2_LIMITS.idBytes),
    recipientKeyGeneration: reader.readU64(),
    processedRevision: reader.readU64(),
    issuedAt: unixTimestamp(reader.readU64()),
    expiresAt: unixTimestamp(reader.readU64()),
  };
}

export function decodeNamespaceGenerationAcknowledgementV1(
  bytes: Uint8Array,
): NamespaceGenerationAcknowledgementV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_NAMESPACE_DELIVERY_WIRE_BYTES_V1) {
    throw new TypeError("Namespace generation acknowledgement bytes are invalid");
  }
  const raw = decodeExact(
    bytes,
    (reader): NamespaceGenerationAcknowledgementV1 => ({
      ...readAcknowledgement(reader),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    }),
  );
  let normalized: NamespaceGenerationAcknowledgementV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeSignedAcknowledgement(raw);
    canonical = concatV2(
      acknowledgementSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Namespace generation acknowledgement is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroySignedAcknowledgement(raw);
    if (normalized) destroySignedAcknowledgement(normalized);
    canonical?.fill(0);
  }
}

function prepareSigned<Value extends { readonly signature: Uint8Array }>(
  crypto: LatticeCrypto,
  unsigned: Omit<Value, "signature">,
  signingPublicKey: Uint8Array,
  signingPrivateKey: Uint8Array,
  signingBytes: (value: Omit<Value, "signature">) => Uint8Array,
  encode: (value: Value) => Uint8Array,
  decode: (bytes: Uint8Array) => Value,
): PreparedNamespaceDeliveryRecordV1<Value> {
  const publicKey = exactBytes(
    "Namespace delivery signing public key",
    signingPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Namespace delivery signing private key",
    signingPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  let message: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    message = signingBytes(unsigned);
    signature = crypto.sign(privateKey, message);
    if (!crypto.verify(publicKey, message, signature)) {
      throw new TypeError("Namespace delivery signing keys do not match");
    }
    const bytes = encode({ ...unsigned, signature } as Value);
    return Object.freeze({ value: decode(bytes), bytes, digest: sha256(bytes) });
  } finally {
    publicKey.fill(0);
    privateKey.fill(0);
    message?.fill(0);
    signature?.fill(0);
  }
}

export function prepareNamespaceGenerationFetchProofV1(
  crypto: LatticeCrypto,
  input: Omit<NamespaceGenerationFetchProofUnsignedV1, "formatVersion"> &
    Readonly<{
      signingPublicKey: Uint8Array;
      signingPrivateKey: Uint8Array;
    }>,
): PreparedNamespaceDeliveryRecordV1<NamespaceGenerationFetchProofV1> {
  const { signingPublicKey, signingPrivateKey, ...rest } = input;
  return prepareSigned(
    crypto,
    { ...rest, formatVersion: 1 },
    signingPublicKey,
    signingPrivateKey,
    namespaceGenerationFetchProofSigningBytesV1,
    encodeNamespaceGenerationFetchProofV1,
    decodeNamespaceGenerationFetchProofV1,
  );
}

export function prepareNamespaceGenerationAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Omit<NamespaceGenerationAcknowledgementUnsignedV1, "formatVersion"> &
    Readonly<{
      signingPublicKey: Uint8Array;
      signingPrivateKey: Uint8Array;
    }>,
): PreparedNamespaceDeliveryRecordV1<NamespaceGenerationAcknowledgementV1> {
  const { signingPublicKey, signingPrivateKey, ...rest } = input;
  return prepareSigned(
    crypto,
    { ...rest, formatVersion: 1 },
    signingPublicKey,
    signingPrivateKey,
    namespaceGenerationAcknowledgementSigningBytesV1,
    encodeNamespaceGenerationAcknowledgementV1,
    decodeNamespaceGenerationAcknowledgementV1,
  );
}

function verifySigned<Value extends { readonly signature: Uint8Array }>(
  crypto: LatticeCrypto,
  bytes: Uint8Array,
  now: UnixTimestamp,
  signingPublicKey: Uint8Array,
  decode: (value: Uint8Array) => Value,
  signingBytes: (value: Omit<Value, "signature">) => Uint8Array,
): Value | null {
  const publicKey = exactBytes(
    "Namespace delivery signing public key",
    signingPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let value: Value | undefined;
  let message: Uint8Array | undefined;
  try {
    value = decode(bytes);
    const temporal = value as Value & { issuedAt: UnixTimestamp; expiresAt: UnixTimestamp };
    const checkedNow = unixTimestamp(now);
    if (checkedNow < temporal.issuedAt || checkedNow >= temporal.expiresAt) {
      return null;
    }
    const { signature: _signature, ...unsigned } = value;
    message = signingBytes(unsigned);
    return crypto.verify(publicKey, message, value.signature) ? value : null;
  } catch {
    return null;
  } finally {
    publicKey.fill(0);
    message?.fill(0);
  }
}

export function verifyNamespaceGenerationFetchProofV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    bytes: Uint8Array;
    now: UnixTimestamp;
    signingPublicKey: Uint8Array;
  }>,
): NamespaceGenerationFetchProofV1 | null {
  return verifySigned(
    crypto,
    input.bytes,
    input.now,
    input.signingPublicKey,
    decodeNamespaceGenerationFetchProofV1,
    namespaceGenerationFetchProofSigningBytesV1,
  );
}

export function verifyNamespaceGenerationAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    bytes: Uint8Array;
    now: UnixTimestamp;
    signingPublicKey: Uint8Array;
  }>,
): NamespaceGenerationAcknowledgementV1 | null {
  return verifySigned(
    crypto,
    input.bytes,
    input.now,
    input.signingPublicKey,
    decodeNamespaceGenerationAcknowledgementV1,
    namespaceGenerationAcknowledgementSigningBytesV1,
  );
}
