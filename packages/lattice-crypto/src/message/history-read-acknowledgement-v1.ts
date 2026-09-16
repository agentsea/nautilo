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
  unixTimestamp,
  type AuthorizationRevision,
  type CryptoDeviceId,
  type HumanId,
  type UnixTimestamp,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1 = 1 as const;
export const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1 =
  "message.history_read_acknowledgement" as const;
export const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1 =
  "nautilo/lattice-crypto/human-history-read-acknowledgement/v1";
export const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1 = 120_000;
export const HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1 = 50;
export const MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1 = 4 * 1024;

const HASH_BYTES = 32;
const PG_SERIAL_MAX = 2_147_483_647;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const HUMAN_HISTORY_READ_RESULT_OUTCOMES_V1 = Object.freeze([
  "verified",
  "unavailable",
  "failed",
] as const);
export const HUMAN_HISTORY_READ_RESULT_REASONS_V1 = Object.freeze([
  "none",
  "client_crypto_unavailable",
  "client_custody_unavailable",
  "current_read_authority_unavailable",
  "retained_key_material_unavailable",
  "signer_evidence_unavailable",
  "live_shadow_lifecycle_unavailable",
  "integrity_failure",
  "parity_mismatch",
] as const);

export type HumanHistoryReadResultOutcomeV1 =
  typeof HUMAN_HISTORY_READ_RESULT_OUTCOMES_V1[number];
export type HumanHistoryReadResultReasonV1 =
  typeof HUMAN_HISTORY_READ_RESULT_REASONS_V1[number];

export interface HumanHistoryReadResultCountsV1 {
  readonly verified: number;
  readonly clientCryptoUnavailable: number;
  readonly clientCustodyUnavailable: number;
  readonly currentReadAuthorityUnavailable: number;
  readonly retainedKeyMaterialUnavailable: number;
  readonly signerEvidenceUnavailable: number;
  readonly liveShadowLifecycleUnavailable: number;
  readonly integrityFailure: number;
  readonly parityMismatch: number;
}

export interface HumanHistoryReadResultDigestEntryV1 {
  /** Digest of the exact selected ordinary coordinate, never content bytes. */
  readonly coordinateDigest: Uint8Array;
  readonly outcome: HumanHistoryReadResultOutcomeV1;
  readonly reason: HumanHistoryReadResultReasonV1;
}

export interface HumanHistoryReadSelectedCoordinateV1 {
  readonly sessionId: string;
  readonly messageId: number;
  readonly editRevision: number;
  readonly role: string;
  readonly logicalMessageKey: string;
}

export interface HumanHistoryReadAcknowledgementUnsignedV1 {
  readonly formatVersion:
    typeof HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1;
  readonly purpose: typeof HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1;
  readonly operationId: string;
  readonly clientRequestKey: string;
  readonly policyRevision: number;
  readonly subjectHumanId: HumanId;
  readonly readerDeviceId: CryptoDeviceId;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: AuthorizationRevision;
  readonly roomId: string;
  readonly selectedCoordinateDigest: Uint8Array;
  readonly eligibleCount: number;
  readonly resultCounts: HumanHistoryReadResultCountsV1;
  readonly orderedResultSetDigest: Uint8Array;
  readonly issuedAt: UnixTimestamp;
  readonly deadlineAt: UnixTimestamp;
}

export interface HumanHistoryReadAcknowledgementV1
  extends HumanHistoryReadAcknowledgementUnsignedV1 {
  readonly signature: Uint8Array;
}

export interface CreatedHumanHistoryReadAcknowledgementV1 {
  readonly acknowledgement: HumanHistoryReadAcknowledgementV1;
  readonly bytes: Uint8Array;
  readonly acknowledgementDigest: Uint8Array;
}

export type ResolvePlannedHumanHistoryReadAuthorityV1 = (
  context: Readonly<{
    purpose: "human-history-read-acknowledgement";
    subjectHumanId: HumanId;
    operationId: string;
    readerDeviceId: CryptoDeviceId;
    readerDeviceSigningKeyGeneration: number;
    hostAuthorizationRevision: AuthorizationRevision;
  }>,
) => Uint8Array | null;

const COUNT_FIELDS = Object.freeze([
  "verified",
  "clientCryptoUnavailable",
  "clientCustodyUnavailable",
  "currentReadAuthorityUnavailable",
  "retainedKeyMaterialUnavailable",
  "signerEvidenceUnavailable",
  "liveShadowLifecycleUnavailable",
  "integrityFailure",
  "parityMismatch",
] as const);
const UNSIGNED_FIELDS = Object.freeze([
  "formatVersion",
  "purpose",
  "operationId",
  "clientRequestKey",
  "policyRevision",
  "subjectHumanId",
  "readerDeviceId",
  "readerDeviceSigningKeyGeneration",
  "hostAuthorizationRevision",
  "roomId",
  "selectedCoordinateDigest",
  "eligibleCount",
  "resultCounts",
  "orderedResultSetDigest",
  "issuedAt",
  "deadlineAt",
] as const);
const FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const RESULT_FIELDS = Object.freeze(["coordinateDigest", "outcome", "reason"]);

function exactFields(label: string, value: object, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) throw new TypeError(`${label} has an invalid field set`);
}

function exactBytes(label: string, value: unknown, length = HASH_BYTES): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must be exactly ${length} bytes`);
  }
  return copyOwnedBytesV2(value);
}

function safeInteger(
  label: string,
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) throw new RangeError(`${label} is invalid`);
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

function closed<Value extends string>(
  label: string,
  value: unknown,
  values: readonly Value[],
): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

function normalizeCounts(
  value: HumanHistoryReadResultCountsV1,
): HumanHistoryReadResultCountsV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human history read result counts must be an object");
  }
  exactFields("Human history read result counts", value, COUNT_FIELDS);
  return Object.freeze(Object.fromEntries(COUNT_FIELDS.map((field) => [
    field,
    safeInteger(`Human history read ${field} count`, value[field], 0,
      HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
  ])) as unknown as HumanHistoryReadResultCountsV1);
}

function countTotal(value: HumanHistoryReadResultCountsV1): number {
  return COUNT_FIELDS.reduce((sum, field) => sum + value[field], 0);
}

function normalizeUnsigned(
  value: HumanHistoryReadAcknowledgementUnsignedV1,
): HumanHistoryReadAcknowledgementUnsignedV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human history read acknowledgement must be an object");
  }
  exactFields("Human history read acknowledgement", value, UNSIGNED_FIELDS);
  if (
    value.formatVersion !== HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1 ||
    value.purpose !== HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1
  ) throw new TypeError("Human history read acknowledgement version or purpose is invalid");
  const eligibleCount = safeInteger(
    "Human history read eligible count",
    value.eligibleCount,
    1,
    HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1,
  );
  const resultCounts = normalizeCounts(value.resultCounts);
  if (countTotal(resultCounts) !== eligibleCount) {
    throw new TypeError("Human history read result counts do not close over eligibility");
  }
  const issuedAt = unixTimestamp(value.issuedAt);
  const deadlineAt = unixTimestamp(value.deadlineAt);
  if (
    deadlineAt <= issuedAt ||
    deadlineAt - issuedAt > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1
  ) throw new RangeError("Human history read acknowledgement lifetime is invalid");
  return Object.freeze({
    formatVersion: HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1,
    purpose: HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1,
    operationId: portable("Human history read operation ID", value.operationId),
    clientRequestKey: portable(
      "Human history read client request key",
      value.clientRequestKey,
    ),
    policyRevision: safeInteger("Human history read policy revision", value.policyRevision, 1),
    subjectHumanId: humanId(value.subjectHumanId),
    readerDeviceId: cryptoDeviceId(value.readerDeviceId),
    readerDeviceSigningKeyGeneration: safeInteger(
      "Human history read device signing key generation",
      value.readerDeviceSigningKeyGeneration,
      1,
    ),
    hostAuthorizationRevision: authorizationRevision(value.hostAuthorizationRevision),
    roomId: uuid("Human history read Room ID", value.roomId),
    selectedCoordinateDigest: exactBytes(
      "Human history read selected-coordinate digest",
      value.selectedCoordinateDigest,
    ),
    eligibleCount,
    resultCounts,
    orderedResultSetDigest: exactBytes(
      "Human history read ordered result-set digest",
      value.orderedResultSetDigest,
    ),
    issuedAt,
    deadlineAt,
  });
}

function resultCountsBytes(value: HumanHistoryReadResultCountsV1): Uint8Array {
  return concatV2(...COUNT_FIELDS.map((field) => encodeU32(value[field])));
}

function unsignedBytes(value: HumanHistoryReadAcknowledgementUnsignedV1): Uint8Array {
  return concatV2(
    frameText(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1),
    encodeU32(value.formatVersion),
    frameText(value.purpose),
    frameText(value.operationId),
    frameText(value.clientRequestKey),
    encodeU64(value.policyRevision),
    frameText(value.subjectHumanId),
    frameText(value.readerDeviceId),
    encodeU64(value.readerDeviceSigningKeyGeneration),
    encodeU64(value.hostAuthorizationRevision),
    frameText(value.roomId),
    frame(value.selectedCoordinateDigest),
    encodeU32(value.eligibleCount),
    resultCountsBytes(value.resultCounts),
    frame(value.orderedResultSetDigest),
    encodeU64(value.issuedAt),
    encodeU64(value.deadlineAt),
  );
}

function destroy(
  value: HumanHistoryReadAcknowledgementUnsignedV1 |
    HumanHistoryReadAcknowledgementV1,
): void {
  value.selectedCoordinateDigest.fill(0);
  value.orderedResultSetDigest.fill(0);
  if ("signature" in value) value.signature.fill(0);
}

/**
 * Digest the exact ordered ordinary page selected by the canonical Room query.
 * Both the server and Browser recompute this value; it is not a server echo.
 */
export function humanHistoryReadSelectedCoordinateDigestV1(
  crypto: LatticeCrypto,
  coordinates: readonly HumanHistoryReadSelectedCoordinateV1[],
): Uint8Array {
  if (!Array.isArray(coordinates) || coordinates.length === 0 ||
    coordinates.length > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1) {
    throw new TypeError("Human history read selected-coordinate count is invalid");
  }
  const entries: readonly HumanHistoryReadSelectedCoordinateV1[] = coordinates;
  const seen = new Set<string>();
  const normalized = entries.map((coordinate) => {
    if (typeof coordinate !== "object" || coordinate === null ||
      Array.isArray(coordinate)) {
      throw new TypeError("Human history read selected coordinate must be an object");
    }
    exactFields("Human history read selected coordinate", coordinate, [
      "sessionId",
      "messageId",
      "editRevision",
      "role",
      "logicalMessageKey",
    ]);
    const sessionId = uuid(
      "Human history read selected Session ID",
      coordinate.sessionId,
    );
    const messageId = safeInteger(
      "Human history read selected Message ID",
      coordinate.messageId,
      1,
      PG_SERIAL_MAX,
    );
    const editRevision = safeInteger(
      "Human history read selected edit revision",
      coordinate.editRevision,
    );
    const role = portable("Human history read selected role", coordinate.role);
    const logicalMessageKey = portable(
      "Human history read selected logical Message key",
      coordinate.logicalMessageKey,
    );
    const identity = `${sessionId}\u0000${messageId}\u0000${editRevision}`;
    if (seen.has(identity)) {
      throw new TypeError("Human history read selected coordinate is duplicated");
    }
    seen.add(identity);
    return { sessionId, messageId, editRevision, role, logicalMessageKey };
  });
  let bytes: Uint8Array | undefined;
  try {
    bytes = concatV2(
      frameText(`${HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1}/selection`),
      encodeU32(normalized.length),
      ...normalized.flatMap((coordinate) => [
        frameText(coordinate.sessionId),
        encodeU64(coordinate.messageId),
        encodeU64(coordinate.editRevision),
        frameText(coordinate.role),
        frameText(coordinate.logicalMessageKey),
      ]),
    );
    return crypto.hash(bytes);
  } finally {
    bytes?.fill(0);
  }
}

export function humanHistoryReadResultSetDigestV1(
  crypto: LatticeCrypto,
  results: readonly HumanHistoryReadResultDigestEntryV1[],
): Uint8Array {
  if (!Array.isArray(results) || results.length === 0 ||
    results.length > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1) {
    throw new TypeError("Human history read result set count is invalid");
  }
  const entries: readonly HumanHistoryReadResultDigestEntryV1[] = results;
  const normalized = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("Human history read result must be an object");
    }
    exactFields("Human history read result", entry, RESULT_FIELDS);
    const outcome = closed(
      "Human history read result outcome",
      entry.outcome,
      HUMAN_HISTORY_READ_RESULT_OUTCOMES_V1,
    );
    const reason = closed(
      "Human history read result reason",
      entry.reason,
      HUMAN_HISTORY_READ_RESULT_REASONS_V1,
    );
    if (
      (outcome === "verified") !== (reason === "none") ||
      (outcome === "failed") !== ["integrity_failure", "parity_mismatch"].includes(reason)
    ) throw new TypeError("Human history read result outcome and reason disagree");
    return {
      coordinateDigest: exactBytes(
        "Human history read result coordinate digest",
        entry.coordinateDigest,
      ),
      outcome,
      reason,
    };
  });
  let bytes: Uint8Array | undefined;
  try {
    bytes = concatV2(
      frameText(`${HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1}/result-set`),
      encodeU32(normalized.length),
      ...normalized.flatMap((entry) => [
        frame(entry.coordinateDigest),
        frameText(entry.outcome),
        frameText(entry.reason),
      ]),
    );
    return crypto.hash(bytes);
  } finally {
    normalized.forEach((entry) => entry.coordinateDigest.fill(0));
    bytes?.fill(0);
  }
}

export function humanHistoryReadAcknowledgementSigningBytesV1(
  value: HumanHistoryReadAcknowledgementUnsignedV1,
): Uint8Array {
  const normalized = normalizeUnsigned(value);
  try {
    return unsignedBytes(normalized);
  } finally {
    destroy(normalized);
  }
}

export function encodeHumanHistoryReadAcknowledgementV1(
  value: HumanHistoryReadAcknowledgementV1,
): Uint8Array {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Human history read acknowledgement must be an object");
  }
  exactFields("Human history read acknowledgement", value, FIELDS);
  const { signature: rawSignature, ...rawUnsigned } = value;
  const unsigned = normalizeUnsigned(rawUnsigned);
  const signature = exactBytes(
    "Human history read acknowledgement signature",
    rawSignature,
    V2_LIMITS.signatureBytes,
  );
  try {
    const bytes = concatV2(unsignedBytes(unsigned), frame(signature));
    if (bytes.length > MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1) {
      bytes.fill(0);
      throw new RangeError("Human history read acknowledgement exceeds its wire limit");
    }
    return bytes;
  } finally {
    destroy(unsigned);
    signature.fill(0);
  }
}

export function decodeHumanHistoryReadAcknowledgementV1(
  bytes: Uint8Array,
): HumanHistoryReadAcknowledgementV1 {
  if (!(bytes instanceof Uint8Array) ||
    bytes.length > MAX_HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_WIRE_BYTES_V1) {
    throw new TypeError("Human history read acknowledgement bytes are invalid");
  }
  const raw = decodeExact(bytes, (reader): HumanHistoryReadAcknowledgementV1 => {
    if (
      reader.readText(utf8V2(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1).length) !==
      HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_DOMAIN_V1
    ) throw new CanonicalDecodingError("Human history read acknowledgement domain mismatch");
    const formatVersion = reader.readVersion(1) as 1;
    const purpose = reader.readText(96) as typeof HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1;
    const operationId = reader.readText(V2_LIMITS.idBytes);
    const clientRequestKey = reader.readText(V2_LIMITS.idBytes);
    const policyRevision = reader.readU64();
    const subjectHumanId = humanId(reader.readText(V2_LIMITS.idBytes));
    const readerDeviceId = cryptoDeviceId(reader.readText(V2_LIMITS.idBytes));
    const readerDeviceSigningKeyGeneration = reader.readU64();
    const hostAuthorizationRevision = authorizationRevision(reader.readU64());
    const roomId = reader.readText(36);
    const selectedCoordinateDigest = reader.readFrame(HASH_BYTES);
    const eligibleCount = reader.readU32();
    const counts = COUNT_FIELDS.map(() => reader.readU32());
    const resultCounts = Object.fromEntries(
      COUNT_FIELDS.map((field, index) => [field, counts[index]]),
    ) as unknown as HumanHistoryReadResultCountsV1;
    const orderedResultSetDigest = reader.readFrame(HASH_BYTES);
    const issuedAt = unixTimestamp(reader.readU64());
    const deadlineAt = unixTimestamp(reader.readU64());
    const signature = reader.readFrame(V2_LIMITS.signatureBytes);
    return {
      formatVersion,
      purpose,
      operationId,
      clientRequestKey,
      policyRevision,
      subjectHumanId,
      readerDeviceId,
      readerDeviceSigningKeyGeneration,
      hostAuthorizationRevision,
      roomId,
      selectedCoordinateDigest,
      eligibleCount,
      resultCounts,
      orderedResultSetDigest,
      issuedAt,
      deadlineAt,
      signature,
    };
  });
  let normalized: HumanHistoryReadAcknowledgementUnsignedV1 | undefined;
  let normalizedSignature: Uint8Array | undefined;
  let canonical: Uint8Array | undefined;
  try {
    const { signature, ...unsigned } = raw;
    normalized = normalizeUnsigned(unsigned);
    normalizedSignature = exactBytes(
      "Human history read acknowledgement signature",
      signature,
      V2_LIMITS.signatureBytes,
    );
    canonical = concatV2(unsignedBytes(normalized), frame(normalizedSignature));
    if (!sameBytes(canonical, bytes)) {
      throw new CanonicalDecodingError(
        "Human history read acknowledgement is noncanonical",
      );
    }
    const result = Object.freeze({
      ...normalized,
      signature: copyOwnedBytesV2(normalizedSignature),
    });
    normalized = undefined;
    return result;
  } finally {
    destroy(raw);
    if (normalized) destroy(normalized);
    normalizedSignature?.fill(0);
    canonical?.fill(0);
  }
}

export function prepareHumanHistoryReadAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Omit<
    HumanHistoryReadAcknowledgementUnsignedV1,
    "formatVersion" | "purpose"
  > & Readonly<{
    readerSigningPublicKey: Uint8Array;
    readerSigningPrivateKey: Uint8Array;
  }>,
): CreatedHumanHistoryReadAcknowledgementV1 {
  const { readerSigningPublicKey, readerSigningPrivateKey, ...rest } = input;
  const unsigned = normalizeUnsigned({
    ...rest,
    formatVersion: HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_FORMAT_VERSION_V1,
    purpose: HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_PURPOSE_V1,
  });
  const publicKey = copyOwnedBytesV2(readerSigningPublicKey);
  let signingSecret: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  try {
    if (publicKey.length !== V2_LIMITS.signingPublicKeyBytes) {
      throw new TypeError("Human history read signing public key is invalid");
    }

    // Copy the secret only after the shareable identity has passed its own
    // structural contract. Keeping these validation stages separate also
    // ensures failure before this point never creates another secret copy.
    // Both owned copies are wiped by the common cleanup below.
    signingSecret = copyOwnedBytesV2(readerSigningPrivateKey);
    if (signingSecret.length !== V2_LIMITS.signingPrivateKeyBytes) {
      throw new TypeError("Human history read signing private key is invalid");
    }
    signingBytes = unsignedBytes(unsigned);
    signature = crypto.sign(signingSecret, signingBytes);
    if (!crypto.verify(publicKey, signingBytes, signature)) {
      throw new TypeError("Human history read signing keys do not match");
    }
    const bytes = encodeHumanHistoryReadAcknowledgementV1({
      ...unsigned,
      signature,
    });
    return Object.freeze({
      acknowledgement: decodeHumanHistoryReadAcknowledgementV1(bytes),
      bytes,
      acknowledgementDigest: crypto.hash(bytes),
    });
  } finally {
    destroy(unsigned);
    publicKey.fill(0);
    signingSecret?.fill(0);
    signingBytes?.fill(0);
    signature?.fill(0);
  }
}

export function verifyHumanHistoryReadAcknowledgementV1(
  crypto: LatticeCrypto,
  input: Readonly<{
    acknowledgementBytes: Uint8Array;
    now: UnixTimestamp;
    resolvePlannedAuthority: ResolvePlannedHumanHistoryReadAuthorityV1;
  }>,
): HumanHistoryReadAcknowledgementV1 {
  const acknowledgement = decodeHumanHistoryReadAcknowledgementV1(
    input.acknowledgementBytes,
  );
  let publicKey: Uint8Array | undefined;
  let signingBytes: Uint8Array | undefined;
  let ok = false;
  try {
    const now = unixTimestamp(input.now);
    if (now < acknowledgement.issuedAt || now >= acknowledgement.deadlineAt) {
      throw new TypeError("Human history read acknowledgement is not currently valid");
    }
    const resolved = input.resolvePlannedAuthority(Object.freeze({
      purpose: "human-history-read-acknowledgement" as const,
      subjectHumanId: acknowledgement.subjectHumanId,
      operationId: acknowledgement.operationId,
      readerDeviceId: acknowledgement.readerDeviceId,
      readerDeviceSigningKeyGeneration:
        acknowledgement.readerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: acknowledgement.hostAuthorizationRevision,
    }));
    if (resolved === null) {
      throw new TypeError("Human history read planned authority is unavailable");
    }
    publicKey = copyOwnedBytesV2(resolved);
    if (publicKey.length !== V2_LIMITS.signingPublicKeyBytes) {
      throw new TypeError("Human history read planned public key is invalid");
    }
    signingBytes = unsignedBytes(acknowledgement);
    if (!crypto.verify(publicKey, signingBytes, acknowledgement.signature)) {
      throw new TypeError("Human history read acknowledgement signature is invalid");
    }
    ok = true;
    return acknowledgement;
  } finally {
    publicKey?.fill(0);
    signingBytes?.fill(0);
    if (!ok) destroy(acknowledgement);
  }
}
