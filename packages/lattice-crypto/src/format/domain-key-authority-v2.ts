import type { LatticeCrypto } from "../crypto/index.ts";
import {
  DOMAIN_KEY_BYTES_V2,
  type DomainKeyClassV2,
  domainKeyClassV2,
} from "../domain/domain-keys-v2.ts";
import type {
  AuthorizationRevision,
  CryptoDeviceId,
  CryptoDomainId,
  HumanId,
} from "../v2-types/ids.ts";
import {
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  concatV2,
  decodeExact,
  encodeU32,
  encodeU64,
  frame,
  frameText,
} from "./v2-primitives.ts";

export const DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2 = 2 as const;
export const DOMAIN_KEY_HEAD_PURPOSE_V2 = "domain_key.head" as const;
export const DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2 =
  "domain_key.recipient_secret" as const;
export const DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2 =
  "domain_key.recipient_envelope" as const;
export const DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2 =
  "domain_key.recipient_authorization" as const;
export const DOMAIN_KEY_AUTHORITY_MAX_TTL_MS_V2 = 30_000;
export const DOMAIN_KEY_HEAD_MAX_WIRE_BYTES_V2 = 8 * 1024;
export const DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2 = 16 * 1024;
export const DOMAIN_KEY_RECIPIENT_AUTHORIZATION_MAX_WIRE_BYTES_V2 = 32 * 1024;

const HEAD_DOMAIN = "nautilo/lattice-crypto/domain-key-head/v2";
const SECRET_DOMAIN = "nautilo/lattice-crypto/domain-key-recipient-secret/v2";
const ENVELOPE_DOMAIN =
  "nautilo/lattice-crypto/domain-key-recipient-envelope/v2";
const AUTHORIZATION_DOMAIN =
  "nautilo/lattice-crypto/domain-key-recipient-authorization/v2";
const HASH_BYTES = 32;

export type DomainKeyRecipientKindV2 = "device" | "recovery";
export type DomainKeyRecipientAuthorizationReasonV2 =
  | "head_establishment"
  | "late_recipient"
  | "catch_up";

export interface DomainKeyHeadUnsignedV2 {
  readonly formatVersion: typeof DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_HEAD_PURPOSE_V2;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly previousHeadDigest: Uint8Array | null;
  readonly publicationOperationId: string;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerDeviceSigningGeneration: number;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface DomainKeyHeadV2 extends DomainKeyHeadUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface DomainKeyRecipientV2 {
  readonly recipientHumanId: HumanId;
  readonly recipientKind: DomainKeyRecipientKindV2;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPublicKeyDigest: Uint8Array;
}

export interface DomainKeyRecipientInputV2 extends DomainKeyRecipientV2 {
  readonly recipientPublicKey: Uint8Array;
}

export interface DomainKeyRecipientSecretV2 extends DomainKeyRecipientV2 {
  readonly formatVersion: typeof DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly headDigest: Uint8Array;
  readonly domainKey: Uint8Array;
}

export interface DomainKeyRecipientEnvelopeUnsignedV2
  extends DomainKeyRecipientV2 {
  readonly formatVersion: typeof DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2;
  readonly serverId: string;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly headDigest: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly ciphertextDigest: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerDeviceSigningGeneration: number;
}

export interface DomainKeyRecipientEnvelopeV2
  extends DomainKeyRecipientEnvelopeUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface DomainKeyRecipientAuthorizationUnsignedV2 {
  readonly formatVersion: typeof DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2;
  readonly authorizationOperationId: string;
  readonly reason: DomainKeyRecipientAuthorizationReasonV2;
  readonly requestDigest: Uint8Array | null;
  readonly envelopeBytes: Uint8Array;
  readonly envelopeDigest: Uint8Array;
  readonly issuerHumanId: HumanId;
  readonly issuerDeviceId: CryptoDeviceId;
  readonly issuerDeviceSigningGeneration: number;
  readonly issuedAt: number;
  readonly deadlineAt: number;
}

export interface DomainKeyRecipientAuthorizationV2
  extends DomainKeyRecipientAuthorizationUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface PreparedDomainKeyHeadV2 {
  readonly head: DomainKeyHeadV2;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

export interface PreparedDomainKeyRecipientEnvelopeV2 {
  readonly envelope: DomainKeyRecipientEnvelopeV2;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

export interface OpenedDomainKeyRecipientEnvelopeV2 {
  readonly envelope: DomainKeyRecipientEnvelopeV2;
  readonly envelopeDigest: Uint8Array;
  readonly domainKey: Uint8Array;
}

export interface PreparedDomainKeyRecipientAuthorizationV2 {
  readonly authorization: DomainKeyRecipientAuthorizationV2;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function counter(label: string, value: unknown, minimum = 0): number {
  assertU64Counter(label, value);
  if (value < minimum) throw new RangeError(`${label} is below its minimum`);
  return value;
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new RangeError(`${label} must be exactly ${length} bytes`);
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
  ) throw new RangeError(`${label} is out of bounds`);
  return copyOwnedBytesV2(value);
}

function nullableDigestBytes(value: Uint8Array | null): Uint8Array {
  return value === null ? new Uint8Array(0) : value;
}

function recipientKind(value: unknown): DomainKeyRecipientKindV2 {
  if (value !== "device" && value !== "recovery") {
    throw new TypeError("Domain key recipient kind is unsupported");
  }
  return value;
}

function authorizationReason(
  value: unknown,
): DomainKeyRecipientAuthorizationReasonV2 {
  if (
    value !== "head_establishment"
    && value !== "late_recipient"
    && value !== "catch_up"
  ) throw new TypeError("Domain key authorization reason is unsupported");
  return value;
}

function readNullableDigest(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): Uint8Array | null {
  const value = reader.readFrame(HASH_BYTES);
  if (value.length === 0) return null;
  if (value.length !== HASH_BYTES) {
    value.fill(0);
    throw new TypeError("Nullable digest is invalid");
  }
  return value;
}

function validateWindow(issuedAtValue: unknown, deadlineAtValue: unknown) {
  const issuedAt = counter("Domain key issued time", issuedAtValue);
  const deadlineAt = counter("Domain key deadline", deadlineAtValue);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > DOMAIN_KEY_AUTHORITY_MAX_TTL_MS_V2
  ) throw new RangeError("Domain key authority deadline is invalid");
  return { issuedAt, deadlineAt };
}

function normalizeHeadUnsigned(
  value: DomainKeyHeadUnsignedV2,
): DomainKeyHeadUnsignedV2 {
  const window = validateWindow(value.issuedAt, value.deadlineAt);
  return Object.freeze({
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_HEAD_PURPOSE_V2,
    serverId: portable("Server ID", value.serverId),
    cryptoDomainId: cryptoDomainId(value.cryptoDomainId),
    participantDigest: exactBytes(
      "Domain participant digest",
      value.participantDigest,
      HASH_BYTES,
    ),
    participantCount: counter("Domain participant count", value.participantCount, 1),
    keyClass: domainKeyClassV2(value.keyClass),
    domainKeyGeneration: counter("Domain key generation", value.domainKeyGeneration, 1),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    previousHeadDigest: value.previousHeadDigest === null
      ? null
      : exactBytes("Previous Domain key head digest", value.previousHeadDigest, HASH_BYTES),
    publicationOperationId: portable(
      "Domain key publication operation ID",
      value.publicationOperationId,
    ),
    issuerHumanId: humanId(value.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
    issuerDeviceSigningGeneration: counter(
      "Domain key issuer signing generation",
      value.issuerDeviceSigningGeneration,
      1,
    ),
    ...window,
  });
}

function headSigningBytesNormalized(value: DomainKeyHeadUnsignedV2): Uint8Array {
  return concatV2(
    frameText(HEAD_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.serverId),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(nullableDigestBytes(value.previousHeadDigest)),
    frameText(value.publicationOperationId),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerDeviceSigningGeneration),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function domainKeyHeadSigningBytesV2(
  value: DomainKeyHeadUnsignedV2,
): Uint8Array {
  const normalized = normalizeHeadUnsigned(value);
  try {
    return headSigningBytesNormalized(normalized);
  } finally {
    destroyHeadUnsigned(normalized);
  }
}

export function encodeDomainKeyHeadV2(value: DomainKeyHeadV2): Uint8Array {
  const signature = exactBytes(
    "Domain key head signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  const signing = domainKeyHeadSigningBytesV2(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    if (bytes.length > DOMAIN_KEY_HEAD_MAX_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Domain key head exceeds its wire bound");
    }
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainKeyHeadV2(bytes: Uint8Array): DomainKeyHeadV2 {
  if (bytes.length > DOMAIN_KEY_HEAD_MAX_WIRE_BYTES_V2) {
    throw new RangeError("Domain key head exceeds its wire bound");
  }
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== HEAD_DOMAIN) {
      throw new TypeError("Domain key head domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_HEAD_PURPOSE_V2) {
      throw new TypeError("Domain key head purpose is invalid");
    }
    const normalized = normalizeHeadUnsigned({
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_HEAD_PURPOSE_V2,
      serverId: reader.readText(V2_LIMITS.idBytes),
      cryptoDomainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      participantDigest: reader.readFrame(HASH_BYTES),
      participantCount: reader.readU64(),
      keyClass: domainKeyClassV2(reader.readText(16)),
      domainKeyGeneration: reader.readU64(),
      authorizationRevision: authorizationRevision(reader.readU64()),
      previousHeadDigest: readNullableDigest(reader),
      publicationOperationId: reader.readText(V2_LIMITS.idBytes),
      issuerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceSigningGeneration: reader.readU64(),
      issuedAt: reader.readU64(),
      deadlineAt: reader.readU64(),
    });
    return Object.freeze({
      ...normalized,
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeDomainKeyHeadV2(decoded);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain key head is noncanonical");
    }
    return decoded;
  } catch (error) {
    destroyDomainKeyHeadV2(decoded);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

export function prepareDomainKeyHeadV2(
  crypto: LatticeCrypto,
  input: Omit<
    DomainKeyHeadUnsignedV2,
    "formatVersion" | "purpose"
  > & Readonly<{
    issuerSigningPublicKey: Uint8Array;
    issuerSigningPrivateKey: Uint8Array;
  }>,
): PreparedDomainKeyHeadV2 {
  const publicKey = exactBytes(
    "Domain key issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Domain key issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const unsigned: DomainKeyHeadUnsignedV2 = {
    ...input,
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_HEAD_PURPOSE_V2,
  };
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signing = domainKeyHeadSigningBytesV2(unsigned);
    signature = crypto.sign(privateKey, signing);
    if (!crypto.verify(publicKey, signing, signature)) {
      throw new TypeError("Domain key head signing keys do not match");
    }
    const bytes = encodeDomainKeyHeadV2({ ...unsigned, signature });
    return Object.freeze({
      head: decodeDomainKeyHeadV2(bytes),
      bytes,
      digest: crypto.hash(bytes),
    });
  } finally {
    publicKey.fill(0);
    privateKey.fill(0);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export function verifyDomainKeyHeadV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    headBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    now?: number;
    expectedHeadDigest?: Uint8Array;
  }>,
): DomainKeyHeadV2 | null {
  const publicKey = exactBytes(
    "Domain key issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let head: DomainKeyHeadV2 | undefined;
  let signing: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  try {
    head = decodeDomainKeyHeadV2(input.headBytes);
    signing = domainKeyHeadSigningBytesV2(head);
    digest = crypto.hash(input.headBytes);
    if (
      !crypto.verify(publicKey, signing, head.signature)
      || (input.now !== undefined
        && (input.now < head.issuedAt || input.now >= head.deadlineAt))
      || (input.expectedHeadDigest !== undefined
        && !sameBytes(digest, input.expectedHeadDigest))
    ) return null;
    return decodeDomainKeyHeadV2(input.headBytes);
  } catch {
    return null;
  } finally {
    publicKey.fill(0);
    signing?.fill(0);
    digest?.fill(0);
    if (head) destroyDomainKeyHeadV2(head);
  }
}

function normalizeRecipient(value: DomainKeyRecipientV2): DomainKeyRecipientV2 {
  return Object.freeze({
    recipientHumanId: humanId(value.recipientHumanId),
    recipientKind: recipientKind(value.recipientKind),
    recipientKeyId: portable("Domain key recipient key ID", value.recipientKeyId),
    recipientKeyGeneration: counter(
      "Domain key recipient key generation",
      value.recipientKeyGeneration,
      1,
    ),
    recipientPublicKeyDigest: exactBytes(
      "Domain key recipient public-key digest",
      value.recipientPublicKeyDigest,
      HASH_BYTES,
    ),
  });
}

function recipientBytes(value: DomainKeyRecipientV2): Uint8Array {
  return concatV2(
    frameText(value.recipientHumanId),
    frameText(value.recipientKind),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    frame(value.recipientPublicKeyDigest),
  );
}

function secretBytes(value: DomainKeyRecipientSecretV2): Uint8Array {
  return concatV2(
    frameText(SECRET_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.serverId),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(value.headDigest),
    recipientBytes(value),
    frame(value.domainKey),
  );
}

export function encodeDomainKeyRecipientSecretV2(
  value: DomainKeyRecipientSecretV2,
): Uint8Array {
  const recipient = normalizeRecipient(value);
  const participantDigest = exactBytes(
    "Domain participant digest",
    value.participantDigest,
    HASH_BYTES,
  );
  const headDigest = exactBytes("Domain key head digest", value.headDigest, HASH_BYTES);
  const key = exactBytes("Domain key", value.domainKey, DOMAIN_KEY_BYTES_V2);
  const normalized: DomainKeyRecipientSecretV2 = Object.freeze({
    ...recipient,
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2,
    serverId: portable("Server ID", value.serverId),
    cryptoDomainId: cryptoDomainId(value.cryptoDomainId),
    participantDigest,
    participantCount: counter("Domain participant count", value.participantCount, 1),
    keyClass: domainKeyClassV2(value.keyClass),
    domainKeyGeneration: counter("Domain key generation", value.domainKeyGeneration, 1),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    headDigest,
    domainKey: key,
  });
  try {
    return secretBytes(normalized);
  } finally {
    destroyDomainKeyRecipientSecretV2(normalized);
  }
}

export function decodeDomainKeyRecipientSecretV2(
  bytes: Uint8Array,
): DomainKeyRecipientSecretV2 {
  return decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== SECRET_DOMAIN) {
      throw new TypeError("Domain key recipient secret domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2) {
      throw new TypeError("Domain key recipient secret purpose is invalid");
    }
    return Object.freeze({
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2,
      serverId: portable("Server ID", reader.readText(V2_LIMITS.idBytes)),
      cryptoDomainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      participantDigest: reader.readFrame(HASH_BYTES),
      participantCount: counter("Domain participant count", reader.readU64(), 1),
      keyClass: domainKeyClassV2(reader.readText(16)),
      domainKeyGeneration: counter("Domain key generation", reader.readU64(), 1),
      authorizationRevision: authorizationRevision(reader.readU64()),
      headDigest: reader.readFrame(HASH_BYTES),
      recipientHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      recipientKind: recipientKind(reader.readText(16)),
      recipientKeyId: portable(
        "Domain key recipient key ID",
        reader.readText(V2_LIMITS.idBytes),
      ),
      recipientKeyGeneration: counter(
        "Domain key recipient key generation",
        reader.readU64(),
        1,
      ),
      recipientPublicKeyDigest: reader.readFrame(HASH_BYTES),
      domainKey: reader.readFrame(DOMAIN_KEY_BYTES_V2),
    });
  });
}

function normalizeEnvelopeUnsigned(
  value: DomainKeyRecipientEnvelopeUnsignedV2,
): DomainKeyRecipientEnvelopeUnsignedV2 {
  const recipient = normalizeRecipient(value);
  return Object.freeze({
    ...recipient,
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2,
    serverId: portable("Server ID", value.serverId),
    cryptoDomainId: cryptoDomainId(value.cryptoDomainId),
    participantDigest: exactBytes(
      "Domain participant digest",
      value.participantDigest,
      HASH_BYTES,
    ),
    participantCount: counter("Domain participant count", value.participantCount, 1),
    keyClass: domainKeyClassV2(value.keyClass),
    domainKeyGeneration: counter("Domain key generation", value.domainKeyGeneration, 1),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    headDigest: exactBytes("Domain key head digest", value.headDigest, HASH_BYTES),
    ciphertext: boundedBytes("Domain key envelope ciphertext", value.ciphertext, 1, 4096),
    ciphertextDigest: exactBytes(
      "Domain key envelope ciphertext digest",
      value.ciphertextDigest,
      HASH_BYTES,
    ),
    issuerHumanId: humanId(value.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
    issuerDeviceSigningGeneration: counter(
      "Domain key issuer signing generation",
      value.issuerDeviceSigningGeneration,
      1,
    ),
  });
}

function envelopeSigningBytesNormalized(
  value: DomainKeyRecipientEnvelopeUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(ENVELOPE_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.serverId),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(value.headDigest),
    recipientBytes(value),
    frame(value.ciphertext),
    frame(value.ciphertextDigest),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerDeviceSigningGeneration),
  );
}

export function domainKeyRecipientEnvelopeSigningBytesV2(
  value: DomainKeyRecipientEnvelopeUnsignedV2,
): Uint8Array {
  const normalized = normalizeEnvelopeUnsigned(value);
  try {
    return envelopeSigningBytesNormalized(normalized);
  } finally {
    destroyEnvelopeUnsigned(normalized);
  }
}

export function encodeDomainKeyRecipientEnvelopeV2(
  value: DomainKeyRecipientEnvelopeV2,
): Uint8Array {
  const signature = exactBytes(
    "Domain key recipient envelope signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  const signing = domainKeyRecipientEnvelopeSigningBytesV2(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    if (bytes.length > DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Domain key recipient envelope exceeds its wire bound");
    }
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainKeyRecipientEnvelopeV2(
  bytes: Uint8Array,
): DomainKeyRecipientEnvelopeV2 {
  if (bytes.length > DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2) {
    throw new RangeError("Domain key recipient envelope exceeds its wire bound");
  }
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== ENVELOPE_DOMAIN) {
      throw new TypeError("Domain key recipient envelope domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2) {
      throw new TypeError("Domain key recipient envelope purpose is invalid");
    }
    const normalized = normalizeEnvelopeUnsigned({
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2,
      serverId: reader.readText(V2_LIMITS.idBytes),
      cryptoDomainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
      participantDigest: reader.readFrame(HASH_BYTES),
      participantCount: reader.readU64(),
      keyClass: domainKeyClassV2(reader.readText(16)),
      domainKeyGeneration: reader.readU64(),
      authorizationRevision: authorizationRevision(reader.readU64()),
      headDigest: reader.readFrame(HASH_BYTES),
      recipientHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      recipientKind: recipientKind(reader.readText(16)),
      recipientKeyId: reader.readText(V2_LIMITS.idBytes),
      recipientKeyGeneration: reader.readU64(),
      recipientPublicKeyDigest: reader.readFrame(HASH_BYTES),
      ciphertext: reader.readFrame(4096),
      ciphertextDigest: reader.readFrame(HASH_BYTES),
      issuerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceSigningGeneration: reader.readU64(),
    });
    return Object.freeze({
      ...normalized,
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeDomainKeyRecipientEnvelopeV2(decoded);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain key recipient envelope is noncanonical");
    }
    return decoded;
  } catch (error) {
    destroyDomainKeyRecipientEnvelopeV2(decoded);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

export async function prepareDomainKeyRecipientEnvelopeV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    head: DomainKeyHeadV2;
    headDigest: Uint8Array;
    recipient: DomainKeyRecipientInputV2;
    domainKey: Uint8Array;
    issuerHumanId: HumanId;
    issuerDeviceId: CryptoDeviceId;
    issuerDeviceSigningGeneration: number;
    issuerSigningPublicKey: Uint8Array;
    issuerSigningPrivateKey: Uint8Array;
  }>,
): Promise<PreparedDomainKeyRecipientEnvelopeV2> {
  const headDigest = exactBytes("Domain key head digest", input.headDigest, HASH_BYTES);
  const domainKey = exactBytes("Domain key", input.domainKey, DOMAIN_KEY_BYTES_V2);
  const recipient = normalizeRecipient(input.recipient);
  const recipientPublicKey = boundedBytes(
    "Domain key recipient public key",
    input.recipient.recipientPublicKey,
    1,
    512,
  );
  const signingPublicKey = exactBytes(
    "Domain key issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const signingPrivateKey = exactBytes(
    "Domain key issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  let plaintext: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let ciphertextDigest: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    const actualHeadDigest = crypto.hash(encodeDomainKeyHeadV2(input.head));
    const actualRecipientDigest = crypto.hash(recipientPublicKey);
    try {
      if (!sameBytes(actualHeadDigest, headDigest)) {
        throw new TypeError("Domain key head digest disagrees");
      }
      if (!sameBytes(actualRecipientDigest, recipient.recipientPublicKeyDigest)) {
        throw new TypeError("Domain key recipient public-key digest disagrees");
      }
    } finally {
      actualHeadDigest.fill(0);
      actualRecipientDigest.fill(0);
    }
    plaintext = encodeDomainKeyRecipientSecretV2({
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_RECIPIENT_SECRET_PURPOSE_V2,
      serverId: input.head.serverId,
      cryptoDomainId: input.head.cryptoDomainId,
      participantDigest: input.head.participantDigest,
      participantCount: input.head.participantCount,
      keyClass: input.head.keyClass,
      domainKeyGeneration: input.head.domainKeyGeneration,
      authorizationRevision: input.head.authorizationRevision,
      headDigest,
      ...recipient,
      domainKey,
    });
    ciphertext = await crypto.sealTo(recipientPublicKey, plaintext);
    ciphertextDigest = crypto.hash(ciphertext);
    const unsigned: DomainKeyRecipientEnvelopeUnsignedV2 = {
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_RECIPIENT_ENVELOPE_PURPOSE_V2,
      serverId: input.head.serverId,
      cryptoDomainId: input.head.cryptoDomainId,
      participantDigest: input.head.participantDigest,
      participantCount: input.head.participantCount,
      keyClass: input.head.keyClass,
      domainKeyGeneration: input.head.domainKeyGeneration,
      authorizationRevision: input.head.authorizationRevision,
      headDigest,
      ...recipient,
      ciphertext,
      ciphertextDigest,
      issuerHumanId: input.issuerHumanId,
      issuerDeviceId: input.issuerDeviceId,
      issuerDeviceSigningGeneration: input.issuerDeviceSigningGeneration,
    };
    signing = domainKeyRecipientEnvelopeSigningBytesV2(unsigned);
    signature = crypto.sign(signingPrivateKey, signing);
    if (!crypto.verify(signingPublicKey, signing, signature)) {
      throw new TypeError("Domain key envelope signing keys do not match");
    }
    const bytes = encodeDomainKeyRecipientEnvelopeV2({ ...unsigned, signature });
    return Object.freeze({
      envelope: decodeDomainKeyRecipientEnvelopeV2(bytes),
      bytes,
      digest: crypto.hash(bytes),
    });
  } finally {
    headDigest.fill(0);
    domainKey.fill(0);
    destroyRecipient(recipient);
    recipientPublicKey.fill(0);
    signingPublicKey.fill(0);
    signingPrivateKey.fill(0);
    plaintext?.fill(0);
    ciphertext?.fill(0);
    ciphertextDigest?.fill(0);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export function verifyDomainKeyRecipientEnvelopeV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    envelopeBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    expectedEnvelopeDigest?: Uint8Array;
  }>,
): DomainKeyRecipientEnvelopeV2 | null {
  const publicKey = exactBytes(
    "Domain key issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let envelope: DomainKeyRecipientEnvelopeV2 | undefined;
  let signing: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  let ciphertextDigest: Uint8Array | undefined;
  try {
    envelope = decodeDomainKeyRecipientEnvelopeV2(input.envelopeBytes);
    signing = domainKeyRecipientEnvelopeSigningBytesV2(envelope);
    digest = crypto.hash(input.envelopeBytes);
    ciphertextDigest = crypto.hash(envelope.ciphertext);
    if (
      !crypto.verify(publicKey, signing, envelope.signature)
      || !sameBytes(ciphertextDigest, envelope.ciphertextDigest)
      || (input.expectedEnvelopeDigest !== undefined
        && !sameBytes(digest, input.expectedEnvelopeDigest))
    ) return null;
    return decodeDomainKeyRecipientEnvelopeV2(input.envelopeBytes);
  } catch {
    return null;
  } finally {
    publicKey.fill(0);
    signing?.fill(0);
    digest?.fill(0);
    ciphertextDigest?.fill(0);
    if (envelope) destroyDomainKeyRecipientEnvelopeV2(envelope);
  }
}

export async function openDomainKeyRecipientEnvelopeV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    envelopeBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    expectedEnvelopeDigest?: Uint8Array;
    recipientHumanId: HumanId;
    recipientKind: DomainKeyRecipientKindV2;
    recipientKeyId: string;
    recipientKeyGeneration: number;
    recipientPrivateKey: Uint8Array;
  }>,
): Promise<OpenedDomainKeyRecipientEnvelopeV2 | null> {
  const envelope = verifyDomainKeyRecipientEnvelopeV2(crypto, input);
  if (envelope === null) return null;
  const recipientPrivateKey = boundedBytes(
    "Domain key recipient private key",
    input.recipientPrivateKey,
    1,
    512,
  );
  let plaintext: Uint8Array | null = null;
  let secret: DomainKeyRecipientSecretV2 | undefined;
  try {
    if (
      envelope.recipientHumanId !== input.recipientHumanId
      || envelope.recipientKind !== input.recipientKind
      || envelope.recipientKeyId !== input.recipientKeyId
      || envelope.recipientKeyGeneration !== input.recipientKeyGeneration
    ) return null;
    plaintext = await crypto.openSealed(recipientPrivateKey, envelope.ciphertext);
    if (plaintext === null) return null;
    secret = decodeDomainKeyRecipientSecretV2(plaintext);
    if (!secretMatchesEnvelope(secret, envelope)) return null;
    return Object.freeze({
      envelope: decodeDomainKeyRecipientEnvelopeV2(input.envelopeBytes),
      envelopeDigest: crypto.hash(input.envelopeBytes),
      domainKey: secret.domainKey.slice(),
    });
  } catch {
    return null;
  } finally {
    recipientPrivateKey.fill(0);
    plaintext?.fill(0);
    if (secret) destroyDomainKeyRecipientSecretV2(secret);
    destroyDomainKeyRecipientEnvelopeV2(envelope);
  }
}

function secretMatchesEnvelope(
  secret: DomainKeyRecipientSecretV2,
  envelope: DomainKeyRecipientEnvelopeV2,
): boolean {
  return secret.serverId === envelope.serverId
    && secret.cryptoDomainId === envelope.cryptoDomainId
    && secret.participantCount === envelope.participantCount
    && secret.keyClass === envelope.keyClass
    && secret.domainKeyGeneration === envelope.domainKeyGeneration
    && secret.authorizationRevision === envelope.authorizationRevision
    && secret.recipientHumanId === envelope.recipientHumanId
    && secret.recipientKind === envelope.recipientKind
    && secret.recipientKeyId === envelope.recipientKeyId
    && secret.recipientKeyGeneration === envelope.recipientKeyGeneration
    && sameBytes(secret.participantDigest, envelope.participantDigest)
    && sameBytes(secret.headDigest, envelope.headDigest)
    && sameBytes(
      secret.recipientPublicKeyDigest,
      envelope.recipientPublicKeyDigest,
    );
}

function normalizeAuthorizationUnsigned(
  value: DomainKeyRecipientAuthorizationUnsignedV2,
): DomainKeyRecipientAuthorizationUnsignedV2 {
  const reason = authorizationReason(value.reason);
  const requestDigest = value.requestDigest === null
    ? null
    : exactBytes("Domain key access request digest", value.requestDigest, HASH_BYTES);
  if (reason === "catch_up" && requestDigest === null) {
    throw new TypeError("Catch-up authorization requires an exact request digest");
  }
  if (reason === "head_establishment" && requestDigest !== null) {
    requestDigest.fill(0);
    throw new TypeError("Head establishment cannot bind an access request");
  }
  const envelopeBytes = boundedBytes(
    "Domain key recipient envelope",
    value.envelopeBytes,
    1,
    DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2,
  );
  const envelopeDigest = exactBytes(
    "Domain key recipient envelope digest",
    value.envelopeDigest,
    HASH_BYTES,
  );
  const window = validateWindow(value.issuedAt, value.deadlineAt);
  return Object.freeze({
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2,
    authorizationOperationId: portable(
      "Domain key authorization operation ID",
      value.authorizationOperationId,
    ),
    reason,
    requestDigest,
    envelopeBytes,
    envelopeDigest,
    issuerHumanId: humanId(value.issuerHumanId),
    issuerDeviceId: cryptoDeviceId(value.issuerDeviceId),
    issuerDeviceSigningGeneration: counter(
      "Domain key authorization issuer signing generation",
      value.issuerDeviceSigningGeneration,
      1,
    ),
    ...window,
  });
}

function authorizationSigningBytesNormalized(
  value: DomainKeyRecipientAuthorizationUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(AUTHORIZATION_DOMAIN),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.authorizationOperationId),
    frameText(value.reason),
    frame(nullableDigestBytes(value.requestDigest)),
    frame(value.envelopeBytes),
    frame(value.envelopeDigest),
    frameText(value.issuerHumanId),
    frameText(value.issuerDeviceId),
    encodeU64(value.issuerDeviceSigningGeneration),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function domainKeyRecipientAuthorizationSigningBytesV2(
  value: DomainKeyRecipientAuthorizationUnsignedV2,
): Uint8Array {
  const normalized = normalizeAuthorizationUnsigned(value);
  try {
    return authorizationSigningBytesNormalized(normalized);
  } finally {
    destroyAuthorizationUnsigned(normalized);
  }
}

export function encodeDomainKeyRecipientAuthorizationV2(
  value: DomainKeyRecipientAuthorizationV2,
): Uint8Array {
  const signature = exactBytes(
    "Domain key recipient authorization signature",
    value.signature,
    V2_LIMITS.signatureBytes,
  );
  const signing = domainKeyRecipientAuthorizationSigningBytesV2(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    if (bytes.length > DOMAIN_KEY_RECIPIENT_AUTHORIZATION_MAX_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError("Domain key authorization exceeds its wire bound");
    }
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainKeyRecipientAuthorizationV2(
  bytes: Uint8Array,
): DomainKeyRecipientAuthorizationV2 {
  if (bytes.length > DOMAIN_KEY_RECIPIENT_AUTHORIZATION_MAX_WIRE_BYTES_V2) {
    throw new RangeError("Domain key authorization exceeds its wire bound");
  }
  const decoded = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== AUTHORIZATION_DOMAIN) {
      throw new TypeError("Domain key authorization domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2) {
      throw new TypeError("Domain key authorization purpose is invalid");
    }
    const normalized = normalizeAuthorizationUnsigned({
      formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2,
      authorizationOperationId: reader.readText(V2_LIMITS.idBytes),
      reason: authorizationReason(reader.readText(32)),
      requestDigest: readNullableDigest(reader),
      envelopeBytes: reader.readFrame(DOMAIN_KEY_RECIPIENT_ENVELOPE_MAX_WIRE_BYTES_V2),
      envelopeDigest: reader.readFrame(HASH_BYTES),
      issuerHumanId: humanId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      issuerDeviceSigningGeneration: reader.readU64(),
      issuedAt: reader.readU64(),
      deadlineAt: reader.readU64(),
    });
    return Object.freeze({
      ...normalized,
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeDomainKeyRecipientAuthorizationV2(decoded);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain key authorization is noncanonical");
    }
    return decoded;
  } catch (error) {
    destroyDomainKeyRecipientAuthorizationV2(decoded);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

export function prepareDomainKeyRecipientAuthorizationV2(
  crypto: LatticeCrypto,
  input: Omit<
    DomainKeyRecipientAuthorizationUnsignedV2,
    "formatVersion" | "purpose"
  > & Readonly<{
    issuerSigningPublicKey: Uint8Array;
    issuerSigningPrivateKey: Uint8Array;
  }>,
): PreparedDomainKeyRecipientAuthorizationV2 {
  const publicKey = exactBytes(
    "Domain key authorization issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  const privateKey = exactBytes(
    "Domain key authorization issuer signing private key",
    input.issuerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const unsigned: DomainKeyRecipientAuthorizationUnsignedV2 = {
    ...input,
    formatVersion: DOMAIN_KEY_AUTHORITY_FORMAT_VERSION_V2,
    purpose: DOMAIN_KEY_RECIPIENT_AUTHORIZATION_PURPOSE_V2,
  };
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    const envelopeDigest = crypto.hash(input.envelopeBytes);
    try {
      if (!sameBytes(envelopeDigest, input.envelopeDigest)) {
        throw new TypeError("Domain key recipient envelope digest disagrees");
      }
    } finally {
      envelopeDigest.fill(0);
    }
    signing = domainKeyRecipientAuthorizationSigningBytesV2(unsigned);
    signature = crypto.sign(privateKey, signing);
    if (!crypto.verify(publicKey, signing, signature)) {
      throw new TypeError("Domain key authorization signing keys do not match");
    }
    const bytes = encodeDomainKeyRecipientAuthorizationV2({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      authorization: decodeDomainKeyRecipientAuthorizationV2(bytes),
      bytes,
      digest: crypto.hash(bytes),
    });
  } finally {
    publicKey.fill(0);
    privateKey.fill(0);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export function verifyDomainKeyRecipientAuthorizationV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    now?: number;
    expectedAuthorizationDigest?: Uint8Array;
  }>,
): DomainKeyRecipientAuthorizationV2 | null {
  const publicKey = exactBytes(
    "Domain key authorization issuer signing public key",
    input.issuerSigningPublicKey,
    V2_LIMITS.signingPublicKeyBytes,
  );
  let authorization: DomainKeyRecipientAuthorizationV2 | undefined;
  let signing: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  let envelopeDigest: Uint8Array | undefined;
  try {
    authorization = decodeDomainKeyRecipientAuthorizationV2(
      input.authorizationBytes,
    );
    signing = domainKeyRecipientAuthorizationSigningBytesV2(authorization);
    digest = crypto.hash(input.authorizationBytes);
    envelopeDigest = crypto.hash(authorization.envelopeBytes);
    if (
      !crypto.verify(publicKey, signing, authorization.signature)
      || !sameBytes(envelopeDigest, authorization.envelopeDigest)
      || (input.now !== undefined
        && (input.now < authorization.issuedAt
          || input.now >= authorization.deadlineAt))
      || (input.expectedAuthorizationDigest !== undefined
        && !sameBytes(digest, input.expectedAuthorizationDigest))
    ) return null;
    return decodeDomainKeyRecipientAuthorizationV2(input.authorizationBytes);
  } catch {
    return null;
  } finally {
    publicKey.fill(0);
    signing?.fill(0);
    digest?.fill(0);
    envelopeDigest?.fill(0);
    if (authorization) destroyDomainKeyRecipientAuthorizationV2(authorization);
  }
}

export function verifyDomainKeyRecipientAuthorizationExactReplayV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    authorizationBytes: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
    expectedAuthorizationDigest: Uint8Array;
  }>,
): DomainKeyRecipientAuthorizationV2 | null {
  return verifyDomainKeyRecipientAuthorizationV2(crypto, input);
}

function destroyRecipient(value: DomainKeyRecipientV2): void {
  value.recipientPublicKeyDigest.fill(0);
}

function destroyHeadUnsigned(value: DomainKeyHeadUnsignedV2): void {
  value.participantDigest.fill(0);
  value.previousHeadDigest?.fill(0);
}

export function destroyDomainKeyHeadV2(value: DomainKeyHeadV2): void {
  destroyHeadUnsigned(value);
  value.signature.fill(0);
}

export function destroyDomainKeyRecipientSecretV2(
  value: DomainKeyRecipientSecretV2,
): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.recipientPublicKeyDigest.fill(0);
  value.domainKey.fill(0);
}

function destroyEnvelopeUnsigned(
  value: DomainKeyRecipientEnvelopeUnsignedV2,
): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.recipientPublicKeyDigest.fill(0);
  value.ciphertext.fill(0);
  value.ciphertextDigest.fill(0);
}

export function destroyDomainKeyRecipientEnvelopeV2(
  value: DomainKeyRecipientEnvelopeV2,
): void {
  destroyEnvelopeUnsigned(value);
  value.signature.fill(0);
}

function destroyAuthorizationUnsigned(
  value: DomainKeyRecipientAuthorizationUnsignedV2,
): void {
  value.requestDigest?.fill(0);
  value.envelopeBytes.fill(0);
  value.envelopeDigest.fill(0);
}

export function destroyDomainKeyRecipientAuthorizationV2(
  value: DomainKeyRecipientAuthorizationV2,
): void {
  destroyAuthorizationUnsigned(value);
  value.signature.fill(0);
}
