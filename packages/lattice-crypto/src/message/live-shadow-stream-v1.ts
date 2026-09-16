import { bytesToHex } from "@noble/hashes/utils.js";

import {
  normalizeAgentRuntimeObjectSignerPrincipalV1,
  signAgentRuntimeObjectBytesV1,
  type AgentRuntimeObjectSignerPrincipalV1,
} from "../agent-runtime/object-signer-v1.ts";
import type { AgentRuntimeGenerationV2 } from "../agent-runtime/types.ts";
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
  agentRuntimeGeneration,
  assertPortableId,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type CryptoDomainId,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V1 = 1 as const;
export const AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1 =
  "message.live_shadow_agent_stream_start" as const;
export const AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V1 =
  "nautilo/lattice-crypto/agent-live-shadow-stream-start/v1";
export const AGENT_LIVE_SHADOW_STREAM_FRAME_FORMAT_VERSION_V1 = 1 as const;
export const AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1 =
  "message.live_shadow_agent_stream_frame" as const;
export const AGENT_LIVE_SHADOW_STREAM_FRAME_DOMAIN_V1 =
  "nautilo/lattice-crypto/agent-live-shadow-stream-frame/v1";
export const AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V1 =
  "nautilo/lattice-crypto/message-live-shadow-stream-key/v1";
export const AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V1 = 30_000;
export const AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1 = 64 * 1024;
export const AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1 = 1024 * 1024;
export const AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1 = 65_536;
export const MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V1 =
  V2_LIMITS.manifestEnvelopeBytes + 8 * 1024;
export const MAX_AGENT_LIVE_SHADOW_STREAM_FRAME_WIRE_BYTES_V1 = 160 * 1024;

const HASH_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AgentLiveShadowStreamStartUnsignedV1 {
  readonly formatVersion: typeof AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V1;
  readonly purpose: typeof AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly messageId: number;
  readonly revision: 0;
  readonly createdAt: UnixTimestamp;
  readonly cryptoObjectId: ObjectId;
  readonly authorAgentId: AgentId;
  readonly assistantMessageKey: string;
  readonly transcriptOrdinal: number;
  readonly streamId: string;
  readonly namespaceId: NamespaceId;
  readonly namespaceBindingHash: Uint8Array;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly bindingRevisionAtWrap: number;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: number;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly runtimeSigner: AgentRuntimeObjectSignerPrincipalV1;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly namespaceEnvelopeBytes: Uint8Array;
  readonly namespaceEnvelopeDigest: Uint8Array;
  readonly firstChunkSequence: 1;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface AgentLiveShadowStreamStartV1
  extends AgentLiveShadowStreamStartUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedAgentLiveShadowStreamStartV1 {
  readonly start: AgentLiveShadowStreamStartV1;
  readonly bytes: Uint8Array;
  readonly startDigest: Uint8Array;
}

export type ResolveAgentLiveShadowStreamSignerV1 = (
  context: Readonly<{
    purpose: "agent-live-shadow-stream-start-verify";
    operationId: string;
    authorAgentId: AgentId;
    runtimeGeneration: AgentRuntimeGeneration;
    signerKeyId: string;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

export interface AgentLiveShadowStreamFrameV1 {
  readonly formatVersion: typeof AGENT_LIVE_SHADOW_STREAM_FRAME_FORMAT_VERSION_V1;
  readonly purpose: typeof AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1;
  readonly streamStartDigest: Uint8Array;
  readonly streamId: string;
  readonly messageId: number;
  readonly revision: 0;
  readonly cryptoObjectId: ObjectId;
  readonly transcriptOrdinal: number;
  readonly chunkSequence: number;
  readonly done: boolean;
  readonly plaintextLength: number;
  readonly previousFrameHash: Uint8Array;
  readonly ordinaryChunk: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
  readonly totalChunkCount: number | null;
  readonly streamedTextDigest: Uint8Array | null;
  readonly finalPayloadDigest: Uint8Array | null;
}

export interface SealAgentLiveShadowStreamFrameInputV1 {
  readonly startBytes: Uint8Array;
  readonly objectDek: Uint8Array;
  readonly chunkSequence: number;
  readonly previousFrameHash: Uint8Array;
  readonly ordinaryChunk: Uint8Array;
  readonly done: boolean;
  readonly totalChunkCount?: number;
  readonly streamedTextDigest?: Uint8Array;
  readonly finalPayloadDigest?: Uint8Array;
  readonly reserveNonce: (nonce: Uint8Array) => boolean;
}

const START_UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "operationId", "policyRevision", "sessionId",
  "roomId", "messageId", "revision", "createdAt", "cryptoObjectId",
  "authorAgentId", "assistantMessageKey", "transcriptOrdinal", "streamId",
  "namespaceId", "namespaceBindingHash", "namespaceAccessRevision",
  "namespaceKeyGeneration", "bindingRevisionAtWrap", "domainId", "domainEpoch",
  "agentAuthorizationRevision", "runtimeSigner", "hostAuthorizationRevision",
  "namespaceEnvelopeBytes", "namespaceEnvelopeDigest", "firstChunkSequence",
  "issuedAt", "deadlineAt",
] as const);
const START_FIELDS = Object.freeze([...START_UNSIGNED_FIELDS, "signature"]);
const FRAME_FIELDS = Object.freeze([
  "formatVersion", "purpose", "streamStartDigest", "streamId", "messageId",
  "revision", "cryptoObjectId", "transcriptOrdinal", "chunkSequence", "done",
  "plaintextLength", "previousFrameHash", "ordinaryChunk", "nonce",
  "ciphertext", "tag", "totalChunkCount", "streamedTextDigest",
  "finalPayloadDigest",
] as const);

function exactFields(label: string, value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((fieldName, index) => fieldName !== expected[index])) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(label: string, value: unknown, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function boundedBytes(label: string, value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length > maximum) {
    throw new TypeError(`${label} must be at most ${maximum} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function counter(label: string, value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as number;
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID`);
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function validWindow(issuedAt: UnixTimestamp, deadlineAt: UnixTimestamp): void {
  if (deadlineAt <= issuedAt || deadlineAt - issuedAt > AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V1) {
    throw new RangeError("Agent live Shadow stream lifetime is invalid");
  }
}

function normalizeStartUnsigned(value: AgentLiveShadowStreamStartUnsignedV1): AgentLiveShadowStreamStartUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent live Shadow stream start must be an object");
  }
  exactFields("Agent live Shadow stream start", value, START_UNSIGNED_FIELDS);
  if (
    value.formatVersion !== 1
    || value.purpose !== AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1
    || value.revision !== 0
    || value.firstChunkSequence !== 1
  ) throw new TypeError("Agent live Shadow stream start version, purpose, or fixed coordinate is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  const envelopeBytes = boundedBytes("Agent live Shadow Namespace envelope", value.namespaceEnvelopeBytes, V2_LIMITS.manifestEnvelopeBytes);
  const envelopeDigest = exactBytes("Agent live Shadow Namespace envelope digest", value.namespaceEnvelopeDigest, HASH_BYTES);
  return Object.freeze({
    formatVersion: 1,
    purpose: AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1,
    operationId: portable("Agent live Shadow operation ID", value.operationId),
    policyRevision: counter("Agent live Shadow policy revision", value.policyRevision, 1),
    sessionId: uuid("Agent live Shadow Session ID", value.sessionId),
    roomId: uuid("Agent live Shadow Room ID", value.roomId),
    messageId: counter("Agent live Shadow Message ID", value.messageId, 1, 2_147_483_647),
    revision: 0,
    createdAt: unixTimestamp(value.createdAt),
    cryptoObjectId: objectId(value.cryptoObjectId),
    authorAgentId: agentId(value.authorAgentId),
    assistantMessageKey: portable("Agent live Shadow assistant Message key", value.assistantMessageKey),
    transcriptOrdinal: counter("Agent live Shadow transcript ordinal", value.transcriptOrdinal, 1),
    streamId: portable("Agent live Shadow stream ID", value.streamId),
    namespaceId: namespaceId(value.namespaceId),
    namespaceBindingHash: exactBytes("Agent live Shadow Namespace binding hash", value.namespaceBindingHash, HASH_BYTES),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    bindingRevisionAtWrap: accessRevision(value.bindingRevisionAtWrap),
    domainId: cryptoDomainId(value.domainId),
    domainEpoch: domainEpoch(value.domainEpoch),
    agentAuthorizationRevision: authorizationRevision(value.agentAuthorizationRevision),
    runtimeSigner: normalizeAgentRuntimeObjectSignerPrincipalV1(value.runtimeSigner),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    namespaceEnvelopeBytes: envelopeBytes,
    namespaceEnvelopeDigest: envelopeDigest,
    firstChunkSequence: 1,
    issuedAt,
    deadlineAt,
  });
}

function destroyStart(value: AgentLiveShadowStreamStartUnsignedV1 | AgentLiveShadowStreamStartV1): void {
  value.namespaceBindingHash.fill(0);
  value.namespaceEnvelopeBytes.fill(0);
  value.namespaceEnvelopeDigest.fill(0);
  if ("signature" in value) value.signature.fill(0);
}

function startUnsignedBytes(value: AgentLiveShadowStreamStartUnsignedV1): Uint8Array {
  return concatV2(
    frameText(AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V1), encodeU32(value.formatVersion),
    frameText(value.purpose), frameText(value.operationId), encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId), encodeU64(value.messageId),
    encodeU64(value.revision), encodeU64(value.createdAt), frameText(value.cryptoObjectId),
    frameText(value.authorAgentId), frameText(value.assistantMessageKey),
    encodeU64(value.transcriptOrdinal), frameText(value.streamId),
    frameText(value.namespaceId), frame(value.namespaceBindingHash),
    encodeU64(value.namespaceAccessRevision), encodeU64(value.namespaceKeyGeneration),
    encodeU64(value.bindingRevisionAtWrap), frameText(value.domainId),
    encodeU64(value.domainEpoch), encodeU64(value.agentAuthorizationRevision),
    frameText(value.runtimeSigner.kind), frameText(value.runtimeSigner.agentId),
    encodeU64(value.runtimeSigner.runtimeGeneration), frameText(value.runtimeSigner.signerKeyId),
    encodeU64(value.hostAuthorizationRevision), frame(value.namespaceEnvelopeBytes),
    frame(value.namespaceEnvelopeDigest), encodeU64(value.firstChunkSequence),
    encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
  );
}

export function agentLiveShadowStreamStartSigningBytesV1(
  value: AgentLiveShadowStreamStartUnsignedV1,
): Uint8Array {
  const normalized = normalizeStartUnsigned(value);
  try {
    return startUnsignedBytes(normalized);
  } finally {
    destroyStart(normalized);
  }
}

export function encodeAgentLiveShadowStreamStartV1(value: AgentLiveShadowStreamStartV1): Uint8Array {
  if (typeof value !== "object" || value === null) throw new TypeError("Agent live Shadow stream start must be an object");
  exactFields("Agent live Shadow stream start", value, START_FIELDS);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeStartUnsigned(rawUnsigned);
  const signature = exactBytes("Agent live Shadow stream start signature", rawSignature, V2_LIMITS.signatureBytes);
  try {
    const bytes = concatV2(startUnsignedBytes(unsigned), frame(signature));
    if (bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Agent live Shadow stream start exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyStart(unsigned);
    signature.fill(0);
  }
}

export function decodeAgentLiveShadowStreamStartV1(bytes: Uint8Array): AgentLiveShadowStreamStartV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V1) {
    throw new TypeError("Agent live Shadow stream start bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): AgentLiveShadowStreamStartV1 => {
    if (reader.readText(utf8V2(AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V1).length) !== AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V1) {
      throw new CanonicalDecodingError("Agent live Shadow stream start domain mismatch");
    }
    return {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(96) as typeof AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1,
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(), sessionId: reader.readText(36), roomId: reader.readText(36),
      messageId: reader.readU64(), revision: reader.readU64() as 0,
      createdAt: unixTimestamp(reader.readU64()),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      authorAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      assistantMessageKey: reader.readText(V2_LIMITS.idBytes), transcriptOrdinal: reader.readU64(),
      streamId: reader.readText(V2_LIMITS.idBytes), namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceBindingHash: reader.readFrame(HASH_BYTES), namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(), bindingRevisionAtWrap: reader.readU64(),
      domainId: cryptoDomainId(reader.readText(V2_LIMITS.idBytes)), domainEpoch: reader.readU64(),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      runtimeSigner: {
        kind: reader.readText(32) as "agent_runtime",
        agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
        runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
        signerKeyId: reader.readText(V2_LIMITS.idBytes),
      },
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      namespaceEnvelopeBytes: reader.readFrame(V2_LIMITS.manifestEnvelopeBytes),
      namespaceEnvelopeDigest: reader.readFrame(HASH_BYTES), firstChunkSequence: reader.readU64() as 1,
      issuedAt: unixTimestamp(reader.readU64()), deadlineAt: unixTimestamp(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    } as AgentLiveShadowStreamStartV1;
  });
  let unsigned: AgentLiveShadowStreamStartUnsignedV1 | undefined;
  let signature: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  try {
    const { signature: rawSignature, ...rawUnsigned } = raw;
    unsigned = normalizeStartUnsigned(rawUnsigned);
    signature = exactBytes("Agent live Shadow stream start signature", rawSignature, V2_LIMITS.signatureBytes);
    canonical = concatV2(startUnsignedBytes(unsigned), frame(signature));
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Agent live Shadow stream start is noncanonical");
    const result = Object.freeze({ ...unsigned, signature: copyOwnedBytesV2(signature) });
    unsigned = undefined;
    return result;
  } finally {
    destroyStart(raw);
    if (unsigned) destroyStart(unsigned);
    signature?.fill(0);
    canonical?.fill(0);
  }
}

export function prepareAgentLiveShadowStreamStartV1(
  crypto: LatticeCrypto,
  input: Omit<AgentLiveShadowStreamStartUnsignedV1, "formatVersion" | "purpose" | "runtimeSigner"> & Readonly<{
    runtime: AgentRuntimeGenerationV2;
    runtimeSigner: AgentRuntimeObjectSignerPrincipalV1;
  }>,
): CreatedAgentLiveShadowStreamStartV1 {
  const { runtime, runtimeSigner, ...rest } = input;
  const unsigned = normalizeStartUnsigned({ ...rest, runtimeSigner, formatVersion: 1, purpose: AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V1 });
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signing = startUnsignedBytes(unsigned);
    signature = signAgentRuntimeObjectBytesV1(crypto, { runtime, signer: unsigned.runtimeSigner, message: signing });
    const bytes = encodeAgentLiveShadowStreamStartV1({ ...unsigned, signature });
    return Object.freeze({ start: decodeAgentLiveShadowStreamStartV1(bytes), bytes, startDigest: crypto.hash(bytes) });
  } finally {
    destroyStart(unsigned);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export function verifyAgentLiveShadowStreamStartV1(
  crypto: LatticeCrypto,
  input: Readonly<{ startBytes: Uint8Array; now: UnixTimestamp; resolveSigner: ResolveAgentLiveShadowStreamSignerV1 }>,
): AgentLiveShadowStreamStartV1 {
  const start = decodeAgentLiveShadowStreamStartV1(input.startBytes);
  let publicKey: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let envelopeDigest: Uint8Array | undefined;
  let ok = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < start.issuedAt || now >= start.deadlineAt) throw new TypeError("Agent live Shadow stream start is not currently valid");
    if (start.runtimeSigner.agentId !== start.authorAgentId) throw new TypeError("Agent live Shadow stream signer Agent disagrees");
    envelopeDigest = crypto.hash(start.namespaceEnvelopeBytes);
    if (!sameBytes(envelopeDigest, start.namespaceEnvelopeDigest)) throw new TypeError("Agent live Shadow Namespace envelope digest disagrees");
    const resolved = input.resolveSigner(Object.freeze({
      purpose: "agent-live-shadow-stream-start-verify" as const,
      operationId: start.operationId,
      authorAgentId: start.authorAgentId,
      runtimeGeneration: start.runtimeSigner.runtimeGeneration,
      signerKeyId: start.runtimeSigner.signerKeyId,
      hostAuthorizationRevision: start.hostAuthorizationRevision,
    }));
    if (resolved === null) throw new TypeError("Agent live Shadow stream signer is unavailable");
    publicKey = exactBytes("Agent live Shadow stream signer public key", resolved, V2_LIMITS.signingPublicKeyBytes);
    signing = startUnsignedBytes(start);
    if (!crypto.verify(publicKey, signing, start.signature)) throw new TypeError("Agent live Shadow stream start signature is invalid");
    ok = true;
    return start;
  } finally {
    publicKey?.fill(0); signing?.fill(0); envelopeDigest?.fill(0);
    if (!ok) destroyStart(start);
  }
}

function normalizeFrame(value: AgentLiveShadowStreamFrameV1): AgentLiveShadowStreamFrameV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Agent live Shadow stream frame must be an object");
  exactFields("Agent live Shadow stream frame", value, FRAME_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1 || value.revision !== 0) {
    throw new TypeError("Agent live Shadow stream frame version, purpose, or revision is invalid");
  }
  const ordinaryChunk = boundedBytes("Agent live Shadow ordinary chunk", value.ordinaryChunk, AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1);
  const ciphertext = boundedBytes("Agent live Shadow ciphertext", value.ciphertext, AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1);
  const plaintextLength = counter("Agent live Shadow plaintext length", value.plaintextLength, 0, AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1);
  if (ordinaryChunk.length !== plaintextLength || ciphertext.length !== plaintextLength) throw new TypeError("Agent live Shadow frame lengths disagree");
  const terminalComplete = value.totalChunkCount !== null
    && value.streamedTextDigest !== null
    && value.finalPayloadDigest !== null;
  const terminalEmpty = value.totalChunkCount === null
    && value.streamedTextDigest === null
    && value.finalPayloadDigest === null;
  if ((value.done && !terminalComplete) || (!value.done && !terminalEmpty)) {
    throw new TypeError("Agent live Shadow terminal fields are incoherent");
  }
  return Object.freeze({
    formatVersion: 1,
    purpose: AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1,
    streamStartDigest: exactBytes("Agent live Shadow stream start digest", value.streamStartDigest, HASH_BYTES),
    streamId: portable("Agent live Shadow stream ID", value.streamId),
    messageId: counter("Agent live Shadow Message ID", value.messageId, 1, 2_147_483_647),
    revision: 0,
    cryptoObjectId: objectId(value.cryptoObjectId),
    transcriptOrdinal: counter("Agent live Shadow transcript ordinal", value.transcriptOrdinal, 1),
    chunkSequence: counter("Agent live Shadow chunk sequence", value.chunkSequence, 1, AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1),
    done: value.done,
    plaintextLength,
    previousFrameHash: exactBytes("Agent live Shadow previous frame hash", value.previousFrameHash, HASH_BYTES),
    ordinaryChunk,
    nonce: exactBytes("Agent live Shadow nonce", value.nonce, NONCE_BYTES),
    ciphertext,
    tag: exactBytes("Agent live Shadow tag", value.tag, TAG_BYTES),
    totalChunkCount: value.totalChunkCount === null ? null : counter("Agent live Shadow total chunk count", value.totalChunkCount, 1, AGENT_LIVE_SHADOW_STREAM_MAX_FRAMES_V1),
    streamedTextDigest: value.streamedTextDigest === null ? null : exactBytes("Agent live Shadow streamed text digest", value.streamedTextDigest, HASH_BYTES),
    finalPayloadDigest: value.finalPayloadDigest === null ? null : exactBytes("Agent live Shadow final payload digest", value.finalPayloadDigest, HASH_BYTES),
  });
}

function destroyFrame(value: AgentLiveShadowStreamFrameV1): void {
  value.streamStartDigest.fill(0); value.previousFrameHash.fill(0); value.ordinaryChunk.fill(0);
  value.nonce.fill(0); value.ciphertext.fill(0); value.tag.fill(0);
  value.streamedTextDigest?.fill(0); value.finalPayloadDigest?.fill(0);
}

function frameAadBytes(value: AgentLiveShadowStreamFrameV1): Uint8Array {
  return concatV2(
    frameText(AGENT_LIVE_SHADOW_STREAM_FRAME_DOMAIN_V1), encodeU32(value.formatVersion),
    frameText(value.purpose), frame(value.streamStartDigest), frameText(value.streamId),
    encodeU64(value.messageId), encodeU64(value.revision), frameText(value.cryptoObjectId),
    encodeU64(value.transcriptOrdinal), encodeU64(value.chunkSequence), encodeU32(value.done ? 1 : 0),
    encodeU64(value.plaintextLength), frame(value.previousFrameHash),
    encodeU64(value.totalChunkCount ?? 0),
    frame(value.streamedTextDigest ?? new Uint8Array(0)),
    frame(value.finalPayloadDigest ?? new Uint8Array(0)),
  );
}

function frameBytes(value: AgentLiveShadowStreamFrameV1): Uint8Array {
  return concatV2(frameAadBytes(value), frame(value.ordinaryChunk), frame(value.nonce), frame(value.ciphertext), frame(value.tag));
}

export function encodeAgentLiveShadowStreamFrameV1(value: AgentLiveShadowStreamFrameV1): Uint8Array {
  const normalized = normalizeFrame(value);
  try {
    const bytes = frameBytes(normalized);
    if (bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_FRAME_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Agent live Shadow stream frame exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroyFrame(normalized);
  }
}

export function decodeAgentLiveShadowStreamFrameV1(bytes: Uint8Array): AgentLiveShadowStreamFrameV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_FRAME_WIRE_BYTES_V1) throw new TypeError("Agent live Shadow stream frame bytes are invalid");
  const raw = decodeExact(bytes, (reader): AgentLiveShadowStreamFrameV1 => {
    if (reader.readText(utf8V2(AGENT_LIVE_SHADOW_STREAM_FRAME_DOMAIN_V1).length) !== AGENT_LIVE_SHADOW_STREAM_FRAME_DOMAIN_V1) throw new CanonicalDecodingError("Agent live Shadow stream frame domain mismatch");
    const result = {
      formatVersion: reader.readVersion(1) as 1,
      purpose: reader.readText(96) as typeof AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1,
      streamStartDigest: reader.readFrame(HASH_BYTES), streamId: reader.readText(V2_LIMITS.idBytes),
      messageId: reader.readU64(), revision: reader.readU64() as 0,
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)), transcriptOrdinal: reader.readU64(),
      chunkSequence: reader.readU64(), done: reader.readU32() === 1,
      plaintextLength: reader.readU64(), previousFrameHash: reader.readFrame(HASH_BYTES),
      totalChunkCount: reader.readU64(), streamedTextDigest: reader.readFrame(HASH_BYTES),
      finalPayloadDigest: reader.readFrame(HASH_BYTES), ordinaryChunk: reader.readFrame(AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1),
      nonce: reader.readFrame(NONCE_BYTES), ciphertext: reader.readFrame(AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1),
      tag: reader.readFrame(TAG_BYTES),
    };
    return {
      ...result,
      totalChunkCount: result.totalChunkCount === 0 ? null : result.totalChunkCount,
      streamedTextDigest: result.streamedTextDigest.length === 0 ? null : result.streamedTextDigest,
      finalPayloadDigest: result.finalPayloadDigest.length === 0 ? null : result.finalPayloadDigest,
    } as AgentLiveShadowStreamFrameV1;
  });
  let normalized: AgentLiveShadowStreamFrameV1 | undefined;
  let canonical: Uint8Array | undefined;
  try {
    normalized = normalizeFrame(raw);
    canonical = frameBytes(normalized);
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Agent live Shadow stream frame is noncanonical");
    const result = normalized;
    normalized = undefined;
    return result;
  } finally {
    destroyFrame(raw);
    if (normalized) destroyFrame(normalized);
    canonical?.fill(0);
  }
}

export interface LiveShadowStreamFrameStartContext {
  readonly streamId: string;
  readonly messageId: number;
  readonly revision: 0;
  readonly cryptoObjectId: ObjectId;
  readonly transcriptOrdinal: number;
}

export interface LiveShadowStreamFrameStartCodec<
  Start extends LiveShadowStreamFrameStartContext,
> {
  readonly keyDomain: string;
  readonly decode: (bytes: Uint8Array) => Start;
  readonly destroy: (start: Start) => void;
  readonly identityBytes: (start: Start) => Uint8Array;
}

function withStreamKey<
  Start extends LiveShadowStreamFrameStartContext,
  Value,
>(
  crypto: LatticeCrypto,
  objectDek: Uint8Array,
  start: Start,
  codec: LiveShadowStreamFrameStartCodec<Start>,
  execute: (key: Uint8Array) => Value,
): Value {
  const ownedDek = exactBytes("Agent live Shadow object DEK", objectDek, 32);
  let identity: Uint8Array | undefined;
  let digest: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    identity = codec.identityBytes(start);
    digest = crypto.hash(identity);
    key = crypto.deriveKey(
      ownedDek,
      `${codec.keyDomain}:${bytesToHex(digest)}`,
      32,
    );
    return execute(key);
  } finally {
    ownedDek.fill(0); identity?.fill(0); digest?.fill(0); key?.fill(0);
  }
}

export function sealAgentLiveShadowStreamFrameForStart<
  Start extends LiveShadowStreamFrameStartContext,
>(
  crypto: LatticeCrypto,
  input: SealAgentLiveShadowStreamFrameInputV1,
  codec: LiveShadowStreamFrameStartCodec<Start>,
): Readonly<{ frame: AgentLiveShadowStreamFrameV1; bytes: Uint8Array; frameHash: Uint8Array }> {
  const start = codec.decode(input.startBytes);
  const ordinary = boundedBytes("Agent live Shadow ordinary chunk", input.ordinaryChunk, AGENT_LIVE_SHADOW_STREAM_MAX_FRAME_PLAINTEXT_BYTES_V1);
  const startDigest = crypto.hash(input.startBytes);
  const empty = new Uint8Array(0);
  const template = normalizeFrame({
    formatVersion: 1, purpose: AGENT_LIVE_SHADOW_STREAM_FRAME_PURPOSE_V1,
    streamStartDigest: startDigest, streamId: start.streamId, messageId: start.messageId,
    revision: 0, cryptoObjectId: start.cryptoObjectId, transcriptOrdinal: start.transcriptOrdinal,
    chunkSequence: input.chunkSequence, done: input.done, plaintextLength: ordinary.length,
    previousFrameHash: input.previousFrameHash, ordinaryChunk: ordinary,
    nonce: new Uint8Array(NONCE_BYTES), ciphertext: new Uint8Array(ordinary.length), tag: new Uint8Array(TAG_BYTES),
    totalChunkCount: input.done ? input.totalChunkCount ?? input.chunkSequence : null,
    streamedTextDigest: input.done ? input.streamedTextDigest ?? null : null,
    finalPayloadDigest: input.done ? input.finalPayloadDigest ?? null : null,
  });
  let aad: Uint8Array | undefined;
  let sealed: Uint8Array | undefined;
  try {
    if (template.done && template.totalChunkCount !== template.chunkSequence) throw new TypeError("Agent live Shadow terminal frame count disagrees");
    aad = frameAadBytes(template);
    const result = withStreamKey(crypto, input.objectDek, start, codec, (key) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        sealed = crypto.aeadSeal(key, ordinary, aad);
        const nonce = sealed.slice(0, NONCE_BYTES);
        if (!input.reserveNonce(copyOwnedBytesV2(nonce))) {
          nonce.fill(0); sealed.fill(0); sealed = undefined;
          continue;
        }
        const body = sealed.slice(NONCE_BYTES);
        const tag = body.slice(body.length - TAG_BYTES);
        const ciphertext = body.slice(0, body.length - TAG_BYTES);
        body.fill(0);
        try {
          const bytes = encodeAgentLiveShadowStreamFrameV1({ ...template, nonce, ciphertext, tag });
          return Object.freeze({ frame: decodeAgentLiveShadowStreamFrameV1(bytes), bytes, frameHash: crypto.hash(bytes) });
        } finally {
          nonce.fill(0); ciphertext.fill(0); tag.fill(0);
        }
      }
      throw new TypeError("Agent live Shadow stream nonce collision limit exceeded");
    });
    return result;
  } finally {
    codec.destroy(start); destroyFrame(template); ordinary.fill(0); startDigest.fill(0); empty.fill(0);
    aad?.fill(0); sealed?.fill(0);
  }
}

export function openAgentLiveShadowStreamFrameForStart<
  Start extends LiveShadowStreamFrameStartContext,
>(
  crypto: LatticeCrypto,
  input: Readonly<{
    startBytes: Uint8Array;
    frameBytes: Uint8Array;
    objectDek: Uint8Array;
    expectedSequence: number;
    expectedPreviousFrameHash: Uint8Array;
    accumulatedPlaintextBytes: number;
  }>,
  codec: LiveShadowStreamFrameStartCodec<Start>,
): Readonly<{ frame: AgentLiveShadowStreamFrameV1; plaintext: Uint8Array; frameHash: Uint8Array; accumulatedPlaintextBytes: number }> {
  const start = codec.decode(input.startBytes);
  const value = decodeAgentLiveShadowStreamFrameV1(input.frameBytes);
  const expectedStartDigest = crypto.hash(input.startBytes);
  const expectedPrevious = exactBytes("Expected previous live Shadow frame hash", input.expectedPreviousFrameHash, HASH_BYTES);
  let aad: Uint8Array | undefined;
  let blob: Uint8Array | undefined;
  let plaintext: Uint8Array | null = null;
  let ok = false;
  try {
    if (
      !sameBytes(value.streamStartDigest, expectedStartDigest)
      || value.streamId !== start.streamId || value.messageId !== start.messageId
      || value.cryptoObjectId !== start.cryptoObjectId || value.transcriptOrdinal !== start.transcriptOrdinal
      || value.chunkSequence !== input.expectedSequence
      || !sameBytes(value.previousFrameHash, expectedPrevious)
    ) throw new TypeError("Agent live Shadow stream frame coordinates disagree");
    const accumulated = counter("Accumulated live Shadow plaintext bytes", input.accumulatedPlaintextBytes)
      + value.plaintextLength;
    if (accumulated > AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1) throw new RangeError("Agent live Shadow stream exceeds its plaintext limit");
    aad = frameAadBytes(value);
    blob = concatV2(value.nonce, value.ciphertext, value.tag);
    plaintext = withStreamKey(
      crypto,
      input.objectDek,
      start,
      codec,
      (key) => crypto.aeadOpen(key, blob!, aad),
    );
    if (plaintext === null || !sameBytes(plaintext, value.ordinaryChunk)) throw new TypeError("Agent live Shadow stream plaintext parity failed");
    ok = true;
    return Object.freeze({ frame: value, plaintext, frameHash: crypto.hash(input.frameBytes), accumulatedPlaintextBytes: accumulated });
  } finally {
    codec.destroy(start); expectedStartDigest.fill(0); expectedPrevious.fill(0); aad?.fill(0); blob?.fill(0);
    if (!ok) { plaintext?.fill(0); destroyFrame(value); }
  }
}

const STREAM_START_V1_CODEC: LiveShadowStreamFrameStartCodec<
  AgentLiveShadowStreamStartV1
> = Object.freeze({
  keyDomain: AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V1,
  decode: decodeAgentLiveShadowStreamStartV1,
  destroy: destroyStart,
  identityBytes: startUnsignedBytes,
});

export function sealAgentLiveShadowStreamFrameV1(
  crypto: LatticeCrypto,
  input: SealAgentLiveShadowStreamFrameInputV1,
): Readonly<{
  frame: AgentLiveShadowStreamFrameV1;
  bytes: Uint8Array;
  frameHash: Uint8Array;
}> {
  return sealAgentLiveShadowStreamFrameForStart(
    crypto,
    input,
    STREAM_START_V1_CODEC,
  );
}

export function openAgentLiveShadowStreamFrameV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    startBytes: Uint8Array;
    frameBytes: Uint8Array;
    objectDek: Uint8Array;
    expectedSequence: number;
    expectedPreviousFrameHash: Uint8Array;
    accumulatedPlaintextBytes: number;
  }>,
): Readonly<{
  frame: AgentLiveShadowStreamFrameV1;
  plaintext: Uint8Array;
  frameHash: Uint8Array;
  accumulatedPlaintextBytes: number;
}> {
  return openAgentLiveShadowStreamFrameForStart(
    crypto,
    input,
    STREAM_START_V1_CODEC,
  );
}

export function verifyAgentLiveShadowStreamTerminalV1(
  crypto: LatticeCrypto,
  input: Readonly<{ terminalFrameBytes: Uint8Array; orderedPlaintext: Uint8Array; expectedFinalPayloadDigest: Uint8Array }>,
): AgentLiveShadowStreamFrameV1 {
  const frameValue = decodeAgentLiveShadowStreamFrameV1(input.terminalFrameBytes);
  const plaintext = boundedBytes("Complete live Shadow streamed text", input.orderedPlaintext, AGENT_LIVE_SHADOW_STREAM_MAX_PLAINTEXT_BYTES_V1);
  const expectedFinal = exactBytes("Expected live Shadow final payload digest", input.expectedFinalPayloadDigest, HASH_BYTES);
  const digest = crypto.hash(plaintext);
  let ok = false;
  try {
    if (!frameValue.done || frameValue.totalChunkCount !== frameValue.chunkSequence) throw new TypeError("Agent live Shadow terminal frame is incomplete");
    if (frameValue.streamedTextDigest === null || !sameBytes(frameValue.streamedTextDigest, digest)) throw new TypeError("Agent live Shadow streamed text digest disagrees");
    if (frameValue.finalPayloadDigest === null || !sameBytes(frameValue.finalPayloadDigest, expectedFinal)) throw new TypeError("Agent live Shadow final payload digest disagrees");
    ok = true;
    return frameValue;
  } finally {
    plaintext.fill(0); expectedFinal.fill(0); digest.fill(0);
    if (!ok) destroyFrame(frameValue);
  }
}
