import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  encodeLiveShadowMessagePlanV4,
  serializeDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import { CRYPTO_STORAGE_BYTE_LIMITS } from "@nautilo/db";
import { deriveTaskDefinitionForegroundRecipientKeyIdV1 } from
  "@nautilo/lattice-bridge";
import {
  createTaskDefinitionForegroundAuthorizationResolver,
  inspectTaskDefinitionForegroundAuthorizationEvidence,
  parseTaskDefinitionForegroundAuthorizationId,
  taskDefinitionForegroundAuthorizationId,
  TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES,
  TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES,
  verifyHistoricalTaskDefinitionForegroundAuthorizationEvidence,
} from "../../src/routes/task-definition-foreground-authorization";

const bytes = (fill: number) => new Uint8Array(32).fill(fill);
const longestId = (prefix: string) => prefix + "x".repeat(128 - prefix.length);

async function maximumEvidence(operations: readonly ["decrypt", "encrypt"]
  | readonly ["decrypt"] = ["decrypt", "encrypt"] as const) {
  const crypto = new LatticeCrypto();
  const device = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domain = Object.freeze({
    domainId: longestId("domain:"),
    sourceNamespaceId: longestId("namespace:"),
    participantDigest: bytes(0x11),
    participantCount: Number.MAX_SAFE_INTEGER,
    keyClass: "ai" as const,
    domainKeyGeneration: Number.MAX_SAFE_INTEGER,
    authorizationRevision: authorizationRevision(Number.MAX_SAFE_INTEGER),
    headDigest: bytes(0x12),
    activeNamespaceBindingSetDigest: bytes(0x13),
    activeNamespaceBindingCount: Number.MAX_SAFE_INTEGER,
  });
  const deadlineAt = Number.MAX_SAFE_INTEGER;
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: longestId("authorization:"),
    policyRevision: Number.MAX_SAFE_INTEGER,
    sessionId: longestId("session:"),
    roomId: longestId("room:"),
    subjectHumanId: humanId(longestId("human:")),
    committerDeviceId: cryptoDeviceId(longestId("device:")),
    committerDeviceSigningGeneration: Number.MAX_SAFE_INTEGER,
    hostAuthorizationRevision: authorizationRevision(Number.MAX_SAFE_INTEGER),
    recipientKind: "runtime",
    recipientPrincipalId: longestId("principal:"),
    recipientAuthorizationRevision: authorizationRevision(Number.MAX_SAFE_INTEGER),
    recipientRuntimeGeneration: Number.MAX_SAFE_INTEGER,
    recipientKeyId: longestId("recipient:"),
    operations,
    issuedAt: deadlineAt - 7_200_000,
    deadlineAt,
    maximumSecretBytes: 8 * 1024 * 1024,
    domains: [domain],
  });
  const authorization = await mintDomainForegroundAuthorization(crypto, {
    plan,
    domains: [{ ...domain, domainKey: bytes(0x21) }],
    committerDeviceSigningPrivateKey: device.privateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  return Object.freeze({
    plan,
    planBytes: serializeDomainForegroundAuthorizationPlanV2(plan),
    authorizationBytes: serializeDomainForegroundAuthorizationV2(authorization),
  });
}

describe("Task definition foreground authorization evidence", () => {
  test("portable ID retains exact Task work coordinates within 128 bytes", () => {
    const crypto = new LatticeCrypto();
    const input = {
      parentOperationId: longestId("parent:"),
      taskId: "11111111-1111-4111-8111-111111111111",
      operation: "update" as const,
      targetContentRevision: Number.MAX_SAFE_INTEGER,
      workDescriptorDigest: bytes(0x31),
    };
    const authorizationId = taskDefinitionForegroundAuthorizationId(crypto, input);
    expect(authorizationId.length).toBe(126);
    expect(parseTaskDefinitionForegroundAuthorizationId(authorizationId)).toEqual({
      taskId: input.taskId,
      operation: input.operation,
      targetContentRevision: input.targetContentRevision,
      parentOperationHash: crypto.hash(new TextEncoder().encode(
        `nautilo/task-definition-parent-operation/v1\n${input.parentOperationId}`,
      )),
      workDescriptorDigest: input.workDescriptorDigest,
    });
    expect(parseTaskDefinitionForegroundAuthorizationId(`${authorizationId}x`))
      .toBeNull();
  });

  test("derived one-Domain bound matches the canonical maximum V2 encoding", async () => {
    const value = await maximumEvidence();
    expect(value.planBytes.length)
      .toBe(TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_PLAN_BYTES);
    expect(value.authorizationBytes.length)
      .toBe(TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES);
    expect(TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES)
      .toBe(3_675);
    expect(Number(CRYPTO_STORAGE_BYTE_LIMITS.taskDefinitionForegroundAuthorizationEvidence))
      .toBe(TASK_DEFINITION_FOREGROUND_AUTHORIZATION_MAX_EVIDENCE_BYTES);
  });

  test("Task evidence inspection rejects a generic one-operation grant", async () => {
    const value = await maximumEvidence(["decrypt"]);
    expect(inspectTaskDefinitionForegroundAuthorizationEvidence({
      authorizationBytes: value.authorizationBytes,
      expectedAuthorizationId: value.plan.authorizationId,
      expectedPlanBytes: value.planBytes,
      expectedRoomId: value.plan.roomId,
      expectedHumanId: value.plan.subjectHumanId,
      expectedNamespaceId: value.plan.domains[0]!.sourceNamespaceId,
      expectedDomainId: value.plan.domains[0]!.domainId,
    })).toBeNull();
  });

  test("historical Task proof verifies its signed coordinates and private Room", async () => {
    const crypto = new LatticeCrypto();
    const signer = crypto.generateSigningKeyPair();
    const agentSigner = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const workDescriptorDigest = bytes(0x41);
    const coordinates = {
      parentOperationId: "parent-operation",
      taskId: "11111111-1111-4111-8111-111111111111",
      operation: "create" as const,
      targetContentRevision: 1,
      workDescriptorDigest,
    };
    const authorizationId = taskDefinitionForegroundAuthorizationId(
      crypto,
      coordinates,
    );
    const domain = Object.freeze({
      domainId: "domain",
      sourceNamespaceId: "namespace",
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
      policyRevision: 2,
      sessionId: "33333333-3333-4333-8333-333333333333",
      roomId: "private-room",
      subjectHumanId: humanId("human"),
      committerDeviceId: cryptoDeviceId("device"),
      committerDeviceSigningGeneration: 3,
      hostAuthorizationRevision: authorizationRevision(4),
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_foreground_runtime",
      recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 0,
      recipientKeyId: deriveTaskDefinitionForegroundRecipientKeyIdV1(crypto, {
        authorizationId,
        parentAgentSignerPublicKey: agentSigner.publicKey,
      }),
      operations: ["decrypt", "encrypt"],
      issuedAt: 1_000,
      deadlineAt: 2_000,
      maximumSecretBytes: 1_024,
      domains: [domain],
    });
    const authorization = await mintDomainForegroundAuthorization(crypto, {
      plan,
      domains: [{ ...domain, domainKey: bytes(0x54) }],
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    const authorizationBytes = serializeDomainForegroundAuthorizationV2(
      authorization,
    );
    const verify = (overrides: Partial<typeof coordinates & {
      privateRoomId: string;
    }> = {}) => verifyHistoricalTaskDefinitionForegroundAuthorizationEvidence(
      crypto,
      {
        ...coordinates,
        privateRoomId: "private-room",
        humanId: "human",
        namespaceId: "namespace",
        domainId: "domain",
        committerDeviceSigningPublicKey: signer.publicKey,
        authorizationBytes,
        ...overrides,
      },
    );
    expect(verify()).toEqual({ status: "verified" });
    expect(verify({ targetContentRevision: 2 })).toEqual({
      status: "unavailable", reason: "invalid",
    });
    expect(verify({ parentOperationId: "other-parent" })).toEqual({
      status: "unavailable", reason: "invalid",
    });
    expect(verify({ privateRoomId: "shared-room" })).toEqual({
      status: "unavailable", reason: "invalid",
    });

    const principal = Object.freeze({
      agentId: "agent",
      runtimeGeneration: 5,
      signerKeyId: "agent-signer",
    });
    const parentBytes = (
      overrides: Partial<Parameters<typeof encodeLiveShadowMessagePlanV4>[0]> = {},
    ) => encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: coordinates.parentOperationId,
      policyRevision: 2,
      sessionId: "33333333-3333-4333-8333-333333333333",
      roomId: "44444444-4444-4444-8444-444444444444",
      humanMessageId: 1,
      revision: 0,
      createdAt: unixTimestamp(900),
      subjectHumanId: humanId("human"),
      committerDeviceId: cryptoDeviceId("device"),
      committerDeviceSigningKeyGeneration: 3,
      hostAuthorizationRevision: authorizationRevision(4),
      recipientAgentId: agentId("agent"),
      agentAuthorizationRevision: authorizationRevision(1),
      agentRuntimeGeneration: agentRuntimeGeneration(5),
      agentSignerKeyId: "agent-signer",
      agentSignerPublicKey: agentSigner.publicKey,
      namespaceId: namespaceId("55555555-5555-4555-8555-555555555555"),
      namespaceAccessRevision: accessRevision(1),
      namespaceKeyGeneration: namespaceGeneration(1),
      namespaceHeadDigest: bytes(0x61),
      namespacePublicationDigest: bytes(0x62),
      namespacePublicationSetDigest: bytes(0x63),
      namespaceAudienceFingerprint: bytes(0x64),
      grantDomainId: "shared-domain",
      grantDomainParticipantDigest: bytes(0x65),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: bytes(0x66),
      grantDomainPublicationDigest: bytes(0x67),
      grantDomainAuthorizationRevision: authorizationRevision(1),
      namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(1),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: bytes(0x68),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "parent-session-reference",
        authorizationDigest: bytes(0x69),
      },
      attemptCoordinate: "parent-attempt",
      issuedAt: unixTimestamp(900),
      deadlineAt: unixTimestamp(2_100),
      ...overrides,
    });
    type ResolverCoordinates = Partial<Pick<
      Parameters<typeof createTaskDefinitionForegroundAuthorizationResolver>[0],
      "taskId" | "operation" | "targetContentRevision" | "humanId"
    >>;
    const resolve = async (
      inputOverrides: ResolverCoordinates = {},
      parentOverrides: Partial<Parameters<typeof encodeLiveShadowMessagePlanV4>[0]> = {},
      grantLifetime?: Readonly<{ issuedAt: number; deadlineAt: number }>,
    ) => {
      const acceptedPlanBytes = parentBytes(parentOverrides);
      const acceptedPlanDigest = crypto.hash(acceptedPlanBytes);
      const resolver = createTaskDefinitionForegroundAuthorizationResolver({
        crypto,
        expectedObjectId: `task-definition:v1:${coordinates.taskId}`,
        taskId: coordinates.taskId,
        operation: coordinates.operation,
        targetContentRevision: coordinates.targetContentRevision,
        privateRoomId: "private-room",
        humanId: "human",
        namespaceId: "namespace",
        domainId: "domain",
        resolveAcceptedExecutionEvidence: () => Promise.resolve({
          signerPublicKey: agentSigner.publicKey.slice(),
          planBytes: acceptedPlanBytes.slice(),
          planDigest: acceptedPlanDigest.slice(),
          ...(grantLifetime === undefined ? {} : {
            acceptedAuthority: {
              subjectHumanId: "human",
              authorizedNamespaces: [],
              grantLifetime,
            },
          }),
        }),
        resolveHistoricalDeviceSigningPublicKey: () =>
          Promise.resolve(signer.publicKey.slice()),
        ...inputOverrides,
      });
      try {
        return await resolver({
          principal,
          authorizationHash: crypto.hash(authorizationBytes),
          objectId: `task-definition:v1:${coordinates.taskId}`,
          authorizationBytes,
        });
      } finally {
        acceptedPlanBytes.fill(0);
        acceptedPlanDigest.fill(0);
      }
    };
    expect(await resolve()).toEqual(agentSigner.publicKey);
    // A Task may be created after the Message admission deadline, while its
    // separately accepted foreground grant is still live.
    expect(await resolve({}, { deadlineAt: unixTimestamp(950) }, {
      issuedAt: 800, deadlineAt: 2_000,
    })).toEqual(agentSigner.publicKey);
    expect(await resolve({}, { deadlineAt: unixTimestamp(950) })).toBeNull();
    expect(await resolve({}, {}, {
      issuedAt: 800, deadlineAt: 1_999,
    })).toBeNull();
    expect(await resolve({}, {}, {
      issuedAt: 1_001, deadlineAt: 2_100,
    })).toBeNull();
    expect(await resolve({}, { issuedAt: unixTimestamp(1_001) }, {
      issuedAt: 800, deadlineAt: 2_100,
    })).toBeNull();
    for (const [inputOverrides, parentOverrides] of [
      [{ taskId: "22222222-2222-4222-8222-222222222222" }, {}],
      [{ operation: "update" }, {}],
      [{ targetContentRevision: 2 }, {}],
      [{ humanId: "other-human" }, {}],
      [{}, { recipientAgentId: agentId("other-agent") }],
      [{}, { agentSignerKeyId: "other-agent-signer" }],
      [{}, { agentSignerPublicKey: bytes(0x70) }],
      [{}, { policyRevision: 3 }],
      [{}, { sessionId: "66666666-6666-4666-8666-666666666666" }],
      [{}, { committerDeviceId: cryptoDeviceId("other-device") }],
      [{}, { committerDeviceSigningKeyGeneration: 4 }],
      [{}, { hostAuthorizationRevision: authorizationRevision(5) }],
      [{}, { issuedAt: unixTimestamp(1_001) }],
      [{}, { deadlineAt: unixTimestamp(1_999) }],
    ] as const) {
      expect(await resolve(inputOverrides, parentOverrides)).toBeNull();
    }
  });
});
