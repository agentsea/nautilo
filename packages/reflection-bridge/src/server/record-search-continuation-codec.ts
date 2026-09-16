import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  RECORD_SEARCH_POLICY_V1,
  assertRecordEvidenceContinuationStateV1,
  assertRecordEvidenceContinuationToken,
  assertRecordSearchContinuationStateV1,
  assertRecordSearchContinuationToken,
  type RecordEvidenceContinuationStateV1,
  type RecordEvidenceContinuationToken,
  type RecordSearchContinuationStateV1,
  type RecordSearchContinuationToken,
} from "@nautilo/reflection/search";

const SEARCH_PREFIX = "s1";
const EVIDENCE_PREFIX = "e1";
const SEARCH_DOMAIN = "nautilo-reflection-record-search-continuation-v1\0";
const EVIDENCE_AAD = Buffer.from(
  "nautilo-reflection-record-evidence-continuation-v1",
  "utf8",
);

export interface RecordSearchContinuationCodec {
  authenticateSearch(
    state: RecordSearchContinuationStateV1,
  ): RecordSearchContinuationToken;
  verifySearch(token: RecordSearchContinuationToken): RecordSearchContinuationStateV1;
  sealEvidence(
    state: RecordEvidenceContinuationStateV1,
  ): RecordEvidenceContinuationToken;
  openEvidence(
    token: RecordEvidenceContinuationToken,
  ): RecordEvidenceContinuationStateV1;
}

function canonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new TypeError("invalid encoding");
  return decoded;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function parseSearchState(bytes: Buffer): RecordSearchContinuationStateV1 {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !exactObject(value, [
      "version",
      "policyVersion",
      "queryCommitment",
      "invocationAudienceCommitment",
      "repositorySelectionCommitment",
      "corpusStateCommitment",
      "lastEligiblePosition",
    ])
    || !exactObject(value["lastEligiblePosition"], [
      "recordRef",
      "score",
      "structuralHeight",
    ])
  ) throw new TypeError("invalid search state");
  const state = value as unknown as RecordSearchContinuationStateV1;
  assertRecordSearchContinuationStateV1(state);
  return Object.freeze({
    ...state,
    lastEligiblePosition: Object.freeze({ ...state.lastEligiblePosition }),
  });
}

function parseEvidenceState(bytes: Buffer): RecordEvidenceContinuationStateV1 {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!exactObject(value, [
    "version",
    "policyVersion",
    "rootCommitment",
    "invocationAudienceCommitment",
    "repositorySelectionCommitment",
    "graphStateCommitment",
    "traversalCheckpointRef",
  ])) throw new TypeError("invalid evidence state");
  const state = value as unknown as RecordEvidenceContinuationStateV1;
  assertRecordEvidenceContinuationStateV1(state);
  return Object.freeze({ ...state });
}

function invalid(label: "search" | "evidence"): never {
  throw new TypeError(`Record ${label} continuation is invalid`);
}

/** Server-keyed authenticated search tokens and confidential evidence tokens. */
export function createRecordSearchContinuationCodec(
  key: Uint8Array,
): RecordSearchContinuationCodec {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new TypeError("Record search continuation key must contain at least 32 bytes");
  }
  const ownedKey = key.slice();
  const authenticationKey = createHash("sha256")
    .update("nautilo-reflection-record-search-authentication-key-v1", "utf8")
    .update(ownedKey)
    .digest();
  const encryptionKey = createHash("sha256")
    .update("nautilo-reflection-record-evidence-encryption-key-v1", "utf8")
    .update(ownedKey)
    .digest();

  return Object.freeze({
    authenticateSearch(
      state: RecordSearchContinuationStateV1,
    ): RecordSearchContinuationToken {
      assertRecordSearchContinuationStateV1(state);
      const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
      const mac = createHmac("sha256", authenticationKey)
        .update(SEARCH_DOMAIN, "utf8")
        .update(payload, "utf8")
        .digest("base64url");
      const token = `${SEARCH_PREFIX}.${payload}.${mac}`;
      assertRecordSearchContinuationToken(token);
      return token;
    },

    verifySearch(
      token: RecordSearchContinuationToken,
    ): RecordSearchContinuationStateV1 {
      try {
        assertRecordSearchContinuationToken(token);
        const fields = token.split(".");
        if (fields.length !== 3 || fields[0] !== SEARCH_PREFIX) invalid("search");
        const payload = fields[1]!;
        const suppliedMac = canonicalBase64Url(fields[2]!);
        const expectedMac = createHmac("sha256", authenticationKey)
          .update(SEARCH_DOMAIN, "utf8")
          .update(payload, "utf8")
          .digest();
        if (
          suppliedMac.byteLength !== expectedMac.byteLength
          || !timingSafeEqual(suppliedMac, expectedMac)
        ) invalid("search");
        return parseSearchState(canonicalBase64Url(payload));
      } catch {
        return invalid("search");
      }
    },

    sealEvidence(
      state: RecordEvidenceContinuationStateV1,
    ): RecordEvidenceContinuationToken {
      assertRecordEvidenceContinuationStateV1(state);
      const plaintext = Buffer.from(JSON.stringify(state), "utf8");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      cipher.setAAD(EVIDENCE_AAD);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const token = `${EVIDENCE_PREFIX}.${Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString("base64url")}`;
      if (Buffer.byteLength(token, "utf8") > RECORD_SEARCH_POLICY_V1.evidenceContinuationBytesMaximum) {
        throw new RangeError("Record evidence continuation exceeds the V1 byte contract");
      }
      assertRecordEvidenceContinuationToken(token);
      return token;
    },

    openEvidence(
      token: RecordEvidenceContinuationToken,
    ): RecordEvidenceContinuationStateV1 {
      try {
        assertRecordEvidenceContinuationToken(token);
        const fields = token.split(".");
        if (fields.length !== 2 || fields[0] !== EVIDENCE_PREFIX) invalid("evidence");
        const sealed = canonicalBase64Url(fields[1]!);
        if (sealed.byteLength < 29) invalid("evidence");
        const nonce = sealed.subarray(0, 12);
        const tag = sealed.subarray(12, 28);
        const ciphertext = sealed.subarray(28);
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAAD(EVIDENCE_AAD);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return parseEvidenceState(plaintext);
      } catch {
        return invalid("evidence");
      }
    },
  });
}
