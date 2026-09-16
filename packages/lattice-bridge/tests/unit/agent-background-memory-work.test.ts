import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptObjectPayload,
  grantId,
  grantWriteRecord,
  humanId,
  mintGrant,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistAgentRuntimeInitialization,
  persistNamespaceBinding,
  prepareAgentRuntimeInitialization,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type GrantAuthoritySetUseAuthorizationContext,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
  backgroundWorkDescriptorDigestV2,
  encodeBackgroundWorkDescriptorV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  type BackgroundProtectedMemoryOutputRevisionV2,
  type BackgroundAgentWorkDescriptorV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  inspectProtectedInvocationCapability,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
} from "../../src/message/conversation-repository.ts";
import {
  encodeMessagePayloadV2,
} from "../../src/message/message-payload-v2.ts";
import {
  createProtectedAgentBackgroundMemoryWorkPort,
  type ProtectedAgentBackgroundMemoryWorkInput,
  type ProtectedAgentBackgroundMemoryWorkOutput,
} from "../../src/memory/agent-background-memory-work.ts";
import {
  encodeMemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
} from "../../src/memory/memory-repository.ts";
import {
  createFakeLatticeStorage,
} from "../../src/testing/fake-lattice-storage.ts";

const NOW = 1_812_300_000_000;
const AGENT_ID = "background-memory-agent";
const HUMAN_ID = "background-memory-human";
const DEVICE_ID = "background-memory-device";
const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_A = "background-memory-domain-a";
const DOMAIN_B = "background-memory-domain-b";
const INPUT_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const OUTPUT_MEMORY_A = "33333333-3333-4333-8333-333333333333";
const OUTPUT_MEMORY_B = "44444444-4444-4444-8444-444444444444";
const RUNTIME_AUTHORIZATION_REVISION = 7;
const TIER_OPERATION_ID = "background-tier-input-memory";

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

function allow(context: GrantAuthoritySetUseAuthorizationContext) {
  return Object.freeze({
    context,
    currentTime: NOW + 10,
    issuingDeviceActive: true,
    recipientAgentAuthorized: true,
    requestedNamespacesAuthorized: true,
    requestedDomainsAuthorized: true,
    hostAllowsOperation: true,
    currentSingleUseStatus: context.singleUseStatus,
  });
}

function everyByteIsZero(values: readonly Uint8Array[]): boolean {
  return values.every((value) => value.every((byte) => byte === 0));
}

function testEmbedding() {
  return Object.freeze({
    provider: "background-test",
    canonicalModel: "background-test-v1",
    vector: Object.freeze(Array.from(
      { length: 1536 },
      (_unused, index) => (index % 8) / 8,
    )),
    dimensions: 1536 as const,
    contractVersion: 1,
  });
}

function output(
  revision: BackgroundProtectedMemoryOutputRevisionV2,
  content: string,
): ProtectedAgentBackgroundMemoryWorkOutput {
  return Object.freeze({
    kind: "content_revision" as const,
    publicationIdempotencyId: revision.publicationIdempotencyId,
    memoryId: revision.memoryId,
    payload: Object.freeze({
      formatVersion: 1 as const,
      type: "fact",
      content,
    }),
    embedding: testEmbedding(),
    importance: 0.75,
  });
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x243_12), {
    now: () => NOW,
  });
  const manager = crypto.generateSigningKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const roots = new Map([
    [DOMAIN_A, new Uint8Array(32).fill(0xa1)],
    [DOMAIN_B, new Uint8Array(32).fill(0xb2)],
  ]);
  const { storage } = createFakeLatticeStorage();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "background-memory-runtime-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision:
      authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
    configObjects: [{
      objectId: objectId("background-memory-runtime-config"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0xc3),
    }],
    domains: [
      {
        domainId: cryptoDomainId(DOMAIN_A),
        domainEpoch: domainEpoch(3),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        domainRoot: roots.get(DOMAIN_A)!,
        committerSigningPrivateKey: manager.privateKey,
      },
      {
        domainId: cryptoDomainId(DOMAIN_B),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        domainRoot: roots.get(DOMAIN_B)!,
        committerSigningPrivateKey: manager.privateKey,
      },
    ],
    resolveCurrentDomainCommitterAuthority: () => manager.publicKey,
    manager: {
      managerHumanId: humanId(HUMAN_ID),
      managerAuthorizationRevision:
        authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
      managerDeviceId: cryptoDeviceId(DEVICE_ID),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentId(AGENT_ID),
        authorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId(HUMAN_ID),
        managerAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        managerDeviceId: cryptoDeviceId(DEVICE_ID),
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: [
        {
          domainId: cryptoDomainId(DOMAIN_A),
          domainEpoch: domainEpoch(3),
          agentAuthorizationRevision:
            authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
          committerDeviceId: cryptoDeviceId(DEVICE_ID),
          committerSigningPublicKey: manager.publicKey,
        },
        {
          domainId: cryptoDomainId(DOMAIN_B),
          domainEpoch: domainEpoch(4),
          agentAuthorizationRevision:
            authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
          committerDeviceId: cryptoDeviceId(DEVICE_ID),
          committerSigningPublicKey: manager.publicKey,
        },
      ],
    }),
  })).toBe("inserted");
  initialized.runtime.key.fill(0);

  const keyrings = new Map<string, ReturnType<typeof createInitialNamespaceKeyrings>>();
  for (const item of [
    { namespaceId: NAMESPACE_A, domainId: DOMAIN_A, epoch: 3 },
    { namespaceId: NAMESPACE_B, domainId: DOMAIN_B, epoch: 4 },
  ] as const) {
    const created = createInitialNamespaceKeyrings(
      crypto,
      namespaceId(item.namespaceId),
    );
    keyrings.set(item.namespaceId, created);
    const metadata = {
      domainId: cryptoDomainId(item.domainId),
      domainEpoch: domainEpoch(item.epoch),
      previousBindingHash: null,
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
    } as const;
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: new Uint8Array(32).fill(item.epoch),
      keyring: created.human,
      metadata,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: roots.get(item.domainId)!,
      keyring: created.ai,
      metadata,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    expect(await persistNamespaceBinding({
      crypto,
      storage,
      prepared: {
        expectedHead: null,
        nextHead: {
          namespaceId: binding.namespaceId,
          accessRevision: binding.accessRevision,
          bindingHash: namespaceBindingHash(binding),
          domainId: binding.domainId,
          domainEpoch: binding.domainEpoch,
        },
        signedBindingBytes: serializeNamespaceBindingV2(binding),
        humanKeyringEnvelopeBytes:
          serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
        aiKeyringEnvelopeBytes:
          serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
      },
      resolveCurrentCommitter: () => manager.publicKey,
    })).toBe("applied");
  }

  function encryptedInput(
    targetObjectId: string,
    targetObjectType: string,
    targetNamespaceId: string,
    plaintext: Uint8Array,
  ) {
    const encrypted = encryptObjectPayload(crypto, {
      objectId: objectId(targetObjectId),
      keyClass: "ai",
      objectType: targetObjectType,
      createdAt: unixTimestamp(NOW),
    }, plaintext);
    plaintext.fill(0);
    const current = keyrings.get(targetNamespaceId)!.ai.generations[0]!;
    const envelope = wrapObjectDekForNamespace(
      crypto,
      current.key,
      {
        objectId: objectId(targetObjectId),
        namespaceId: namespaceId(targetNamespaceId),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(current.generation),
        bindingRevisionAtWrap: accessRevision(0),
      },
      encrypted.dek,
    );
    encrypted.dek.fill(0);
    return Object.freeze({
      payloadBytes: encodeEncryptedPayloadV2(encrypted.payload),
      envelopeBytes: encodeNamespaceObjectEnvelopeV2(envelope),
    });
  }

  const memoryObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: INPUT_MEMORY_ID,
    contentRevision: 1,
  });
  const messageObjectId = "message-background-memory-input";
  const memoryInput = encryptedInput(
    memoryObjectId,
    MEMORY_OBJECT_TYPE,
    NAMESPACE_A,
    encodeMemoryPayloadV1({
      formatVersion: 1,
      type: "preference",
      content: "Use concise answers",
    }),
  );
  const messageInput = encryptedInput(
    messageObjectId,
    CONVERSATION_MESSAGE_OBJECT_TYPE,
    NAMESPACE_B,
    encodeMessagePayloadV2({
      role: "user",
      content: "Remember that I prefer dark mode",
    }),
  );

  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "background-memory-recipient",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("background-memory-grant"),
    issuingDeviceId: cryptoDeviceId(DEVICE_ID),
    issuingHumanId: humanId(HUMAN_ID),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "background-memory-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId(HUMAN_ID)],
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: [
      {
        domainId: cryptoDomainId(DOMAIN_A),
        domainEpoch: domainEpoch(3),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        aiRoot: roots.get(DOMAIN_A)!,
      },
      {
        domainId: cryptoDomainId(DOMAIN_B),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        aiRoot: roots.get(DOMAIN_B)!,
      },
    ],
    singleUse: true,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));

  const rawInputs = [
    {
      source: {
        productKind: "memory" as const,
        productId: INPUT_MEMORY_ID,
        productRevision: 1,
        cryptoAccessRevision: 0,
        accessKind: "namespace" as const,
        objectId: objectId(memoryObjectId),
      },
      binding: {
        objectId: objectId(memoryObjectId),
        namespaceId: namespaceId(NAMESPACE_A),
      },
    },
    {
      source: {
        productKind: "message" as const,
        productId: MESSAGE_ID,
        productRevision: 0,
        objectId: objectId(messageObjectId),
      },
      binding: {
        objectId: objectId(messageObjectId),
        namespaceId: namespaceId(NAMESPACE_B),
      },
    },
  ].sort((left, right) => left.source.objectId.localeCompare(right.source.objectId));
  const rawOutputs = [
    {
      revision: {
        action: "create" as const,
        memoryId: OUTPUT_MEMORY_A,
        expectedContentRevision: 0,
        expectedCryptoAccessRevision: 0,
        nextContentRevision: 1,
        objectId: objectId(deriveMemoryCryptoObjectIdV1({
          memoryId: OUTPUT_MEMORY_A,
          contentRevision: 1,
        })),
        publicationIdempotencyId: "background-publication-a",
      },
      slot: {
        objectId: objectId(deriveMemoryCryptoObjectIdV1({
          memoryId: OUTPUT_MEMORY_A,
          contentRevision: 1,
        })),
        objectType: "memory.revision",
        createdAt: unixTimestamp(NOW + 1),
        namespaceIds: [namespaceId(NAMESPACE_A)],
      },
    },
    {
      revision: {
        action: "create" as const,
        memoryId: OUTPUT_MEMORY_B,
        expectedContentRevision: 0,
        expectedCryptoAccessRevision: 0,
        nextContentRevision: 1,
        objectId: objectId(deriveMemoryCryptoObjectIdV1({
          memoryId: OUTPUT_MEMORY_B,
          contentRevision: 1,
        })),
        publicationIdempotencyId: "background-publication-b",
      },
      slot: {
        objectId: objectId(deriveMemoryCryptoObjectIdV1({
          memoryId: OUTPUT_MEMORY_B,
          contentRevision: 1,
        })),
        objectType: "memory.revision",
        createdAt: unixTimestamp(NOW + 2),
        namespaceIds: [namespaceId(NAMESPACE_B)],
      },
    },
  ].sort((left, right) => left.revision.objectId.localeCompare(right.revision.objectId));
  const descriptor: BackgroundAgentWorkDescriptorV2 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V2,
    requestId: "background-memory-request",
    recipientGeneration: 1,
    workKind: "memory.review",
    workId: "background-memory-work",
    anchorNamespaceId: namespaceId(NAMESPACE_A),
    anchorDomainId: cryptoDomainId(DOMAIN_A),
    subject: {
      kind: "agent",
      agentId: agentId(AGENT_ID),
      runtimeGeneration: agentRuntimeGeneration(0),
      authorizationRevision:
        authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
    },
    purpose: "memory.review",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "protected_memory_work",
      sourceVersion: 1,
      productAuthority: { mode: "namespace" },
      inputRevisions: rawInputs.map((entry) => entry.source),
      outputRevisions: rawOutputs.map((entry) => entry.revision),
      tierMutations: [{
        operationIdempotencyId: TIER_OPERATION_ID,
        memoryId: INPUT_MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        objectId: objectId(memoryObjectId),
        action: "promote",
        expectedTier: 2,
        nextTier: 1,
        requiredNamespaceIds: [namespaceId(NAMESPACE_A)],
      }],
    },
    grantScope: [humanId(HUMAN_ID)],
    inputBindings: rawInputs.map((entry) => entry.binding),
    outputSlots: rawOutputs.map((entry) => entry.slot),
    namespaceRequirements: [
      {
        namespaceId: namespaceId(NAMESPACE_A),
        domainId: cryptoDomainId(DOMAIN_A),
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: authorizationRevision(11),
      },
      {
        namespaceId: namespaceId(NAMESPACE_B),
        domainId: cryptoDomainId(DOMAIN_B),
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: authorizationRevision(12),
      },
    ],
    domainRequirements: [
      {
        domainId: cryptoDomainId(DOMAIN_A),
        expectedEpoch: domainEpoch(3),
        expectedAgentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
      },
      {
        domainId: cryptoDomainId(DOMAIN_B),
        expectedEpoch: domainEpoch(4),
        expectedAgentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
      },
    ],
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 128 * 1_024,
    maximumCiphertextBytes: 256 * 1_024,
    recipientKeyId: "background-memory-recipient",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 60_000,
    idempotencyId: "background-memory-attempt",
  };
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "background-memory-invocation",
    grantId: grant.id,
    issuingHumanId: HUMAN_ID,
    recipientAgentId: AGENT_ID,
    recipientKeyId: grant.recipientKeyId,
    issuingDeviceId: DEVICE_ID,
    namespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    domainIds: Object.freeze([DOMAIN_A, DOMAIN_B]),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
  const capability = createProtectedInvocationCapability({
    coordinates,
    recipient: recipient.recipient,
    workDescriptorHash: backgroundWorkDescriptorDigestV2(crypto, descriptor),
  });
  const facts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
    now: NOW + 1,
    expectedIssuingDeviceId: DEVICE_ID,
    issuingDeviceHumanId: HUMAN_ID,
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: AGENT_ID,
    recipientKeyId: grant.recipientKeyId,
    singleUseAvailable: true,
    grantScope: [HUMAN_ID],
    namespaceRequirements: [
      {
        namespaceId: namespaceId(NAMESPACE_A),
        domainId: cryptoDomainId(DOMAIN_A),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: [humanId(HUMAN_ID)],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: authorizationRevision(11),
      },
      {
        namespaceId: namespaceId(NAMESPACE_B),
        domainId: cryptoDomainId(DOMAIN_B),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: [humanId(HUMAN_ID)],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: authorizationRevision(12),
      },
    ],
    domainRequirements: descriptor.domainRequirements,
    hostAllowsOperation: true,
  });
  let currentFacts: ProtectedGrantAuthoritySetFactsV2 | null = facts;
  const authority: ProtectedGrantAuthoritySetPortV2 = {
    resolvePreflightFacts: () => currentFacts,
    resolveCurrentAuthorization: (context) => allow(context),
  };
  const returnedBytes: Uint8Array[] = [];
  const planCalls: Array<Readonly<{ operationId: string; namespaceIds: readonly string[] }>> = [];
  const published: Array<Readonly<{ operationId: string; namespaceIds: readonly string[] }>> = [];
  const tierPlanned: string[] = [];
  const tierCommitted: string[] = [];
  const publicationStatuses: Array<"published" | "replayed" | "stale" | "deleted" | Error> = [];
  let readerMismatch: "memory" | "message" | null = null;
  let planFailure: "throw" | "mismatch" | "unavailable" | null = null;
  const port = createProtectedAgentBackgroundMemoryWorkPort({
    crypto,
    storage,
    authority,
    resolveHistoricalNamespaceCommitter: () => manager.publicKey,
    resolveHistoricalRuntimeCommitter: () => manager.publicKey,
    memoryReader: {
      read: async (request) => {
        if (
          request.memoryId !== INPUT_MEMORY_ID
          || request.contentRevision !== 1
          || request.cryptoAccessRevision !== 0
          || request.accessKind !== "namespace"
          || request.productAuthority.mode !== "namespace"
          || request.objectId !== memoryObjectId
          || request.selectedNamespaceId !== NAMESPACE_A
        ) return null;
        const payloadBytes = memoryInput.payloadBytes.slice();
        const envelopeBytes = memoryInput.envelopeBytes.slice();
        const accessManifestBytes = new Uint8Array([0x91]);
        const accessManifestHash = new Uint8Array(32).fill(0x92);
        const accessManifestSignerPublicKey = new Uint8Array(32).fill(0x93);
        returnedBytes.push(
          payloadBytes,
          envelopeBytes,
          accessManifestBytes,
          accessManifestHash,
          accessManifestSignerPublicKey,
        );
        return Object.freeze({
          memoryId: readerMismatch === "memory"
            ? OUTPUT_MEMORY_A
            : INPUT_MEMORY_ID,
          contentRevision: 1,
          cryptoAccessRevision: 0,
          importance: 0.75,
          tier: 2 as const,
          createdAt: NOW - 1_000,
          embedding: testEmbedding(),
          objectId: memoryObjectId,
          accessRevision: 0,
          accessManifestBytes,
          accessManifestHash,
          accessManifestSignerPublicKey,
          requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
          payloadBytes,
          namespaceEnvelopes: Object.freeze([Object.freeze({
            namespaceId: NAMESPACE_A,
            envelopeBytes,
          })]),
        });
      },
    },
    messageReader: {
      read: async (request) => {
        if (
          request.productId !== MESSAGE_ID
          || request.productRevision !== 0
          || request.objectId !== messageObjectId
          || request.selectedNamespaceId !== NAMESPACE_B
        ) return null;
        const payloadBytes = messageInput.payloadBytes.slice();
        const namespaceEnvelopeBytes = messageInput.envelopeBytes.slice();
        returnedBytes.push(payloadBytes, namespaceEnvelopeBytes);
        return Object.freeze({
          productId: readerMismatch === "message"
            ? INPUT_MEMORY_ID
            : MESSAGE_ID,
          productRevision: 0,
          objectId: messageObjectId,
          namespaceId: NAMESPACE_B,
          role: "user" as const,
          payloadBytes,
          namespaceEnvelopeBytes,
        });
      },
    },
    product: {
      planBackgroundOutput: async (request) => {
        planCalls.push(Object.freeze({
          operationId: request.publicationIdempotencyId,
          namespaceIds: Object.freeze([...request.requiredNamespaceIds]),
        }));
        if (planFailure === "throw") throw new Error("provider unavailable");
        if (planFailure === "unavailable") {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "embedding_unavailable" as const,
          });
        }
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({
            operationId: planFailure === "mismatch"
              ? "wrong-publication"
              : request.publicationIdempotencyId,
            action: "created" as const,
            mutationKind: "background" as const,
            memoryId: request.memoryId,
            contentRevision: request.nextContentRevision,
            cryptoAccessRevision: 0,
            expectedPriorAccessRevision: request.expectedCryptoAccessRevision,
            cryptoObjectId: request.cryptoObjectId,
            requiredNamespaceIds:
              Object.freeze([...request.requiredNamespaceIds]),
            reservationDigest: new Uint8Array(32),
            mutationCommitment: request.descriptorHash.slice(),
            importance: request.importance,
            createdAt: request.createdAt,
          }),
        });
      },
      publishPrepared: async (request) => {
        published.push(Object.freeze({
          operationId: request.plan.operationId,
          namespaceIds: request.plan.requiredNamespaceIds,
        }));
        const next = publicationStatuses.shift() ?? "published";
        if (next instanceof Error) throw next;
        return next;
      },
      planBackgroundTier: async (request) => {
        tierPlanned.push(request.operationIdempotencyId);
        return Object.freeze({ status: "success" as const, value: request });
      },
      commitBackgroundTier: async ({ plan }) => {
        tierCommitted.push(plan.operationIdempotencyId);
        return "applied" as const;
      },
    },
  });
  return {
    capability,
    crypto,
    descriptor,
    facts,
    keyrings,
    planCalls,
    port,
    publicationStatuses,
    published,
    returnedBytes,
    tierCommitted,
    tierPlanned,
    setFacts(value: ProtectedGrantAuthoritySetFactsV2 | null) {
      currentFacts = value;
    },
    setPlanFailure(value: typeof planFailure) {
      planFailure = value;
    },
    setReaderMismatch(value: typeof readerMismatch) {
      readerMismatch = value;
    },
  };
}

describe("terminal protected Agent background Memory work", () => {
  test("commits an exact tier-only signed transition with no content row", async () => {
    const state = await fixture();
    const result = await state.port.execute({
      capability: state.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        state.crypto,
        state.descriptor,
      ),
      transform: () => [Object.freeze({
        kind: "tier_transition" as const,
        operationIdempotencyId: TIER_OPERATION_ID,
        memoryId: INPUT_MEMORY_ID,
        action: "promote" as const,
      })],
    });
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value).toEqual({
      status: "completed",
      publications: [{
        kind: "tier_transition",
        operationIdempotencyId: TIER_OPERATION_ID,
        memoryId: INPUT_MEMORY_ID,
        status: "published",
      }],
    });
    expect(state.tierPlanned).toEqual([TIER_OPERATION_ID]);
    expect(state.tierCommitted).toEqual([TIER_OPERATION_ID]);
    expect(state.planCalls).toEqual([]);
    expect(state.published).toEqual([]);
  });

  test("opens mixed inputs and publishes exact per-output Namespace subsets", async () => {
    const state = await fixture();
    const outputs = state.descriptor.source.kind === "protected_memory_work"
      ? state.descriptor.source.outputRevisions
      : [];
    let seenInputs: readonly ProtectedAgentBackgroundMemoryWorkInput[] = [];
    const result = await state.port.execute({
      capability: state.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        state.crypto,
        state.descriptor,
      ),
      transform: (inputs) => {
        seenInputs = inputs;
        return [
          output(outputs[0]!, "first output"),
          output(outputs[1]!, "second output"),
        ];
      },
    });
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value.status).toBe("completed");
    expect(seenInputs).toHaveLength(2);
    const openedMemory = seenInputs.find((entry) =>
      entry.productKind === "memory"
    );
    const openedMessage = seenInputs.find((entry) =>
      entry.productKind === "message"
    );
    expect(openedMemory?.payload.content).toBe("Use concise answers");
    expect(openedMessage?.payload.content)
      .toBe("Remember that I prefer dark mode");
    expect(state.planCalls).toEqual(outputs.map((entry, index) => ({
      operationId: entry.publicationIdempotencyId,
      namespaceIds: state.descriptor.outputSlots[index]!.namespaceIds,
    })));
    expect(state.published).toEqual(state.planCalls);
    expect(everyByteIsZero(state.returnedBytes)).toBe(true);
    expect(inspectProtectedInvocationCapability(state.capability)).toBeNull();
  });

  test("uses only an ordered signed-slot subset and permits no output", async () => {
    const state = await fixture();
    const outputs = state.descriptor.source.kind === "protected_memory_work"
      ? state.descriptor.source.outputRevisions
      : [];
    const result = await state.port.execute({
      capability: state.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        state.crypto,
        state.descriptor,
      ),
      transform: () => [output(outputs[1]!, "only second slot")],
    });
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value.status).toBe("completed");
    expect(state.planCalls).toEqual([{
      operationId: outputs[1]!.publicationIdempotencyId,
      namespaceIds: state.descriptor.outputSlots[1]!.namespaceIds,
    }]);

    const empty = await fixture();
    const noOutput = await empty.port.execute({
      capability: empty.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(empty.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        empty.crypto,
        empty.descriptor,
      ),
      transform: () => [],
    });
    expect(noOutput).toEqual({
      status: "executed",
      value: {
        status: "completed",
        publications: [],
      },
    });
    expect(empty.planCalls).toHaveLength(0);
    expect(empty.published).toHaveLength(0);
  });

  test("rejects duplicate, reordered, unknown, and mismatched signed slots", async () => {
    for (const mutation of ["duplicate", "reordered", "unknown", "memory"] as const) {
      const state = await fixture();
      const revisions = state.descriptor.source.kind === "protected_memory_work"
        ? state.descriptor.source.outputRevisions
        : [];
      const first = output(revisions[0]!, "first");
      const second = output(revisions[1]!, "second");
      const outputs = mutation === "duplicate"
        ? [first, first]
        : mutation === "reordered"
          ? [second, first]
          : mutation === "unknown"
            ? [{ ...first, publicationIdempotencyId: "unknown-publication" }]
            : [{ ...first, memoryId: revisions[1]!.memoryId }];
      const result = await state.port.execute({
        capability: state.capability,
        descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
        descriptorHash: backgroundWorkDescriptorDigestV2(
          state.crypto,
          state.descriptor,
        ),
        transform: () => outputs,
      });
      expect(result).toEqual({
        status: "executed",
        value: { status: "unavailable", reason: "transform_invalid" },
      });
      expect(state.planCalls).toHaveLength(0);
      expect(state.published).toHaveLength(0);
      expect(inspectProtectedInvocationCapability(state.capability)).toBeNull();
      expect(everyByteIsZero(state.returnedBytes)).toBe(true);
    }
  });

  test("reports recoverable partial publication and rejects terminal replay", async () => {
    const state = await fixture();
    state.publicationStatuses.push("published", new Error("database restart"));
    const revisions = state.descriptor.source.kind === "protected_memory_work"
      ? state.descriptor.source.outputRevisions
      : [];
    const descriptorBytes = encodeBackgroundWorkDescriptorV2(state.descriptor);
    const descriptorHash = backgroundWorkDescriptorDigestV2(
      state.crypto,
      state.descriptor,
    );
    const request = {
      capability: state.capability,
      descriptorBytes,
      descriptorHash,
      transform: () => revisions.map((entry, index) =>
        output(entry, `output ${index}`)
      ),
    } as const;
    const result = await state.port.execute(request);
    expect(result.status).toBe("executed");
    if (result.status !== "executed") throw new Error("expected execution");
    expect(result.value.status).toBe("publication_pending");
    if (result.value.status === "unavailable") {
      throw new Error("expected publication outcomes");
    }
    expect(result.value.publications.map((entry) => entry.status))
      .toEqual(["published", "pending"]);
    expect(state.published).toHaveLength(2);
    expect(await state.port.execute(request)).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(state.published).toHaveLength(2);
  });

  test("rejects authenticated-reader coordinate mismatches and wipes bytes", async () => {
    for (const kind of ["memory", "message"] as const) {
      const state = await fixture();
      state.setReaderMismatch(kind);
      const result = await state.port.execute({
        capability: state.capability,
        descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
        descriptorHash: backgroundWorkDescriptorDigestV2(
          state.crypto,
          state.descriptor,
        ),
        transform: () => [],
      });
      expect(result).toEqual({
        status: "executed",
        value: { status: "unavailable", reason: "content_invalid" },
      });
      expect(everyByteIsZero(state.returnedBytes)).toBe(true);
      expect(state.planCalls).toHaveLength(0);
    }
  });

  test("maps transform and output-planning failures without publishing", async () => {
    const provider = await fixture();
    const thrown = await provider.port.execute({
      capability: provider.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(provider.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        provider.crypto,
        provider.descriptor,
      ),
      transform: () => {
        throw new Error("model unavailable");
      },
    });
    expect(thrown).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "transform_unavailable" },
    });
    expect(everyByteIsZero(provider.returnedBytes)).toBe(true);
    expect(provider.published).toHaveLength(0);

    for (const failure of ["throw", "unavailable", "mismatch"] as const) {
      const state = await fixture();
      state.setPlanFailure(failure);
      const revisions = state.descriptor.source.kind === "protected_memory_work"
        ? state.descriptor.source.outputRevisions
        : [];
      const result = await state.port.execute({
        capability: state.capability,
        descriptorBytes: encodeBackgroundWorkDescriptorV2(state.descriptor),
        descriptorHash: backgroundWorkDescriptorDigestV2(
          state.crypto,
          state.descriptor,
        ),
        transform: () => [output(revisions[0]!, "planned")],
      });
      expect(result).toEqual({
        status: "executed",
        value: {
          status: "unavailable",
          reason: "output_plan_unavailable",
        },
      });
      expect(state.published).toHaveLength(0);
      expect(everyByteIsZero(state.returnedBytes)).toBe(true);
    }
  });

  test("rejects a forged descriptor hash and stale exact authority", async () => {
    const forged = await fixture();
    const forgedHash = backgroundWorkDescriptorDigestV2(
      forged.crypto,
      forged.descriptor,
    );
    forgedHash[0] = forgedHash[0]! ^ 0xff;
    expect(await forged.port.execute({
      capability: forged.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(forged.descriptor),
      descriptorHash: forgedHash,
      transform: () => [],
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(inspectProtectedInvocationCapability(forged.capability)).toBeNull();

    const stale = await fixture();
    stale.setFacts(Object.freeze({
      ...stale.facts,
      namespaceRequirements: Object.freeze(
        stale.facts.namespaceRequirements.map((entry, index) =>
          index === 0
            ? Object.freeze({
              ...entry,
              expectedPolicyRevision:
                authorizationRevision(entry.expectedPolicyRevision + 1),
            })
            : entry
        ),
      ),
    }));
    expect(await stale.port.execute({
      capability: stale.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(stale.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        stale.crypto,
        stale.descriptor,
      ),
      transform: () => [],
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(stale.returnedBytes).toHaveLength(0);

    const expired = await fixture();
    expired.setFacts(Object.freeze({
      ...expired.facts,
      now: expired.descriptor.expiresAt + 1,
    }));
    expect(await expired.port.execute({
      capability: expired.capability,
      descriptorBytes: encodeBackgroundWorkDescriptorV2(expired.descriptor),
      descriptorHash: backgroundWorkDescriptorDigestV2(
        expired.crypto,
        expired.descriptor,
      ),
      transform: () => [],
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(expired.returnedBytes).toHaveLength(0);
  });
});
