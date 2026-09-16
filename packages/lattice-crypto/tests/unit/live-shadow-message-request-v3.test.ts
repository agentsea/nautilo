import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  deviceWrappedDomainAgentGrantAuthoritySetDigestV1,
  serializeDeviceWrappedDomainAgentGrantPlanV1,
  type DeviceWrappedDomainAgentGrantAuthorityEntryV1,
  type DeviceWrappedDomainAgentGrantPlanV1,
} from "../../src/format/device-wrapped-domain-agent-grant-v1.ts";
import {
  decodeHumanLiveShadowMessageRequestV3,
  decodeLiveShadowMessagePlanV3,
  encodeHumanLiveShadowMessageRequestV3,
  encodeLiveShadowMessagePlanV3,
  humanLiveShadowMessageRequestDigestV3,
  liveShadowMessagePlanDigestV3,
  prepareHumanLiveShadowMessageRequestV3,
  verifyHumanLiveShadowMessageRequestExactReplayV3,
  verifyHumanLiveShadowMessageRequestV3,
  type HumanLiveShadowMessageRequestV3,
  type LiveShadowMessagePlanV3,
} from "../../src/message/live-shadow-message-request-v3.ts";
import {
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  grantId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;
const SESSION = "10000000-0000-4000-8000-000000000291";
const ROOM = "20000000-0000-4000-8000-000000000291";

function bytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(291_401), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const domain: DeviceWrappedDomainAgentGrantAuthorityEntryV1 = {
    grantDomainId: "grant-domain:human-alpha",
    participantDigest: bytes(0x71),
    domainKeyGeneration: 2,
    headDigest: bytes(0x72),
    publicationDigest: bytes(0x73),
    publicationAuthorizationRevision: authorizationRevision(1),
    authorizationRevision: authorizationRevision(5),
    activeNamespaceBindingSetDigest: bytes(0x74),
    activeNamespaceBindingCount: 300,
  };
  const grantPlan: DeviceWrappedDomainAgentGrantPlanV1 = {
    formatVersion: 1,
    purpose: "device_wrapped_grant_domain.agent_grant_plan",
    scheme: "device_wrapped_grant_domain_enumeration_v1",
    operationId: "operation_live_m291",
    policyRevision: 5,
    sessionId: SESSION,
    roomId: ROOM,
    subjectHumanId: humanId("human_live_m291"),
    committerDeviceId: cryptoDeviceId("device_browser_m291"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(9),
    recipientAgentId: agentId("agent_live_m291"),
    recipientKeyId: "recipient_key_live_m291",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    domainCount: 1,
    maximumSecretBytes: 16_384,
    domainAuthoritySetDigest:
      deviceWrappedDomainAgentGrantAuthoritySetDigestV1(crypto, [domain]),
    domains: [domain],
  };
  const agentGrantPlanBytes = serializeDeviceWrappedDomainAgentGrantPlanV1(
    grantPlan,
  );
  const plan: LiveShadowMessagePlanV3 = {
    formatVersion: 3,
    purpose: "message.live_shadow_plan",
    operationId: grantPlan.operationId,
    policyRevision: grantPlan.policyRevision,
    sessionId: SESSION,
    roomId: ROOM,
    humanMessageId: 291,
    revision: 0,
    createdAt: unixTimestamp(NOW),
    subjectHumanId: grantPlan.subjectHumanId,
    committerDeviceId: grantPlan.committerDeviceId,
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: grantPlan.hostAuthorizationRevision,
    recipientAgentId: grantPlan.recipientAgentId,
    agentAuthorizationRevision: authorizationRevision(6),
    agentRuntimeGeneration: 3,
    agentSignerKeyId: `agent_runtime_signer_${"a".repeat(64)}`,
    agentSignerPublicKey: bytes(0x31),
    namespaceId: namespaceId("namespace_room_m291"),
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 4,
    namespaceHeadDigest: bytes(0x12),
    namespacePublicationDigest: bytes(0x32),
    namespacePublicationSetDigest: bytes(0x42),
    namespaceAudienceFingerprint: bytes(0x22),
    grantDomainId: domain.grantDomainId,
    grantDomainParticipantDigest: domain.participantDigest,
    grantDomainKeyGeneration: domain.domainKeyGeneration,
    grantDomainHeadDigest: domain.headDigest,
    grantDomainPublicationDigest: domain.publicationDigest,
    grantDomainAuthorizationRevision: domain.authorizationRevision,
    namespaceBundleRevision: 2,
    namespaceBundleDigest: bytes(0x75),
    agentGrantPlanBytes,
    agentGrantPlanDigest: crypto.hash(agentGrantPlanBytes),
    recipientId: "recipient_live_m291",
    recipientKeyId: grantPlan.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(0x41),
    attemptCoordinate: "attempt_live_m291",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  };
  const planBytes = encodeLiveShadowMessagePlanV3(plan);
  const created = prepareHumanLiveShadowMessageRequestV3(crypto, {
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
    cryptoObjectId: objectId("message_live_shadow_m291"),
    namespaceId: plan.namespaceId,
    namespaceAccessRevision: plan.namespaceAccessRevision,
    namespaceKeyGeneration: plan.namespaceKeyGeneration,
    namespaceHeadDigest: plan.namespaceHeadDigest,
    namespacePublicationDigest: plan.namespacePublicationDigest,
    namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
    namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
    recipientKeyId: plan.recipientKeyId,
    grantId: grantId("grant_live_m291"),
    grantDigest: bytes(0x51),
    grantExpiresAt: plan.deadlineAt,
    planDigest: liveShadowMessagePlanDigestV3(planBytes),
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
  return { crypto, signing, plan, planBytes, created };
}

function mutate(
  request: HumanLiveShadowMessageRequestV3,
  changes: Partial<HumanLiveShadowMessageRequestV3>,
): Uint8Array {
  return encodeHumanLiveShadowMessageRequestV3({ ...request, ...changes });
}

describe("M291 Domain-compressed live Shadow plan and Human request V3", () => {
  test("pins explicit V3 bytes and preserves current Room M290 coordinates", () => {
    const value = fixture();
    const decoded = decodeLiveShadowMessagePlanV3(value.planBytes);
    expect(decoded.grantDomainId).toBe("grant-domain:human-alpha");
    expect(decoded.namespaceId).toBe(namespaceId("namespace_room_m291"));
    expect(decodeHumanLiveShadowMessageRequestV3(value.created.bytes).grantId)
      .toBe(grantId("grant_live_m291"));
    expect(Buffer.from(value.crypto.hash(value.planBytes)).toString("hex"))
      .toBe("1f6f6696c07e24eed021a18f396c40abc6a139e61712e25bcc1d09b4a8293ae9");
    expect(Buffer.from(value.created.requestDigest).toString("hex"))
      .toBe("0be16927d30b72ad86d9a3955eeef68f6933c5bb32956686241742ce7de4846f");
  });

  test("verifies fresh current authority and exact expired replay", () => {
    const value = fixture();
    const resolveCurrentAuthority = () => value.signing.publicKey;
    expect(verifyHumanLiveShadowMessageRequestV3(value.crypto, {
      requestBytes: value.created.bytes,
      now: unixTimestamp(NOW + 1),
      resolveCurrentAuthority,
    }).operationId).toBe("operation_live_m291");
    expect(() => verifyHumanLiveShadowMessageRequestV3(value.crypto, {
      requestBytes: value.created.bytes,
      now: unixTimestamp(NOW + 30_000),
      resolveCurrentAuthority,
    })).toThrow(/not currently valid/i);
    expect(verifyHumanLiveShadowMessageRequestExactReplayV3(value.crypto, {
      requestBytes: value.created.bytes,
      expectedRequestDigest: value.created.requestDigest,
      resolveCurrentAuthority,
    }).operationId).toBe("operation_live_m291");
    expect(humanLiveShadowMessageRequestDigestV3(value.created.bytes))
      .toEqual(value.created.requestDigest);
  });

  test("rejects Domain, bundle, Grant-plan, and signed request substitution", () => {
    const value = fixture();
    expect(() => encodeLiveShadowMessagePlanV3({
      ...value.plan,
      grantDomainId: "grant-domain:substituted",
    })).toThrow(/Grant plan disagrees/i);
    expect(() => encodeLiveShadowMessagePlanV3({
      ...value.plan,
      grantDomainAuthorizationRevision: authorizationRevision(7),
    })).toThrow(/Grant plan disagrees/i);
    const changedGrantPlan = value.plan.agentGrantPlanBytes.slice();
    changedGrantPlan[changedGrantPlan.length - 1] =
      (changedGrantPlan[changedGrantPlan.length - 1] ?? 0) ^ 1;
    expect(() => encodeLiveShadowMessagePlanV3({
      ...value.plan,
      agentGrantPlanBytes: changedGrantPlan,
    })).toThrow(/Grant plan disagrees/i);
    for (const requestBytes of [
      mutate(value.created.request, { namespaceHeadDigest: bytes(0x91) }),
      mutate(value.created.request, { planDigest: bytes(0x92) }),
      mutate(value.created.request, { grantDigest: bytes(0x93) }),
    ]) {
      expect(() => verifyHumanLiveShadowMessageRequestV3(value.crypto, {
        requestBytes,
        now: unixTimestamp(NOW + 1),
        resolveCurrentAuthority: () => value.signing.publicKey,
      })).toThrow(/signature/i);
    }
    expect(() => decodeLiveShadowMessagePlanV3(
      value.planBytes.subarray(0, value.planBytes.length - 1),
    )).toThrow();
  });
});
