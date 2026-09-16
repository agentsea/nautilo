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
  assertPortableId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type ObjectId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1 =
  "message.live_shadow_client_verification" as const;
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-live-shadow-client-verification/v1";
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_TTL_MS_V1 = 30_000;
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1 = 256;
export const MAX_HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_WIRE_BYTES_V1 = 256 * 1024;

const HASH_BYTES = 32;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STATUSES_V1 = Object.freeze([
  "matched", "failed",
] as const);
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STAGES_V1 = Object.freeze([
  "human_prepare", "server_admission", "agent_consume", "assistant_stream",
  "tool_call_consume", "tool_result_consume", "durable_transcript", "browser_open",
] as const);
export const HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_REASONS_V1 = Object.freeze([
  "none", "policy_changed", "authority_changed", "deadline_expired",
  "integrity_failure", "parity_mismatch", "stream_incomplete", "client_unavailable",
  "unsupported_payload", "storage_failure", "transport_failure",
] as const);

export type HumanLiveShadowClientVerificationStatusV1 =
  typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STATUSES_V1[number];
export type HumanLiveShadowClientVerificationStageV1 =
  typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STAGES_V1[number];
export type HumanLiveShadowClientVerificationReasonV1 =
  typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_REASONS_V1[number];

export interface HumanLiveShadowTranscriptVerificationEntryV1 {
  readonly transcriptOrdinal: number;
  readonly messageId: number;
  readonly revision: 0;
  readonly authorRole: "human" | "assistant" | "tool";
  readonly cryptoObjectId: ObjectId;
  readonly ordinaryPayloadDigest: Uint8Array;
  readonly protectedDtoDigest: Uint8Array;
}

export interface HumanLiveShadowStreamTerminalVerificationEntryV1 {
  readonly transcriptOrdinal: number;
  readonly streamId: string;
  readonly streamStartDigest: Uint8Array;
  readonly terminalFrameDigest: Uint8Array;
  readonly streamedTextDigest: Uint8Array;
  readonly finalPayloadDigest: Uint8Array;
}

export interface HumanLiveShadowClientVerificationUnsignedV1 {
  readonly formatVersion: typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_FORMAT_VERSION_V1;
  readonly purpose: typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1;
  readonly subjectHumanId: HumanId;
  readonly operationId: string;
  readonly policyRevision: number;
  readonly sessionId: string;
  readonly roomId: string;
  readonly status: HumanLiveShadowClientVerificationStatusV1;
  readonly transcript: readonly HumanLiveShadowTranscriptVerificationEntryV1[];
  readonly streamTerminals: readonly HumanLiveShadowStreamTerminalVerificationEntryV1[];
  readonly closedStage: HumanLiveShadowClientVerificationStageV1;
  readonly reason: HumanLiveShadowClientVerificationReasonV1;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
  readonly committerDeviceId: CryptoDeviceId;
  readonly hostAuthorizationRevision: AuthorizationRevision;
}

export interface HumanLiveShadowClientVerificationV1
  extends HumanLiveShadowClientVerificationUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedHumanLiveShadowClientVerificationV1 {
  readonly verification: HumanLiveShadowClientVerificationV1;
  readonly bytes: Uint8Array;
  readonly verificationDigest: Uint8Array;
}

export type ResolveCurrentHumanLiveShadowClientVerificationAuthorityV1 = (
  context: Readonly<{
    purpose: "human-live-shadow-client-verification";
    subjectHumanId: HumanId;
    operationId: string;
    committerDeviceId: CryptoDeviceId;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion", "purpose", "subjectHumanId", "operationId", "policyRevision",
  "sessionId", "roomId", "status", "transcript", "streamTerminals",
  "closedStage", "reason", "issuedAt", "deadlineAt", "committerDeviceId",
  "hostAuthorizationRevision",
] as const);
const FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const TRANSCRIPT_FIELDS = Object.freeze([
  "transcriptOrdinal", "messageId", "revision", "authorRole", "cryptoObjectId",
  "ordinaryPayloadDigest", "protectedDtoDigest",
] as const);
const TERMINAL_FIELDS = Object.freeze([
  "transcriptOrdinal", "streamId", "streamStartDigest", "terminalFrameDigest",
  "streamedTextDigest", "finalPayloadDigest",
] as const);

function exactFields(label: string, value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((fieldName, index) => fieldName !== expected[index])) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function exactBytes(label: string, value: unknown, length = HASH_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError(`${label} must be exactly ${length} bytes`);
  return copyOwnedBytesV2(value);
}

function counter(label: string, value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new RangeError(`${label} is invalid`);
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

function closed<Value extends string>(label: string, value: unknown, values: readonly Value[]): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) throw new TypeError(`${label} is invalid`);
  return value as Value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function normalizeTranscript(value: readonly HumanLiveShadowTranscriptVerificationEntryV1[]): readonly HumanLiveShadowTranscriptVerificationEntryV1[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1) throw new TypeError("Human live Shadow transcript evidence count is invalid");
  const entries: readonly HumanLiveShadowTranscriptVerificationEntryV1[] = value;
  let previous = 0;
  return Object.freeze(entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TypeError("Human live Shadow transcript evidence must be an object");
    exactFields("Human live Shadow transcript evidence", entry, TRANSCRIPT_FIELDS);
    const ordinal = counter("Human live Shadow transcript ordinal", entry.transcriptOrdinal, 1);
    if (ordinal <= previous) throw new TypeError("Human live Shadow transcript evidence must be strictly ordered");
    previous = ordinal;
    if (entry.revision !== 0) throw new TypeError("Human live Shadow transcript revision is invalid");
    return Object.freeze({
      transcriptOrdinal: ordinal,
      messageId: counter("Human live Shadow Message ID", entry.messageId, 1, PG_SERIAL_MAX),
      revision: 0 as const,
      authorRole: closed("Human live Shadow author role", entry.authorRole, ["human", "assistant", "tool"] as const),
      cryptoObjectId: objectId(entry.cryptoObjectId),
      ordinaryPayloadDigest: exactBytes("Human live Shadow ordinary payload digest", entry.ordinaryPayloadDigest),
      protectedDtoDigest: exactBytes("Human live Shadow protected DTO digest", entry.protectedDtoDigest),
    });
  }));
}

function normalizeTerminals(value: readonly HumanLiveShadowStreamTerminalVerificationEntryV1[]): readonly HumanLiveShadowStreamTerminalVerificationEntryV1[] {
  if (!Array.isArray(value) || value.length > HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1) throw new TypeError("Human live Shadow stream terminal count is invalid");
  const entries: readonly HumanLiveShadowStreamTerminalVerificationEntryV1[] = value;
  let previous = 0;
  return Object.freeze(entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TypeError("Human live Shadow stream terminal must be an object");
    exactFields("Human live Shadow stream terminal", entry, TERMINAL_FIELDS);
    const ordinal = counter("Human live Shadow stream terminal ordinal", entry.transcriptOrdinal, 1);
    if (ordinal <= previous) throw new TypeError("Human live Shadow stream terminals must be strictly ordered");
    previous = ordinal;
    return Object.freeze({
      transcriptOrdinal: ordinal,
      streamId: portable("Human live Shadow stream ID", entry.streamId),
      streamStartDigest: exactBytes("Human live Shadow stream start digest", entry.streamStartDigest),
      terminalFrameDigest: exactBytes("Human live Shadow terminal frame digest", entry.terminalFrameDigest),
      streamedTextDigest: exactBytes("Human live Shadow streamed text digest", entry.streamedTextDigest),
      finalPayloadDigest: exactBytes("Human live Shadow final payload digest", entry.finalPayloadDigest),
    });
  }));
}

function destroyUnsigned(value: HumanLiveShadowClientVerificationUnsignedV1 | HumanLiveShadowClientVerificationV1): void {
  value.transcript.forEach((entry) => { entry.ordinaryPayloadDigest.fill(0); entry.protectedDtoDigest.fill(0); });
  value.streamTerminals.forEach((entry) => {
    entry.streamStartDigest.fill(0); entry.terminalFrameDigest.fill(0);
    entry.streamedTextDigest.fill(0); entry.finalPayloadDigest.fill(0);
  });
  if ("signature" in value) value.signature.fill(0);
}

function normalizeUnsigned(value: HumanLiveShadowClientVerificationUnsignedV1): HumanLiveShadowClientVerificationUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Human live Shadow client verification must be an object");
  exactFields("Human live Shadow client verification", value, UNSIGNED_FIELDS);
  if (value.formatVersion !== 1 || value.purpose !== HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1) throw new TypeError("Human live Shadow client verification version or purpose is invalid");
  const status = closed("Human live Shadow verification status", value.status, HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STATUSES_V1);
  const stage = closed("Human live Shadow verification stage", value.closedStage, HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_STAGES_V1);
  const reason = closed("Human live Shadow verification reason", value.reason, HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_REASONS_V1);
  if ((status === "matched") !== (reason === "none")) throw new TypeError("Human live Shadow verification status and reason disagree");
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  if (deadlineAt <= issuedAt || deadlineAt - issuedAt > HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_TTL_MS_V1) throw new RangeError("Human live Shadow client verification lifetime is invalid");
  return Object.freeze({
    formatVersion: 1, purpose: HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1,
    subjectHumanId: humanId(value.subjectHumanId), operationId: portable("Human live Shadow operation ID", value.operationId),
    policyRevision: counter("Human live Shadow policy revision", value.policyRevision, 1),
    sessionId: uuid("Human live Shadow Session ID", value.sessionId), roomId: uuid("Human live Shadow Room ID", value.roomId),
    status, transcript: normalizeTranscript(value.transcript), streamTerminals: normalizeTerminals(value.streamTerminals),
    closedStage: stage, reason, issuedAt, deadlineAt,
    committerDeviceId: cryptoDeviceId(value.committerDeviceId),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
  });
}

function unsignedBytes(value: HumanLiveShadowClientVerificationUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_DOMAIN_V1), encodeU32(value.formatVersion),
    frameText(value.purpose), frameText(value.subjectHumanId), frameText(value.operationId),
    encodeU64(value.policyRevision), frameText(value.sessionId), frameText(value.roomId),
    frameText(value.status), encodeU32(value.transcript.length),
    ...value.transcript.flatMap((entry) => [
      encodeU64(entry.transcriptOrdinal), encodeU64(entry.messageId), encodeU64(entry.revision),
      frameText(entry.authorRole), frameText(entry.cryptoObjectId), frame(entry.ordinaryPayloadDigest),
      frame(entry.protectedDtoDigest),
    ]),
    encodeU32(value.streamTerminals.length),
    ...value.streamTerminals.flatMap((entry) => [
      encodeU64(entry.transcriptOrdinal), frameText(entry.streamId), frame(entry.streamStartDigest),
      frame(entry.terminalFrameDigest), frame(entry.streamedTextDigest), frame(entry.finalPayloadDigest),
    ]),
    frameText(value.closedStage), frameText(value.reason), encodeU64(value.issuedAt), encodeU64(value.deadlineAt),
    frameText(value.committerDeviceId), encodeU64(value.hostAuthorizationRevision),
  );
}

export function humanLiveShadowClientVerificationSigningBytesV1(value: HumanLiveShadowClientVerificationUnsignedV1): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try { return unsignedBytes(normalized); } finally { destroyUnsigned(normalized); }
}

export function encodeHumanLiveShadowClientVerificationV1(value: HumanLiveShadowClientVerificationV1): Uint8Array {
  if (typeof value !== "object" || value === null) throw new TypeError("Human live Shadow client verification must be an object");
  exactFields("Human live Shadow client verification", value, FIELDS);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  const signature = exactBytes("Human live Shadow client verification signature", rawSignature, V2_LIMITS.signatureBytes);
  try {
    const bytes = concatV2(unsignedBytes(unsigned), frame(signature));
    if (bytes.length > MAX_HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_WIRE_BYTES_V1) { bytes.fill(0); throw new RangeError("Human live Shadow client verification exceeds its wire limit"); }
    return bytes;
  } finally { destroyUnsigned(unsigned); signature.fill(0); }
}

export function decodeHumanLiveShadowClientVerificationV1(bytes: Uint8Array): HumanLiveShadowClientVerificationV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_WIRE_BYTES_V1) throw new TypeError("Human live Shadow client verification bytes are invalid");
  const raw = decodeExact(bytes, (reader): HumanLiveShadowClientVerificationV1 => {
    if (reader.readText(utf8V2(HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_DOMAIN_V1).length) !== HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_DOMAIN_V1) throw new CanonicalDecodingError("Human live Shadow client verification domain mismatch");
    const formatVersion = reader.readVersion(1) as 1;
    const purpose = reader.readText(96) as typeof HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1;
    const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const operationId = reader.readText(V2_LIMITS.idBytes); const policyRevision = reader.readU64();
    const sessionId = reader.readText(36); const roomId = reader.readText(36);
    const status = reader.readText(16) as HumanLiveShadowClientVerificationStatusV1;
    const transcript = Array.from({ length: reader.readCount(HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1) }, (): HumanLiveShadowTranscriptVerificationEntryV1 => ({
      transcriptOrdinal: reader.readU64(), messageId: reader.readU64(), revision: reader.readU64() as 0,
      authorRole: reader.readText(16) as "human" | "assistant" | "tool", cryptoObjectId: objectId(reader.readText(V2_LIMITS.idBytes)),
      ordinaryPayloadDigest: reader.readFrame(HASH_BYTES), protectedDtoDigest: reader.readFrame(HASH_BYTES),
    }));
    const streamTerminals = Array.from({ length: reader.readCount(HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_MAX_ENTRIES_V1) }, (): HumanLiveShadowStreamTerminalVerificationEntryV1 => ({
      transcriptOrdinal: reader.readU64(), streamId: reader.readText(V2_LIMITS.idBytes),
      streamStartDigest: reader.readFrame(HASH_BYTES), terminalFrameDigest: reader.readFrame(HASH_BYTES),
      streamedTextDigest: reader.readFrame(HASH_BYTES), finalPayloadDigest: reader.readFrame(HASH_BYTES),
    }));
    return {
      formatVersion, purpose, subjectHumanId, operationId, policyRevision, sessionId, roomId, status,
      transcript, streamTerminals,
      closedStage: reader.readText(32) as HumanLiveShadowClientVerificationStageV1,
      reason: reader.readText(32) as HumanLiveShadowClientVerificationReasonV1,
      issuedAt: unixTimestamp(reader.readU64()), deadlineAt: unixTimestamp(reader.readU64()),
      committerDeviceId: cryptoDeviceId(reader.readText(V2_LIMITS.idBytes)),
      hostAuthorizationRevision: authorizationRevision(reader.readU64()),
      signature: reader.readFrame(V2_LIMITS.signatureBytes),
    };
  });
  let unsigned: HumanLiveShadowClientVerificationUnsignedV1 | undefined;
  let signature: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  try {
    const { signature: rawSignature, ...rawUnsigned } = raw;
    unsigned = normalizeUnsigned(rawUnsigned);
    signature = exactBytes("Human live Shadow client verification signature", rawSignature, V2_LIMITS.signatureBytes);
    canonical = concatV2(unsignedBytes(unsigned), frame(signature));
    if (!sameBytes(canonical, bytes)) throw new CanonicalDecodingError("Human live Shadow client verification is noncanonical");
    const result = Object.freeze({ ...unsigned, signature: copyOwnedBytesV2(signature) });
    unsigned = undefined;
    return result;
  } finally {
    destroyUnsigned(raw); if (unsigned) destroyUnsigned(unsigned); signature?.fill(0); canonical?.fill(0);
  }
}

export function prepareHumanLiveShadowClientVerificationV1(
  crypto: LatticeCrypto,
  input: Omit<HumanLiveShadowClientVerificationUnsignedV1, "formatVersion" | "purpose"> & Readonly<{
    committerSigningPublicKey: Uint8Array;
    committerSigningPrivateKey: Uint8Array;
  }>,
): CreatedHumanLiveShadowClientVerificationV1 {
  const { committerSigningPublicKey, committerSigningPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({ ...rest, formatVersion: 1, purpose: HUMAN_LIVE_SHADOW_CLIENT_VERIFICATION_PURPOSE_V1 });
  const publicKey = copyOwnedBytesV2(committerSigningPublicKey);
  const secretKey = copyOwnedBytesV2(committerSigningPrivateKey);
  let signing: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    assertLiveShadowVerificationPublicKey(publicKey);
    assertLiveShadowVerificationPrivateKey(secretKey);
    signing = unsignedBytes(unsigned);
    signature = crypto.sign(secretKey, signing);
    if (!crypto.verify(publicKey, signing, signature)) throw new TypeError("Human live Shadow verification signing keys do not match");
    const bytes = encodeHumanLiveShadowClientVerificationV1({ ...unsigned, signature });
    return Object.freeze({ verification: decodeHumanLiveShadowClientVerificationV1(bytes), bytes, verificationDigest: crypto.hash(bytes) });
  } finally {
    destroyUnsigned(unsigned); publicKey.fill(0); secretKey.fill(0); signing?.fill(0); signature?.fill(0);
  }
}

function assertLiveShadowVerificationPublicKey(key: Uint8Array): void {
  if (key.length !== V2_LIMITS.signingPublicKeyBytes) {
    throw new TypeError("Human live Shadow verification signing public key length is invalid");
  }
}

function assertLiveShadowVerificationPrivateKey(key: Uint8Array): void {
  if (key.length !== V2_LIMITS.signingPrivateKeyBytes) {
    throw new TypeError("Human live Shadow verification signing private key length is invalid");
  }
}

export function verifyHumanLiveShadowClientVerificationV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    verificationBytes: Uint8Array;
    now: UnixTimestamp;
    resolveCurrentAuthority: ResolveCurrentHumanLiveShadowClientVerificationAuthorityV1;
  }>,
): HumanLiveShadowClientVerificationV1 {
  const verification = decodeHumanLiveShadowClientVerificationV1(input.verificationBytes);
  let publicKey: Uint8Array | undefined;
  let signing: Uint8Array | undefined;
  let ok = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < verification.issuedAt || now >= verification.deadlineAt) throw new TypeError("Human live Shadow client verification is not currently valid");
    const resolved = input.resolveCurrentAuthority(Object.freeze({
      purpose: "human-live-shadow-client-verification" as const,
      subjectHumanId: verification.subjectHumanId, operationId: verification.operationId,
      committerDeviceId: verification.committerDeviceId,
      hostAuthorizationRevision: verification.hostAuthorizationRevision,
    }));
    if (resolved === null) throw new TypeError("Human live Shadow client verification authority is unavailable");
    publicKey = copyOwnedBytesV2(resolved);
    if (publicKey.length !== V2_LIMITS.signingPublicKeyBytes) throw new TypeError("Human live Shadow client verification public key is invalid");
    signing = unsignedBytes(verification);
    if (!crypto.verify(publicKey, signing, verification.signature)) throw new TypeError("Human live Shadow client verification signature is invalid");
    ok = true;
    return verification;
  } finally {
    publicKey?.fill(0); signing?.fill(0); if (!ok) destroyUnsigned(verification);
  }
}

export function humanLiveShadowClientVerificationDigestV1(crypto: LatticeCrypto, bytes: Uint8Array): Uint8Array {
  const verification = decodeHumanLiveShadowClientVerificationV1(bytes);
  try { return crypto.hash(bytes); } finally { destroyUnsigned(verification); }
}
