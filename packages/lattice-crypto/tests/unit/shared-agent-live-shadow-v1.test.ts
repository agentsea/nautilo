import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeSharedAgentLiveShadowAcknowledgementV1,
  decodeSharedAgentLiveShadowMessagePlanV1,
  decodeSharedAgentLiveShadowMessageRequestV1,
  encodeSharedAgentLiveShadowAcknowledgementV1,
  encodeSharedAgentLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessageRequestV1,
  sharedAgentLiveShadowAcknowledgementDigestV1,
  sharedAgentLiveShadowExecutionInputSetDigestV1,
  sharedAgentLiveShadowMessagePlanDigestV1,
  prepareSharedAgentLiveShadowAcknowledgementV1,
  prepareSharedAgentLiveShadowMessageRequestV1,
  verifySharedAgentLiveShadowAcknowledgementV1,
  verifySharedAgentLiveShadowMessageRequestExactReplayV1,
  verifySharedAgentLiveShadowMessageRequestV1,
  type SharedAgentLiveShadowAcknowledgementV1,
  type SharedAgentLiveShadowMessagePlanV1,
  type SharedAgentLiveShadowMessageRequestV1,
} from "../../src/message/shared-agent-live-shadow-v1.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_100_000_000;
const SESSION = "10000000-0000-4000-8000-000000000296";
const ROOM = "20000000-0000-4000-8000-000000000296";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(296_001), { now: () => NOW });
  const senderSigning = crypto.generateSigningKeyPair();
  const recipientSigning = crypto.generateSigningKeyPair();
  const plan: SharedAgentLiveShadowMessagePlanV1 = {
    formatVersion: 1,
    purpose: "message.shared_agent_live_shadow_plan",
    operationId: "shared_agent_operation_296",
    clientIdempotencyKey: "shared_agent_client_request_296",
    policyRevision: 7,
    sessionId: SESSION,
    roomId: ROOM,
    recipientAgentId: agentId("agent_shared_296"),
    humanMessageId: 296,
    revision: 0,
    transcriptOrdinal: 12,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId("human_sender_296"),
    committerDeviceId: cryptoDeviceId("device_sender_296"),
    committerDeviceSigningKeyGeneration: 3,
    hostAuthorizationRevision: authorizationRevision(9),
    namespaceId: namespaceId("namespace_shared_room_296"),
    keyClass: "ai",
    namespaceAccessRevision: 4,
    namespaceKeyGeneration: 5,
    namespaceHeadDigest: bytes(0x11),
    namespacePublicationDigest: bytes(0x12),
    namespacePublicationSetDigest: bytes(0x13),
    namespaceAudienceFingerprint: bytes(0x14),
    attemptCoordinate: "shared_agent_attempt_296",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeSharedAgentLiveShadowMessagePlanV1(plan);
  const request = prepareSharedAgentLiveShadowMessageRequestV1(crypto, {
    subjectHumanId: plan.subjectHumanId,
    operationId: plan.operationId,
    clientIdempotencyKey: plan.clientIdempotencyKey,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    recipientAgentId: plan.recipientAgentId,
    messageId: plan.humanMessageId,
    revision: 0,
    transcriptOrdinal: plan.transcriptOrdinal,
    role: "user",
    createdAt: plan.createdAt,
    cryptoObjectId: objectId("message:live-shadow:v1:shared-agent-295"),
    namespaceId: plan.namespaceId,
    keyClass: "ai",
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    planDigest: sharedAgentLiveShadowMessagePlanDigestV1(planBytes),
    plaintextPayloadDigest: bytes(0x21),
    encryptedPayloadDigest: bytes(0x22),
    manifestDigest: bytes(0x23),
    envelopeDigest: bytes(0x24),
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningKeyGeneration:
      plan.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    committerSigningPublicKey: senderSigning.publicKey,
    committerSigningPrivateKey: senderSigning.privateKey,
  });
  const acknowledgement = prepareSharedAgentLiveShadowAcknowledgementV1(
    crypto,
    {
      subjectHumanId: humanId("human_recipient_296"),
      operationId: plan.operationId,
      clientIdempotencyKey: plan.clientIdempotencyKey,
      policyRevision: plan.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      recipientAgentId: plan.recipientAgentId,
      messageId: plan.humanMessageId,
      revision: 0,
      transcriptOrdinal: plan.transcriptOrdinal,
      cryptoObjectId: request.request.cryptoObjectId,
      protectedMessageDigest: bytes(0x31),
      ordinaryPayloadDigest: request.request.plaintextPayloadDigest,
      status: "verified",
      reason: "matched",
      issuedAt: unixTimestamp(NOW + 1),
      deadlineAt: unixTimestamp(NOW + 30_000),
      committerDeviceId: cryptoDeviceId("device_recipient_296"),
      committerDeviceSigningKeyGeneration: 8,
      hostAuthorizationRevision: authorizationRevision(11),
      committerSigningPublicKey: recipientSigning.publicKey,
      committerSigningPrivateKey: recipientSigning.privateKey,
    },
  );
  return {
    acknowledgement,
    crypto,
    plan,
    planBytes,
    recipientSigning,
    request,
    senderSigning,
  };
}

function mutateRequest(
  request: SharedAgentLiveShadowMessageRequestV1,
  changes: Partial<SharedAgentLiveShadowMessageRequestV1>,
): Uint8Array {
  return encodeSharedAgentLiveShadowMessageRequestV1({ ...request, ...changes });
}

function mutateAcknowledgement(
  acknowledgement: SharedAgentLiveShadowAcknowledgementV1,
  changes: Partial<SharedAgentLiveShadowAcknowledgementV1>,
): Uint8Array {
  return encodeSharedAgentLiveShadowAcknowledgementV1({
    ...acknowledgement,
    ...changes,
  });
}

describe("Shared-Agent live Shadow V1 bytes", () => {
  test("binds the exact ordered coalesced execution input set", () => {
    const crypto = new LatticeCrypto(seededRng(296_002));
    const first = sharedAgentLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_b", messageId: 102 },
    ]);
    expect(first).toHaveLength(32);
    expect(sharedAgentLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_b", messageId: 102 },
      { operationId: "operation_a", messageId: 101 },
    ])).not.toEqual(first);
    expect(sharedAgentLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_b", messageId: 103 },
    ])).not.toEqual(first);
    expect(() => sharedAgentLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_a", messageId: 101 },
    ])).toThrow("duplicated");
  });

  test("pins canonical plan, request, and recipient acknowledgement", () => {
    const value = fixture();
    expect(encodeSharedAgentLiveShadowMessagePlanV1(
      decodeSharedAgentLiveShadowMessagePlanV1(value.planBytes),
    )).toEqual(value.planBytes);
    expect(encodeSharedAgentLiveShadowMessageRequestV1(
      decodeSharedAgentLiveShadowMessageRequestV1(value.request.bytes),
    )).toEqual(value.request.bytes);
    expect(encodeSharedAgentLiveShadowAcknowledgementV1(
      decodeSharedAgentLiveShadowAcknowledgementV1(value.acknowledgement.bytes),
    )).toEqual(value.acknowledgement.bytes);
    expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
      .toBe("168adcd3507b8bc31fa28315df6b59ee6da1917fd4ad9d79e3e2a3e8057499ec");
    expect(Buffer.from(value.crypto.hash(value.request.bytes)).toString("hex"))
      .toBe("4aa83343bfbbee3caefde36798a75410d0f81ac6253a36dac4f706b837ea0b6f");
    expect(Buffer.from(value.crypto.hash(value.acknowledgement.bytes)).toString("hex"))
      .toBe("d7a75fd27fa1a9139ff60bb8cbd1bd19d64b54f5907a69b37e523f9863f9da37");
  });

  test("verifies fresh and exact durable-replay requests", () => {
    const value = fixture();
    expect(verifySharedAgentLiveShadowMessageRequestV1(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).operationId).toBe(value.plan.operationId);
    expect(verifySharedAgentLiveShadowMessageRequestExactReplayV1(value.crypto, {
      requestBytes: value.request.bytes,
      expectedRequestDigest: value.request.requestDigest,
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).clientIdempotencyKey).toBe(value.plan.clientIdempotencyKey);
    expect(() => verifySharedAgentLiveShadowMessageRequestV1(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 30_000),
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    })).toThrow("not currently valid");
  });

  test("rejects transcript, role, identity, and signature substitution", () => {
    const value = fixture();
    for (const mutatedBytes of [
      mutateRequest(value.request.request, { transcriptOrdinal: 13 }),
      mutateRequest(value.request.request, {
        clientIdempotencyKey: "shared_agent_client_request_changed",
      }),
      mutateRequest(value.request.request, { roomId: SESSION }),
      mutateRequest(value.request.request, {
        signature: new Uint8Array(64).fill(0x99),
      }),
    ]) {
      expect(() => verifySharedAgentLiveShadowMessageRequestV1(value.crypto, {
        requestBytes: mutatedBytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: () => value.senderSigning.publicKey,
      })).toThrow();
    }
    expect(() => encodeSharedAgentLiveShadowMessageRequestV1({
      ...value.request.request,
      role: "assistant" as "user",
    })).toThrow("shape is invalid");
    expect(() => decodeSharedAgentLiveShadowMessageRequestV1(
      value.request.bytes.slice(0, -1),
    )).toThrow();
    expect(() => decodeSharedAgentLiveShadowMessageRequestV1(
      new Uint8Array([...value.request.bytes, 0]),
    )).toThrow();
  });

  test("authenticates each recipient-device result independently", () => {
    const value = fixture();
    expect(verifySharedAgentLiveShadowAcknowledgementV1(value.crypto, {
      bytes: value.acknowledgement.bytes,
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    }).status).toBe("verified");
    expect(sharedAgentLiveShadowAcknowledgementDigestV1(
      value.acknowledgement.bytes,
    )).toEqual(value.acknowledgement.acknowledgementDigest);
    expect(() => mutateAcknowledgement(value.acknowledgement.acknowledgement, {
      status: "fallback",
    })).toThrow("shape is invalid");
    expect(() => verifySharedAgentLiveShadowAcknowledgementV1(value.crypto, {
      bytes: mutateAcknowledgement(
        value.acknowledgement.acknowledgement,
        { transcriptOrdinal: 13 },
      ),
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    })).toThrow("signature is invalid");
  });
});
