import type { LatticeCrypto } from "../crypto/index.ts";
import {
  type DomainKeyClassV2,
  domainKeyClassV2,
} from "../domain/domain-keys-v2.ts";
import {
  assertPortableId,
  assertU64Counter,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type CryptoDomainId,
  type HumanId,
  type UnixTimestamp,
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

export const DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2 = 2 as const;
export const DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2 =
  "domain_key.access_request" as const;
export const DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2 =
  "domain_key.acknowledgement" as const;
export const DOMAIN_KEY_DELIVERY_MAX_TTL_MS_V2 = 30_000;
export const DOMAIN_KEY_DELIVERY_MAX_WIRE_BYTES_V2 = 8 * 1024;

const REQUEST_DOMAIN = "nautilo/lattice-crypto/domain-key-access-request/v2";
const ACK_DOMAIN = "nautilo/lattice-crypto/domain-key-acknowledgement/v2";
const HASH_BYTES = 32;

export interface DomainKeyDeliveryCoordinatesV2 {
  readonly serverId: string;
  readonly humanId: HumanId;
  readonly deviceId: CryptoDeviceId;
  readonly deviceSigningKeyGeneration: number;
  readonly cryptoDomainId: CryptoDomainId;
  readonly participantDigest: Uint8Array;
  readonly participantCount: number;
  readonly keyClass: DomainKeyClassV2;
  readonly domainKeyGeneration: number;
  readonly authorizationRevision: AuthorizationRevision;
  readonly headDigest: Uint8Array;
  readonly recipientKeyId: string;
  readonly recipientKeyGeneration: number;
  readonly recipientPublicKeyDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
}

export interface DomainKeyAccessRequestUnsignedV2
  extends DomainKeyDeliveryCoordinatesV2 {
  readonly formatVersion: typeof DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2;
  readonly requestId: string;
}

export interface DomainKeyAccessRequestV2
  extends DomainKeyAccessRequestUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface DomainKeyAcknowledgementUnsignedV2
  extends DomainKeyDeliveryCoordinatesV2 {
  readonly formatVersion: typeof DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2;
  readonly purpose: typeof DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2;
  readonly acknowledgementId: string;
  readonly requestDigest: Uint8Array | null;
  readonly envelopeDigest: Uint8Array;
  readonly processedDeviceRevision: number;
}

export interface DomainKeyAcknowledgementV2
  extends DomainKeyAcknowledgementUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface PreparedDomainKeyDeliveryRecordV2<Value> {
  readonly value: Value;
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
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

function exactBytes(label: string, value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new TypeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function normalizeCoordinates(
  value: DomainKeyDeliveryCoordinatesV2,
): DomainKeyDeliveryCoordinatesV2 {
  const issuedAt = unixTimestamp(value.issuedAt);
  const expiresAt = unixTimestamp(value.expiresAt);
  if (
    expiresAt <= issuedAt
    || expiresAt - issuedAt > DOMAIN_KEY_DELIVERY_MAX_TTL_MS_V2
  ) throw new RangeError("Domain key delivery validity window is invalid");
  return Object.freeze({
    serverId: portable("Server ID", value.serverId),
    humanId: humanId(value.humanId),
    deviceId: cryptoDeviceId(value.deviceId),
    deviceSigningKeyGeneration: counter(
      "Domain key delivery device signing generation",
      value.deviceSigningKeyGeneration,
      1,
    ),
    cryptoDomainId: cryptoDomainId(value.cryptoDomainId),
    participantDigest: exactBytes(
      "Domain key delivery participant digest",
      value.participantDigest,
    ),
    participantCount: counter(
      "Domain key delivery participant count",
      value.participantCount,
      1,
    ),
    keyClass: domainKeyClassV2(value.keyClass),
    domainKeyGeneration: counter(
      "Domain key delivery generation",
      value.domainKeyGeneration,
      1,
    ),
    authorizationRevision: authorizationRevision(value.authorizationRevision),
    headDigest: exactBytes("Domain key delivery head digest", value.headDigest),
    recipientKeyId: portable(
      "Domain key delivery recipient key ID",
      value.recipientKeyId,
    ),
    recipientKeyGeneration: counter(
      "Domain key delivery recipient generation",
      value.recipientKeyGeneration,
      1,
    ),
    recipientPublicKeyDigest: exactBytes(
      "Domain key delivery recipient public-key digest",
      value.recipientPublicKeyDigest,
    ),
    issuedAt,
    expiresAt,
  });
}

function coordinateSigningBytes(
  domain: string,
  purpose: string,
  operationId: string,
  value: DomainKeyDeliveryCoordinatesV2,
): Uint8Array {
  return concatV2(
    frameText(domain),
    encodeU32(DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2),
    frameText(purpose),
    frameText(operationId),
    frameText(value.serverId),
    frameText(value.humanId),
    frameText(value.deviceId),
    encodeU64(value.deviceSigningKeyGeneration),
    frameText(value.cryptoDomainId),
    frame(value.participantDigest),
    encodeU64(value.participantCount),
    frameText(value.keyClass),
    encodeU64(value.domainKeyGeneration),
    encodeU64(value.authorizationRevision),
    frame(value.headDigest),
    frameText(value.recipientKeyId),
    encodeU64(value.recipientKeyGeneration),
    frame(value.recipientPublicKeyDigest),
    encodeU64(value.issuedAt),
    encodeU64(value.expiresAt),
  );
}

export function domainKeyAccessRequestSigningBytesV2(
  value: DomainKeyAccessRequestUnsignedV2,
): Uint8Array {
  if (
    value.formatVersion !== DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2
    || value.purpose !== DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2
  ) throw new TypeError("Domain key access-request version is unsupported");
  const coordinates = normalizeCoordinates(value);
  try {
    return coordinateSigningBytes(
      REQUEST_DOMAIN,
      value.purpose,
      portable("Domain key access request ID", value.requestId),
      coordinates,
    );
  } finally {
    destroyCoordinates(coordinates);
  }
}

export function encodeDomainKeyAccessRequestV2(
  value: DomainKeyAccessRequestV2,
): Uint8Array {
  const signature = signatureBytes(value.signature);
  const signing = domainKeyAccessRequestSigningBytesV2(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    assertWireBound(bytes);
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainKeyAccessRequestV2(
  bytes: Uint8Array,
): DomainKeyAccessRequestV2 {
  assertWireBound(bytes);
  const value = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== REQUEST_DOMAIN) {
      throw new TypeError("Domain key access-request domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2) {
      throw new TypeError("Domain key access-request purpose is invalid");
    }
    return Object.freeze({
      formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
      requestId: reader.readText(V2_LIMITS.idBytes),
      ...decodeCoordinates(reader),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  return canonicalRequest(bytes, value);
}

export function domainKeyAcknowledgementSigningBytesV2(
  value: DomainKeyAcknowledgementUnsignedV2,
): Uint8Array {
  if (
    value.formatVersion !== DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2
    || value.purpose !== DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2
  ) throw new TypeError("Domain key acknowledgement version is unsupported");
  const coordinates = normalizeCoordinates(value);
  const requestDigest = value.requestDigest === null
    ? null
    : exactBytes("Domain key acknowledgement request digest", value.requestDigest);
  const envelopeDigest = exactBytes(
    "Domain key acknowledgement envelope digest",
    value.envelopeDigest,
  );
  try {
    return concatV2(
      coordinateSigningBytes(
        ACK_DOMAIN,
        value.purpose,
        portable("Domain key acknowledgement ID", value.acknowledgementId),
        coordinates,
      ),
      frame(requestDigest ?? new Uint8Array(0)),
      frame(envelopeDigest),
      encodeU64(counter(
        "Domain key acknowledgement processed device revision",
        value.processedDeviceRevision,
      )),
    );
  } finally {
    destroyCoordinates(coordinates);
    requestDigest?.fill(0);
    envelopeDigest.fill(0);
  }
}

export function encodeDomainKeyAcknowledgementV2(
  value: DomainKeyAcknowledgementV2,
): Uint8Array {
  const signature = signatureBytes(value.signature);
  const signing = domainKeyAcknowledgementSigningBytesV2(value);
  try {
    const bytes = concatV2(signing, frame(signature));
    assertWireBound(bytes);
    return bytes;
  } finally {
    signature.fill(0);
    signing.fill(0);
  }
}

export function decodeDomainKeyAcknowledgementV2(
  bytes: Uint8Array,
): DomainKeyAcknowledgementV2 {
  assertWireBound(bytes);
  const value = decodeExact(bytes, (reader) => {
    if (reader.readText(256) !== ACK_DOMAIN) {
      throw new TypeError("Domain key acknowledgement domain is invalid");
    }
    reader.readVersion(DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2);
    if (reader.readText(128) !== DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2) {
      throw new TypeError("Domain key acknowledgement purpose is invalid");
    }
    const acknowledgementId = reader.readText(V2_LIMITS.idBytes);
    const coordinates = decodeCoordinates(reader);
    const requestDigestBytes = reader.readFrame(HASH_BYTES);
    const requestDigest = requestDigestBytes.length === 0
      ? null
      : exactBytes("Domain key acknowledgement request digest", requestDigestBytes);
    requestDigestBytes.fill(0);
    return Object.freeze({
      formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2,
      acknowledgementId,
      ...coordinates,
      requestDigest,
      envelopeDigest: reader.readFrame(HASH_BYTES),
      processedDeviceRevision: reader.readU64(),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    });
  });
  const canonical = encodeDomainKeyAcknowledgementV2(value);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain key acknowledgement is noncanonical");
    }
    return value;
  } catch (error) {
    destroyDomainKeyAcknowledgementV2(value);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

export function prepareDomainKeyAccessRequestV2(
  crypto: LatticeCrypto,
  input: DomainKeyAccessRequestUnsignedV2 & Readonly<{
    signingPrivateKey: Uint8Array;
  }>,
): PreparedDomainKeyDeliveryRecordV2<DomainKeyAccessRequestV2> {
  const { signingPrivateKey, ...unsigned } = input;
  const signing = domainKeyAccessRequestSigningBytesV2(unsigned);
  const signature = crypto.sign(signingPrivateKey, signing);
  try {
    const bytes = encodeDomainKeyAccessRequestV2({ ...unsigned, signature });
    return Object.freeze({
      value: decodeDomainKeyAccessRequestV2(bytes),
      bytes,
      digest: crypto.hash(bytes),
    });
  } finally {
    signing.fill(0);
    signature.fill(0);
  }
}

export function prepareDomainKeyAcknowledgementV2(
  crypto: LatticeCrypto,
  input: DomainKeyAcknowledgementUnsignedV2 & Readonly<{
    signingPrivateKey: Uint8Array;
  }>,
): PreparedDomainKeyDeliveryRecordV2<DomainKeyAcknowledgementV2> {
  const { signingPrivateKey, ...unsigned } = input;
  const signing = domainKeyAcknowledgementSigningBytesV2(unsigned);
  const signature = crypto.sign(signingPrivateKey, signing);
  try {
    const bytes = encodeDomainKeyAcknowledgementV2({ ...unsigned, signature });
    return Object.freeze({
      value: decodeDomainKeyAcknowledgementV2(bytes),
      bytes,
      digest: crypto.hash(bytes),
    });
  } finally {
    signing.fill(0);
    signature.fill(0);
  }
}

export function verifyDomainKeyAccessRequestV2(
  crypto: Pick<LatticeCrypto, "verify">,
  input: Readonly<{
    bytes: Uint8Array;
    signingPublicKey: Uint8Array;
    now?: number;
  }>,
): DomainKeyAccessRequestV2 | null {
  let value: DomainKeyAccessRequestV2 | undefined;
  let signing: Uint8Array | undefined;
  try {
    value = decodeDomainKeyAccessRequestV2(input.bytes);
    signing = domainKeyAccessRequestSigningBytesV2(value);
    if (
      (input.now !== undefined
        && (input.now < value.issuedAt || input.now >= value.expiresAt))
      || !crypto.verify(input.signingPublicKey, signing, value.signature)
    ) return null;
    return decodeDomainKeyAccessRequestV2(input.bytes);
  } catch {
    return null;
  } finally {
    signing?.fill(0);
    if (value) destroyDomainKeyAccessRequestV2(value);
  }
}

export function verifyDomainKeyAcknowledgementV2(
  crypto: Pick<LatticeCrypto, "verify">,
  input: Readonly<{
    bytes: Uint8Array;
    signingPublicKey: Uint8Array;
    now?: number;
  }>,
): DomainKeyAcknowledgementV2 | null {
  let value: DomainKeyAcknowledgementV2 | undefined;
  let signing: Uint8Array | undefined;
  try {
    value = decodeDomainKeyAcknowledgementV2(input.bytes);
    signing = domainKeyAcknowledgementSigningBytesV2(value);
    if (
      (input.now !== undefined
        && (input.now < value.issuedAt || input.now >= value.expiresAt))
      || !crypto.verify(input.signingPublicKey, signing, value.signature)
    ) return null;
    return decodeDomainKeyAcknowledgementV2(input.bytes);
  } catch {
    return null;
  } finally {
    signing?.fill(0);
    if (value) destroyDomainKeyAcknowledgementV2(value);
  }
}

export function destroyDomainKeyAccessRequestV2(
  value: DomainKeyAccessRequestV2,
): void {
  destroyCoordinates(value);
  value.signature.fill(0);
}

export function destroyDomainKeyAcknowledgementV2(
  value: DomainKeyAcknowledgementV2,
): void {
  destroyCoordinates(value);
  value.requestDigest?.fill(0);
  value.envelopeDigest.fill(0);
  value.signature.fill(0);
}

function decodeCoordinates(
  reader: Parameters<Parameters<typeof decodeExact>[1]>[0],
): DomainKeyDeliveryCoordinatesV2 {
  return normalizeCoordinates({
    serverId: reader.readText(V2_LIMITS.idBytes),
    humanId: humanId(reader.readText(V2_LIMITS.idBytes)),
    deviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
    deviceSigningKeyGeneration: reader.readU64(),
    cryptoDomainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)),
    participantDigest: reader.readFrame(HASH_BYTES),
    participantCount: reader.readU64(),
    keyClass: domainKeyClassV2(reader.readText(16)),
    domainKeyGeneration: reader.readU64(),
    authorizationRevision: authorizationRevision(reader.readU64()),
    headDigest: reader.readFrame(HASH_BYTES),
    recipientKeyId: reader.readText(V2_LIMITS.idBytes),
    recipientKeyGeneration: reader.readU64(),
    recipientPublicKeyDigest: reader.readFrame(HASH_BYTES),
    issuedAt: unixTimestamp(reader.readU64()),
    expiresAt: unixTimestamp(reader.readU64()),
  });
}

function canonicalRequest(
  bytes: Uint8Array,
  value: DomainKeyAccessRequestV2,
): DomainKeyAccessRequestV2 {
  const canonical = encodeDomainKeyAccessRequestV2(value);
  try {
    if (!sameBytes(canonical, bytes)) {
      throw new TypeError("Domain key access request is noncanonical");
    }
    return value;
  } catch (error) {
    destroyDomainKeyAccessRequestV2(value);
    throw error;
  } finally {
    canonical.fill(0);
  }
}

function signatureBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== V2_LIMITS.signatureBytes) {
    throw new TypeError("Domain key delivery signature is invalid");
  }
  return copyOwnedBytesV2(value);
}

function assertWireBound(bytes: Uint8Array): void {
  if (bytes.length > DOMAIN_KEY_DELIVERY_MAX_WIRE_BYTES_V2) {
    throw new RangeError("Domain key delivery record exceeds its wire bound");
  }
}

function destroyCoordinates(value: DomainKeyDeliveryCoordinatesV2): void {
  value.participantDigest.fill(0);
  value.headDigest.fill(0);
  value.recipientPublicKeyDigest.fill(0);
}
