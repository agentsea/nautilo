import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanAiReadableLiveShadowAcknowledgementV1,
  decodeHumanAiReadableLiveShadowMessagePlanV1,
  decodeHumanAiReadableLiveShadowMessageRequestV1,
  encodeHumanAiReadableLiveShadowAcknowledgementV1,
  encodeHumanAiReadableLiveShadowMessagePlanV1,
  encodeHumanAiReadableLiveShadowMessageRequestV1,
  humanAiReadableLiveShadowAcknowledgementDigestV1,
  humanAiReadableLiveShadowExecutionInputSetDigestV1,
  humanAiReadableLiveShadowMessagePlanDigestV1,
  prepareHumanAiReadableLiveShadowAcknowledgementV1,
  prepareHumanAiReadableLiveShadowMessageRequestV1,
  verifyHumanAiReadableLiveShadowAcknowledgementV1,
  verifyHumanAiReadableLiveShadowMessageRequestExactReplayV1,
  verifyHumanAiReadableLiveShadowMessageRequestV1,
  type HumanAiReadableLiveShadowAcknowledgementV1,
  type HumanAiReadableLiveShadowMessagePlanV1,
  type HumanAiReadableLiveShadowMessageRequestV1,
} from "../../src/message/human-ai-readable-live-shadow-v1.ts";
import {
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
  const plan: HumanAiReadableLiveShadowMessagePlanV1 = {
    formatVersion: 1,
    purpose: "message.human_ai_readable_live_shadow_plan",
    operationId: "human_ai_readable_operation_296",
    clientIdempotencyKey: "human_ai_readable_client_request_296",
    policyRevision: 7,
    sessionId: SESSION,
    roomId: ROOM,
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
    attemptCoordinate: "human_ai_readable_attempt_296",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeHumanAiReadableLiveShadowMessagePlanV1(plan);
  const request = prepareHumanAiReadableLiveShadowMessageRequestV1(crypto, {
    subjectHumanId: plan.subjectHumanId,
    operationId: plan.operationId,
    clientIdempotencyKey: plan.clientIdempotencyKey,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    messageId: plan.humanMessageId,
    revision: 0,
    transcriptOrdinal: plan.transcriptOrdinal,
    role: "user",
    createdAt: plan.createdAt,
    cryptoObjectId: objectId("message:live-shadow:v1:human-ai-readable-295"),
    namespaceId: plan.namespaceId,
    keyClass: "ai",
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    planDigest: humanAiReadableLiveShadowMessagePlanDigestV1(planBytes),
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
  const acknowledgement = prepareHumanAiReadableLiveShadowAcknowledgementV1(
    crypto,
    {
      subjectHumanId: humanId("human_recipient_296"),
      operationId: plan.operationId,
      clientIdempotencyKey: plan.clientIdempotencyKey,
      policyRevision: plan.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
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
  request: HumanAiReadableLiveShadowMessageRequestV1,
  changes: Partial<HumanAiReadableLiveShadowMessageRequestV1>,
): Uint8Array {
  return encodeHumanAiReadableLiveShadowMessageRequestV1({ ...request, ...changes });
}

function mutateAcknowledgement(
  acknowledgement: HumanAiReadableLiveShadowAcknowledgementV1,
  changes: Partial<HumanAiReadableLiveShadowAcknowledgementV1>,
): Uint8Array {
  return encodeHumanAiReadableLiveShadowAcknowledgementV1({
    ...acknowledgement,
    ...changes,
  });
}

describe("Human AI-readable live Shadow V1 bytes", () => {
  test("binds the exact ordered coalesced execution input set", () => {
    const crypto = new LatticeCrypto(seededRng(296_002));
    const first = humanAiReadableLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_b", messageId: 102 },
    ]);
    expect(first).toHaveLength(32);
    expect(humanAiReadableLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_b", messageId: 102 },
      { operationId: "operation_a", messageId: 101 },
    ])).not.toEqual(first);
    expect(humanAiReadableLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_b", messageId: 103 },
    ])).not.toEqual(first);
    expect(() => humanAiReadableLiveShadowExecutionInputSetDigestV1(crypto, [
      { operationId: "operation_a", messageId: 101 },
      { operationId: "operation_a", messageId: 101 },
    ])).toThrow("duplicated");
  });

  test("pins canonical plan, request, and recipient acknowledgement", () => {
    const value = fixture();
    expect(encodeHumanAiReadableLiveShadowMessagePlanV1(
      decodeHumanAiReadableLiveShadowMessagePlanV1(value.planBytes),
    )).toEqual(value.planBytes);
    expect(encodeHumanAiReadableLiveShadowMessageRequestV1(
      decodeHumanAiReadableLiveShadowMessageRequestV1(value.request.bytes),
    )).toEqual(value.request.bytes);
    expect(encodeHumanAiReadableLiveShadowAcknowledgementV1(
      decodeHumanAiReadableLiveShadowAcknowledgementV1(value.acknowledgement.bytes),
    )).toEqual(value.acknowledgement.bytes);
    expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
      .toBe("645b210a60625fed1c3c8b3d024c3d8ce42a08beff55f6b8138a7a1b3dc651cd");
    expect(Buffer.from(value.crypto.hash(value.request.bytes)).toString("hex"))
      .toBe("5ea7c3525cfdbd6d5a32312c62151799debc9e523059470e48be652edbb3bf28");
    expect(Buffer.from(value.crypto.hash(value.acknowledgement.bytes)).toString("hex"))
      .toBe("5e5d96355e7161213008b719406e84d2d73ac9b560bf89b2678900d4932c539d");
  });

  test("verifies fresh and exact durable-replay requests", () => {
    const value = fixture();
    expect(verifyHumanAiReadableLiveShadowMessageRequestV1(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).operationId).toBe(value.plan.operationId);
    expect(verifyHumanAiReadableLiveShadowMessageRequestExactReplayV1(value.crypto, {
      requestBytes: value.request.bytes,
      expectedRequestDigest: value.request.requestDigest,
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).clientIdempotencyKey).toBe(value.plan.clientIdempotencyKey);
    expect(() => verifyHumanAiReadableLiveShadowMessageRequestV1(value.crypto, {
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
        clientIdempotencyKey: "human_ai_readable_client_request_changed",
      }),
      mutateRequest(value.request.request, { roomId: SESSION }),
      mutateRequest(value.request.request, {
        signature: new Uint8Array(64).fill(0x99),
      }),
    ]) {
      expect(() => verifyHumanAiReadableLiveShadowMessageRequestV1(value.crypto, {
        requestBytes: mutatedBytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: () => value.senderSigning.publicKey,
      })).toThrow();
    }
    expect(() => encodeHumanAiReadableLiveShadowMessageRequestV1({
      ...value.request.request,
      role: "assistant" as "user",
    })).toThrow("shape is invalid");
    expect(() => decodeHumanAiReadableLiveShadowMessageRequestV1(
      value.request.bytes.slice(0, -1),
    )).toThrow();
    expect(() => decodeHumanAiReadableLiveShadowMessageRequestV1(
      new Uint8Array([...value.request.bytes, 0]),
    )).toThrow();
    expect(() => encodeHumanAiReadableLiveShadowMessagePlanV1({
      ...value.plan,
      recipientAgentId: "agent:injected",
    } as typeof value.plan)).toThrow("invalid field set");
    expect(() => encodeHumanAiReadableLiveShadowMessageRequestV1({
      ...value.request.request,
      recipientAgentId: "agent:injected",
    } as typeof value.request.request)).toThrow("invalid field set");
  });

  test("authenticates each recipient-device result independently", () => {
    const value = fixture();
    expect(verifyHumanAiReadableLiveShadowAcknowledgementV1(value.crypto, {
      bytes: value.acknowledgement.bytes,
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    }).status).toBe("verified");
    expect(humanAiReadableLiveShadowAcknowledgementDigestV1(
      value.acknowledgement.bytes,
    )).toEqual(value.acknowledgement.acknowledgementDigest);
    expect(() => mutateAcknowledgement(value.acknowledgement.acknowledgement, {
      status: "fallback",
    })).toThrow("shape is invalid");
    expect(() => verifyHumanAiReadableLiveShadowAcknowledgementV1(value.crypto, {
      bytes: mutateAcknowledgement(
        value.acknowledgement.acknowledgement,
        { transcriptOrdinal: 13 },
      ),
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    })).toThrow("signature is invalid");
  });
});
