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
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  type AgentId,
  type AgentRuntimeGeneration,
  type AuthorizationRevision,
  type NamespaceId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  openAgentLiveShadowStreamFrameForStart,
  sealAgentLiveShadowStreamFrameForStart,
  type AgentLiveShadowStreamFrameV1,
  type LiveShadowStreamFrameStartCodec,
  type SealAgentLiveShadowStreamFrameInputV1,
} from "./live-shadow-stream-v1.ts";

export const AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V2 = 2 as const;
export const AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2 =
  "message.live_shadow_agent_stream_start" as const;
export const AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V2 =
  "nautilo/lattice-crypto/agent-live-shadow-stream-start/v2";
export const AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V2 =
  "nautilo/lattice-crypto/message-live-shadow-stream-key/v2";
export const AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V2 = 30_000;
export const MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V2 =
  V2_LIMITS.manifestEnvelopeBytes + 8 * 1024;

const HASH_BYTES = 32;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AgentLiveShadowStreamStartUnsignedV2 {
  readonly formatVersion: typeof AGENT_LIVE_SHADOW_STREAM_START_FORMAT_VERSION_V2;
  readonly purpose: typeof AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2;
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
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly namespaceHeadDigest: Uint8Array;
  readonly namespacePublicationDigest: Uint8Array;
  readonly namespacePublicationSetDigest: Uint8Array;
  readonly namespaceAudienceFingerprint: Uint8Array;
  readonly agentAuthorizationRevision: AuthorizationRevision;
  readonly runtimeSigner: AgentRuntimeObjectSignerPrincipalV1;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly namespaceEnvelopeBytes: Uint8Array;
  readonly namespaceEnvelopeDigest: Uint8Array;
  readonly firstChunkSequence: 1;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface AgentLiveShadowStreamStartV2
  extends AgentLiveShadowStreamStartUnsignedV2 {
  readonly signature: Uint8Array;
}

export interface CreatedAgentLiveShadowStreamStartV2 {
  readonly start: AgentLiveShadowStreamStartV2;
  readonly bytes: Uint8Array;
  readonly startDigest: Uint8Array;
}

export type ResolveAgentLiveShadowStreamSignerV2 = (
  context: Readonly<{
    purpose: "agent-live-shadow-stream-start-v2-verify";
    operationId: string;
    authorAgentId: AgentId;
    runtimeGeneration: AgentRuntimeGeneration;
    signerKeyId: string;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const START_UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "operationId", "policyRevision", "sessionId",
  "roomId", "messageId", "revision", "createdAt", "cryptoObjectId",
  "authorAgentId", "assistantMessageKey", "transcriptOrdinal", "streamId",
  "namespaceId", "namespaceAccessRevision", "namespaceKeyGeneration",
  "namespaceHeadDigest", "namespacePublicationDigest",
  "namespacePublicationSetDigest", "namespaceAudienceFingerprint",
  "agentAuthorizationRevision", "runtimeSigner", "hostAuthorizationRevision",
  "namespaceEnvelopeBytes", "namespaceEnvelopeDigest", "firstChunkSequence",
  "issuedAt", "deadlineAt",
] as const);
const START_FIELDS = Object.freeze([...START_UNSIGNED_FIELDS, "signature"]);

function exactFields(label: string, value: object, fields: readonly string[]) {
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

function boundedBytes(
  label: string,
  value: unknown,
  maximum: number,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length > maximum) {
    throw new TypeError(`${label} must be at most ${maximum} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function counter(
  label: string,
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new RangeError(`${label} is invalid`);
  return value as number;
}

function portable(label: string, value: unknown): string {
  assertPortableId(label, value);
  return value;
}

function uuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function validWindow(issuedAt: UnixTimestamp, deadlineAt: UnixTimestamp): void {
  if (
    deadlineAt <= issuedAt
    || deadlineAt - issuedAt > AGENT_LIVE_SHADOW_STREAM_MAX_TTL_MS_V2
  ) throw new RangeError("Agent live Shadow V2 stream lifetime is invalid");
}

function normalizeStartUnsigned(
  value: AgentLiveShadowStreamStartUnsignedV2,
): AgentLiveShadowStreamStartUnsignedV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent live Shadow V2 stream start must be an object");
  }
  exactFields("Agent live Shadow V2 stream start", value, START_UNSIGNED_FIELDS);
  if (
    value.formatVersion !== 2
    || value.purpose !== AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2
    || value.revision !== 0
    || value.firstChunkSequence !== 1
  ) throw new TypeError("Agent live Shadow V2 stream start shape is invalid");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  validWindow(issuedAt, deadlineAt);
  return Object.freeze({
    formatVersion: 2,
    purpose: AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2,
    operationId: portable("Agent live Shadow operation ID", value.operationId),
    policyRevision: counter(
      "Agent live Shadow policy revision",
      value.policyRevision,
      1,
    ),
    sessionId: uuid("Agent live Shadow Session ID", value.sessionId),
    roomId: uuid("Agent live Shadow Room ID", value.roomId),
    messageId: counter(
      "Agent live Shadow Message ID",
      value.messageId,
      1,
      2_147_483_647,
    ),
    revision: 0,
    createdAt: unixTimestamp(value.createdAt),
    cryptoObjectId: objectId(value.cryptoObjectId),
    authorAgentId: agentId(value.authorAgentId),
    assistantMessageKey: portable(
      "Agent live Shadow assistant Message key",
      value.assistantMessageKey,
    ),
    transcriptOrdinal: counter(
      "Agent live Shadow transcript ordinal",
      value.transcriptOrdinal,
      1,
    ),
    streamId: portable("Agent live Shadow stream ID", value.streamId),
    namespaceId: namespaceId(value.namespaceId),
    namespaceAccessRevision: accessRevision(value.namespaceAccessRevision),
    namespaceKeyGeneration: namespaceGeneration(value.namespaceKeyGeneration),
    namespaceHeadDigest: exactBytes(
      "Agent live Shadow Namespace head digest",
      value.namespaceHeadDigest,
      HASH_BYTES,
    ),
    namespacePublicationDigest: exactBytes(
      "Agent live Shadow Namespace publication digest",
      value.namespacePublicationDigest,
      HASH_BYTES,
    ),
    namespacePublicationSetDigest: exactBytes(
      "Agent live Shadow Namespace publication-set digest",
      value.namespacePublicationSetDigest,
      HASH_BYTES,
    ),
    namespaceAudienceFingerprint: exactBytes(
      "Agent live Shadow Namespace audience fingerprint",
      value.namespaceAudienceFingerprint,
      HASH_BYTES,
    ),
    agentAuthorizationRevision: authorizationRevision(
      value.agentAuthorizationRevision,
    ),
    runtimeSigner: normalizeAgentRuntimeObjectSignerPrincipalV1(
      value.runtimeSigner,
    ),
    hostAuthorizationRevision: authorizationRevision(
      value.hostAuthorizationRevision,
    ),
    namespaceEnvelopeBytes: boundedBytes(
      "Agent live Shadow Namespace envelope",
      value.namespaceEnvelopeBytes,
      V2_LIMITS.manifestEnvelopeBytes,
    ),
    namespaceEnvelopeDigest: exactBytes(
      "Agent live Shadow Namespace envelope digest",
      value.namespaceEnvelopeDigest,
      HASH_BYTES,
    ),
    firstChunkSequence: 1,
    issuedAt,
    deadlineAt,
  });
}

function destroyStart(
  value: AgentLiveShadowStreamStartUnsignedV2 | AgentLiveShadowStreamStartV2,
): void {
  value.namespaceHeadDigest.fill(0);
  value.namespacePublicationDigest.fill(0);
  value.namespacePublicationSetDigest.fill(0);
  value.namespaceAudienceFingerprint.fill(0);
  value.namespaceEnvelopeBytes.fill(0);
  value.namespaceEnvelopeDigest.fill(0);
  if ("signature" in value) value.signature.fill(0);
}

function startUnsignedBytes(
  value: AgentLiveShadowStreamStartUnsignedV2,
): Uint8Array {
  return concatV2(
    frameText(AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V2),
    encodeU32(value.formatVersion), frameText(value.purpose),
    frameText(value.operationId), encodeU64(value.policyRevision),
    frameText(value.sessionId), frameText(value.roomId),
    encodeU64(value.messageId), encodeU64(value.revision),
    encodeU64(value.createdAt), frameText(value.cryptoObjectId),
    frameText(value.authorAgentId), frameText(value.assistantMessageKey),
    encodeU64(value.transcriptOrdinal), frameText(value.streamId),
    frameText(value.namespaceId), encodeU64(value.namespaceAccessRevision),
    encodeU64(value.namespaceKeyGeneration), frame(value.namespaceHeadDigest),
    frame(value.namespacePublicationDigest),
    frame(value.namespacePublicationSetDigest),
    frame(value.namespaceAudienceFingerprint),
    encodeU64(value.agentAuthorizationRevision),
    frameText(value.runtimeSigner.kind), frameText(value.runtimeSigner.agentId),
    encodeU64(value.runtimeSigner.runtimeGeneration),
    frameText(value.runtimeSigner.signerKeyId),
    encodeU64(value.hostAuthorizationRevision),
    frame(value.namespaceEnvelopeBytes), frame(value.namespaceEnvelopeDigest),
    encodeU64(value.firstChunkSequence), encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

export function agentLiveShadowStreamStartSigningBytesV2(
  value: AgentLiveShadowStreamStartUnsignedV2,
): Uint8Array {
  const normalized = normalizeStartUnsigned(value);
  try {
    return startUnsignedBytes(normalized);
  } finally {
    destroyStart(normalized);
  }
}

export function encodeAgentLiveShadowStreamStartV2(
  value: AgentLiveShadowStreamStartV2,
): Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent live Shadow V2 stream start must be an object");
  }
  exactFields("Agent live Shadow V2 stream start", value, START_FIELDS);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeStartUnsigned(rawUnsigned);
  const signature = exactBytes(
    "Agent live Shadow V2 stream start signature",
    rawSignature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(startUnsignedBytes(unsigned), frame(signature));
    if (bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V2) {
      bytes.fill(0);
      throw new RangeError(
        "Agent live Shadow V2 stream start exceeds its wire limit",
      );
    }
    return bytes;
  } finally {
    destroyStart(unsigned);
    signature.fill(0);
  }
}

export function decodeAgentLiveShadowStreamStartV2(
  bytes: Uint8Array,
): AgentLiveShadowStreamStartV2 {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length > MAX_AGENT_LIVE_SHADOW_STREAM_START_WIRE_BYTES_V2
  ) throw new TypeError("Agent live Shadow V2 stream start bytes are invalid");
  const raw = decodeExact(bytes, (reader): AgentLiveShadowStreamStartV2 => {
    if (
      reader.readText(utf8V2(AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V2).length)
      !== AGENT_LIVE_SHADOW_STREAM_START_DOMAIN_V2
    ) throw new CanonicalDecodingError(
      "Agent live Shadow V2 stream start domain mismatch",
    );
    return {
      formatVersion: reader.readVersion(2) as 2,
      purpose: reader.readText(96) as typeof AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2,
      operationId: reader.readText(V2_LIMITS.idBytes),
      policyRevision: reader.readU64(),
      sessionId: reader.readText(36),
      roomId: reader.readText(36),
      messageId: reader.readU64(),
      revision: reader.readU64() as 0,
      createdAt: unixTimestamp(reader.readU64()),
      cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      authorAgentId: agentId(reader.readText(V2_LIMITS.idBytes)),
      assistantMessageKey: reader.readText(V2_LIMITS.idBytes),
      transcriptOrdinal: reader.readU64(),
      streamId: reader.readText(V2_LIMITS.idBytes),
      namespaceId: namespaceId(reader.readText(V2_LIMITS.idBytes)),
      namespaceAccessRevision: reader.readU64(),
      namespaceKeyGeneration: reader.readU64(),
      namespaceHeadDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationDigest: reader.readFrame(HASH_BYTES),
      namespacePublicationSetDigest: reader.readFrame(HASH_BYTES),
      namespaceAudienceFingerprint: reader.readFrame(HASH_BYTES),
      agentAuthorizationRevision: authorizationRevision(reader.readU64()),
      runtimeSigner: {
        kind: reader.readText(32) as "agent_runtime",
        agentId: agentId(reader.readText(V2_LIMITS.idBytes)),
        runtimeGeneration: agentRuntimeGeneration(reader.readU64()),
        signerKeyId: reader.readText(V2_LIMITS.idBytes),
      },
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      namespaceEnvelopeBytes: reader.readFrame(V2_LIMITS.manifestEnvelopeBytes),
      namespaceEnvelopeDigest: reader.readFrame(HASH_BYTES),
      firstChunkSequence: reader.readU64() as 1,
      issuedAt: unixTimestamp(reader.readU64()),
      deadlineAt: unixTimestamp(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let unsigned: AgentLiveShadowStreamStartUnsignedV2 | undefined;
  let signature: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  try {
    const { signature: rawSignature, ...rawUnsigned } = raw;
    unsigned = normalizeStartUnsigned(rawUnsigned);
    signature = exactBytes(
      "Agent live Shadow V2 stream start signature",
      rawSignature,
      V2_LIMITS.signatureBytes,
    );
    canonical = concatV2(startUnsignedBytes(unsigned), frame(signature));
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Agent live Shadow V2 stream start is noncanonical",
      );
    }
    const result = Object.freeze({
      ...unsigned,
      signature: copyOwnedBytesV2(signature),
    });
    unsigned = undefined;
    return result;
  } finally {
    destroyStart(raw);
    if (unsigned) destroyStart(unsigned);
    signature?.fill(0);
    canonical?.fill(0);
  }
}

export function prepareAgentLiveShadowStreamStartV2(
  crypto: LatticeCrypto,
  input: Omit<
    AgentLiveShadowStreamStartUnsignedV2,
    "formatVersion" | "purpose" | "runtimeSigner"
  > & Readonly<{
    runtime: AgentRuntimeGenerationV2;
    runtimeSigner: AgentRuntimeObjectSignerPrincipalV1;
  }>,
): CreatedAgentLiveShadowStreamStartV2 {
  const { runtime, runtimeSigner, ...rest } = input;
  const unsigned = normalizeStartUnsigned({
    ...rest,
    runtimeSigner,
    formatVersion: 2,
    purpose: AGENT_LIVE_SHADOW_STREAM_START_PURPOSE_V2,
  });
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    signing = startUnsignedBytes(unsigned);
    signature = signAgentRuntimeObjectBytesV1(crypto, {
      runtime,
      signer: unsigned.runtimeSigner,
      message: signing,
    });
    const bytes = encodeAgentLiveShadowStreamStartV2({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      start: decodeAgentLiveShadowStreamStartV2(bytes),
      bytes,
      startDigest: crypto.hash(bytes),
    });
  } finally {
    destroyStart(unsigned);
    signing?.fill(0);
    signature?.fill(0);
  }
}

export function verifyAgentLiveShadowStreamStartV2(
  crypto: LatticeCrypto,
  input: Readonly<{
    startBytes: Uint8Array;
    now: UnixTimestamp;
    resolveSigner: ResolveAgentLiveShadowStreamSignerV2;
  }>,
): AgentLiveShadowStreamStartV2 {
  const start = decodeAgentLiveShadowStreamStartV2(input.startBytes);
  let publicKey: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let envelopeDigest: Uint8Array | undefined;
  let verified = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < start.issuedAt || now >= start.deadlineAt) {
      throw new TypeError(
        "Agent live Shadow V2 stream start is not currently valid",
      );
    }
    if (start.runtimeSigner.agentId !== start.authorAgentId) {
      throw new TypeError("Agent live Shadow V2 stream signer Agent disagrees");
    }
    envelopeDigest = crypto.hash(start.namespaceEnvelopeBytes);
    if (!sameBytes(envelopeDigest, start.namespaceEnvelopeDigest)) {
      throw new TypeError(
        "Agent live Shadow V2 Namespace envelope digest disagrees",
      );
    }
    const resolved = input.resolveSigner(Object.freeze({
      purpose: "agent-live-shadow-stream-start-v2-verify" as const,
      operationId: start.operationId,
      authorAgentId: start.authorAgentId,
      runtimeGeneration: start.runtimeSigner.runtimeGeneration,
      signerKeyId: start.runtimeSigner.signerKeyId,
      hostAuthorizationRevision: start.hostAuthorizationRevision,
    }));
    if (resolved === null) {
      throw new TypeError("Agent live Shadow V2 stream signer is unavailable");
    }
    publicKey = exactBytes(
      "Agent live Shadow V2 stream signer public key",
      resolved,
      V2_LIMITS.signingPublicKeyBytes,
    );
    signing = startUnsignedBytes(start);
    if (!crypto.verify(publicKey, signing, start.signature)) {
      throw new TypeError("Agent live Shadow V2 stream start signature is invalid");
    }
    verified = true;
    return start;
  } finally {
    publicKey?.fill(0);
    signing?.fill(0);
    envelopeDigest?.fill(0);
    if (!verified) destroyStart(start);
  }
}

const STREAM_START_V2_CODEC: LiveShadowStreamFrameStartCodec<
  AgentLiveShadowStreamStartV2
> = Object.freeze({
  keyDomain: AGENT_LIVE_SHADOW_STREAM_KEY_DOMAIN_V2,
  decode: decodeAgentLiveShadowStreamStartV2,
  destroy: destroyStart,
  identityBytes: startUnsignedBytes,
});

export function sealAgentLiveShadowStreamFrameV2(
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
    STREAM_START_V2_CODEC,
  );
}

export function openAgentLiveShadowStreamFrameV2(
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
    STREAM_START_V2_CODEC,
  );
}
