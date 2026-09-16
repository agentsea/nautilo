import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import { compareUnsignedUtf8 } from "../domain/participants.ts";
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
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
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

export const NAMESPACE_GENERATION_FORMAT_VERSION_V1 = 1 as const;
export const NAMESPACE_GENERATION_HEAD_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-head/v1";
export const NAMESPACE_GENERATION_SECRET_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-secret/v1";
export const NAMESPACE_GENERATION_ENVELOPE_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-recipient-envelope/v1";
export const NAMESPACE_GENERATION_PUBLICATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-publication/v1";
export const NAMESPACE_GENERATION_RECEIPT_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-receipt/v1";
export const NAMESPACE_GENERATION_PUBLICATION_SET_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-publication-set/v1";
export const NAMESPACE_GENERATION_AUDIENCE_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-audience/v1";
export const NAMESPACE_GENERATION_KEY_COMMITMENT_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-generation-key-commitment/v1";
export const NAMESPACE_GENERATION_MAX_TTL_MS_V1 = 30_000;
/**
 * One atomic Namespace publication is bounded by the canonical recipient-
 * envelope ledger, not by unrelated Domain topology limits. This is a
 * resource-safety envelope rather than a product Room-size limit. A larger
 * future fanout needs a resumable publication protocol, not a silent subset of
 * recipients.
 */
export const NAMESPACE_GENERATION_MAX_RECIPIENTS_V1 = 4_096;
export const MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1 = 4 * 1024;
export const MAX_NAMESPACE_GENERATION_ENVELOPE_WIRE_BYTES_V1 = 16 * 1024;
/** Two canonical key-class publications share the durable 64 MiB aggregate. */
export const MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1 =
  32 * 1024 * 1024;

const HEAD_PURPOSE = "namespace.generation_head";
const SECRET_PURPOSE = "namespace.generation_recipient_secret";
const ENVELOPE_PURPOSE = "namespace.generation_recipient_envelope";
const PUBLICATION_PURPOSE = "namespace.generation_publication";
const RECEIPT_PURPOSE = "namespace.generation_publication_receipt";
const PUBLICATION_SET_PURPOSE = "namespace.generation_publication_set";
const RECIPIENT_SET_DOMAIN =
  "nautilo/lattice-crypto/namespace-generation-recipient-set/v1";

export function namespaceGenerationAudienceFingerprintV1(
  participants: readonly HumanId[],
): Uint8Array {
  const canonical = participants
    .map((participant) => humanId(participant))
    .sort(compareUnsignedUtf8);
  if (canonical.length < 1) {
    throw new RangeError("Namespace generation audience must not be empty");
  }
  for (let index = 1; index < canonical.length; index++) {
    if (canonical[index - 1] === canonical[index]) {
      throw new RangeError("Namespace generation audience contains a duplicate");
    }
  }
  // Audience size is independent of a single V1 recipient publication. Feed
  // the existing canonical framing incrementally instead of concatenating a
  // second complete roster buffer. Existing audience hash bytes stay exact.
  const hash = sha256.create();
  hash.update(frameText(NAMESPACE_GENERATION_AUDIENCE_DOMAIN_V1));
  hash.update(encodeU32(canonical.length));
  for (const participant of canonical) hash.update(frameText(participant));
  return hash.digest();
}
const HASH_BYTES = 32;
const KEY_BYTES = 32;

export type NamespaceGenerationRecipientKindV1 = "device" | "recovery";

export interface NamespaceGenerationRecipientV1 {
  readonly recipientHumanId: HumanId;
  readonly recipientKind: NamespaceGenerationRecipientKindV1;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPublicKeyDigest: Uint8Array;
}

export interface NamespaceGenerationRecipientInputV1
  extends NamespaceGenerationRecipientV1 {
  readonly recipientPublicKey: Uint8Array;
}

export interface NamespaceGenerationHeadV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly operationId: string;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKeyCommitment: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly previousHeadDigest: Uint8Array | null;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly recipientCount: number;
  readonly recipientSetDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface NamespaceGenerationKeyCommitmentInputV1 {
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKey: Uint8Array;
}

export function namespaceGenerationKeyCommitmentV1(
  input: NamespaceGenerationKeyCommitmentInputV1,
): Uint8Array {
  const key = exactBytes(
    "Namespace generation commitment key",
    input.generationKey,
    KEY_BYTES,
  );
  let bytes: Uint8Array | undefined;
  try {
    bytes = concatV2(
      frameText(NAMESPACE_GENERATION_KEY_COMMITMENT_DOMAIN_V1),
      encodeU32(NAMESPACE_GENERATION_FORMAT_VERSION_V1),
      frameText(namespaceId(input.namespaceId)),
      frameText(keyClass(input.keyClass)),
      encodeU64(namespaceGeneration(input.generation)),
      frame(key),
    );
    return sha256(bytes);
  } finally {
    key.fill(0);
    bytes?.fill(0);
  }
}

export interface NamespaceGenerationSecretV1
  extends NamespaceGenerationRecipientV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKey: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly headDigest: Uint8Array;
}

export interface NamespaceGenerationRecipientEnvelopeV1
  extends NamespaceGenerationRecipientV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly audienceFingerprint: Uint8Array;
  readonly headDigest: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export interface NamespaceGenerationPublicationV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly head: NamespaceGenerationHeadV1;
  readonly envelopes: readonly NamespaceGenerationRecipientEnvelopeV1[];
  readonly signature: Uint8Array;
}

export interface NamespaceGenerationReceiptV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly operationId: string;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
  readonly committedAt: UnixTimestamp;
}

export interface PrepareNamespaceGenerationPublicationInputV1 {
  readonly operationId: string;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKey: Uint8Array;
  readonly audienceFingerprint: Uint8Array;
  readonly previousHeadDigest: Uint8Array | null;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly recipients: readonly NamespaceGenerationRecipientInputV1[];
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface PreparedNamespaceGenerationPublicationV1 {
  readonly publication: NamespaceGenerationPublicationV1;
  readonly bytes: Uint8Array;
  readonly headDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
}

export interface OpenNamespaceGenerationEnvelopeInputV1 {
  readonly publicationBytes: Uint8Array;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly recipientHumanId: HumanId;
  readonly recipientKind: NamespaceGenerationRecipientKindV1;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPrivateKey: Uint8Array;
  readonly now: UnixTimestamp;
  readonly expectedPublicationDigest?: Uint8Array;
}

export interface OpenedNamespaceGenerationV1 {
  readonly head: NamespaceGenerationHeadV1;
  readonly generationKey: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly publicationDigest: Uint8Array;
}

export interface NamespaceGenerationPublicationSetEntryV1 {
  readonly keyClass: NamespaceKeyClass;
  readonly publicationBytes: Uint8Array;
  readonly publicationDigest: Uint8Array;
}

export interface NamespaceGenerationPublicationSetV1 {
  readonly formatVersion: typeof NAMESPACE_GENERATION_FORMAT_VERSION_V1;
  readonly operationId: string;
  readonly namespaceId: NamespaceId;
  readonly accessRevision: AccessRevision;
  readonly audienceFingerprint: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly totalEnvelopeCount: number;
  readonly entrySetDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly entries: readonly NamespaceGenerationPublicationSetEntryV1[];
  readonly signature: Uint8Array;
}

export interface PrepareNamespaceGenerationPublicationSetClassV1 {
  readonly keyClass: NamespaceKeyClass;
  readonly generation: NamespaceKeyGeneration;
  readonly generationKey: Uint8Array;
  readonly previousHeadDigest: Uint8Array | null;
}

export interface PrepareNamespaceGenerationPublicationSetInputV1 {
  readonly operationId: string;
  readonly namespaceId: NamespaceId;
  readonly accessRevision: AccessRevision;
  readonly audienceFingerprint: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly recipients: readonly NamespaceGenerationRecipientInputV1[];
  /** Exactly `ai`, then `human`; both classes commit atomically. */
  readonly classes: readonly PrepareNamespaceGenerationPublicationSetClassV1[];
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface PreparedNamespaceGenerationPublicationSetV1 {
  readonly publicationSet: NamespaceGenerationPublicationSetV1;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

export interface OpenNamespaceGenerationPublicationSetInputV1
  extends Omit<OpenNamespaceGenerationEnvelopeInputV1, "publicationBytes"> {
  readonly publicationSetBytes: Uint8Array;
  readonly keyClass: NamespaceKeyClass;
  readonly expectedPublicationSetDigest?: Uint8Array;
}

export interface OpenNamespaceGenerationPublicationSetExactReplayInputV1
  extends Omit<OpenNamespaceGenerationPublicationSetInputV1, "now" | "expectedPublicationSetDigest"> {
  /** Must come from the exact current durable publication/head lookup. */
  readonly expectedPublicationSetDigest: Uint8Array;
}

export interface OpenedNamespaceGenerationPublicationSetV1
  extends OpenedNamespaceGenerationV1 {
  readonly publicationSetDigest: Uint8Array;
}

export interface VerifiedNamespaceGenerationPublicationSetV1 {
  readonly publicationSet: NamespaceGenerationPublicationSetV1;
  readonly publicationSetDigest: Uint8Array;
}

export interface WithVerifiedNamespaceGenerationPublicationSetInputV1<Value> {
  readonly publicationSetBytes: Uint8Array;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly now: UnixTimestamp;
  readonly expectedPublicationSetDigest?: Uint8Array;
  readonly use: (
    verified: VerifiedNamespaceGenerationPublicationSetV1,
  ) => Promise<Value> | Value;
}

export interface WithVerifiedNamespaceGenerationPublicationSetExactReplayInputV1<Value>
  extends Omit<
    WithVerifiedNamespaceGenerationPublicationSetInputV1<Value>,
    "now" | "expectedPublicationSetDigest"
  > {
  /** Must come from the exact current durable publication/head lookup. */
  readonly expectedPublicationSetDigest: Uint8Array;
}

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
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function boundedBytes(
  label: string,
  value: unknown,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length < minimum
    || value.length > maximum
  ) {
    throw new RangeError(`${label} has an invalid length`);
  }
  return copyOwnedBytesV2(value);
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function keyClass(value: unknown): NamespaceKeyClass {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("Namespace generation key class is unsupported");
  }
  return value;
}

function recipientKind(value: unknown): NamespaceGenerationRecipientKindV1 {
  if (value !== "device" && value !== "recovery") {
    throw new TypeError("Namespace generation recipient kind is unsupported");
  }
  return value;
}

function safeCounter(label: string, value: unknown): number {
  assertU64Counter(label, value);
  return value;
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

const RECIPIENT_FIELDS = Object.freeze([
  "recipientHumanId",
  "recipientKind",
  "recipientKeyId",
  "recipientKeyGeneration",
  "recipientPublicKeyDigest",
] as const);

function normalizeRecipient(
  value: NamespaceGenerationRecipientV1,
): NamespaceGenerationRecipientV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation recipient must be an object");
  }
  exactFields("Namespace generation recipient", value, RECIPIENT_FIELDS);
  return Object.freeze({
    recipientHumanId: humanId(value.recipientHumanId),
    recipientKind: recipientKind(value.recipientKind),
    recipientKeyId: portable(
      "Namespace generation recipient key ID",
      value.recipientKeyId,
    ),
    recipientKeyGeneration: safeCounter(
      "Namespace generation recipient key generation",
      value.recipientKeyGeneration,
    ),
    recipientPublicKeyDigest: exactBytes(
      "Namespace generation recipient public-key digest",
      value.recipientPublicKeyDigest,
      HASH_BYTES,
    ),
  });
}

function recipientBytes(value: NamespaceGenerationRecipientV1): Uint8Array {
  return concatV2(
    frameText(value.recipientHumanId),
    frameText(value.recipientKind),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    frame(value.recipientPublicKeyDigest),
  );
}

function recipientCoordinates(
  value: NamespaceGenerationRecipientV1,
): NamespaceGenerationRecipientV1 {
  return {
    recipientHumanId: value.recipientHumanId,
    recipientKind: value.recipientKind,
    recipientKeyId: value.recipientKeyId,
    recipientKeyGeneration: value.recipientKeyGeneration,
    recipientPublicKeyDigest: value.recipientPublicKeyDigest,
  };
}

function compareRecipients(
  left: NamespaceGenerationRecipientV1,
  right: NamespaceGenerationRecipientV1,
): number {
  for (const [leftValue, rightValue] of [
    [left.recipientHumanId, right.recipientHumanId],
    [left.recipientKind, right.recipientKind],
    [left.recipientKeyId, right.recipientKeyId],
  ] as const) {
    const compared = compareUnsignedUtf8(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  if (left.recipientKeyGeneration !== right.recipientKeyGeneration) {
    return left.recipientKeyGeneration < right.recipientKeyGeneration ? -1 : 1;
  }
  return compareUnsignedUtf8(
    bytesToHex(left.recipientPublicKeyDigest),
    bytesToHex(right.recipientPublicKeyDigest),
  );
}

function normalizeCanonicalRecipients(
  values: readonly NamespaceGenerationRecipientV1[],
): readonly NamespaceGenerationRecipientV1[] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError("Namespace generation recipients must be an array");
  }
  assertV2Range(
    "Namespace generation recipients",
    values.length,
    1,
    NAMESPACE_GENERATION_MAX_RECIPIENTS_V1,
  );
  const recipients = values.map(normalizeRecipient);
  for (let index = 1; index < recipients.length; index += 1) {
    if (compareRecipients(recipients[index - 1]!, recipients[index]!) >= 0) {
      recipients.forEach((recipient) =>
        recipient.recipientPublicKeyDigest.fill(0)
      );
      throw new TypeError(
        "Namespace generation recipients must be canonical and unique",
      );
    }
  }
  return Object.freeze(recipients);
}

function recipientSetBytes(
  recipients: readonly NamespaceGenerationRecipientV1[],
): Uint8Array {
  return concatV2(
    frameText(RECIPIENT_SET_DOMAIN),
    encodeU32(NAMESPACE_GENERATION_FORMAT_VERSION_V1),
    encodeU32(recipients.length),
    ...recipients.map(recipientBytes),
  );
}

export function namespaceGenerationRecipientSetDigestV1(
  recipients: readonly NamespaceGenerationRecipientV1[],
): Uint8Array {
  const normalized = normalizeCanonicalRecipients(recipients);
  let bytes: Uint8Array | undefined;
  try {
    bytes = recipientSetBytes(normalized);
    return sha256(bytes);
  } finally {
    bytes?.fill(0);
    normalized.forEach((recipient) =>
      recipient.recipientPublicKeyDigest.fill(0)
    );
  }
}

const HEAD_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "generationKeyCommitment",
  "audienceFingerprint",
  "previousHeadDigest",
  "issuerHumanId",
  "issuerDeviceId",
  "issuerSigningKeyGeneration",
  "recipientCount",
  "recipientSetDigest",
  "issuedAt",
  "expiresAt",
] as const);

function normalizeHead(value: NamespaceGenerationHeadV1): NamespaceGenerationHeadV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation head must be an object");
  }
  exactFields("Namespace generation head", value, HEAD_FIELDS);
  if (value.formatVersion !== NAMESPACE_GENERATION_FORMAT_VERSION_V1) {
    throw new TypeError("Namespace generation head version is unsupported");
  }
  const generation = namespaceGeneration(value.generation);
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > NAMESPACE_GENERATION_MAX_TTL_MS_V1
  ) {
    throw new RangeError("Namespace generation head validity window is invalid");
  }
  const previousHeadDigest = value.previousHeadDigest === null
    ? null
    : exactBytes(
      "Namespace generation previous-head digest",
      value.previousHeadDigest,
      HASH_BYTES,
    );
  if ((generation === 0) !== (previousHeadDigest === null)) {
    previousHeadDigest?.fill(0);
    throw new TypeError(
      "Namespace generation zero requires no predecessor; later generations require one",
    );
  }
  return Object.freeze({
    formatVersion: NAMESPACE_GENERATION_FORMAT_VERSION_V1,
    operationId: portable("Namespace generation operation ID", value.operationId),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation,
    generationKeyCommitment: exactBytes(
      "Namespace generation key commitment",
      value.generationKeyCommitment,
      HASH_BYTES,
    ),
    audienceFingerprint: exactBytes(
      "Namespace generation audience fingerprint",
      value.audienceFingerprint,
      HASH_BYTES,
    ),
    previousHeadDigest,
    issuerHumanId: humanId(value.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
    issuerSigningKeyGeneration: safeCounter(
      "Namespace generation issuer signing-key generation",
      value.issuerSigningKeyGeneration,
    ),
    recipientCount: assertV2Range(
      "Namespace generation recipient count",
      value.recipientCount,
      1,
      NAMESPACE_GENERATION_MAX_RECIPIENTS_V1,
    ),
    recipientSetDigest: exactBytes(
      "Namespace generation recipient-set digest",
      value.recipientSetDigest,
      HASH_BYTES,
    ),
    issuedAt,
    expiresAt,
  });
}

function destroyHead(value: NamespaceGenerationHeadV1): void {
  value.audienceFingerprint.fill(0);
  value.generationKeyCommitment.fill(0);
  value.previousHeadDigest?.fill(0);
  value.recipientSetDigest.fill(0);
}

function headBytes(value: NamespaceGenerationHeadV1): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_HEAD_DOMAIN_V1),
    frameText(HEAD_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.operationId),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.generationKeyCommitment),
    frame(value.audienceFingerprint),
    frame(value.previousHeadDigest ?? new Uint8Array()),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerSigningKeyGeneration),
    encodeU32(value.recipientCount),
    frame(value.recipientSetDigest),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function encodeNamespaceGenerationHeadV1(
  value: NamespaceGenerationHeadV1,
): Uint8Array {
  const normalized = normalizeHead(value);
  try {
    return headBytes(normalized);
  } finally {
    destroyHead(normalized);
  }
}

export function decodeNamespaceGenerationHeadV1(
  bytes: Uint8Array,
): NamespaceGenerationHeadV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4 * 1024) {
    throw new TypeError("Namespace generation head bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationHeadV1 => {
    readExactText(reader, NAMESPACE_GENERATION_HEAD_DOMAIN_V1, "Head domain");
    readExactText(reader, HEAD_PURPOSE, "Head purpose");
    return {
      formatVersion: reader.readVersion(1) as 1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(5) as NamespaceKeyClass,
      accessRevision: accessRevision(reader.readU64()),
      generation: namespaceGeneration(reader.readU64()),
      generationKeyCommitment: reader.readFrame(HASH_BYTES),
      audienceFingerprint: reader.readFrame(HASH_BYTES),
      previousHeadDigest: nullIfEmpty(reader.readFrame(HASH_BYTES)),
      issuerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      issuerSigningKeyGeneration: reader.readU64(),
      recipientCount: reader.readCount(NAMESPACE_GENERATION_MAX_RECIPIENTS_V1),
      recipientSetDigest: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      expiresAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: NamespaceGenerationHeadV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeHead(raw);
    canonical = headBytes(normalized);
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Namespace generation head is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyHead(raw);
    if (normalized) destroyHead(normalized);
    canonical?.fill(0);
  }
}

export function namespaceGenerationHeadDigestV1(
  value: NamespaceGenerationHeadV1,
): Uint8Array {
  const bytes = encodeNamespaceGenerationHeadV1(value);
  try {
    return sha256(bytes);
  } finally {
    bytes.fill(0);
  }
}

function nullIfEmpty(value: Uint8Array): Uint8Array | null {
  if (value.length !== 0) return value;
  value.fill(0);
  return null;
}

const SECRET_FIELDS = Object.freeze([
  "formatVersion",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "generationKey",
  "audienceFingerprint",
  "headDigest",
  ...RECIPIENT_FIELDS,
] as const);

function normalizeSecret(
  value: NamespaceGenerationSecretV1,
): NamespaceGenerationSecretV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation secret must be an object");
  }
  exactFields("Namespace generation secret", value, SECRET_FIELDS);
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation secret version is unsupported");
  }
  const recipient = normalizeRecipient(recipientCoordinates(value));
  return Object.freeze({
    formatVersion: 1,
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation: namespaceGeneration(value.generation),
    generationKey: exactBytes(
      "Namespace generation key",
      value.generationKey,
      KEY_BYTES,
    ),
    audienceFingerprint: exactBytes(
      "Namespace generation secret audience fingerprint",
      value.audienceFingerprint,
      HASH_BYTES,
    ),
    headDigest: exactBytes(
      "Namespace generation secret head digest",
      value.headDigest,
      HASH_BYTES,
    ),
    ...recipient,
  });
}

function destroySecret(value: NamespaceGenerationSecretV1): void {
  value.generationKey.fill(0);
  value.audienceFingerprint.fill(0);
  value.headDigest.fill(0);
  value.recipientPublicKeyDigest.fill(0);
}

function secretBytes(value: NamespaceGenerationSecretV1): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_SECRET_DOMAIN_V1),
    frameText(SECRET_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.generationKey),
    frame(value.audienceFingerprint),
    frame(value.headDigest),
    recipientBytes(value),
  );
}

export function encodeNamespaceGenerationSecretV1(
  value: NamespaceGenerationSecretV1,
): Uint8Array {
  const normalized = normalizeSecret(value);
  try {
    const bytes = secretBytes(normalized);
    if (bytes.length > MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Namespace generation secret exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroySecret(normalized);
  }
}

export function decodeNamespaceGenerationSecretV1(
  bytes: Uint8Array,
): NamespaceGenerationSecretV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1
  ) {
    throw new TypeError("Namespace generation secret bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationSecretV1 => {
    readExactText(reader, NAMESPACE_GENERATION_SECRET_DOMAIN_V1, "Secret domain");
    readExactText(reader, SECRET_PURPOSE, "Secret purpose");
    return {
      formatVersion: reader.readVersion(1) as 1,
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(5) as NamespaceKeyClass,
      accessRevision: accessRevision(reader.readU64()),
      generation: namespaceGeneration(reader.readU64()),
      generationKey: reader.readFrame(KEY_BYTES),
      audienceFingerprint: reader.readFrame(HASH_BYTES),
      headDigest: reader.readFrame(HASH_BYTES),
      ...readRecipient(reader),
    };
  });
  let normalized: NamespaceGenerationSecretV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeSecret(raw);
    canonical = secretBytes(normalized);
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Namespace generation secret is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroySecret(raw);
    if (normalized) destroySecret(normalized);
    canonical?.fill(0);
  }
}

function readRecipient(reader: StrictDecoder): NamespaceGenerationRecipientV1 {
  return {
    recipientHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
    recipientKind: reader.readText(8) as NamespaceGenerationRecipientKindV1,
    recipientKeyId: reader.readText(V2_LIMITS.idBytes),
    recipientKeyGeneration: reader.readU64(),
    recipientPublicKeyDigest: reader.readFrame(HASH_BYTES),
  };
}

const ENVELOPE_FIELDS = Object.freeze([
  "formatVersion",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "audienceFingerprint",
  "headDigest",
  ...RECIPIENT_FIELDS,
  "ciphertext",
] as const);

function normalizeEnvelope(
  value: NamespaceGenerationRecipientEnvelopeV1,
): NamespaceGenerationRecipientEnvelopeV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation envelope must be an object");
  }
  exactFields("Namespace generation envelope", value, ENVELOPE_FIELDS);
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation envelope version is unsupported");
  }
  const recipient = normalizeRecipient(recipientCoordinates(value));
  return Object.freeze({
    formatVersion: 1,
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation: namespaceGeneration(value.generation),
    audienceFingerprint: exactBytes(
      "Namespace generation envelope audience fingerprint",
      value.audienceFingerprint,
      HASH_BYTES,
    ),
    headDigest: exactBytes(
      "Namespace generation envelope head digest",
      value.headDigest,
      HASH_BYTES,
    ),
    ...recipient,
    ciphertext: boundedBytes(
      "Namespace generation envelope ciphertext",
      value.ciphertext,
      1,
      MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1 + 512,
    ),
  });
}

function destroyEnvelope(value: NamespaceGenerationRecipientEnvelopeV1): void {
  value.audienceFingerprint.fill(0);
  value.headDigest.fill(0);
  value.recipientPublicKeyDigest.fill(0);
  value.ciphertext.fill(0);
}

function envelopeBytes(
  value: NamespaceGenerationRecipientEnvelopeV1,
): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_ENVELOPE_DOMAIN_V1),
    frameText(ENVELOPE_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.audienceFingerprint),
    frame(value.headDigest),
    recipientBytes(value),
    frame(value.ciphertext),
  );
}

export function encodeNamespaceGenerationRecipientEnvelopeV1(
  value: NamespaceGenerationRecipientEnvelopeV1,
): Uint8Array {
  const normalized = normalizeEnvelope(value);
  try {
    const bytes = envelopeBytes(normalized);
    if (bytes.length > MAX_NAMESPACE_GENERATION_ENVELOPE_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Namespace generation envelope exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyEnvelope(normalized);
  }
}

export function decodeNamespaceGenerationRecipientEnvelopeV1(
  bytes: Uint8Array,
): NamespaceGenerationRecipientEnvelopeV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_NAMESPACE_GENERATION_ENVELOPE_WIRE_BYTES_V1
  ) {
    throw new TypeError("Namespace generation envelope bytes are invalid");
  }
  const raw = decodeExact(
    bytes,
    (reader): NamespaceGenerationRecipientEnvelopeV1 => {
      readExactText(
        reader,
        NAMESPACE_GENERATION_ENVELOPE_DOMAIN_V1,
        "Envelope domain",
      );
      readExactText(reader, ENVELOPE_PURPOSE, "Envelope purpose");
      return {
        formatVersion: reader.readVersion(1) as 1,
        namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
        keyClass: reader.readText(5) as NamespaceKeyClass,
        accessRevision: accessRevision(reader.readU64()),
        generation: namespaceGeneration(reader.readU64()),
        audienceFingerprint: reader.readFrame(HASH_BYTES),
        headDigest: reader.readFrame(HASH_BYTES),
        ...readRecipient(reader),
        ciphertext: reader.readFrame(
          MAX_NAMESPACE_GENERATION_SECRET_WIRE_BYTES_V1 + 512,
        ),
      };
    },
  );
  let normalized: NamespaceGenerationRecipientEnvelopeV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeEnvelope(raw);
    canonical = envelopeBytes(normalized);
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Namespace generation envelope is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyEnvelope(raw);
    if (normalized) destroyEnvelope(normalized);
    canonical?.fill(0);
  }
}

function envelopeRecipient(
  value: NamespaceGenerationRecipientEnvelopeV1,
): NamespaceGenerationRecipientV1 {
  return {
    recipientHumanId: value.recipientHumanId,
    recipientKind: value.recipientKind,
    recipientKeyId: value.recipientKeyId,
    recipientKeyGeneration: value.recipientKeyGeneration,
    recipientPublicKeyDigest: value.recipientPublicKeyDigest,
  };
}

const PUBLICATION_FIELDS = Object.freeze([
  "formatVersion",
  "head",
  "envelopes",
  "signature",
] as const);

function normalizePublication(
  value: NamespaceGenerationPublicationV1,
): NamespaceGenerationPublicationV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation publication must be an object");
  }
  exactFields("Namespace generation publication", value, PUBLICATION_FIELDS);
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation publication version is unsupported");
  }
  const head = normalizeHead(value.head);
  let envelopes: readonly NamespaceGenerationRecipientEnvelopeV1[] = [];
  try {
    if (!Array.isArray(value.envelopes as unknown)) {
      throw new TypeError("Namespace generation envelopes must be an array");
    }
    assertV2Range(
      "Namespace generation publication envelopes",
      value.envelopes.length,
      1,
      NAMESPACE_GENERATION_MAX_RECIPIENTS_V1,
    );
    envelopes = Object.freeze(value.envelopes.map(normalizeEnvelope));
    if (envelopes.length !== head.recipientCount) {
      throw new TypeError("Namespace generation publication recipient count disagrees");
    }
    const headDigest = namespaceGenerationHeadDigestV1(head);
    try {
      for (let index = 0; index < envelopes.length; index += 1) {
        const envelope = envelopes[index]!;
        if (
          envelope.namespaceId !== head.namespaceId
          || envelope.keyClass !== head.keyClass
          || envelope.accessRevision !== head.accessRevision
          || envelope.generation !== head.generation
          || !sameBytes(envelope.audienceFingerprint, head.audienceFingerprint)
          || !sameBytes(envelope.headDigest, headDigest)
        ) {
          throw new TypeError(
            "Namespace generation envelope coordinates disagree with the head",
          );
        }
        if (
          index > 0
          && compareRecipients(envelopes[index - 1]!, envelope) >= 0
        ) {
          throw new TypeError(
            "Namespace generation envelopes must be canonical and unique",
          );
        }
      }
      const recipients = envelopes.map(envelopeRecipient);
      const expectedSetDigest = namespaceGenerationRecipientSetDigestV1(recipients);
      try {
        if (!sameBytes(expectedSetDigest, head.recipientSetDigest)) {
          throw new TypeError(
            "Namespace generation publication recipient set is incomplete",
          );
        }
      } finally {
        expectedSetDigest.fill(0);
      }
    } finally {
      headDigest.fill(0);
    }
    return Object.freeze({
      formatVersion: 1,
      head,
      envelopes,
      signature: exactBytes(
        "Namespace generation publication signature",
        value.signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyHead(head);
    envelopes.forEach(destroyEnvelope);
    throw error;
  }
}

function destroyPublication(value: NamespaceGenerationPublicationV1): void {
  destroyHead(value.head);
  value.envelopes.forEach(destroyEnvelope);
  value.signature.fill(0);
}

function publicationSigningBytesFromNormalized(
  value: Omit<NamespaceGenerationPublicationV1, "signature">,
): Uint8Array {
  const encodedHead = headBytes(value.head);
  const encodedEnvelopes = value.envelopes.map(envelopeBytes);
  try {
    return concatV2(
      frameText(NAMESPACE_GENERATION_PUBLICATION_DOMAIN_V1),
      frameText(PUBLICATION_PURPOSE),
      encodeU32(value.formatVersion),
      frame(encodedHead),
      encodeU32(encodedEnvelopes.length),
      ...encodedEnvelopes.map(frame),
    );
  } finally {
    encodedHead.fill(0);
    encodedEnvelopes.forEach((bytes) => bytes.fill(0));
  }
}

export function namespaceGenerationPublicationSigningBytesV1(
  value: NamespaceGenerationPublicationV1,
): Uint8Array {
  const normalized = normalizePublication(value);
  try {
    return publicationSigningBytesFromNormalized(normalized);
  } finally {
    destroyPublication(normalized);
  }
}

export function encodeNamespaceGenerationPublicationV1(
  value: NamespaceGenerationPublicationV1,
): Uint8Array {
  const normalized = normalizePublication(value);
  try {
    const bytes = concatV2(
      publicationSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Namespace generation publication exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyPublication(normalized);
  }
}

export function decodeNamespaceGenerationPublicationV1(
  bytes: Uint8Array,
): NamespaceGenerationPublicationV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1
  ) {
    throw new TypeError("Namespace generation publication bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationPublicationV1 => {
    readExactText(
      reader,
      NAMESPACE_GENERATION_PUBLICATION_DOMAIN_V1,
      "Publication domain",
    );
    readExactText(reader, PUBLICATION_PURPOSE, "Publication purpose");
    const formatVersion = reader.readVersion(1) as 1;
    const head = decodeNamespaceGenerationHeadV1(reader.readFrame(4 * 1024));
    const count = reader.readCount(NAMESPACE_GENERATION_MAX_RECIPIENTS_V1);
    const envelopes = Array.from({ length: count }, () =>
      decodeNamespaceGenerationRecipientEnvelopeV1(
        reader.readFrame(MAX_NAMESPACE_GENERATION_ENVELOPE_WIRE_BYTES_V1),
      )
    );
    return {
      formatVersion,
      head,
      envelopes,
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: NamespaceGenerationPublicationV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePublication(raw);
    canonical = concatV2(
      publicationSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Namespace generation publication is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyPublication(raw);
    if (normalized) destroyPublication(normalized);
    canonical?.fill(0);
  }
}

export function namespaceGenerationPublicationDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const publication = decodeNamespaceGenerationPublicationV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyPublication(publication);
  }
}

export async function prepareNamespaceGenerationPublicationV1(
  crypto: LatticeCrypto,
  input: PrepareNamespaceGenerationPublicationInputV1,
): Promise<PreparedNamespaceGenerationPublicationV1> {
  const generationKey = exactBytes(
    "Namespace generation key",
    input.generationKey,
    KEY_BYTES,
  );
  const publicSigningKey = exactBytes(
    "Namespace generation issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateSigningKey = exactBytes(
    "Namespace generation issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  let recipients: readonly NamespaceGenerationRecipientInputV1[] = [];
  let head: NamespaceGenerationHeadV1 | undefined;
  let headDigest: Uint8Array | undefined;
  const envelopes: NamespaceGenerationRecipientEnvelopeV1[] = [];
  try {
    if (!Array.isArray(input.recipients as unknown)) {
      throw new TypeError("Namespace generation recipients must be an array");
    }
    const normalizedRecipients = normalizeCanonicalRecipients(
      input.recipients.map(recipientCoordinates),
    );
    try {
      recipients = Object.freeze(input.recipients.map((value, index) => {
        const recipient = normalizedRecipients[index]!;
        const recipientPublicKey = boundedBytes(
          "Namespace generation recipient public key",
          value.recipientPublicKey,
          1,
          512,
        );
        const digest = sha256(recipientPublicKey);
        if (!sameBytes(digest, recipient.recipientPublicKeyDigest)) {
          recipientPublicKey.fill(0);
          digest.fill(0);
          throw new TypeError(
            "Namespace generation recipient public key digest disagrees",
          );
        }
        digest.fill(0);
        return Object.freeze({ ...recipient, recipientPublicKey });
      }));
      const recipientSetDigest = namespaceGenerationRecipientSetDigestV1(
        normalizedRecipients,
      );
      const generationKeyCommitment = namespaceGenerationKeyCommitmentV1({
        namespaceId: input.namespaceId,
        keyClass: input.keyClass,
        generation: input.generation,
        generationKey,
      });
      head = normalizeHead({
        formatVersion: 1,
        operationId: input.operationId,
        namespaceId: input.namespaceId,
        keyClass: input.keyClass,
        accessRevision: input.accessRevision,
        generation: input.generation,
        generationKeyCommitment,
        audienceFingerprint: input.audienceFingerprint,
        previousHeadDigest: input.previousHeadDigest,
        issuerHumanId: input.issuerHumanId,
        issuerDeviceId: input.issuerDeviceId,
        issuerSigningKeyGeneration: input.issuerSigningKeyGeneration,
        recipientCount: normalizedRecipients.length,
        recipientSetDigest,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      });
      recipientSetDigest.fill(0);
      generationKeyCommitment.fill(0);
      headDigest = namespaceGenerationHeadDigestV1(head);
      for (const recipient of recipients) {
        const secret = normalizeSecret({
          formatVersion: 1,
          namespaceId: head.namespaceId,
          keyClass: head.keyClass,
          accessRevision: head.accessRevision,
          generation: head.generation,
          generationKey,
          audienceFingerprint: head.audienceFingerprint,
          headDigest,
          ...recipientCoordinates(recipient),
        });
        let plaintext: Uint8Array | undefined;
        try {
          plaintext = secretBytes(secret);
          const ciphertext = await crypto.sealTo(
            recipient.recipientPublicKey,
            plaintext,
          );
          envelopes.push(normalizeEnvelope({
            formatVersion: 1,
            namespaceId: head.namespaceId,
            keyClass: head.keyClass,
            accessRevision: head.accessRevision,
            generation: head.generation,
            audienceFingerprint: head.audienceFingerprint,
            headDigest,
            ...recipientCoordinates(recipient),
            ciphertext,
          }));
          ciphertext.fill(0);
        } finally {
          plaintext?.fill(0);
          destroySecret(secret);
        }
      }
      const unsigned = {
        formatVersion: 1 as const,
        head,
        envelopes: Object.freeze(envelopes),
      };
      const signingBytes = publicationSigningBytesFromNormalized(unsigned);
      const signature = crypto.sign(privateSigningKey, signingBytes);
      try {
        if (!crypto.verify(publicSigningKey, signingBytes, signature)) {
          throw new TypeError("Namespace generation signing keys do not match");
        }
        const bytes = encodeNamespaceGenerationPublicationV1({
          ...unsigned,
          signature,
        });
        return Object.freeze({
          publication: decodeNamespaceGenerationPublicationV1(bytes),
          bytes,
          headDigest: headDigest.slice(),
          publicationDigest: sha256(bytes),
        });
      } finally {
        signingBytes.fill(0);
        signature.fill(0);
      }
    } finally {
      normalizedRecipients.forEach((recipient) =>
        recipient.recipientPublicKeyDigest.fill(0)
      );
    }
  } finally {
    generationKey.fill(0);
    publicSigningKey.fill(0);
    privateSigningKey.fill(0);
    recipients.forEach((recipient) => {
      recipient.recipientPublicKey.fill(0);
      recipient.recipientPublicKeyDigest.fill(0);
    });
    if (head) destroyHead(head);
    headDigest?.fill(0);
    envelopes.forEach(destroyEnvelope);
  }
}

async function openNamespaceGenerationEnvelope(
  crypto: LatticeCrypto,
  input: Omit<OpenNamespaceGenerationEnvelopeInputV1, "now"> & Readonly<{
    now?: UnixTimestamp;
  }>,
  enforceFreshness: boolean,
): Promise<OpenedNamespaceGenerationV1 | null> {
  const publication = decodeNamespaceGenerationPublicationV1(
    input.publicationBytes,
  );
  const issuerKey = exactBytes(
    "Namespace generation issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const recipientPrivateKey = boundedBytes(
    "Namespace generation recipient private key",
    input.recipientPrivateKey,
    1,
    512,
  );
  let signingBytes: Uint8Array | undefined;
  let publicationDigest: Uint8Array | undefined;
  let plaintext: Uint8Array | null = null;
  let secret: NamespaceGenerationSecretV1 | undefined;
  try {
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (now < publication.head.issuedAt || now >= publication.head.expiresAt) {
        return null;
      }
    }
    signingBytes = namespaceGenerationPublicationSigningBytesV1(publication);
    if (!crypto.verify(issuerKey, signingBytes, publication.signature)) {
      return null;
    }
    publicationDigest = sha256(input.publicationBytes);
    if (
      input.expectedPublicationDigest !== undefined
      && !sameBytes(
        publicationDigest,
        exactBytes(
          "Expected Namespace generation publication digest",
          input.expectedPublicationDigest,
          HASH_BYTES,
        ),
      )
    ) return null;
    const target = publication.envelopes.find((envelope) =>
      envelope.recipientHumanId === input.recipientHumanId
      && envelope.recipientKind === input.recipientKind
      && envelope.recipientKeyId === input.recipientKeyId
      && envelope.recipientKeyGeneration === input.recipientKeyGeneration
    );
    if (target === undefined) return null;
    plaintext = await crypto.openSealed(recipientPrivateKey, target.ciphertext);
    if (plaintext === null) return null;
    secret = decodeNamespaceGenerationSecretV1(plaintext);
    const headDigest = namespaceGenerationHeadDigestV1(publication.head);
    try {
      if (
        secret.namespaceId !== target.namespaceId
        || secret.keyClass !== target.keyClass
        || secret.accessRevision !== target.accessRevision
        || secret.generation !== target.generation
        || secret.recipientHumanId !== target.recipientHumanId
        || secret.recipientKind !== target.recipientKind
        || secret.recipientKeyId !== target.recipientKeyId
        || secret.recipientKeyGeneration !== target.recipientKeyGeneration
        || !sameBytes(secret.audienceFingerprint, target.audienceFingerprint)
        || !sameBytes(secret.recipientPublicKeyDigest, target.recipientPublicKeyDigest)
        || !sameBytes(secret.headDigest, headDigest)
      ) return null;
      const keyCommitment = namespaceGenerationKeyCommitmentV1({
        namespaceId: secret.namespaceId,
        keyClass: secret.keyClass,
        generation: secret.generation,
        generationKey: secret.generationKey,
      });
      try {
        if (!sameBytes(keyCommitment, publication.head.generationKeyCommitment)) {
          return null;
        }
      } finally {
        keyCommitment.fill(0);
      }
      const envelopeWire = encodeNamespaceGenerationRecipientEnvelopeV1(target);
      try {
        return Object.freeze({
          head: decodeNamespaceGenerationHeadV1(
            encodeNamespaceGenerationHeadV1(publication.head),
          ),
          generationKey: secret.generationKey.slice(),
          envelopeDigest: sha256(envelopeWire),
          publicationDigest: publicationDigest.slice(),
        });
      } finally {
        envelopeWire.fill(0);
      }
    } finally {
      headDigest.fill(0);
    }
  } catch {
    return null;
  } finally {
    destroyPublication(publication);
    issuerKey.fill(0);
    recipientPrivateKey.fill(0);
    signingBytes?.fill(0);
    publicationDigest?.fill(0);
    plaintext?.fill(0);
    if (secret) destroySecret(secret);
  }
}

export async function openNamespaceGenerationEnvelopeV1(
  crypto: LatticeCrypto,
  input: OpenNamespaceGenerationEnvelopeInputV1,
): Promise<OpenedNamespaceGenerationV1 | null> {
  return openNamespaceGenerationEnvelope(crypto, input, true);
}

const RECEIPT_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "namespaceId",
  "keyClass",
  "accessRevision",
  "generation",
  "headDigest",
  "publicationDigest",
  "committedAt",
] as const);

function normalizeReceipt(
  value: NamespaceGenerationReceiptV1,
): NamespaceGenerationReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation receipt must be an object");
  }
  exactFields("Namespace generation receipt", value, RECEIPT_FIELDS);
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation receipt version is unsupported");
  }
  return Object.freeze({
    formatVersion: 1,
    operationId: portable("Namespace generation receipt operation ID", value.operationId),
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    accessRevision: accessRevision(value.accessRevision),
    generation: namespaceGeneration(value.generation),
    headDigest: exactBytes("Namespace generation receipt head digest", value.headDigest, HASH_BYTES),
    publicationDigest: exactBytes(
      "Namespace generation receipt publication digest",
      value.publicationDigest,
      HASH_BYTES,
    ),
    committedAt: unixTimestamp(value.committedAt),
  });
}

function destroyReceipt(value: NamespaceGenerationReceiptV1): void {
  value.headDigest.fill(0);
  value.publicationDigest.fill(0);
}

function receiptBytes(value: NamespaceGenerationReceiptV1): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_GENERATION_RECEIPT_DOMAIN_V1),
    frameText(RECEIPT_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.operationId),
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.accessRevision),
    encodeU64(value.generation),
    frame(value.headDigest),
    frame(value.publicationDigest),
    encodeU64(value.committedAt),
  );
}

export function encodeNamespaceGenerationReceiptV1(
  value: NamespaceGenerationReceiptV1,
): Uint8Array {
  const normalized = normalizeReceipt(value);
  try {
    return receiptBytes(normalized);
  } finally {
    destroyReceipt(normalized);
  }
}

export function decodeNamespaceGenerationReceiptV1(
  bytes: Uint8Array,
): NamespaceGenerationReceiptV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4 * 1024) {
    throw new TypeError("Namespace generation receipt bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationReceiptV1 => {
    readExactText(reader, NAMESPACE_GENERATION_RECEIPT_DOMAIN_V1, "Receipt domain");
    readExactText(reader, RECEIPT_PURPOSE, "Receipt purpose");
    return {
      formatVersion: reader.readVersion(1) as 1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      keyClass: reader.readText(5) as NamespaceKeyClass,
      accessRevision: accessRevision(reader.readU64()),
      generation: namespaceGeneration(reader.readU64()),
      headDigest: reader.readFrame(HASH_BYTES),
      publicationDigest: reader.readFrame(HASH_BYTES),
      committedAt: unixTimestamp(reader.readU64()),
    };
  });
  let normalized: NamespaceGenerationReceiptV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeReceipt(raw);
    canonical = receiptBytes(normalized);
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Namespace generation receipt is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyReceipt(raw);
    if (normalized) destroyReceipt(normalized);
    canonical?.fill(0);
  }
}

const PUBLICATION_SET_ENTRY_FIELDS = Object.freeze([
  "keyClass",
  "publicationBytes",
  "publicationDigest",
] as const);
const PUBLICATION_SET_FIELDS = Object.freeze([
  "formatVersion",
  "operationId",
  "namespaceId",
  "accessRevision",
  "audienceFingerprint",
  "issuerHumanId",
  "issuerDeviceId",
  "issuerSigningKeyGeneration",
  "totalEnvelopeCount",
  "entrySetDigest",
  "issuedAt",
  "expiresAt",
  "entries",
  "signature",
] as const);

function normalizePublicationSetEntry(
  value: NamespaceGenerationPublicationSetEntryV1,
): NamespaceGenerationPublicationSetEntryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation publication-set entry must be an object");
  }
  exactFields(
    "Namespace generation publication-set entry",
    value,
    PUBLICATION_SET_ENTRY_FIELDS,
  );
  return Object.freeze({
    keyClass: keyClass(value.keyClass),
    publicationBytes: boundedBytes(
      "Namespace generation publication-set inner publication",
      value.publicationBytes,
      1,
      MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1,
    ),
    publicationDigest: exactBytes(
      "Namespace generation publication-set inner digest",
      value.publicationDigest,
      HASH_BYTES,
    ),
  });
}

function destroyPublicationSetEntry(
  value: NamespaceGenerationPublicationSetEntryV1,
): void {
  value.publicationBytes.fill(0);
  value.publicationDigest.fill(0);
}

function publicationSetEntryBytes(
  value: NamespaceGenerationPublicationSetEntryV1,
): Uint8Array {
  return concatV2(
    frameText(value.keyClass),
    frame(value.publicationBytes),
    frame(value.publicationDigest),
  );
}

function publicationSetDigestInput(
  entries: readonly NamespaceGenerationPublicationSetEntryV1[],
): Uint8Array {
  return concatV2(
    frameText(`${NAMESPACE_GENERATION_PUBLICATION_SET_DOMAIN_V1}/entries`),
    encodeU32(NAMESPACE_GENERATION_FORMAT_VERSION_V1),
    encodeU32(entries.length),
    ...entries.flatMap((entry) => [
      frameText(entry.keyClass),
      frame(entry.publicationDigest),
    ]),
  );
}

function normalizePublicationSet(
  value: NamespaceGenerationPublicationSetV1,
): NamespaceGenerationPublicationSetV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Namespace generation publication set must be an object");
  }
  exactFields(
    "Namespace generation publication set",
    value,
    PUBLICATION_SET_FIELDS,
  );
  if (value.formatVersion !== 1) {
    throw new TypeError("Namespace generation publication-set version is unsupported");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > NAMESPACE_GENERATION_MAX_TTL_MS_V1
  ) {
    throw new RangeError(
      "Namespace generation publication-set validity window is invalid",
    );
  }
  const audienceFingerprint = exactBytes(
    "Namespace generation publication-set audience fingerprint",
    value.audienceFingerprint,
    HASH_BYTES,
  );
  const entrySetDigest = exactBytes(
    "Namespace generation publication-set entry digest",
    value.entrySetDigest,
    HASH_BYTES,
  );
  let entries: readonly NamespaceGenerationPublicationSetEntryV1[] = [];
  try {
    if (!Array.isArray(value.entries as unknown) || value.entries.length !== 2) {
      throw new TypeError(
        "Namespace generation publication set requires exactly AI and Human entries",
      );
    }
    entries = Object.freeze(value.entries.map(normalizePublicationSetEntry));
    if (entries[0]!.keyClass !== "ai" || entries[1]!.keyClass !== "human") {
      throw new TypeError(
        "Namespace generation publication-set entries must be canonical AI then Human",
      );
    }
    let totalEnvelopeCount = 0;
    for (const entry of entries) {
      const digest = sha256(entry.publicationBytes);
      let publication: NamespaceGenerationPublicationV1 | undefined;
      try {
        if (!sameBytes(digest, entry.publicationDigest)) {
          throw new TypeError(
            "Namespace generation publication-set inner digest disagrees",
          );
        }
        publication = decodeNamespaceGenerationPublicationV1(
          entry.publicationBytes,
        );
        const head = publication.head;
        if (
          head.keyClass !== entry.keyClass
          || head.operationId !== value.operationId
          || head.namespaceId !== value.namespaceId
          || head.accessRevision !== value.accessRevision
          || !sameBytes(head.audienceFingerprint, audienceFingerprint)
          || head.issuerHumanId !== value.issuerHumanId
          || head.issuerDeviceId !== value.issuerDeviceId
          || head.issuerSigningKeyGeneration !== value.issuerSigningKeyGeneration
          || head.issuedAt !== issuedAt
          || head.expiresAt !== expiresAt
        ) {
          throw new TypeError(
            "Namespace generation publication-set inner coordinates disagree",
          );
        }
        totalEnvelopeCount += publication.envelopes.length;
      } finally {
        digest.fill(0);
        if (publication) destroyPublication(publication);
      }
    }
    if (totalEnvelopeCount !== value.totalEnvelopeCount) {
      throw new TypeError(
        "Namespace generation publication-set envelope count disagrees",
      );
    }
    const digestInput = publicationSetDigestInput(entries);
    try {
      if (!sameBytes(sha256(digestInput), entrySetDigest)) {
        throw new TypeError(
          "Namespace generation publication-set entry closure disagrees",
        );
      }
    } finally {
      digestInput.fill(0);
    }
    return Object.freeze({
      formatVersion: 1,
      operationId: portable(
        "Namespace generation publication-set operation ID",
        value.operationId,
      ),
      namespaceId: namespaceId(value.namespaceId),
      accessRevision: accessRevision(value.accessRevision),
      audienceFingerprint,
      issuerHumanId: humanId(value.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
      issuerSigningKeyGeneration: safeCounter(
        "Namespace generation publication-set issuer signing-key generation",
        value.issuerSigningKeyGeneration,
      ),
      totalEnvelopeCount: assertV2Range(
        "Namespace generation publication-set envelope count",
        value.totalEnvelopeCount,
        2,
        NAMESPACE_GENERATION_MAX_RECIPIENTS_V1 * 2,
      ),
      entrySetDigest,
      issuedAt,
      expiresAt,
      entries,
      signature: exactBytes(
        "Namespace generation publication-set signature",
        value.signature,
        V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    audienceFingerprint.fill(0);
    entrySetDigest.fill(0);
    entries.forEach(destroyPublicationSetEntry);
    throw error;
  }
}

function destroyPublicationSet(value: NamespaceGenerationPublicationSetV1): void {
  value.audienceFingerprint.fill(0);
  value.entrySetDigest.fill(0);
  value.entries.forEach(destroyPublicationSetEntry);
  value.signature.fill(0);
}

function publicationSetSigningBytesFromNormalized(
  value: Omit<NamespaceGenerationPublicationSetV1, "signature">,
): Uint8Array {
  const encodedEntries = value.entries.map(publicationSetEntryBytes);
  try {
    return concatV2(
      frameText(NAMESPACE_GENERATION_PUBLICATION_SET_DOMAIN_V1),
      frameText(PUBLICATION_SET_PURPOSE),
      encodeU32(value.formatVersion),
      frameText(value.operationId),
      frameText(value.namespaceId),
      encodeU64(value.accessRevision),
      frame(value.audienceFingerprint),
      frameText(value.issuerHumanId),
      frameText(value.issuerDeviceId),
      encodeU64(value.issuerSigningKeyGeneration),
      encodeU32(value.totalEnvelopeCount),
      frame(value.entrySetDigest),
      encodeU64(value.issuedAt),
      encodeU64(value.expiresAt),
      encodeU32(encodedEntries.length),
      ...encodedEntries.map(frame),
    );
  } finally {
    encodedEntries.forEach((bytes) => bytes.fill(0));
  }
}

export function namespaceGenerationPublicationSetSigningBytesV1(
  value: NamespaceGenerationPublicationSetV1,
): Uint8Array {
  const normalized = normalizePublicationSet(value);
  try {
    return publicationSetSigningBytesFromNormalized(normalized);
  } finally {
    destroyPublicationSet(normalized);
  }
}

export function encodeNamespaceGenerationPublicationSetV1(
  value: NamespaceGenerationPublicationSetV1,
): Uint8Array {
  const normalized = normalizePublicationSet(value);
  try {
    const bytes = concatV2(
      publicationSetSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (bytes.length > MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1 * 2) {
      bytes.fill(0);
      throw new RangeError(
        "Namespace generation publication set exceeds its wire limit",
      );
    }
    return bytes;
  } finally {
    destroyPublicationSet(normalized);
  }
}

export function decodeNamespaceGenerationPublicationSetV1(
  bytes: Uint8Array,
): NamespaceGenerationPublicationSetV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1 * 2
  ) {
    throw new TypeError("Namespace generation publication-set bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): NamespaceGenerationPublicationSetV1 => {
    readExactText(
      reader,
      NAMESPACE_GENERATION_PUBLICATION_SET_DOMAIN_V1,
      "Publication-set domain",
    );
    readExactText(reader, PUBLICATION_SET_PURPOSE, "Publication-set purpose");
    const formatVersion = reader.readVersion(1) as 1;
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const decodedNamespaceId = namespaceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const decodedAccessRevision = accessRevision(reader.readU64());
    const audienceFingerprint = reader.readFrame(HASH_BYTES);
    const issuerHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const issuerDeviceId = cryptoDeviceId(
      reader.readText(V2_LIMITS.idBytes),
    );
    const issuerSigningKeyGeneration = reader.readU64();
    const totalEnvelopeCount = reader.readCount(
      NAMESPACE_GENERATION_MAX_RECIPIENTS_V1 * 2,
    );
    const entrySetDigest = reader.readFrame(HASH_BYTES);
    const issuedAt = unixTimestamp(reader.readU64());
    const expiresAt = unixTimestamp(reader.readU64());
    const count = reader.readCount(2);
    const entries = Array.from({ length: count }, () => {
      const entryBytes = reader.readFrame(
        MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1 + 256,
      );
      return decodeExact(
        entryBytes,
        (entryReader): NamespaceGenerationPublicationSetEntryV1 => ({
          keyClass: entryReader.readText(5) as NamespaceKeyClass,
          publicationBytes: entryReader.readFrame(
            MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1,
          ),
          publicationDigest: entryReader.readFrame(HASH_BYTES),
        }),
      );
    });
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    return {
      formatVersion,
      operationId,
      namespaceId: decodedNamespaceId,
      accessRevision: decodedAccessRevision,
      audienceFingerprint,
      issuerHumanId,
      issuerDeviceId,
      issuerSigningKeyGeneration,
      totalEnvelopeCount,
      entrySetDigest,
      issuedAt,
      expiresAt,
      entries,
      signature,
    };
  });
  let normalized: NamespaceGenerationPublicationSetV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizePublicationSet(raw);
    canonical = concatV2(
      publicationSetSigningBytesFromNormalized(normalized),
      frame(normalized.signature),
    );
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Namespace generation publication set is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyPublicationSet(raw);
    if (normalized) destroyPublicationSet(normalized);
    canonical?.fill(0);
  }
}

export function namespaceGenerationPublicationSetDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const value = decodeNamespaceGenerationPublicationSetV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyPublicationSet(value);
  }
}

export async function prepareNamespaceGenerationPublicationSetV1(
  crypto: LatticeCrypto,
  input: PrepareNamespaceGenerationPublicationSetInputV1,
): Promise<PreparedNamespaceGenerationPublicationSetV1> {
  if (!Array.isArray(input.classes as unknown) || input.classes.length !== 2) {
    throw new TypeError(
      "Namespace generation publication set requires exactly AI and Human classes",
    );
  }
  if (input.classes[0]?.keyClass !== "ai" || input.classes[1]?.keyClass !== "human") {
    throw new TypeError(
      "Namespace generation publication-set classes must be canonical AI then Human",
    );
  }
  const prepared: PreparedNamespaceGenerationPublicationV1[] = [];
  const signingPublicKey = exactBytes(
    "Namespace generation publication-set signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const signingPrivateKey = exactBytes(
    "Namespace generation set signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  let entries: NamespaceGenerationPublicationSetEntryV1[] = [];
  let entrySetDigest: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    for (const selected of input.classes) {
      prepared.push(await prepareNamespaceGenerationPublicationV1(crypto, {
        operationId: input.operationId,
        namespaceId: input.namespaceId,
        keyClass: selected.keyClass,
        accessRevision: input.accessRevision,
        generation: selected.generation,
        generationKey: selected.generationKey,
        audienceFingerprint: input.audienceFingerprint,
        previousHeadDigest: selected.previousHeadDigest,
        issuerHumanId: input.issuerHumanId,
        issuerDeviceId: input.issuerDeviceId,
        issuerSigningKeyGeneration: input.issuerSigningKeyGeneration,
        issuerSigningPublicKey: signingPublicKey,
        issuerSigningPrivateKey: signingPrivateKey,
        recipients: input.recipients,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
      }));
    }
    entries = prepared.map((value, index) => ({
      keyClass: input.classes[index]!.keyClass,
      publicationBytes: value.bytes,
      publicationDigest: value.publicationDigest,
    }));
    const digestInput = publicationSetDigestInput(entries);
    try {
      entrySetDigest = sha256(digestInput);
    } finally {
      digestInput.fill(0);
    }
    const unsigned = {
      formatVersion: 1 as const,
      operationId: input.operationId,
      namespaceId: input.namespaceId,
      accessRevision: input.accessRevision,
      audienceFingerprint: input.audienceFingerprint,
      issuerHumanId: input.issuerHumanId,
      issuerDeviceId: input.issuerDeviceId,
      issuerSigningKeyGeneration: input.issuerSigningKeyGeneration,
      totalEnvelopeCount: prepared.reduce(
        (total, value) => total + value.publication.envelopes.length,
        0,
      ),
      entrySetDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      entries,
    };
    signingBytes = publicationSetSigningBytesFromNormalized(unsigned);
    signature = crypto.sign(signingPrivateKey, signingBytes);
    if (!crypto.verify(signingPublicKey, signingBytes, signature)) {
      throw new TypeError("Namespace generation publication-set signing keys do not match");
    }
    const bytes = encodeNamespaceGenerationPublicationSetV1({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      publicationSet: decodeNamespaceGenerationPublicationSetV1(bytes),
      bytes,
      digest: sha256(bytes),
    });
  } finally {
    signingPublicKey.fill(0);
    signingPrivateKey.fill(0);
    entrySetDigest?.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
    entries.forEach(destroyPublicationSetEntry);
    for (const value of prepared) {
      destroyPublication(value.publication);
      value.bytes.fill(0);
      value.headDigest.fill(0);
      value.publicationDigest.fill(0);
    }
  }
}

/**
 * Authenticate a complete publication set without opening any recipient key.
 * The decoded publication and digest are callback-local and wiped afterward.
 */
async function withVerifiedNamespaceGenerationPublicationSet<Value>(
  crypto: LatticeCrypto,
  input: Omit<
    WithVerifiedNamespaceGenerationPublicationSetInputV1<Value>,
    "now"
  > & Readonly<{ now?: UnixTimestamp }>,
  enforceFreshness: boolean,
): Promise<Value | null> {
  let set: NamespaceGenerationPublicationSetV1 | undefined;
  let setSigningBytes: Uint8Array | undefined;
  let setDigest: Uint8Array | undefined;
  const issuerKey = exactBytes(
    "Namespace generation publication-set issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    set = decodeNamespaceGenerationPublicationSetV1(input.publicationSetBytes);
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (now < set.issuedAt || now >= set.expiresAt) return null;
    }
    setSigningBytes = namespaceGenerationPublicationSetSigningBytesV1(set);
    if (!crypto.verify(issuerKey, setSigningBytes, set.signature)) return null;
    setDigest = sha256(input.publicationSetBytes);
    if (input.expectedPublicationSetDigest !== undefined) {
      const expected = exactBytes(
        "Expected Namespace generation publication-set digest",
        input.expectedPublicationSetDigest,
        HASH_BYTES,
      );
      try {
        if (!sameBytes(setDigest, expected)) return null;
      } finally {
        expected.fill(0);
      }
    }
    for (const entry of set.entries) {
      const publication = decodeNamespaceGenerationPublicationV1(
        entry.publicationBytes,
      );
      let signingBytes: Uint8Array | undefined;
      try {
        signingBytes = namespaceGenerationPublicationSigningBytesV1(
          publication,
        );
        if (!crypto.verify(issuerKey, signingBytes, publication.signature)) {
          return null;
        }
      } finally {
        signingBytes?.fill(0);
        destroyPublication(publication);
      }
    }
    return await input.use(Object.freeze({
      publicationSet: set,
      publicationSetDigest: setDigest,
    }));
  } catch {
    return null;
  } finally {
    issuerKey.fill(0);
    if (set) destroyPublicationSet(set);
    setSigningBytes?.fill(0);
    setDigest?.fill(0);
  }
}

export async function withVerifiedNamespaceGenerationPublicationSetV1<Value>(
  crypto: LatticeCrypto,
  input: WithVerifiedNamespaceGenerationPublicationSetInputV1<Value>,
): Promise<Value | null> {
  return withVerifiedNamespaceGenerationPublicationSet(crypto, input, true);
}

/**
 * Re-authenticates an exact durable active publication after its admission
 * deadline. The required digest must come from the current durable head; this
 * function does not itself grant freshness or current product authority.
 */
export async function withVerifiedNamespaceGenerationPublicationSetExactReplayV1<
  Value,
>(
  crypto: LatticeCrypto,
  input: WithVerifiedNamespaceGenerationPublicationSetExactReplayInputV1<Value>,
): Promise<Value | null> {
  return withVerifiedNamespaceGenerationPublicationSet(crypto, input, false);
}

async function openNamespaceGenerationPublicationSet(
  crypto: LatticeCrypto,
  input: Omit<OpenNamespaceGenerationPublicationSetInputV1, "now"> & Readonly<{
    now?: UnixTimestamp;
  }>,
  enforceFreshness: boolean,
): Promise<OpenedNamespaceGenerationPublicationSetV1 | null> {
  let set: NamespaceGenerationPublicationSetV1 | undefined;
  let signingBytes: Uint8Array | undefined;
  let setDigest: Uint8Array | undefined;
  const issuerKey = exactBytes(
    "Namespace generation publication-set issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  try {
    set = decodeNamespaceGenerationPublicationSetV1(input.publicationSetBytes);
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (now < set.issuedAt || now >= set.expiresAt) return null;
    }
    signingBytes = namespaceGenerationPublicationSetSigningBytesV1(set);
    if (!crypto.verify(issuerKey, signingBytes, set.signature)) return null;
    setDigest = sha256(input.publicationSetBytes);
    if (input.expectedPublicationSetDigest !== undefined) {
      const expected = exactBytes(
        "Expected Namespace generation publication-set digest",
        input.expectedPublicationSetDigest,
        HASH_BYTES,
      );
      try {
        if (!sameBytes(setDigest, expected)) return null;
      } finally {
        expected.fill(0);
      }
    }
    const entry = set.entries.find((candidate) =>
      candidate.keyClass === input.keyClass
    );
    if (entry === undefined) return null;
    const opened = await openNamespaceGenerationEnvelope(crypto, {
      publicationBytes: entry.publicationBytes,
      issuerSigningPublicKey: issuerKey,
      recipientHumanId: input.recipientHumanId,
      recipientKind: input.recipientKind,
      recipientKeyId: input.recipientKeyId,
      recipientKeyGeneration: input.recipientKeyGeneration,
      recipientPrivateKey: input.recipientPrivateKey,
      ...(input.now === undefined ? {} : { now: input.now }),
      expectedPublicationDigest: entry.publicationDigest,
    }, enforceFreshness);
    if (opened === null) return null;
    return Object.freeze({
      ...opened,
      publicationSetDigest: setDigest.slice(),
    });
  } catch {
    return null;
  } finally {
    issuerKey.fill(0);
    if (set) destroyPublicationSet(set);
    signingBytes?.fill(0);
    setDigest?.fill(0);
  }
}

export async function openNamespaceGenerationPublicationSetV1(
  crypto: LatticeCrypto,
  input: OpenNamespaceGenerationPublicationSetInputV1,
): Promise<OpenedNamespaceGenerationPublicationSetV1 | null> {
  return openNamespaceGenerationPublicationSet(crypto, input, true);
}

/**
 * Opens an exact durable active publication after its admission deadline.
 * The caller must first authenticate the current durable head and supply its
 * complete publication-set digest; this function deliberately grants no
 * freshness by itself.
 */
export async function openNamespaceGenerationPublicationSetExactReplayV1(
  crypto: LatticeCrypto,
  input: OpenNamespaceGenerationPublicationSetExactReplayInputV1,
): Promise<OpenedNamespaceGenerationPublicationSetV1 | null> {
  return openNamespaceGenerationPublicationSet(crypto, input, false);
}
