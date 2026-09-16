import type { LatticeCrypto } from "../crypto/index.ts";
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
  accessRevision,
  agentId,
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type AgentId,
  type CryptoDeviceId,
  type HumanId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1 =
  1 as const;
export const HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-existing-message-representation-publication-request/v1";
export const HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1 =
  "message.existing_representation_publish" as const;
export const HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1 = 30_000;
export const MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1 =
  16 * 1024;

const HASH_BYTES = 32;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type HumanExistingMessageRepresentationAuthorRoleV1 =
  | "user"
  | "assistant"
  | "tool"
  | "system";

export interface HumanExistingMessageRepresentationPublicationRequestUnsignedV1 {
  readonly formatVersion:
    typeof HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1;
  readonly purpose:
    typeof HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly revision: number;
  readonly createdAt: UnixTimestamp;
  /** Immutable product authorship; never describes the encryption publisher. */
  readonly authorRole: HumanExistingMessageRepresentationAuthorRoleV1;
  /** Exact durable Human-turn provenance when the ordinary row has it. */
  readonly authorHumanTurnId: string | null;
  /** Exact Session Agent provenance, including null on legacy Sessions. */
  readonly sessionAgentId: AgentId | null;
  readonly cryptoObjectId: ObjectId;
  readonly namespaceId: NamespaceId;
  readonly namespaceBindingHash: Uint8Array;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly ciphertextPayloadHash: Uint8Array;
  readonly plaintextPayloadHash: Uint8Array;
  readonly accessManifestHash: Uint8Array;
  readonly envelopeHash: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanExistingMessageRepresentationPublicationRequestV1
  extends HumanExistingMessageRepresentationPublicationRequestUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface PrepareHumanExistingMessageRepresentationPublicationRequestInputV1
  extends Omit<
    HumanExistingMessageRepresentationPublicationRequestUnsignedV1,
    "formatVersion" | "purpose"
  > {
  readonly committerSigningPublicKey: Uint8Array;
  readonly committerSigningPrivateKey: Uint8Array;
}

export interface CreatedHumanExistingMessageRepresentationPublicationRequestV1 {
  readonly request: HumanExistingMessageRepresentationPublicationRequestV1;
  readonly bytes: Uint8Array;
}

export interface HumanExistingMessageRepresentationPublicationAuthorityContextV1 {
  readonly purpose: "human-existing-message-representation-publication-verify";
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export type ResolveCurrentHumanExistingMessageRepresentationPublicationAuthorityV1 = (
  context: HumanExistingMessageRepresentationPublicationAuthorityContextV1,
) => Uint8Array | null;

export interface VerifyHumanExistingMessageRepresentationPublicationExactReplayInputV1 {
  readonly requestBytes: Uint8Array;
  readonly expectedRequestDigest: Uint8Array;
  readonly resolveCurrentAuthority:
    ResolveCurrentHumanExistingMessageRepresentationPublicationAuthorityV1;
}

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "subjectHumanId", "operationId", "sessionId",
  "roomId", "messageId", "revision", "createdAt", "authorRole",
  "authorHumanTurnId", "sessionAgentId", "cryptoObjectId",
  "namespaceId", "namespaceBindingHash", "namespaceAccessRevision",
  "namespaceKeyGeneration", "bindingRevisionAtWrap", "ciphertextPayloadHash",
  "plaintextPayloadHash", "accessManifestHash", "envelopeHash", "issuedAt",
  "deadlineAt", "committerDeviceId", "hostAuthorizationRevision",
] as const);
const SIGNED_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);

function exactFields(label: string, value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((field, index) => field !== wanted[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function exactUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function exactCounter(label: string, value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum
    || (value as number) > PG_SERIAL_MAX) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function exactAuthorRole(
  value: unknown,
): HumanExistingMessageRepresentationAuthorRoleV1 {
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) throw new TypeError("Existing Message author role is invalid");
  return value;
}

function optionalPortableId(label: string, value: unknown): string | null {
  if (value === null) return null;
  assertPortableId(label, value);
  return value;
}

function normalizeUnsigned(
  value: HumanExistingMessageRepresentationPublicationRequestUnsignedV1,
): HumanExistingMessageRepresentationPublicationRequestUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human existing Message representation request must be an object");
  }
  exactFields("Human existing Message representation request", value, UNSIGNED_FIELDS);
  if (
    value.formatVersion
      !== HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1
    || value.purpose !== HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1
  ) throw new TypeError("Human existing Message representation request version or purpose is invalid");
  assertPortableId("Human existing Message representation operation ID", value.operationId);
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt
      > HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_MAX_TTL_MS_V1
  ) throw new RangeError("Human existing Message representation request lifetime is invalid");
  const hashes: Uint8Array[] = [];
  try {
    const namespaceBindingHash = exactBytes(
      "Human Message Namespace binding hash", value.namespaceBindingHash,
      HASH_BYTES,
    );
    hashes.push(namespaceBindingHash);
    const ciphertextPayloadHash = exactBytes(
      "Human Message ciphertext payload hash", value.ciphertextPayloadHash,
      HASH_BYTES,
    );
    hashes.push(ciphertextPayloadHash);
    const plaintextPayloadHash = exactBytes(
      "Human Message plaintext payload hash", value.plaintextPayloadHash,
      HASH_BYTES,
    );
    hashes.push(plaintextPayloadHash);
    const accessManifestHash = exactBytes(
      "Human Message access manifest hash", value.accessManifestHash,
      HASH_BYTES,
    );
    hashes.push(accessManifestHash);
    const envelopeHash = exactBytes(
      "Human Message envelope hash", value.envelopeHash, HASH_BYTES,
    );
    hashes.push(envelopeHash);
    const normalized = Object.freeze({
      formatVersion: HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1,
      purpose: HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1,
      subjectHumanId: humanId(value.subjectHumanId),
      operationId: value.operationId,
      sessionId: exactUuid("Human Message Session ID", value.sessionId),
      roomId: exactUuid("Human Message Room ID", value.roomId),
      messageId: exactCounter("Human Message ID", value.messageId, 1),
      revision: exactCounter("Human Message revision", value.revision, 0),
      createdAt: unixTimestamp(value.createdAt),
      authorRole: exactAuthorRole(value.authorRole),
      authorHumanTurnId: optionalPortableId(
        "Existing Message Human turn ID",
        value.authorHumanTurnId,
      ),
      sessionAgentId: value.sessionAgentId === null
        ? null
        : agentId(value.sessionAgentId),
      cryptoObjectId: objectId(value.cryptoObjectId),
      namespaceId: namespaceId(value.namespaceId),
      namespaceBindingHash,
      namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
      namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
      bindingRevisionAtWrap: accessRevision(value.bindingRevisionAtWrap),
      ciphertextPayloadHash,
      plaintextPayloadHash,
      accessManifestHash,
      envelopeHash,
      issuedAt,
      deadlineAt,
      committerDeviceId: cryptoDeviceId(value.committerDeviceId),
      hostAuthorizationRevision: authorizationRevision(
        value.hostAuthorizationRevision,
      ),
    });
    if (
      normalized.authorRole !== "user"
      && normalized.authorHumanTurnId !== null
    ) {
      throw new TypeError(
        "Only a user Message may carry Human-turn provenance",
      );
    }
    hashes.length = 0;
    return normalized;
  } finally {
    for (const hash of hashes) hash.fill(0);
  }
}

function normalizeRequest(
  value: HumanExistingMessageRepresentationPublicationRequestV1,
): HumanExistingMessageRepresentationPublicationRequestV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human existing Message representation request must be an object");
  }
  exactFields("Human existing Message representation request", value, SIGNED_FIELDS);
  const { signature, ...unsignedValue } = value;
  const unsigned = normalizeUnsigned(unsignedValue);
  try {
    return Object.freeze({
      ...unsigned,
      signature: exactBytes(
        "Human existing Message representation signature", signature, V2_LIMITS.signatureBytes,
      ),
    });
  } catch (error) {
    destroyUnsigned(unsigned);
    throw error;
  }
}

function destroyUnsigned(value: HumanExistingMessageRepresentationPublicationRequestUnsignedV1): void {
  value.namespaceBindingHash.fill(0);
  value.ciphertextPayloadHash.fill(0);
  value.plaintextPayloadHash.fill(0);
  value.accessManifestHash.fill(0);
  value.envelopeHash.fill(0);
}

function destroyRequest(value: HumanExistingMessageRepresentationPublicationRequestV1): void {
  destroyUnsigned(value);
  value.signature.fill(0);
}

function signingBytes(value: HumanExistingMessageRepresentationPublicationRequestUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1),
    encodeU32(HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1),
    frameText(value.purpose), frameText(value.subjectHumanId),
    frameText(value.operationId), frameText(value.sessionId),
    frameText(value.roomId), encodeU64(value.messageId),
    encodeU64(value.revision), encodeU64(value.createdAt),
    frameText(value.authorRole),
    encodeU32(value.authorHumanTurnId === null ? 0 : 1),
    ...(value.authorHumanTurnId === null
      ? []
      : [frameText(value.authorHumanTurnId)]),
    encodeU32(value.sessionAgentId === null ? 0 : 1),
    ...(value.sessionAgentId === null ? [] : [frameText(value.sessionAgentId)]),
    frameText(value.cryptoObjectId), frameText(value.namespaceId),
    frame(value.namespaceBindingHash), encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration), encodeU64(value.bindingRevisionAtWrap),
    frame(value.ciphertextPayloadHash), frame(value.plaintextPayloadHash),
    frame(value.accessManifestHash), frame(value.envelopeHash),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId), encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanExistingMessageRepresentationPublicationRequestSigningBytesV1(
  value: HumanExistingMessageRepresentationPublicationRequestUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return signingBytes(normalized);
  } finally {
    destroyUnsigned(normalized);
  }
}

export function encodeHumanExistingMessageRepresentationPublicationRequestV1(
  value: HumanExistingMessageRepresentationPublicationRequestV1,
): Uint8Array {
  const normalized = normalizeRequest(value);
  try {
    const bytes = concatV2(signingBytes(normalized), frame(normalized.signature));
    if (bytes.length > MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Human existing Message representation request exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyRequest(normalized);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export function decodeHumanExistingMessageRepresentationPublicationRequestV1(
  bytes: Uint8Array,
): HumanExistingMessageRepresentationPublicationRequestV1 {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Human existing Message representation request bytes must be Uint8Array");
  }
  if (bytes.length > MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1) {
    throw new RangeError("Human existing Message representation request exceeds its wire limit");
  }
  const raw = decodeExact(bytes, (reader): HumanExistingMessageRepresentationPublicationRequestV1 => {
    const domain = reader.readText(
      utf8V2(HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1).length,
    );
    if (domain !== HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_DOMAIN_V1) {
      throw new CanonicalDecodingError("Human existing Message representation request domain mismatch");
    }
    const formatVersion = reader.readVersion(
      HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1,
    ) as 1;
    const purpose = reader.readText(
      utf8V2(HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1).length,
    ) as typeof HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1;
    const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const sessionId = reader.readText(36);
    const roomId = reader.readText(36);
    const messageId = reader.readU64();
    const revision = reader.readU64();
    const createdAt = unixTimestamp(reader.readU64());
    const authorRole = reader.readText(9) as
      HumanExistingMessageRepresentationAuthorRoleV1;
    const humanTurnPresence = reader.readU32();
    if (humanTurnPresence !== 0 && humanTurnPresence !== 1) {
      throw new CanonicalDecodingError(
        "Existing Message Human-turn presence is invalid",
      );
    }
    const authorHumanTurnId = humanTurnPresence === 0
      ? null
      : reader.readText(V2_LIMITS.idBytes);
    const sessionAgentPresence = reader.readU32();
    if (sessionAgentPresence !== 0 && sessionAgentPresence !== 1) {
      throw new CanonicalDecodingError(
        "Existing Message Session Agent presence is invalid",
      );
    }
    const sessionAgentId = sessionAgentPresence === 0
      ? null
      : agentId(reader.readText(V2_LIMITS.idBytes));
    return {
      formatVersion,
      purpose,
      subjectHumanId,
      operationId,
      sessionId,
      roomId,
      messageId,
      revision,
      createdAt,
      authorRole,
      authorHumanTurnId,
      sessionAgentId,
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceBindingHash: reader.readFrame(HASH_BYTES),
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      bindingRevisionAtWrap: reader.readU64(),
      ciphertextPayloadHash: reader.readFrame(HASH_BYTES),
      plaintextPayloadHash: reader.readFrame(HASH_BYTES),
      accessManifestHash: reader.readFrame(HASH_BYTES),
      envelopeHash: reader.readFrame(HASH_BYTES),
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let normalized: HumanExistingMessageRepresentationPublicationRequestV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeRequest(raw);
    canonical = encodeHumanExistingMessageRepresentationPublicationRequestV1(normalized);
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError("Human existing Message representation request is noncanonical");
    }
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyRequest(raw);
    if (normalized) destroyRequest(normalized);
    canonical?.fill(0);
  }
}

export function prepareHumanExistingMessageRepresentationPublicationRequestV1(
  crypto: LatticeCrypto,
  input: PrepareHumanExistingMessageRepresentationPublicationRequestInputV1,
): CreatedHumanExistingMessageRepresentationPublicationRequestV1 {
  const {
    committerSigningPublicKey: rawPublicKey,
    committerSigningPrivateKey: rawPrivateKey,
    ...rest
  } = input;
  const unsigned = normalizeUnsigned({
    ...rest,
    formatVersion: HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_FORMAT_VERSION_V1,
    purpose: HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_PURPOSE_V1,
  });
  let publicKey: Uint8Array | undefined;
  let privateKey: Uint8Array | undefined;
  let message: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    publicKey = exactBytes(
      "Human Message signing public key", rawPublicKey,
      V2_LIMITS.signingPublicKeyBytes,
    );

    privateKey = exactBytes(
      "Human Message signing private key", rawPrivateKey,
      V2_LIMITS.signingPrivateKeyBytes,
    );
    message = signingBytes(unsigned);
    signature = exactBytes(
      "Human existing Message representation signature", crypto.sign(privateKey, message),
      V2_LIMITS.signatureBytes,
    );
    if (!crypto.verify(publicKey, message, signature)) {
      throw new TypeError("Human Message signing keys do not match");
    }
    const bytes = encodeHumanExistingMessageRepresentationPublicationRequestV1({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      request: decodeHumanExistingMessageRepresentationPublicationRequestV1(bytes),
      bytes,
    });
  } finally {
    destroyUnsigned(unsigned);
    publicKey?.fill(0); privateKey?.fill(0); message?.fill(0); signature?.fill(0);
  }
}

export function verifyHumanExistingMessageRepresentationPublicationRequestV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    requestBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority:
      ResolveCurrentHumanExistingMessageRepresentationPublicationAuthorityV1;
  }>,
): HumanExistingMessageRepresentationPublicationRequestV1 {
  const request = verifyHumanExistingMessageRepresentationPublicationSignature(
    crypto,
    input.requestBytes,
    input.resolveCurrentAuthority,
  );
  let verified = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < request.issuedAt || now >= request.deadlineAt) {
      throw new TypeError("Human existing Message representation request is not currently valid");
    }
    verified = true;
    return request;
  } finally {
    if (!verified) destroyRequest(request);
  }
}

function verifyHumanExistingMessageRepresentationPublicationSignature(
  crypto: LatticeCrypto,
  requestBytes: Uint8Array,
  resolveCurrentAuthority:
    ResolveCurrentHumanExistingMessageRepresentationPublicationAuthorityV1,
): HumanExistingMessageRepresentationPublicationRequestV1 {
  const request = decodeHumanExistingMessageRepresentationPublicationRequestV1(
    requestBytes,
  );
  let publicKey: Uint8Array | undefined;
  let message: Uint8Array | undefined;
  let verified = false;
  try {
    const resolved = resolveCurrentAuthority(Object.freeze({
      purpose: "human-existing-message-representation-publication-verify" as const,
      subjectHumanId: request.subjectHumanId,
      operationId: request.operationId,
      committerDeviceId: request.committerDeviceId,
      hostAuthorizationRevision: request.hostAuthorizationRevision,
    }));
    if (resolved === null) {
      throw new TypeError("Human existing Message representation publication authority is unavailable");
    }
    publicKey = exactBytes(
      "Human existing Message representation authority public key", resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    message = signingBytes(request);
    if (!crypto.verify(publicKey, message, request.signature)) {
      throw new TypeError("Human existing Message representation publication signature is invalid");
    }
    verified = true;
    return request;
  } finally {
    publicKey?.fill(0); message?.fill(0);
    if (!verified) destroyRequest(request);
  }
}

/**
 * Authenticates an already allocated request for exact durable replay only.
 * Unlike the live verifier this deliberately grants no freshness; callers must
 * additionally prove that the signed object/access bytes already exist.
 */
export function verifyHumanExistingMessageRepresentationPublicationRequestExactReplayV1(
  crypto: LatticeCrypto,
  input: VerifyHumanExistingMessageRepresentationPublicationExactReplayInputV1,
): HumanExistingMessageRepresentationPublicationRequestV1 {
  const expectedDigest = exactBytes(
    "Human Message durable request digest",
    input.expectedRequestDigest,
    HASH_BYTES,
  );
  let rawDigest: Uint8Array | undefined;
  let actualDigest: Uint8Array | undefined;
  try {
    rawDigest = crypto.hash(input.requestBytes);
    actualDigest = exactBytes(
      "Human Message computed request digest",
      rawDigest,
      HASH_BYTES,
    );
    if (!sameBytes(actualDigest, expectedDigest)) {
      throw new TypeError("Human Message durable digest disagrees");
    }
    return verifyHumanExistingMessageRepresentationPublicationSignature(
      crypto,
      input.requestBytes,
      input.resolveCurrentAuthority,
    );
  } finally {
    expectedDigest.fill(0);
    rawDigest?.fill(0);
    actualDigest?.fill(0);
  }
}
