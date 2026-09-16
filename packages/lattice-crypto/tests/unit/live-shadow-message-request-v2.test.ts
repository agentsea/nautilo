import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createNamespaceAgentGrantPlanV1,
  destroyNamespaceAgentGrantPlanV1,
  serializeNamespaceAgentGrantPlanV1,
} from "../../src/format/namespace-agent-grant-v1.ts";
import {
  decodeHumanLiveShadowMessageRequestV2,
  decodeLiveShadowMessagePlanV2,
  encodeHumanLiveShadowMessageRequestV2,
  encodeLiveShadowMessagePlanV2,
  humanLiveShadowMessageRequestDigestV2,
  liveShadowMessagePlanDigestV2,
  prepareHumanLiveShadowMessageRequestV2,
  verifyHumanLiveShadowMessageRequestExactReplayV2,
  verifyHumanLiveShadowMessageRequestV2,
  type HumanLiveShadowMessageRequestV2,
  type LiveShadowMessagePlanV2,
} from "../../src/message/live-shadow-message-request-v2.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;
const SESSION = "10000000-0000-4000-8000-000000000290";
const ROOM = "20000000-0000-4000-8000-000000000290";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(290_020), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const currentNamespace = namespaceId("namespace_room_m290");
  const agentGrantPlan = createNamespaceAgentGrantPlanV1(crypto, {
    operationId: "operation_live_m290",
    policyRevision: 5,
    sessionId: SESSION,
    roomId: ROOM,
    subjectHumanId: humanId("human_live_m290"),
    issuingDeviceId: cryptoDeviceId("device_browser_m290"),
    issuingDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(9),
    recipientAgentId: agentId("agent_live_m290"),
    recipientKeyId: "recipient_key_live_m290",
    operations: Object.freeze(["decrypt", "encrypt"]),
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    maximumSecretBytes: 16_384,
    authority: Object.freeze([
      Object.freeze({
        namespaceId: namespaceId("namespace_memory_m290"),
        keyClass: "ai" as const,
        firstRetainedGeneration: namespaceGeneration(0),
        currentGeneration: namespaceGeneration(1),
        retainedGenerations: Object.freeze([0, 1].map((generation) =>
          Object.freeze({
            generation: namespaceGeneration(generation),
            accessRevision: accessRevision(2),
            headDigest: bytes(0x11),
            publicationDigest: bytes(0x31),
            publicationSetDigest: bytes(0x41),
            audienceFingerprint: bytes(0x21),
          })
        )),
        agentAuthorizationRevision: authorizationRevision(4),
      }),
      Object.freeze({
        namespaceId: currentNamespace,
        keyClass: "ai" as const,
        firstRetainedGeneration: namespaceGeneration(0),
        currentGeneration: namespaceGeneration(4),
        retainedGenerations: Object.freeze([0, 1, 2, 3, 4].map(
          (generation) => Object.freeze({
            generation: namespaceGeneration(generation),
            accessRevision: accessRevision(3),
            headDigest: bytes(0x12),
            publicationDigest: bytes(0x32),
            publicationSetDigest: bytes(0x42),
            audienceFingerprint: bytes(0x22),
          }),
        )),
        agentAuthorizationRevision: authorizationRevision(6),
      }),
    ]),
  });
  const agentGrantPlanBytes = serializeNamespaceAgentGrantPlanV1(agentGrantPlan);
  const plan: LiveShadowMessagePlanV2 = Object.freeze({
    formatVersion: 2,
    purpose: "message.live_shadow_plan",
    operationId: agentGrantPlan.operationId,
    policyRevision: agentGrantPlan.policyRevision,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 290,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: agentGrantPlan.subjectHumanId,
    committerDeviceId: agentGrantPlan.issuingDeviceId,
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: agentGrantPlan.hostAuthorizationRevision,
    recipientAgentId: agentGrantPlan.recipientAgentId,
    agentAuthorizationRevision: authorizationRevision(6),
    agentRuntimeGeneration: 3,
    agentSignerKeyId: `agent_runtime_signer_${"a".repeat(64)}`,
    agentSignerPublicKey: new Uint8Array(32).fill(0x31),
    namespaceId: currentNamespace,
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    namespaceHeadDigest: bytes(0x12),
    namespacePublicationDigest: bytes(0x32),
    namespacePublicationSetDigest: bytes(0x42),
    namespaceAudienceFingerprint: bytes(0x22),
    agentGrantPlanBytes,
    agentGrantPlanDigest: crypto.hash(agentGrantPlanBytes),
    recipientId: "recipient_live_m290",
    recipientKeyId: agentGrantPlan.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(0x41),
    attemptCoordinate: "attempt_live_m290",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  });
  const planBytes = encodeLiveShadowMessagePlanV2(plan);
  const created = prepareHumanLiveShadowMessageRequestV2(crypto, {
    subjectHumanId: plan.subjectHumanId,
    operationId: plan.operationId,
    policyRevision: plan.policyRevision,
    sessionId: plan.sessionId,
    roomId: plan.roomId,
    messageId: plan.humanMessageId,
    revision: 0,
    createdAt: plan.createdAt,
    recipientAgentId: plan.recipientAgentId,
    agentAuthorizationRevision: plan.agentAuthorizationRevision,
    cryptoObjectId: objectId("message_live_shadow_m290"),
    namespaceId: plan.namespaceId,
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    recipientKeyId: plan.recipientKeyId,
    grantId: grantId("grant_live_m290"),
    grantDigest: bytes(0x51),
    grantExpiresAt: plan.deadlineAt,
    planDigest: liveShadowMessagePlanDigestV2(planBytes),
    plaintextPayloadDigest: bytes(0x61),
    encryptedPayloadDigest: bytes(0x62),
    manifestDigest: bytes(0x63),
    envelopeDigest: bytes(0x64),
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
    committerDeviceId: plan.committerDeviceId,
    committerDeviceSigningKeyGeneration:
      plan.committerDeviceSigningKeyGeneration,
    hostAuthorizationRevision: plan.hostAuthorizationRevision,
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  return {
    crypto,
    signing,
    agentGrantPlan,
    plan,
    planBytes,
    created,
    resolveCurrentAuthority: () => signing.publicKey,
  };
}

function mutate(
  request: HumanLiveShadowMessageRequestV2,
  changes: Partial<HumanLiveShadowMessageRequestV2>,
): Uint8Array {
  return encodeHumanLiveShadowMessageRequestV2({ ...request, ...changes });
}

describe("M290 device-wrapped live Shadow plan and Human request V2", () => {
  test("pins canonical plan and request bytes with the complete Agent authority plan", () => {
    const value = fixture();
    try {
      expect(decodeLiveShadowMessagePlanV2(value.planBytes).operationId)
        .toBe("operation_live_m290");
      expect(decodeHumanLiveShadowMessageRequestV2(value.created.bytes).grantId)
        .toBe(grantId("grant_live_m290"));
      expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
        .toBe("7dd9bf5f1df3292be327b181f9ddbbbf56db6d2bf21944256edfe98986b4c6f3");
      expect(Buffer.from(value.created.requestDigest).toString("hex"))
        .toBe("706b2a8093ccef6da44c5fd3b2a64ad48790e0a9dd7a60deebcdbe7d394dabe0");
    } finally {
      destroyNamespaceAgentGrantPlanV1(value.agentGrantPlan);
    }
  });

  test("verifies fresh current authority and exact expired replay", () => {
    const value = fixture();
    try {
      expect(verifyHumanLiveShadowMessageRequestV2(value.crypto, {
        requestBytes: value.created.bytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: value.resolveCurrentAuthority,
      }).operationId).toBe("operation_live_m290");
      expect(() => verifyHumanLiveShadowMessageRequestV2(value.crypto, {
        requestBytes: value.created.bytes,
        now: unixTimestamp(NOW + 30_000),
        resolveCurrentAuthority: value.resolveCurrentAuthority,
      })).toThrow(/not currently valid/i);
      expect(verifyHumanLiveShadowMessageRequestExactReplayV2(value.crypto, {
        requestBytes: value.created.bytes,
        expectedRequestDigest: value.created.requestDigest,
        resolveCurrentAuthority: value.resolveCurrentAuthority,
      }).operationId).toBe("operation_live_m290");
      expect(humanLiveShadowMessageRequestDigestV2(value.created.bytes))
        .toEqual(value.created.requestDigest);
    } finally {
      destroyNamespaceAgentGrantPlanV1(value.agentGrantPlan);
    }
  });

  test("rejects current-Room, complete Grant-plan, and signed request substitution", () => {
    const value = fixture();
    try {
      expect(() => encodeLiveShadowMessagePlanV2({
        ...value.plan,
        namespaceId: namespaceId("namespace_omitted_m290"),
      })).toThrow(/Grant plan disagrees/i);
      const changedGrantPlan = value.plan.agentGrantPlanBytes.slice();
      changedGrantPlan[changedGrantPlan.length - 1] =
        (changedGrantPlan[changedGrantPlan.length - 1] ?? 0) ^ 1;
      expect(() => encodeLiveShadowMessagePlanV2({
        ...value.plan,
        agentGrantPlanBytes: changedGrantPlan,
      })).toThrow(/Grant plan disagrees/i);
      for (const requestBytes of [
        mutate(value.created.request, { namespaceHeadDigest: bytes(0x91) }),
        mutate(value.created.request, {
          committerDeviceSigningKeyGeneration: 3,
        }),
        mutate(value.created.request, { grantDigest: bytes(0x92) }),
      ]) {
        expect(() => verifyHumanLiveShadowMessageRequestV2(value.crypto, {
          requestBytes,
          now: unixTimestamp(NOW + 1),
          resolveCurrentAuthority: value.resolveCurrentAuthority,
        })).toThrow(/signature/i);
      }
      const wrongDigest = value.created.requestDigest.slice();
      wrongDigest[0] = (wrongDigest[0] ?? 0) ^ 1;
      expect(() => verifyHumanLiveShadowMessageRequestExactReplayV2(
        value.crypto,
        {
          requestBytes: value.created.bytes,
          expectedRequestDigest: wrongDigest,
          resolveCurrentAuthority: value.resolveCurrentAuthority,
        },
      )).toThrow(/digest disagrees/i);
    } finally {
      destroyNamespaceAgentGrantPlanV1(value.agentGrantPlan);
    }
  });

  test("rejects truncation, extension, and noncanonical field sets", () => {
    const value = fixture();
    try {
      expect(() => decodeLiveShadowMessagePlanV2(value.planBytes.subarray(0, -1)))
        .toThrow();
      expect(() => decodeHumanLiveShadowMessageRequestV2(
        new Uint8Array([...value.created.bytes, 0]),
      )).toThrow();
      expect(() => encodeLiveShadowMessagePlanV2({
        ...value.plan,
        extra: true,
      } as LiveShadowMessagePlanV2)).toThrow(/invalid field set/i);
    } finally {
      destroyNamespaceAgentGrantPlanV1(value.agentGrantPlan);
    }
  });
});
