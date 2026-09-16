import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@nautilo/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { createPostgresJsBridgeConnection, createPostgresJsCanonicalBridgeConnection, encryptionTransitionPolicy, memories, memoryCryptoOperations, memoryNamespaces } from "@nautilo/db";
import {
  LatticeCrypto,
  accessRevision,
  appendNamespaceGeneration,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  compareUnsignedUtf8,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  InMemoryLatticeStore,
  namespaceGeneration,
  namespaceBindingHash,
  mintGrant,
  namespaceId,
  objectId,
  participantDigest,
  persistAgentRuntimeInitialization,
  persistNamespaceBinding,
  preflightGrantAuthoritySetUse,
  prepareHumanMemoryContentEmbeddingRequest,
  prepareHumanMemoryExactAccessRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanObjectAccessManifestUpdateSet,
  prepareAgentRuntimeInitialization,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  encryptObjectPayload,
  decryptObjectPayload,
  openObjectDekForNamespace,
  type AgentRuntimeKeyGeneration,
  type GrantAuthoritySetAuthorization,
  type LatticeStorage,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeAgentRuntimeSignerPublicationV1,
  encodeLiveShadowMessagePlanV4,
  encodeEncryptedPayloadV2,
  decodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresAgentMemoryProductPort,
  PostgresAgentMemoryExactAccessProduct,
  PostgresMemoryProductStore,
  createHumanMemoryPreparedCreateRoutePort,
  createPostgresMemoryCryptoCompletion,
  createPostgresAgentMemoryExactAccessCryptoCompletion,
  createPostgresHumanMemoryCryptoCompletion,
  createPostgresHumanMemoryProtectedProductRoutePort,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  attachPostgresForegroundMemoryRepair,
  bindConversationProductCanonicalTransactionRunner,
  loadPostgresForegroundMemoryRepairSources,
  restorePostgresForegroundMemoryOrdinary,
  validatePostgresForegroundMemoryRepairSource,
  PostgresHumanMemoryProductUpdate,
  PostgresHumanDeviceSignerHistory,
  PostgresHumanMemoryAuthorityResolver,
  PostgresHumanMemoryExactAccessCryptoCompletion,
  PostgresHumanMemoryExactAccessProduct,
  persistForegroundAgentMemoryNativeExactAccess,
  readVerifiedDeviceWrappedAgentObject,
  authenticateHumanMemoryExactAccessPrepared,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresIsolationLevel,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";
import {
  createForegroundDomainMemoryExactAccess,
  createForegroundDomainProtectedAgentMemoryAccessPort,
} from "../../../runtime/src/memory/foreground-domain-memory-exact-access.ts";
import {
  createProtectedInvocationCapability,
  createProtectedInvocationRecipient,
  type ProtectedGrantAuthoritySetFactsV2,
  type ProtectedGrantAuthoritySetPortV2,
  type ProtectedInvocationCoordinates,
} from "../../src/invocation/protected-grant-invocation.ts";
import type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityNamespaceAuthority,
} from "../../src/object/foreground-agent-entity-crypto.ts";
import {
  createProtectedAgentMemoryExactAccessContentPort,
  type AgentMemoryExactAccessBindingFact,
} from "../../src/memory/agent-memory-exact-access.ts";
import type { ProtectedMemoryAuthority } from "../../src/memory/active-memory-repository.ts";
import {
  PostgresProtectedScopeCloseSaga,
  type ScopeClosePostgresConnection,
  type ScopeClosePostgresExecutor,
  type ScopeCloseRow,
  type ScopeCloseScalar,
} from "@nautilo/trust";

import {
  encodeMemoryPayloadV1,
  decodeMemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";
import {
  prepareAgentMemoryCryptoRevision,
} from "../../src/memory/agent-memory-crypto.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  type MemoryCryptoRevisionReference,
} from "../../src/memory/memory-repository.ts";
import {
  readPreparedMemoryCryptoRevisionSnapshot,
} from "../../src/memory/memory-prepared-revision.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const NOW = 1_820_000_000_000;
const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const agentUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL");

let admin: SqlClient;
let rngSeed = Number.parseInt(
  randomUUID().replaceAll("-", "").slice(0, 8),
  16,
);

type IntegrationFixture = Readonly<{
  memoryId: string;
  namespaceIds: readonly [string, string];
  domainIds: readonly [string, string];
  agentProductId: string;
  userId: string;
  scopeIds: readonly string[];
  grantId: string;
  agentCryptoId: string;
  objectId: string;
  plaintext: string;
  plaintextType: string;
  shadowEmbeddingText: string;
  crypto: LatticeCrypto;
  managerSigningPublicKey: Uint8Array;
  managerDeviceId: string;
  managerAuthorizationRevision: number;
  agentSignerPublicKey: Uint8Array;
  agentSignerKeyId: string;
  agentRuntimeGeneration: number;
  agentRuntime: AgentRuntimeKeyGeneration;
  humanCryptoId: string;
  runtimeAuthorizationRevision: number;
  runtimeStorage: LatticeStorage;
  namespaceBindingFacts: readonly AgentMemoryExactAccessBindingFact[];
  nativeNamespaces: readonly Readonly<{
    authority: ForegroundAgentEntityNamespaceAuthority;
    key: Uint8Array;
  }>[];
  domainFacts: readonly Readonly<{
    domainId: string;
    epoch: number;
    agentAuthorizationRevision: number;
    aiRoot: Uint8Array;
  }>[];
  prepared: Awaited<ReturnType<typeof prepareAgentMemoryCryptoRevision>>;
  createPrepared: Awaited<ReturnType<typeof prepareAgentMemoryCryptoRevision>>;
  replacementPrepared: Awaited<
    ReturnType<typeof prepareAgentMemoryCryptoRevision>
  >;
  reference: MemoryCryptoRevisionReference;
  requiredNamespaceFingerprint: Uint8Array;
}>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function sqlClient(url: string, maximumConnections = 4): SqlClient {
  return postgres(url, {
    max: maximumConnections,
    prepare: false,
    onnotice: () => undefined,
  });
}

function cryptoExecutor(client: SqlExecutor): CryptoPostgresExecutor {
  return {
    async query<Row>(statement: string, parameters = []): Promise<readonly Row[]> {
      const rows = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return rows as unknown as readonly Row[];
    },
  };
}

function cryptoConnection(client: SqlClient): CryptoPostgresConnection {
  return {
    ...cryptoExecutor(client),
    transaction: (callback) =>
      client.begin((transaction) => callback(cryptoExecutor(transaction))) as
        Promise<ReturnType<typeof callback> extends Promise<infer Result>
          ? Result
          : never>,
  };
}

function productConnection(client: SqlClient): ConversationProductPostgresConnection {
  return createPostgresJsBridgeConnection({ $client: client });
}

function agentProductConnection(
  client: SqlClient,
  userId: string,
  agentId: string,
): ConversationProductPostgresConnection {
  const connection = createPostgresJsBridgeConnection({ $client: client });
  return {
    query: connection.query,
    transaction: <Result>(
      callback: (transaction: ConversationProductPostgresExecutor) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ): Promise<Result> =>
      connection.transaction(
        async (transaction) => {
          await transaction.query(
            `SELECT set_config('app.current_user_id', $1, true),
                    set_config('app.current_agent_id', $2, true)`,
            [userId, agentId],
          );
          return callback(transaction);
        },
        options,
      ),
  };
}

function agentCanonicalConnection(
  client: SqlClient,
  userId: string,
  agentId: string,
): ConversationProductCanonicalTransactionConnection {
  const canonical = createPostgresJsCanonicalBridgeConnection(drizzle(client, { schema }));
  return {
    transaction: (callback, options) => canonical.transaction(
      async (transaction, executor) => {
        await transaction.execute(sql`
          SELECT set_config('app.current_user_id', ${userId}, true),
                 set_config('app.current_agent_id', ${agentId}, true)
        `);
        return callback(transaction, executor);
      },
      options,
    ),
  };
}

function humanProductConnection(
  client: SqlClient,
  userId: string,
): ConversationProductPostgresConnection {
  const connection = createPostgresJsBridgeConnection({ $client: client });
  return {
    query: connection.query,
    transaction: <Result>(
      callback: (transaction: ConversationProductPostgresExecutor) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ): Promise<Result> =>
      connection.transaction(
        async (transaction) => {
          await transaction.query(
            "SELECT set_config('app.current_user_id', $1, true)",
            [userId],
          );
          await transaction.query(
            "SELECT set_config('app.current_agent_id', '', true)",
          );
          return callback(transaction);
        },
        options,
      ),
  };
}

function humanCanonicalConnection(
  client: SqlClient,
  userId: string,
): ConversationProductCanonicalTransactionConnection {
  const canonical = createPostgresJsCanonicalBridgeConnection(drizzle(client, { schema }));
  return {
    transaction: (callback, options) => canonical.transaction(
      async (transaction, executor) => {
        await transaction.execute(sql`
          SELECT set_config('app.current_user_id', ${userId}, true),
                 set_config('app.current_agent_id', '', true)
        `);
        return callback(transaction, executor);
      }, options),
  };
}

function scopeCloseExecutor(client: SqlExecutor): ScopeClosePostgresExecutor {
  return {
    async query<Row extends ScopeCloseRow = ScopeCloseRow>(
      statement: string,
      parameters: readonly ScopeCloseScalar[] = [],
    ): Promise<readonly Row[]> {
      const rows = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return rows as unknown as readonly Row[];
    },
  };
}

function scopeCloseConnection(client: SqlClient): ScopeClosePostgresConnection {
  return {
    ...scopeCloseExecutor(client),
    transaction: <Result>(
      callback: (transaction: ScopeClosePostgresExecutor) => Promise<Result>,
    ): Promise<Result> => client.begin((transaction) =>
      callback(scopeCloseExecutor(transaction))) as unknown as Promise<Result>,
  };
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e37_79b9;
  return {
    bytes(length: number): Uint8Array {
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

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function createFixture(options: Readonly<{
  scopeOrigin: boolean;
  protectedOnly?: boolean;
  seedProduct?: boolean;
}>): Promise<IntegrationFixture> {
  const memoryId = randomUUID();
  const namespaceIds = [randomUUID(), randomUUID()].sort() as [string, string];
  const domainIds = [
    `memory-domain-${randomUUID()}`,
    `memory-domain-${randomUUID()}`,
  ].sort() as [string, string];
  const agentProductId = randomUUID();
  const userId = randomUUID();
  const agentCryptoId = agentProductId;
  const grantValue = `memory-grant-${randomUUID()}`;
  const plaintext = `private-memory-${randomUUID()}`;
  const plaintextType = `private-type-${randomUUID()}`;
  const shadowEmbeddingText = `[${new Array<string>(1536).fill("0.125").join(",")}]`;
  const crypto = new LatticeCrypto(seededRng(rngSeed++), { now: () => NOW });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const humanValue = humanId(userId);
  const agentValue = agentId(agentCryptoId);
  const managerDeviceId = cryptoDeviceId(`memory-manager-${randomUUID()}`);
  const runtimeAuthorizationRevision = authorizationRevision(17);
  const activeNamespaceCount = options.seedProduct === false ? 1 : 2;
  const domains = [
    {
      domainId: cryptoDomainId(domainIds[0]),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(11),
      aiRoot: digest(0x41),
    },
    {
      domainId: cryptoDomainId(domainIds[1]),
      domainEpoch: domainEpoch(6),
      agentAuthorizationRevision: authorizationRevision(13),
      aiRoot: digest(0x42),
    },
  ] as const;
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: `memory-runtime-${randomUUID()}`,
    agentId: agentValue,
    authorizationRevision: runtimeAuthorizationRevision,
    configObjects: [{
      objectId: `memory-config-${randomUUID()}`,
      configRevision: authorizationRevision(1),
      plaintextDek: digest(0x31),
    }],
    domains: domains.map((domain) => ({
      domainId: domain.domainId,
      domainEpoch: domain.domainEpoch,
      agentAuthorizationRevision: domain.agentAuthorizationRevision,
      committerDeviceId: managerDeviceId,
      domainRoot: domain.aiRoot,
      committerSigningPrivateKey: manager.privateKey,
    })),
    resolveCurrentDomainCommitterAuthority: () => manager.publicKey,
    manager: {
      managerHumanId: humanValue,
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId,
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const inMemoryStore = new InMemoryLatticeStore();
  const persistedRuntime = await persistAgentRuntimeInitialization({
    crypto,
    storage: inMemoryStore,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentValue,
        authorizationRevision: runtimeAuthorizationRevision,
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanValue,
        managerAuthorizationRevision: authorizationRevision(8),
        managerDeviceId,
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: domains.map((domain) => ({
        domainId: domain.domainId,
        domainEpoch: domain.domainEpoch,
        agentAuthorizationRevision: domain.agentAuthorizationRevision,
        committerDeviceId: managerDeviceId,
        committerSigningPublicKey: manager.publicKey,
      })),
    }),
  });
  if (persistedRuntime !== "inserted") {
    throw new Error("Expected Agent Runtime integration initialization");
  }
  const namespaceMaterials = [] as Array<Readonly<{
    namespaceId: string;
    domainId: string;
    bindingHash: Uint8Array;
    bindingBytes: Uint8Array;
    humanEnvelopeBytes: Uint8Array;
    aiEnvelopeBytes: Uint8Array;
    currentGeneration: number;
    key: Uint8Array;
  }>>;
  for (const [index, namespaceValue] of namespaceIds.entries()) {
    const keyrings = createInitialNamespaceKeyrings(
      crypto,
      namespaceId(namespaceValue),
    );
    const metadata = {
      domainId: domains[index]!.domainId,
      domainEpoch: domains[index]!.domainEpoch,
      previousBindingHash: null,
      committerDeviceId: managerDeviceId,
    } as const;
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: digest(0x51 + index),
      keyring: keyrings.human,
      metadata,
      committerSigningPrivateKey: manager.privateKey,
      resolveCurrentCommitter: () => manager.publicKey,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: domains[index]!.aiRoot,
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
    const bindingBytes = serializeNamespaceBindingV2(binding);
    const humanEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(
      humanEnvelope,
    );
    const aiEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(aiEnvelope);
    const persisted = await persistNamespaceBinding({
      crypto,
      storage: inMemoryStore,
      prepared: {
        expectedHead: null,
        nextHead: {
          namespaceId: binding.namespaceId,
          accessRevision: binding.accessRevision,
          bindingHash,
          domainId: binding.domainId,
          domainEpoch: binding.domainEpoch,
        },
        signedBindingBytes: bindingBytes,
        humanKeyringEnvelopeBytes: humanEnvelopeBytes,
        aiKeyringEnvelopeBytes: aiEnvelopeBytes,
      },
      resolveCurrentCommitter: () => manager.publicKey,
    });
    if (persisted !== "applied") {
      throw new Error("Expected Namespace binding integration persistence");
    }
    const generation = keyrings.ai.generations.find((entry) =>
      entry.generation === keyrings.ai.currentGeneration
    );
    if (generation === undefined) throw new Error("Missing AI key generation");
    namespaceMaterials.push(Object.freeze({
      namespaceId: namespaceValue,
      domainId: String(domains[index]!.domainId),
      bindingHash: bindingHash.slice(),
      bindingBytes,
      humanEnvelopeBytes,
      aiEnvelopeBytes,
      currentGeneration: generation.generation,
      key: generation.key.slice(),
    }));
  }
  const issuingDeviceId = cryptoDeviceId(`memory-issuer-${randomUUID()}`);
  const grant = await mintGrant(crypto, {
    id: grantId(grantValue),
    issuingDeviceId,
    issuingHumanId: humanValue,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentValue,
    recipientKeyId: `memory-recipient-${randomUUID()}`,
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanValue],
    operations: ["encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: domains.slice(0, activeNamespaceCount),
    singleUse: false,
  });
  const bindingHashes = namespaceMaterials.map((entry) =>
    entry.bindingHash
  ) as [Uint8Array, Uint8Array];
  const namespaceRequirements = namespaceIds.slice(0, activeNamespaceCount)
    .map((value, index) => ({
    namespaceId: namespaceId(value),
    domainId: domains[index]!.domainId,
    operations: ["encrypt"] as const,
    namespaceParticipants: [humanValue],
    expectedAccessRevision: accessRevision(0),
    expectedPolicyRevision: authorizationRevision(21 + index),
  }));
  const authorization: GrantAuthoritySetAuthorization = {
    now: NOW + 1,
    expectedIssuingDeviceId: issuingDeviceId,
    issuingDeviceHumanId: humanValue,
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentValue,
    recipientKeyId: grant.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    singleUseAvailable: true,
    grantScope: grant.scope,
    namespaceRequirements,
    domainRequirements: domains.slice(0, activeNamespaceCount).map((domain) => ({
      domainId: domain.domainId,
      expectedEpoch: domain.domainEpoch,
      expectedAgentAuthorizationRevision: domain.agentAuthorizationRevision,
    })),
    hostAllowsOperation: true,
  };
  const grantBytes = serializeGrantV2(grant);
  await inMemoryStore.putGrant(grantWriteRecord(grantBytes));
  const agentRuntime = Object.freeze({
    ...initialized.runtime,
    key: initialized.runtime.key.slice(),
  });
  const nativeNamespaces = Object.freeze(namespaceMaterials.map(
    (entry, index) => Object.freeze({
      authority: Object.freeze({
        namespaceId: entry.namespaceId,
        namespaceAccessRevision: 0,
        namespaceKeyGeneration: entry.currentGeneration,
        domainId: entry.domainId,
        domainKeyGeneration: 0,
        domainAuthorizationRevision:
          domains[index]!.agentAuthorizationRevision,
        domainHeadDigest: entry.bindingHash.slice(),
        namespaceHeadDigest: entry.bindingHash.slice(),
        namespacePublicationDigest: entry.bindingHash.slice(),
        namespacePublicationSetDigest: entry.bindingHash.slice(),
        namespaceAudienceFingerprint: entry.bindingHash.slice(),
      }),
      key: entry.key.slice(),
    })),
  );
  const preflight = await preflightGrantAuthoritySetUse(
    crypto,
    grant,
    authorization,
  );
  if (preflight === null) throw new Error("Expected Memory Grant preflight");
  const coordinated = await coordinateGrantAuthoritySetUse({
    preflight,
    storage: inMemoryStore,
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: context.preflightTime,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
    execute: (_opened, evidence) => {
      const prepare = (contentRevision: number, content: string) =>
        prepareAgentMemoryCryptoRevision({
          crypto,
          memoryId,
          contentRevision,
          payload: {
            formatVersion: 1,
            content,
            type: plaintextType,
          },
          createdAt: NOW,
          namespaceSet: {
            recipientAgentId: agentValue,
            runtimeAuthorizationRevision,
            namespaces: namespaceRequirements.map((requirement, index) => ({
              namespaceId: requirement.namespaceId,
              domainId: requirement.domainId,
              domainEpoch: domains[index]!.domainEpoch,
              accessRevision: requirement.expectedAccessRevision,
              policyRevision: requirement.expectedPolicyRevision,
              domainAgentAuthorizationRevision:
                domains[index]!.agentAuthorizationRevision,
              bindingHash: bindingHashes[index]!,
              currentGeneration: namespaceMaterials[index]!.currentGeneration,
              generations: [{
                generation: namespaceMaterials[index]!.currentGeneration,
                key: namespaceMaterials[index]!.key,
              }],
            })),
          },
          authoritySet: evidence,
          runtime: initialized.runtime,
          signerPublication: initialized.signerPublication,
        });
      return Object.freeze({
        createPrepared: prepare(1, plaintext),
        prepared: prepare(3, plaintext),
        replacementPrepared: prepare(4, `${plaintext}:replacement`),
      });
    },
  });
  if (coordinated.status !== "executed") {
    throw new Error("Expected Memory preparation to execute");
  }
  const { createPrepared, prepared, replacementPrepared } = coordinated.value;
  initialized.runtime.key.fill(0);
  namespaceMaterials.forEach((entry) => entry.key.fill(0));
  const requiredNamespaceFingerprint = fingerprintRequiredMemoryNamespaces(
    prepared.requiredNamespaceIds,
  );
  const scopeIds = options.scopeOrigin ? [randomUUID()] : [];
  const fixture: IntegrationFixture = Object.freeze({
    memoryId,
    namespaceIds,
    domainIds,
    agentProductId,
    userId,
    scopeIds,
    grantId: grantValue,
    agentCryptoId,
    objectId: prepared.objectId,
    plaintext,
    plaintextType,
    shadowEmbeddingText,
    crypto,
    managerSigningPublicKey: manager.publicKey.slice(),
    managerDeviceId: String(managerDeviceId),
    managerAuthorizationRevision: 8,
    agentSignerPublicKey:
      initialized.signerPublication.signerPublicKey.slice(),
    agentSignerKeyId: initialized.signerPublication.signerKeyId,
    agentRuntimeGeneration: Number(initialized.runtime.generation),
    agentRuntime,
    humanCryptoId: String(humanValue),
    runtimeAuthorizationRevision,
    runtimeStorage: inMemoryStore,
    namespaceBindingFacts: Object.freeze(namespaceMaterials.map(
      (entry, index) => Object.freeze({
        namespaceId: entry.namespaceId,
        domainId: entry.domainId,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 21 + index,
        bindingHash: entry.bindingHash.slice(),
      }),
    )),
    nativeNamespaces,
    domainFacts: Object.freeze(domains.map((domain) => Object.freeze({
      domainId: String(domain.domainId),
      epoch: Number(domain.domainEpoch),
      agentAuthorizationRevision: Number(domain.agentAuthorizationRevision),
      aiRoot: domain.aiRoot.slice(),
    }))),
    prepared,
    createPrepared,
    replacementPrepared,
    reference: Object.freeze({
      memoryId,
      contentRevision: prepared.contentRevision,
      objectId: prepared.objectId,
      expectedAccessRevision: 0,
      expectedActiveNamespaceFingerprint: requiredNamespaceFingerprint,
    }),
    requiredNamespaceFingerprint,
  });
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'Memory integration user')`,
      [userId],
    );
    await transaction.unsafe(
      `INSERT INTO agents (id, handle) VALUES ($1, $2)`,
      [agentProductId, `memory-integration-${agentProductId}`],
    );
    const humanActorId = randomUUID();
    const agentActorId = randomUUID();
    await transaction.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind, agent_id
       ) VALUES
         ($1, $2, 'Memory integration Human', 'verified', 'user', NULL),
         ($3, $2, 'Memory integration Agent', 'verified', 'agent', $4)`,
      [humanActorId, userId, agentActorId, agentProductId],
    );
    for (const [index, namespaceValue] of namespaceIds.entries()) {
      await transaction.unsafe(
        `INSERT INTO namespaces (id, scope, label)
         VALUES ($1, 'room', $2)`,
        [namespaceValue, `Memory integration Namespace ${index}`],
      );
      const roomId = randomUUID();
      await transaction.unsafe(
        `INSERT INTO rooms (
           id, owner_id, type, label, graph_thread_id, namespace_id,
           human_actor_ids, kind, created_by
         ) VALUES (
           $1, $2, 'private', $3, $4, $5,
           ARRAY[$6::uuid], 'private', $6
         )`,
        [
          roomId,
          userId,
          `Memory integration Room ${index}`,
          `memory-integration:${roomId}`,
          namespaceValue,
          humanActorId,
        ],
      );
      await transaction.unsafe(
        `INSERT INTO room_members (
           room_id, actor_id, room_role, agent_response_mode
         ) VALUES
           ($1, $2, 'admin', NULL),
           ($1, $3, 'member', 'active')`,
        [roomId, humanActorId, agentActorId],
      );
    }
    if (options.seedProduct !== false) await transaction.unsafe(
      `INSERT INTO memories (
         id, type, content, content_revision, scope_origin_namespace_id,
         embedding
       ) VALUES ($1, $2, $3, 3, $4, $5::vector(1536))`,
      [
        memoryId,
        options.protectedOnly ? null : plaintextType,
        options.protectedOnly ? null : plaintext,
        options.scopeOrigin ? namespaceIds[1] : null,
        shadowEmbeddingText,
      ],
    );
    const attachedNamespaceIds = options.scopeOrigin
      ? namespaceIds.slice(0, 1)
      : namespaceIds;
    for (const namespaceValue of options.seedProduct === false ? [] : attachedNamespaceIds) {
      await transaction.unsafe(
        `INSERT INTO memory_namespaces (memory_id, namespace_id)
         VALUES ($1, $2)`,
        [memoryId, namespaceValue],
      );
    }
    if (options.scopeOrigin && options.seedProduct !== false) {
      const scopeId = scopeIds[0]!;
      await transaction.unsafe(
        `INSERT INTO agent_scopes (
           id, parent_agent_id, speaker_user_id, name
         ) VALUES ($1, $2, $3, $4)`,
        [scopeId, agentProductId, userId, `scope-${scopeId}`],
      );
      await transaction.unsafe(
        `INSERT INTO memory_scopes (memory_id, scope_id, origin)
         VALUES ($1, $2, 'scope')`,
        [memoryId, scopeId],
      );
    }
    if (options.seedProduct !== false) await transaction.unsafe(
      `INSERT INTO memory_crypto_revisions (
         memory_id, content_revision, anchor_namespace_id,
         crypto_object_id, allocation_request_digest,
         required_namespace_fingerprint
       ) VALUES ($1, 3, $2, $3, $4, $5)`,
      [
        memoryId,
        namespaceIds[0],
        prepared.objectId,
        digest(0x93),
        requiredNamespaceFingerprint,
      ],
    );
    for (const [index, domain] of domains.entries()) {
      await transaction.unsafe(
        `INSERT INTO crypto_domains (
           id, participant_digest, participants, epoch,
           authorization_revision, roster_bytes
         ) VALUES ($1, $2, $3::text[], $4, $5, $6)`,
        [
          domain.domainId,
          participantDigest([humanValue]),
          [humanValue],
          domain.domainEpoch,
          domain.agentAuthorizationRevision,
          new Uint8Array([0x40 + index]),
        ],
      );
      await transaction.unsafe(
        `INSERT INTO namespace_crypto_bindings (
           namespace_id, revision, binding_hash, previous_binding_hash,
           signed_binding_bytes, human_keyring_envelope_bytes,
           ai_keyring_envelope_bytes
         ) VALUES ($1, 0, $2, NULL, $3, $4, $5)`,
        [
          namespaceIds[index]!,
          bindingHashes[index]!,
          namespaceMaterials[index]!.bindingBytes,
          namespaceMaterials[index]!.humanEnvelopeBytes,
          namespaceMaterials[index]!.aiEnvelopeBytes,
        ],
      );
      await transaction.unsafe(
        `INSERT INTO namespace_crypto_heads (
           namespace_id, access_revision, binding_hash, domain_id,
           domain_epoch
         ) VALUES ($1, 0, $2, $3, $4)`,
        [
          namespaceIds[index]!,
          bindingHashes[index]!,
          domain.domainId,
          domain.domainEpoch,
        ],
      );
      const nativeOperationId = `memory-native-${namespaceIds[index]}`;
      const nativeDigest = bindingHashes[index]!;
      await transaction.unsafe(
        `INSERT INTO namespace_domain_key_bindings (
           operation_id, idempotency_key, namespace_id, domain_id, key_class,
           domain_key_generation, domain_authorization_revision, domain_head_digest,
           namespace_access_revision, namespace_current_generation, bundle_revision,
           retained_generation_count, retained_authority_set_digest,
           previous_binding_digest, binding_digest, plaintext_digest,
           ciphertext_digest, binding_bytes, issuer_human_id, issuer_device_id,
           issuer_device_signing_generation, state, created_at, updated_at,
           deadline_at, activated_at, terminal_at
         ) VALUES ($1, $1, $2, $3, 'ai', 0, $4, $5, 0, $6, 0, 1, $7,
           NULL, $7, $7, $7, $8, $9, $10, 0, 'active', NOW(), NOW(),
           NOW() + INTERVAL '1 hour', NOW(), NOW())`,
        [nativeOperationId, namespaceIds[index]!, domain.domainId,
          domain.agentAuthorizationRevision, nativeDigest,
          namespaceMaterials[index]!.currentGeneration, nativeDigest,
          namespaceMaterials[index]!.bindingBytes, humanValue, managerDeviceId],
      );
      await transaction.unsafe(
        `INSERT INTO namespace_domain_key_heads (
           namespace_id, key_class, domain_id, domain_key_generation,
           domain_authorization_revision, domain_head_digest,
           namespace_access_revision, namespace_current_generation,
           bundle_revision, retained_generation_count,
           retained_authority_set_digest, binding_digest,
           binding_operation_id, activated_at
         ) VALUES ($1, 'ai', $2, 0, $3, $4, 0, $5, 0, 1, $4, $4, $6, NOW())`,
        [namespaceIds[index]!, domain.domainId,
          domain.agentAuthorizationRevision, nativeDigest,
          namespaceMaterials[index]!.currentGeneration, nativeOperationId],
      );
    }
    await transaction.unsafe(
      `INSERT INTO agent_crypto_runtime_states (
         agent_id, authorization_revision, runtime_generation,
         config_object_count, config_inventory_digest
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        agentValue,
        runtimeAuthorizationRevision,
        initialized.runtime.generation,
        initialized.intended.configInventory.objectCount,
        initialized.intended.configInventory.digest,
      ],
    );
    const publication = initialized.signerPublication;
    await transaction.unsafe(
      `INSERT INTO agent_crypto_runtime_signers (
         agent_id, runtime_generation, authorization_revision,
         transition_kind, operation_id, signer_key_id,
         signer_public_key, publication_bytes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        publication.agentId,
        publication.runtimeGeneration,
        publication.authorizationRevision,
        publication.transitionKind,
        publication.operationId,
        publication.signerKeyId,
        publication.signerPublicKey,
        encodeAgentRuntimeSignerPublicationV1(publication),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO crypto_grants (grant_id, grant_bytes, consumed)
       VALUES ($1, $2, FALSE)`,
      [grant.id, grantBytes],
    );
  });

  return fixture;
}

type NativeNamespaceFixture = Readonly<{
  authority: ForegroundAgentEntityNamespaceAuthority;
  key: Uint8Array;
}>;

async function createNativeTargetNamespace(
  fixture: IntegrationFixture,
): Promise<NativeNamespaceFixture> {
  let targetNamespaceId = `00000000-${randomUUID().slice(9)}`;
  while (fixture.namespaceIds.includes(targetNamespaceId)) {
    targetNamespaceId = `00000000-${randomUUID().slice(9)}`;
  }
  const targetDomainId = `native-memory-target-${randomUUID()}`;
  const targetRoot = digest(0xd7);
  const targetSigner = fixture.crypto.generateSigningKeyPair();
  const targetDeviceId = cryptoDeviceId(`native-memory-target-${randomUUID()}`);
  const keyrings = createInitialNamespaceKeyrings(
    fixture.crypto,
    namespaceId(targetNamespaceId),
  );
  const metadata = {
    domainId: cryptoDomainId(targetDomainId),
    domainEpoch: domainEpoch(9),
    previousBindingHash: null,
    committerDeviceId: targetDeviceId,
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto: fixture.crypto,
    domainRoot: digest(0xd6),
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: targetSigner.privateKey,
    resolveCurrentCommitter: () => targetSigner.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: fixture.crypto,
    domainRoot: targetRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: targetSigner.privateKey,
    resolveCurrentCommitter: () => targetSigner.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto: fixture.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: targetSigner.privateKey,
    resolveCurrentCommitter: () => targetSigner.publicKey,
  });
  const bindingHash = namespaceBindingHash(binding);
  const bindingBytes = serializeNamespaceBindingV2(binding);
  const humanEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(humanEnvelope);
  const aiEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(aiEnvelope);
  const generation = keyrings.ai.generations.find((entry) =>
    entry.generation === keyrings.ai.currentGeneration
  );
  if (generation === undefined) throw new Error("Native target key is absent");
  const nativeOperationId = `memory-native-${targetNamespaceId}`;
  const [actors] = await admin.unsafe<{
    human_actor_id: string;
    agent_actor_id: string;
  }[]>(
    `SELECT
       max(id::text) FILTER (WHERE kind = 'user') AS human_actor_id,
       max(id::text) FILTER (WHERE kind = 'agent') AS agent_actor_id
     FROM actors WHERE owner_id = $1`,
    [fixture.userId],
  );
  if (actors === undefined) throw new Error("Native target actors are absent");
  const targetRoomId = randomUUID();
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'room', 'Native exact-access target')`,
      [targetNamespaceId],
    );
    await transaction.unsafe(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind, created_by
       ) VALUES ($1, $2, 'private', 'Native exact-access target', $3,
         $4, ARRAY[$5::uuid], 'access', $5)`,
      [targetRoomId, fixture.userId, `native-access:${targetRoomId}`,
        targetNamespaceId, actors.human_actor_id],
    );
    await transaction.unsafe(
      `INSERT INTO room_members (
         room_id, actor_id, room_role, agent_response_mode
       ) VALUES
         ($1, $2, 'admin', NULL),
         ($1, $3, 'member', 'active')`,
      [targetRoomId, actors.human_actor_id, actors.agent_actor_id],
    );
    await transaction.unsafe(
      `INSERT INTO crypto_domains (
         id, participant_digest, participants, epoch,
         authorization_revision, roster_bytes
       ) VALUES ($1, $2, ARRAY[$3]::text[], 9, 31, $4)`,
      [targetDomainId, participantDigest([humanId(fixture.humanCryptoId)]),
        fixture.humanCryptoId, new Uint8Array([0xd7])],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_crypto_bindings (
         namespace_id, revision, binding_hash, previous_binding_hash,
         signed_binding_bytes, human_keyring_envelope_bytes,
         ai_keyring_envelope_bytes
       ) VALUES ($1, 0, $2, NULL, $3, $4, $5)`,
      [targetNamespaceId, bindingHash, bindingBytes,
        humanEnvelopeBytes, aiEnvelopeBytes],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_crypto_heads (
         namespace_id, access_revision, binding_hash, domain_id, domain_epoch
       ) VALUES ($1, 0, $2, $3, 9)`,
      [targetNamespaceId, bindingHash, targetDomainId],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_domain_key_bindings (
         operation_id, idempotency_key, namespace_id, domain_id, key_class,
         domain_key_generation, domain_authorization_revision, domain_head_digest,
         namespace_access_revision, namespace_current_generation, bundle_revision,
         retained_generation_count, retained_authority_set_digest,
         previous_binding_digest, binding_digest, plaintext_digest,
         ciphertext_digest, binding_bytes, issuer_human_id, issuer_device_id,
         issuer_device_signing_generation, state, created_at, updated_at,
         deadline_at, activated_at, terminal_at
       ) VALUES ($1, $1, $2, $3, 'ai', 0, 31, $4, 0, $5, 0, 1, $4,
         NULL, $4, $4, $4, $6, $7, $8, 0, 'active', NOW(), NOW(),
         NOW() + INTERVAL '1 hour', NOW(), NOW())`,
      [nativeOperationId, targetNamespaceId, targetDomainId, bindingHash,
        generation.generation, bindingBytes, fixture.humanCryptoId,
        targetDeviceId],
    );
    await transaction.unsafe(
      `INSERT INTO namespace_domain_key_heads (
         namespace_id, key_class, domain_id, domain_key_generation,
         domain_authorization_revision, domain_head_digest,
         namespace_access_revision, namespace_current_generation,
         bundle_revision, retained_generation_count,
         retained_authority_set_digest, binding_digest,
         binding_operation_id, activated_at
       ) VALUES ($1, 'ai', $2, 0, 31, $3, 0, $4, 0, 1, $3, $3, $5, NOW())`,
      [targetNamespaceId, targetDomainId, bindingHash,
        generation.generation, nativeOperationId],
    );
  });
  targetSigner.privateKey.fill(0);
  return Object.freeze({
    authority: Object.freeze({
      namespaceId: targetNamespaceId,
      namespaceAccessRevision: 0,
      namespaceKeyGeneration: generation.generation,
      domainId: targetDomainId,
      domainKeyGeneration: 0,
      domainAuthorizationRevision: 31,
      domainHeadDigest: bindingHash.slice(),
      namespaceHeadDigest: bindingHash.slice(),
      namespacePublicationDigest: bindingHash.slice(),
      namespacePublicationSetDigest: bindingHash.slice(),
      namespaceAudienceFingerprint: bindingHash.slice(),
    }),
    key: generation.key.slice(),
  });
}

function createNativeEntityInvocation(
  namespaces: readonly NativeNamespaceFixture[],
): Pick<ForegroundAgentEntityCryptoInvocation, "signal" | "use" | "useCurrentSet"> {
  const signal = new AbortController().signal;
  const byId = new Map(namespaces.map((entry) =>
    [entry.authority.namespaceId, entry] as const));
  const useOne = async <Value>(
    entry: NativeNamespaceFixture,
    execute: (context: Readonly<{
      namespaceKey: Uint8Array;
      authority: ForegroundAgentEntityNamespaceAuthority;
    }>) => Promise<Value> | Value,
  ) => {
    const namespaceKey = entry.key.slice();
    try {
      return Object.freeze({ status: "executed" as const,
        value: await execute({ namespaceKey, authority: entry.authority }) });
    } finally {
      namespaceKey.fill(0);
    }
  };
  return Object.freeze({
    signal,
    use: async <Value>(input: Readonly<{
      operations: readonly ("decrypt" | "encrypt")[];
      entity: Readonly<{
        namespaceId: string;
        keyGeneration: number;
        accessRevision: number;
      }>;
      execute(context: Readonly<{
        namespaceKey: Uint8Array;
        authority: ForegroundAgentEntityNamespaceAuthority;
      }>): Promise<Value> | Value;
    }>) => {
      const entry = byId.get(input.entity.namespaceId);
      if (entry === undefined
        || entry.authority.namespaceKeyGeneration !== input.entity.keyGeneration
        || entry.authority.namespaceAccessRevision !== input.entity.accessRevision) {
        return Object.freeze({ status: "unavailable" as const,
          reason: "authorization_unavailable" as const });
      }
      return useOne(entry, input.execute);
    },
    useCurrentSet: async <Value>(input: Readonly<{
      operations: readonly ("decrypt" | "encrypt")[];
      namespaceIds: readonly string[];
      execute(items: readonly Readonly<{
        namespaceKey: Uint8Array;
        authority: ForegroundAgentEntityNamespaceAuthority;
      }>[]): Promise<Value> | Value;
    }>) => {
      const entries = input.namespaceIds.map((id) => byId.get(id));
      if (entries.some((entry) => entry === undefined)) {
        return Object.freeze({ status: "unavailable" as const,
          reason: "authorization_unavailable" as const });
      }
      const opened = entries.map((entry) => Object.freeze({
        namespaceKey: entry!.key.slice(),
        authority: entry!.authority,
      }));
      try {
        return Object.freeze({ status: "executed" as const,
          value: await input.execute(opened) });
      } finally {
        opened.forEach((entry) => entry.namespaceKey.fill(0));
      }
    },
  });
}

async function openNativeExactAccessFixture() {
  const fixture = await createFixture({ scopeOrigin: false, protectedOnly: true });
  const productStore = await openProductStore();
  const initialCrypto = await openCryptoCompletion(fixture);
  try {
    expect(await initialCrypto.completion.complete(fixture.prepared)).toBe("created");
    expect(await productStore.store.markCryptoComplete({
      memoryId: fixture.memoryId,
      contentRevision: 3,
      cryptoObjectId: fixture.objectId,
      leaseToken: null,
    })).toBe("applied");
    expect(await productStore.store.compareAndSwapCryptoMapping({
      memoryId: fixture.memoryId,
      contentRevision: 3,
      cryptoObjectId: fixture.objectId,
      expectedRequiredNamespaceFingerprint: fixture.requiredNamespaceFingerprint,
      leaseToken: null,
    })).toBe("applied");
  } finally {
    await productStore.client.end();
    await initialCrypto.client.end();
  }

  const target = await createNativeTargetNamespace(fixture);
  const namespaces = Object.freeze([...fixture.nativeNamespaces, target]
    .sort((left, right) =>
      left.authority.namespaceId.localeCompare(right.authority.namespaceId)
    ));
  const entities = createNativeEntityInvocation(namespaces);
  const agentClient = sqlClient(agentUrl);
  const cryptoClient = sqlClient(cryptoUrl);
  const productHandle = await verifyConversationProductPostgresHandle(
    agentProductConnection(agentClient, fixture.userId, fixture.agentProductId),
  );
  const cryptoHandle = await verifyCryptoPostgresHandle(
    cryptoConnection(cryptoClient),
  );
  const product = new PostgresAgentMemoryExactAccessProduct({
    handle: productHandle,
    readableNamespaceIds: namespaces.map((entry) => entry.authority.namespaceId),
    resolveGrantUserNamespace: ({ userHandle }) => Promise.resolve(
      userHandle === "integration-target" ? target.authority.namespaceId : null,
    ),
  });
  const signer = (principal: Readonly<{
    agentId: string;
    runtimeGeneration: number;
    signerKeyId: string;
  }>) => principal.agentId === fixture.agentCryptoId
      && principal.runtimeGeneration === fixture.agentRuntimeGeneration
      && principal.signerKeyId === fixture.agentSignerKeyId
    ? fixture.agentSignerPublicKey.slice()
    : null;
  const nativeEntries = (coordinates: readonly Readonly<{
    namespaceId: string;
    generation: number;
    accessRevision: number;
    envelopeHash: Uint8Array;
  }>[]) => {
    const entries = coordinates.map((coordinate) => {
      const namespace = namespaces.find((candidate) =>
        candidate.authority.namespaceId === coordinate.namespaceId
        && candidate.authority.namespaceKeyGeneration === coordinate.generation
        && candidate.authority.namespaceAccessRevision === coordinate.accessRevision
      );
      return namespace === undefined ? null : Object.freeze({
        namespaceId: namespaceId(coordinate.namespaceId),
        keyGeneration: coordinate.generation,
        namespaceAccessRevision: coordinate.accessRevision,
        headDigest: namespace.authority.namespaceHeadDigest.slice(),
        publicationDigest:
          namespace.authority.namespacePublicationDigest.slice(),
        publicationSetDigest:
          namespace.authority.namespacePublicationSetDigest.slice(),
        audienceFingerprint:
          namespace.authority.namespaceAudienceFingerprint.slice(),
        envelopeHash: coordinate.envelopeHash.slice(),
      });
    });
    return entries.some((entry) => entry === null)
      ? null
      : Object.freeze(entries as Array<Exclude<typeof entries[number], null>>);
  };
  const read = (request: Readonly<{
    objectId: string;
    expectedObjectType: string;
    expectedAccessRevision?: number;
    expectedNamespaceIds: readonly string[];
  }>) => readVerifiedDeviceWrappedAgentObject({
    handle: cryptoHandle,
    crypto: fixture.crypto,
    ...request,
    resolveNativeNamespaceEntries: (coordinates) =>
      Promise.resolve(nativeEntries(coordinates)),
    resolveHistoricalAgentSignerAuthority: (context) => ({
      ...context,
      managerSigningPublicKey: fixture.managerSigningPublicKey.slice(),
    }),
    resolveLiveShadowAgentSigner: signer,
  });
  const exactCrypto = createForegroundDomainMemoryExactAccess({
    crypto: fixture.crypto,
    entities,
    runtime: fixture.agentRuntime,
    signerKeyId: fixture.agentSignerKeyId,
    agentAuthorizationRevision: fixture.runtimeAuthorizationRevision,
    read: async (request) => {
      const value = await read({ ...request, expectedObjectType: MEMORY_OBJECT_TYPE });
      return value?.nativeEntries === undefined
        ? null
        : { ...value, nativeEntries: value.nativeEntries };
    },
  });
  const persist = (publication: Parameters<
    typeof persistForegroundAgentMemoryNativeExactAccess
  >[0]["publication"]) => persistForegroundAgentMemoryNativeExactAccess({
    handle: cryptoHandle,
    crypto: fixture.crypto,
    publication,
    resolveHistoricalAgentSignerAuthority: (context) => ({
      ...context,
      managerSigningPublicKey: fixture.managerSigningPublicKey.slice(),
    }),
    resolveLiveShadowAgentSigner: signer,
    resolveCurrentAgentSigner: signer,
  });
  const authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }> =
    Object.freeze({
      mode: "namespace",
      subjectUserId: fixture.userId,
      agentId: fixture.agentProductId,
      readableNamespaceIds: Object.freeze(namespaces.map((entry) =>
        entry.authority.namespaceId
      )),
      mutableNamespaceIds: Object.freeze(namespaces.map((entry) =>
        entry.authority.namespaceId
      )),
      writableNamespaceId: target.authority.namespaceId,
    });
  const createPort = (
    persistPublication = persist,
  ) => createForegroundDomainProtectedAgentMemoryAccessPort({
    subjectUserId: fixture.userId,
    agentId: fixture.agentProductId,
    crypto: exactCrypto,
    product,
    persist: persistPublication,
  });
  return Object.freeze({
    fixture,
    target,
    authority,
    read,
    persist,
    product,
    exactCrypto,
    createPort,
    close: async () => {
      fixture.agentRuntime.key.fill(0);
      namespaces.forEach((entry) => entry.key.fill(0));
      await agentClient.end();
      await cryptoClient.end();
    },
  });
}

async function readNativeTargetPayload(
  context: Awaited<ReturnType<typeof openNativeExactAccessFixture>>,
) {
  const expectedNamespaceIds = Object.freeze([
    ...context.fixture.namespaceIds,
    context.target.authority.namespaceId,
  ].sort());
  const durable = await context.read({
    objectId: context.fixture.objectId,
    expectedObjectType: MEMORY_OBJECT_TYPE,
    expectedAccessRevision: 1,
    expectedNamespaceIds,
  });
  expect(durable?.namespaceEnvelopes.map((entry) => entry.namespaceId).sort())
    .toEqual([...expectedNamespaceIds]);
  const targetEnvelope = durable?.namespaceEnvelopes.find((entry) =>
    entry.namespaceId === context.target.authority.namespaceId
  );
  if (durable === null || targetEnvelope === undefined) {
    throw new Error("Native recipient envelope absent");
  }
  const decodedEnvelope = decodeNamespaceObjectEnvelopeV2(
    targetEnvelope.envelopeBytes,
  );
  const dek = openObjectDekForNamespace(
    context.fixture.crypto,
    context.target.key,
    decodedEnvelope,
  );
  if (dek === null) throw new Error("Native recipient could not open DEK");
  const encrypted = decodeEncryptedPayloadV2(durable.payloadBytes);
  const plaintext = decryptObjectPayload(context.fixture.crypto, dek, encrypted);
  if (plaintext === null) throw new Error("Native recipient could not decrypt");
  try {
    return decodeMemoryPayloadV1(plaintext);
  } finally {
    plaintext.fill(0);
    encrypted.ciphertext.fill(0);
    decodedEnvelope.wrappedDek.fill(0);
    dek.fill(0);
  }
}

async function openProductStore(): Promise<Readonly<{
  client: SqlClient;
  store: PostgresMemoryProductStore;
}>> {
  const client = sqlClient(appUrl);
  try {
    const handle = await verifyConversationProductPostgresHandle(
      productConnection(client),
    );
    return Object.freeze({
      client,
      store: new PostgresMemoryProductStore(handle),
    });
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function openCryptoCompletion(fixture: IntegrationFixture) {
  const client = sqlClient(cryptoUrl);
  try {
    const handle = await verifyCryptoPostgresHandle(cryptoConnection(client));
    return Object.freeze({
      client,
      completion: createPostgresMemoryCryptoCompletion({
        handle,
        crypto: fixture.crypto,
        resolveHistoricalAgentSignerAuthority: (context) => ({
          ...context,
          managerSigningPublicKey: fixture.managerSigningPublicKey.slice(),
        }),
      }),
    });
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function openAgentProductPort(
  fixture: IntegrationFixture,
  cryptoCompletion: ReturnType<typeof createPostgresMemoryCryptoCompletion>,
  createMemoryId?: () => string,
) {
  const client = sqlClient(agentUrl);
  try {
    const handle = await verifyConversationProductPostgresHandle(
      agentProductConnection(client, fixture.userId, fixture.agentProductId),
    );
    const canonicalRunner = bindConversationProductCanonicalTransactionRunner(
      handle,
      agentCanonicalConnection(client, fixture.userId, fixture.agentProductId),
    );
    return Object.freeze({
      client,
      port: new PostgresAgentMemoryProductPort({
        handle,
        canonicalRunner,
        readableNamespaceIds: fixture.namespaceIds,
        cryptoCompletion,
        publication: { representation: "protected_only", beforeLocks: async () => {} },
        ...(createMemoryId === undefined ? {} : { createMemoryId }),
      }),
    });
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function assertMemoryRepresentationAndCryptoOpaque(
  fixture: IntegrationFixture,
  expected: Readonly<{
    objectId?: string;
    embeddingText?: string;
    protectedOnly?: boolean;
  }> = {},
): Promise<void> {
  const expectedObjectId = expected.objectId ?? fixture.objectId;
  const expectedEmbeddingText = expected.embeddingText
    ?? fixture.shadowEmbeddingText;
  const productRows = await admin.unsafe<{
    content: string | null;
    type: string | null;
    embedding: string;
    crypto_object_id: string | null;
  }[]>(
    `SELECT content, type, embedding::text AS embedding, crypto_object_id
       FROM memories
      WHERE id = $1`,
    [fixture.memoryId],
  );
  expect([...productRows]).toEqual([{
    content: expected.protectedOnly ? null : fixture.plaintext,
    type: expected.protectedOnly ? null : fixture.plaintextType,
    embedding: expectedEmbeddingText,
    crypto_object_id: expectedObjectId,
  }]);
  const byteRows = await admin.unsafe<{ bytes: Uint8Array }[]>(
    `SELECT payload_bytes AS bytes
       FROM crypto_objects
      WHERE object_id = $1
     UNION ALL
     SELECT manifest_bytes AS bytes
       FROM object_crypto_access_manifests
      WHERE object_id = $1
     UNION ALL
     SELECT envelope_bytes AS bytes
       FROM object_crypto_namespace_envelopes
      WHERE object_id = $1`,
    [expectedObjectId],
  );
  expect(byteRows).toHaveLength(4);
  for (const row of byteRows) {
    const rendered = Buffer.from(row.bytes).toString("utf8");
    expect(rendered).not.toContain(fixture.plaintext);
    expect(rendered).not.toContain(fixture.plaintextType);
  }
}

async function createHumanDeletionFixture(
  representation: "ordinary_and_protected" | "protected_only" = "protected_only",
) {
  const memoryId = randomUUID();
  const namespaceValue = randomUUID();
  const userId = randomUUID();
  const actorId = randomUUID();
  const humanValue = `human:${randomUUID()}`;
  const deviceValue = `human-device:${randomUUID()}`;
  const operationId = `human-memory:create:${randomUUID()}`;
  const plaintext = `human-delete-canary:${randomUUID()}`;
  const crypto = new LatticeCrypto(seededRng(rngSeed++), {
    now: () => NOW,
  });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId,
    contentRevision: 1,
  });
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(cryptoObjectId),
      keyClass: "ai",
      objectType: MEMORY_OBJECT_TYPE,
      createdAt: unixTimestamp(NOW),
    },
    encodeMemoryPayloadV1({
      formatVersion: 1,
      type: "preference",
      content: plaintext,
    }),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const objectDek = encrypted.dek.slice();
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      crypto,
      digest(0xb1),
      {
        objectId: objectId(cryptoObjectId),
        namespaceId: namespaceId(namespaceValue),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap: accessRevision(0),
      },
      encrypted.dek,
    ),
  );
  encrypted.dek.fill(0);
  const genesis = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(cryptoObjectId),
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(humanValue),
    committerDeviceId: cryptoDeviceId(deviceValue),
    hostAuthorizationRevision: authorizationRevision(1),
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  const signedEmbeddingRequest = prepareHumanMemoryContentEmbeddingRequest(
    crypto,
    {
      subjectHumanId: humanId(humanValue),
      requestId: operationId,
      memoryId,
      expectedProductRevision: 0,
      nextProductRevision: 1,
      cryptoObjectId: objectId(cryptoObjectId),
      ciphertextPayloadHash: crypto.hash(payloadBytes),
      genesisManifestHash: crypto.hash(genesis.manifestBytes),
      namespaceEnvelopes: [{
        namespaceId: namespaceId(namespaceValue),
        envelopeHash: crypto.hash(envelopeBytes),
      }],
      type: "preference",
      content: plaintext,
      requestedProvider: "openai",
      requestedModel: "text-embedding-3-small",
      dimensions: 1536,
      processorContractVersion: 1,
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
      committerDeviceId: cryptoDeviceId(deviceValue),
      hostAuthorizationRevision: authorizationRevision(1),
      committerSigningPublicKey: signing.publicKey,
      committerSigningPrivateKey: signing.privateKey,
    },
  );
  const preparedCreateRequest = Object.freeze({
      requestVersion: 1,
      memoryId,
      operationId,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      cryptoObjectId,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url:
        Buffer.from(payloadBytes).toString("base64url"),
      accessManifestBytesBase64url:
        Buffer.from(genesis.manifestBytes).toString("base64url"),
      requiredNamespaceIds: [namespaceValue],
      namespaceEnvelopes: [{
        namespaceId: namespaceValue,
        envelopeBytesBase64url:
          Buffer.from(envelopeBytes).toString("base64url"),
      }],
      signedContentEmbeddingRequestBytesBase64url:
        Buffer.from(signedEmbeddingRequest.bytes).toString("base64url"),
  });
  try {
    const createdAt = new Date(NOW).toISOString();
    await admin.begin(async (transaction) => {
      await transaction.unsafe(
        "INSERT INTO users (id, name) VALUES ($1, 'Human v5 integration user')",
        [userId],
      );
      await transaction.unsafe(
        `INSERT INTO actors (
           id, owner_id, display_name, trust_state, kind, agent_id
         ) VALUES ($1, $2, 'Human v5 integration actor', 'verified', 'user', NULL)`,
        [actorId, userId],
      );
      await transaction.unsafe(
        `INSERT INTO human_crypto_custodies (
           human_id, user_id, human_actor_id,
           initial_installation_lineage_digest, state, ever_initialized_at,
           first_device_id, current_recovery_generation,
           current_recovery_public_key_digest, revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
        [humanValue, userId, actorId, digest(0xb5), createdAt, deviceValue,
          digest(0xb6)],
      );
      await transaction.unsafe(
        `INSERT INTO human_crypto_devices (
           device_id, human_id, user_id, human_actor_id, client_kind,
           installation_lineage_digest, device_generation,
           signing_public_key, encryption_public_key, public_fingerprint,
           state, authorization_kind, recovery_generation,
           authorization_evidence_digest, key_package_generation,
           key_package_count, revision, created_at, activated_at
         ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
           'active', 'first_bootstrap', 1, $9, 1, 0, 1, $10, $10)`,
        [deviceValue, humanValue, userId, actorId, digest(0xb7),
          signing.publicKey, encryption.publicKey, crypto.hash(signing.publicKey),
          digest(0xb8), createdAt],
      );
      await transaction.unsafe(
        `INSERT INTO namespaces (id, scope, label)
         VALUES ($1, 'room', 'Human v5 integration Namespace')`,
        [namespaceValue],
      );
    });
  } finally {
    encryption.privateKey.fill(0);
  }
  const openCrypto = async () => {
    const client = sqlClient(cryptoUrl);
    const handle = await verifyCryptoPostgresHandle(cryptoConnection(client));
    const completion = createPostgresHumanMemoryCryptoCompletion({
      handle,
      crypto,
      resolveCurrentWriteAuthorization: async (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: signing.publicKey.slice(),
      }),
      resolveStoredSignerAuthority: async (context) => ({
        ...context,
        humanId: humanValue,
        committerSigningPublicKey: signing.publicKey.slice(),
      }),
    });
    return { client, completion, handle };
  };
  const cryptoCompletion = await openCrypto();
  const createProductClient = sqlClient(appUrl);
  const createProductHandle = await verifyConversationProductPostgresHandle(
    humanProductConnection(createProductClient, userId),
  );
  const createProduct = new PostgresHumanMemoryProductUpdate(
    createProductHandle,
    {
      canonicalRunner: bindConversationProductCanonicalTransactionRunner(
        createProductHandle,
        humanCanonicalConnection(createProductClient, userId),
      ),
      publication: {
        representation,
        allowOrdinaryFallback: true,
        policyRevision: 1,
        fence: async () => {},
        withLocks: (_input, publish) => publish(async () => {}),
        withOrdinaryLocks: (_input, publish) => publish(async () => {}),
      },
      createMemoryId: () => memoryId,
      createOperationId: () => operationId,
    },
  );
  const createAuthority = Object.freeze({
    userId,
    actorId,
    agentId: null,
    memoryMode: "namespace" as const,
    readableNamespaceIds: Object.freeze([namespaceValue]),
    mutableNamespaceIds: Object.freeze([namespaceValue]),
    writableNamespaceIds: Object.freeze([namespaceValue]),
    scopeId: null,
    originWritableNamespaceId: null,
    sourceRoomId: actorId,
  });
  const createRoute = createHumanMemoryPreparedCreateRoutePort({
    crypto,
    now: () => NOW,
    resolveHumanId: async (requestedUserId) =>
      requestedUserId === userId ? humanValue : null,
    resolveNamespaceAuthority: async ({ namespaceId: requestedNamespaceId }) => ({
      sourceRoomId: actorId,
      namespaceId: requestedNamespaceId,
      currentGeneration: 0,
      retainedGenerations: [{ generation: 0, accessRevision: 0,
        headDigestBase64url: "AQ", publicationDigestBase64url: "Ag",
        publicationSetDigestBase64url: "Aw", audienceFingerprintBase64url: "BA" }],
    }),
    resolveHistoricalDeviceAuthority: async (context) => ({
      ...context,
      committerSigningPublicKey: signing.publicKey.slice(),
    }),
    resolveHistoricalOrdinaryDeviceAuthority: async () => null,
    resolveCurrentWriteAuthorization: async (context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision: context.hostAuthorizationRevision,
      committerSigningPublicKey: signing.publicKey.slice(),
    }),
    foregroundEmbeddingProcessor: {
      embed: async ({ request }) => {
        expect(request.plaintext).toBe(plaintext);
        return {
          status: "embedded",
          embedding: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1536,
            vector: new Array<number>(1536).fill(0.5),
            processorContractVersion: 1,
          },
        };
      },
    },
    product: createProduct,
    createCryptoCompletion: (resolveCurrentWriteAuthorization) =>
      createPostgresHumanMemoryCryptoCompletion({
        handle: cryptoCompletion.handle,
        crypto,
        resolveCurrentWriteAuthorization,
        resolveStoredSignerAuthority: async (context) => ({
          ...context,
          humanId: humanValue,
          committerSigningPublicKey: signing.publicKey.slice(),
        }),
      }),
  });
  try {
    expect(await createRoute.planCreate({ authority: createAuthority }))
      .toMatchObject({ memoryId, operationId, requiredNamespaceIds: [namespaceValue] });
    expect(await createRoute.createPrepared({
      authority: createAuthority,
      prepared: preparedCreateRequest,
    })).toMatchObject({
      status: "published",
      memory: { projection: { memoryId, contentRevision: 1 } },
    });
  } finally {
    await createProductClient.end();
    await cryptoCompletion.client.end();
  }
  return Object.freeze({
    memoryId,
    humanValue,
    deviceValue,
    userId,
    actorId,
    namespaceValue,
    crypto,
    cryptoObjectId,
    plaintext,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    genesis,
    payloadBytes,
    objectDek,
    envelopeBytes,
    signedEmbeddingRequest,
  });
}

function exactAccessBinding(input: Readonly<{
  crypto: LatticeCrypto;
  namespaceValue: string;
  domainValue: string;
  deviceValue: string;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
}>) {
  const created = createInitialNamespaceKeyrings(
    input.crypto,
    namespaceId(input.namespaceValue),
  );
  const humanKeyring = appendNamespaceGeneration(input.crypto, created.human);
  const metadata = {
    domainId: cryptoDomainId(input.domainValue),
    domainEpoch: domainEpoch(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId(input.deviceValue),
  } as const;
  const resolve = () => input.signingPublicKey;
  const human = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: digest(0xd1),
    keyring: humanKeyring,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  const ai = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: digest(0xd2),
    keyring: created.ai,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  const binding = createNamespaceBinding({
    crypto: input.crypto,
    humanEnvelope: human,
    aiEnvelope: ai,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  [...created.human.generations, ...created.ai.generations,
    ...humanKeyring.generations].forEach((entry) => entry.key.fill(0));
  return Object.freeze({
    bytes: serializeNamespaceBindingV2(binding),
    hash: namespaceBindingHash(binding),
  });
}


beforeAll(() => {
  admin = sqlClient(adminUrl, 1);
});

afterAll(async () => {
  await admin.end();
});

describe("Postgres protected Memory product and crypto adapters", () => {
  test("rejects partially populated foreground replay receipts and null Namespace elements", async () => {
    const digest = new Uint8Array(32).fill(0x31);
    const invalidShapes: readonly Readonly<{
      digest: Uint8Array | null;
      kind: "save" | null;
      namespaceIds: readonly (string | null)[] | null;
    }>[] = [
      { digest, kind: null, namespaceIds: [randomUUID()] },
      { digest: null, kind: "save", namespaceIds: [randomUUID()] },
      { digest, kind: "save", namespaceIds: null },
      { digest, kind: "save", namespaceIds: [randomUUID(), null] },
    ];

    for (const shape of invalidShapes) {
      let caught: unknown;
      try {
        await admin.begin(async (transaction) => {
          // Deliberately bypass typed Drizzle values to exercise malformed
          // nullable UUID-array shapes against the database CHECK itself.
          await transaction.unsafe(
            `INSERT INTO memory_crypto_operations (
               operation_id, memory_id, anchor_namespace_id, operation_type,
               expected_content_revision, expected_access_revision,
               request_digest, foreground_stable_request_digest,
               foreground_mutation_kind, foreground_required_namespace_ids
             ) VALUES ($1, $2, $3, 'metadata', 0, 0, $4, $5, $6, $7::uuid[])`,
            [
              `m320.constraint.${randomUUID()}`,
              randomUUID(),
              randomUUID(),
              digest,
              shape.digest,
              shape.kind,
              shape.namespaceIds,
            ],
          );
          throw new Error("Invalid foreground receipt unexpectedly passed its CHECK");
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "23514",
        constraint_name: "memory_crypto_operations_foreground_replay_coherent",
      });
    }
  });

  test("native foreground exact access attaches an existing target and the recipient decrypts", async () => {
    const context = await openNativeExactAccessFixture();
    try {
      const diagnosticPlan = await context.product.planNativeChange({
        operationId: `native-diagnostic-${randomUUID()}`,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
      });
      expect(diagnosticPlan).toMatchObject({ status: "success", value: {
        status: "prepared",
      } });
      if (diagnosticPlan.status !== "success") {
        throw new Error("Native diagnostic product plan unavailable");
      }
      const diagnosticHead = await context.read({
        objectId: diagnosticPlan.value.plan.cryptoObjectId,
        expectedObjectType: MEMORY_OBJECT_TYPE,
        expectedAccessRevision:
          diagnosticPlan.value.plan.expectedCryptoAccessRevision,
        expectedNamespaceIds: diagnosticPlan.value.plan.currentNamespaceIds,
      });
      expect(diagnosticHead).not.toBeNull();
      const diagnosticPrepared = await context.exactCrypto.prepare({
        objectId: diagnosticPlan.value.plan.cryptoObjectId,
        expectedAccessRevision:
          diagnosticPlan.value.plan.expectedCryptoAccessRevision,
        currentNamespaceIds: diagnosticPlan.value.plan.currentNamespaceIds,
        targetNamespaceIds: diagnosticPlan.value.plan.targetNamespaceIds,
      });
      expect(diagnosticPrepared).not.toBeNull();
      if (diagnosticPrepared === null) {
        throw new Error("Native diagnostic crypto preparation unavailable");
      }
      const diagnosticPublication = await context.exactCrypto.authorizeCommit({
        prepared: diagnosticPrepared,
        commit: (publication) => Promise.resolve(publication),
      });
      expect(await context.persist({
        ...diagnosticPublication,
        targetEnvelopeBytes: Object.freeze(
          diagnosticPublication.targetEnvelopeBytes.slice(0, -1),
        ),
      })).toBe("stale");
      expect(await context.persist({
        ...diagnosticPublication,
        targetEnvelopeBytes: Object.freeze(
          [...diagnosticPublication.targetEnvelopeBytes].reverse(),
        ),
      })).toBe("stale");
      expect([...(await admin.unsafe<{ access_revision: number }[]>(
        `SELECT access_revision::integer AS access_revision
           FROM object_crypto_access_manifests
          WHERE object_id = $1 ORDER BY access_revision`,
        [context.fixture.objectId],
      ))]).toEqual([{ access_revision: 0 }]);
      const port = context.createPort();
      const operationId = `native-access-${randomUUID()}`;
      const toolCallId = `native-tool-${randomUUID()}`;
      const prepared = await port.prepareApproval!({
        operationId,
        toolCallId,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
      });
      expect(prepared).toMatchObject({ status: "success", value: {
        preview: { type: context.fixture.plaintextType,
          content: context.fixture.plaintext },
      } });
      if (prepared.status !== "success") throw new Error("Native approval absent");
      expect(await port.change({
        operationId,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
        approvalReference: prepared.value.reference,
      })).toEqual({ status: "success", value: {
        status: "updated", memoryId: context.fixture.memoryId,
      } });

      expect(await readNativeTargetPayload(context)).toEqual({
        formatVersion: 1,
        type: context.fixture.plaintextType,
        content: context.fixture.plaintext,
      });
    } finally {
      await context.close();
    }
  });

  test("native foreground exact access exposes the crypto-first product-failure retry gap", async () => {
    const context = await openNativeExactAccessFixture();
    try {
      let persisted = false;
      const port = context.createPort(async (publication) => {
        const result = await context.persist(publication);
        persisted = result === "created" || result === "duplicate";
        throw new Error("simulated product-side loss after native crypto commit");
      });
      const operationId = `native-fault-${randomUUID()}`;
      const prepared = await port.prepareApproval!({
        operationId,
        toolCallId: `native-fault-tool-${randomUUID()}`,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
      });
      if (prepared.status !== "success") throw new Error("Native fault approval absent");
      let failure: unknown;
      try {
        await port.change({
          operationId,
          authority: context.authority,
          memoryId: context.fixture.memoryId,
          action: { kind: "grant_user", userHandle: "integration-target" },
          approvalReference: prepared.value.reference,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        message: "simulated product-side loss after native crypto commit",
      });
      expect(persisted).toBe(true);
      const [product] = await admin.unsafe<{
        crypto_access_revision: number;
        target_attached: boolean;
      }[]>(
        `SELECT m.crypto_access_revision,
                EXISTS (
                  SELECT 1 FROM memory_namespaces mn
                   WHERE mn.memory_id = m.id AND mn.namespace_id = $2
                ) AS target_attached
           FROM memories m WHERE m.id = $1`,
        [context.fixture.memoryId, context.target.authority.namespaceId],
      );
      expect(product).toEqual({ crypto_access_revision: 0, target_attached: false });
      expect([...(await admin.unsafe<{
        access_revision: number;
      }[]>(
        `SELECT access_revision::integer AS access_revision FROM object_crypto_access_heads
          WHERE object_id = $1`,
        [context.fixture.objectId],
      ))]).toEqual([{ access_revision: 1 }]);
      expect([...(await admin.unsafe<{
        completion: string;
        disposition: string;
      }[]>(
        `SELECT completion, disposition FROM memory_crypto_operations
          WHERE operation_id = $1`,
        [operationId],
      ))]).toEqual([{ completion: "pending", disposition: "active" }]);

      const fresh = context.createPort();
      const freshOperationId = `native-fresh-retry-${randomUUID()}`;
      const freshToolCallId = `native-fresh-tool-${randomUUID()}`;
      const freshPrepared = await fresh.prepareApproval!({
        operationId: freshOperationId,
        toolCallId: freshToolCallId,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
      });
      expect(freshPrepared).toMatchObject({ status: "success", value: {
        preview: { type: context.fixture.plaintextType,
          content: context.fixture.plaintext },
      } });
      if (freshPrepared.status !== "success") {
        throw new Error("Native recovery did not prepare the replay");
      }
      expect(await fresh.change({
        operationId: freshOperationId,
        authority: context.authority,
        memoryId: context.fixture.memoryId,
        action: { kind: "grant_user", userHandle: "integration-target" },
        approvalReference: freshPrepared.value.reference,
      })).toEqual({ status: "success", value: {
        status: "unchanged", memoryId: context.fixture.memoryId,
      } });
      expect([...(await admin.unsafe<{
        completion: string;
        disposition: string;
      }[]>(
        `SELECT completion, disposition FROM memory_crypto_operations
          WHERE operation_id = $1`,
        [operationId],
      ))]).toEqual([{ completion: "complete", disposition: "complete" }]);
      expect([...(await admin.unsafe<{ access_revision: number }[]>(
        `SELECT access_revision::integer AS access_revision
           FROM object_crypto_access_manifests
          WHERE object_id = $1 ORDER BY access_revision`,
        [context.fixture.objectId],
      ))]).toEqual([{ access_revision: 0 }, { access_revision: 1 }]);
      expect(await readNativeTargetPayload(context)).toEqual({
        formatVersion: 1,
        type: context.fixture.plaintextType,
        content: context.fixture.plaintext,
      });
    } finally {
      await context.close();
    }
  });

  // These scenarios intentionally retain append-only crypto and Runtime signer
  // history. Run them only through the disposable Postgres harness (or against
  // a disposable migration-QA clone), then dispose of the whole database.
  test("shares one actual transaction across canonical Drizzle and raw bridge work", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const client = sqlClient(agentUrl, 1);
    const canonical = agentCanonicalConnection(
      client,
      fixture.userId,
      fixture.agentProductId,
    );
    try {
      await canonical.transaction(async (transaction, executor) => {
        const drizzleIdentity = await transaction.execute<{ txid: string }>(
          sql`SELECT txid_current()::text AS txid`,
        );
        const rawIdentity = await executor.query<{ txid: string }>(
          "SELECT txid_current()::text AS txid",
        );
        expect(drizzleIdentity[0]?.txid).toBe(rawIdentity[0]?.txid);
        await transaction.update(memories).set({ importance: 0.51 })
          .where(eq(memories.id, fixture.memoryId));
        await executor.query(
          "UPDATE memories SET tier = $1::integer WHERE id = $2::uuid",
          [2, fixture.memoryId],
        );
      }, { isolationLevel: "serializable" });
      expect([...(await admin.unsafe<{
        importance: number;
        tier: number;
      }[]>("SELECT importance, tier FROM memories WHERE id = $1::uuid", [
        fixture.memoryId,
      ]))]).toEqual([{ importance: 0.51, tier: 2 }]);

      try {
        await canonical.transaction(async (transaction, executor) => {
          await transaction.update(memories).set({ importance: 0.52 })
            .where(eq(memories.id, fixture.memoryId));
          await executor.query(
            "UPDATE memories SET tier = $1::integer WHERE id = $2::uuid",
            [3, fixture.memoryId],
          );
          throw new Error("rollback probe");
        }, { isolationLevel: "serializable" });
        throw new Error("Expected canonical bridge rollback probe to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("rollback probe");
      }
      expect([...(await admin.unsafe<{
        importance: number;
        tier: number;
      }[]>("SELECT importance, tier FROM memories WHERE id = $1::uuid", [
        fixture.memoryId,
      ]))]).toEqual([{ importance: 0.51, tier: 2 }]);
    } finally {
      await client.end();
    }
  });

  test.each(["raw", "drizzle"] as const)("attaches and replays one exact ordinary-only foreground Memory repair (%s)", async (driver) => {
    const fixture = await createFixture({ scopeOrigin: false });
    const productClient = sqlClient(appUrl);
    const foregroundAgentClient = sqlClient(agentUrl);
    const cryptoCompletion = await openCryptoCompletion(fixture);
    try {
      const product = await verifyConversationProductPostgresHandle(
        driver === "drizzle"
          ? createPostgresJsBridgeConnection(drizzle(productClient))
          : productConnection(productClient),
      );
      const rows = await admin.unsafe<{
        created_at: Date;
        importance: number;
        tier: number;
      }[]>(
        `SELECT created_at, importance, tier
           FROM memories
          WHERE id = $1`,
        [fixture.memoryId],
      );
      const selected = Object.freeze({
        id: fixture.memoryId,
        type: fixture.plaintextType,
        content: fixture.plaintext,
        importance: rows[0]!.importance,
        tier: rows[0]!.tier,
        createdAt: rows[0]!.created_at,
      });
      await admin.unsafe(
        `DELETE FROM memory_crypto_revisions
          WHERE memory_id = $1`,
        [fixture.memoryId],
      );
      const [source] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      expect(source).toMatchObject({
        memory: selected,
        expectedContentRevision: 3,
        targetContentRevision: 3,
        existingObjectId: null,
        expectedAccessRevision: 0,
        accessNamespaceIds: fixture.namespaceIds,
      });
      expect(source?.plaintextBytes).toEqual(encodeMemoryPayloadV1({
        formatVersion: 1,
        type: fixture.plaintextType,
        content: fixture.plaintext,
      }));

      expect(await cryptoCompletion.completion.complete(fixture.prepared))
        .toBe("created");
      expect(await attachPostgresForegroundMemoryRepair({
        product,
        source: source!,
        objectId: fixture.objectId,
        requestCommitment: source!.requestCommitment,
      })).toBe("attached");
      expect(await attachPostgresForegroundMemoryRepair({
        product,
        source: source!,
        objectId: fixture.objectId,
        requestCommitment: source!.requestCommitment,
      })).toBe("replayed");
      const [existingSource] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      expect(existingSource?.existingObjectId).toBe(fixture.objectId);
      expect(await validatePostgresForegroundMemoryRepairSource({
        product,
        source: existingSource!,
        objectId: fixture.objectId,
      })).toBe(true);
      const [protectedSource] = await loadPostgresForegroundMemoryRepairSources({
        product: await verifyConversationProductPostgresHandle(
          agentProductConnection(
            foregroundAgentClient,
            fixture.userId,
            fixture.agentProductId,
          ),
        ),
        crypto: fixture.crypto,
        memories: [selected],
        representationMode: "protected-only",
      });
      expect(protectedSource).toMatchObject({
        memory: { ...selected, type: null, content: null },
        representationMode: "protected-only",
        existingObjectId: fixture.objectId,
        plaintextBytes: null,
      });
      expect([...(await admin.unsafe<{
        content_revision: number;
        crypto_object_id: string;
        crypto_mapping_state: string;
        completion: string;
        disposition: string;
      }[]>(
        `SELECT m.content_revision, m.crypto_object_id,
                m.crypto_mapping_state, r.completion, r.disposition
           FROM memories m
           JOIN memory_crypto_revisions r
             ON r.memory_id = m.id
            AND r.content_revision = m.content_revision
          WHERE m.id = $1`,
        [fixture.memoryId],
      ))]).toEqual([{
        content_revision: 3,
        crypto_object_id: fixture.objectId,
        crypto_mapping_state: "verified",
        completion: "complete",
        disposition: "mapped",
      }]);
      await admin.unsafe(
        `UPDATE memories SET importance = importance + 1 WHERE id = $1`,
        [fixture.memoryId],
      );
      expect(await validatePostgresForegroundMemoryRepairSource({
        product,
        source: existingSource!,
        objectId: fixture.objectId,
      })).toBe(false);
    } finally {
      await foregroundAgentClient.end();
      await productClient.end();
      await cryptoCompletion.client.end();
    }
  });

  test("audience changes allocate a fresh resumable foreground Memory repair", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const productClient = sqlClient(appUrl);
    try {
      const product = await verifyConversationProductPostgresHandle(
        productConnection(productClient),
      );
      const [row] = await admin.unsafe<{
        created_at: Date;
        importance: number;
        tier: number;
      }[]>(
        `SELECT created_at, importance, tier
           FROM memories
          WHERE id = $1`,
        [fixture.memoryId],
      );
      const selected = Object.freeze({
        id: fixture.memoryId,
        type: fixture.plaintextType,
        content: fixture.plaintext,
        importance: row!.importance,
        tier: row!.tier,
        createdAt: row!.created_at,
      });
      await admin.unsafe(
        `DELETE FROM memory_crypto_revisions WHERE memory_id = $1`,
        [fixture.memoryId],
      );
      await admin.unsafe(
        `DELETE FROM memory_namespaces
          WHERE memory_id = $1 AND namespace_id = $2`,
        [fixture.memoryId, fixture.namespaceIds[1]],
      );
      const [first] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      expect(first).toMatchObject({
        targetContentRevision: 3,
        accessNamespaceIds: [fixture.namespaceIds[0]],
      });
      const [resumedFirst] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      expect(resumedFirst?.targetContentRevision).toBe(3);
      expect(resumedFirst?.requestCommitment).toEqual(
        first?.requestCommitment,
      );

      await admin.unsafe(
        `INSERT INTO memory_namespaces (memory_id, namespace_id)
         VALUES ($1, $2)`,
        [fixture.memoryId, fixture.namespaceIds[1]],
      );
      expect(await attachPostgresForegroundMemoryRepair({
        product,
        source: first!,
        objectId: deriveMemoryCryptoObjectIdV1({
          memoryId: fixture.memoryId,
          contentRevision: first!.targetContentRevision,
        }),
        requestCommitment: first!.requestCommitment,
      })).toBe("conflict");

      const [second] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      expect(second).toMatchObject({
        targetContentRevision: 4,
        accessNamespaceIds: fixture.namespaceIds,
      });
      expect([...(await admin.unsafe<{
        content_revision: number;
        completion: string;
        disposition: string;
      }[]>(
        `SELECT content_revision, completion, disposition
           FROM memory_crypto_revisions
          WHERE memory_id = $1
          ORDER BY content_revision`,
        [fixture.memoryId],
      ))]).toEqual([
        { content_revision: 3, completion: "pending", disposition: "active" },
        { content_revision: 4, completion: "pending", disposition: "active" },
      ]);
    } finally {
      await productClient.end();
    }
  });

  test("rejects attachment after selected Memory ranking metadata changes", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const productClient = sqlClient(appUrl);
    try {
      const product = await verifyConversationProductPostgresHandle(
        productConnection(productClient),
      );
      const [row] = await admin.unsafe<{
        created_at: Date;
        importance: number;
        tier: number;
      }[]>(
        `SELECT created_at, importance, tier
           FROM memories
          WHERE id = $1`,
        [fixture.memoryId],
      );
      const selected = Object.freeze({
        id: fixture.memoryId,
        type: fixture.plaintextType,
        content: fixture.plaintext,
        importance: row!.importance,
        tier: row!.tier,
        createdAt: row!.created_at,
      });
      await admin.unsafe(
        `DELETE FROM memory_crypto_revisions WHERE memory_id = $1`,
        [fixture.memoryId],
      );
      const [source] = await loadPostgresForegroundMemoryRepairSources({
        product,
        crypto: fixture.crypto,
        memories: [selected],
      });
      await admin.unsafe(
        `UPDATE memories SET importance = importance + 0.01 WHERE id = $1`,
        [fixture.memoryId],
      );

      expect(await attachPostgresForegroundMemoryRepair({
        product,
        source: source!,
        objectId: deriveMemoryCryptoObjectIdV1({
          memoryId: fixture.memoryId,
          contentRevision: source!.targetContentRevision,
        }),
        requestCommitment: source!.requestCommitment,
      })).toBe("conflict");
    } finally {
      await productClient.end();
    }
  });

  test("keeps the Agent product and restricted crypto roles on opposite sides of the storage boundary", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const crypto = await openCryptoCompletion(fixture);
    const productClient = sqlClient(agentUrl);
    const restrictedCryptoClient = sqlClient(cryptoUrl);
    try {
      expect(await crypto.completion.complete(fixture.prepared)).toBe("created");

      const assertCannotRead = async (
        client: SqlClient,
        statement: string,
        parameters: readonly postgres.ParameterOrJSON<never>[],
      ) => {
        try {
          expect([...(await client.unsafe(statement, [...parameters]))])
            .toEqual([]);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(
            /permission denied|row-level security/u,
          );
        }
      };

      await assertCannotRead(
        productClient,
        "SELECT object_id FROM crypto_objects WHERE object_id = $1",
        [fixture.objectId],
      );
      await assertCannotRead(
        restrictedCryptoClient,
        "SELECT memory_id FROM memory_crypto_revisions WHERE memory_id = $1",
        [fixture.memoryId],
      );
      expect([...(await productClient.unsafe<{ reusable: number }[]>(
        "SELECT 1 AS reusable",
      ))])
        .toEqual([{ reusable: 1 }]);
      expect([...(await restrictedCryptoClient.unsafe<{ reusable: number }[]>(
        "SELECT 1 AS reusable",
      ))])
        .toEqual([{ reusable: 1 }]);
    } finally {
      await productClient.end();
      await restrictedCryptoClient.end();
      await crypto.client.end();
    }
  });

  test("persists an ordinary M:N cross-Domain revision and survives restart and replay", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    let product = await openProductStore();
    let crypto = await openCryptoCompletion(fixture);
    try {
      const initial = await product.store.getRevision({
        memoryId: fixture.memoryId,
        contentRevision: 3,
      });
      expect(initial?.requiredNamespaceIds).toEqual(fixture.namespaceIds);
      expect(await crypto.completion.complete(fixture.prepared)).toBe("created");
      expect(await product.store.markCryptoComplete({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        leaseToken: null,
      })).toBe("applied");
      expect(await product.store.compareAndSwapCryptoMapping({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint:
          fixture.requiredNamespaceFingerprint,
        leaseToken: null,
      })).toBe("applied");
      await assertMemoryRepresentationAndCryptoOpaque(fixture);

      const agent = await openAgentProductPort(
        fixture,
        crypto.completion,
      );
      try {
        const replacementEmbedding = Object.freeze({
          vector: Object.freeze(new Array<number>(1536).fill(0.25)),
          provider: "openai",
          canonicalModel: "text-embedding-3-small",
          dimensions: 1536 as const,
          contractVersion: 1,
        });
        const authority = Object.freeze({
          mode: "namespace" as const,
          subjectUserId: fixture.userId,
          agentId: fixture.agentProductId,
          readableNamespaceIds: fixture.namespaceIds,
          mutableNamespaceIds: fixture.namespaceIds,
          writableNamespaceId: fixture.namespaceIds[0],
        });
        const planned = await agent.port.planReplace({
          operationId: `memory-replace-${randomUUID()}`,
          authority,
          memoryId: fixture.memoryId,
          embedding: replacementEmbedding,
          mutationCommitment: new Uint8Array(32).fill(0x11),
        });
        expect(planned.status).toBe("success");
        if (planned.status !== "success") {
          throw new Error(`Replacement planning failed: ${planned.reason}`);
        }
        expect(planned.value).toMatchObject({
          action: "updated",
          memoryId: fixture.memoryId,
          contentRevision: 4,
          cryptoObjectId: fixture.replacementPrepared.objectId,
        });
        // Planning reserves retry identity only. Until crypto and publication
        // succeed, the complete prior product revision stays usable.
        await assertMemoryRepresentationAndCryptoOpaque(fixture);
        const [reservedProduct] = await drizzle(admin).select({
          contentRevision: memories.contentRevision,
        }).from(memories).where(eq(memories.id, fixture.memoryId));
        expect(reservedProduct?.contentRevision).toBe(3);
        expect(await agent.port.publishPrepared({
          authority,
          plan: planned.value,
          prepared: fixture.replacementPrepared,
          embedding: replacementEmbedding,
        })).toBe("published");
        const replayed = await agent.port.planReplace({
          operationId: planned.value.operationId,
          authority,
          memoryId: fixture.memoryId,
          embedding: replacementEmbedding,
          mutationCommitment: new Uint8Array(32).fill(0x11),
        });
        expect(replayed.status).toBe("success");
        if (replayed.status !== "success") throw new Error("Committed replacement lost its replay receipt");
        expect(replayed.value).toEqual(planned.value);
        expect(await agent.port.publishPrepared({
          authority,
          plan: replayed.value,
          prepared: fixture.replacementPrepared,
          embedding: replacementEmbedding,
        })).toBe("replayed");
        const replaced = await admin.unsafe<{
          content: string | null;
          type: string | null;
          content_revision: number;
          crypto_object_id: string;
          embedding: string;
        }[]>(
          `SELECT content, type, content_revision, crypto_object_id,
                  embedding::text AS embedding
             FROM memories WHERE id = $1`,
          [fixture.memoryId],
        );
        expect([...replaced]).toEqual([{
          content: null,
          type: null,
          content_revision: 4,
          crypto_object_id: fixture.replacementPrepared.objectId,
          embedding: `[${new Array<string>(1536).fill("0.25").join(",")}]`,
        }]);
        expect(await crypto.completion.verify({
          memoryId: fixture.memoryId,
          contentRevision: 4,
          objectId: fixture.replacementPrepared.objectId,
          expectedAccessRevision: 0,
          expectedActiveNamespaceFingerprint:
            fixture.requiredNamespaceFingerprint,
        })).toMatchObject({
          memoryId: fixture.memoryId,
          contentRevision: 4,
          objectId: fixture.replacementPrepared.objectId,
          requiredNamespaceIds: fixture.namespaceIds,
        });
        const lifecycle = await admin.unsafe<{
          content_revision: number;
          completion: string;
          disposition: string;
        }[]>(
          `SELECT content_revision, completion, disposition
             FROM memory_crypto_revisions
            WHERE memory_id = $1
            ORDER BY content_revision`,
          [fixture.memoryId],
        );
        expect([...lifecycle]).toEqual([
          {
            content_revision: 3,
            completion: "complete",
            disposition: "superseded",
          },
          {
            content_revision: 4,
            completion: "complete",
            disposition: "mapped",
          },
        ]);
      } finally {
        await agent.client.end();
      }
    } finally {
      await product.client.end();
      await crypto.client.end();
    }

    await admin.unsafe(`DELETE FROM crypto_grants WHERE grant_id = $1`, [fixture.grantId]);
    await admin.unsafe(
      `DELETE FROM namespace_crypto_heads WHERE namespace_id = ANY($1::text[])`,
      [fixture.namespaceIds],
    );
    await admin.unsafe(
      `DELETE FROM crypto_domains WHERE id = ANY($1::text[])`,
      [fixture.domainIds],
    );

    product = await openProductStore();
    crypto = await openCryptoCompletion(fixture);
    try {
      expect(await crypto.completion.complete(fixture.prepared)).toBe("duplicate");
      expect(await product.store.markCryptoComplete({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        leaseToken: null,
      })).toBe("conflict");
      expect(await product.store.compareAndSwapCryptoMapping({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint:
          fixture.requiredNamespaceFingerprint,
        leaseToken: null,
      })).toBe("stale");
      expect(await crypto.completion.verify(fixture.reference)).toMatchObject({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        objectId: fixture.objectId,
        requiredNamespaceIds: fixture.namespaceIds,
      });
      const heads = await admin.unsafe<{ access_revision: string }[]>(
        `SELECT access_revision
           FROM object_crypto_access_heads
          WHERE object_id = $1`,
        [fixture.objectId],
      );
      expect([...heads]).toEqual([{ access_revision: "0" }]);
      await assertMemoryRepresentationAndCryptoOpaque(fixture, {
        protectedOnly: true,
        objectId: fixture.replacementPrepared.objectId,
        embeddingText: `[${new Array<string>(1536).fill("0.25").join(",")}]`,
      });
    } finally {
      await product.client.end();
      await crypto.client.end();
    }
  });

  test("lets the Human completion reader authenticate an accepted Agent genesis", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const agentCrypto = await openCryptoCompletion(fixture);
    const productClient = sqlClient(appUrl);
    const cryptoClient = sqlClient(cryptoUrl);
    const operationId = `memory-agent-human-read-${randomUUID()}`;
    try {
      expect(await agentCrypto.completion.complete(fixture.prepared)).toBe("created");
      const productHandle = await verifyConversationProductPostgresHandle(
        productConnection(productClient),
      );
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(cryptoClient),
      );
      const roomRows = await admin.unsafe<{ id: string }[]>(
        "SELECT id::text FROM rooms WHERE namespace_id = $1 LIMIT 1",
        [fixture.namespaceIds[0]],
      );
      const roomId = roomRows[0]!.id;
      const sessionId = randomUUID();
      const acceptedDigest = digest(0xa1);
      const namespaceHeadDigest = digest(0xa2);
      const namespacePublicationDigest = digest(0xa3);
      const namespacePublicationSetDigest = digest(0xa4);
      const namespaceAudienceFingerprint = digest(0xa5);
      const grantDomainParticipantDigest = digest(0xa6);
      const grantDomainHeadDigest = digest(0xa7);
      const grantDomainPublicationDigest = digest(0xa8);
      const namespaceBundleDigest = digest(0xa9);
      const humanRequestBytes = digest(0xaa);
      const humanRequestDigest = fixture.crypto.hash(humanRequestBytes);
      const agentGrantPlanBytes = digest(0xab);
      const agentGrantPlanDigest = fixture.crypto.hash(agentGrantPlanBytes);
      const attemptCoordinate = `memory-attempt-${randomUUID()}`;
      const recipientKeyId = `memory-recipient-key-${randomUUID()}`;
      const recipientKey = await globalThis.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
      );
      const recipientPublicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey(
        "raw", recipientKey.publicKey,
      ));
      const actorRows = await admin.unsafe<{ id: string }[]>(
        "SELECT id::text FROM actors WHERE owner_id = $1 AND kind = 'user' LIMIT 1",
        [fixture.userId],
      );
      const humanActorId = actorRows[0]!.id;
      const managerEncryption = await fixture.crypto.generateEncryptionKeyPair();
      managerEncryption.privateKey.fill(0);
      const fixtureDb = drizzle(admin, { schema });
      const messages = await fixtureDb.transaction(async (db) => {
        const timestamp = new Date(NOW);
        await db.insert(schema.humanCryptoCustodies).values({
          humanId: fixture.humanCryptoId,
          userId: fixture.userId,
          humanActorId,
          initialInstallationLineageDigest: digest(0xb1),
          state: "active",
          everInitializedAt: timestamp,
          firstDeviceId: fixture.managerDeviceId,
          currentRecoveryGeneration: 1,
          currentRecoveryPublicKeyDigest: digest(0xb2),
          revision: fixture.managerAuthorizationRevision,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await db.insert(schema.humanCryptoDevices).values({
          deviceId: fixture.managerDeviceId,
          humanId: fixture.humanCryptoId,
          userId: fixture.userId,
          humanActorId,
          clientKind: "electron",
          installationLineageDigest: digest(0xb3),
          deviceGeneration: 1,
          signingPublicKey: fixture.managerSigningPublicKey,
          encryptionPublicKey: managerEncryption.publicKey,
          publicFingerprint: fixture.crypto.hash(fixture.managerSigningPublicKey),
          state: "active",
          authorizationKind: "first_bootstrap",
          recoveryGeneration: 1,
          authorizationEvidenceDigest: digest(0xb4),
          keyPackageGeneration: 1,
          keyPackageCount: 0,
          revision: fixture.managerAuthorizationRevision,
          createdAt: timestamp,
          activatedAt: timestamp,
        });
        await db.insert(schema.sessions).values({
          id: sessionId,
          threadId: `memory-agent-read-${sessionId}`,
          ownerId: fixture.userId,
          agentId: fixture.agentProductId,
          roomId,
        });
        return db.insert(schema.sessionMessages).values({
          sessionId,
          role: "user",
          content: null,
          humanTurnId: `memory-human-turn-${randomUUID()}`,
        }).returning({ id: schema.sessionMessages.id });
      });
      const planBytes = encodeLiveShadowMessagePlanV4({
        formatVersion: 4,
        purpose: "message.live_shadow_plan",
        operationId,
        policyRevision: 1,
        sessionId,
        roomId,
        humanMessageId: messages[0]!.id,
        revision: 0,
        createdAt: unixTimestamp(NOW),
        subjectHumanId: humanId(fixture.humanCryptoId),
        committerDeviceId: cryptoDeviceId(fixture.managerDeviceId),
        committerDeviceSigningKeyGeneration: 1,
        hostAuthorizationRevision:
          authorizationRevision(fixture.managerAuthorizationRevision),
        recipientAgentId: agentId(fixture.agentProductId),
        agentAuthorizationRevision:
          authorizationRevision(fixture.runtimeAuthorizationRevision),
        agentRuntimeGeneration:
          agentRuntimeGeneration(fixture.agentRuntimeGeneration),
        agentSignerKeyId: fixture.agentSignerKeyId,
        agentSignerPublicKey: fixture.agentSignerPublicKey,
        namespaceId: namespaceId(fixture.namespaceIds[0]),
        namespaceAccessRevision: accessRevision(0),
        namespaceKeyGeneration: namespaceGeneration(0),
        namespaceHeadDigest,
        namespacePublicationDigest,
        namespacePublicationSetDigest,
        namespaceAudienceFingerprint,
        grantDomainId: fixture.domainIds[0],
        grantDomainParticipantDigest,
        grantDomainKeyGeneration: 1,
        grantDomainHeadDigest,
        grantDomainPublicationDigest,
        grantDomainAuthorizationRevision: authorizationRevision(1),
        namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(1),
        namespaceBundleRevision: 1,
        namespaceBundleDigest,
        authorization: {
          disposition: "authorization_reusable",
          sessionReference: `memory-session-${randomUUID()}`,
          authorizationDigest: acceptedDigest,
        },
        attemptCoordinate,
        issuedAt: unixTimestamp(NOW),
        deadlineAt: unixTimestamp(NOW + 30_000),
      });
      const planDigest = fixture.crypto.hash(planBytes);
      await fixtureDb.transaction(async (db) => {
        await db.insert(schema.conversationShadowTurnOperations).values({
          operationId,
          clientIdempotencyKey: `memory-client-${randomUUID()}`,
          policyRevision: 1,
          sessionId,
          roomId,
          humanMessageId: messages[0]!.id,
          humanMessageCreatedAt: new Date(NOW),
          subjectHumanId: fixture.humanCryptoId,
          committerDeviceId: fixture.managerDeviceId,
          committerDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: fixture.managerAuthorizationRevision,
          agentId: fixture.agentProductId,
          agentAuthorizationRevision: fixture.runtimeAuthorizationRevision,
          namespaceId: fixture.namespaceIds[0],
          namespaceAccessRevision: 0,
          namespaceKeyGeneration: 0,
          namespaceHeadDigest,
          namespacePublicationDigest,
          namespacePublicationSetDigest,
          namespaceAudienceFingerprint,
          grantDomainId: fixture.domainIds[0],
          grantDomainParticipantDigest,
          grantDomainKeyGeneration: 1,
          grantDomainHeadDigest,
          grantDomainPublicationDigest,
          grantDomainAuthorizationRevision: 1,
          namespaceBundleRevision: 1,
          namespaceBundleDigest,
          agentGrantPlanBytes,
          agentGrantPlanDigest,
          recipientId: fixture.agentProductId,
          recipientKeyId,
          recipientPublicKey,
          attemptCoordinate,
          planDigest,
          planBytes,
          humanRequestDigest,
          humanRequestBytes,
          grantDigest: acceptedDigest,
          state: "running",
          deadlineAt: new Date(NOW + 30_000),
        });
        await db.insert(schema.conversationShadowTurnAgentSigners).values({
          operationId,
          agentRuntimeGeneration: fixture.agentRuntimeGeneration,
          agentSignerKeyId: fixture.agentSignerKeyId,
          agentSignerPublicKey: fixture.agentSignerPublicKey,
        });
      });
      const signerHistory = new PostgresHumanDeviceSignerHistory({
        handle: cryptoHandle, crypto: fixture.crypto,
      });
      const humanAuthority = new PostgresHumanMemoryAuthorityResolver({
        handle: cryptoHandle,
      });
      const completion = createPostgresHumanMemoryCryptoCompletion({
        handle: cryptoHandle,
        crypto: fixture.crypto,
        resolveCurrentWriteAuthorization:
          humanAuthority.resolveCurrentWriteAuthorization,
        resolveStoredSignerAuthority: humanAuthority.resolveStoredSignerAuthority,
        resolveHistoricalAgentSignerAuthority:
          signerHistory.resolveAgentRuntimeSignerManager,
        resolveForegroundAgentAcceptedExecutionEvidence:
          createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
            product: productHandle, crypto: fixture.crypto,
          }),
      });
      const opened = await completion.read(fixture.reference);
      expect(opened).toMatchObject({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        objectId: fixture.objectId,
      });
      expect(opened?.accessSignerEvidence.some((entry) =>
        entry.kind === "foreground_agent_accepted_execution"
      )).toBe(true);
      opened?.payloadBytes.fill(0);
      opened?.accessManifestBytes.fill(0);
      opened?.accessManifestProofBytes.forEach((bytes) => bytes.fill(0));
      opened?.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
      let tamperError: unknown;
      try {
        await fixtureDb.update(schema.conversationShadowTurnOperations)
          .set({ planDigest: digest(0xff) })
          .where(eq(schema.conversationShadowTurnOperations.operationId, operationId));
      } catch (error) { tamperError = error; }
      expect(tamperError).toMatchObject({ cause: {
        code: "23514", message: "conversation Shadow turn identity is immutable",
      } });
      const unchanged = await fixtureDb.select({
        planDigest: schema.conversationShadowTurnOperations.planDigest,
      }).from(schema.conversationShadowTurnOperations)
        .where(eq(schema.conversationShadowTurnOperations.operationId, operationId));
      expect(unchanged[0]?.planDigest).toEqual(planDigest);
    } finally {
      await agentCrypto.client.end();
      await productClient.end();
      await cryptoClient.end();
    }
  });

  test("alternates Agent 0 -> Human 1 -> Agent 2 with restart reconciliation under real roles", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const productStore = await openProductStore();
    const initialCrypto = await openCryptoCompletion(fixture);
    try {
      expect(await initialCrypto.completion.complete(fixture.prepared))
        .toBe("created");
      expect(await productStore.store.markCryptoComplete({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        leaseToken: null,
      })).toBe("applied");
      expect(await productStore.store.compareAndSwapCryptoMapping({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint:
          fixture.requiredNamespaceFingerprint,
        leaseToken: null,
      })).toBe("applied");

      const sourceNamespaceId = fixture.namespaceIds[0];
      const sourceBinding = fixture.namespaceBindingFacts.find((entry) =>
        entry.namespaceId === sourceNamespaceId
      )!;
      const sourceDomain = fixture.domainFacts.find((entry) =>
        entry.domainId === sourceBinding.domainId
      )!;
      const actorRows = await admin.unsafe<{
        human_actor_id: string;
        agent_actor_id: string;
      }[]>(
        `SELECT
           max(id::text) FILTER (WHERE kind = 'user') AS human_actor_id,
           max(id::text) FILTER (WHERE kind = 'agent') AS agent_actor_id
         FROM actors WHERE owner_id = $1`,
        [fixture.userId],
      );
      const actors = actorRows[0]!;

      // The object starts at Agent Runtime revision 0. A Human device then
      // removes one audience under the ordinary/restricted product split, so
      // the following Agent grant must append revision 2 to a Human-signed
      // current head rather than to its own genesis.
      const humanKeyCrypto = new LatticeCrypto(seededRng(
        Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16),
      ), { now: () => NOW });
      const humanSigner = humanKeyCrypto.generateSigningKeyPair();
      const humanEncryption = await humanKeyCrypto.generateEncryptionKeyPair();
      const humanDeviceValue = `memory-human-device-${randomUUID()}`;
      const createdAt = new Date(NOW).toISOString();
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO human_crypto_custodies (
             human_id, user_id, human_actor_id,
             initial_installation_lineage_digest, state, ever_initialized_at,
             first_device_id, current_recovery_generation,
             current_recovery_public_key_digest, revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
          [fixture.humanCryptoId, fixture.userId, actors.human_actor_id,
            digest(0xd1), createdAt, humanDeviceValue, digest(0xd2)],
        );
        await transaction.unsafe(
          `INSERT INTO human_crypto_devices (
             device_id, human_id, user_id, human_actor_id, client_kind,
             installation_lineage_digest, device_generation,
             signing_public_key, encryption_public_key, public_fingerprint,
             state, authorization_kind, recovery_generation,
             authorization_evidence_digest, key_package_generation,
             key_package_count, revision, created_at, activated_at
           ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
             'active', 'first_bootstrap', 1, $9, 1, 0, 7, $10, $10)`,
          [humanDeviceValue, fixture.humanCryptoId, fixture.userId,
            actors.human_actor_id, digest(0xd3), humanSigner.publicKey,
            humanEncryption.publicKey, fixture.crypto.hash(humanSigner.publicKey),
            digest(0xd4), createdAt],
        );
      });
      const genesisSnapshot = readPreparedMemoryCryptoRevisionSnapshot(
        fixture.prepared,
      );
      const genesisManifest = decodeObjectAccessManifestV5(
        genesisSnapshot.access.manifestBytes,
      );
      const currentEnvelopeByNamespace = new Map(
        genesisSnapshot.access.envelopeBytes.map((bytes) => [
          decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
          bytes,
        ] as const),
      );
      const canonicalCurrentEnvelopeBytes = fixture.namespaceIds.map(
        (namespaceValue) => {
          const bytes = currentEnvelopeByNamespace.get(
            namespaceId(namespaceValue),
          );
          if (bytes === undefined) {
            throw new Error("Agent genesis Namespace envelope is absent");
          }
          return bytes;
        },
      );
      const sourceEnvelope = currentEnvelopeByNamespace.get(
        namespaceId(sourceNamespaceId),
      );
      if (sourceEnvelope === undefined) {
        throw new Error("Agent genesis source envelope is absent");
      }
      const humanOperationId = `human-access-operation-${randomUUID()}`;
      const humanPrepared = prepareHumanObjectAccessManifestUpdateSet(
        fixture.crypto,
        {
          operationId: humanOperationId,
          expectedContentRevision: 3,
          subjectHumanId: humanId(fixture.humanCryptoId),
          currentManifestBytes: genesisSnapshot.access.manifestBytes,
          currentEnvelopeBytes: canonicalCurrentEnvelopeBytes,
          targetEnvelopeBytes: [sourceEnvelope],
          trustedMinimumHead: {
            objectId: genesisManifest.objectId,
            payloadHash: genesisManifest.payloadHash,
            accessRevision: genesisManifest.accessRevision,
            manifestHash: fixture.crypto.hash(
              genesisSnapshot.access.manifestBytes,
            ),
          },
          proof: [],
          resolveAgentRuntimeSignerPublicKey: () =>
            fixture.agentSignerPublicKey,
          currentNamespaceBindings: fixture.namespaceBindingFacts,
          targetNamespaceBindings: [sourceBinding],
          sourceAuthorized: true,
          targetAuthorized: true,
          committerDeviceId: cryptoDeviceId(humanDeviceValue),
          hostAuthorizationRevision: authorizationRevision(7),
          committerSigningPublicKey: humanSigner.publicKey,
          committerSigningPrivateKey: humanSigner.privateKey,
        },
      );
      const durableGenesis = await admin.unsafe<{
        payload_hash: Uint8Array;
        manifest_hash: Uint8Array;
      }[]>(
        `SELECT m.payload_hash, m.manifest_hash
           FROM object_crypto_access_heads h
           JOIN object_crypto_access_manifests m
             ON m.object_id = h.object_id
            AND m.access_revision = h.access_revision
          WHERE h.object_id = $1`,
        [fixture.objectId],
      );
      expect(durableGenesis).toHaveLength(1);
      expect([...durableGenesis[0]!.payload_hash]).toEqual([
        ...genesisManifest.payloadHash,
      ]);
      expect([...humanPrepared.authority.payloadHash]).toEqual([
        ...genesisManifest.payloadHash,
      ]);
      expect([...durableGenesis[0]!.manifest_hash]).toEqual([
        ...humanPrepared.authority.currentManifestHash,
      ]);
      const signedEntries = (
        bindings: typeof fixture.namespaceBindingFacts,
        envelopes: typeof humanPrepared.authority.currentEnvelopes,
      ) => bindings.map((binding, index) => Object.freeze({
        namespaceId: namespaceId(binding.namespaceId),
        keyGeneration: envelopes[index]!.keyGeneration,
        namespaceAccessRevision: envelopes[index]!.bindingRevisionAtWrap,
        headDigest: binding.bindingHash,
        publicationDigest: binding.bindingHash,
        publicationSetDigest: binding.bindingHash,
        audienceFingerprint: binding.bindingHash,
        envelopeHash: envelopes[index]!.envelopeHash,
      }));
      const authorityEntries = (entries: ReturnType<typeof signedEntries>) =>
        entries.map(({ envelopeHash: _envelopeHash, ...entry }) => entry);
      const currentEntries = signedEntries(
        fixture.namespaceBindingFacts, humanPrepared.authority.currentEnvelopes,
      );
      const targetEntries = signedEntries(
        [sourceBinding], humanPrepared.authority.targetEnvelopes,
      );
      const humanSigned = prepareHumanMemoryExactAccessRequest(
        fixture.crypto,
        {
          subjectHumanId: humanId(fixture.humanCryptoId),
          operationId: humanOperationId,
          memoryId: fixture.memoryId,
          cryptoObjectId: objectId(fixture.objectId),
          payloadHash: humanPrepared.authority.payloadHash,
          expectedContentRevision: 3,
          expectedAccessRevision: 0,
          nextAccessRevision: 1,
          currentManifestHash: humanPrepared.authority.currentManifestHash,
          nextManifestHash: humanPrepared.authority.nextManifestHash,
          currentEntries, targetEntries,
          currentAuthorityEntries: authorityEntries(currentEntries),
          targetAuthorityEntries: authorityEntries(targetEntries),
          issuedAt: unixTimestamp(NOW),
          deadlineAt: unixTimestamp(NOW + 30_000),
          committerDeviceId: cryptoDeviceId(humanDeviceValue),
          hostAuthorizationRevision: authorizationRevision(7),
          committerSigningPublicKey: humanSigner.publicKey,
          committerSigningPrivateKey: humanSigner.privateKey,
        },
      );
      expect([...humanSigned.request.payloadHash]).toEqual([
        ...genesisManifest.payloadHash,
      ]);
      expect([...humanPrepared.authority.payloadHash]).toEqual([
        ...genesisManifest.payloadHash,
      ]);
      const humanAuthority = Object.freeze({
        userId: fixture.userId,
        subjectHumanId: fixture.humanCryptoId,
        actorId: actors.human_actor_id,
        agentId: null,
        readableNamespaceIds: [...fixture.namespaceIds],
        mutableNamespaceIds: [...fixture.namespaceIds],
        writableNamespaceIds: [sourceNamespaceId],
      });
      const humanProductClient = sqlClient(appUrl);
      const humanCryptoClient = sqlClient(cryptoUrl);
      try {
        const humanProductHandle = await verifyConversationProductPostgresHandle(
          humanProductConnection(humanProductClient, fixture.userId),
        );
        const humanProduct = new PostgresHumanMemoryExactAccessProduct(
          humanProductHandle,
          {
            canonicalRunner: bindConversationProductCanonicalTransactionRunner(
              humanProductHandle,
              humanCanonicalConnection(humanProductClient, fixture.userId),
            ),
            publication: { fence: async () => {}, allowOrdinaryFallback: false,
              withLocks: async (_input, publish) => publish(async () => {}) },
          },
        );
        const humanPlan = await humanProduct.plan({
          authority: humanAuthority,
          operationId: humanOperationId,
          memoryId: fixture.memoryId,
          target: {
            kind: "replace_exact",
            namespaceIds: [sourceNamespaceId],
          },
        });
        if (humanPlan.status !== "prepared") {
          throw new Error("Human alternating access plan was unavailable");
        }
        authenticateHumanMemoryExactAccessPrepared({
          crypto: fixture.crypto,
          plan: humanPlan,
          signedRequestBytes: humanSigned.bytes,
          manifestBytes: humanPrepared.manifestBytes,
          envelopeBytes: humanPrepared.envelopeBytes,
          now: NOW + 1,
          resolveCurrentAuthority: () => humanSigner.publicKey,
        });
        expect([...humanSigned.request.payloadHash]).toEqual([
          ...genesisManifest.payloadHash,
        ]);
        expect([...humanPrepared.authority.payloadHash]).toEqual([
          ...genesisManifest.payloadHash,
        ]);
        expect(await humanProduct.reserve({
          authority: humanAuthority,
          plan: humanPlan,
          signedRequestDigest: fixture.crypto.hash(humanSigned.bytes),
        })).toBe("reserved");
        const replay = await humanProduct.lookupReplay({
          authority: humanAuthority,
          operationId: humanOperationId,
          memoryId: fixture.memoryId,
          subjectHumanId: fixture.humanCryptoId,
          signedRequestDigest: fixture.crypto.hash(humanSigned.bytes),
        });
        if (replay.status !== "pending") {
          throw new Error("Human exact-access reservation was not replayable");
        }
        const authenticated = authenticateHumanMemoryExactAccessPrepared({
          crypto: fixture.crypto,
          plan: humanPlan,
          signedRequestBytes: humanSigned.bytes,
          manifestBytes: humanPrepared.manifestBytes,
          envelopeBytes: humanPrepared.envelopeBytes,
          now: NOW + 60_000,
          resolveCurrentAuthority: () => humanSigner.publicKey,
          replayAdmission: replay.replayAdmission,
        });
        const humanCompletion = new PostgresHumanMemoryExactAccessCryptoCompletion({
          handle: await verifyCryptoPostgresHandle(
            cryptoConnection(humanCryptoClient),
          ),
          crypto: fixture.crypto,
          resolveHistoricalAgentSignerAuthority: (context) => ({
            ...context,
            managerSigningPublicKey:
              fixture.managerSigningPublicKey.slice(),
          }),
        });
        const humanReceipt = await humanCompletion.complete(authenticated);
        expect(await humanProduct.commit({
          authority: humanAuthority,
          plan: humanPlan,
          receipt: humanReceipt,
        })).toMatchObject({
          status: "updated",
          cryptoAccessRevision: 1,
          requiredNamespaceIds: [sourceNamespaceId],
        });
      } finally {
        await humanProductClient.end();
        await humanCryptoClient.end();
        humanSigner.privateKey.fill(0);
        humanEncryption.privateKey.fill(0);
        humanSigned.bytes.fill(0);
      }
      let targetNamespaceId = randomUUID();
      while (fixture.namespaceIds.includes(targetNamespaceId)) {
        targetNamespaceId = randomUUID();
      }
      const targetDomainId = `zz-agent-access-${randomUUID()}`;
      const targetRoot = digest(0xc7);
      const targetSigner = fixture.crypto.generateSigningKeyPair();
      const targetDeviceId = cryptoDeviceId(`agent-access-${randomUUID()}`);
      const targetKeyrings = createInitialNamespaceKeyrings(
        fixture.crypto,
        namespaceId(targetNamespaceId),
      );
      const targetMetadata = {
        domainId: cryptoDomainId(targetDomainId),
        domainEpoch: domainEpoch(9),
        previousBindingHash: null,
        committerDeviceId: targetDeviceId,
      } as const;
      const targetHumanEnvelope = sealNamespaceKeyring({
        crypto: fixture.crypto,
        domainRoot: digest(0xc6),
        keyring: targetKeyrings.human,
        metadata: targetMetadata,
        committerSigningPrivateKey: targetSigner.privateKey,
        resolveCurrentCommitter: () => targetSigner.publicKey,
      });
      const targetAiEnvelope = sealNamespaceKeyring({
        crypto: fixture.crypto,
        domainRoot: targetRoot,
        keyring: targetKeyrings.ai,
        metadata: targetMetadata,
        committerSigningPrivateKey: targetSigner.privateKey,
        resolveCurrentCommitter: () => targetSigner.publicKey,
      });
      const targetBinding = createNamespaceBinding({
        crypto: fixture.crypto,
        humanEnvelope: targetHumanEnvelope,
        aiEnvelope: targetAiEnvelope,
        committerSigningPrivateKey: targetSigner.privateKey,
        resolveCurrentCommitter: () => targetSigner.publicKey,
      });
      const targetBindingHash = namespaceBindingHash(targetBinding);
      const targetBindingBytes = serializeNamespaceBindingV2(targetBinding);
      const targetHumanEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(
        targetHumanEnvelope,
      );
      const targetAiEnvelopeBytes = serializeNamespaceKeyringEnvelopeV2(
        targetAiEnvelope,
      );
      expect(await persistNamespaceBinding({
        crypto: fixture.crypto,
        storage: fixture.runtimeStorage,
        prepared: {
          expectedHead: null,
          nextHead: {
            namespaceId: targetBinding.namespaceId,
            accessRevision: targetBinding.accessRevision,
            bindingHash: targetBindingHash,
            domainId: targetBinding.domainId,
            domainEpoch: targetBinding.domainEpoch,
          },
          signedBindingBytes: targetBindingBytes,
          humanKeyringEnvelopeBytes: targetHumanEnvelopeBytes,
          aiKeyringEnvelopeBytes: targetAiEnvelopeBytes,
        },
        resolveCurrentCommitter: () => targetSigner.publicKey,
      })).toBe("applied");
      const targetBindingFact = Object.freeze({
        namespaceId: targetNamespaceId,
        domainId: targetDomainId,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 33,
        bindingHash: targetBindingHash.slice(),
      });
      const targetRoomId = randomUUID();
      await admin.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO namespaces (id, scope, label)
           VALUES ($1, 'room', 'Agent exact-access target')`,
          [targetNamespaceId],
        );
        await tx.unsafe(
          `INSERT INTO rooms (
             id, owner_id, type, label, graph_thread_id, namespace_id,
             human_actor_ids, kind, created_by
           ) VALUES ($1, $2, 'private', 'Agent exact-access target', $3,
             $4, ARRAY[$5::uuid], 'access', $5)`,
          [targetRoomId, fixture.userId, `agent-access:${targetRoomId}`,
            targetNamespaceId, actors.human_actor_id],
        );
        await tx.unsafe(
          `INSERT INTO room_members (
             room_id, actor_id, room_role, agent_response_mode
           ) VALUES
             ($1, $2, 'admin', NULL),
             ($1, $3, 'member', 'active')`,
          [targetRoomId, actors.human_actor_id, actors.agent_actor_id],
        );
        await tx.unsafe(
          `INSERT INTO crypto_domains (
             id, participant_digest, participants, epoch,
             authorization_revision, roster_bytes
           ) VALUES ($1, $2, ARRAY[$3]::text[], 9, 31, $4)`,
          [targetDomainId, participantDigest([humanId(fixture.humanCryptoId)]),
            fixture.humanCryptoId, new Uint8Array([0xc7])],
        );
        await tx.unsafe(
          `INSERT INTO namespace_crypto_bindings (
             namespace_id, revision, binding_hash, previous_binding_hash,
             signed_binding_bytes, human_keyring_envelope_bytes,
             ai_keyring_envelope_bytes
           ) VALUES ($1, 0, $2, NULL, $3, $4, $5)`,
          [targetNamespaceId, targetBindingHash, targetBindingBytes,
            targetHumanEnvelopeBytes, targetAiEnvelopeBytes],
        );
        await tx.unsafe(
          `INSERT INTO namespace_crypto_heads (
             namespace_id, access_revision, binding_hash, domain_id,
             domain_epoch
           ) VALUES ($1, 0, $2, $3, 9)`,
          [targetNamespaceId, targetBindingHash, targetDomainId],
        );
      });

      const recipientKeyId = `agent-access-recipient-${randomUUID()}`;
      const recipient = await createProtectedInvocationRecipient({
        crypto: fixture.crypto,
        recipientAgentId: agentId(fixture.agentCryptoId),
        recipientKeyId,
      });
      const issuer = fixture.crypto.generateSigningKeyPair();
      const issuingDeviceId = cryptoDeviceId(
        `agent-access-issuer-${randomUUID()}`,
      );
      const exactGrant = await mintGrant(fixture.crypto, {
        id: grantId(`agent-access-grant-${randomUUID()}`),
        issuingDeviceId,
        issuingHumanId: humanId(fixture.humanCryptoId),
        issuingDeviceSigningPrivateKey: issuer.privateKey,
        recipientAgentId: agentId(fixture.agentCryptoId),
        recipientKeyId,
        recipientEncryptionPublicKey: recipient.publicKey,
        scope: [humanId(fixture.humanCryptoId)],
        operations: ["decrypt", "encrypt"],
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
        coveredDomains: [
          {
            domainId: cryptoDomainId(sourceDomain.domainId),
            domainEpoch: domainEpoch(sourceDomain.epoch),
            agentAuthorizationRevision: authorizationRevision(
              sourceDomain.agentAuthorizationRevision,
            ),
            aiRoot: sourceDomain.aiRoot,
          },
          {
            domainId: cryptoDomainId(targetDomainId),
            domainEpoch: domainEpoch(9),
            agentAuthorizationRevision: authorizationRevision(31),
            aiRoot: targetRoot,
          },
        ].sort((left, right) =>
          compareUnsignedUtf8(String(left.domainId), String(right.domainId))
        ),
        singleUse: false,
      });
      const exactGrantBytes = serializeGrantV2(exactGrant);
      await fixture.runtimeStorage.putGrant(grantWriteRecord(exactGrantBytes));
      await admin.unsafe(
        `INSERT INTO crypto_grants (grant_id, grant_bytes, consumed)
         VALUES ($1, $2, FALSE)`,
        [exactGrant.id, exactGrantBytes],
      );
      const namespaceRequirements = [
        {
          namespaceId: namespaceId(sourceNamespaceId),
          domainId: cryptoDomainId(sourceDomain.domainId),
          operations: ["decrypt"] as const,
          namespaceParticipants: [humanId(fixture.humanCryptoId)],
          expectedAccessRevision: accessRevision(0),
          expectedPolicyRevision:
            authorizationRevision(sourceBinding.expectedPolicyRevision),
        },
        {
          namespaceId: namespaceId(targetNamespaceId),
          domainId: cryptoDomainId(targetDomainId),
          operations: ["encrypt"] as const,
          namespaceParticipants: [humanId(fixture.humanCryptoId)],
          expectedAccessRevision: accessRevision(0),
          expectedPolicyRevision: authorizationRevision(33),
        },
      ].sort((left, right) =>
        compareUnsignedUtf8(String(left.namespaceId), String(right.namespaceId))
      );
      const domainRequirements = [
        {
          domainId: cryptoDomainId(sourceDomain.domainId),
          expectedEpoch: domainEpoch(sourceDomain.epoch),
          expectedAgentAuthorizationRevision: authorizationRevision(
            sourceDomain.agentAuthorizationRevision,
          ),
        },
        {
          domainId: cryptoDomainId(targetDomainId),
          expectedEpoch: domainEpoch(9),
          expectedAgentAuthorizationRevision: authorizationRevision(31),
        },
      ].sort((left, right) =>
        compareUnsignedUtf8(String(left.domainId), String(right.domainId))
      );
      const coordinates: ProtectedInvocationCoordinates = Object.freeze({
        invocationId: `agent-access-invocation-${randomUUID()}`,
        grantId: exactGrant.id,
        issuingHumanId: fixture.humanCryptoId,
        recipientAgentId: fixture.agentCryptoId,
        recipientKeyId,
        issuingDeviceId: String(issuingDeviceId),
        namespaceIds: Object.freeze(namespaceRequirements.map((entry) =>
          String(entry.namespaceId)
        )),
        domainIds: Object.freeze(domainRequirements.map((entry) =>
          String(entry.domainId)
        )),
        issuedAt: exactGrant.issuedAt,
        expiresAt: exactGrant.expiresAt,
      });
      const capability = createProtectedInvocationCapability({
        coordinates,
        recipient: recipient.recipient,
      });
      const facts: ProtectedGrantAuthoritySetFactsV2 = Object.freeze({
        now: NOW + 1,
        expectedIssuingDeviceId: String(issuingDeviceId),
        issuingDeviceHumanId: fixture.humanCryptoId,
        issuingDeviceSigningPublicKey: issuer.publicKey,
        issuingDeviceActive: true,
        recipientAgentId: fixture.agentCryptoId,
        recipientKeyId,
        singleUseAvailable: true,
        grantScope: [fixture.humanCryptoId],
        namespaceRequirements,
        domainRequirements,
        hostAllowsOperation: true,
      });
      const grantAuthority: ProtectedGrantAuthoritySetPortV2 = {
        resolvePreflightFacts: () => facts,
        resolveCurrentAuthorization: (context) => ({
          context,
          currentTime: NOW + 2,
          issuingDeviceActive: true,
          recipientAgentAuthorized: true,
          requestedNamespacesAuthorized: true,
          requestedDomainsAuthorized: true,
          hostAllowsOperation: true,
          currentSingleUseStatus: context.singleUseStatus,
        }),
      };
      const allBindings = Object.freeze([
        ...fixture.namespaceBindingFacts,
        targetBindingFact,
      ].sort((left, right) =>
        compareUnsignedUtf8(left.namespaceId, right.namespaceId)
      ));
      const authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }> =
        Object.freeze({
          mode: "namespace" as const,
          subjectUserId: fixture.userId,
          agentId: fixture.agentProductId,
          readableNamespaceIds: Object.freeze([
            ...fixture.namespaceIds,
            targetNamespaceId,
          ].sort()),
          mutableNamespaceIds: Object.freeze([
            ...fixture.namespaceIds,
            targetNamespaceId,
          ].sort()),
          writableNamespaceId: targetNamespaceId,
        });
      const exactProductClient = sqlClient(agentUrl);
      const exactCryptoClient = sqlClient(cryptoUrl);
      try {
        const productHandle = await verifyConversationProductPostgresHandle(
          agentProductConnection(
            exactProductClient,
            fixture.userId,
            fixture.agentProductId,
          ),
        );
        const cryptoHandle = await verifyCryptoPostgresHandle(
          cryptoConnection(exactCryptoClient),
        );
        const exactCrypto = createPostgresAgentMemoryExactAccessCryptoCompletion({
          handle: cryptoHandle,
          crypto: fixture.crypto,
          resolveHistoricalAgentSignerAuthority: (context) => ({
            ...context,
            managerSigningPublicKey: fixture.managerSigningPublicKey.slice(),
          }),
          resolveHistoricalNamespaceCommitter: ({ committerDeviceId }) =>
            committerDeviceId === String(targetDeviceId)
              ? targetSigner.publicKey
              : fixture.managerSigningPublicKey,
          resolvePolicyRevision: (binding) => Promise.resolve(
            allBindings.find((entry) =>
              entry.namespaceId === binding.namespaceId
            )?.expectedPolicyRevision ?? null,
          ),
        });
        let loseResponse = true;
        const product = new PostgresAgentMemoryExactAccessProduct({
          handle: productHandle,
          readableNamespaceIds: [...fixture.namespaceIds, targetNamespaceId],
          crypto: {
            observe: exactCrypto.observe,
            complete: async (prepared) => {
              const receipt = await exactCrypto.complete(prepared);
              if (loseResponse) {
                loseResponse = false;
                throw new Error("simulated response loss after crypto commit");
              }
              return receipt;
            },
          },
          resolveGrantUserNamespace: () => Promise.resolve(targetNamespaceId),
          resolveCryptoAuthority: ({ currentNamespaceIds,
            targetNamespaceIds }) => Promise.resolve({
            currentBindings: allBindings.filter((entry) =>
              currentNamespaceIds.includes(entry.namespaceId)
            ),
            targetBindings: allBindings.filter((entry) =>
              targetNamespaceIds.includes(entry.namespaceId)
            ),
          }),
        });
        const planned = await product.planChange({
          operationId: `agent-access-operation-${randomUUID()}`,
          authority,
          memoryId: fixture.memoryId,
          action: { kind: "grant_user", userHandle: "integration-target" },
        });
        if (
          planned.status !== "success"
          || planned.value.status !== "prepared"
        ) {
          throw new Error(
            `Agent exact-access integration plan unavailable: ${JSON.stringify(planned)}`,
          );
        }
        const plannedValue = planned.value;
        const contentPort = createProtectedAgentMemoryExactAccessContentPort({
          crypto: fixture.crypto,
          storage: fixture.runtimeStorage,
          authority: grantAuthority,
          resolveHistoricalNamespaceCommitter: ({ committerDeviceId }) =>
            committerDeviceId === String(targetDeviceId)
              ? targetSigner.publicKey
              : fixture.managerSigningPublicKey,
          resolveHistoricalRuntimeCommitter: () =>
            fixture.managerSigningPublicKey,
          revisionReader: initialCrypto.completion,
        });
        const prepared = await contentPort.prepare({
          capability,
          entrypointId: "foreground.main",
          agentId: fixture.agentProductId,
          authority,
          requestedNamespaceIds: coordinates.namespaceIds,
          allowedDomainIds: coordinates.domainIds,
          sourceNamespaceId: plannedValue.sourceNamespaceId,
          plan: plannedValue.plan,
        });
        if (
          prepared.status !== "executed"
          || prepared.value.status !== "success"
        ) throw new Error("Agent exact-access integration preparation failed");
        const preparedHandle = prepared.value.value;
        const responseLoss = await contentPort.authorizeCommit({
          capability,
          entrypointId: "foreground.main",
          agentId: fixture.agentProductId,
          authority,
          requestedNamespaceIds: coordinates.namespaceIds,
          allowedDomainIds: coordinates.domainIds,
          sourceNamespaceId: plannedValue.sourceNamespaceId,
          plan: plannedValue.plan,
          prepared: preparedHandle,
          commit: () => product.commitPrepared({
            authority,
            plan: plannedValue.plan,
            prepared: preparedHandle,
          }),
        });
        expect(loseResponse).toBe(false);
        expect(responseLoss).toEqual({
          status: "unavailable",
          reason: "content_invalid",
        });
        const restarted = new PostgresAgentMemoryExactAccessProduct({
          handle: productHandle,
          readableNamespaceIds: [...fixture.namespaceIds, targetNamespaceId],
          crypto: exactCrypto,
          resolveGrantUserNamespace: () => Promise.resolve(targetNamespaceId),
          resolveCryptoAuthority: ({ currentNamespaceIds,
            targetNamespaceIds }) => Promise.resolve({
            currentBindings: allBindings.filter((entry) =>
              currentNamespaceIds.includes(entry.namespaceId)
            ),
            targetBindings: allBindings.filter((entry) =>
              targetNamespaceIds.includes(entry.namespaceId)
            ),
          }),
        });
        expect(await restarted.reconcileAfterProcessLoss({
          authority,
          operationId: plannedValue.plan.operationId,
          memoryId: fixture.memoryId,
        })).toMatchObject({
          status: "completed",
          cryptoAccessRevision: 2,
          requiredNamespaceIds: plannedValue.plan.targetNamespaceIds,
        });
      } finally {
        await exactProductClient.end();
        await exactCryptoClient.end();
      }
    } finally {
      await productStore.client.end();
      await initialCrypto.client.end();
    }
  });

  test("restart-resumes a real-role protected scope close after seed-detach response loss", async () => {
    const fixture = await createFixture({ scopeOrigin: false });
    const productStore = await openProductStore();
    const crypto = await openCryptoCompletion(fixture);
    const productClient = sqlClient(agentUrl);
    try {
      expect(await crypto.completion.complete(fixture.prepared)).toBe("created");
      expect(await productStore.store.markCryptoComplete({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        leaseToken: null,
      })).toBe("applied");
      expect(await productStore.store.compareAndSwapCryptoMapping({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint:
          fixture.requiredNamespaceFingerprint,
        leaseToken: null,
      })).toBe("applied");

      const scopeId = randomUUID();
      const closeOperationId = `scope-close:${randomUUID()}`;
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO agent_scopes (
             id, parent_agent_id, speaker_user_id, name
           ) VALUES ($1, $2, $3, 'restart-safe close')`,
          [scopeId, fixture.agentProductId, fixture.userId],
        );
        await transaction.unsafe(
          `INSERT INTO memory_scopes (memory_id, scope_id, origin)
           VALUES ($1, $2, 'seed')`,
          [fixture.memoryId, scopeId],
        );
      });
      let saga = new PostgresProtectedScopeCloseSaga(
        scopeCloseConnection(admin),
      );
      expect(await saga.begin({
        operationId: closeOperationId,
        scopeId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
        expectedScopeRevision: 0,
      })).toMatchObject({ status: "started", capturedItemCount: 1 });
      expect(await saga.assertOpenForProtectedMutation({
        scopeId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
      })).toEqual({ status: "closing" });

      // Reconstruct both sides after the durable begin to model a worker
      // process restart. Seed detachment is product-only; exact crypto state
      // must remain untouched.
      saga = new PostgresProtectedScopeCloseSaga(scopeCloseConnection(admin));
      const claim = await saga.claim({
        operationId: closeOperationId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
        claimToken: randomUUID(),
        claimOwner: "scope-close-integration-worker",
        now: NOW,
        leaseMs: 60_000,
      });
      if (claim.status !== "claimed") throw new Error("Expected scope claim");
      const productHandle = await verifyConversationProductPostgresHandle(
        agentProductConnection(
          productClient,
          fixture.userId,
          fixture.agentProductId,
        ),
      );
      const product = new PostgresAgentMemoryExactAccessProduct({
        handle: productHandle,
        readableNamespaceIds: fixture.namespaceIds,
        crypto: {
          complete: () => Promise.reject(new Error("seed detach has no crypto")),
          observe: () => Promise.resolve({ status: "absent" }),
        },
        resolveGrantUserNamespace: () => Promise.resolve(null),
        resolveCryptoAuthority: () => Promise.resolve(null),
      });
      const authority: Extract<ProtectedMemoryAuthority, { mode: "namespace" }> =
        Object.freeze({
          mode: "namespace" as const,
          subjectUserId: fixture.userId,
          agentId: fixture.agentProductId,
          readableNamespaceIds: fixture.namespaceIds,
          mutableNamespaceIds: fixture.namespaceIds,
          writableNamespaceId: fixture.namespaceIds[0],
        });
      const transition = {
        closeOperationId,
        authority,
        scopeId,
        memoryId: claim.item.memoryId,
        cryptoObjectId: claim.item.cryptoObjectId,
        expectedContentRevision: claim.item.expectedContentRevision,
        expectedAccessRevision: claim.item.expectedAccessRevision,
        expectedRequiredNamespaceFingerprint:
          claim.item.expectedRequiredNamespaceFingerprint,
      } as const;
      expect(await product.detachScopeSeed(transition)).toMatchObject({
        status: "success",
        value: { status: "detached" },
      });
      const replay = await product.detachScopeSeed(transition);
      if (replay.status !== "success") {
        throw new Error("Expected restart-safe seed replay");
      }
      expect(replay.value.status).toBe("replayed");
      expect(await saga.completeClaim({
        operationId: closeOperationId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
        ordinal: claim.item.ordinal,
        claimToken: claim.claimToken,
        claimOwner: claim.claimOwner,
        now: NOW + 1,
        result: {
          status: "complete",
          productReceiptRef: replay.value.productReceiptRef,
          cryptoReceiptRef: "crypto:not-required",
        },
      })).toBe("applied");
      expect(await saga.finalize({
        operationId: closeOperationId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
        now: NOW + 2,
      })).toBe("complete");
      expect(await saga.finalize({
        operationId: closeOperationId,
        parentAgentId: fixture.agentProductId,
        speakerUserId: fixture.userId,
        now: NOW + 3,
      })).toBe("already_complete");
      expect([...(await admin.unsafe(
        "SELECT 1 FROM agent_scopes WHERE id = $1",
        [scopeId],
      ))]).toEqual([]);
      expect([...(await admin.unsafe<{ id: string }[]>(
        "SELECT id::text AS id FROM memories WHERE id = $1",
        [fixture.memoryId],
      ))]).toEqual([{ id: fixture.memoryId }]);
      expect(await crypto.completion.verify(fixture.reference)).toMatchObject({
        objectId: fixture.objectId,
        requiredNamespaceIds: fixture.namespaceIds,
      });
    } finally {
      await productClient.end();
      await productStore.client.end();
      await crypto.client.end();
    }
  });

  test.each(["openai", "openrouter", "venice"])("executes %s Agent Memory candidate selection for Namespace and scope authority", async (provider) => {
    for (const scopeOrigin of [false, true]) {
      const fixture = await createFixture({ scopeOrigin });
      const product = await openProductStore();
      const crypto = await openCryptoCompletion(fixture);
      try {
        expect(await crypto.completion.complete(fixture.prepared)).toBe("created");
        expect(await product.store.markCryptoComplete({ memoryId: fixture.memoryId,
          contentRevision: 3, cryptoObjectId: fixture.objectId,
          leaseToken: null })).toBe("applied");
        expect(await product.store.compareAndSwapCryptoMapping({
          memoryId: fixture.memoryId, contentRevision: 3,
          cryptoObjectId: fixture.objectId,
          expectedRequiredNamespaceFingerprint: fixture.requiredNamespaceFingerprint,
          leaseToken: null })).toBe("applied");
        await admin.unsafe(
          `UPDATE memories SET embedding = $2::vector,
             embedding_revision = content_revision,
             embedding_provider = $3,
             embedding_model = 'text-embedding-3-small',
             embedding_dimensions = 1536,
             embedding_contract_version = 1
           WHERE id = $1`,
          [fixture.memoryId, `[${new Array<number>(1536).fill(0.25).join(",")}]`, provider],
        );
        const agent = await openAgentProductPort(fixture, crypto.completion);
        try {
          const authority = scopeOrigin ? Object.freeze({ mode: "scope" as const,
            subjectUserId: fixture.userId, agentId: fixture.agentProductId,
            scopeId: fixture.scopeIds[0]!,
            originWritableNamespaceId: fixture.namespaceIds[0] })
            : Object.freeze({ mode: "namespace" as const,
              subjectUserId: fixture.userId, agentId: fixture.agentProductId,
              readableNamespaceIds: fixture.namespaceIds,
              mutableNamespaceIds: fixture.namespaceIds,
              writableNamespaceId: fixture.namespaceIds[0] });
          const embedding = Object.freeze({
            vector: Object.freeze(new Array<number>(1536).fill(0.25)),
            provider, canonicalModel: "text-embedding-3-small",
            dimensions: 1536 as const, contractVersion: 1,
          });
          const searched = await agent.port.searchCandidates({ authority,
            embedding, limit: 4, includeArchive: false });
          expect(searched.status).toBe("success");
          if (searched.status !== "success") {
            throw new Error(`Candidate search failed: ${searched.reason}`);
          }
          expect(searched.value.map(({ memoryId }) => memoryId))
            .toContain(fixture.memoryId);
          const selected = await agent.port.selectSaveCandidate({ authority,
            embedding });
          expect(selected.status).toBe("success");
          if (selected.status !== "success") {
            throw new Error(`Candidate selection failed: ${selected.reason}`);
          }
          if (scopeOrigin) {
            // This fixture deliberately carries sibling Namespace attachments.
            // Scope mutation authority is confined to its singular origin set,
            // so it may read the row but must not select it for replacement.
            expect(selected.value).toBeNull();
          } else {
            expect(selected.value).toMatchObject({ memoryId: fixture.memoryId,
              contentRevision: 3 });
          }
        } finally { await agent.client.end(); }
      } finally {
        await product.client.end();
        await crypto.client.end();
      }
    }
  });

  test("publishes an Agent-created Memory only after attaching its exact Namespace audience", async () => {
    const fixture = await createFixture({ scopeOrigin: false, seedProduct: false });
    const crypto = await openCryptoCompletion(fixture);
    const agent = await openAgentProductPort(
      fixture,
      crypto.completion,
      () => fixture.memoryId,
    );
    try {
      expect(await crypto.completion.complete(fixture.createPrepared)).toBe("created");
      const authority = Object.freeze({
        mode: "namespace" as const,
        subjectUserId: fixture.userId,
        agentId: fixture.agentProductId,
        readableNamespaceIds: fixture.namespaceIds,
        mutableNamespaceIds: fixture.namespaceIds,
        writableNamespaceId: fixture.namespaceIds[0],
      });
      const embedding = Object.freeze({
        vector: Object.freeze(new Array<number>(1536).fill(0.25)),
        provider: "openai",
        canonicalModel: "text-embedding-3-small",
        dimensions: 1536 as const,
        contractVersion: 1,
      });
      const planned = await agent.port.planSave({
        operationId: `memory-create-${randomUUID()}`,
        authority,
        embedding,
        selectedCandidate: null,
        mutationCommitment: new Uint8Array(32).fill(0x12),
        importance: 0.65,
      });
      expect(planned.status).toBe("success");
      if (planned.status !== "success") {
        throw new Error(`Agent Memory create planning failed: ${planned.reason}`);
      }
      expect(planned.value.memoryId).toBe(fixture.memoryId);
      expect(planned.value.cryptoObjectId).toBe(fixture.createPrepared.objectId);
      expect(await agent.port.publishPrepared({
        authority,
        plan: planned.value,
        prepared: fixture.createPrepared,
        embedding,
      })).toBe("published");
      const rows = await drizzle(admin).select({
        cryptoMappingState: memories.cryptoMappingState,
        cryptoObjectId: memories.cryptoObjectId,
      }).from(memories).where(eq(memories.id, fixture.memoryId));
      expect(rows).toEqual([{
        cryptoMappingState: "verified",
        cryptoObjectId: fixture.createPrepared.objectId,
      }]);
      const attachments = await drizzle(admin).select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(
        eq(memoryNamespaces.memoryId, fixture.memoryId),
      ).orderBy(memoryNamespaces.namespaceId);
      expect(attachments.map(({ namespaceId }) => namespaceId))
        .toEqual([...planned.value.requiredNamespaceIds]);
    } finally {
      await agent.client.end();
      await crypto.client.end();
    }
  });

  test("includes the singular retained scope-origin Namespace in the exact durable set", async () => {
    const fixture = await createFixture({ scopeOrigin: true });
    const product = await openProductStore();
    const crypto = await openCryptoCompletion(fixture);
    try {
      const initial = await product.store.getRevision({
        memoryId: fixture.memoryId,
        contentRevision: 3,
      });
      expect(initial?.requiredNamespaceIds).toEqual(fixture.namespaceIds);
      expect(await crypto.completion.complete(fixture.prepared)).toBe("created");
      expect(await product.store.markCryptoComplete({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        leaseToken: null,
      })).toBe("applied");
      expect(await product.store.compareAndSwapCryptoMapping({
        memoryId: fixture.memoryId,
        contentRevision: 3,
        cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint:
          fixture.requiredNamespaceFingerprint,
        leaseToken: null,
      })).toBe("applied");
      const durable = await crypto.completion.read(fixture.reference);
      expect(durable?.requiredNamespaceIds).toEqual(fixture.namespaceIds);
      expect(
        durable?.namespaceEnvelopes
          .map(({ namespaceId }) => namespaceId)
          .sort(),
      ).toEqual([...fixture.namespaceIds]);
      await assertMemoryRepresentationAndCryptoOpaque(fixture);
    } finally {
      await product.client.end();
      await crypto.client.end();
    }
  });

  test("terminalizes exact Human access fallback atomically without advancing the crypto head", async () => {
    const fixture = await createHumanDeletionFixture("ordinary_and_protected");
    const operationId = `human-memory:access-fallback:${randomUUID()}`;
    const authority = Object.freeze({ userId: fixture.userId,
      subjectHumanId: fixture.humanValue, actorId: fixture.actorId, agentId: null,
      readableNamespaceIds: [fixture.namespaceValue],
      mutableNamespaceIds: [fixture.namespaceValue],
      writableNamespaceIds: [fixture.namespaceValue] });
    const client = sqlClient(appUrl);
    try {
      const handle = await verifyConversationProductPostgresHandle(
        humanProductConnection(client, fixture.userId));
      const product = new PostgresHumanMemoryExactAccessProduct(handle, {
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          handle, humanCanonicalConnection(client, fixture.userId)),
        publication: { fence: async () => {}, allowOrdinaryFallback: true,
          withLocks: async (_input, publish) => publish(async () => {}) },
      });
      const plan = await product.plan({ authority, operationId,
        memoryId: fixture.memoryId, target: { kind: "delete_authorized_view" } });
      if (plan.status !== "prepared") throw new Error("fallback plan unavailable");
      const requestDigest = fixture.crypto.hash(new TextEncoder().encode(operationId));
      await product.reserve({ authority, plan, signedRequestDigest: requestDigest });
      const preparedAuthority = Object.freeze({
        purpose: "persist-human-memory-native-access-update" as const,
        operationId, objectId: plan.cryptoObjectId,
        payloadHash: new Uint8Array(32),
        expectedContentRevision: plan.expectedContentRevision,
        currentAccessRevision: plan.expectedCryptoAccessRevision,
        currentManifestHash: new Uint8Array(32),
        nextAccessRevision: plan.nextCryptoAccessRevision,
        nextManifestHash: new Uint8Array(32), currentEntries: [], targetEntries: [],
        currentAuthorityEntries: [], targetAuthorityEntries: [],
        subjectHumanId: fixture.humanValue, committerDeviceId: fixture.deviceValue,
        hostAuthorizationRevision: 1,
      });
      expect(await product.commitOrdinaryFallback({ authority, plan,
        preparedAuthority, signedRequestDigest: requestDigest,
        reason: "target_encryption_not_ready" })).toEqual({
        status: "ordinary_fallback", operationId, memoryId: fixture.memoryId,
        cryptoAccessRevision: plan.expectedCryptoAccessRevision,
        requiredNamespaceIds: [], reason: "target_encryption_not_ready",
      });
      const receipts = await admin.unsafe<Array<{ completion: string;
        ordinary_fallback_reason: string; expected_access_revision: number;
        result_access_revision: number }>>(
        `SELECT completion, ordinary_fallback_reason, expected_access_revision,
                result_access_revision
           FROM memory_crypto_operations WHERE operation_id = $1`, [operationId]);
      expect([...receipts]).toEqual([{ completion: "ordinary_fallback",
        ordinary_fallback_reason: "target_encryption_not_ready",
        expected_access_revision: plan.expectedCryptoAccessRevision,
        result_access_revision: plan.nextCryptoAccessRevision }]);
      expect(await admin.unsafe(`SELECT id FROM memories WHERE id = $1`,
        [fixture.memoryId])).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  test("persists protected Human tier metadata across archive replay, restore, demote, and promote", async () => {
    const fixture = await createHumanDeletionFixture("protected_only");
    const client = sqlClient(appUrl);
    const cryptoClient = sqlClient(cryptoUrl);
    try {
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(cryptoClient),
      );
      const cryptoCompletion = createPostgresHumanMemoryCryptoCompletion({
        handle: cryptoHandle,
        crypto: fixture.crypto,
        resolveCurrentWriteAuthorization: async (context) => ({
          ...context,
          sourceAuthorized: true,
          targetAuthorized: true,
          currentHostAuthorizationRevision: context.hostAuthorizationRevision,
          committerSigningPublicKey: fixture.signingPublicKey.slice(),
        }),
        resolveStoredSignerAuthority: async (context) => ({
          ...context,
          humanId: fixture.humanValue,
          committerSigningPublicKey: fixture.signingPublicKey.slice(),
        }),
      });
      const handle = await verifyConversationProductPostgresHandle(
        humanProductConnection(client, fixture.userId),
      );
      const product = createPostgresHumanMemoryProtectedProductRoutePort({
        handle,
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          handle,
          humanCanonicalConnection(client, fixture.userId),
        ),
        publication: {
          representation: "protected_only",
          allowOrdinaryFallback: false,
          policyRevision: 1,
          fence: async () => {},
        },
        cryptoCompletion,
        resolveHumanId: async (userId) =>
          userId === fixture.userId ? fixture.humanValue : null,
        resolveNamespaceAuthority: async ({ namespaceId }) => ({
          sourceRoomId: fixture.actorId,
          namespaceId,
          currentGeneration: 0,
          retainedGenerations: [{ generation: 0, accessRevision: 0,
            headDigestBase64url: "AQ", publicationDigestBase64url: "Ag",
            publicationSetDigestBase64url: "Aw",
            audienceFingerprintBase64url: "BA" }],
        }),
      });
      const authority = Object.freeze({
        userId: fixture.userId,
        actorId: fixture.actorId,
        agentId: null,
        memoryMode: "namespace" as const,
        readableNamespaceIds: [fixture.namespaceValue],
        mutableNamespaceIds: [fixture.namespaceValue],
        writableNamespaceIds: [fixture.namespaceValue],
        scopeId: null,
        originWritableNamespaceId: null,
        sourceRoomId: fixture.actorId,
      });
      const transition = (
        action: "archive" | "restore" | "demote" | "promote",
        expectedTier: 1 | 2 | 3,
        nextTier: 1 | 2 | 3,
        operationId: string,
      ) => product.transitionTier({
        authority,
        subjectHumanId: fixture.humanValue,
        operationId,
        memoryId: fixture.memoryId,
        action,
        expectedContentRevision: 1,
        expectedCryptoAccessRevision: 0,
        expectedTier,
        nextTier,
      });
      const metadata = async () => {
        const rows = await drizzle(admin).select({
          tier: memories.tier,
          demoted_from: memories.demotedFrom,
          demoted_at: memories.demotedAt,
          promoted_at: memories.promotedAt,
        }).from(memories).where(eq(memories.id, fixture.memoryId));
        expect(rows).toHaveLength(1);
        return rows[0]!;
      };

      const archiveOperationId = `human-memory:archive:${randomUUID()}`;
      expect(await transition("archive", 1, 3, archiveOperationId))
        .toMatchObject({ operation: "archive", response: {
          status: "archived", previousTier: 1, nextTier: 3,
        } });
      const archived = await metadata();
      expect(archived).toMatchObject({
        tier: 3,
        demoted_from: 1,
        promoted_at: null,
      });
      expect(archived.demoted_at).toBeInstanceOf(Date);

      expect(await transition("archive", 1, 3, archiveOperationId))
        .toMatchObject({ operation: "archive", response: {
          status: "replayed", previousTier: 1, nextTier: 3,
        } });
      expect(await metadata()).toEqual(archived);

      const restoreOperationId = `human-memory:restore:${randomUUID()}`;
      expect(await transition(
        "restore", 3, 1, restoreOperationId,
      )).toMatchObject({ operation: "restore", response: {
        status: "restored", previousTier: 3, nextTier: 1,
      } });
      const restored = await metadata();
      expect(restored).toMatchObject({
        tier: 1,
        demoted_from: null,
        demoted_at: null,
      });
      expect(restored.promoted_at).toBeInstanceOf(Date);

      const demoteOperationId = `human-memory:demote:${randomUUID()}`;
      expect(await transition(
        "demote", 1, 2, demoteOperationId,
      )).toMatchObject({ operation: "tier_transition", response: {
        status: "demoted", previousTier: 1, nextTier: 2,
      } });
      const demoted = await metadata();
      expect(demoted).toMatchObject({ tier: 2, demoted_from: 1 });
      expect(demoted.demoted_at).toBeInstanceOf(Date);
      expect(demoted.promoted_at).toEqual(restored.promoted_at);

      const promoteOperationId = `human-memory:promote:${randomUUID()}`;
      expect(await transition(
        "promote", 2, 1, promoteOperationId,
      )).toMatchObject({ operation: "tier_transition", response: {
        status: "promoted", previousTier: 2, nextTier: 1,
      } });
      const promoted = await metadata();
      expect(promoted).toMatchObject({
        tier: 1,
        demoted_from: null,
        demoted_at: null,
      });
      expect(promoted.promoted_at).toBeInstanceOf(Date);
      const receipts = await drizzle(admin).select({
        operation_id: memoryCryptoOperations.operationId,
        operation_type: memoryCryptoOperations.operationType,
        completion: memoryCryptoOperations.completion,
        disposition: memoryCryptoOperations.disposition,
        semantic_change_kind: memoryCryptoOperations.semanticChangeKind,
      }).from(memoryCryptoOperations).where(inArray(
        memoryCryptoOperations.operationId,
        [archiveOperationId, restoreOperationId, demoteOperationId, promoteOperationId],
      )).orderBy(memoryCryptoOperations.operationId);
      expect([...receipts]).toEqual([
        { operationId: archiveOperationId, semanticChangeKind: "archive" as const },
        { operationId: demoteOperationId, semanticChangeKind: "demote" as const },
        { operationId: promoteOperationId, semanticChangeKind: "restore" as const },
        { operationId: restoreOperationId, semanticChangeKind: "restore" as const },
      ].sort((left, right) => left.operationId.localeCompare(right.operationId))
        .map(({ operationId, semanticChangeKind }) => ({
          operation_id: operationId,
          operation_type: "metadata",
          completion: "complete",
          disposition: "complete",
          semantic_change_kind: semanticChangeKind,
        }),
      ));
    } finally {
      await client.end();
      await cryptoClient.end();
      fixture.objectDek.fill(0);
      fixture.envelopeBytes.fill(0);
      fixture.signedEmbeddingRequest.bytes.fill(0);
    }
  });

  test("publishes and replays early ordinary Human create/update with truthful terminal receipts and no crypto allocation", async () => {
    const fixture = await createHumanDeletionFixture("ordinary_and_protected");
    const operationId = `human-memory:ordinary-update:${randomUUID()}`;
    const requestDigest = fixture.crypto.hash(new TextEncoder().encode(operationId));
    const authority = Object.freeze({ userId: fixture.userId,
      mutableNamespaceIds: [fixture.namespaceValue],
      writableNamespaceIds: [] as string[] });
    const client = sqlClient(appUrl);
    try {
      const handle = await verifyConversationProductPostgresHandle(
        humanProductConnection(client, fixture.userId));
      const product = new PostgresHumanMemoryProductUpdate(handle, {
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          handle, humanCanonicalConnection(client, fixture.userId)),
        publication: { representation: "ordinary_and_protected",
          allowOrdinaryFallback: true, policyRevision: 1,
          fence: async () => {},
          withLocks: async (_input, publish) => publish(async () => {}),
          withOrdinaryLocks: async (_input, publish) => publish(async () => {}) },
      });
      const authenticated = Object.freeze({ requestDigest,
        request: Object.freeze({ formatVersion: 1 as const,
          purpose: "memory.ordinary_fallback.update" as const,
          reason: "target_encryption_not_ready" as const,
          operationId, memoryId: fixture.memoryId,
          expectedContentRevision: 1, nextContentRevision: 2,
          expectedCryptoAccessRevision: 0,
          requiredNamespaceIds: [fixture.namespaceValue], type: "preference",
          content: "early ordinary update", requestedProvider: "openai" as const,
          requestedModel: "text-embedding-3-small", dimensions: 1536 as const,
          processorContractVersion: 1 as const, policyRevision: 1,
          subjectHumanId: fixture.humanValue,
          committerDeviceId: fixture.deviceValue,
          committerDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 1, planIssuedAt: null,
          planDeadlineAt: null, issuedAt: NOW, deadlineAt: NOW + 30_000,
          signature: new Uint8Array(64) }) });
      expect(() => product.admitOrdinaryFallback({
        authority: { ...authority, mutableNamespaceIds: [] }, authenticated,
      })).toThrow("fallback authority is incomplete");
      const admission = await product.admitOrdinaryFallback({ authority,
        authenticated });
      const projection = await product.publishOrdinaryFallbackIntent({
        authority, admission, embedding: { provider: "openai",
          canonicalModel: "text-embedding-3-small", dimensions: 1536,
          vector: new Array<number>(1536).fill(0.25),
          processorContractVersion: 1 },
      });
      expect(projection).toMatchObject({ memoryId: fixture.memoryId,
        contentRevision: 2, cryptoAccessRevision: 0 });
      expect((await product.lookupOrdinaryFallback({ authority, operationId,
        memoryId: fixture.memoryId, requestDigest }))?.completed?.projection)
        .toEqual(projection);
      const receiptDb = drizzle(admin, { schema });
      const receiptTable = schema.memoryCryptoOperations;
      const [receipt] = await receiptDb.select({
        completion: receiptTable.completion,
        disposition: receiptTable.disposition,
        cryptoCompletedAt: receiptTable.cryptoCompletedAt,
        ordinaryFallbackCompletedAt: receiptTable.ordinaryFallbackCompletedAt,
        ordinaryFallbackReason: receiptTable.ordinaryFallbackReason,
        humanProductOutcome: receiptTable.humanProductOutcome,
      }).from(receiptTable).where(eq(receiptTable.operationId, operationId));
      expect(receipt).toMatchObject({
        completion: "ordinary_fallback", disposition: "complete",
        cryptoCompletedAt: null,
        ordinaryFallbackReason: "target_encryption_not_ready",
        humanProductOutcome: { memoryId: fixture.memoryId, contentRevision: 2 },
      });
      expect(receipt?.ordinaryFallbackCompletedAt).toBeInstanceOf(Date);
      // The relaxed outcome CHECK must not weaken truthful crypto completion.
      const [storedReceipt] = await receiptDb.select().from(receiptTable)
        .where(eq(receiptTable.operationId, operationId));
      if (storedReceipt === undefined) throw new Error("Missing fallback receipt");
      const invalidReceiptError = await receiptDb.transaction(async (tx) => {
        await tx.insert(receiptTable).values({ ...storedReceipt,
          sequence: undefined, operationId: `invalid-crypto-completion:${randomUUID()}`,
          cryptoCompletedAt: new Date(NOW) });
        throw new Error("Invalid fallback crypto timestamp passed its CHECK");
      }).then(() => undefined, (error: Error) => error.cause);
      expect(invalidReceiptError).toMatchObject({ code: "23514",
        constraint_name: "memory_crypto_operations_completion_coherent" });
      const allocation = await admin.unsafe<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM memory_crypto_revisions
          WHERE memory_id = $1 AND content_revision = 2`, [fixture.memoryId]);
      expect(allocation[0]?.count).toBe("0");

      const createdMemoryId = randomUUID();
      const createdOperationId = `human-memory:ordinary-create:${randomUUID()}`;
      const createProduct = new PostgresHumanMemoryProductUpdate(handle, {
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          handle, humanCanonicalConnection(client, fixture.userId)),
        publication: { representation: "ordinary_and_protected",
          allowOrdinaryFallback: true, policyRevision: 1,
          fence: async () => {},
          withLocks: async (_input, publish) => publish(async () => {}),
          withOrdinaryLocks: async (_input, publish) => publish(async () => {}) },
        createMemoryId: () => createdMemoryId,
        createOperationId: () => createdOperationId,
      });
      const deniedCreateAuthority = { ...authority,
        memoryMode: "namespace" as const,
        scopeId: null, originWritableNamespaceId: null };
      expect(() => createProduct.reserveCreatePlan({
        authority: deniedCreateAuthority, now: NOW,
      })).toThrow("create authority is incomplete");
      const createAuthority = { ...deniedCreateAuthority,
        writableNamespaceIds: [fixture.namespaceValue] };
      const plan = await createProduct.reserveCreatePlan({
        authority: createAuthority, now: NOW });
      if (plan.issuedAt === undefined) throw new Error("Missing plan issue time");
      const createDigest = fixture.crypto.hash(
        new TextEncoder().encode(createdOperationId));
      const createAuthenticated = Object.freeze({ requestDigest: createDigest,
        request: Object.freeze({ formatVersion: 1 as const,
          purpose: "memory.ordinary_fallback.create" as const,
          reason: "target_encryption_not_ready" as const,
          operationId: plan.operationId, memoryId: plan.memoryId,
          expectedContentRevision: 0, nextContentRevision: 1,
          expectedCryptoAccessRevision: 0,
          requiredNamespaceIds: [...plan.requiredNamespaceIds], type: "fact",
          content: "early ordinary create", requestedProvider: "openai" as const,
          requestedModel: "text-embedding-3-small", dimensions: 1536 as const,
          processorContractVersion: 1 as const, policyRevision: 1,
          subjectHumanId: fixture.humanValue,
          committerDeviceId: fixture.deviceValue,
          committerDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 1, planIssuedAt: plan.issuedAt,
          planDeadlineAt: plan.deadlineAt, issuedAt: plan.issuedAt,
          deadlineAt: plan.deadlineAt, signature: new Uint8Array(64) }) });
      const createAdmission = await createProduct.admitOrdinaryFallback({
        authority: createAuthority, authenticated: createAuthenticated });
      expect(await createProduct.publishOrdinaryFallbackIntent({
        authority: createAuthority, admission: createAdmission,
        embedding: { provider: "openai",
          canonicalModel: "text-embedding-3-small", dimensions: 1536,
          vector: new Array<number>(1536).fill(0.5),
          processorContractVersion: 1 },
      })).toMatchObject({ memoryId: createdMemoryId, contentRevision: 1,
        cryptoAccessRevision: 0 });
      const createAllocations = await admin.unsafe<Array<{ count: string }>>(
        `SELECT count(*)::text AS count FROM memory_crypto_revisions
          WHERE memory_id = $1`, [createdMemoryId]);
      expect(createAllocations[0]?.count).toBe("0");
    } finally {
      await client.end();
    }
  });

  test("commits and restart-reconciles exact Human M:N access across Domains without leaking product plaintext", async () => {
    const fixture = await createHumanDeletionFixture();
    const targetNamespace = randomUUID();
    const domains = [
      `human-access-domain-${randomUUID()}`,
      `human-access-domain-${randomUUID()}`,
    ] as const;
    const bindings = [
      exactAccessBinding({
        crypto: fixture.crypto,
        namespaceValue: fixture.namespaceValue,
        domainValue: domains[0],
        deviceValue: fixture.deviceValue,
        signingPrivateKey: fixture.signingPrivateKey,
        signingPublicKey: fixture.signingPublicKey,
      }),
      exactAccessBinding({
        crypto: fixture.crypto,
        namespaceValue: targetNamespace,
        domainValue: domains[1],
        deviceValue: fixture.deviceValue,
        signingPrivateKey: fixture.signingPrivateKey,
        signingPublicKey: fixture.signingPublicKey,
      }),
    ] as const;
    await drizzle(admin, { schema }).transaction(async (transaction) => {
      await transaction.insert(schema.namespaces).values({
        id: targetNamespace, scope: "room", label: "Human exact-access target Namespace",
      });
      for (const [index, domainValue] of domains.entries()) {
        const operationId = `human-native-access-${randomUUID()}`;
        const nativeHead = {
          namespaceId: index === 0 ? fixture.namespaceValue : targetNamespace,
          domainId: domainValue, keyClass: "ai", domainKeyGeneration: 0,
          domainAuthorizationRevision: 1, domainHeadDigest: bindings[index]!.hash,
          namespaceAccessRevision: 0, namespaceCurrentGeneration: 0,
          bundleRevision: 0, retainedGenerationCount: 1,
          retainedAuthoritySetDigest: bindings[index]!.hash,
          bindingDigest: bindings[index]!.hash, activatedAt: new Date(NOW),
        };
        await transaction.insert(schema.namespaceDomainKeyBindings).values({
          ...nativeHead, operationId, idempotencyKey: operationId,
          plaintextDigest: bindings[index]!.hash, ciphertextDigest: bindings[index]!.hash,
          bindingBytes: bindings[index]!.bytes, issuerHumanId: fixture.humanValue,
          issuerDeviceId: fixture.deviceValue, issuerDeviceSigningGeneration: 1,
          state: "active", createdAt: new Date(NOW), updatedAt: new Date(NOW),
          deadlineAt: new Date(NOW + 30_000), terminalAt: new Date(NOW),
        });
        await transaction.insert(schema.namespaceDomainKeyHeads).values({
          ...nativeHead, bindingOperationId: operationId,
        });
      }
    });
    const targetEnvelope = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        fixture.crypto,
        digest(0xb2),
        {
          objectId: objectId(fixture.cryptoObjectId),
          namespaceId: namespaceId(targetNamespace),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(0),
          bindingRevisionAtWrap: accessRevision(0),
        },
        fixture.objectDek,
      ),
    );
    const targetInventory = [
      Object.freeze({
        namespaceId: fixture.namespaceValue,
        domainId: domains[0],
        binding: bindings[0],
        envelopeBytes: fixture.envelopeBytes,
      }),
      Object.freeze({
        namespaceId: targetNamespace,
        domainId: domains[1],
        binding: bindings[1],
        envelopeBytes: targetEnvelope,
      }),
    ].sort((left, right) =>
      compareUnsignedUtf8(left.namespaceId, right.namespaceId)
    );
    const targetNamespaceIds = targetInventory.map(({ namespaceId: value }) =>
      value
    );
    const bindingFacts = targetInventory.map(
      ({ namespaceId: value, domainId, binding }) => Object.freeze({
        namespaceId: value,
        domainId,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 1,
        bindingHash: binding.hash,
      }),
    );
    const currentBindingFact = bindingFacts.find(({ namespaceId: value }) =>
      value === fixture.namespaceValue
    )!;
    const operationId = `human-memory:exact-access:${randomUUID()}`;
    const prepared = prepareHumanObjectAccessManifestUpdateSet(fixture.crypto, {
      operationId,
      expectedContentRevision: 1,
      subjectHumanId: humanId(fixture.humanValue),
      currentManifestBytes: fixture.genesis.manifestBytes,
      currentEnvelopeBytes: [fixture.envelopeBytes],
      targetEnvelopeBytes: targetInventory.map(({ envelopeBytes }) =>
        envelopeBytes
      ),
      trustedMinimumHead: {
        objectId: objectId(fixture.cryptoObjectId),
        payloadHash: fixture.genesis.manifest.payloadHash,
        accessRevision: accessRevision(0),
        manifestHash: fixture.genesis.manifestHash,
      },
      proof: [],
      resolveSigningPublicKey: () => fixture.signingPublicKey,
      currentNamespaceBindings: [currentBindingFact],
      targetNamespaceBindings: bindingFacts,
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: cryptoDeviceId(fixture.deviceValue),
      hostAuthorizationRevision: authorizationRevision(1),
      committerSigningPublicKey: fixture.signingPublicKey,
      committerSigningPrivateKey: fixture.signingPrivateKey,
    });
    const requestEntries = (
      facts: typeof bindingFacts,
      envelopes: typeof prepared.authority.currentEnvelopes,
    ) => facts.map((fact, index) => ({
      namespaceId: namespaceId(fact.namespaceId),
      keyGeneration: envelopes[index]!.keyGeneration,
      namespaceAccessRevision: envelopes[index]!.bindingRevisionAtWrap,
      headDigest: fact.bindingHash,
      publicationDigest: fact.bindingHash,
      publicationSetDigest: fact.bindingHash,
      audienceFingerprint: fact.bindingHash,
      envelopeHash: envelopes[index]!.envelopeHash,
    }));
    const signed = prepareHumanMemoryExactAccessRequest(fixture.crypto, {
      subjectHumanId: humanId(fixture.humanValue),
      operationId,
      memoryId: fixture.memoryId,
      cryptoObjectId: objectId(fixture.cryptoObjectId),
      payloadHash: prepared.authority.payloadHash,
      expectedContentRevision: 1,
      expectedAccessRevision: 0,
      nextAccessRevision: 1,
      currentManifestHash: prepared.authority.currentManifestHash,
      nextManifestHash: prepared.authority.nextManifestHash,
      currentEntries: requestEntries(
        [currentBindingFact],
        prepared.authority.currentEnvelopes,
      ),
      targetEntries: requestEntries(
        bindingFacts,
        prepared.authority.targetEnvelopes,
      ),
      currentAuthorityEntries: requestEntries(
        [currentBindingFact], prepared.authority.currentEnvelopes,
      ).map(({ envelopeHash: _envelopeHash, ...entry }) => entry),
      targetAuthorityEntries: requestEntries(
        bindingFacts, prepared.authority.targetEnvelopes,
      ).map(({ envelopeHash: _envelopeHash, ...entry }) => entry),
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
      committerDeviceId: cryptoDeviceId(fixture.deviceValue),
      hostAuthorizationRevision: authorizationRevision(1),
      committerSigningPublicKey: fixture.signingPublicKey,
      committerSigningPrivateKey: fixture.signingPrivateKey,
    });
    const authority = Object.freeze({
      userId: fixture.userId,
      subjectHumanId: fixture.humanValue,
      actorId: fixture.actorId,
      agentId: null,
      readableNamespaceIds: [fixture.namespaceValue],
      mutableNamespaceIds: [fixture.namespaceValue],
      writableNamespaceIds: targetNamespaceIds,
    });
    const productClient = sqlClient(appUrl);
    const cryptoClient = sqlClient(cryptoUrl);
    let plan;
    let receipt;
    try {
      const productHandle = await verifyConversationProductPostgresHandle(
        humanProductConnection(productClient, fixture.userId),
      );
      const product = new PostgresHumanMemoryExactAccessProduct(productHandle, {
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          productHandle, humanCanonicalConnection(productClient, fixture.userId)),
        publication: { fence: async () => {}, allowOrdinaryFallback: false,
          withLocks: async (_input, publish) => publish(async () => {}) },
      });
      plan = await product.plan({
        authority,
        operationId,
        memoryId: fixture.memoryId,
        target: { kind: "replace_exact", namespaceIds: [
          ...targetNamespaceIds,
        ] },
      });
      if (plan.status !== "prepared") throw new Error("exact access plan unavailable");
      const authenticated = authenticateHumanMemoryExactAccessPrepared({
        crypto: fixture.crypto,
        plan,
        signedRequestBytes: signed.bytes,
        manifestBytes: prepared.manifestBytes,
        envelopeBytes: prepared.envelopeBytes,
        now: NOW + 1,
        resolveCurrentAuthority: () => fixture.signingPublicKey,
      });
      await product.reserve({
        authority,
        plan,
        signedRequestDigest: fixture.crypto.hash(signed.bytes),
      });
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(cryptoClient),
      );
      const completion = new PostgresHumanMemoryExactAccessCryptoCompletion({
        handle: cryptoHandle,
        crypto: fixture.crypto,
      });
      receipt = await completion.complete(authenticated);
      expect(receipt.status).toBe("applied");
    } finally {
      await productClient.end();
      await cryptoClient.end();
    }
    const restartedProductClient = sqlClient(appUrl);
    const restartedCryptoClient = sqlClient(cryptoUrl);
    try {
      const productHandle = await verifyConversationProductPostgresHandle(
        humanProductConnection(restartedProductClient, fixture.userId),
      );
      const product = new PostgresHumanMemoryExactAccessProduct(productHandle, {
        canonicalRunner: bindConversationProductCanonicalTransactionRunner(
          productHandle,
          humanCanonicalConnection(restartedProductClient, fixture.userId),
        ),
        publication: { fence: async () => {}, allowOrdinaryFallback: false,
          withLocks: async (_input, publish) => publish(async () => {}) },
      });
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(restartedCryptoClient),
      );
      const completion = new PostgresHumanMemoryExactAccessCryptoCompletion({
        handle: cryptoHandle,
        crypto: fixture.crypto,
      });
      expect(await product.reconcile({
        authority,
        operationId,
        memoryId: fixture.memoryId,
        crypto: await completion.observe(fixture.cryptoObjectId),
      })).toEqual({ status: "pending", phase: "crypto" });
      // A durable crypto head alone cannot authorize product publication.
      // Retry the exact signed request after restart and expiry using its
      // retained admission, while checking the current device authority.
      const replay = await product.lookupReplay({
        authority, operationId, memoryId: fixture.memoryId,
        subjectHumanId: fixture.humanValue,
        signedRequestDigest: fixture.crypto.hash(signed.bytes),
      });
      if (replay.status !== "pending") throw new Error("Expected retained access admission");
      const replayPlan = await product.plan({
        authority, operationId, memoryId: fixture.memoryId,
        target: { kind: "replace_exact", namespaceIds: targetNamespaceIds },
      });
      if (replayPlan.status !== "prepared") throw new Error("Expected current access plan");
      const retry = authenticateHumanMemoryExactAccessPrepared({
        crypto: fixture.crypto, plan: replayPlan, signedRequestBytes: signed.bytes,
        manifestBytes: prepared.manifestBytes, envelopeBytes: prepared.envelopeBytes,
        now: NOW + 60_000, replayAdmission: replay.replayAdmission,
        resolveCurrentAuthority: () => fixture.signingPublicKey,
      });
      const retryReceipt = await completion.complete(retry);
      expect(retryReceipt.status).toBe("duplicate");
      expect(await product.commit({ authority, plan: replayPlan, receipt: retryReceipt }))
        .toMatchObject({ status: "updated", cryptoAccessRevision: 1 });
      expect(await product.reconcile({
        authority, operationId, memoryId: fixture.memoryId,
        crypto: await completion.observe(fixture.cryptoObjectId),
      })).toMatchObject({
        status: "completed",
        cryptoAccessRevision: 1,
        requiredNamespaceIds: targetNamespaceIds,
      });
      const productRows = await admin.unsafe<{
        content: string | null;
        crypto_access_revision: number;
        crypto_mapping_state: string;
      }[]>(
        `SELECT content, crypto_access_revision, crypto_mapping_state
           FROM memories WHERE id = $1`,
        [fixture.memoryId],
      );
      expect([...productRows]).toEqual([{
        content: null,
        crypto_access_revision: 1,
        crypto_mapping_state: "verified",
      }]);
      const receiptRows = await admin.unsafe<{ request_digest: Uint8Array }[]>(
        `SELECT request_digest FROM memory_crypto_operations
          WHERE operation_id = $1 AND operation_type = 'access'`,
        [operationId],
      );
      expect(receiptRows).toHaveLength(1);
      expect(Buffer.from(receiptRows[0]!.request_digest).toString("utf8"))
        .not.toContain(fixture.plaintext);
    } finally {
      await restartedProductClient.end();
      await restartedCryptoClient.end();
      fixture.objectDek.fill(0);
      targetEnvelope.fill(0);
      signed.bytes.fill(0);
    }
  });
  test("restores and fences a current protected-only Memory", async () => {
    const fixture = await createFixture({ scopeOrigin: false, protectedOnly: true });
    const productStore = await openProductStore();
    const crypto = await openCryptoCompletion(fixture);
    const agentClient = sqlClient(agentUrl);
    const adminDb = drizzle(admin);
    const [policy] = await adminDb.select({ mode: encryptionTransitionPolicy.mode,
      revision: encryptionTransitionPolicy.revision,
      shadowEncryptionStartedAt: encryptionTransitionPolicy.shadowEncryptionStartedAt,
    }).from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server"));
    if (policy === undefined) throw new Error("Missing encryption policy");
    try {
      expect(await crypto.completion.complete(fixture.prepared)).toBe("created");
      expect(await productStore.store.markCryptoComplete({ memoryId: fixture.memoryId,
        contentRevision: 3, cryptoObjectId: fixture.objectId, leaseToken: null })).toBe("applied");
      expect(await productStore.store.compareAndSwapCryptoMapping({ memoryId: fixture.memoryId,
        contentRevision: 3, cryptoObjectId: fixture.objectId,
        expectedRequiredNamespaceFingerprint: fixture.requiredNamespaceFingerprint,
        leaseToken: null })).toBe("applied");
      const [before] = await adminDb.select({ type: memories.type,
          importance: memories.importance, tier: memories.tier,
          createdAt: memories.createdAt, updatedAt: memories.updatedAt,
          contentRevision: memories.contentRevision,
          cryptoAccessRevision: memories.cryptoAccessRevision,
          cryptoMappingState: memories.cryptoMappingState })
        .from(memories).where(eq(memories.id, fixture.memoryId));
      expect(before?.cryptoMappingState).toBe("verified");
      if (before === undefined) throw new Error("Missing Memory fixture");
      const [shadow] = await adminDb.update(encryptionTransitionPolicy).set({ mode: "shadow_encryption",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        shadowEncryptionStartedAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"))
        .returning({ revision: encryptionTransitionPolicy.revision });
      if (shadow === undefined) throw new Error("Missing Shadow policy");
      const handle = await verifyConversationProductPostgresHandle(
        agentProductConnection(agentClient, fixture.userId, fixture.agentProductId));
      const canonical = bindConversationProductCanonicalTransactionRunner(
        handle,
        agentCanonicalConnection(
          agentClient,
          fixture.userId,
          fixture.agentProductId,
        ),
      );
      const [source] = await loadPostgresForegroundMemoryRepairSources({
        product: handle,
        crypto: fixture.crypto,
        memories: [Object.freeze({
          representation: "structural" as const,
          id: fixture.memoryId,
          type: before.type,
          importance: before.importance,
          tier: before.tier,
          createdAt: before.createdAt,
        })],
        representationMode: "protected-only",
      });
      if (source === undefined) throw new Error("Missing protected Memory source");
      const restore = (content: string, revision = shadow.revision) =>
        restorePostgresForegroundMemoryOrdinary({ canonical, source,
          objectId: fixture.objectId, type: fixture.plaintextType, content,
          expectedPolicyRevision: revision });
      expect(await validatePostgresForegroundMemoryRepairSource({
        product: handle,
        source,
        objectId: fixture.objectId,
      })).toBe(true);
      expect(await restore(fixture.plaintext)).toBe("restored");
      expect(await restore(fixture.plaintext)).toBe("replayed");
      expect(await restore("conflicting body")).toBe("conflict");
      expect(await restore(fixture.plaintext, shadow.revision - 1)).toBe("conflict");
      expect(await restorePostgresForegroundMemoryOrdinary({ canonical,
        source: { ...source, existingObjectId: `wrong:${fixture.objectId}` },
        objectId: fixture.objectId, type: fixture.plaintextType,
        content: fixture.plaintext,
        expectedPolicyRevision: shadow.revision })).toBe("conflict");
      const [after] = await adminDb.select({ content: memories.content, type: memories.type,
        importance: memories.importance, tier: memories.tier, contentRevision: memories.contentRevision,
        createdAt: memories.createdAt, updatedAt: memories.updatedAt,
      }).from(memories).where(eq(memories.id, fixture.memoryId));
      expect(after).toEqual({ content: fixture.plaintext, type: fixture.plaintextType,
        importance: before.importance, tier: before.tier, contentRevision: 3,
        createdAt: before.createdAt, updatedAt: before.updatedAt });
      await adminDb.update(memories).set({ content: null }).where(eq(memories.id, fixture.memoryId));
      const baseCanonical = agentCanonicalConnection(
        agentClient,
        fixture.userId,
        fixture.agentProductId,
      );
      const remapConflictCanonical = bindConversationProductCanonicalTransactionRunner(handle, {
        transaction: (callback, options) => baseCanonical.transaction(async (tx, executor) => {
          let updateCount = 0;
          const conflictTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "update") {
                return Reflect.get(target, property, receiver) as unknown;
              }
              return (...args: Parameters<typeof tx.update>) => {
                updateCount += 1;
                if (updateCount !== 2) return tx.update(...args);
                return { set: () => ({ where: () => ({
                  returning: () => Promise.resolve([]),
                }) }) };
              };
            },
          });
          return callback(conflictTx, executor);
        }, options),
      });
      expect(await restorePostgresForegroundMemoryOrdinary({
        canonical: remapConflictCanonical,
        source,
        objectId: fixture.objectId,
        type: fixture.plaintextType,
        content: fixture.plaintext,
        expectedPolicyRevision: shadow.revision,
      })).toBe("conflict");
      expect((await adminDb.select({ content: memories.content }).from(memories)
        .where(eq(memories.id, fixture.memoryId)))[0]?.content).toBeNull();
      await adminDb.update(encryptionTransitionPolicy).set({ mode: "encrypted_only",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      expect(await restore(fixture.plaintext)).toBe("conflict");
      expect((await adminDb.select({ content: memories.content }).from(memories)
        .where(eq(memories.id, fixture.memoryId)))[0]?.content).toBeNull();
    } finally {
      await adminDb.update(encryptionTransitionPolicy).set({ mode: policy.mode,
        revision: policy.revision, shadowEncryptionStartedAt: policy.shadowEncryptionStartedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      await Promise.all([agentClient.end(), productStore.client.end(), crypto.client.end()]);
    }
  });
});
