import { sha256 } from "@noble/hashes/sha2.js";

import type { LatticeCrypto } from "../crypto/index.ts";
import type { NamespaceKeyClass } from "../namespace/types.ts";
import {
  accessRevision,
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
import {
  CanonicalDecodingError,
  StrictDecoder,
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "./v2-primitives.ts";
import {
  namespaceGenerationKeyCommitmentV1,
  type NamespaceGenerationRecipientKindV1,
} from "./namespace-generation-v1.ts";

export const NAMESPACE_RECIPIENT_AUTHORIZATION_FORMAT_VERSION_V1 = 1 as const;
export const NAMESPACE_RECIPIENT_AUTHORIZATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-recipient-authorization/v1";
export const NAMESPACE_RECIPIENT_AUTHORIZATION_SECRET_DOMAIN_V1 =
  "nautilo/lattice-crypto/namespace-recipient-authorization-secret/v1";
export const NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_TTL_MS_V1 = 30_000;
export const NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_ENTRIES_V1 = 128;
export const MAX_NAMESPACE_RECIPIENT_AUTHORIZATION_WIRE_BYTES_V1 =
  2 * 1024 * 1024;

const PURPOSE = "namespace.historical_recipient_authorization";
const SECRET_PURPOSE = "namespace.historical_recipient_secret";
const HASH_BYTES = 32;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export interface NamespaceRecipientAuthorizationTargetV1 {
  readonly recipientHumanId: HumanId;
  readonly recipientKind: NamespaceGenerationRecipientKindV1;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPublicKeyDigest: Uint8Array;
}

export interface NamespaceRecipientAuthorizationGenerationV1 {
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly generation: NamespaceKeyGeneration;
  readonly sourceAccessRevision: AccessRevision;
  readonly sourceAudienceFingerprint: Uint8Array;
  readonly sourceHeadDigest: Uint8Array;
  readonly sourcePublicationDigest: Uint8Array;
  readonly sourcePublicationSetDigest: Uint8Array;
  readonly sourceRecipientEnvelopeDigest: Uint8Array;
  readonly generationKeyCommitment: Uint8Array;
}

export interface NamespaceRecipientAuthorizationEnvelopeV1
  extends NamespaceRecipientAuthorizationGenerationV1 {
  readonly ciphertext: Uint8Array;
}

export interface NamespaceRecipientAuthorizationV1 {
  readonly formatVersion:
    typeof NAMESPACE_RECIPIENT_AUTHORIZATION_FORMAT_VERSION_V1;
  readonly operationId: string;
  readonly currentAccessRevision: AccessRevision;
  readonly currentAudienceFingerprint: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly target: NamespaceRecipientAuthorizationTargetV1;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly entries: readonly NamespaceRecipientAuthorizationEnvelopeV1[];
  readonly signature: Uint8Array;
}

export interface PrepareNamespaceRecipientAuthorizationEntryV1
  extends NamespaceRecipientAuthorizationGenerationV1 {
  readonly generationKey: Uint8Array;
}

export interface PrepareNamespaceRecipientAuthorizationInputV1 {
  readonly operationId: string;
  readonly currentAccessRevision: AccessRevision;
  readonly currentAudienceFingerprint: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerSigningKeyGeneration: number;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly issuerSigningPrivateKey: Uint8Array;
  readonly target: NamespaceRecipientAuthorizationTargetV1 & Readonly<{
    recipientPublicKey: Uint8Array;
  }>;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly entries: readonly PrepareNamespaceRecipientAuthorizationEntryV1[];
}

export interface PreparedNamespaceRecipientAuthorizationV1 {
  readonly authorization: NamespaceRecipientAuthorizationV1;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

export interface VerifyNamespaceRecipientAuthorizationInputV1 {
  readonly bytes: Uint8Array;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly now: UnixTimestamp;
  readonly expectedDigest?: Uint8Array;
}

export interface OpenNamespaceRecipientAuthorizationInputV1
  extends VerifyNamespaceRecipientAuthorizationInputV1 {
  readonly recipientHumanId: HumanId;
  readonly recipientKind: NamespaceGenerationRecipientKindV1;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPrivateKey: Uint8Array;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly generation: NamespaceKeyGeneration;
}

export type OpenNamespaceRecipientAuthorizationExactReplayInputV1 =
  Omit<OpenNamespaceRecipientAuthorizationInputV1, "now">;

export interface OpenedNamespaceRecipientAuthorizationV1 {
  readonly authorizationDigest: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly entry: NamespaceRecipientAuthorizationGenerationV1;
  readonly generationKey: Uint8Array;
}

interface NamespaceRecipientAuthorizationSecretV1
  extends NamespaceRecipientAuthorizationGenerationV1,
    NamespaceRecipientAuthorizationTargetV1 {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly currentAccessRevision: AccessRevision;
  readonly currentAudienceFingerprint: Uint8Array;
  readonly generationKey: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function ownedBytes(label: string, value: Uint8Array, length?: number): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || (length !== undefined && value.length !== length)
  ) throw new TypeError(`${label} bytes are invalid`);
  return value.slice();
}

function boundedBytes(
  label: string,
  value: Uint8Array,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || value.length < minimum
    || value.length > maximum
  ) throw new TypeError(`${label} bytes are invalid`);
  return value.slice();
}

function portable(label: string, value: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > V2_LIMITS.idBytes
    || !PORTABLE.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function counter(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function keyClass(value: string): NamespaceKeyClass {
  if (value !== "ai" && value !== "human") {
    throw new TypeError("Namespace key class is invalid");
  }
  return value;
}

function recipientKind(value: string): NamespaceGenerationRecipientKindV1 {
  if (value !== "device" && value !== "recovery") {
    throw new TypeError("Namespace recipient kind is invalid");
  }
  return value;
}

function normalizeTarget(
  value: NamespaceRecipientAuthorizationTargetV1,
): NamespaceRecipientAuthorizationTargetV1 {
  return Object.freeze({
    recipientHumanId: humanId(value.recipientHumanId),
    recipientKind: recipientKind(value.recipientKind),
    recipientKeyId: portable("Namespace recipient key ID", value.recipientKeyId),
    recipientKeyGeneration: counter(
      "Namespace recipient key generation",
      value.recipientKeyGeneration,
    ),
    recipientPublicKeyDigest: ownedBytes(
      "Namespace recipient public-key digest",
      value.recipientPublicKeyDigest,
      HASH_BYTES,
    ),
  });
}

function destroyTarget(value: NamespaceRecipientAuthorizationTargetV1): void {
  value.recipientPublicKeyDigest.fill(0);
}

function normalizeGeneration(
  value: NamespaceRecipientAuthorizationGenerationV1,
): NamespaceRecipientAuthorizationGenerationV1 {
  return Object.freeze({
    namespaceId: namespaceId(value.namespaceId),
    keyClass: keyClass(value.keyClass),
    generation: namespaceGeneration(value.generation),
    sourceAccessRevision: accessRevision(value.sourceAccessRevision),
    sourceAudienceFingerprint: ownedBytes(
      "Namespace source audience fingerprint",
      value.sourceAudienceFingerprint,
      HASH_BYTES,
    ),
    sourceHeadDigest: ownedBytes(
      "Namespace source head digest",
      value.sourceHeadDigest,
      HASH_BYTES,
    ),
    sourcePublicationDigest: ownedBytes(
      "Namespace source publication digest",
      value.sourcePublicationDigest,
      HASH_BYTES,
    ),
    sourcePublicationSetDigest: ownedBytes(
      "Namespace source publication-set digest",
      value.sourcePublicationSetDigest,
      HASH_BYTES,
    ),
    sourceRecipientEnvelopeDigest: ownedBytes(
      "Namespace source recipient-envelope digest",
      value.sourceRecipientEnvelopeDigest,
      HASH_BYTES,
    ),
    generationKeyCommitment: ownedBytes(
      "Namespace generation key commitment",
      value.generationKeyCommitment,
      HASH_BYTES,
    ),
  });
}

function destroyGeneration(value: NamespaceRecipientAuthorizationGenerationV1): void {
  value.sourceAudienceFingerprint.fill(0);
  value.sourceHeadDigest.fill(0);
  value.sourcePublicationDigest.fill(0);
  value.sourcePublicationSetDigest.fill(0);
  value.sourceRecipientEnvelopeDigest.fill(0);
  value.generationKeyCommitment.fill(0);
}

function compareEntries(
  left: NamespaceRecipientAuthorizationGenerationV1,
  right: NamespaceRecipientAuthorizationGenerationV1,
): number {
  return (left.namespaceId < right.namespaceId
    ? -1
    : left.namespaceId > right.namespaceId
    ? 1
    : 0)
    || (left.keyClass === right.keyClass ? 0 : left.keyClass === "ai" ? -1 : 1)
    || left.generation - right.generation;
}

function targetBytes(value: NamespaceRecipientAuthorizationTargetV1): Uint8Array {
  return concatV2(
    frameText(value.recipientHumanId),
    frameText(value.recipientKind),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    frame(value.recipientPublicKeyDigest),
  );
}

function generationBytes(
  value: NamespaceRecipientAuthorizationGenerationV1,
): Uint8Array {
  return concatV2(
    frameText(value.namespaceId),
    frameText(value.keyClass),
    encodeU64(value.generation),
    encodeU64(value.sourceAccessRevision),
    frame(value.sourceAudienceFingerprint),
    frame(value.sourceHeadDigest),
    frame(value.sourcePublicationDigest),
    frame(value.sourcePublicationSetDigest),
    frame(value.sourceRecipientEnvelopeDigest),
    frame(value.generationKeyCommitment),
  );
}

function envelopeBytes(value: NamespaceRecipientAuthorizationEnvelopeV1): Uint8Array {
  return concatV2(generationBytes(value), frame(value.ciphertext));
}

function unsignedBytes(
  value: Omit<NamespaceRecipientAuthorizationV1, "signature">,
): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_RECIPIENT_AUTHORIZATION_DOMAIN_V1),
    frameText(PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.operationId),
    encodeU64(value.currentAccessRevision),
    frame(value.currentAudienceFingerprint),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerSigningKeyGeneration),
    frame(targetBytes(value.target)),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
    encodeU32(value.entries.length),
    ...value.entries.map((entry) => frame(envelopeBytes(entry))),
  );
}

function normalizeAuthorization(
  value: NamespaceRecipientAuthorizationV1,
): NamespaceRecipientAuthorizationV1 {
  if (value.formatVersion !== 1 || !Array.isArray(value.entries as unknown)) {
    throw new TypeError("Namespace recipient authorization is invalid");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_TTL_MS_V1
  ) throw new TypeError("Namespace recipient authorization deadline is invalid");
  const entries = value.entries.map((entry) => Object.freeze({
    ...normalizeGeneration(entry),
    ciphertext: boundedBytes(
      "Namespace recipient ciphertext",
      entry.ciphertext,
      1,
      MAX_CIPHERTEXT_BYTES,
    ),
  }));
  try {
    assertV2Range(
      "Namespace recipient authorization entries",
      entries.length,
      1,
      NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_ENTRIES_V1,
    );
    for (let index = 1; index < entries.length; index += 1) {
      if (compareEntries(entries[index - 1]!, entries[index]!) >= 0) {
        throw new TypeError(
          "Namespace recipient authorization entries must be canonical and unique",
        );
      }
    }
    return Object.freeze({
      formatVersion: 1,
      operationId: portable("Namespace recipient operation ID", value.operationId),
      currentAccessRevision: accessRevision(value.currentAccessRevision),
      currentAudienceFingerprint: ownedBytes(
        "Namespace current audience fingerprint",
        value.currentAudienceFingerprint,
        HASH_BYTES,
      ),
      issuerHumanId: humanId(value.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
      issuerSigningKeyGeneration: counter(
        "Namespace issuer signing-key generation",
        value.issuerSigningKeyGeneration,
      ),
      target: normalizeTarget(value.target),
      issuedAt,
      expiresAt,
      entries: Object.freeze(entries),
      signature: ownedBytes(
        "Namespace recipient authorization signature",
        value.signature,
        SIGNATURE_BYTES,
      ),
    });
  } catch (error) {
    entries.forEach((entry) => {
      destroyGeneration(entry);
      entry.ciphertext.fill(0);
    });
    throw error;
  }
}

export function destroyNamespaceRecipientAuthorizationV1(
  value: NamespaceRecipientAuthorizationV1,
): void {
  value.currentAudienceFingerprint.fill(0);
  destroyTarget(value.target);
  value.entries.forEach((entry) => {
    destroyGeneration(entry);
    entry.ciphertext.fill(0);
  });
  value.signature.fill(0);
}

export function namespaceRecipientAuthorizationSigningBytesV1(
  value: NamespaceRecipientAuthorizationV1,
): Uint8Array {
  const normalized = normalizeAuthorization(value);
  try {
    return unsignedBytes(normalized);
  } finally {
    destroyNamespaceRecipientAuthorizationV1(normalized);
  }
}

export function encodeNamespaceRecipientAuthorizationV1(
  value: NamespaceRecipientAuthorizationV1,
): Uint8Array {
  const normalized = normalizeAuthorization(value);
  try {
    return concatV2(unsignedBytes(normalized), frame(normalized.signature));
  } finally {
    destroyNamespaceRecipientAuthorizationV1(normalized);
  }
}

function readExactText(reader: StrictDecoder, expected: string, label: string): void {
  if (reader.readText(Math.max(expected.length, 1)) !== expected) {
    throw new CanonicalDecodingError(`${label} is invalid`);
  }
}

function readTarget(reader: StrictDecoder): NamespaceRecipientAuthorizationTargetV1 {
  const bytes = reader.readFrame(4 * 1024);
  try {
    return decodeExact(bytes, (nested) => ({
      recipientHumanId: humanId(nested.readText(V2_LIMITS.idBytes)),
      recipientKind: recipientKind(nested.readText(8)),
      recipientKeyId: nested.readText(V2_LIMITS.idBytes),
      recipientKeyGeneration: nested.readU64(),
      recipientPublicKeyDigest: nested.readFrame(HASH_BYTES),
    }));
  } finally {
    bytes.fill(0);
  }
}

function readGeneration(
  reader: StrictDecoder,
): NamespaceRecipientAuthorizationGenerationV1 {
  return {
    namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
    keyClass: keyClass(reader.readText(5)),
    generation: namespaceGeneration(reader.readU64()),
    sourceAccessRevision: accessRevision(reader.readU64()),
    sourceAudienceFingerprint: reader.readFrame(HASH_BYTES),
    sourceHeadDigest: reader.readFrame(HASH_BYTES),
    sourcePublicationDigest: reader.readFrame(HASH_BYTES),
    sourcePublicationSetDigest: reader.readFrame(HASH_BYTES),
    sourceRecipientEnvelopeDigest: reader.readFrame(HASH_BYTES),
    generationKeyCommitment: reader.readFrame(HASH_BYTES),
  };
}

function readEnvelope(reader: StrictDecoder): NamespaceRecipientAuthorizationEnvelopeV1 {
  const bytes = reader.readFrame(MAX_CIPHERTEXT_BYTES + 1024);
  try {
    return decodeExact(bytes, (nested) => ({
      ...readGeneration(nested),
      ciphertext: nested.readFrame(MAX_CIPHERTEXT_BYTES),
    }));
  } finally {
    bytes.fill(0);
  }
}

export function decodeNamespaceRecipientAuthorizationV1(
  bytes: Uint8Array,
): NamespaceRecipientAuthorizationV1 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > MAX_NAMESPACE_RECIPIENT_AUTHORIZATION_WIRE_BYTES_V1
  ) throw new TypeError("Namespace recipient authorization bytes are invalid");
  const raw = decodeExact(bytes, (reader): NamespaceRecipientAuthorizationV1 => {
    readExactText(reader, NAMESPACE_RECIPIENT_AUTHORIZATION_DOMAIN_V1, "Domain");
    readExactText(reader, PURPOSE, "Purpose");
    const formatVersion = reader.readVersion(1) as 1;
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const currentAccessRevision = accessRevision(reader.readU64());
    const currentAudienceFingerprint = reader.readFrame(HASH_BYTES);
    const issuerHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const issuerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
    const issuerSigningKeyGeneration = reader.readU64();
    const target = readTarget(reader);
    const issuedAt = unixTimestamp(reader.readU64());
    const expiresAt = unixTimestamp(reader.readU64());
    const count = reader.readCount(NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_ENTRIES_V1);
    const entries = Array.from({ length: count }, () => readEnvelope(reader));
    const signature = reader.readFrame(SIGNATURE_BYTES);
    return {
      formatVersion,
      operationId,
      currentAccessRevision,
      currentAudienceFingerprint,
      issuerHumanId,
      issuerDeviceId,
      issuerSigningKeyGeneration,
      target,
      issuedAt,
      expiresAt,
      entries,
      signature,
    };
  });
  let normalized: NamespaceRecipientAuthorizationV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeAuthorization(raw);
    canonical = concatV2(unsignedBytes(normalized), frame(normalized.signature));
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Namespace recipient authorization is noncanonical",
      );
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyNamespaceRecipientAuthorizationV1(raw);
    if (normalized) destroyNamespaceRecipientAuthorizationV1(normalized);
    canonical?.fill(0);
  }
}

export function namespaceRecipientAuthorizationDigestV1(
  bytes: Uint8Array,
): Uint8Array {
  const decoded = decodeNamespaceRecipientAuthorizationV1(bytes);
  try {
    return sha256(bytes);
  } finally {
    destroyNamespaceRecipientAuthorizationV1(decoded);
  }
}

function secretBytes(value: NamespaceRecipientAuthorizationSecretV1): Uint8Array {
  return concatV2(
    frameText(NAMESPACE_RECIPIENT_AUTHORIZATION_SECRET_DOMAIN_V1),
    frameText(SECRET_PURPOSE),
    encodeU32(value.formatVersion),
    frameText(value.operationId),
    encodeU64(value.currentAccessRevision),
    frame(value.currentAudienceFingerprint),
    frame(generationBytes(value)),
    frame(targetBytes(value)),
    frame(value.generationKey),
  );
}

function decodeSecret(bytes: Uint8Array): NamespaceRecipientAuthorizationSecretV1 {
  return decodeExact(bytes, (reader) => {
    readExactText(reader, NAMESPACE_RECIPIENT_AUTHORIZATION_SECRET_DOMAIN_V1, "Secret domain");
    readExactText(reader, SECRET_PURPOSE, "Secret purpose");
    const formatVersion = reader.readVersion(1) as 1;
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const currentAccessRevision = accessRevision(reader.readU64());
    const currentAudienceFingerprint = reader.readFrame(HASH_BYTES);
    const generationBytes = reader.readFrame(1024);
    let generation: NamespaceRecipientAuthorizationGenerationV1;
    try {
      generation = decodeExact(generationBytes, readGeneration);
    } finally {
      generationBytes.fill(0);
    }
    const target = readTarget(reader);
    const generationKey = reader.readFrame(KEY_BYTES);
    return {
      formatVersion,
      operationId,
      currentAccessRevision,
      currentAudienceFingerprint,
      ...generation,
      ...target,
      generationKey,
    };
  });
}

function destroySecret(value: NamespaceRecipientAuthorizationSecretV1): void {
  value.currentAudienceFingerprint.fill(0);
  destroyGeneration(value);
  destroyTarget(value);
  value.generationKey.fill(0);
}

export async function prepareNamespaceRecipientAuthorizationV1(
  crypto: LatticeCrypto,
  input: PrepareNamespaceRecipientAuthorizationInputV1,
): Promise<PreparedNamespaceRecipientAuthorizationV1> {
  const publicKey = boundedBytes(
    "Namespace recipient public key",
    input.target.recipientPublicKey,
    1,
    512,
  );
  const publicKeyDigest = sha256(publicKey);
  const target = normalizeTarget(input.target);
  const signingPublicKey = ownedBytes(
    "Namespace issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const signingPrivateKey = ownedBytes(
    "Namespace issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const currentAudienceFingerprint = ownedBytes(
    "Namespace current audience fingerprint",
    input.currentAudienceFingerprint,
    HASH_BYTES,
  );
  const entries: NamespaceRecipientAuthorizationEnvelopeV1[] = [];
  try {
    if (!sameBytes(publicKeyDigest, target.recipientPublicKeyDigest)) {
      throw new TypeError("Namespace recipient public key digest disagrees");
    }
    if (!Array.isArray(input.entries as unknown)) {
      throw new TypeError("Namespace recipient authorization entries are invalid");
    }
    const prepared = input.entries.map((entry) => ({
      generation: normalizeGeneration(entry),
      generationKey: ownedBytes(
        "Namespace historical generation key",
        entry.generationKey,
        KEY_BYTES,
      ),
    }));
    try {
      assertV2Range(
        "Namespace recipient authorization entries",
        prepared.length,
        1,
        NAMESPACE_RECIPIENT_AUTHORIZATION_MAX_ENTRIES_V1,
      );
      for (let index = 1; index < prepared.length; index += 1) {
        if (compareEntries(prepared[index - 1]!.generation, prepared[index]!.generation) >= 0) {
          throw new TypeError(
            "Namespace recipient authorization entries must be canonical and unique",
          );
        }
      }
      for (const item of prepared) {
        const commitment = namespaceGenerationKeyCommitmentV1({
          namespaceId: item.generation.namespaceId,
          keyClass: item.generation.keyClass,
          generation: item.generation.generation,
          generationKey: item.generationKey,
        });
        try {
          if (!sameBytes(commitment, item.generation.generationKeyCommitment)) {
            throw new TypeError("Namespace historical generation key disagrees");
          }
        } finally {
          commitment.fill(0);
        }
        const secret: NamespaceRecipientAuthorizationSecretV1 = {
          formatVersion: 1,
          operationId: portable("Namespace recipient operation ID", input.operationId),
          currentAccessRevision: accessRevision(input.currentAccessRevision),
          currentAudienceFingerprint: currentAudienceFingerprint.slice(),
          ...normalizeGeneration(item.generation),
          ...normalizeTarget(target),
          generationKey: item.generationKey.slice(),
        };
        let plaintext: Uint8Array | undefined;
        try {
          plaintext = secretBytes(secret);
          const ciphertext = await crypto.sealTo(publicKey, plaintext);
          entries.push(Object.freeze({
            ...normalizeGeneration(item.generation),
            ciphertext: ciphertext.slice(),
          }));
          ciphertext.fill(0);
        } finally {
          plaintext?.fill(0);
          destroySecret(secret);
        }
      }
      const unsigned = {
        formatVersion: 1 as const,
        operationId: portable("Namespace recipient operation ID", input.operationId),
        currentAccessRevision: accessRevision(input.currentAccessRevision),
        currentAudienceFingerprint: currentAudienceFingerprint.slice(),
        issuerHumanId: humanId(input.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(input.issuerDeviceId),
        issuerSigningKeyGeneration: counter(
          "Namespace issuer signing-key generation",
          input.issuerSigningKeyGeneration,
        ),
        target: normalizeTarget(target),
        issuedAt: unixTimestamp(input.issuedAt),
        expiresAt: unixTimestamp(input.expiresAt),
        entries: Object.freeze(entries),
      };
      let signingBytes: Uint8Array | undefined;
      let signature: Uint8Array | undefined;
      try {
        signingBytes = unsignedBytes(unsigned);
        signature = crypto.sign(signingPrivateKey, signingBytes);
        if (!crypto.verify(signingPublicKey, signingBytes, signature)) {
          throw new TypeError("Namespace recipient authorization signing keys disagree");
        }
        const bytes = encodeNamespaceRecipientAuthorizationV1({
          ...unsigned,
          signature,
        });
        return Object.freeze({
          authorization: decodeNamespaceRecipientAuthorizationV1(bytes),
          bytes,
          digest: sha256(bytes),
        });
      } finally {
        signingBytes?.fill(0);
        signature?.fill(0);
        unsigned.currentAudienceFingerprint.fill(0);
        destroyTarget(unsigned.target);
      }
    } finally {
      prepared.forEach((item) => {
        destroyGeneration(item.generation);
        item.generationKey.fill(0);
      });
    }
  } finally {
    publicKey.fill(0);
    publicKeyDigest.fill(0);
    destroyTarget(target);
    signingPublicKey.fill(0);
    signingPrivateKey.fill(0);
    currentAudienceFingerprint.fill(0);
    entries.forEach((entry) => {
      destroyGeneration(entry);
      entry.ciphertext.fill(0);
    });
  }
}

function verifyAuthorization(
  crypto: LatticeCrypto,
  input: Omit<VerifyNamespaceRecipientAuthorizationInputV1, "now"> & Readonly<{
    now?: UnixTimestamp;
  }>,
  enforceFreshness: boolean,
): NamespaceRecipientAuthorizationV1 | null {
  let decoded: NamespaceRecipientAuthorizationV1 | undefined;
  const issuerKey = ownedBytes(
    "Namespace issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let signingBytes: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  let expectedDigest: Uint8Array | undefined;
  try {
    decoded = decodeNamespaceRecipientAuthorizationV1(input.bytes);
    if (enforceFreshness) {
      const now = unixTimestamp(input.now);
      if (now < decoded.issuedAt || now >= decoded.expiresAt) return null;
    }
    signingBytes = unsignedBytes(decoded);
    if (!crypto.verify(issuerKey, signingBytes, decoded.signature)) return null;
    digest = sha256(input.bytes);
    if (input.expectedDigest !== undefined) {
      expectedDigest = ownedBytes(
        "Expected Namespace recipient authorization digest",
        input.expectedDigest,
        HASH_BYTES,
      );
      if (!sameBytes(digest, expectedDigest)) return null;
    }
    const result = decoded;
    decoded = undefined;
    return result;
  } catch {
    return null;
  } finally {
    issuerKey.fill(0);
    signingBytes?.fill(0);
    digest?.fill(0);
    expectedDigest?.fill(0);
    if (decoded) destroyNamespaceRecipientAuthorizationV1(decoded);
  }
}

export function verifyNamespaceRecipientAuthorizationV1(
  crypto: LatticeCrypto,
  input: VerifyNamespaceRecipientAuthorizationInputV1,
): NamespaceRecipientAuthorizationV1 | null {
  return verifyAuthorization(crypto, input, true);
}

export function verifyNamespaceRecipientAuthorizationExactReplayV1(
  crypto: LatticeCrypto,
  input: Omit<VerifyNamespaceRecipientAuthorizationInputV1, "now">,
): NamespaceRecipientAuthorizationV1 | null {
  return verifyAuthorization(crypto, input, false);
}

async function openAuthorization(
  crypto: LatticeCrypto,
  input:
    | OpenNamespaceRecipientAuthorizationInputV1
    | OpenNamespaceRecipientAuthorizationExactReplayInputV1,
  enforceFreshness: boolean,
): Promise<OpenedNamespaceRecipientAuthorizationV1 | null> {
  const authorization = enforceFreshness
    ? verifyNamespaceRecipientAuthorizationV1(
      crypto,
      input as OpenNamespaceRecipientAuthorizationInputV1,
    )
    : verifyNamespaceRecipientAuthorizationExactReplayV1(crypto, input);
  if (authorization === null) return null;
  const privateKey = boundedBytes(
    "Namespace recipient private key",
    input.recipientPrivateKey,
    1,
    512,
  );
  let plaintext: Uint8Array | null = null;
  let secret: NamespaceRecipientAuthorizationSecretV1 | undefined;
  try {
    if (
      authorization.target.recipientHumanId !== input.recipientHumanId
      || authorization.target.recipientKind !== input.recipientKind
      || authorization.target.recipientKeyId !== input.recipientKeyId
      || authorization.target.recipientKeyGeneration !== input.recipientKeyGeneration
    ) return null;
    const entry = authorization.entries.find((candidate) =>
      candidate.namespaceId === input.namespaceId
      && candidate.keyClass === input.keyClass
      && candidate.generation === input.generation
    );
    if (entry === undefined) return null;
    plaintext = await crypto.openSealed(privateKey, entry.ciphertext);
    if (plaintext === null) return null;
    secret = decodeSecret(plaintext);
    if (
      secret.operationId !== authorization.operationId
      || secret.currentAccessRevision !== authorization.currentAccessRevision
      || !sameBytes(
        secret.currentAudienceFingerprint,
        authorization.currentAudienceFingerprint,
      )
      || secret.recipientHumanId !== authorization.target.recipientHumanId
      || secret.recipientKind !== authorization.target.recipientKind
      || secret.recipientKeyId !== authorization.target.recipientKeyId
      || secret.recipientKeyGeneration
        !== authorization.target.recipientKeyGeneration
      || !sameBytes(
        secret.recipientPublicKeyDigest,
        authorization.target.recipientPublicKeyDigest,
      )
      || compareEntries(secret, entry) !== 0
      || !sameBytes(secret.sourceAudienceFingerprint, entry.sourceAudienceFingerprint)
      || !sameBytes(secret.sourceHeadDigest, entry.sourceHeadDigest)
      || !sameBytes(secret.sourcePublicationDigest, entry.sourcePublicationDigest)
      || !sameBytes(secret.sourcePublicationSetDigest, entry.sourcePublicationSetDigest)
      || !sameBytes(
        secret.sourceRecipientEnvelopeDigest,
        entry.sourceRecipientEnvelopeDigest,
      )
      || !sameBytes(secret.generationKeyCommitment, entry.generationKeyCommitment)
    ) return null;
    const commitment = namespaceGenerationKeyCommitmentV1({
      namespaceId: secret.namespaceId,
      keyClass: secret.keyClass,
      generation: secret.generation,
      generationKey: secret.generationKey,
    });
    try {
      if (!sameBytes(commitment, entry.generationKeyCommitment)) return null;
    } finally {
      commitment.fill(0);
    }
    return Object.freeze({
      authorizationDigest: sha256(input.bytes),
      envelopeDigest: sha256(entry.ciphertext),
      entry: normalizeGeneration(entry),
      generationKey: secret.generationKey.slice(),
    });
  } catch {
    return null;
  } finally {
    destroyNamespaceRecipientAuthorizationV1(authorization);
    privateKey.fill(0);
    plaintext?.fill(0);
    if (secret) destroySecret(secret);
  }
}

export async function openNamespaceRecipientAuthorizationV1(
  crypto: LatticeCrypto,
  input: OpenNamespaceRecipientAuthorizationInputV1,
): Promise<OpenedNamespaceRecipientAuthorizationV1 | null> {
  return openAuthorization(crypto, input, true);
}

export async function openNamespaceRecipientAuthorizationExactReplayV1(
  crypto: LatticeCrypto,
  input: OpenNamespaceRecipientAuthorizationExactReplayInputV1,
): Promise<OpenedNamespaceRecipientAuthorizationV1 | null> {
  return openAuthorization(crypto, input, false);
}
