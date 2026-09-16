import { describe, expect, test } from "bun:test";
import type { FullEncryptionMessagePreparedRequestV2 } from "@nautilo/api-client";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  LatticeCrypto,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  encodeHumanAiReadableLiveShadowMessagePlan,
  encodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";
import {
  decodePreparedLiveShadowAttempt,
  destroyDecodedPreparedMessage,
  preparedAuthorizationSchemeMatchesWireFormat,
} from
  "../../src/messaging/decode-prepared-message";

const common = {
  status: "prepared" as const, operationId: "operation_m318",
  planBytesBase64url: "AQ", signedRequestBytesBase64url: "Ag",
  encryptedPayloadBytesBase64url: "Aw", accessManifestBytesBase64url: "BA",
  namespaceEnvelopeBytesBase64url: "BQ",
};
const full: FullEncryptionMessagePreparedRequestV2 = {
  ...common, requestVersion: 2, representationMode: "full_encryption",
  authorizationScheme: "human_peer_v1",
};

function humanAiReadableBytes(
  planFormatVersion: 1 | 2,
  requestFormatVersion = planFormatVersion,
): Readonly<{ plan: string; request: string }> {
  const crypto = new LatticeCrypto();
  const createdAt = unixTimestamp(1_800_000_000_000);
  const deadlineAt = unixTimestamp(1_800_000_030_000);
  const subjectHumanId = humanId("human_prepared_decoder");
  const committerDeviceId = cryptoDeviceId("device_prepared_decoder");
  const namespace = namespaceId("namespace_prepared_decoder");
  const planBytes = encodeHumanAiReadableLiveShadowMessagePlan({
    formatVersion: planFormatVersion,
    purpose: "message.human_ai_readable_live_shadow_plan",
    operationId: common.operationId,
    clientIdempotencyKey: "client_prepared_decoder",
    policyRevision: 4,
    sessionId: "10000000-0000-4000-8000-000000000322",
    roomId: "20000000-0000-4000-8000-000000000322",
    humanMessageId: 42,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt,
    subjectHumanId,
    committerDeviceId,
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(2),
    namespaceId: namespace,
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(3),
    namespaceKeyGeneration: namespaceGeneration(4),
    namespaceHeadDigest: new Uint8Array(32).fill(0x11),
    namespacePublicationDigest: new Uint8Array(32).fill(0x12),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x13),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x14),
    attemptCoordinate: "attempt_prepared_decoder",
    issuedAt: createdAt,
    deadlineAt,
  });
  const requestBytes = encodeHumanAiReadableLiveShadowMessageRequest({
    formatVersion: requestFormatVersion,
    purpose: "message.human_ai_readable_live_shadow_publish",
    normalizationVersion: 1,
    subjectHumanId,
    operationId: common.operationId,
    clientIdempotencyKey: "client_prepared_decoder",
    policyRevision: 4,
    sessionId: "10000000-0000-4000-8000-000000000322",
    roomId: "20000000-0000-4000-8000-000000000322",
    messageId: 42,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt,
    cryptoObjectId: objectId("message:prepared-decoder"),
    namespaceId: namespace,
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(3),
    namespaceKeyGeneration: namespaceGeneration(4),
    namespaceHeadDigest: new Uint8Array(32).fill(0x11),
    namespacePublicationDigest: new Uint8Array(32).fill(0x12),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x13),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x14),
    planDigest: crypto.hash(planBytes),
    plaintextPayloadDigest: new Uint8Array(32).fill(0x21),
    encryptedPayloadDigest: new Uint8Array(32).fill(0x22),
    manifestDigest: new Uint8Array(32).fill(0x23),
    envelopeDigest: new Uint8Array(32).fill(0x24),
    issuedAt: createdAt,
    deadlineAt,
    committerDeviceId,
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(2),
    signature: new Uint8Array(64).fill(0x31),
  });
  const result = {
    plan: Buffer.from(planBytes).toString("base64url"),
    request: Buffer.from(requestBytes).toString("base64url"),
  };
  planBytes.fill(0);
  requestBytes.fill(0);
  return result;
}

describe("canonical prepared Message transport decoder", () => {
  test.each(["foreground_session_v1", "human_peer_v1", "shared_agent_v1"] as const)("Full %s has no ordinary sibling", (authorizationScheme) => {
    const decoded = decodePreparedLiveShadowAttempt({ ...full, authorizationScheme });
    expect(decoded?.representationMode).toBe("full_encryption");
    expect(decoded).not.toHaveProperty("ordinaryPayloadBytes");
    expect(decoded?.encryptedPayloadBytes).toEqual(new Uint8Array([3]));
    if (!decoded) throw new Error("Expected Full decode");
    destroyDecodedPreparedMessage(decoded);
    expect(decoded.encryptedPayloadBytes).toEqual(new Uint8Array([0]));
  });
  test.each([
    ["human_ai_readable_v1", 1],
    ["human_ai_readable_v2", 2],
  ] as const)("Full %s admits only its exact framed format", (
    authorizationScheme,
    formatVersion,
  ) => {
    const bytes = humanAiReadableBytes(formatVersion);
    const attempt: FullEncryptionMessagePreparedRequestV2 = {
      ...full,
      authorizationScheme,
      planBytesBase64url: bytes.plan,
      signedRequestBytesBase64url: bytes.request,
    };
    expect(preparedAuthorizationSchemeMatchesWireFormat(attempt)).toBe(true);
    const decoded = decodePreparedLiveShadowAttempt(attempt);
    expect(decoded?.authorizationScheme).toBe(authorizationScheme);
    if (decoded) destroyDecodedPreparedMessage(decoded);
  });
  test.each([
    ["human_ai_readable_v1", 2, 2],
    ["human_ai_readable_v2", 1, 1],
    ["human_ai_readable_v2", 2, 1],
    ["human_ai_readable_v2", 1, 2],
  ] as const)("rejects substituted %s plan/request formats %d/%d", (
    authorizationScheme,
    planFormatVersion,
    requestFormatVersion,
  ) => {
    const bytes = humanAiReadableBytes(planFormatVersion, requestFormatVersion);
    const attempt: FullEncryptionMessagePreparedRequestV2 = {
      ...full,
      authorizationScheme,
      planBytesBase64url: bytes.plan,
      signedRequestBytesBase64url: bytes.request,
    };
    expect(preparedAuthorizationSchemeMatchesWireFormat(attempt)).toBe(false);
    expect(decodePreparedLiveShadowAttempt(attempt)).toBeNull();
  });
  test("keeps transport requestVersion independent from the V2 authorization format", () => {
    const bytes = humanAiReadableBytes(2);
    const decoded = decodePreparedLiveShadowAttempt({
      ...common,
      requestVersion: 1,
      authorizationScheme: "human_ai_readable_v2",
      planBytesBase64url: bytes.plan,
      signedRequestBytesBase64url: bytes.request,
      ordinaryPayloadBytesBase64url: "Bg",
    });
    expect(decoded?.representationMode).toBe("shadow_encryption");
    expect(decoded?.authorizationScheme).toBe("human_ai_readable_v2");
    if (decoded) destroyDecodedPreparedMessage(decoded);
  });
  test("retains the ordinary sibling only for Shadow", () => {
    const decoded = decodePreparedLiveShadowAttempt({ ...common, requestVersion: 1,
      ordinaryPayloadBytesBase64url: "Bg", authorizationScheme: "human_peer_v1" });
    expect(decoded?.representationMode).toBe("shadow_encryption");
    expect(decoded?.ordinaryPayloadBytes).toEqual(new Uint8Array([6]));
    if (!decoded) throw new Error("Expected Shadow decode");
    destroyDecodedPreparedMessage(decoded);
    expect(decoded.ordinaryPayloadBytes).toEqual(new Uint8Array([0]));
  });
  test("rejects ordinary bytes hidden in a Full object and non-canonical encoding", () => {
    const smuggled = { ...full, ordinaryPayloadBytesBase64url: "Bg" };
    expect(decodePreparedLiveShadowAttempt(smuggled)).toBeNull();
    expect(decodePreparedLiveShadowAttempt({ ...full, encryptedPayloadBytesBase64url: "Aw==" })).toBeNull();
    expect(decodePreparedLiveShadowAttempt({ ...full, encryptedPayloadBytesBase64url: "" })).toBeNull();
  });
  test("explicit grant form retains only the grant ciphertext", () => {
    const decoded = decodePreparedLiveShadowAttempt({ ...common,
      requestVersion: 2, representationMode: "full_encryption", grantBytesBase64url: "Bw" });
    expect(decoded?.authorizationScheme).toBeNull();
    expect(decoded?.grantBytes).toEqual(new Uint8Array([7]));
    if (decoded) destroyDecodedPreparedMessage(decoded);
  });
});
