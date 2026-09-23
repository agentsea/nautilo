import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeHumanPeerLiveShadowAcknowledgementV1,
  decodeHumanPeerLiveShadowMessagePlanV1,
  decodeHumanPeerLiveShadowMessageRequestV1,
  encodeHumanPeerLiveShadowAcknowledgementV1,
  encodeHumanPeerLiveShadowMessagePlanV1,
  encodeHumanPeerLiveShadowMessageRequestV1,
  humanPeerLiveShadowAcknowledgementDigestV1,
  humanPeerLiveShadowMessagePlanDigestV1,
  prepareHumanPeerLiveShadowAcknowledgementV1,
  prepareHumanPeerLiveShadowMessageRequestV1,
  verifyHumanPeerLiveShadowAcknowledgementV1,
  verifyHumanPeerLiveShadowMessageRequestExactReplayV1,
  verifyHumanPeerLiveShadowMessageRequestV1,
  type HumanPeerLiveShadowAcknowledgementV1,
  type HumanPeerLiveShadowMessagePlanV1,
  type HumanPeerLiveShadowMessageRequestV1,
} from "../../src/message/human-peer-live-shadow-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_100_000_000;
const SESSION = "10000000-0000-4000-8000-000000000295";
const ROOM = "20000000-0000-4000-8000-000000000295";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(295_001), { now: () => NOW });
  const senderSigning = crypto.generateSigningKeyPair();
  const recipientSigning = crypto.generateSigningKeyPair();
  const plan: HumanPeerLiveShadowMessagePlanV1 = {
    formatVersion: 1,
    purpose: "message.human_peer_live_shadow_plan",
    operationId: "human_peer_operation_295",
    clientIdempotencyKey: "human_peer_client_request_295",
    policyRevision: 7,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 295,
    revision: 0,
    transcriptOrdinal: 12,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId("human_sender_295"),
    committerDeviceId: cryptoDeviceId("device_sender_295"),
    committerDeviceSigningKeyGeneration: 3,
    hostAuthorizationRevision: authorizationRevision(9),
    namespaceId: namespaceId("namespace_human_room_295"),
    keyClass: "human",
    namespaceAccessRevision: 4,
    namespaceKeyGeneration: 5,
    namespaceHeadDigest: bytes(0x11),
    namespacePublicationDigest: bytes(0x12),
    namespacePublicationSetDigest: bytes(0x13),
    namespaceAudienceFingerprint: bytes(0x14),
    attemptCoordinate: "human_peer_attempt_295",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeHumanPeerLiveShadowMessagePlanV1(plan);
  const request = prepareHumanPeerLiveShadowMessageRequestV1(crypto, {
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
    cryptoObjectId: objectId("message:live-shadow:v1:human-peer-295"),
    namespaceId: plan.namespaceId,
    keyClass: "human",
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    planDigest: humanPeerLiveShadowMessagePlanDigestV1(planBytes),
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
  const acknowledgement = prepareHumanPeerLiveShadowAcknowledgementV1(
    crypto,
    {
      subjectHumanId: humanId("human_recipient_295"),
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
      committerDeviceId: cryptoDeviceId("device_recipient_295"),
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
  request: HumanPeerLiveShadowMessageRequestV1,
  changes: Partial<HumanPeerLiveShadowMessageRequestV1>,
): Uint8Array {
  return encodeHumanPeerLiveShadowMessageRequestV1({ ...request, ...changes });
}

function mutateAcknowledgement(
  acknowledgement: HumanPeerLiveShadowAcknowledgementV1,
  changes: Partial<HumanPeerLiveShadowAcknowledgementV1>,
): Uint8Array {
  return encodeHumanPeerLiveShadowAcknowledgementV1({
    ...acknowledgement,
    ...changes,
  });
}

describe("Human-peer live Shadow V1 bytes", () => {
  test("pins canonical plan, request, and recipient acknowledgement", () => {
    const value = fixture();
    expect(encodeHumanPeerLiveShadowMessagePlanV1(
      decodeHumanPeerLiveShadowMessagePlanV1(value.planBytes),
    )).toEqual(value.planBytes);
    expect(encodeHumanPeerLiveShadowMessageRequestV1(
      decodeHumanPeerLiveShadowMessageRequestV1(value.request.bytes),
    )).toEqual(value.request.bytes);
    expect(encodeHumanPeerLiveShadowAcknowledgementV1(
      decodeHumanPeerLiveShadowAcknowledgementV1(value.acknowledgement.bytes),
    )).toEqual(value.acknowledgement.bytes);
    expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
      .toBe("f7020fdb3e80ed8b544df2c2cdcd0e6a05bc3da9e3e66234e884a2b7684a1855");
    expect(Buffer.from(value.crypto.hash(value.request.bytes)).toString("hex"))
      .toBe("4c23540f0ff4d24b5bae2841b0307e3f51d5a70be02764f75829ffd33a8044e2");
    expect(Buffer.from(value.crypto.hash(value.acknowledgement.bytes)).toString("hex"))
      .toBe("bfd5e006afef56e17b446222c1b9f73128751d416a94613cae5e7b08bde7e07a");
  });

  test("verifies fresh and exact durable-replay requests", () => {
    const value = fixture();
    expect(verifyHumanPeerLiveShadowMessageRequestV1(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).operationId).toBe(value.plan.operationId);
    expect(verifyHumanPeerLiveShadowMessageRequestExactReplayV1(value.crypto, {
      requestBytes: value.request.bytes,
      expectedRequestDigest: value.request.requestDigest,
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    }).clientIdempotencyKey).toBe(value.plan.clientIdempotencyKey);
    expect(() => verifyHumanPeerLiveShadowMessageRequestV1(value.crypto, {
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
        clientIdempotencyKey: "human_peer_client_request_changed",
      }),
      mutateRequest(value.request.request, { roomId: SESSION }),
      mutateRequest(value.request.request, {
        signature: new Uint8Array(64).fill(0x99),
      }),
    ]) {
      expect(() => verifyHumanPeerLiveShadowMessageRequestV1(value.crypto, {
        requestBytes: mutatedBytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: () => value.senderSigning.publicKey,
      })).toThrow();
    }
    expect(() => encodeHumanPeerLiveShadowMessageRequestV1({
      ...value.request.request,
      role: "assistant" as "user",
    })).toThrow("shape is invalid");
    expect(() => decodeHumanPeerLiveShadowMessageRequestV1(
      value.request.bytes.slice(0, -1),
    )).toThrow();
    expect(() => decodeHumanPeerLiveShadowMessageRequestV1(
      new Uint8Array([...value.request.bytes, 0]),
    )).toThrow();
  });

  test("authenticates each recipient-device result independently", () => {
    const value = fixture();
    expect(verifyHumanPeerLiveShadowAcknowledgementV1(value.crypto, {
      bytes: value.acknowledgement.bytes,
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    }).status).toBe("verified");
    expect(humanPeerLiveShadowAcknowledgementDigestV1(
      value.acknowledgement.bytes,
    )).toEqual(value.acknowledgement.acknowledgementDigest);
    expect(() => mutateAcknowledgement(value.acknowledgement.acknowledgement, {
      status: "fallback",
    })).toThrow("shape is invalid");
    expect(() => verifyHumanPeerLiveShadowAcknowledgementV1(value.crypto, {
      bytes: mutateAcknowledgement(
        value.acknowledgement.acknowledgement,
        { transcriptOrdinal: 13 },
      ),
      now: unixTimestamp(NOW + 2),
      resolveCurrentAuthority: () => value.recipientSigning.publicKey,
    })).toThrow("signature is invalid");
  });
});


describe("signed room-wide mention intent", () => {
  test("retains old plan bytes and binds the opt-in audience into the digest", () => {
    const value = fixture();
    const addressed = encodeHumanPeerLiveShadowMessagePlanV1({ ...value.plan, mentionEveryone: true });
    expect(decodeHumanPeerLiveShadowMessagePlanV1(value.planBytes)).not.toHaveProperty("mentionEveryone");
    expect(encodeHumanPeerLiveShadowMessagePlanV1(decodeHumanPeerLiveShadowMessagePlanV1(value.planBytes))).toEqual(value.planBytes);
    expect(decodeHumanPeerLiveShadowMessagePlanV1(addressed).mentionEveryone).toBe(true);
    expect(encodeHumanPeerLiveShadowMessagePlanV1(decodeHumanPeerLiveShadowMessagePlanV1(addressed))).toEqual(addressed);
    expect(humanPeerLiveShadowMessagePlanDigestV1(addressed)).not.toEqual(humanPeerLiveShadowMessagePlanDigestV1(value.planBytes));
    expect(() => encodeHumanPeerLiveShadowMessagePlanV1({ ...value.plan, mentionEveryone: false } as unknown as HumanPeerLiveShadowMessagePlanV1)).toThrow();
    expect(() => decodeHumanPeerLiveShadowMessagePlanV1(new Uint8Array([...addressed, 0]))).toThrow();
    const corrupted = addressed.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    expect(() => decodeHumanPeerLiveShadowMessagePlanV1(corrupted)).toThrow();
  });
});
