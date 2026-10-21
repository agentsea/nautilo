import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  createTaskDefinitionForegroundObjectAccessManifest,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeObjectAccessManifestV5,
  encodeLiveShadowMessagePlanV4,
  parseDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import { exactTaskDefinitionForegroundAgentSignerKeysV1 } from
  "../../src/client/task/task-definition-foreground-authorization-evidence-v1.ts";
import { foregroundAgentSignerPrincipalKeyV1 } from
  "../../src/client/foreground-agent-accepted-execution.ts";
import {
  deriveTaskDefinitionForegroundRecipientKeyIdV1,
  taskDefinitionForegroundAuthorizationIdV1,
} from "../../src/task/task-definition-foreground-authorization-id-v1.ts";

const NOW = 1_801_900_000_000;
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "human:task-definition";
const PRIVATE_ROOM_ID = "room:private-task";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_ROOM_ID = "33333333-3333-4333-8333-333333333333";
const NAMESPACE_ID = "namespace:private-task";
const DOMAIN_ID = "domain:private-task";

const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const base64url = (value: Uint8Array) => Buffer.from(value).toString("base64url");

async function fixture(parentDeadlineAt = NOW + 29_000) {
  const crypto = new LatticeCrypto(seededRng(2_701_901), { now: () => NOW });
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const runtime = {
    agentId: agentId("agent:task-definition-author"),
    keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(3),
    key: bytes(0x31),
  };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const parentOperationId = "operation:shared-room-parent";
  const workDescriptorDigest = bytes(0x32);
  const authorizationId = taskDefinitionForegroundAuthorizationIdV1(crypto, {
    parentOperationId,
    taskId: TASK_ID,
    operation: "create",
    targetContentRevision: 1,
    workDescriptorDigest,
  });
  const parentBytes = encodeLiveShadowMessagePlanV4({
    formatVersion: 4,
    purpose: "message.live_shadow_plan",
    operationId: parentOperationId,
    policyRevision: 7,
    sessionId: SESSION_ID,
    roomId: SHARED_ROOM_ID,
    humanMessageId: 1,
    revision: 0,
    createdAt: unixTimestamp(NOW - 1_000),
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId("device:task-author"),
    committerDeviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientAgentId: runtime.agentId,
    agentAuthorizationRevision: authorizationRevision(4),
    agentRuntimeGeneration: runtime.generation,
    agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: signer.publicKey,
    namespaceId: namespaceId("namespace:shared-parent"),
    namespaceAccessRevision: accessRevision(1),
    namespaceKeyGeneration: namespaceGeneration(1),
    namespaceHeadDigest: bytes(0x41),
    namespacePublicationDigest: bytes(0x42),
    namespacePublicationSetDigest: bytes(0x43),
    namespaceAudienceFingerprint: bytes(0x44),
    grantDomainId: "domain:shared-parent",
    grantDomainParticipantDigest: bytes(0x45),
    grantDomainKeyGeneration: 1,
    grantDomainHeadDigest: bytes(0x46),
    grantDomainPublicationDigest: bytes(0x47),
    grantDomainAuthorizationRevision: authorizationRevision(1),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(1),
    namespaceBundleRevision: 1,
    namespaceBundleDigest: bytes(0x48),
    authorization: {
      disposition: "authorization_reusable",
      sessionReference: "authorization:shared-parent",
      authorizationDigest: bytes(0x49),
    },
    attemptCoordinate: "attempt:shared-parent",
    issuedAt: unixTimestamp(NOW - 1_000),
    deadlineAt: unixTimestamp(parentDeadlineAt),
  });
  const domain = Object.freeze({
    domainId: DOMAIN_ID,
    sourceNamespaceId: NAMESPACE_ID,
    participantDigest: bytes(0x51),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 1,
    authorizationRevision: authorizationRevision(1),
    headDigest: bytes(0x52),
    activeNamespaceBindingSetDigest: bytes(0x53),
    activeNamespaceBindingCount: 1,
  });
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId,
    policyRevision: 7,
    sessionId: SESSION_ID,
    roomId: PRIVATE_ROOM_ID,
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId("device:task-author"),
    committerDeviceSigningGeneration: 2,
    hostAuthorizationRevision: authorizationRevision(5),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_foreground_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
      authorizationId,
      parentAgentSignerPublicKey: signer.publicKey,
    }),
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 20_000,
    maximumSecretBytes: 1_024,
    domains: [domain],
  });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x54) }],
    committerDeviceSigningPrivateKey: device.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const authorizationBytes = serializeDomainForegroundAuthorizationV2(
    authorization,
  );
  const genesis = createTaskDefinitionForegroundObjectAccessManifest(
    crypto,
    {
      objectId: objectId(`task-definition:v1:${"d".repeat(64)}`),
      payloadHash: bytes(0x61),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [bytes(0x62)],
      signer: signer.principal,
      signerAuthorizationHash: crypto.hash(authorizationBytes),
      hostAuthorizationRevision: authorizationRevision(5),
    },
    runtime,
  );
  return {
    crypto,
    device,
    signer,
    runtime,
    parentBytes,
    authorizationBytes,
    genesisBytes: genesis.bytes,
    evidence: [
      {
        kind: "foreground_agent_accepted_execution",
        planBytesBase64url: base64url(parentBytes),
        planDigestBase64url: base64url(crypto.hash(parentBytes)),
      },
      {
        kind: "task_definition_foreground_authorization",
        evidenceBytesBase64url: base64url(authorizationBytes),
      },
    ],
  };
}

describe("Task definition retained foreground authorization", () => {
  test("authenticates the exact Device, parent execution, Task and private Domain", async () => {
    const value = await fixture(NOW - 500);
    const resolvedDeviceAuthorities: Array<Readonly<{
      humanId: string;
      deviceId: string;
      deviceGeneration: number;
      hostAuthorizationRevision: number;
    }>> = [];
    const verify = (overrides: Partial<Parameters<
      typeof exactTaskDefinitionForegroundAgentSignerKeysV1
    >[0]> = {}) => exactTaskDefinitionForegroundAgentSignerKeysV1({
      crypto: value.crypto,
      evidence: value.evidence,
      genesisManifestBytes: value.genesisBytes,
      taskId: TASK_ID,
      contentRevision: 1,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      privateRoomId: PRIVATE_ROOM_ID,
      expectedHumanId: HUMAN_ID,
      resolveHistoricalDeviceSigningPublicKey: input => {
        resolvedDeviceAuthorities.push(input);
        return value.device.publicKey;
      },
      ...overrides,
    });
    const keys = verify();
    expect(keys.get(foregroundAgentSignerPrincipalKeyV1(
      value.signer.principal,
    ))).toEqual(value.signer.publicKey);
    keys.forEach(key => key.fill(0));
    expect(resolvedDeviceAuthorities[0]).toEqual({
      humanId: HUMAN_ID,
      deviceId: "device:task-author",
      deviceGeneration: 2,
      hostAuthorizationRevision: 5,
    });

    expect(() => verify({ namespaceId: "namespace:other" })).toThrow();
    expect(() => verify({ contentRevision: 2 })).toThrow();
    expect(() => verify({
      resolveHistoricalDeviceSigningPublicKey: () => bytes(0xee),
    })).toThrow();

    const substitutedParent = decodeLiveShadowMessagePlanV4(value.parentBytes);
    const substitutedParentBytes = encodeLiveShadowMessagePlanV4({
      ...substitutedParent,
      agentSignerPublicKey: bytes(0xee),
    });
    expect(() => verify({ evidence: [{
      kind: "foreground_agent_accepted_execution",
      planBytesBase64url: base64url(substitutedParentBytes),
      planDigestBase64url: base64url(value.crypto.hash(substitutedParentBytes)),
    }, value.evidence[1]] })).toThrow("Task definition authorization binding is invalid");

    const authorization = parseDomainForegroundAuthorizationV2(
      value.authorizationBytes,
    )!;
    const signedPlan = parseDomainForegroundAuthorizationPlanV2(
      authorization.planBytes,
    )!;
    const changedDeadlineBytes = serializeDomainForegroundAuthorizationV2({
      ...authorization,
      planBytes: serializeDomainForegroundAuthorizationPlanV2({
        ...signedPlan, deadlineAt: unixTimestamp(NOW + 21_000),
      }),
    });
    const originalGenesis = decodeObjectAccessManifestV5(value.genesisBytes);
    const changedGenesis = createTaskDefinitionForegroundObjectAccessManifest(
      value.crypto,
      {
        objectId: originalGenesis.objectId,
        payloadHash: originalGenesis.payloadHash,
        accessRevision: originalGenesis.accessRevision,
        previousManifestHash: originalGenesis.previousManifestHash,
        envelopeHashes: originalGenesis.envelopeHashes,
        signer: originalGenesis.signer,
        hostAuthorizationRevision: originalGenesis.hostAuthorizationRevision,
        signerAuthorizationHash: value.crypto.hash(changedDeadlineBytes),
      },
      value.runtime,
    );
    expect(() => verify({ genesisManifestBytes: changedGenesis.bytes,
      evidence: [value.evidence[0], {
      kind: "task_definition_foreground_authorization",
      evidenceBytesBase64url: base64url(changedDeadlineBytes),
    }] })).toThrow("Task definition Device signature is invalid");
  });
});
