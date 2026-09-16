import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  createDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2,
  mintDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorityEntryV2,
} from "../../src/format/domain-foreground-authorization-v2.ts";
import {
  decodeHumanLiveShadowMessageRequestV4,
  decodeLiveShadowMessagePlanV4,
  encodeHumanLiveShadowMessageRequestV4,
  encodeLiveShadowMessagePlanV4,
  humanLiveShadowMessageRequestDigestV4,
  liveShadowMessagePlanDigestV4,
  prepareHumanLiveShadowMessageRequestV4,
  verifyHumanLiveShadowMessageRequestExactReplayV4,
  verifyHumanLiveShadowMessageRequestV4,
  type HumanLiveShadowMessageRequestV4,
  type LiveShadowMessagePlanV4,
} from "../../src/message/live-shadow-message-request-v4.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;
const SESSION = "10000000-0000-4000-8000-000000000294";
const ROOM = "20000000-0000-4000-8000-000000000294";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(294_201), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(bytes(0x51));
  const domain: DomainForegroundAuthorityEntryV2 = {
    domainId: "grant-domain:human-alpha",
    sourceNamespaceId: "namespace_room_m294",
    participantDigest: bytes(0x71),
    participantCount: 2,
    keyClass: "ai",
    domainKeyGeneration: 2,
    headDigest: bytes(0x72),
    authorizationRevision: authorizationRevision(5),
    activeNamespaceBindingSetDigest: bytes(0x74),
    activeNamespaceBindingCount: 300,
  };
  const authorizationPlan =
    createDomainForegroundAuthorizationPlanV2(crypto, {
      authorizationId: "foreground_authorization_m294",
      policyRevision: 5,
      sessionId: SESSION,
      roomId: ROOM,
      subjectHumanId: humanId("human_live_m294"),
      committerDeviceId: cryptoDeviceId("device_browser_m294"),
      committerDeviceSigningGeneration: 2,
      hostAuthorizationRevision: authorizationRevision(9),
      recipientKind: "agent",
      recipientPrincipalId: agentId("agent_live_m294"),
      recipientAuthorizationRevision: authorizationRevision(6),
      recipientRuntimeGeneration: 3,
      recipientKeyId: "recipient_key_live_m294",
      operations: ["decrypt", "encrypt"],
      issuedAt: NOW,
      deadlineAt: NOW + 5 * 60_000,
      maximumSecretBytes: 16_384,
      domains: [domain],
    });
  const authorizationPlanBytes =
    serializeDomainForegroundAuthorizationPlanV2(
      authorizationPlan,
    );
  const authorization =
    await mintDomainForegroundAuthorizationV2(crypto, {
      plan: authorizationPlan,
      domains: [{
        domainId: domain.domainId,
        sourceNamespaceId: domain.sourceNamespaceId,
        participantCount: domain.participantCount,
        keyClass: "ai",
        domainKeyGeneration: domain.domainKeyGeneration,
        participantDigest: domain.participantDigest,
        headDigest: domain.headDigest,
        authorizationRevision: domain.authorizationRevision,
        domainKey: bytes(0x91),
      }],
      committerDeviceSigningPrivateKey: signing.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
  const authorizationBytes =
    serializeDomainForegroundAuthorizationV2(authorization);
  const plan: LiveShadowMessagePlanV4 = {
    formatVersion: 4,
    purpose: "message.live_shadow_plan",
    operationId: "operation_live_m294",
    policyRevision: authorizationPlan.policyRevision,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 294,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: authorizationPlan.subjectHumanId,
    committerDeviceId: authorizationPlan.committerDeviceId,
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: authorizationPlan.hostAuthorizationRevision,
    recipientAgentId: agentId(authorizationPlan.recipientPrincipalId),
    agentAuthorizationRevision:
      authorizationPlan.recipientAuthorizationRevision,
    agentRuntimeGeneration: authorizationPlan.recipientRuntimeGeneration,
    agentSignerKeyId: `agent_runtime_signer_${"a".repeat(64)}`,
    agentSignerPublicKey: bytes(0x31),
    namespaceId: namespaceId("namespace_room_m294"),
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    namespaceHeadDigest: bytes(0x12),
    namespacePublicationDigest: bytes(0x32),
    namespacePublicationSetDigest: bytes(0x42),
    namespaceAudienceFingerprint: bytes(0x22),
    grantDomainId: domain.domainId,
    grantDomainParticipantDigest: domain.participantDigest,
    grantDomainKeyGeneration: domain.domainKeyGeneration,
    grantDomainHeadDigest: domain.headDigest,
    grantDomainPublicationDigest: domain.activeNamespaceBindingSetDigest,
    grantDomainAuthorizationRevision: domain.authorizationRevision,
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(4),
    namespaceBundleRevision: 2,
    namespaceBundleDigest: bytes(0x75),
    authorization: {
      disposition: "authorization_required",
      authorizationId: authorizationPlan.authorizationId,
      authorizationPlanBytes,
      authorizationPlanDigest: crypto.hash(authorizationPlanBytes),
      recipientId: "recipient_live_m294",
      recipientKeyId: authorizationPlan.recipientKeyId,
      recipientPublicKey: recipient.publicKey,
    },
    attemptCoordinate: "attempt_live_m294",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeLiveShadowMessagePlanV4(plan);
  const created = prepareHumanLiveShadowMessageRequestV4(crypto, {
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
    cryptoObjectId: objectId("message_live_shadow_m294"),
    namespaceId: plan.namespaceId,
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    authorization: {
      kind: "establish",
      authorizationBytes,
      authorizationDigest: crypto.hash(authorizationBytes),
    },
    planDigest: liveShadowMessagePlanDigestV4(planBytes),
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
    crypto, signing, domain, authorizationPlan, authorizationBytes,
    plan, planBytes, created,
  };
}

function mutate(
  request: HumanLiveShadowMessageRequestV4,
  changes: Partial<HumanLiveShadowMessageRequestV4>,
): Uint8Array {
  return encodeHumanLiveShadowMessageRequestV4({ ...request, ...changes });
}

describe("M294 foreground-session live Shadow plan and request V4", () => {
  test("accepts the V2 Domain authority embedded by a live Shadow plan", async () => {
    const value = await fixture();
    const domainPlan = createDomainForegroundAuthorizationPlanV2(value.crypto, {
      authorizationId: "foreground_authorization_m301",
      policyRevision: value.plan.policyRevision,
      sessionId: value.plan.sessionId,
      roomId: value.plan.roomId,
      subjectHumanId: value.plan.subjectHumanId,
      committerDeviceId: value.plan.committerDeviceId,
      committerDeviceSigningGeneration:
        value.plan.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: value.plan.hostAuthorizationRevision,
      recipientKind: "agent",
      recipientPrincipalId: value.plan.recipientAgentId,
      recipientAuthorizationRevision: value.plan.agentAuthorizationRevision,
      recipientRuntimeGeneration: value.plan.agentRuntimeGeneration,
      recipientKeyId: value.plan.authorization.disposition === "authorization_required"
        ? value.plan.authorization.recipientKeyId
        : "unreachable",
      operations: ["decrypt", "encrypt"],
      issuedAt: value.plan.issuedAt,
      deadlineAt: value.plan.issuedAt + 5 * 60_000,
      maximumSecretBytes: 16_384,
      domains: [{
        domainId: value.plan.grantDomainId,
        sourceNamespaceId: value.plan.namespaceId,
        participantDigest: value.plan.grantDomainParticipantDigest,
        participantCount: 2,
        keyClass: "ai",
        domainKeyGeneration: value.plan.grantDomainKeyGeneration,
        authorizationRevision: value.plan.grantDomainAuthorizationRevision,
        headDigest: value.plan.grantDomainHeadDigest,
        activeNamespaceBindingSetDigest:
          value.plan.grantDomainPublicationDigest,
        activeNamespaceBindingCount: 1,
      }],
    });
    try {
      const authorizationPlanBytes =
        serializeDomainForegroundAuthorizationPlanV2(domainPlan);
      const v2Plan: LiveShadowMessagePlanV4 = {
        ...value.plan,
        authorization: {
          disposition: "authorization_required",
          authorizationId: domainPlan.authorizationId,
          authorizationPlanBytes,
          authorizationPlanDigest: value.crypto.hash(authorizationPlanBytes),
          recipientId: "recipient_live_m301",
          recipientKeyId: domainPlan.recipientKeyId,
          recipientPublicKey: value.plan.authorization.disposition
            === "authorization_required"
            ? value.plan.authorization.recipientPublicKey
            : bytes(0x51),
        },
      };
      const encoded = encodeLiveShadowMessagePlanV4(v2Plan);
      expect(decodeLiveShadowMessagePlanV4(encoded).authorization.disposition)
        .toBe("authorization_required");
      expect(() => encodeLiveShadowMessagePlanV4({
        ...v2Plan,
        grantDomainPublicationDigest: bytes(0xee),
      })).toThrow("Foreground authorization plan disagrees");
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(domainPlan);
    }
  });

  test("pins required establishment bytes and verifies a short operation", async () => {
    const value = await fixture();
    expect(decodeLiveShadowMessagePlanV4(value.planBytes).authorization.disposition)
      .toBe("authorization_required");
    expect(decodeHumanLiveShadowMessageRequestV4(value.created.bytes)
      .authorization.kind).toBe("establish");
    expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
      .toBe("117ea1491f8a7f4aab1f95a41360ba110bf83419aa3349d4a1051f28a89174a5");
    expect(encodeHumanLiveShadowMessageRequestV4(
      decodeHumanLiveShadowMessageRequestV4(value.created.bytes),
    )).toEqual(value.created.bytes);
    expect(verifyHumanLiveShadowMessageRequestV4(value.crypto, {
      requestBytes: value.created.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: () => value.signing.publicKey,
    }).operationId).toBe(value.plan.operationId);
    expect(humanLiveShadowMessageRequestDigestV4(value.created.bytes))
      .toEqual(value.created.requestDigest);
  });

  test("encodes reusable authorization without recipient or Grant bytes", async () => {
    const value = await fixture();
    const reusablePlan: LiveShadowMessagePlanV4 = {
      ...value.plan,
      operationId: "operation_live_m294_reuse",
      humanMessageId: 295,
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "opaque_session_reference_m294",
        authorizationDigest: bytes(0x98),
      },
    };
    const reusablePlanBytes = encodeLiveShadowMessagePlanV4(reusablePlan);
    const decodedPlan = decodeLiveShadowMessagePlanV4(reusablePlanBytes);
    expect(decodedPlan.authorization).toEqual({
      disposition: "authorization_reusable",
      sessionReference: "opaque_session_reference_m294",
      authorizationDigest: bytes(0x98),
    });
    const request = prepareHumanLiveShadowMessageRequestV4(value.crypto, {
      subjectHumanId: reusablePlan.subjectHumanId,
      operationId: reusablePlan.operationId,
      policyRevision: reusablePlan.policyRevision,
      sessionId: reusablePlan.sessionId,
      roomId: reusablePlan.roomId,
      messageId: reusablePlan.humanMessageId,
      revision: 0,
      createdAt: reusablePlan.createdAt,
      recipientAgentId: reusablePlan.recipientAgentId,
      agentAuthorizationRevision: reusablePlan.agentAuthorizationRevision,
      cryptoObjectId: objectId("message_live_shadow_m294_reuse"),
      namespaceId: reusablePlan.namespaceId,
      namespaceAccessRevision: reusablePlan.namespaceAccessRevision,
      namespaceKeyGeneration: reusablePlan.namespaceKeyGeneration,
      namespaceHeadDigest: reusablePlan.namespaceHeadDigest,
      namespacePublicationDigest: reusablePlan.namespacePublicationDigest,
      namespacePublicationSetDigest: reusablePlan.namespacePublicationSetDigest,
      namespaceAudienceFingerprint: reusablePlan.namespaceAudienceFingerprint,
      authorization: {
        kind: "reuse",
        sessionReference: decodedPlan.authorization.disposition
          === "authorization_reusable"
          ? decodedPlan.authorization.sessionReference
          : "unreachable",
        authorizationDigest: bytes(0x98),
      },
      planDigest: liveShadowMessagePlanDigestV4(reusablePlanBytes),
      plaintextPayloadDigest: bytes(0x81),
      encryptedPayloadDigest: bytes(0x82),
      manifestDigest: bytes(0x83),
      envelopeDigest: bytes(0x84),
      issuedAt: reusablePlan.issuedAt,
      deadlineAt: reusablePlan.deadlineAt,
      committerDeviceId: reusablePlan.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        reusablePlan.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: reusablePlan.hostAuthorizationRevision,
      committerSigningPublicKey: value.signing.publicKey,
      committerSigningPrivateKey: value.signing.privateKey,
    });
    expect(request.bytes.length).toBeLessThan(value.created.bytes.length / 2);
    expect(Buffer.from(request.requestDigest).toString("hex"))
      .toBe("aead7249ca4a29efcffddfe825565304989d7c15b813e22bf1b1d5aa31db00b8");
    expect(decodeHumanLiveShadowMessageRequestV4(request.bytes).authorization.kind)
      .toBe("reuse");
  });

  test("rejects substitution, overlong operations, and malformed bytes", async () => {
    const value = await fixture();
    expect(() => encodeLiveShadowMessagePlanV4({
      ...value.plan,
      grantDomainId: "grant-domain:substituted",
    })).toThrow(/authorization plan disagrees/i);
    expect(() => encodeLiveShadowMessagePlanV4({
      ...value.plan,
      operationId: value.authorizationPlan.authorizationId,
    })).toThrow(/authorization plan disagrees/i);
    expect(() => encodeLiveShadowMessagePlanV4({
      ...value.plan,
      deadlineAt: unixTimestamp(NOW + 30_001),
    })).toThrow(/lifetime/i);
    const changedProof = mutate(value.created.request, {
      authorization: {
        kind: "reuse",
        sessionReference: "substituted_session_reference",
        authorizationDigest: value.crypto.hash(value.authorizationBytes),
      },
    });
    expect(() => verifyHumanLiveShadowMessageRequestV4(value.crypto, {
      requestBytes: changedProof,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority: () => value.signing.publicKey,
    })).toThrow(/signature/i);
    expect(() => decodeLiveShadowMessagePlanV4(
      value.planBytes.subarray(0, value.planBytes.length - 1),
    )).toThrow();
    expect(() => decodeHumanLiveShadowMessageRequestV4(
      new Uint8Array([...value.created.bytes, 0]),
    )).toThrow();
    expect(verifyHumanLiveShadowMessageRequestExactReplayV4(value.crypto, {
      requestBytes: value.created.bytes,
      expectedRequestDigest: value.created.requestDigest,
      resolveCurrentAuthority: () => value.signing.publicKey,
    }).operationId).toBe(value.plan.operationId);
  });
});
