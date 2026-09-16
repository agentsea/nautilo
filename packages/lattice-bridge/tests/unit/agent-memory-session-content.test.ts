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
  decryptObjectThroughNamespace,
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
  prepareHumanObjectAccessManifestGenesisSet,
  resealNamespaceKeyring,
  sealNamespaceKeyring,
  unixTimestamp,
  verifyCommonObjectAccessManifest,
  wrapObjectDekForNamespace,
  type GrantAuthoritySetUseAuthorizationContext,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation.ts";
import {
  createProtectedAgentMemorySessionContentPort,
  type VerifiedAgentMemoryCryptoRevisionContent,
} from "../../src/memory/agent-memory-session-content.ts";
import {
  agentMemoryExactAccessRequestDigest,
  createProtectedAgentMemoryExactAccessContentPort,
  readPreparedAgentMemoryExactAccessSnapshot,
} from "../../src/memory/agent-memory-exact-access.ts";
import { PostgresAgentMemoryExactAccessProduct } from "../../src/server/memory/postgres-agent-memory-exact-access-product.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import type {
  ProtectedMemoryAuthority,
} from "../../src/memory/active-memory-repository.ts";
import type {
  ProtectedMemoryCandidate,
  ProtectedMemoryMutationPlan,
} from "../../src/memory/active-memory-composition.ts";
import {
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  fingerprintRequiredMemoryNamespaces,
  type PreparedMemoryCryptoRevision,
} from "../../src/memory/memory-repository.ts";
import {
  readPreparedMemoryCryptoRevisionSnapshot,
} from "../../src/memory/memory-prepared-revision.ts";
import {
  createFakeLatticeStorage,
} from "../../src/testing/fake-lattice-storage.ts";

const NOW = 1_812_000_000_000;
const AGENT_ID = "memory-session-agent";
const HUMAN_ID = "memory-session-human";
const DEVICE_ID = "memory-session-device";
const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_A = "memory-session-domain-a";
const DOMAIN_B = "memory-session-domain-b";
const MEMORY_A = "11111111-1111-4111-8111-111111111111";
const MEMORY_B = "22222222-2222-4222-8222-222222222222";
const RUNTIME_AUTHORIZATION_REVISION = 7;

class ExactAccessProductConnection
  implements ConversationProductPostgresConnection {
  namespaceIds = [NAMESPACE_A];
  accessRevision = 0;
  fingerprint = fingerprintRequiredMemoryNamespaces(this.namespaceIds);
  operation: Readonly<{
    operationId: string;
    requestDigest: Uint8Array;
    targetFingerprint: Uint8Array;
    expectedAccessRevision: number;
    resultAccessRevision: number;
    completion: "pending" | "complete";
    disposition: "active" | "complete";
  }> | null = null;
  cryptoCalls = 0;

  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_agent",
        session_user: "nautilo_agent",
      }] as unknown as Row[]);
    }
    return this.run(statement, parameters);
  }

  transaction<Result>(
    callback: (connection: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }

  run<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    const normalized = statement.toLowerCase();
    if (statement.includes("app_current_user_id")) {
      return Promise.resolve([{
        current_user_id: HUMAN_ID,
        current_agent_id: AGENT_ID,
      }] as unknown as Row[]);
    }
    if (
      statement.includes("agent-memory:exact-access:operation")
      || normalized.includes('from "memory_crypto_operations"')
    ) {
      if (this.operation === null) return Promise.resolve([]);
      return Promise.resolve([{
        operation_id: this.operation.operationId,
        memory_id: MEMORY_A,
        operation_type: "access",
        anchor_namespace_id: NAMESPACE_A,
        expected_content_revision: 1,
        result_content_revision: null,
        expected_access_revision: this.operation.expectedAccessRevision,
        result_access_revision: this.operation.resultAccessRevision,
        request_digest: this.operation.requestDigest,
        target_required_namespace_fingerprint:
          this.operation.targetFingerprint,
        completion: this.operation.completion,
        disposition: this.operation.disposition,
      }] as unknown as Row[]);
    }
    if (statement.includes("agent-memory:exact-access:lock-product")) {
      return Promise.resolve([{
        memory_id: MEMORY_A,
        content_revision: 1,
        crypto_access_revision: this.accessRevision,
        crypto_object_id: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_A,
          contentRevision: 1,
        }),
        crypto_required_namespace_fingerprint: this.fingerprint,
        scope_origin_namespace_id: null,
        namespace_ids: JSON.stringify(this.namespaceIds),
        scope_origin_count: 0,
      }] as unknown as Row[]);
    }
    if (
      statement.includes("agent-memory:exact-access:reserve")
      || normalized.startsWith('insert into "memory_crypto_operations"')
    ) {
      this.operation = Object.freeze({
        operationId: parameters[0] as string,
        requestDigest: (parameters[8] as Uint8Array).slice(),
        targetFingerprint: (parameters[9] as Uint8Array).slice(),
        expectedAccessRevision: parameters[6] as number,
        resultAccessRevision: parameters[7] as number,
        completion: "pending",
        disposition: "active",
      });
      return Promise.resolve([]);
    }
    if (
      statement.includes("INSERT INTO memory_namespaces")
      || normalized.startsWith('insert into "memory_namespaces"')
    ) {
      const namespaceId = parameters[1] as string;
      this.namespaceIds = [...this.namespaceIds, namespaceId].sort();
      return Promise.resolve([{ namespace_id: namespaceId }] as unknown as Row[]);
    }
    if (statement.includes("UPDATE memories")) {
      this.accessRevision = parameters[2] as number;
      this.fingerprint = (parameters[3] as Uint8Array).slice();
      return Promise.resolve([{ memory_id: MEMORY_A }] as unknown as Row[]);
    }
    if (
      statement.includes("UPDATE memory_crypto_operations")
      || normalized.startsWith('update "memory_crypto_operations"')
    ) {
      if (this.operation === null) return Promise.resolve([]);
      this.operation = Object.freeze({
        ...this.operation,
        completion: "complete",
        disposition: "complete",
      });
      return Promise.resolve([{
        operation_id: this.operation.operationId,
      }] as unknown as Row[]);
    }
    throw new Error(`Unexpected exact product SQL: ${statement}`);
  }
}

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

function plan(
  memoryId: string,
  contentRevision: number,
): ProtectedMemoryMutationPlan {
  return Object.freeze({
    operationId: `memory-operation-${memoryId}-${contentRevision}`,
    action: contentRevision === 1 ? "created" as const : "updated" as const,
    mutationKind: "save" as const,
    memoryId,
    contentRevision,
    cryptoAccessRevision: 0,
    expectedPriorAccessRevision: 0,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId,
      contentRevision,
    }),
    requiredNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    reservationDigest: new Uint8Array(32),
    mutationCommitment: new Uint8Array(32),
    importance: 0.6,
    createdAt: NOW + contentRevision,
  });
}

function candidate(
  currentPlan: ProtectedMemoryMutationPlan,
  readNamespaceId = NAMESPACE_B,
): ProtectedMemoryCandidate {
  return Object.freeze({
    memoryId: currentPlan.memoryId,
    contentRevision: currentPlan.contentRevision,
    cryptoAccessRevision: currentPlan.cryptoAccessRevision,
    cryptoObjectId: currentPlan.cryptoObjectId,
    readNamespaceId,
    requiredNamespaceIds: currentPlan.requiredNamespaceIds,
    importance: 0.8,
    tier: 2,
    score: 0.9,
    createdAt: new Date(currentPlan.createdAt),
  });
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x243_120), {
    now: () => NOW,
  });
  const manager = crypto.generateSigningKeyPair();
  const issuer = crypto.generateSigningKeyPair();
  const roots = Object.freeze({
    [DOMAIN_A]: new Uint8Array(32).fill(0xa1),
    [DOMAIN_B]: new Uint8Array(32).fill(0xb2),
  });
  const rootFor = (targetDomainId: string): Uint8Array => {
    if (targetDomainId === DOMAIN_A) return roots[DOMAIN_A];
    if (targetDomainId === DOMAIN_B) return roots[DOMAIN_B];
    throw new Error("unknown test Domain root");
  };
  const { storage } = createFakeLatticeStorage();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "memory-session-runtime-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision:
      authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
    configObjects: [{
      objectId: objectId("memory-session-runtime-config"),
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
        domainRoot: roots[DOMAIN_A],
        committerSigningPrivateKey: manager.privateKey,
      },
      {
        domainId: cryptoDomainId(DOMAIN_B),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        domainRoot: roots[DOMAIN_B],
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

  const bindingHashes = new Map<string, Uint8Array>();
  const aiNamespaceKeys = new Map<string, Readonly<{
    currentGeneration: number;
    generations: readonly Readonly<{
      generation: number;
      key: Uint8Array;
    }>[];
  }>>();
  const bindingStates = new Map<string, Readonly<{
    domainId: string;
    epoch: number;
    humanRoot: Uint8Array;
    humanEnvelope: ReturnType<typeof sealNamespaceKeyring>;
    aiEnvelope: ReturnType<typeof sealNamespaceKeyring>;
    binding: ReturnType<typeof createNamespaceBinding>;
    bindingHash: Uint8Array;
  }>>();
  for (const item of [
    { namespaceId: NAMESPACE_A, domainId: DOMAIN_A, epoch: 3 },
    { namespaceId: NAMESPACE_B, domainId: DOMAIN_B, epoch: 4 },
  ] as const) {
    const keyrings = createInitialNamespaceKeyrings(
      crypto,
      namespaceId(item.namespaceId),
    );
    aiNamespaceKeys.set(item.namespaceId, Object.freeze({
      currentGeneration: Number(keyrings.ai.currentGeneration),
      generations: Object.freeze(keyrings.ai.generations.map((entry) =>
        Object.freeze({
          generation: Number(entry.generation),
          key: entry.key.slice(),
        })
      )),
    }));
    const metadata = {
      domainId: cryptoDomainId(item.domainId),
      domainEpoch: domainEpoch(item.epoch),
      previousBindingHash: null,
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
    } as const;
    const humanRoot = new Uint8Array(32).fill(item.epoch);
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: humanRoot,
      keyring: keyrings.human,
      metadata,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: roots[item.domainId],
      keyring: keyrings.ai,
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
    const bindingHash = namespaceBindingHash(binding);
    bindingHashes.set(item.namespaceId, bindingHash.slice());
    bindingStates.set(item.namespaceId, Object.freeze({
      domainId: item.domainId,
      epoch: item.epoch,
      humanRoot,
      humanEnvelope,
      aiEnvelope,
      binding,
      bindingHash: bindingHash.slice(),
    }));
    expect(await persistNamespaceBinding({
      crypto,
      storage,
      prepared: {
        expectedHead: null,
        nextHead: {
          namespaceId: binding.namespaceId,
          accessRevision: binding.accessRevision,
          bindingHash,
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

  const recipient = await createProtectedInvocationRecipient({
    crypto,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "memory-session-recipient",
  });
  const grant = await mintGrant(crypto, {
    id: grantId("memory-session-grant"),
    issuingDeviceId: cryptoDeviceId(DEVICE_ID),
    issuingHumanId: humanId(HUMAN_ID),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentId(AGENT_ID),
    recipientKeyId: "memory-session-recipient",
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
        aiRoot: roots[DOMAIN_A],
      },
      {
        domainId: cryptoDomainId(DOMAIN_B),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        aiRoot: roots[DOMAIN_B],
      },
    ],
    singleUse: false,
  });
  await storage.putGrant(grantWriteRecord(serializeGrantV2(grant)));
  const coordinates: ProtectedInvocationCoordinates = Object.freeze({
    invocationId: "memory-session-invocation",
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
  });
  const baseFacts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
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
        namespaceParticipants: [HUMAN_ID],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: 11,
      },
      {
        namespaceId: namespaceId(NAMESPACE_B),
        domainId: cryptoDomainId(DOMAIN_B),
        operations: ["decrypt", "encrypt"] as const,
        namespaceParticipants: [HUMAN_ID],
        expectedAccessRevision: accessRevision(0),
        expectedPolicyRevision: 12,
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
    hostAllowsOperation: true,
  });
  let facts = baseFacts;
  const authority: ProtectedGrantAuthoritySetPortV2 = {
    resolvePreflightFacts: () => facts,
    resolveCurrentAuthorization: (context) => allow(context),
  };
  const durable = new Map<string, VerifiedAgentMemoryCryptoRevisionContent>();
  const returnedBytes: Uint8Array[] = [];
  const revisionReader = {
    read: async (reference: Readonly<{ objectId: string }>) => {
      const stored = durable.get(reference.objectId);
      if (stored === undefined) return null;
      const value = Object.freeze({
        ...stored,
        requiredNamespaceIds:
          Object.freeze([...stored.requiredNamespaceIds]),
        payloadBytes: stored.payloadBytes.slice(),
        accessManifestBytes: stored.accessManifestBytes.slice(),
        accessManifestHash: stored.accessManifestHash.slice(),
        accessManifestSignerPublicKey:
          stored.accessManifestSignerPublicKey.slice(),
        ...(stored.accessManifestSignerAuthorizationBytes === undefined
          ? {}
          : {
            accessManifestSignerAuthorizationBytes:
              stored.accessManifestSignerAuthorizationBytes.slice(),
          }),
        ...(stored.accessManifestSignerIssuingPublicKey === undefined
          ? {}
          : {
            accessManifestSignerIssuingPublicKey:
              stored.accessManifestSignerIssuingPublicKey.slice(),
          }),
        ...(stored.accessSignerEvidence === undefined
          ? {}
          : {
            accessSignerEvidence: Object.freeze(
              stored.accessSignerEvidence.map((entry) => Object.freeze({
                kind: entry.kind,
                evidenceBytes: entry.evidenceBytes.slice(),
              })),
            ),
          }),
        namespaceEnvelopes: Object.freeze(
          stored.namespaceEnvelopes.map((entry) => Object.freeze({
            namespaceId: entry.namespaceId,
            envelopeBytes: entry.envelopeBytes.slice(),
          })),
        ),
      });
      returnedBytes.push(
        value.payloadBytes,
        value.accessManifestBytes,
        value.accessManifestHash,
        value.accessManifestSignerPublicKey,
        ...(value.accessManifestSignerAuthorizationBytes === undefined
          ? []
          : [value.accessManifestSignerAuthorizationBytes]),
        ...(value.accessManifestSignerIssuingPublicKey === undefined
          ? []
          : [value.accessManifestSignerIssuingPublicKey]),
        ...(value.accessSignerEvidence ?? []).map((entry) =>
          entry.evidenceBytes
        ),
        ...value.namespaceEnvelopes.map((entry) => entry.envelopeBytes),
      );
      return value;
    },
  };
  const createPort = () => createProtectedAgentMemorySessionContentPort({
      crypto,
      storage,
      authority,
      resolveHistoricalNamespaceCommitter: () => manager.publicKey,
      resolveHistoricalRuntimeCommitter: () => manager.publicKey,
      revisionReader,
    });
  const port = createPort();
  const exactAccessPort = createProtectedAgentMemoryExactAccessContentPort({
    crypto,
    storage,
    authority,
    resolveHistoricalNamespaceCommitter: () => manager.publicKey,
    resolveHistoricalRuntimeCommitter: () => manager.publicKey,
    revisionReader,
  });
  const namespaceAuthority: ProtectedMemoryAuthority = Object.freeze({
    mode: "namespace" as const,
    subjectUserId: HUMAN_ID,
    agentId: AGENT_ID,
    readableNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    mutableNamespaceIds: Object.freeze([NAMESPACE_A, NAMESPACE_B]),
    writableNamespaceId: NAMESPACE_A,
  });
  function retain(prepared: PreparedMemoryCryptoRevision): void {
    const snapshot = readPreparedMemoryCryptoRevisionSnapshot(prepared);
    const namespaceEnvelopes = snapshot.access.envelopeBytes.map((bytes) => ({
      namespaceId:
        decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
      envelopeBytes: bytes.slice(),
    })).reverse();
    durable.set(prepared.objectId, Object.freeze({
      memoryId: prepared.memoryId,
      contentRevision: prepared.contentRevision,
      objectId: prepared.objectId,
      accessRevision: 0,
      accessManifestBytes: snapshot.access.manifestBytes.slice(),
      accessManifestHash: snapshot.access.manifestHash.slice(),
      accessManifestSignerPublicKey:
        initialized.signerPublication.signerPublicKey.slice(),
      requiredNamespaceIds: prepared.requiredNamespaceIds,
      payloadBytes: snapshot.object.payloadBytes.ciphertext.slice(),
      namespaceEnvelopes: Object.freeze(namespaceEnvelopes),
    }));
  }
  function retainExact(
    prepared: Parameters<typeof readPreparedAgentMemoryExactAccessSnapshot>[0],
  ): void {
    const snapshot = readPreparedAgentMemoryExactAccessSnapshot(prepared);
    const current = durable.get(snapshot.plan.cryptoObjectId);
    if (current === undefined) throw new Error("missing current exact publication");
    durable.set(snapshot.plan.cryptoObjectId, Object.freeze({
      ...current,
      accessRevision: snapshot.plan.nextCryptoAccessRevision,
      accessManifestBytes: snapshot.prepared.manifestBytes.slice(),
      accessManifestHash: snapshot.prepared.manifestHash.slice(),
      requiredNamespaceIds: snapshot.plan.targetNamespaceIds,
      namespaceEnvelopes: Object.freeze(
        snapshot.prepared.envelopeBytes.map((bytes) => Object.freeze({
          namespaceId: String(
            decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
          ),
          envelopeBytes: bytes.slice(),
        })),
      ),
    }));
  }
  function setSignerEvidence(
    cryptoObjectId: string,
    evidence: VerifiedAgentMemoryCryptoRevisionContent["accessSignerEvidence"],
  ): void {
    const current = durable.get(cryptoObjectId);
    if (current === undefined) throw new Error("missing signer evidence fixture");
    durable.set(cryptoObjectId, Object.freeze({
      ...current,
      ...(evidence === undefined
        ? {}
        : {
          accessSignerEvidence: Object.freeze(
            evidence.map((entry) => Object.freeze({
              kind: entry.kind,
              evidenceBytes: entry.evidenceBytes.slice(),
            })),
          ),
        }),
    }));
  }
  async function rotateNamespaceBindingHead(
    targetNamespaceId: string,
  ): Promise<void> {
    const current = bindingStates.get(targetNamespaceId);
    if (current === undefined) throw new Error("missing binding state");
    const nextRevision = Number(current.binding.accessRevision) + 1;
    const metadata = {
      domainId: cryptoDomainId(current.domainId),
      domainEpoch: domainEpoch(current.epoch),
      accessRevision: accessRevision(nextRevision),
      previousBindingHash: current.bindingHash,
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
    } as const;
    const humanEnvelope = resealNamespaceKeyring({
      crypto,
      oldDomainRoot: current.humanRoot,
      oldEnvelope: current.humanEnvelope,
      resolveHistoricalCommitter: () => manager.publicKey,
      newDomainRoot: current.humanRoot,
      newMetadata: metadata,
      newCommitterSigningPrivateKey: manager.privateKey,
      resolveSourceCommitter: () => manager.publicKey,
      resolveCurrentCommitter: () => manager.publicKey,
      rotateGeneration: false,
    });
    const aiEnvelope = resealNamespaceKeyring({
      crypto,
      oldDomainRoot: rootFor(current.domainId),
      oldEnvelope: current.aiEnvelope,
      resolveHistoricalCommitter: () => manager.publicKey,
      newDomainRoot: rootFor(current.domainId),
      newMetadata: metadata,
      newCommitterSigningPrivateKey: manager.privateKey,
      resolveSourceCommitter: () => manager.publicKey,
      resolveCurrentCommitter: () => manager.publicKey,
      rotateGeneration: false,
    });
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    const bindingHash = namespaceBindingHash(binding);
    expect(await persistNamespaceBinding({
      crypto,
      storage,
      prepared: {
        expectedHead: {
          namespaceId: current.binding.namespaceId,
          accessRevision: current.binding.accessRevision,
          bindingHash: current.bindingHash,
        },
        nextHead: {
          namespaceId: binding.namespaceId,
          accessRevision: binding.accessRevision,
          bindingHash,
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
    bindingHashes.set(targetNamespaceId, bindingHash.slice());
    bindingStates.set(targetNamespaceId, Object.freeze({
      ...current,
      humanEnvelope,
      aiEnvelope,
      binding,
      bindingHash: bindingHash.slice(),
    }));
    facts = Object.freeze({
      ...facts,
      namespaceRequirements: facts.namespaceRequirements.map((entry) =>
        String(entry.namespaceId) === targetNamespaceId
          ? Object.freeze({
            ...entry,
            expectedAccessRevision: accessRevision(nextRevision),
          })
          : entry
      ),
    });
  }
  function publishHumanRevision(
    targetPlan: ProtectedMemoryMutationPlan,
    payload: MemoryPayloadV1,
    bindingRevisionOffset = 0,
  ): void {
    const plaintext = encodeMemoryPayloadV1(payload);
    const encrypted = encryptObjectPayload(crypto, {
      objectId: objectId(targetPlan.cryptoObjectId),
      keyClass: "ai",
      objectType: MEMORY_OBJECT_TYPE,
      createdAt: unixTimestamp(targetPlan.createdAt),
    }, plaintext);
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes: Uint8Array[] = [];
    try {
      for (const targetNamespaceId of targetPlan.requiredNamespaceIds) {
        const keyring = aiNamespaceKeys.get(targetNamespaceId);
        const binding = bindingStates.get(targetNamespaceId);
        const current = keyring?.generations.find((entry) =>
          entry.generation === keyring.currentGeneration
        );
        if (keyring === undefined || binding === undefined || current === undefined) {
          throw new Error("missing Human AI Namespace key fixture");
        }
        envelopeBytes.push(encodeNamespaceObjectEnvelopeV2(
          wrapObjectDekForNamespace(crypto, current.key, {
            objectId: objectId(targetPlan.cryptoObjectId),
            namespaceId: namespaceId(targetNamespaceId),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(current.generation),
            bindingRevisionAtWrap: accessRevision(
              Number(binding.binding.accessRevision) + bindingRevisionOffset,
            ),
          }, encrypted.dek),
        ));
      }
      const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
        objectId: objectId(targetPlan.cryptoObjectId),
        payloadHash: crypto.hash(payloadBytes),
        envelopeBytes,
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: humanId(HUMAN_ID),
        committerDeviceId: cryptoDeviceId(DEVICE_ID),
        hostAuthorizationRevision:
          authorizationRevision(RUNTIME_AUTHORIZATION_REVISION),
        committerSigningPublicKey: issuer.publicKey,
        committerSigningPrivateKey: issuer.privateKey,
      });
      durable.set(targetPlan.cryptoObjectId, Object.freeze({
        memoryId: targetPlan.memoryId,
        contentRevision: targetPlan.contentRevision,
        objectId: targetPlan.cryptoObjectId,
        accessRevision: 0,
        accessManifestBytes: access.manifestBytes.slice(),
        accessManifestHash: access.manifestHash.slice(),
        accessManifestSignerPublicKey: issuer.publicKey.slice(),
        requiredNamespaceIds:
          Object.freeze([...targetPlan.requiredNamespaceIds]),
        payloadBytes: payloadBytes.slice(),
        namespaceEnvelopes: Object.freeze(envelopeBytes.map((bytes) => {
          const decoded = decodeNamespaceObjectEnvelopeV2(bytes);
          return Object.freeze({
            namespaceId: String(decoded.context.namespaceId),
            envelopeBytes: bytes.slice(),
          });
        })),
      }));
      access.manifestBytes.fill(0);
      access.manifestHash.fill(0);
      access.envelopeBytes.forEach((bytes) => bytes.fill(0));
    } finally {
      plaintext.fill(0);
      encrypted.dek.fill(0);
      encrypted.payload.ciphertext.fill(0);
      payloadBytes.fill(0);
      envelopeBytes.forEach((bytes) => bytes.fill(0));
    }
  }
  function openAsHuman(
    targetPlan: ProtectedMemoryMutationPlan,
    readNamespaceId: string,
  ): MemoryPayloadV1 {
    const stored = durable.get(targetPlan.cryptoObjectId);
    const keyring = aiNamespaceKeys.get(readNamespaceId);
    if (stored === undefined || keyring === undefined) {
      throw new Error("missing Human-open fixture bytes");
    }
    const verified = verifyCommonObjectAccessManifest(crypto, {
      manifestBytes: stored.accessManifestBytes,
      resolveHistoricalHumanDeviceSigningPublicKey: (context) =>
        String(context.subjectHumanId) === HUMAN_ID
          && String(context.committerDeviceId) === DEVICE_ID
          && Number(context.hostAuthorizationRevision)
            === RUNTIME_AUTHORIZATION_REVISION
          ? issuer.publicKey
          : null,
      resolveAgentRuntimeSignerPublicKey: (principal) =>
        String(principal.agentId)
            === String(initialized.signerPublication.agentId)
          && Number(principal.runtimeGeneration)
            === Number(initialized.signerPublication.runtimeGeneration)
          && principal.signerKeyId
            === initialized.signerPublication.signerKeyId
          ? initialized.signerPublication.signerPublicKey
          : null,
      resolveProcessorSignerAuthorizationBytes: () => null,
      resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
    });
    const selected = stored.namespaceEnvelopes.filter((entry) =>
      entry.namespaceId === readNamespaceId
    );
    if (
      selected.length !== 1
      || !verified.manifestHash.every((byte, index) =>
        byte === stored.accessManifestHash[index]
      )
    ) throw new Error("Human-open manifest or envelope mismatch");
    const payload = decodeEncryptedPayloadV2(stored.payloadBytes);
    const envelope = decodeNamespaceObjectEnvelopeV2(
      selected[0]!.envelopeBytes,
    );
    const key = keyring.generations.find((entry) =>
      entry.generation === Number(envelope.context.keyGeneration)
    );
    if (key === undefined) throw new Error("Human-open key is unavailable");
    const plaintext = decryptObjectThroughNamespace(
      crypto,
      key.key,
      envelope,
      payload,
    );
    if (plaintext === null) throw new Error("Human-open decryption failed");
    try {
      return decodeMemoryPayloadV1(plaintext);
    } finally {
      plaintext.fill(0);
      payload.ciphertext.fill(0);
      envelope.wrappedDek.fill(0);
      verified.manifestBytes.fill(0);
      verified.manifestHash.fill(0);
      verified.manifest.payloadHash.fill(0);
      verified.manifest.previousManifestHash?.fill(0);
      verified.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
      verified.manifest.signature.fill(0);
    }
  }
  return {
    baseFacts,
    capability,
    namespaceAuthority,
    port,
    restartPort: createPort,
    exactAccessPort,
    bindingHashes,
    retain,
    retainExact,
    setSignerEvidence,
    rotateNamespaceBindingHead,
    publishHumanRevision,
    openAsHuman,
    signerPublication: initialized.signerPublication,
    returnedBytes,
    setFacts(value: ProtectedGrantAuthoritySetFactsV2) {
      facts = value;
    },
  };
}

describe("protected Agent Memory session content", () => {
  test("continues common v5 AI bytes across Human and Agent writers in both directions", async () => {
    const state = await fixture();
    const humanFirst = plan(MEMORY_A, 1);
    state.publishHumanRevision(humanFirst, {
      formatVersion: 1,
      type: "preference",
      content: "Human-authored head",
    });
    expect(await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(humanFirst, NAMESPACE_B)],
    })).toMatchObject({
      status: "executed",
      value: { status: "success", value: [{ content: "Human-authored head" }] },
    });
    const agentContinuation = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: plan(MEMORY_A, 2),
      content: {
        kind: "replacement",
        previous: {
          memoryId: humanFirst.memoryId,
          contentRevision: humanFirst.contentRevision,
          cryptoAccessRevision: humanFirst.cryptoAccessRevision,
          cryptoObjectId: humanFirst.cryptoObjectId,
          requiredNamespaceIds: humanFirst.requiredNamespaceIds,
        },
        content: "Agent continuation of Human bytes",
      },
    });
    if (
      agentContinuation.status !== "executed"
      || agentContinuation.value.status !== "success"
    ) throw new Error("expected Agent continuation");
    const agentContinuationPlan = plan(MEMORY_A, 2);
    state.retain(agentContinuation.value.value);
    expect(state.openAsHuman(agentContinuationPlan, NAMESPACE_A)).toEqual({
      formatVersion: 1,
      type: "preference",
      content: "Agent continuation of Human bytes",
    });

    const agentFirst = plan(MEMORY_B, 1);
    const agentCreated = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: agentFirst,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "fact",
          content: "Agent-authored head",
        },
      },
    });
    if (agentCreated.status !== "executed" || agentCreated.value.status !== "success") {
      throw new Error("expected Agent-created head");
    }
    state.retain(agentCreated.value.value);
    expect(state.openAsHuman(agentFirst, NAMESPACE_B).content)
      .toBe("Agent-authored head");
    const humanContinuation = plan(MEMORY_B, 2);
    state.publishHumanRevision(humanContinuation, {
      formatVersion: 1,
      type: "fact",
      content: "Human continuation of Agent bytes",
    });
    expect(await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(humanContinuation, NAMESPACE_A)],
    })).toMatchObject({
      status: "executed",
      value: {
        status: "success",
        value: [{ content: "Human continuation of Agent bytes" }],
      },
    });
  });

  test("opens a retained historical envelope after its Namespace binding head rotates", async () => {
    const state = await fixture();
    const currentPlan = Object.freeze({
      ...plan(MEMORY_A, 1),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    const created = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: currentPlan,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "fact",
          content: "the retained envelope predates the Namespace head",
        },
      },
    });
    if (created.status !== "executed" || created.value.status !== "success") {
      throw new Error("expected initial Agent Memory publication");
    }
    state.retain(created.value.value);
    await state.rotateNamespaceBindingHead(NAMESPACE_A);
    await state.rotateNamespaceBindingHead(NAMESPACE_A);

    expect(await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(currentPlan, NAMESPACE_A)],
    })).toEqual({
      status: "executed",
      value: {
        status: "success",
        value: [{
          memoryId: MEMORY_A,
          contentRevision: 1,
          type: "fact",
          content: "the retained envelope predates the Namespace head",
        }],
      },
    });
  });

  test("owns and wipes bounded signer evidence across a restarted foreground reader", async () => {
    const state = await fixture();
    const currentPlan = Object.freeze({
      ...plan(MEMORY_A, 1),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    const created = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: currentPlan,
      content: {
        kind: "complete",
        payload: { formatVersion: 1, type: "fact", content: "restart evidence" },
      },
    });
    if (created.status !== "executed" || created.value.status !== "success") {
      throw new Error("expected signer-evidence publication");
    }
    state.retain(created.value.value);
    const signerEvidenceBytes = encodeAgentRuntimeSignerPublicationV1(
      state.signerPublication,
    );
    state.setSignerEvidence(currentPlan.cryptoObjectId, [{
      kind: "agent_runtime_publication",
      evidenceBytes: signerEvidenceBytes,
    }]);
    signerEvidenceBytes.fill(0);
    const open = (port: typeof state.port) => port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(currentPlan, NAMESPACE_A)],
    });
    expect(await open(state.port)).toMatchObject({
      status: "executed",
      value: { status: "success" },
    });
    expect(await open(state.restartPort())).toMatchObject({
      status: "executed",
      value: { status: "success" },
    });
    expect(state.returnedBytes.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true);

    state.returnedBytes.length = 0;
    const duplicatedEvidence = encodeAgentRuntimeSignerPublicationV1(
      state.signerPublication,
    );
    state.setSignerEvidence(currentPlan.cryptoObjectId, [{
      kind: "agent_runtime_publication",
      evidenceBytes: duplicatedEvidence,
    }, {
      kind: "agent_runtime_publication",
      evidenceBytes: duplicatedEvidence,
    }]);
    duplicatedEvidence.fill(0);
    expect(await open(state.restartPort())).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "integrity_failure" },
    });
    expect(state.returnedBytes.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("rejects a cryptographically valid envelope from a future Namespace binding", async () => {
    const state = await fixture();
    const futurePlan = Object.freeze({
      ...plan(MEMORY_A, 1),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    state.publishHumanRevision(futurePlan, {
      formatVersion: 1,
      type: "fact",
      content: "future wrap must not authorize early",
    }, 1);
    expect(await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(futurePlan, NAMESPACE_A)],
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "integrity_failure" },
    });
  });

  test("prepares, opens by the requested seed Namespace, and wipes reader bytes", async () => {
    const state = await fixture();
    const firstPlan = plan(MEMORY_A, 1);
    const prepared = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: firstPlan,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "preference",
          content: "always use metric units",
        },
      },
    });
    expect(prepared).toMatchObject({ status: "executed" });
    if (
      prepared.status !== "executed"
      || prepared.value.status !== "success"
    ) throw new Error("expected prepared Memory");
    state.retain(prepared.value.value);

    const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
      mode: "scope" as const,
      subjectUserId: HUMAN_ID,
      agentId: AGENT_ID,
      scopeId: "task:memory-session",
      originWritableNamespaceId: NAMESPACE_A,
    });
    const opened = await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: scopeAuthority,
      candidates: [candidate(firstPlan, NAMESPACE_B)],
    });
    expect(opened).toEqual({
      status: "executed",
      value: {
        status: "success",
        value: [{
          memoryId: MEMORY_A,
          contentRevision: 1,
          type: "preference",
          content: "always use metric units",
        }],
      },
    });
    expect(state.returnedBytes.length).toBe(6);
    expect(state.returnedBytes.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true);

    expect(await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: scopeAuthority,
      plan: plan(MEMORY_B, 1),
      content: {
        kind: "complete",
        payload: { formatVersion: 1, type: "new", content: "wrong set" },
      },
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "incomplete_access_set" },
    });
    let forbiddenScopeCommits = 0;
    expect(await state.port.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: scopeAuthority,
      target: {
        memoryId: firstPlan.memoryId,
        contentRevision: firstPlan.contentRevision,
        cryptoAccessRevision: firstPlan.cryptoAccessRevision,
        cryptoObjectId: firstPlan.cryptoObjectId,
        requiredNamespaceIds: firstPlan.requiredNamespaceIds,
      },
      memoryOperation: "set-tier",
      commit: () => {
        forbiddenScopeCommits += 1;
        return "must-not-run";
      },
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "incomplete_access_set" },
    });
    expect(forbiddenScopeCommits).toBe(0);
  });

  test("preserves confidential type on same-set replacement and freshly authorizes commit", async () => {
    const state = await fixture();
    const previousPlan = plan(MEMORY_A, 1);
    const first = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.fork",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: previousPlan,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "private-type",
          content: "old content",
        },
      },
    });
    if (first.status !== "executed" || first.value.status !== "success") {
      throw new Error("expected initial preparation");
    }
    state.retain(first.value.value);

    const nextPlan = plan(MEMORY_A, 2);
    const replaced = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.fork",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: nextPlan,
      content: {
        kind: "replacement",
        previous: {
          memoryId: previousPlan.memoryId,
          contentRevision: previousPlan.contentRevision,
          cryptoAccessRevision: previousPlan.cryptoAccessRevision,
          cryptoObjectId: previousPlan.cryptoObjectId,
          requiredNamespaceIds: previousPlan.requiredNamespaceIds,
        },
        content: "new content",
      },
    });
    expect(replaced.status).toBe("executed");
    if (
      replaced.status !== "executed"
      || replaced.value.status !== "success"
    ) throw new Error("expected replacement preparation");
    state.retain(replaced.value.value);
    const opened = await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.fork",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [candidate(nextPlan, NAMESPACE_A)],
    });
    expect(opened.status).toBe("executed");
    if (opened.status !== "executed") throw new Error("expected open");
    expect(opened.value).toEqual({
      status: "success",
      value: [{
        memoryId: MEMORY_A,
        contentRevision: 2,
        type: "private-type",
        content: "new content",
      }],
    });

    let commits = 0;
    expect(await state.port.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.fork",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      target: {
        memoryId: nextPlan.memoryId,
        contentRevision: nextPlan.contentRevision,
        cryptoAccessRevision: nextPlan.cryptoAccessRevision,
        cryptoObjectId: nextPlan.cryptoObjectId,
        requiredNamespaceIds: nextPlan.requiredNamespaceIds,
      },
      memoryOperation: "replace",
      commit: () => ++commits,
    })).toEqual({
      status: "executed",
      value: { status: "success", value: 1 },
    });
    expect(commits).toBe(1);
  });

  test("prepares a removal-only exact access update without opening retained roots", async () => {
    const state = await fixture();
    const currentPlan = plan(MEMORY_A, 1);
    const created = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: currentPlan,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "preference",
          content: "keep retained audience bytes exact",
        },
      },
    });
    if (created.status !== "executed" || created.value.status !== "success") {
      throw new Error("expected initial exact Memory publication");
    }
    state.retain(created.value.value);
    const snapshot = readPreparedMemoryCryptoRevisionSnapshot(
      created.value.value,
    );
    const retainedEnvelope = snapshot.access.envelopeBytes.find((bytes) =>
      decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId === NAMESPACE_A
    );
    if (retainedEnvelope === undefined) throw new Error("missing retained envelope");
    const bindingA = state.bindingHashes.get(NAMESPACE_A);
    const bindingB = state.bindingHashes.get(NAMESPACE_B);
    if (bindingA === undefined || bindingB === undefined) {
      throw new Error("missing exact binding fixture");
    }
    const prepared = await state.exactAccessPort.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: null,
      plan: {
        operationId: "memory-access-remove-b",
        memoryId: MEMORY_A,
        cryptoObjectId: currentPlan.cryptoObjectId,
        expectedContentRevision: 1,
        expectedCryptoAccessRevision: 0,
        nextCryptoAccessRevision: 1,
        anchorNamespaceId: NAMESPACE_A,
        currentNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
        targetNamespaceIds: [NAMESPACE_A],
        addedNamespaceIds: [],
        removedNamespaceIds: [NAMESPACE_B],
        currentRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A, NAMESPACE_B]),
        targetRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
        currentBindings: [
          {
            namespaceId: NAMESPACE_A,
            domainId: DOMAIN_A,
            expectedAccessRevision: 0,
            expectedPolicyRevision: 11,
            bindingHash: bindingA,
          },
          {
            namespaceId: NAMESPACE_B,
            domainId: DOMAIN_B,
            expectedAccessRevision: 0,
            expectedPolicyRevision: 12,
            bindingHash: bindingB,
          },
        ],
        targetBindings: [{
          namespaceId: NAMESPACE_A,
          domainId: DOMAIN_A,
          expectedAccessRevision: 0,
          expectedPolicyRevision: 11,
          bindingHash: bindingA,
        }],
        productMutation: { kind: "replace_exact" },
      },
    });
    expect(prepared).toMatchObject({ status: "executed" });
    if (prepared.status !== "executed" || prepared.value.status !== "success") {
      throw new Error("expected exact access preparation");
    }
    const access = readPreparedAgentMemoryExactAccessSnapshot(
      prepared.value.value,
    );
    expect(access.prepared.authority.removedNamespaceIds).toEqual([NAMESPACE_B]);
    expect(access.prepared.authority.addedNamespaceIds).toEqual([]);
    expect(access.prepared.authority.namespaceRequirements.map((entry) => ({
      namespaceId: entry.namespaceId,
      operations: entry.operations,
    }))).toEqual([{ namespaceId: NAMESPACE_B, operations: ["decrypt"] }]);
    expect(access.prepared.envelopeBytes).toHaveLength(1);
    expect(access.prepared.envelopeBytes[0]).toEqual(retainedEnvelope);
    expect(Number(access.prepared.manifest.accessRevision)).toBe(1);
    let commits = 0;
    expect(await state.exactAccessPort.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: null,
      plan: access.plan,
      prepared: prepared.value.value,
      commit: () => {
        commits += 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({ status: "updated" as const }),
        });
      },
    })).toEqual({
      status: "executed",
      value: { status: "success", value: { status: "updated" } },
    });
    expect(commits).toBe(1);

    state.retainExact(prepared.value.value);
    const addPlan = {
      operationId: "memory-access-add-b",
      memoryId: MEMORY_A,
      cryptoObjectId: currentPlan.cryptoObjectId,
      expectedContentRevision: 1,
      expectedCryptoAccessRevision: 1,
      nextCryptoAccessRevision: 2,
      anchorNamespaceId: NAMESPACE_A,
      currentNamespaceIds: [NAMESPACE_A],
      targetNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      addedNamespaceIds: [NAMESPACE_B],
      removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      targetRequiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A, NAMESPACE_B]),
      currentBindings: [{
        namespaceId: NAMESPACE_A,
        domainId: DOMAIN_A,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 11,
        bindingHash: bindingA,
      }],
      targetBindings: [{
        namespaceId: NAMESPACE_A,
        domainId: DOMAIN_A,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 11,
        bindingHash: bindingA,
      }, {
        namespaceId: NAMESPACE_B,
        domainId: DOMAIN_B,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 12,
        bindingHash: bindingB,
      }],
      productMutation: {
        kind: "grant_namespace" as const,
        namespaceId: NAMESPACE_B,
      },
    };
    const addition = await state.exactAccessPort.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: addPlan,
    });
    if (addition.status !== "executed" || addition.value.status !== "success") {
      throw new Error("expected exact audience addition");
    }
    const additionHandle = addition.value.value;
    const added = readPreparedAgentMemoryExactAccessSnapshot(
      additionHandle,
    );
    expect(added.prepared.authority.namespaceRequirements.map((entry) => ({
      namespaceId: entry.namespaceId,
      operations: entry.operations,
    }))).toEqual([{ namespaceId: NAMESPACE_B, operations: ["encrypt"] }]);
    expect(added.prepared.envelopeBytes).toHaveLength(2);
    const retained = added.prepared.envelopeBytes.find((bytes) =>
      String(decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId)
        === NAMESPACE_A
    );
    const introduced = added.prepared.envelopeBytes.find((bytes) =>
      String(decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId)
        === NAMESPACE_B
    );
    expect(retained).toEqual(retainedEnvelope);
    expect(introduced).toBeDefined();
    expect(introduced).not.toEqual(retainedEnvelope);
    expect(await state.exactAccessPort.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: Object.freeze({
        ...state.namespaceAuthority,
        readableNamespaceIds: Object.freeze([NAMESPACE_B]),
      }),
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: addPlan,
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "authorization_required" },
    });

    const productConnection = new ExactAccessProductConnection();
    productConnection.accessRevision = addPlan.expectedCryptoAccessRevision;
    const productHandle = await verifyConversationProductPostgresHandle(
      productConnection,
    );
    const product = new PostgresAgentMemoryExactAccessProduct({
      handle: productHandle,
      readableNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      crypto: {
        observe: () => Promise.resolve({ status: "absent" as const }),
        complete: async (handle) => {
          productConnection.cryptoCalls += 1;
          const exact = readPreparedAgentMemoryExactAccessSnapshot(handle);
          const previous = exact.prepared.manifest.previousManifestHash;
          if (previous === null) throw new Error("missing current manifest hash");
          return Object.freeze({
            operationId: exact.plan.operationId,
            memoryId: exact.plan.memoryId,
            objectId: exact.plan.cryptoObjectId,
            expectedContentRevision: exact.plan.expectedContentRevision,
            expectedAccessRevision: exact.plan.expectedCryptoAccessRevision,
            resultAccessRevision: exact.plan.nextCryptoAccessRevision,
            currentManifestHash: previous.slice(),
            resultManifestHash: exact.prepared.manifestHash.slice(),
            targetRequiredNamespaceFingerprint:
              exact.plan.targetRequiredNamespaceFingerprint.slice(),
            requestDigest: agentMemoryExactAccessRequestDigest(handle),
            currentNamespaceIds: exact.plan.currentNamespaceIds,
            targetNamespaceIds: exact.plan.targetNamespaceIds,
            status: "applied" as const,
          });
        },
      },
      resolveGrantUserNamespace: () => Promise.resolve(NAMESPACE_B),
      resolveCryptoAuthority: ({ currentNamespaceIds, targetNamespaceIds }) =>
        Promise.resolve({
          currentBindings: addPlan.currentBindings.filter((binding) =>
            currentNamespaceIds.includes(binding.namespaceId)
          ),
          targetBindings: addPlan.targetBindings.filter((binding) =>
            targetNamespaceIds.includes(binding.namespaceId)
          ),
        }),
    });
    const commitThroughProduct = () => product.commitPrepared({
      authority: state.namespaceAuthority,
      plan: addPlan,
      prepared: additionHandle,
    });
    expect(await state.exactAccessPort.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: addPlan,
      prepared: additionHandle,
      commit: commitThroughProduct,
    })).toEqual({
      status: "executed",
      value: {
        status: "success",
        value: { status: "updated", memoryId: MEMORY_A },
      },
    });
    expect(await state.exactAccessPort.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: addPlan,
      prepared: additionHandle,
      commit: commitThroughProduct,
    })).toEqual({
      status: "executed",
      value: {
        status: "success",
        value: { status: "replayed", memoryId: MEMORY_A },
      },
    });
    expect(productConnection.cryptoCalls).toBe(1);

    state.setFacts(Object.freeze({
      ...state.baseFacts,
      hostAllowsOperation: false,
    }));
    let freshCommits = 0;
    expect(await state.exactAccessPort.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: addPlan,
      prepared: addition.value.value,
      commit: () => {
        freshCommits += 1;
        return Object.freeze({
          status: "success" as const,
          value: Object.freeze({ status: "updated" as const }),
        });
      },
    })).toEqual({ status: "unavailable", reason: "authorization_unavailable" });
    expect(freshCommits).toBe(0);
  });

  test("rewraps only an added audience from one readable retained source", async () => {
    const state = await fixture();
    const currentPlan = Object.freeze({
      ...plan(MEMORY_A, 1),
      requiredNamespaceIds: Object.freeze([NAMESPACE_A]),
    });
    const created = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: currentPlan,
      content: {
        kind: "complete",
        payload: {
          formatVersion: 1,
          type: "preference",
          content: "add an audience without rewriting the retained envelope",
        },
      },
    });
    expect(created).toMatchObject({ status: "executed", value: { status: "success" } });
    if (created.status !== "executed" || created.value.status !== "success") {
      throw new Error("expected initial singleton Memory publication");
    }
    state.retain(created.value.value);
    const original = readPreparedMemoryCryptoRevisionSnapshot(created.value.value)
      .access.envelopeBytes[0]!;
    const bindingA = state.bindingHashes.get(NAMESPACE_A);
    const bindingB = state.bindingHashes.get(NAMESPACE_B);
    if (bindingA === undefined || bindingB === undefined) {
      throw new Error("missing exact binding fixture");
    }
    const accessPlan = {
      operationId: "memory-access-add-b",
      memoryId: MEMORY_A,
      cryptoObjectId: currentPlan.cryptoObjectId,
      expectedContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      nextCryptoAccessRevision: 1,
      anchorNamespaceId: NAMESPACE_A,
      currentNamespaceIds: [NAMESPACE_A],
      targetNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      addedNamespaceIds: [NAMESPACE_B],
      removedNamespaceIds: [],
      currentRequiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A]),
      targetRequiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces([NAMESPACE_A, NAMESPACE_B]),
      currentBindings: [{
        namespaceId: NAMESPACE_A,
        domainId: DOMAIN_A,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 11,
        bindingHash: bindingA,
      }],
      targetBindings: [{
        namespaceId: NAMESPACE_A,
        domainId: DOMAIN_A,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 11,
        bindingHash: bindingA,
      }, {
        namespaceId: NAMESPACE_B,
        domainId: DOMAIN_B,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 12,
        bindingHash: bindingB,
      }],
      productMutation: {
        kind: "grant_namespace" as const,
        namespaceId: NAMESPACE_B,
      },
    };
    const prepared = await state.exactAccessPort.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: accessPlan,
    });
    if (prepared.status !== "executed" || prepared.value.status !== "success") {
      throw new Error("expected exact audience addition");
    }
    const snapshot = readPreparedAgentMemoryExactAccessSnapshot(
      prepared.value.value,
    );
    expect(snapshot.prepared.authority.namespaceRequirements.map((entry) => ({
      namespaceId: entry.namespaceId,
      operations: entry.operations,
    }))).toEqual([{ namespaceId: NAMESPACE_B, operations: ["encrypt"] }]);
    expect(snapshot.prepared.envelopeBytes).toHaveLength(2);
    const retained = snapshot.prepared.envelopeBytes.find((bytes) =>
      String(decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId)
        === NAMESPACE_A
    );
    const introduced = snapshot.prepared.envelopeBytes.find((bytes) =>
      String(decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId)
        === NAMESPACE_B
    );
    expect(retained).toEqual(original);
    expect(introduced).toBeDefined();
    expect(introduced).not.toEqual(original);

    expect(await state.exactAccessPort.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      agentId: AGENT_ID,
      authority: Object.freeze({
        ...state.namespaceAuthority,
        readableNamespaceIds: Object.freeze([NAMESPACE_B]),
      }),
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      sourceNamespaceId: NAMESPACE_A,
      plan: accessPlan,
    })).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "authorization_required" },
    });
  });

  test("fails all-or-nothing and never invokes commit after fresh authority denial", async () => {
    const state = await fixture();
    const firstPlan = plan(MEMORY_A, 1);
    const prepared = await state.port.prepare({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      plan: firstPlan,
      content: {
        kind: "complete",
        payload: { formatVersion: 1, type: "type-a", content: "one" },
      },
    });
    if (prepared.status !== "executed" || prepared.value.status !== "success") {
      throw new Error("expected preparation");
    }
    state.retain(prepared.value.value);
    const missingPlan = plan(MEMORY_B, 1);
    const opened = await state.port.openMany({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "decrypt",
      requestedNamespaceIds: [NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      candidates: [
        candidate(firstPlan, NAMESPACE_B),
        candidate(missingPlan, NAMESPACE_B),
      ],
    });
    expect(opened).toEqual({
      status: "executed",
      value: { status: "unavailable", reason: "missing_mapping" },
    });

    state.setFacts(Object.freeze({
      ...state.baseFacts,
      hostAllowsOperation: false,
    }));
    let commits = 0;
    expect(await state.port.authorizeCommit({
      capability: state.capability,
      entrypointId: "foreground.main",
      operation: "encrypt",
      requestedNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
      allowedDomainIds: [DOMAIN_A, DOMAIN_B],
      agentId: AGENT_ID,
      authority: state.namespaceAuthority,
      target: {
        memoryId: firstPlan.memoryId,
        contentRevision: firstPlan.contentRevision,
        cryptoAccessRevision: firstPlan.cryptoAccessRevision,
        cryptoObjectId: firstPlan.cryptoObjectId,
        requiredNamespaceIds: firstPlan.requiredNamespaceIds,
      },
      memoryOperation: "publish",
      commit: () => ++commits,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(commits).toBe(0);
  });
});
