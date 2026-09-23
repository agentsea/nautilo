import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  encodeHumanAiReadableLiveShadowMessageRequest,
} from "../../src/message/human-ai-readable-live-shadow-core.ts";
import {
  decodeHumanAiReadableLiveShadowMessagePlanV1,
  decodeHumanAiReadableLiveShadowMessageRequestV1,
  encodeHumanAiReadableLiveShadowMessagePlanV1,
  humanAiReadableLiveShadowMessageRequestDigestV1,
  prepareHumanAiReadableLiveShadowMessageRequestV1,
  verifyHumanAiReadableLiveShadowMessageRequestV1,
  type HumanAiReadableLiveShadowMessagePlanV1,
} from "../../src/message/human-ai-readable-live-shadow-v1.ts";
import {
  HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2,
  decodeHumanAiReadableLiveShadowMessagePlanV2,
  decodeHumanAiReadableLiveShadowMessageRequestV2,
  encodeHumanAiReadableLiveShadowMessagePlanV2,
  encodeHumanAiReadableLiveShadowMessageRequestV2,
  humanAiReadableLiveShadowMessagePlanDigestV2,
  prepareHumanAiReadableLiveShadowMessageRequestV2,
  verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2,
  verifyHumanAiReadableLiveShadowMessageRequestV2,
  type HumanAiReadableLiveShadowMessagePlanV2,
  type HumanAiReadableLiveShadowMessageRequestV2,
} from "../../src/message/human-ai-readable-live-shadow-v2.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_200_000_000;
const SESSION = "10000000-0000-4000-8000-000000000297";
const ROOM = "20000000-0000-4000-8000-000000000297";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture(ttlMs = HUMAN_AI_READABLE_LIVE_SHADOW_MAX_TTL_MS_V2) {
  const crypto = new LatticeCrypto(seededRng(297_001), { now: () => NOW });
  const senderSigning = crypto.generateSigningKeyPair();
  const plan: HumanAiReadableLiveShadowMessagePlanV2 = {
    formatVersion: 2,
    purpose: "message.human_ai_readable_live_shadow_plan",
    operationId: "human_ai_readable_operation_297",
    clientIdempotencyKey: "human_ai_readable_client_request_297",
    policyRevision: 8,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 297,
    revision: 0,
    transcriptOrdinal: 13,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId("human_sender_297"),
    committerDeviceId: cryptoDeviceId("device_sender_297"),
    committerDeviceSigningKeyGeneration: 4,
    hostAuthorizationRevision: authorizationRevision(10),
    namespaceId: namespaceId("namespace_shared_room_297"),
    keyClass: "ai",
    namespaceAccessRevision: 5,
    namespaceKeyGeneration: 6,
    namespaceHeadDigest: bytes(0x11),
    namespacePublicationDigest: bytes(0x12),
    namespacePublicationSetDigest: bytes(0x13),
    namespaceAudienceFingerprint: bytes(0x14),
    attemptCoordinate: "human_ai_readable_attempt_297",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + ttlMs),
  };
  const planBytes = encodeHumanAiReadableLiveShadowMessagePlanV2(plan);
  const requestInput = {
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
    cryptoObjectId: objectId("message:live-shadow:v2:human-ai-readable-297"),
    namespaceId: plan.namespaceId,
    keyClass: "ai",
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    planDigest: humanAiReadableLiveShadowMessagePlanDigestV2(planBytes),
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
  } as const;
  const request = prepareHumanAiReadableLiveShadowMessageRequestV2(
    crypto,
    requestInput,
  );
  return { crypto, plan, planBytes, request, requestInput, senderSigning };
}

function mutateRequest(
  request: HumanAiReadableLiveShadowMessageRequestV2,
  changes: Partial<HumanAiReadableLiveShadowMessageRequestV2>,
): Uint8Array {
  return encodeHumanAiReadableLiveShadowMessageRequestV2({
    ...request,
    ...changes,
  });
}

describe("Human AI-readable live Shadow V2", () => {
  test("admits the five-minute window until its exclusive deadline", () => {
    const value = fixture();
    const resolveCurrentAuthority = () => value.senderSigning.publicKey;

    expect(decodeHumanAiReadableLiveShadowMessagePlanV2(value.planBytes))
      .toMatchObject({ formatVersion: 2, deadlineAt: NOW + 300_000 });
    expect(verifyHumanAiReadableLiveShadowMessageRequestV2(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 299_999),
      resolveCurrentAuthority,
    }).formatVersion).toBe(2);
    for (const now of [NOW + 300_000, NOW + 300_001]) {
      expect(() => verifyHumanAiReadableLiveShadowMessageRequestV2(
        value.crypto,
        {
          requestBytes: value.request.bytes,
          now: unixTimestamp(now),
          resolveCurrentAuthority,
        },
      )).toThrow("not currently valid");
    }
  });

  test("rejects overlong windows and requests that are not issued yet", () => {
    const value = fixture();
    expect(() => encodeHumanAiReadableLiveShadowMessagePlanV2({
      ...value.plan,
      deadlineAt: unixTimestamp(NOW + 300_001),
    })).toThrow("lifetime is invalid");
    expect(() => prepareHumanAiReadableLiveShadowMessageRequestV2(
      value.crypto,
      {
        ...value.requestInput,
        deadlineAt: unixTimestamp(NOW + 300_001),
      },
    )).toThrow("lifetime is invalid");
    expect(() => verifyHumanAiReadableLiveShadowMessageRequestV2(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW - 1),
      resolveCurrentAuthority: () => value.senderSigning.publicKey,
    })).toThrow("not currently valid");
  });

  test("keeps named V1 and V2 decoding boundaries disjoint", () => {
    const v2 = fixture(30_000);
    const v1Plan: HumanAiReadableLiveShadowMessagePlanV1 = {
      ...v2.plan,
      formatVersion: 1,
    };
    const v1PlanBytes = encodeHumanAiReadableLiveShadowMessagePlanV1(v1Plan);
    const v1Request = prepareHumanAiReadableLiveShadowMessageRequestV1(
      v2.crypto,
      {
        ...v2.requestInput,
        planDigest: v2.crypto.hash(v1PlanBytes),
      },
    );
    const v2RequestSnapshot = v2.request.bytes.slice();

    expect(humanAiReadableLiveShadowMessageRequestDigestV1(v1Request.bytes))
      .toEqual(v2.crypto.hash(v1Request.bytes));
    expect(() => humanAiReadableLiveShadowMessageRequestDigestV1(
      v2.request.bytes,
    )).toThrow("V1 format mismatch");
    expect(v2.request.bytes).toEqual(v2RequestSnapshot);
    expect(() => decodeHumanAiReadableLiveShadowMessagePlanV1(v2.planBytes))
      .toThrow("V1 format mismatch");
    expect(() => decodeHumanAiReadableLiveShadowMessageRequestV1(v2.request.bytes))
      .toThrow("V1 format mismatch");
    expect(() => decodeHumanAiReadableLiveShadowMessagePlanV2(v1PlanBytes))
      .toThrow("V2 format mismatch");
    expect(() => decodeHumanAiReadableLiveShadowMessageRequestV2(v1Request.bytes))
      .toThrow("V2 format mismatch");
    v2RequestSnapshot.fill(0);
  });

  test("binds signatures to the versioned domain, room, and plan digest", () => {
    const value = fixture(30_000);
    const resolveCurrentAuthority = () => value.senderSigning.publicKey;
    const versionAndDomainChanged = encodeHumanAiReadableLiveShadowMessageRequest({
      ...value.request.request,
      formatVersion: 1,
    });
    const mutations = [
      mutateRequest(value.request.request, { roomId: SESSION }),
      mutateRequest(value.request.request, { planDigest: bytes(0x99) }),
    ];

    expect(() => verifyHumanAiReadableLiveShadowMessageRequestV1(
      value.crypto,
      {
        requestBytes: versionAndDomainChanged,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority,
      },
    )).toThrow("signature is invalid");
    for (const requestBytes of mutations) {
      expect(() => verifyHumanAiReadableLiveShadowMessageRequestV2(
        value.crypto,
        {
          requestBytes,
          now: unixTimestamp(NOW + 1),
          resolveCurrentAuthority,
        },
      )).toThrow("signature is invalid");
    }
  });

  test("allows expired exact replay only for the expected digest and current device", () => {
    const value = fixture();
    const resolveCurrentAuthority = () => value.senderSigning.publicKey;

    expect(() => verifyHumanAiReadableLiveShadowMessageRequestV2(value.crypto, {
      requestBytes: value.request.bytes,
      now: unixTimestamp(NOW + 300_000),
      resolveCurrentAuthority,
    })).toThrow("not currently valid");
    expect(verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2(
      value.crypto,
      {
        requestBytes: value.request.bytes,
        expectedRequestDigest: value.request.requestDigest,
        resolveCurrentAuthority,
      },
    ).operationId).toBe(value.plan.operationId);
    expect(() => verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2(
      value.crypto,
      {
        requestBytes: value.request.bytes,
        expectedRequestDigest: bytes(0x99),
        resolveCurrentAuthority,
      },
    )).toThrow("durable request digest disagrees");
    expect(() => verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2(
      value.crypto,
      {
        requestBytes: value.request.bytes,
        expectedRequestDigest: value.request.requestDigest,
        resolveCurrentAuthority: () => null,
      },
    )).toThrow("authority is unavailable");
    const differentDevice = value.crypto.generateSigningKeyPair();
    expect(() => verifyHumanAiReadableLiveShadowMessageRequestExactReplayV2(
      value.crypto,
      {
        requestBytes: value.request.bytes,
        expectedRequestDigest: value.request.requestDigest,
        resolveCurrentAuthority: () => differentDevice.publicKey,
      },
    )).toThrow("signature is invalid");
  });
});


describe("signed room-wide mention intent", () => {
  test("retains old plan bytes and binds the opt-in audience into the digest", () => {
    const value = fixture();
    const addressed = encodeHumanAiReadableLiveShadowMessagePlanV2({ ...value.plan, mentionEveryone: true });
    expect(decodeHumanAiReadableLiveShadowMessagePlanV2(value.planBytes)).not.toHaveProperty("mentionEveryone");
    expect(encodeHumanAiReadableLiveShadowMessagePlanV2(decodeHumanAiReadableLiveShadowMessagePlanV2(value.planBytes))).toEqual(value.planBytes);
    expect(decodeHumanAiReadableLiveShadowMessagePlanV2(addressed).mentionEveryone).toBe(true);
    expect(encodeHumanAiReadableLiveShadowMessagePlanV2(decodeHumanAiReadableLiveShadowMessagePlanV2(addressed))).toEqual(addressed);
    expect(humanAiReadableLiveShadowMessagePlanDigestV2(addressed)).not.toEqual(humanAiReadableLiveShadowMessagePlanDigestV2(value.planBytes));
    expect(() => encodeHumanAiReadableLiveShadowMessagePlanV2({ ...value.plan, mentionEveryone: false } as unknown as HumanAiReadableLiveShadowMessagePlanV2)).toThrow();
    expect(() => decodeHumanAiReadableLiveShadowMessagePlanV2(new Uint8Array([...addressed, 0]))).toThrow();
    const corrupted = addressed.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    expect(() => decodeHumanAiReadableLiveShadowMessagePlanV2(corrupted)).toThrow();
  });
});
