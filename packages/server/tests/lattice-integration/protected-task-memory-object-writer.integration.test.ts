import { createHash, randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  __resetSharedDirectCryptoDbForTests,
  __resetSharedDirectAgentDbForTests,
  __resetSharedDirectDbForTests,
  actors,
  agentCryptoRuntimeChallenges,
  agentCryptoRuntimeConfigObjects,
  agentCryptoRuntimeDomainEnvelopes,
  agentCryptoRuntimeSigners,
  agentCryptoRuntimeStates,
  agentScopes,
  agents,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  createDirectDb,
  createPostgresJsBridgeConnection,
  cryptoDomains,
  cryptoObjects,
  domainKeyEnvelopeAcknowledgements,
  domainKeyHeads,
  domainKeyPublicationOperations,
  domainKeyRecipientEnvelopes,
  domainKeyRecipientRequests,
  encryptionTransitionPolicy,
  eq,
  getEncryptionTransitionPolicy,
  getSharedDirectCryptoDb,
  getSharedDirectAgentDb,
  getSharedDirectDb,
  groupMembers,
  groups,
  humanCryptoCustodies,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
  and,
  inArray,
  jobs,
  memories,
  memoryCryptoRevisions,
  memoryNamespaces,
  memoryScopes,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  namespaces,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  resolveAppDatabaseConnectionString,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  serverAdmission,
  sql,
  taskDefinitionCryptoRevisions,
  taskRunResultCryptoRevisions,
  taskRuns,
  tasks,
  transitionTaskLifecycleTerminal,
  users,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  persistJobWithDatabase,
  startProtectedTaskJobWithDatabase,
  updateJobStatusWithDatabase,
} from "../../../db/src/queries/jobs.ts";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  generateDomainKey,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  prepareHumanObjectAccessManifestGenesisSet,
  TaskRuntimeRecipientRegistry,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type DomainForegroundSecretEntry,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  bindEncryptionDataOperationOwner,
  createDormantTaskContentShadowRepository,
  createPreparedHumanTaskContentCryptoRevisionV1,
  deriveMemoryCryptoObjectIdV1,
  deriveTaskContentCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  encodeTaskPayloadV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  prepareTaskRuntimeAgentObject,
  taskContentObjectTypeV1,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryAuthority,
  type TaskRuntimeAgentObjectNamespaceMaterial,
} from "@nautilo/lattice-bridge";
import {
  PostgresDeviceAdmissionRepository,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresLatticeStorage,
  PostgresTaskContentProductStore,
  createPostgresTaskContentCryptoCompletion,
  PostgresNamespaceProductAuthority,
  inspectInitialTaskRuntimeNamespaceAuthority,
  inspectTaskContentNamespaceAuthority,
  verifyCryptoPostgresHandle,
  withNativeProtectedTaskDefinitionV1,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresHandle,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskJobReferenceV1,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";
import {
  InMemoryLaneLock,
  JobManager,
  createTaskRuntimeDomainMemoryCryptoSession,
  withNativeProtectedTaskCheckpointSaver,
} from "@nautilo/runtime";
import {
  PersonalPolicyResolver,
  findActorByOwnerId,
} from "@nautilo/trust";
import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import {
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationRunning,
} from "../../../runtime/src/protected-execution/background-authorization/lifecycle.ts";
import { PostgresBackgroundAuthorizationRepository } from "../../../runtime/src/protected-execution/background-authorization/postgres-repository.ts";
import {
  taskRuntimeStableIdempotencyKey,
} from "../../../runtime/src/protected-execution/background-authorization/task-runtime-grant-claim.ts";
import {
  createForegroundProductTransactionContext,
} from "../../src/routes/foreground-message-product-store.ts";
import {
  withProtectedTaskNativeMemoryRepository,
} from "../../src/routes/protected-task-native-memory-repository.ts";
import {
  adoptProtectedTaskScopeMemoryOrigin,
  attachProtectedTaskScopeMemoryRepair,
  requireHeldProtectedTaskMemoryWriterAuthority,
  reserveProtectedTaskScopeMemoryRepair,
  withCurrentProtectedTaskMemoryAuthority,
  type HeldProtectedTaskMemoryAuthority,
} from "../../src/routes/current-protected-task-memory-authority.ts";
import {
  persistProtectedTaskMemoryObject,
  persistProtectedTaskMemoryObjectUnderHeld,
  type ProtectedTaskMemoryObjectWrite,
  type ProtectedTaskMemoryObjectWriterInput,
} from "../../src/routes/protected-task-memory-object-writer.ts";
import {
  createProductionBackgroundAuthorizationComposition,
} from "../../src/routes/background-authorization-composition.ts";
import {
  createProtectedTaskNativeFixedMemorySegment,
} from "../../src/routes/protected-task-native-fixed-memory-segment.ts";
import {
  createProductionProtectedTaskNativeExecution,
} from "../../src/routes/protected-task-native-execution-composition.ts";
import {
  createProductionProtectedTaskRuntimeInitialComposition,
  loadInitialProtectedTaskOccurrence,
} from "../../src/routes/protected-task-runtime-initial-composition.ts";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
} from "../../src/routes/protected-task-requester-private-room.ts";

const ENABLE_ENV = "NAUTILO_PROTECTED_TASK_MEMORY_WRITER_INTEGRATION";
const EXPECTED_INSTANCE_ID = "qa-task-completion-e7ada3c6";
const EXPECTED_POSTGRES_PORT = "6234";
const NOW = Date.parse("2042-07-08T09:00:00.000Z");
const EXPIRES_AT = NOW + 60_000;
const SERVER_SCOPE = "https://task-memory.integration.test";

function assertExactTarget(): void {
  if (process.env[ENABLE_ENV] !== "1") return;
  if (process.env["NAUTILO_INSTANCE_ID"] !== EXPECTED_INSTANCE_ID) {
    throw new Error(
      `${ENABLE_ENV}=1 requires NAUTILO_INSTANCE_ID=${EXPECTED_INSTANCE_ID}`,
    );
  }
  const product = new URL(resolveAppDatabaseConnectionString());
  const cryptoRaw = process.env["DB_CRYPTO_CONNECTION_STRING"];
  if (!cryptoRaw) throw new Error("DB_CRYPTO_CONNECTION_STRING is required");
  const crypto = new URL(cryptoRaw);
  for (const [url, user] of [[product, "nautilo"], [crypto, "nautilo_crypto"]] as const) {
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      || url.port !== EXPECTED_POSTGRES_PORT
      || url.username !== user
      || url.password.length === 0
      || url.pathname !== "/nautilo"
    ) {
      throw new Error(
        "Protected Task Memory writer integration requires the exact local QA product and crypto roles",
      );
    }
  }
}

assertExactTarget();
const describePostgres = process.env[ENABLE_ENV] === "1"
  ? describe.serial
  : describe.skip;

function digest(label: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(label).digest());
}

function hexDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  return Object.freeze({
    promise: new Promise<void>((complete) => {
      resolve = complete;
    }),
    resolve,
  });
}

function gatedRestrictedConnection(base: PostgresJsBridgeConnection): Readonly<{
  connection: PostgresJsBridgeConnection;
  entered: Promise<void>;
  release(): void;
}> {
  const entered = deferred();
  const release = deferred();
  let admitted = false;
  const transactionOnce: PostgresJsBridgeConnection["transactionOnce"] =
    async (use, options) => {
      if (!admitted) {
        admitted = true;
        entered.resolve();
        await release.promise;
      }
      return base.transactionOnce(use, options);
    };
  return Object.freeze({
    entered: entered.promise,
    release: release.resolve,
    connection: Object.freeze({
      query: base.query.bind(base),
      transaction: base.transaction.bind(base),
      transactionOnce,
    }),
  });
}

function observeRestrictedConnection(
  base: PostgresJsBridgeConnection,
  afterQuery: (
    statement: string,
    parameters: readonly PostgresJsBridgeScalar[] | undefined,
  ) => void,
): PostgresJsBridgeConnection {
  const wrap = (
    executor: Pick<PostgresJsBridgeConnection, "query">,
  ): PostgresJsBridgeConnection => ({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => {
      const rows = await executor.query<Row>(statement, parameters);
      afterQuery(statement, parameters);
      return rows;
    },
    transaction: (use) => use(wrap(executor)),
    transactionOnce: (use) => use(wrap(executor)),
  });
  return {
    query: wrap(base).query,
    transaction: (use, options) => base.transaction(
      (executor) => use(wrap(executor)),
      options,
    ),
    transactionOnce: (use, options) => base.transactionOnce(
      (executor) => use(wrap(executor)),
      options,
    ),
  };
}

function observeCanonicalRunner(
  base: ConversationProductCanonicalTransactionRunner,
  wrapExecutor: (
    executor: PostgresJsBridgeExecutor,
  ) => PostgresJsBridgeExecutor = executor => executor,
): Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  pid: Promise<number>;
  transactionCalls(): number;
}> {
  const backend = Promise.withResolvers<number>();
  let transactionCalls = 0;
  return Object.freeze({
    pid: backend.promise,
    transactionCalls: () => transactionCalls,
    runner: Object.freeze({
      ...base,
      transaction: <Result>(
        callback: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[0],
        options: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[1],
      ): Promise<Result> => {
        transactionCalls += 1;
        return base.transaction(async (tx, executor) => {
        try {
          const rows = await executor.query<{ pid: number }>(
            "SELECT pg_backend_pid()::integer AS pid",
          );
          const pid = rows[0]?.pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
            throw new Error("Task Memory writer has no product backend PID");
          }
          backend.resolve(pid);
          return await callback(tx, wrapExecutor(executor)) as Result;
        } catch (error) {
          backend.reject(error);
          throw error;
        }
        }, options);
      },
    }),
  });
}

function gateCanonicalRunnerAfterScopeOriginUpdate(
  base: ConversationProductCanonicalTransactionRunner,
): Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  entered: Promise<void>;
  pid: Promise<number>;
  release(): void;
}> {
  const entered = deferred();
  const release = deferred();
  let gated = false;
  const observed = observeCanonicalRunner(base, executor => ({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => {
      const result = await executor.query<Row>(statement, parameters);
      if (!gated && /^\s*update\s+"memories"\s+set/iu.test(statement)
        && statement.includes("scope_origin_namespace_id")) {
        gated = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  }));
  return Object.freeze({
    entered: entered.promise,
    pid: observed.pid,
    release: release.resolve,
    runner: observed.runner,
  });
}

function canonicalProductConnection(
  runner: ConversationProductCanonicalTransactionRunner,
): PostgresJsBridgeConnection {
  const transaction: PostgresJsBridgeConnection["transaction"] =
    (use, options) => runner.transaction(
      (_tx, executor) => use(executor),
      options ?? { isolationLevel: "read committed" },
    );
  const query: PostgresJsBridgeConnection["query"] =
    <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters?: readonly PostgresJsBridgeScalar[],
    ): Promise<readonly Row[]> => transaction(
      (executor) => executor.query<Row>(statement, parameters),
    );
  return Object.freeze({
    query,
    transaction,
    transactionOnce: transaction,
  });
}

type BaseFixture = Awaited<ReturnType<typeof createBaseFixture>>;

async function waitForBlockedContender(
  base: BaseFixture,
  blockerPid: number,
  failure = "Task cancellation did not reach the writer's product lock",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await base.admin.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM pg_stat_activity
         WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
           AND state = 'active'
           AND wait_event_type = 'Lock'
      ) AS blocked
    `);
    if (activity?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(failure);
}

async function createBaseFixture(
  options: Readonly<{ connectedExecution?: boolean }> = {},
) {
  const admin = createDirectDb(5);
  const productDb = getSharedDirectDb();
  const cryptoDb = getSharedDirectCryptoDb();
  const restricted = createPostgresJsBridgeConnection(cryptoDb);
  const cryptoHandle = await verifyCryptoPostgresHandle(restricted);
  const crypto = new LatticeCrypto(undefined, { now: () => NOW });
  const userId = randomUUID();
  const humanActorId = randomUUID();
  const agentActorId = randomUUID();
  const productAgentId = randomUUID();
  const namespaceValue = randomUUID();
  const seedNamespaceValue = randomUUID();
  const roomId = randomUUID();
  const seedRoomId = randomUUID();
  const deviceId = `task-memory-device-${randomUUID()}`;
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.generateEncryptionKeyPair();
  const managerVault = DeviceProviderStateVault.fromKey(
    crypto,
    cryptoDeviceId(deviceId),
    crypto.randomBytes(32),
  );
  let namespaceKey: Uint8Array | null = null;
  let seedNamespaceKey: Uint8Array | null = null;
  let domainKey: Uint8Array | null = null;
  let domainIdValue: string | null = null;
  let runtime: Awaited<ReturnType<typeof prepareAgentRuntimeInitialization>> | null = null;
  const objectIds = new Set<string>();
  const memoryIds = new Set<string>();
  const requestIds = new Set<string>();
  const taskIds = new Set<string>();
  const jobIds = new Set<string>();
  const scopeIds = new Set<string>();
  const sessionThreadIds = new Set<string>();

  const [originalPolicy] = await admin.select().from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"));
  if (originalPolicy === undefined) throw new Error("Missing encryption policy");
  const policyRevision = originalPolicy.revision + 1;

  const cleanup = async (): Promise<void> => {
    const attachedObjects = await admin.select({
      objectId: objectCryptoNamespaceEnvelopes.objectId,
    }).from(objectCryptoNamespaceEnvelopes).where(eq(
      objectCryptoNamespaceEnvelopes.namespaceId,
      namespaceValue,
    ));
    const writtenObjectIds = [...new Set([
      ...objectIds,
      ...attachedObjects.map(row => row.objectId),
    ])];
    const attachedMemories = await admin.select({
      memoryId: memoryNamespaces.memoryId,
    }).from(memoryNamespaces).where(eq(
      memoryNamespaces.namespaceId,
      namespaceValue,
    ));
    const writtenMemoryIds = [...new Set([
      ...memoryIds,
      ...attachedMemories.map(row => row.memoryId),
    ])];
    const createdTaskIds = [...taskIds];
    const taskJobRows = createdTaskIds.length === 0 ? [] : await admin.select({
      jobId: taskRuns.jobId,
    }).from(taskRuns).where(inArray(taskRuns.taskId, createdTaskIds));
    const createdJobIds = [...new Set([
      ...jobIds,
      ...taskJobRows.flatMap(row => row.jobId === null ? [] : [row.jobId]),
    ])];
    const createdRequestIds = [...requestIds];
    try {
      if (sessionThreadIds.size > 0) {
        const createdSessions = await admin.select({ id: sessions.id })
          .from(sessions).where(inArray(
            sessions.threadId,
            [...sessionThreadIds],
          ));
        const createdSessionIds = createdSessions.map(row => row.id);
        if (createdSessionIds.length > 0) {
          await admin.delete(sessionMessages).where(inArray(
            sessionMessages.sessionId,
            createdSessionIds,
          ));
          await admin.delete(sessions).where(inArray(
            sessions.id,
            createdSessionIds,
          ));
        }
      }
      if (writtenObjectIds.length > 0) {
        await admin.delete(objectCryptoAccessHeads).where(
          inArray(objectCryptoAccessHeads.objectId, writtenObjectIds),
        );
        await admin.delete(objectCryptoNamespaceEnvelopes).where(
          inArray(objectCryptoNamespaceEnvelopes.objectId, writtenObjectIds),
        );
        await admin.delete(objectCryptoAccessManifests).where(
          inArray(objectCryptoAccessManifests.objectId, writtenObjectIds),
        );
      }
      await admin.delete(agentCryptoRuntimeChallenges).where(
        eq(agentCryptoRuntimeChallenges.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeDomainEnvelopes).where(
        eq(agentCryptoRuntimeDomainEnvelopes.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeConfigObjects).where(
        eq(agentCryptoRuntimeConfigObjects.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeSigners).where(
        eq(agentCryptoRuntimeSigners.agentId, productAgentId),
      );
      await admin.delete(agentCryptoRuntimeStates).where(
        eq(agentCryptoRuntimeStates.agentId, productAgentId),
      );
      if (createdRequestIds.length > 0) {
        await admin.delete(backgroundCryptoAuthorizationNamespaceRequirements)
          .where(inArray(
            backgroundCryptoAuthorizationNamespaceRequirements.requestId,
            createdRequestIds,
          ));
        await admin.delete(backgroundCryptoAuthorizationDomainRequirements)
          .where(inArray(
            backgroundCryptoAuthorizationDomainRequirements.requestId,
            createdRequestIds,
          ));
        await admin.delete(backgroundCryptoAuthorizationRequests).where(
          inArray(backgroundCryptoAuthorizationRequests.requestId, createdRequestIds),
        );
      }
      await admin.delete(namespaceDomainKeyHeads).where(inArray(
        namespaceDomainKeyHeads.namespaceId,
        [namespaceValue, seedNamespaceValue],
      ));
      await admin.delete(namespaceDomainKeyBindings).where(inArray(
        namespaceDomainKeyBindings.namespaceId,
        [namespaceValue, seedNamespaceValue],
      ));
      await admin.delete(domainKeyEnvelopeAcknowledgements).where(
        eq(domainKeyEnvelopeAcknowledgements.recipientDeviceId, deviceId),
      );
      await admin.delete(domainKeyRecipientEnvelopes).where(
        eq(domainKeyRecipientEnvelopes.recipientHumanId, humanActorId),
      );
      await admin.delete(domainKeyRecipientRequests).where(
        eq(domainKeyRecipientRequests.recipientHumanId, humanActorId),
      );
      await admin.delete(domainKeyHeads).where(
        eq(domainKeyHeads.issuerHumanId, humanActorId),
      );
      await admin.delete(domainKeyPublicationOperations).where(
        eq(domainKeyPublicationOperations.issuerHumanId, humanActorId),
      );
      if (domainIdValue !== null) {
        await admin.delete(cryptoDomains).where(eq(cryptoDomains.id, domainIdValue));
      }
      await admin.delete(humanCryptoDeviceGroupAcknowledgements).where(
        eq(humanCryptoDeviceGroupAcknowledgements.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupWelcomes).where(
        eq(humanCryptoDeviceGroupWelcomes.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupCommits).where(
        eq(humanCryptoDeviceGroupCommits.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupJoinRequests).where(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDeviceKeyPackages).where(
        eq(humanCryptoDeviceKeyPackages.deviceId, deviceId),
      );
      await admin.delete(humanCryptoRecoveryKeys).where(
        eq(humanCryptoRecoveryKeys.humanId, humanActorId),
      );
      await admin.delete(humanCryptoDevices).where(
        eq(humanCryptoDevices.humanId, humanActorId),
      );
      await admin.delete(humanCryptoCustodies).where(
        eq(humanCryptoCustodies.humanId, humanActorId),
      );
      if (createdTaskIds.length > 0) {
        await admin.delete(tasks).where(inArray(tasks.id, createdTaskIds));
        await admin.delete(taskRunResultCryptoRevisions).where(inArray(
          taskRunResultCryptoRevisions.taskId,
          createdTaskIds,
        ));
        await admin.delete(taskDefinitionCryptoRevisions).where(
          inArray(taskDefinitionCryptoRevisions.taskId, createdTaskIds),
        );
      }
      if (createdJobIds.length > 0) {
        await admin.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (writtenMemoryIds.length > 0) {
        await admin.delete(memoryScopes).where(
          inArray(memoryScopes.memoryId, writtenMemoryIds),
        );
        await admin.delete(memories).where(
          inArray(memories.id, writtenMemoryIds),
        );
      }
      if (scopeIds.size > 0) {
        await admin.delete(agentScopes).where(inArray(
          agentScopes.id,
          [...scopeIds],
        ));
      }
      if (writtenObjectIds.length > 0) {
        await admin.delete(cryptoObjects).where(
          inArray(cryptoObjects.objectId, writtenObjectIds),
        );
      }
      await admin.delete(roomMembers).where(inArray(
        roomMembers.roomId,
        [roomId, seedRoomId],
      ));
      await admin.delete(rooms).where(inArray(
        rooms.id,
        [roomId, seedRoomId],
      ));
      await admin.delete(namespaces).where(inArray(
        namespaces.id,
        [namespaceValue, seedNamespaceValue],
      ));
      await admin.delete(groupMembers).where(eq(groupMembers.userId, userId));
      await admin.delete(actors).where(eq(actors.ownerId, userId));
      await admin.delete(agents).where(eq(agents.id, productAgentId));
      await admin.delete(serverAdmission).where(eq(serverAdmission.userId, userId));
      await admin.delete(users).where(eq(users.id, userId));
    } finally {
      try {
        await admin.update(encryptionTransitionPolicy).set({
          mode: originalPolicy.mode,
          shadowBehavior: originalPolicy.shadowBehavior,
          revision: originalPolicy.revision,
          shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
          updatedAt: originalPolicy.updatedAt,
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      } finally {
        namespaceKey?.fill(0);
        seedNamespaceKey?.fill(0);
        domainKey?.fill(0);
        runtime?.runtime.key.fill(0);
        signing.privateKey.fill(0);
        encryption.privateKey.fill(0);
        recovery.privateKey.fill(0);
        managerVault.destroy();
        await admin.end();
        await Promise.all([
          __resetSharedDirectCryptoDbForTests(),
          __resetSharedDirectAgentDbForTests(),
          __resetSharedDirectDbForTests(),
        ]);
      }
    }
  };

  try {
    await admin.transaction(async (tx) => {
      await tx.insert(users).values({ id: userId, name: "Task Memory writer" });
      await tx.insert(serverAdmission).values({ userId, admitted: true });
      await tx.insert(agents).values({
        id: productAgentId,
        handle: `task-memory-writer-${productAgentId}`,
      });
      await tx.insert(actors).values([
        {
          id: humanActorId,
          ownerId: userId,
          displayName: "Task Memory writer",
          trustState: "verified",
          kind: "user",
        },
        {
          id: agentActorId,
          ownerId: userId,
          displayName: "Task Memory writer Agent",
          trustState: "verified",
          kind: "agent",
          agentId: productAgentId,
        },
      ]);
      if (options.connectedExecution === true) {
        const [ownersGroup] = await tx.select({ id: groups.id }).from(groups)
          .where(eq(groups.type, "owners")).limit(2);
        if (ownersGroup === undefined) {
          throw new Error("Missing canonical owners Group");
        }
        await tx.insert(groupMembers).values({
          groupId: ownersGroup.id,
          userId,
          grantedBy: humanActorId,
        });
      }
      await tx.insert(namespaces).values([
        {
          id: namespaceValue,
          scope: "room",
          label: "Task Memory writer Namespace",
        },
        {
          id: seedNamespaceValue,
          scope: "room",
          label: "Task Memory seed Namespace",
        },
      ]);
      await tx.insert(rooms).values([
        {
          id: roomId,
          ownerId: userId,
          type: "private",
          label: "Task Memory writer private Room",
          graphThreadId: `task-memory-writer:${roomId}`,
          namespaceId: namespaceValue,
          humanActorIds: [humanActorId],
          kind: "private",
        },
        {
          id: seedRoomId,
          ownerId: userId,
          type: "group",
          label: "Task Memory seed Room",
          graphThreadId: `task-memory-seed:${seedRoomId}`,
          namespaceId: seedNamespaceValue,
          humanActorIds: [humanActorId],
          kind: "group",
        },
      ]);
      await tx.insert(roomMembers).values([
        { roomId, actorId: humanActorId, roomRole: "admin" },
        {
          roomId,
          actorId: agentActorId,
          roomRole: "member",
          agentResponseMode: "active",
        },
        { roomId: seedRoomId, actorId: humanActorId, roomRole: "admin" },
        {
          roomId: seedRoomId,
          actorId: agentActorId,
          roomRole: "member",
          agentResponseMode: "active",
        },
      ]);
      await tx.insert(humanCryptoCustodies).values({
        humanId: humanActorId,
        userId,
        humanActorId,
        initialInstallationLineageDigest: digest("installation-lineage"),
        state: "active",
        everInitializedAt: new Date(NOW),
        firstDeviceId: deviceId,
        currentRecoveryGeneration: 1,
        currentRecoveryPublicKeyDigest: crypto.hash(recovery.publicKey),
        revision: 1,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
      });
      await tx.insert(humanCryptoDevices).values({
        deviceId,
        humanId: humanActorId,
        userId,
        humanActorId,
        clientKind: "electron",
        installationLineageDigest: digest("installation-lineage"),
        deviceGeneration: 1,
        signingPublicKey: signing.publicKey,
        encryptionPublicKey: encryption.publicKey,
        publicFingerprint: crypto.hash(signing.publicKey),
        state: "active",
        authorizationKind: "first_bootstrap",
        recoveryGeneration: 1,
        authorizationEvidenceDigest: digest("device-authorization"),
        keyPackageGeneration: 1,
        keyPackageCount: 0,
        revision: 1,
        createdAt: new Date(NOW),
        activatedAt: new Date(NOW),
      });
      await tx.insert(humanCryptoRecoveryKeys).values({
        humanId: humanActorId,
        generation: 1,
        recoveryKeyId: `task-memory-recovery-${randomUUID()}`,
        formatVersion: 1,
        publicKey: recovery.publicKey,
        publicKeyDigest: crypto.hash(recovery.publicKey),
        archiveHash: digest("recovery-archive"),
        issuerDeviceId: deviceId,
        state: "current",
        activatedAt: new Date(NOW),
        revision: 1,
      });
      await tx.update(encryptionTransitionPolicy).set({
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW),
      }).where(eq(encryptionTransitionPolicy.id, "server"));
    });

    const [instance] = await admin.query.nautiloInstanceIdentity.findMany({
      where: (table, operators) => operators.eq(table.id, "self"),
      limit: 1,
    });
    if (instance === undefined) throw new Error("Missing QA instance identity");
    const membershipCoordinates = Object.freeze({
      serverInstanceId: instance.serverInstanceId,
      humanId: humanId(humanActorId),
      lineageGeneration: 1,
    });
    const group = new HumanDeviceOpenMlsGroup(crypto, managerVault, {
      coordinates: membershipCoordinates,
      ownCredential: {
        formatVersion: 1,
        ...membershipCoordinates,
        deviceId: cryptoDeviceId(deviceId),
        installationLineageDigest: digest("installation-lineage"),
        deviceKeyGeneration: 1,
      },
    });
    await group.initialize();
    const initialMembership = await group.createInitialState();
    const membershipRepository = new PostgresHumanDeviceGroupRepository(
      cryptoHandle,
      crypto,
    );
    expect(await membershipRepository.establishInitial({
      userId,
      humanId: humanActorId,
      deviceId,
      headBytes: encodeHumanDeviceGroupHead(initialMembership.head),
      rosterBytes: initialMembership.rosterBytes,
      now: NOW,
    })).toBe("created");

    const subject = Object.freeze({ userId, humanActorId, deviceId });
    const currentDevice = await new PostgresDeviceAdmissionRepository(
      cryptoHandle,
      crypto,
    ).currentAuthorityForDelegation(subject);
    if (currentDevice === null) throw new Error("Current device authority missing");
    const product = await createForegroundProductTransactionContext(
      { userId, agentId: productAgentId },
      productDb,
    );
    const agentProduct = await createForegroundProductTransactionContext(
      { userId, agentId: productAgentId },
      getSharedDirectAgentDb(),
    );
    const productAuthority = new PostgresNamespaceProductAuthority(
      canonicalProductConnection(product.canonicalRunner),
    );
    const domainRepository = new PostgresDomainKeyAuthorityRepository(
      restricted,
      crypto,
      SERVER_SCOPE,
    );
    const headPlan = await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
      use: (authority) => domainRepository.planHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        now: NOW + 1,
      }),
    });
    if (headPlan?.status !== "create_required") {
      throw new Error(
        `Task Memory Domain head plan was unavailable: ${
          headPlan === null ? "product_authority" : headPlan.status
        }`,
      );
    }
    domainIdValue = headPlan.domainId;
    domainKey = generateDomainKey(crypto);
    const head = prepareDomainKeyHead(crypto, {
      serverId: SERVER_SCOPE,
      cryptoDomainId: cryptoDomainId(headPlan.domainId),
      participantDigest: headPlan.participantDigest,
      participantCount: headPlan.participantCount,
      keyClass: headPlan.keyClass,
      domainKeyGeneration: headPlan.domainKeyGeneration,
      authorizationRevision: authorizationRevision(headPlan.authorizationRevision),
      previousHeadDigest: headPlan.previousHeadDigest,
      publicationOperationId: `task-memory-domain-head:${randomUUID()}`,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuedAt: headPlan.issuedAt,
      deadlineAt: headPlan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const deviceEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: head.head,
      headDigest: head.digest,
      recipient: {
        recipientHumanId: humanId(headPlan.issuerHumanId),
        recipientKind: "device",
        recipientKeyId: headPlan.issuerDeviceId,
        recipientKeyGeneration: headPlan.issuerDeviceSigningGeneration,
        recipientPublicKey: headPlan.recipientEncryptionPublicKey,
        recipientPublicKeyDigest: headPlan.recipientPublicKeyDigest,
      },
      domainKey,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const recoveryEnvelope = await prepareDomainKeyRecipientEnvelope(crypto, {
      head: head.head,
      headDigest: head.digest,
      recipient: {
        recipientHumanId: humanId(headPlan.issuerHumanId),
        recipientKind: "recovery",
        recipientKeyId: headPlan.recoveryKeyId,
        recipientKeyGeneration: headPlan.recoveryKeyGeneration,
        recipientPublicKey: headPlan.recoveryPublicKey,
        recipientPublicKeyDigest: headPlan.recoveryPublicKeyDigest,
      },
      domainKey,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const authorizeEnvelope = (
      envelope: typeof deviceEnvelope,
    ) => prepareDomainKeyRecipientAuthorization(crypto, {
      authorizationOperationId: head.head.publicationOperationId,
      reason: "head_establishment",
      requestDigest: null,
      envelopeBytes: envelope.bytes,
      envelopeDigest: envelope.digest,
      issuerHumanId: humanId(headPlan.issuerHumanId),
      issuerDeviceId: cryptoDeviceId(headPlan.issuerDeviceId),
      issuerDeviceSigningGeneration: headPlan.issuerDeviceSigningGeneration,
      issuedAt: headPlan.issuedAt,
      deadlineAt: headPlan.deadlineAt,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
    });
    const deviceAuthorization = authorizeEnvelope(deviceEnvelope);
    const recoveryAuthorization = authorizeEnvelope(recoveryEnvelope);
    expect((await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
      use: (authority) => domainRepository.publishHead({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
        operationId: head.head.publicationOperationId,
        idempotencyKey: `task-memory-domain-head-request:${randomUUID()}`,
        headBytes: head.bytes,
        envelopeBytes: deviceEnvelope.bytes,
        authorizationBytes: deviceAuthorization.bytes,
        recoveryEnvelopeBytes: recoveryEnvelope.bytes,
        recoveryAuthorizationBytes: recoveryAuthorization.bytes,
        now: NOW + 2,
      }),
    }))?.status).toBe("published");

    const currentDomainKey = domainKey;
    const publishNamespaceBundle = async (
      targetRoomId: string,
      targetNamespaceId: string,
    ) => {
      const bundlePlan = await productAuthority.withCurrentHumanAiReadableRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId: targetRoomId,
        namespaceId: targetNamespaceId,
        use: (authority) => domainRepository.planNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
        }),
      });
      if (bundlePlan?.status !== "create_required") {
        throw new Error("Task Memory Namespace bundle plan was unavailable");
      }
      const key = crypto.randomBytes(32);
      const namespaceHeadDigest = domainNamespaceGenerationHeadDigest(crypto, {
        serverId: SERVER_SCOPE,
        namespaceId: namespaceId(bundlePlan.namespaceId),
        keyClass: bundlePlan.keyClass,
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        generation: namespaceGeneration(0),
        previousHeadDigest: null,
        generationKey: key,
      });
      const retained = [Object.freeze({
        generation: namespaceGeneration(0),
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        headDigest: namespaceHeadDigest,
        generationKey: key,
      })];
      const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
        crypto,
        retained,
      );
      const bundle = prepareDomainNamespaceBundle(crypto, {
        operationId: `task-memory-domain-bundle:${randomUUID()}`,
        bundle: {
          formatVersion: 2,
          purpose: "domain_key.namespace_bundle",
          serverId: SERVER_SCOPE,
          cryptoDomainId: cryptoDomainId(bundlePlan.domainId),
          participantDigest: bundlePlan.participantDigest,
          participantCount: bundlePlan.participantCount,
          keyClass: bundlePlan.keyClass,
          domainKeyGeneration: bundlePlan.domainKeyGeneration,
          domainAuthorizationRevision: authorizationRevision(
            bundlePlan.domainAuthorizationRevision,
          ),
          domainHeadDigest: bundlePlan.domainHeadDigest,
          namespaceId: namespaceId(bundlePlan.namespaceId),
          namespaceAccessRevision: accessRevision(
            bundlePlan.namespaceAccessRevision,
          ),
          namespaceCurrentGeneration: namespaceGeneration(0),
          bundleRevision: bundlePlan.bundleRevision,
          retainedGenerationCount: retained.length,
          retainedAuthoritySetDigest: retainedDigest,
          retainedGenerations: retained,
        },
        previousBindingDigest: bundlePlan.previousBindingDigest,
        issuerHumanId: humanId(bundlePlan.issuerHumanId),
        issuerDeviceId: cryptoDeviceId(bundlePlan.issuerDeviceId),
        issuerDeviceSigningGeneration: bundlePlan.issuerDeviceSigningGeneration,
        issuerSigningPrivateKey: signing.privateKey,
        issuerSigningPublicKey: signing.publicKey,
        domainKey: currentDomainKey,
        issuedAt: NOW + 3,
      });
      expect((await productAuthority.withCurrentHumanAiReadableRoom({
        subjectUserId: userId,
        subjectHumanId: humanActorId,
        roomId: targetRoomId,
        namespaceId: targetNamespaceId,
        use: (authority) => domainRepository.publishNamespaceBundle({
          authority,
          keyClass: "ai",
          clientDeviceId: deviceId,
          operationId: bundle.binding.operationId,
          idempotencyKey: `task-memory-domain-bundle-request:${randomUUID()}`,
          bindingBytes: bundle.bytes,
          now: NOW + 4,
        }),
      }))?.status).toBe("published");
      return Object.freeze({
        namespaceId: targetNamespaceId,
        accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
        keyGeneration: namespaceGeneration(0),
        domainId: bundlePlan.domainId,
        domainKeyGeneration: bundlePlan.domainKeyGeneration,
        domainAuthorizationRevision: authorizationRevision(
          bundlePlan.domainAuthorizationRevision,
        ),
        domainHeadDigest: bundlePlan.domainHeadDigest.slice(),
        headDigest: retainedDigest.slice(),
        publicationDigest: retainedDigest.slice(),
        publicationSetDigest: retainedDigest.slice(),
        audienceFingerprint: retainedDigest.slice(),
        key,
      });
    };
    const originNamespace = await publishNamespaceBundle(
      roomId,
      namespaceValue,
    );
    namespaceKey = originNamespace.key;
    const seedNamespace = await publishNamespaceBundle(
      seedRoomId,
      seedNamespaceValue,
    );
    seedNamespaceKey = seedNamespace.key;
    const domainAuthority = await domainRepository.inspectForegroundAuthority({
      namespaceIds: [namespaceValue],
      keyClass: "ai",
      subjectHumanId: humanActorId,
      deviceId,
    });
    if (domainAuthority.status !== "ready") {
      throw new Error(`Task Memory Domain authority unavailable: ${domainAuthority.reason}`);
    }

    runtime = await prepareAgentRuntimeInitialization({
      crypto,
      operationId: `task-memory-runtime:${randomUUID()}`,
      agentId: agentId(productAgentId),
      authorizationRevision: authorizationRevision(7),
      configObjects: [{
        objectId: `task-memory-config:${randomUUID()}`,
        configRevision: authorizationRevision(1),
        plaintextDek: digest("task-memory-config-dek"),
      }],
      domains: options.connectedExecution === true ? [{
          domainId: cryptoDomainId(domainAuthority.domains[0]!.domainId),
          domainEpoch: domainEpoch(
            domainAuthority.domains[0]!.domainKeyGeneration,
          ),
          agentAuthorizationRevision: authorizationRevision(7),
          committerDeviceId: cryptoDeviceId(deviceId),
          domainRoot: domainKey,
          committerSigningPrivateKey: signing.privateKey,
        }] : [],
      resolveCurrentDomainCommitterAuthority: () =>
        options.connectedExecution === true ? signing.publicKey : null,
      manager: {
        managerHumanId: humanId(humanActorId),
        managerAuthorizationRevision: authorizationRevision(
          currentDevice.securityRevision,
        ),
        managerDeviceId: cryptoDeviceId(deviceId),
      },
      managerSigningPrivateKey: signing.privateKey,
      resolveCurrentManagerAuthority: () => signing.publicKey,
    });
    expect(await persistAgentRuntimeInitialization({
      crypto,
      storage: new PostgresLatticeStorage(cryptoHandle),
      prepared: runtime,
      resolveCurrentAuthorization: () => ({
        currentState: {
          agentId: agentId(productAgentId),
          authorizationRevision: authorizationRevision(7),
          runtimeGeneration: agentRuntimeGeneration(0),
        },
        currentManager: {
          managerHumanId: humanId(humanActorId),
          managerAuthorizationRevision: authorizationRevision(
            currentDevice.securityRevision,
          ),
          managerDeviceId: cryptoDeviceId(deviceId),
        },
        currentManagerSigningPublicKey: signing.publicKey,
        domains: options.connectedExecution === true ? [{
            domainId: cryptoDomainId(domainAuthority.domains[0]!.domainId),
            domainEpoch: domainEpoch(
              domainAuthority.domains[0]!.domainKeyGeneration,
            ),
            agentAuthorizationRevision: authorizationRevision(7),
            committerDeviceId: cryptoDeviceId(deviceId),
            committerSigningPublicKey: signing.publicKey,
          }] : [],
      }),
    })).toBe("inserted");
    destroyDomainKeyRecipientAuthorizationV2(recoveryAuthorization.authorization);
    destroyDomainKeyRecipientAuthorizationV2(deviceAuthorization.authorization);
    destroyDomainKeyRecipientEnvelopeV2(recoveryEnvelope.envelope);
    destroyDomainKeyRecipientEnvelopeV2(deviceEnvelope.envelope);
    destroyDomainKeyHeadV2(head.head);
    for (const value of [
      recoveryAuthorization.bytes,
      recoveryAuthorization.digest,
      deviceAuthorization.bytes,
      deviceAuthorization.digest,
      recoveryEnvelope.bytes,
      recoveryEnvelope.digest,
      deviceEnvelope.bytes,
      deviceEnvelope.digest,
      head.bytes,
      head.digest,
    ]) value.fill(0);

    return {
      admin,
      productDb,
      restricted,
      cryptoHandle,
      crypto,
      userId,
      humanActorId,
      productAgentId,
      namespaceValue,
      seedNamespaceValue,
      roomId,
      seedRoomId,
      deviceId,
      signingPrivateKey: signing.privateKey,
      subject,
      currentDevice,
      policyRevision,
      product,
      agentProduct,
      domainAuthority,
      domainSecret: Object.freeze({
        ...domainAuthority.domains[0]!,
        participantDigest: domainAuthority.domains[0]!.participantDigest.slice(),
        headDigest: domainAuthority.domains[0]!.headDigest.slice(),
        activeNamespaceBindingSetDigest:
          domainAuthority.domains[0]!.activeNamespaceBindingSetDigest.slice(),
        domainKey: domainKey.slice(),
      }) satisfies DomainForegroundSecretEntry,
      namespace: Object.freeze({
        ...originNamespace,
        domainHeadDigest: originNamespace.domainHeadDigest.slice(),
        headDigest: originNamespace.headDigest.slice(),
        publicationDigest: originNamespace.publicationDigest.slice(),
        publicationSetDigest: originNamespace.publicationSetDigest.slice(),
        audienceFingerprint: originNamespace.audienceFingerprint.slice(),
        key: originNamespace.key.slice(),
      }),
      seedNamespace,
      runtime,
      objectIds,
      memoryIds,
      requestIds,
      taskIds,
      jobIds,
      scopeIds,
      sessionThreadIds,
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Task Memory fixture setup and cleanup both failed",
      );
    }
    throw error;
  }
}

type ScenarioOptions = Readonly<{
  contentRepresentation?: "protected" | "dual";
  namespaceIds?: readonly string[];
  scopeMemory?: Readonly<{
    binding: TaskScopeMemoryBinding;
    targetRoomId: string;
    targetNamespace: TaskRuntimeAgentObjectNamespaceMaterial;
  }>;
}>;

async function createScenario(
  base: BaseFixture,
  options: ScenarioOptions = {},
) {
  const scopeMemory = options.scopeMemory;
  if (scopeMemory !== undefined && options.namespaceIds !== undefined) {
    throw new TypeError("Task Memory scenario authority is ambiguous");
  }
  const contentRepresentation = options.contentRepresentation ?? "protected";
  const targetRoomId = scopeMemory?.targetRoomId ?? base.roomId;
  const targetNamespace = scopeMemory?.targetNamespace ?? base.namespace;
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const jobId = randomUUID();
  const memoryId = randomUUID();
  const requestId = `task-run-authorization:${taskRunId}`;
  const inputObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "definition",
    taskId,
    contentRevision: 1,
  });
  const resultObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "run_result",
    taskId,
    taskRunId,
    contentRevision: 1,
  });
  const memoryObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId,
    contentRevision: 1,
  });
  const requiredFingerprint = fingerprintRequiredMemoryNamespaces([
    base.namespaceValue,
  ]);
  const startedAt = new Date(NOW - 1_000);
  const reference: ProtectedTaskJobReferenceV1 = Object.freeze({
    kind: "protected_task_run_v1",
    taskId,
    taskRunId,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: requestId,
    policyRevision: base.policyRevision,
    executionSegment: 1,
  });
  await base.admin.transaction(async (tx) => {
    await tx.insert(cryptoObjects).values({
      objectId: inputObjectId,
      payloadHash: digest(`task-payload:${taskId}`),
      payloadBytes: Uint8Array.of(1),
    });
    await tx.insert(tasks).values({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      prompt: "",
      scheduleKind: "now",
      callingRoomId: base.roomId,
      targetChat: targetRoomId === base.roomId
        ? "orphan"
        : "last_in_namespace",
      targetRoomId,
      targetUserIds: [base.userId],
      status: "running",
      useScope: scopeMemory !== undefined,
      scopeId: scopeMemory?.binding.scopeId ?? null,
    });
    await tx.insert(taskDefinitionCryptoRevisions).values({
      taskId,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      operationId: `task-memory-definition:${randomUUID()}`,
      requestDigest: digest(`task-request:${taskId}`),
      authorityFingerprint: digest(`task-authority:${taskId}`),
      requesterHumanId: base.humanActorId,
      anchorNamespaceId: base.namespaceValue,
      cryptoObjectId: inputObjectId,
      representation: contentRepresentation,
      requiredNamespaceFingerprint: requiredFingerprint,
      completion: "complete",
      disposition: "mapped",
      cryptoCompletedAt: new Date(NOW),
    });
    await tx.update(tasks).set({
      contentRepresentation,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: requiredFingerprint,
      cryptoMappingState: "verified",
    }).where(eq(tasks.id, taskId));
    await tx.insert(jobs).values({
      id: jobId,
      ownerId: base.userId,
      requestorId: base.userId,
      laneKey: `task:${taskId}`,
      roomId: targetRoomId,
      type: "foreground",
      status: "running",
      input: reference,
      startedAt,
    });
    await tx.insert(taskRuns).values({
      id: taskRunId,
      taskId,
      jobId,
      graphThreadId: `task:${taskId}:${taskRunId}`,
      status: "running",
      startedAt,
    });
  });
  base.taskIds.add(taskId);
  base.jobIds.add(jobId);
  base.objectIds.add(inputObjectId);
  base.objectIds.add(memoryObjectId);
  base.requestIds.add(requestId);

  const occurrence: ProtectedTaskRunningOccurrence = Object.freeze({
    task: Object.freeze({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      callingRoomId: base.roomId,
      scheduleKind: "now",
      contentRepresentation,
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: requiredFingerprint.slice(),
    }),
    run: Object.freeze({
      id: taskRunId,
      taskId,
      jobId,
      graphThreadId: `task:${taskId}:${taskRunId}`,
      status: "running",
      startedAt,
    }),
  });
  const availableNamespaces = new Map<
    string,
    TaskRuntimeAgentObjectNamespaceMaterial
  >([
    [base.namespace.namespaceId, base.namespace],
    [base.seedNamespace.namespaceId, base.seedNamespace],
  ]);
  const requiredNamespaceIds = scopeMemory === undefined
    ? [...(options.namespaceIds ?? [base.namespaceValue])]
    : [...scopeMemory.binding.readableNamespaceIds];
  const namespaceRequirements = Object.freeze(requiredNamespaceIds
    .sort()
    .map((requiredNamespaceId, ordinal) => {
      const namespace = availableNamespaces.get(requiredNamespaceId);
      if (namespace === undefined) {
        throw new Error("Task Memory scenario Namespace is unavailable");
      }
      return Object.freeze({
        ordinal,
        namespaceId: requiredNamespaceId,
        domainId: namespace.domainId,
        operations: scopeMemory === undefined
            || requiredNamespaceId === base.namespaceValue
            || requiredNamespaceId === targetNamespace.namespaceId
          ? Object.freeze(["decrypt", "encrypt"] as const)
          : Object.freeze(["decrypt"] as const),
        expectedAccessRevision: namespace.accessRevision,
        expectedPolicyRevision: base.policyRevision,
      });
    }));
  const scenarioDomainAuthority = scopeMemory === undefined
      && requiredNamespaceIds.length === 1
      && requiredNamespaceIds[0] === base.namespaceValue
    ? base.domainAuthority
    : await new PostgresDomainKeyAuthorityRepository(
      base.restricted,
      base.crypto,
      SERVER_SCOPE,
    ).inspectForegroundAuthority({
      namespaceIds: [...requiredNamespaceIds],
      keyClass: "ai",
      subjectHumanId: base.humanActorId,
      deviceId: base.deviceId,
    });
  if (scenarioDomainAuthority.status !== "ready"
    || scenarioDomainAuthority.domains.length !== 1) {
    throw new Error("Task Memory scenario Domain authority is unavailable");
  }
  const scenarioDomain = scenarioDomainAuthority.domains[0]!;
  const scenarioDomainSecret = Object.freeze({
    ...scenarioDomain,
    participantDigest: scenarioDomain.participantDigest.slice(),
    headDigest: scenarioDomain.headDigest.slice(),
    activeNamespaceBindingSetDigest:
      scenarioDomain.activeNamespaceBindingSetDigest.slice(),
    domainKey: base.domainSecret.domainKey,
  }) satisfies DomainForegroundSecretEntry;
  const domainRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    domainId: scenarioDomain.domainId,
    expectedEpoch: scenarioDomain.domainKeyGeneration,
    expectedAuthorizationRevision: scenarioDomain.authorizationRevision,
  })]);
  const stableIdentity = Object.freeze({
    taskId,
    taskRunId,
    executionSegment: 1,
    resumeContinuationFingerprint: null,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    callingRoomId: base.roomId,
    scheduleKind: "now" as const,
    graphThreadId: occurrence.run.graphThreadId,
    startedAt: startedAt.getTime(),
    sourceRoomId: base.roomId,
    targetRoomId,
    targetUserIds: [base.userId],
    outputRoomId: targetRoomId,
    outputNamespaceId: base.namespaceValue,
    memoryMode: scopeMemory === undefined ? "namespace" as const : "scope" as const,
    scopeId: scopeMemory?.binding.scopeId ?? null,
    contentRepresentation,
    contentNamespaceId: base.namespaceValue,
    contentRevision: 1,
    contentObjectId: inputObjectId,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: Buffer.from(requiredFingerprint).toString(
      "base64url",
    ),
  });
  const scopeWorkIdentity = scopeMemory === undefined ? null : JSON.stringify({
    taskId,
    taskRunId,
    targetRoomId,
    scopeMemory: scopeMemory.binding,
  });
  const initialSnapshot = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId,
    workId: taskRunId,
    namespaceId: base.namespaceValue,
    now: NOW,
  });
  const idempotencyKey = taskRuntimeStableIdempotencyKey(stableIdentity);
  const initial: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    snapshot: initialSnapshot,
    workIdentityHash: base.crypto.hash(new TextEncoder().encode(
      scopeWorkIdentity ?? idempotencyKey,
    )),
    idempotencyKey,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: base.domainSecret.domainId,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: base.domainSecret.domainKeyGeneration,
    expectedNamespaceAccessRevision: base.namespace.accessRevision,
    expectedPolicyRevision: base.policyRevision,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: { namespaceRequirements, domainRequirements },
  };
  const recipient = await base.crypto.generateEncryptionKeyPair();
  const recipientKeyId = `task-memory-recipient:${randomUUID()}`;
  const plan = createDomainForegroundAuthorizationPlan(base.crypto, {
    authorizationId: requestId,
    policyRevision: base.policyRevision,
    sessionId: `task-run:${taskRunId}`,
    roomId: base.roomId,
    subjectHumanId: humanId(base.humanActorId),
    committerDeviceId: cryptoDeviceId(base.deviceId),
    committerDeviceSigningGeneration: base.currentDevice.deviceGeneration,
    hostAuthorizationRevision: authorizationRevision(
      base.currentDevice.securityRevision,
    ),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: initial.snapshot.recipientGeneration,
    recipientKeyId,
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: EXPIRES_AT,
    maximumSecretBytes: 2_048,
    domains: scenarioDomainAuthority.domains,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId,
    workId: taskRunId,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: initial.snapshot.recipientGeneration,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const descriptorBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    request,
  );
  const attached: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: hexDigest(descriptorBytes),
      recipientKeyId,
      recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
      expiresAt: EXPIRES_AT,
      now: NOW + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes,
  };
  const repository = new PostgresBackgroundAuthorizationRepository(
    base.cryptoHandle,
  );
  expect((await repository.create(initial)).status).toBe("created");
  const attachedResult = await repository.compareAndSwap({
    expectedRequestRevision: initial.snapshot.requestRevision,
    next: attached,
  });
  if (attachedResult.status !== "updated") {
    throw new Error("Task Memory recipient attachment lost its CAS");
  }
    const authorization = await mintDomainForegroundAuthorization(base.crypto, {
    plan,
    domains: [Object.freeze({
      ...base.domainSecret,
      sourceNamespaceId: scenarioDomain.sourceNamespaceId,
    })],
    committerDeviceSigningPrivateKey: base.signingPrivateKey,
    recipientEncryptionPublicKey: recipient.publicKey,
  });
  const responseBytes = serializeDomainForegroundAuthorizationV2(authorization);
  const responseHash = base.crypto.hash(responseBytes);
  const issuerSigningPublicKeyHash = base.crypto.hash(
    base.currentDevice.signingPublicKey,
  );
  try {
    const verified = verifyDomainForegroundAuthorizationV2(base.crypto, {
      authorizationBytes: responseBytes,
      now: NOW + 2,
      current: {
        authorizationId: plan.authorizationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration:
          plan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey:
          base.currentDevice.signingPublicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientKind: plan.recipientKind,
        recipientPrincipalId: plan.recipientPrincipalId,
        recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
        recipientKeyId: plan.recipientKeyId,
        recipientAuthorized: true,
        domains: scenarioDomainAuthority.domains,
      },
    });
    if (verified.status !== "verified") {
      throw new Error("Task Memory signed authorization did not verify");
    }
    const accepted = await repository.acceptVerifiedResponse({
      response: {
        formatVersion: 3,
        kind: "runtime",
        requestId,
        descriptorHash: base.crypto.hash(descriptorBytes),
        descriptorBytes: descriptorBytes.slice(),
        recipientGeneration: initial.snapshot.recipientGeneration,
        recipientKeyId,
        recipientPublicKey: recipient.publicKey.slice(),
        workId: taskRunId,
        workKind: initial.workKind,
        purpose: initial.purpose,
        authoritySet: initial.authoritySet,
        responseBytes: responseBytes.slice(),
        responseHash: responseHash.slice(),
        authorizationId: plan.authorizationId,
        authorizationHash: responseHash.slice(),
        issuingHumanId: base.humanActorId,
        issuingDeviceId: base.deviceId,
        issuingDeviceAuthorizationRevision:
          base.currentDevice.securityRevision,
        issuerSigningPublicKeyHash: issuerSigningPublicKeyHash.slice(),
        issuedAt: plan.issuedAt,
        expiresAt: plan.deadlineAt,
      },
      acceptedAt: NOW + 2,
    });
    if (accepted.status !== "accepted") {
      throw new Error("Task Memory authorization response was not accepted");
    }
    const acceptedRecord = accepted.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const claimed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...acceptedRecord,
      snapshot: claimBackgroundAuthorizationRequest(
        acceptedRecord.snapshot,
        `task-memory-claim:${randomUUID()}`,
        NOW + 3,
        EXPIRES_AT,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const claimedResult = await repository.compareAndSwap({
      expectedRequestRevision: acceptedRecord.snapshot.requestRevision,
      next: claimed,
    });
    if (claimedResult.status !== "updated") {
      throw new Error("Task Memory claim lost its CAS");
    }
    const storedClaimed = claimedResult.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const running: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...storedClaimed,
      snapshot: markBackgroundAuthorizationRunning(
        storedClaimed.snapshot,
        NOW + 4,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const runningResult = await repository.compareAndSwap({
      expectedRequestRevision: storedClaimed.snapshot.requestRevision,
      next: running,
    });
    if (runningResult.status !== "updated") {
      throw new Error("Task Memory running claim lost its CAS");
    }
    const record = runningResult.record as
      BackgroundAuthorizationTaskRuntimeRecordV3;
    const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
      requestId,
      workId: taskRunId,
      claimId: record.snapshot.claimId!,
      claimExpiresAt: record.snapshot.claimExpiresAt!,
      recipientExpiresAt: record.snapshot.recipient!.expiresAt,
      expiresAt: EXPIRES_AT,
      recipientGeneration: record.snapshot.recipientGeneration,
      recipientKeyId,
      authorizationDigest: responseHash.slice(),
      policyRevision: base.policyRevision,
      episodeId: plan.sessionId,
      sourceRoomId: base.roomId,
      hostAuthorizationRevision: base.currentDevice.securityRevision,
      recipientAuthorizationRevision: 0,
      result: {
        taskId,
        taskRunId,
        contentRevision: 1,
        objectId: resultObjectId,
        signerAgentId: base.productAgentId,
        namespace: {
          namespaceId: base.namespace.namespaceId,
          domainId: base.namespace.domainId,
          operations: ["encrypt"],
          expectedAccessRevision: base.namespace.accessRevision,
          expectedPolicyRevision: base.policyRevision,
        },
      },
      domainRequirements: scenarioDomainAuthority.domains,
      namespaceRequirements,
    };
    const writerInput = (
      evidence: TaskRuntimeExecutionEvidence,
      now: () => number,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ): ProtectedTaskMemoryObjectWriterInput => ({
      runner,
      restricted,
      crypto: base.crypto,
      serverScope: SERVER_SCOPE,
      subject: base.subject,
      occurrence,
      record,
      request,
      evidence,
      jobId,
      executionRoomId: targetRoomId,
      ...(scopeMemory === undefined ? {} : {
        scopeMemory: Object.freeze({
          binding: scopeMemory.binding,
          targetRoomId: scopeMemory.targetRoomId,
          workIdentity: scopeWorkIdentity!,
        }),
      }),
      reference,
      now,
      signal: new AbortController().signal,
    });
    const withAuthority = <Value>(
      now: () => number,
      use: (input: Readonly<{
        evidence: TaskRuntimeExecutionEvidence;
        writer: ProtectedTaskMemoryObjectWriterInput;
      }>) => Promise<Value>,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW + 5,
      execute: (evidence) => use(Object.freeze({
        evidence,
        writer: writerInput(evidence, now, restricted, runner),
      })),
    });
    const withPreparedWrite = <Value>(
      now: () => number,
      use: (input: Readonly<{
        evidence: TaskRuntimeExecutionEvidence;
        writer: ProtectedTaskMemoryObjectWriterInput;
        write: ProtectedTaskMemoryObjectWrite;
      }>) => Promise<Value>,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withAuthority(now, async ({ evidence, writer }) => {
        const plaintextBytes = encodeMemoryPayloadV1({
          formatVersion: 1,
          type: "fact",
          content: `sealed Task Memory ${memoryId}`,
        });
        try {
          return await use(Object.freeze({
            evidence,
            writer,
            write: Object.freeze({
              memoryId,
              contentRevision: 1,
              operationId: `task-memory-object-write:${memoryId}`,
              prepared: prepareTaskRuntimeAgentObject({
                crypto: base.crypto,
                evidence,
                objectId: memoryObjectId,
                objectType: MEMORY_OBJECT_TYPE,
                plaintextBytes,
                createdAt: NOW + 5,
                namespaceSet: [targetNamespace],
                operationId: `task-memory-object-write:${memoryId}`,
                runtime: base.runtime.runtime,
                signerPublication: base.runtime.signerPublication,
                resolveHistoricalSignerPublicationManager: () =>
                  base.currentDevice.signingPublicKey,
                agentAuthorizationRevision: 7,
              }),
            }),
          }));
        } finally {
          plaintextBytes.fill(0);
        }
      }, restricted, runner);
    const execute = (
      now: () => number,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withPreparedWrite(
      now,
      ({ writer, write }) => persistProtectedTaskMemoryObject(writer, write),
      restricted,
      runner,
    );
    return Object.freeze({
      taskId,
      taskRunId,
      memoryObjectId,
      requestId,
      domainSecret: scenarioDomainSecret,
      execute,
      withAuthority,
      withPreparedWrite,
    });
  } finally {
    recipient.privateKey.fill(0);
    responseBytes.fill(0);
    responseHash.fill(0);
    issuerSigningPublicKeyHash.fill(0);
    destroyDomainForegroundAuthorizationV2(authorization);
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

type FallbackPrepareRequest = Parameters<
  ReturnType<typeof createTaskRuntimeDomainMemoryCryptoSession>["session"]["prepare"]
>[0];

function createUnavailableMemorySession(
  onPrepare: (request: FallbackPrepareRequest) => Promise<void> =
    () => Promise.resolve(),
): typeof createTaskRuntimeDomainMemoryCryptoSession {
  return input => {
    const current = createTaskRuntimeDomainMemoryCryptoSession(input);
    return Object.freeze({
      ...current,
      session: Object.freeze({
        ...current.session,
        prepare: async (request: FallbackPrepareRequest) => {
          await onPrepare(request);
          return Object.freeze({
            status: "unavailable" as const,
            reason: "encryption_pending" as const,
          });
        },
      }),
    });
  };
}

function withShadowFallbackRepository<Value>(input: Readonly<{
  base: BaseFixture;
  scenario: Awaited<ReturnType<typeof createScenario>>;
  writer: ProtectedTaskMemoryObjectWriterInput;
  authority: ProtectedMemoryAuthority;
  vector: readonly number[];
  execute(repository: ProtectedAgentMemoryRepository): Promise<Value>;
  onPrepare?: (request: FallbackPrepareRequest) => Promise<void>;
}>): Promise<Value> {
  return withProtectedTaskNativeMemoryRepository({
    authority: input.authority,
    policy: Object.freeze({
      mode: "shadow_encryption" as const,
      shadowBehavior: "fallback" as const,
      revision: input.base.policyRevision,
    }),
    current: input.writer,
    domains: Object.freeze([input.scenario.domainSecret]),
    signer: Object.freeze({
      agentAuthorizationRevision: 7,
      runtime: input.base.runtime.runtime,
      signerPublication: input.base.runtime.signerPublication,
    }),
    resolveHistoricalSignerPublicationManager: () =>
      input.base.currentDevice.signingPublicKey,
    product: input.base.product,
    agentProduct: input.base.agentProduct,
    owner: bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => Object.freeze({
          policy: Object.freeze({
            mode: "shadow_encryption" as const,
            shadowBehavior: "fallback" as const,
          }),
          revalidationToken: input.base.policyRevision,
        }),
        revalidate: async token => {
          if (token !== input.base.policyRevision) {
            throw new TypeError("Task Memory policy token changed");
          }
        },
      },
    }),
    embedding: Object.freeze({
      embed: async () => Object.freeze({
        status: "success" as const,
        value: Object.freeze({
          vector: Object.freeze([...input.vector]),
          provider: "openai" as const,
          canonicalModel: "text-embedding-3-small",
          dimensions: 1536 as const,
          contractVersion: 1,
        }),
      }),
    }),
    execute: input.execute,
  }, {
    createSession: createUnavailableMemorySession(input.onPrepare),
  });
}

async function objectRowCounts(
  base: BaseFixture,
  objectId: string,
): Promise<Readonly<{
  payload: number;
  head: number;
  manifest: number;
  envelope: number;
}>> {
  const [payload, head, manifest, envelope] = await Promise.all([
    base.admin.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
      .where(eq(cryptoObjects.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoAccessHeads.objectId })
      .from(objectCryptoAccessHeads)
      .where(eq(objectCryptoAccessHeads.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoAccessManifests.objectId })
      .from(objectCryptoAccessManifests)
      .where(eq(objectCryptoAccessManifests.objectId, objectId)),
    base.admin.select({ objectId: objectCryptoNamespaceEnvelopes.objectId })
      .from(objectCryptoNamespaceEnvelopes)
      .where(eq(objectCryptoNamespaceEnvelopes.objectId, objectId)),
  ]);
  return Object.freeze({
    payload: payload.length,
    head: head.length,
    manifest: manifest.length,
    envelope: envelope.length,
  });
}

async function createConnectedProtectedTask(base: BaseFixture) {
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const graphThreadId = `subagent:task:${taskId}:${taskRunId}`;
  const coordinate = Object.freeze({
    kind: "definition" as const,
    taskId,
    contentRevision: 1,
  });
  const cryptoObjectId = deriveTaskContentCryptoObjectIdV1(coordinate);
  const authority = Object.freeze({
    authorityVersion: 1 as const,
    kind: "requester_private_namespace" as const,
    keyClass: "ai" as const,
    requesterHumanId: base.humanActorId,
    namespaceId: base.namespaceValue,
    domainId: base.domainSecret.domainId,
    expectedAccessRevision: base.namespace.accessRevision,
    expectedPolicyRevision: base.policyRevision,
  });
  const encrypted = encryptObjectPayload(base.crypto, {
    objectId: objectId(cryptoObjectId),
    keyClass: "ai",
    objectType: taskContentObjectTypeV1(coordinate),
    createdAt: unixTimestamp(NOW + 10),
  }, encodeTaskPayloadV1({
    formatVersion: 1,
    prompt: "Complete the connected protected Task",
    expectedOutput: null,
    protectedMetadata: {},
  }));
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(base.crypto, base.namespace.key, {
      objectId: objectId(cryptoObjectId),
      namespaceId: namespaceId(base.namespaceValue),
      keyClass: "ai",
      keyGeneration: base.namespace.keyGeneration,
      bindingRevisionAtWrap: base.namespace.accessRevision,
    }, encrypted.dek),
  );
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(base.crypto, {
    objectId: cryptoObjectId,
    payloadHash: base.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(base.humanActorId),
    committerDeviceId: cryptoDeviceId(base.deviceId),
    hostAuthorizationRevision: authorizationRevision(
      base.currentDevice.securityRevision,
    ),
    committerSigningPublicKey: base.currentDevice.signingPublicKey,
    committerSigningPrivateKey: base.signingPrivateKey,
  });
  const prepared = createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device",
    coordinate,
    authority,
    object: encryptedObjectWriteRecord(payloadBytes),
    access,
  });
  const classified = classifyProtectedTaskMetadataV1({});
  if (classified.status !== "supported") {
    throw new Error("Empty protected Task metadata was not supported");
  }
  const repository = createDormantTaskContentShadowRepository({
    product: new PostgresTaskContentProductStore(
      base.product.handle,
      () => authority,
    ),
    crypto: createPostgresTaskContentCryptoCompletion({
      handle: base.cryptoHandle,
      crypto: base.crypto,
      resolveCurrentAuthority: () => Promise.resolve(authority),
      resolveHistoricalAgentSignerAuthority: () => null,
      resolveHistoricalHumanDeviceSigningPublicKey: () =>
        Promise.resolve(base.currentDevice.signingPublicKey.slice()),
    }),
  });
  base.taskIds.add(taskId);
  base.objectIds.add(cryptoObjectId);
  base.requestIds.add(`task-run-authorization:${taskRunId}`);
  base.sessionThreadIds.add(graphThreadId);
  expect(await repository.reserveRevision({
    operationId: `connected-task-definition:${taskId}`,
    requestDigest: base.crypto.hash(new TextEncoder().encode(
      `connected-task-definition:${taskId}`,
    )),
    representation: "protected",
    authority,
    prepared,
    operationalMetadata: classified.operational,
  })).toMatchObject({ status: "reserved" });
  await base.admin.insert(tasks).values({
    id: taskId,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    prompt: "",
    preset: "in_background",
    scheduleKind: "now",
    callingRoomId: base.roomId,
    targetChat: "last_in_namespace",
    targetRoomId: base.roomId,
    targetUserIds: [base.userId],
    useScope: false,
    toolsMode: "none",
    fundingMode: "legacy_server",
    status: "pending",
    metadata: classified.operational,
  });
  expect(await repository.completeRevision({ coordinate, prepared }))
    .toMatchObject({ status: "mapped" });
  const startedAt = new Date(NOW);
  await base.admin.transaction(async tx => {
    await tx.update(tasks).set({ status: "awaiting" })
      .where(eq(tasks.id, taskId));
    await tx.insert(taskRuns).values({
      id: taskRunId,
      taskId,
      graphThreadId,
      status: "awaiting",
      startedAt,
    });
  });
  return Object.freeze({
    taskId,
    taskRunId,
    graphThreadId,
    startedAt,
    inputObjectId: cryptoObjectId,
    resultObjectId: deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId,
      taskRunId,
      contentRevision: 1,
    }),
  });
}

async function waitForConnectedCompletion(
  base: BaseFixture,
  taskRunId: string,
  terminalStatus: Promise<void>,
): Promise<Readonly<{
  run: typeof taskRuns.$inferSelect;
  job: typeof jobs.$inferSelect;
}>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Real crypto and database work has no ten-second product SLA. Wait for
    // the test's durable status sink rather than continuously polling the DB.
    await Promise.race([
      terminalStatus,
      new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const [run] = await base.admin.select().from(taskRuns)
    .where(eq(taskRuns.id, taskRunId));
  const [job] = run?.jobId ? await base.admin.select().from(jobs)
    .where(eq(jobs.id, run.jobId)) : [];
  if (run !== undefined && job !== undefined
    && ["completed", "failed", "cancelled", "timed_out"].includes(job.status)) {
    return Object.freeze({ run, job });
  }
  throw new Error(`Connected protected Task did not settle: ${JSON.stringify({
    runStatus: run?.status, resultRevision: run?.resultRevision,
    resultMapping: run?.resultCryptoMappingState, jobStatus: job?.status,
    jobStarted: job?.startedAt !== null && job?.startedAt !== undefined,
  })}`);
}

async function waitForConnectedRelease(
  base: BaseFixture,
  requestId: string,
  recipients: TaskRuntimeRecipientRegistry,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [request] = await base.admin.select({
      state: backgroundCryptoAuthorizationRequests.state,
    }).from(backgroundCryptoAuthorizationRequests).where(eq(
      backgroundCryptoAuthorizationRequests.requestId,
      requestId,
    ));
    if (request?.state === "completed" && recipients.size === 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Connected protected Task did not release grant custody");
}

async function loadConnectedDomainSecrets(
  base: BaseFixture,
  requestId: string,
): Promise<readonly DomainForegroundSecretEntry[]> {
  const requirements = await base.admin.select({
    ordinal: backgroundCryptoAuthorizationNamespaceRequirements.ordinal,
    namespaceId:
      backgroundCryptoAuthorizationNamespaceRequirements.namespaceId,
  }).from(backgroundCryptoAuthorizationNamespaceRequirements).where(eq(
    backgroundCryptoAuthorizationNamespaceRequirements.requestId,
    requestId,
  ));
  requirements.sort((left, right) => left.ordinal - right.ordinal);
  const authority = await new PostgresDomainKeyAuthorityRepository(
    base.restricted,
    base.crypto,
    SERVER_SCOPE,
  ).inspectForegroundAuthority({
    namespaceIds: requirements.map(requirement => requirement.namespaceId),
    keyClass: "ai",
    subjectHumanId: base.humanActorId,
    deviceId: base.deviceId,
  });
  if (authority.status !== "ready") {
    throw new Error(
      `Connected protected Task Domain authority unavailable: ${authority.reason}`,
    );
  }
  return Object.freeze(authority.domains.map(domain => {
    if (domain.domainId !== base.domainSecret.domainId) {
      throw new Error("Connected protected Task Domain key is unavailable");
    }
    return Object.freeze({
      domainId: domain.domainId,
      sourceNamespaceId: domain.sourceNamespaceId,
      participantDigest: domain.participantDigest.slice(),
      participantCount: domain.participantCount,
      keyClass: domain.keyClass,
      domainKeyGeneration: domain.domainKeyGeneration,
      authorizationRevision: domain.authorizationRevision,
      headDigest: domain.headDigest.slice(),
      domainKey: base.domainSecret.domainKey.slice(),
    });
  }));
}

function destroyConnectedDomainSecrets(
  domains: readonly DomainForegroundSecretEntry[],
): void {
  for (const domain of domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.domainKey.fill(0);
  }
}

describePostgres("sealed protected Task Memory object writer", () => {
  test.each(["result", "pre-execution recovery", "cancellation recovery", "linked cancellation"] as const)("executes one genuine-role protected Task through %s", async scenario => {
    const base = await createBaseFixture({ connectedExecution: true });
    const recipients = new TaskRuntimeRecipientRegistry(base.crypto, {
      now: () => NOW,
    });
    let testError: unknown;
    let cleanupError: unknown;
    let connected: Awaited<ReturnType<
      typeof createConnectedProtectedTask
    >> | null = null;
    let connectedJobId: string | null = null;
    let jobManager: JobManager | null = null;
    try {
      connected = await createConnectedProtectedTask(base);
      const segmentCalls: Array<Readonly<{
        taskId: string;
        taskRunId: string;
        graphThreadId: string;
      }>> = [];
      const nativeErrors: Array<Readonly<{
        stage:
          | "prepare"
          | "open"
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint"
          | "execute"
          | "publish_result";
        name: string;
        message: string;
      }>> = [];
      const recordNativeError = (
        stage:
          | "prepare"
          | "open"
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint"
          | "execute"
          | "publish_result",
        error: unknown,
      ): void => {
        nativeErrors.push(Object.freeze({
          stage,
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error
            ? error.message
            : "Non-Error failure",
        }));
      };
      const traceNative = async <Value>(
        stage:
          | "definition"
          | "context"
          | "transcript"
          | "memory"
          | "checkpoint",
        operation: () => Value | Promise<Value>,
      ): Promise<Value> => {
        try {
          return await operation();
        } catch (error) {
          recordNativeError(stage, error);
          throw error;
        }
      };
      let notifyTerminal!: () => void;
      const terminalStatus = new Promise<void>(resolve => { notifyTerminal = resolve; });
      jobManager = new JobManager({
        laneLock: new InMemoryLaneLock(),
        persist: async payload => {
          const jobId = await persistJobWithDatabase(base.productDb, payload);
          connectedJobId = jobId;
          base.jobIds.add(jobId);
          return jobId;
        },
        startProtectedTaskJob: async (
          jobId,
          expectedReference,
          publicationPolicy,
        ) => {
          if (scenario === "linked cancellation") {
            expect(await transitionTaskLifecycleTerminal(base.productDb, {
              taskId: expectedReference.taskId,
              taskStatus: "cancelled",
              taskPatch: { cancelledAt: new Date(NOW) },
              runStatus: "cancelled",
            })).toMatchObject({ transitioned: true,
              task: { status: "cancelled" },
              run: { status: "cancelled", jobId } });
          }
          return startProtectedTaskJobWithDatabase(
            base.productDb, jobId, expectedReference, publicationPolicy,
          );
        },
        updateStatus: async (jobId, status, fields, publicationPolicy) => {
          await updateJobStatusWithDatabase(
            base.productDb, jobId, status, fields, publicationPolicy,
          );
          if (jobId === connectedJobId
            && ["completed", "failed", "cancelled", "timed_out"].includes(status)) {
            notifyTerminal();
          }
        },
      });
      const owner = bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: {
              mode: "encrypted_only" as const,
              shadowBehavior: "strict" as const,
            },
            revalidationToken: base.policyRevision,
          }),
          revalidate: token => {
            if (token !== base.policyRevision) {
              throw new Error("Protected Task policy changed");
            }
            return Promise.resolve();
          },
        },
      });
      let kicks = 0;
      const composition = await createProductionProtectedTaskRuntimeInitialComposition({
        db: base.productDb,
        resolver: new PersonalPolicyResolver(
          base.userId,
          base.productAgentId,
        ),
        convergeCreatedRoomCatalog: async () => undefined,
        owner,
        recipients,
        jobManager,
        kick: () => {
          kicks += 1;
        },
        restricted: base.restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        now: () => NOW,
      }, {
        nativeExecution: input => {
          const native = createProductionProtectedTaskNativeExecution(input, {
            segment: segmentInput => createProtectedTaskNativeFixedMemorySegment({
              ...segmentInput,
              resolveExecutionContext: context => traceNative(
                "context",
                () => segmentInput.resolveExecutionContext(context),
              ),
              createTranscriptPublisher: publisher => traceNative(
                "transcript",
                () => segmentInput.createTranscriptPublisher(publisher),
              ),
            },
              {
                openDefinition: definition => traceNative(
                  "definition",
                  () => withNativeProtectedTaskDefinitionV1(definition),
                ),
                withMemoryRepository: memory => traceNative(
                  "memory",
                  () => withProtectedTaskNativeMemoryRepository(memory),
                ),
                withCheckpointSaver: checkpoint => traceNative(
                  "checkpoint",
                  () => withNativeProtectedTaskCheckpointSaver(checkpoint),
                ),
                runSegment: async segment => {
                  segment.signal.throwIfAborted();
                  expect(segment.execution.brief)
                    .toBe("Complete the connected protected Task");
                  segmentCalls.push(Object.freeze({
                    taskId: segment.taskId,
                    taskRunId: segment.taskRunId,
                    graphThreadId: segment.graphThreadId,
                  }));
                  return Object.freeze({
                    formatVersion: 1 as const,
                    resultText: "Connected protected result",
                    lastError: null,
                  });
                },
              },
            ),
          });
          return Object.freeze({
            prepareExecution: async preparation => {
              let prepared: Awaited<ReturnType<typeof native.prepareExecution>>;
              try {
                prepared = await native.prepareExecution(preparation);
              } catch (error) {
                recordNativeError("prepare", error);
                throw error;
              }
              const executor: typeof prepared.executor = async function* (
                ...args: Parameters<typeof prepared.executor>
              ) {
                try {
                  yield* prepared.executor(...args);
                } catch (error) {
                  recordNativeError("execute", error);
                  throw error;
                }
              };
              const openTransientInput: typeof prepared.openTransientInput =
                async grant => {
                  try {
                    if (scenario === "pre-execution recovery") {
                      throw new Error("synthetic protected setup failure");
                    }
                    return await prepared.openTransientInput(grant);
                  } catch (error) {
                    recordNativeError("open", error);
                    throw error;
                  }
                };
              return Object.freeze({ executor, openTransientInput });
            },
            publishResult: async publication => {
              try {
                await native.publishResult(publication);
              } catch (error) {
                recordNativeError("publish_result", error);
                throw error;
              }
            },
          });
        },
      });
      const occurrence = await loadInitialProtectedTaskOccurrence(
        base.productDb,
        {
          taskRunId: connected.taskRunId,
          authorizationRequestId:
            `task-run-authorization:${connected.taskRunId}`,
        },
      );
      if (occurrence === null) {
        throw new Error("Connected protected Task occurrence was unavailable");
      }
      const [currentPolicy, requesterHuman, requesterPrivateRoom] =
        await Promise.all([
          getEncryptionTransitionPolicy(base.productDb),
          findActorByOwnerId(base.userId),
          createProtectedTaskRequesterPrivateRoomResolver(base.productDb)(
            base.userId,
            base.productAgentId,
            base.namespaceValue,
          ),
        ]);
      expect(currentPolicy).toMatchObject({
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: base.policyRevision,
      });
      expect(requesterHuman?.id).toBe(base.humanActorId);
      expect(requesterPrivateRoom).toEqual({
        roomId: base.roomId,
        namespaceId: base.namespaceValue,
      });
      await composition.coordinator.observeProtectedTaskOccurrence(occurrence);
      expect(recipients.size).toBe(0);

      const deviceService = createProductionBackgroundAuthorizationComposition({
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        now: () => NOW,
        restricted: () => base.restricted,
        bindTaskRecipient: composition.bindTaskRecipient,
        withTaskAuthority: composition.withTaskAuthority,
        isTaskRecipientActive: composition.isTaskRecipientActive,
        wakeProtectedTask: composition.wakeProtectedTask,
      });
      const subject = Object.freeze({
        ...base.subject,
        admission: Object.freeze({
          deviceId: base.currentDevice.deviceId,
          deviceGeneration: base.currentDevice.deviceGeneration,
          serverInstanceId: base.currentDevice.serverInstanceId,
          lineageGeneration: base.currentDevice.lineageGeneration,
          epoch: base.currentDevice.epoch,
          securityRevision: base.currentDevice.securityRevision,
          headDigest: base.currentDevice.headDigest.slice(),
          expiresAt: NOW + 60_000,
        }),
      });
      const page = await deviceService.list(subject, {});
      expect(recipients.size).toBe(1);
      let selected: ReturnType<
        typeof decodeTaskRuntimeBackgroundAuthorizationRequestV1
      > = null;
      let selectedBytes: Uint8Array | null = null;
      for (const candidate of page.requests) {
        const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
          candidate.requestBytes,
        );
        if (decoded?.workId === connected.taskRunId) {
          selected = decoded;
          selectedBytes = candidate.requestBytes;
          break;
        }
        if (decoded !== null) {
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(decoded);
        }
      }
      if (selected === null || selectedBytes === null) {
        throw new Error("Connected protected Task device request was unavailable");
      }
      const plan = parseDomainForegroundAuthorizationPlanV2(
        selected.authorizationPlanBytes,
      );
      if (plan === null) {
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(selected);
        throw new Error("Connected protected Task authorization plan was invalid");
      }
      let responseBytes: Uint8Array | null = null;
      const domains = await loadConnectedDomainSecrets(
        base,
        selected.requestId,
      );
      try {
        const authorization = await mintDomainForegroundAuthorization(
          base.crypto,
          {
            plan,
            domains,
            committerDeviceSigningPrivateKey: base.signingPrivateKey,
            recipientEncryptionPublicKey: selected.recipientPublicKey,
          },
        );
        try {
          responseBytes = serializeDomainForegroundAuthorizationV2(
            authorization,
          );
          expect(await deviceService.respond(subject, { responseBytes }))
            .toEqual({ status: "accepted" });
        } finally {
          destroyDomainForegroundAuthorizationV2(authorization);
        }
      } finally {
        responseBytes?.fill(0);
        selectedBytes.fill(0);
        destroyConnectedDomainSecrets(domains);
        destroyDomainForegroundAuthorizationPlanV2(plan);
        destroyTaskRuntimeBackgroundAuthorizationRequestV1(selected);
      }
      expect(kicks).toBe(1);

      if (scenario === "cancellation recovery") {
        const requestId = `task-run-authorization:${connected.taskRunId}`;
        const persistOrphan = async () => {
          const jobId = await persistJobWithDatabase(base.productDb, {
            ownerId: base.userId,
            requestorId: base.userId,
            laneKey: `task:${connected!.taskId}`,
            type: "foreground",
            input: {
              kind: "protected_task_run_v1",
              taskId: connected!.taskId,
              taskRunId: connected!.taskRunId,
              inputObjectId: connected!.inputObjectId,
              resultObjectId: connected!.resultObjectId,
              authorizationRequestId: requestId,
              policyRevision: base.policyRevision,
              executionSegment: 1,
            },
            publicationPolicy: {
              expectedRevision: base.policyRevision,
              representation: "protected_only",
            },
          });
          base.jobIds.add(jobId);
          return jobId;
        };
        // Simulate process loss after persistence but before attaching the Job.
        const orphanIds = [await persistOrphan(), await persistOrphan()];
        expect(await transitionTaskLifecycleTerminal(base.productDb, {
          taskId: connected.taskId,
          taskStatus: "cancelled",
          taskPatch: { cancelledAt: new Date(NOW) },
          runStatus: "cancelled",
        })).toMatchObject({ transitioned: true,
          task: { status: "cancelled" }, run: { status: "cancelled", jobId: null } });
        await composition.coordinator.recoverBeforeObservation(100);
        expect(recipients.size).toBe(0);
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          reason: backgroundCryptoAuthorizationRequests.terminalReason,
          finishedAt: backgroundCryptoAuthorizationRequests.finishedAt,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId, requestId,
        ));
        expect(grant).toMatchObject({ state: "cancelled", reason: "cancelled" });
        expect(grant?.finishedAt).not.toBeNull();
        // A persistence transaction already in flight can arrive after revocation.
        orphanIds.push(await persistOrphan());
        await composition.coordinator.recoverBeforeObservation(100);
        const orphanRows = await base.admin.select({
          status: jobs.status, startedAt: jobs.startedAt,
          completedAt: jobs.completedAt, result: jobs.result, message: jobs.message,
        }).from(jobs).where(inArray(jobs.id, orphanIds));
        expect(orphanRows).toHaveLength(3);
        for (const job of orphanRows) {
          expect(job).toMatchObject({ status: "cancelled", startedAt: null,
            result: null, message: null });
          expect(job.completedAt).not.toBeNull();
        }
        expect(segmentCalls).toEqual([]);
        expect(await loadInitialProtectedTaskOccurrence(base.productDb, {
          taskRunId: connected.taskRunId, authorizationRequestId: requestId,
        })).toBeNull();
      } else {
      const claimable = await loadInitialProtectedTaskOccurrence(
        base.productDb,
        {
          taskRunId: connected.taskRunId,
          authorizationRequestId:
            `task-run-authorization:${connected.taskRunId}`,
        },
      );
      if (claimable === null) {
        throw new Error("Accepted protected Task occurrence was unavailable");
      }
      await composition.coordinator.observeProtectedTaskOccurrence(claimable);
      if (scenario === "linked cancellation") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [run] = await base.admin.select({ status: taskRuns.status })
            .from(taskRuns).where(eq(taskRuns.id, connected.taskRunId));
          if (run?.status === "cancelled" && connectedJobId !== null
            && jobManager.getJob(connectedJobId) === undefined) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        await composition.coordinator.recoverBeforeObservation(100);
        const [run] = await base.admin.select({ status: taskRuns.status,
          jobId: taskRuns.jobId }).from(taskRuns)
          .where(eq(taskRuns.id, connected.taskRunId));
        expect(connectedJobId).not.toBeNull();
        expect(run).toEqual({ status: "cancelled", jobId: connectedJobId });
        const [job] = await base.admin.select({ status: jobs.status,
          startedAt: jobs.startedAt, result: jobs.result, message: jobs.message })
          .from(jobs).where(eq(jobs.id, connectedJobId!));
        expect(job).toEqual({ status: "cancelled", startedAt: null,
          result: null, message: null });
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          reason: backgroundCryptoAuthorizationRequests.terminalReason,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        expect(grant).toEqual({ state: "cancelled", reason: "cancelled" });
        expect(recipients.size).toBe(0);
        expect(segmentCalls).toEqual([]);
      } else if (scenario === "pre-execution recovery") {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [run] = await base.admin.select().from(taskRuns)
            .where(eq(taskRuns.id, connected.taskRunId));
          if (connectedJobId !== null && run?.status === "awaiting"
            && run.jobId === null && jobManager.getJob(connectedJobId) === undefined) break;
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        const [run] = await base.admin.select().from(taskRuns)
          .where(eq(taskRuns.id, connected.taskRunId));
        expect(run).toMatchObject({ status: "awaiting", jobId: null,
          modelId: null, resultText: null, lastError: null, resultRevision: 0 });
        const [task] = await base.admin.select({ status: tasks.status })
          .from(tasks).where(eq(tasks.id, connected.taskId));
        expect(task?.status).toBe("awaiting");
        expect(connectedJobId).not.toBeNull();
        const [job] = await base.admin.select().from(jobs)
          .where(eq(jobs.id, connectedJobId!));
        expect(job).toMatchObject({ status: "cancelled", startedAt: null,
          result: null, message: null });
        expect(job?.completedAt).not.toBeNull();
        const [grant] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
          retryCount: backgroundCryptoAuthorizationRequests.retryCount,
          claimId: backgroundCryptoAuthorizationRequests.claimId,
          lastRetryReason: backgroundCryptoAuthorizationRequests.lastRetryReason,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        expect(grant).toEqual({ state: "awaiting_recipient", retryCount: 0,
          claimId: null, lastRetryReason: "stale_authority" });
        expect(recipients.size).toBe(0);
        expect(segmentCalls).toEqual([]);
        // The normal observer/device flow can offer a fresh grant automatically.
        await composition.coordinator.observeProtectedTaskOccurrence(occurrence);
        const refreshed = await deviceService.list(subject, {});
        let freshGeneration: number | undefined;
        for (const request of refreshed.requests) {
          const decoded = decodeTaskRuntimeBackgroundAuthorizationRequestV1(request.requestBytes);
          if (decoded !== null) {
            if (decoded.workId === connected.taskRunId) freshGeneration = decoded.recipientGeneration;
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(decoded);
          }
          request.requestBytes.fill(0);
        }
        expect(freshGeneration).toBe(1);
      } else {
      const terminal = await waitForConnectedCompletion(
        base,
        connected.taskRunId,
        terminalStatus,
      );
      if (terminal.job.status !== "completed") {
        const [authorization] = await base.admin.select({
          state: backgroundCryptoAuthorizationRequests.state,
        }).from(backgroundCryptoAuthorizationRequests).where(eq(
          backgroundCryptoAuthorizationRequests.requestId,
          `task-run-authorization:${connected.taskRunId}`,
        ));
        throw new Error(`Connected protected Task Job failed: ${JSON.stringify({
          jobStatus: terminal.job.status,
          runStatus: terminal.run.status,
          authorizationState: authorization?.state ?? "missing",
          segmentCalls,
          nativeErrors,
        })}`);
      }
      await waitForConnectedRelease(
        base,
        `task-run-authorization:${connected.taskRunId}`,
        recipients,
      );
      expect(terminal.job.input).toEqual({
        kind: "protected_task_run_v1",
        taskId: connected.taskId,
        taskRunId: connected.taskRunId,
        inputObjectId: connected.inputObjectId,
        resultObjectId: connected.resultObjectId,
        authorizationRequestId:
          `task-run-authorization:${connected.taskRunId}`,
        policyRevision: base.policyRevision,
        executionSegment: 1,
      });
      expect(terminal.job.message).toBeNull();
      expect(terminal.job.result).toBeNull();
      expect(terminal.run).toMatchObject({
        id: connected.taskRunId,
        taskId: connected.taskId,
        jobId: terminal.job.id,
        status: "completed",
        resultRepresentation: "protected",
        resultContentNamespaceId: base.namespaceValue,
        resultRevision: 1,
        resultCryptoObjectId: connected.resultObjectId,
        resultCryptoAccessRevision: 0,
        resultCryptoMappingState: "verified",
        resultText: null,
        lastError: null,
      });
      const exactRuns = await base.admin.select({ id: taskRuns.id })
        .from(taskRuns).where(eq(taskRuns.taskId, connected.taskId));
      const exactJobs = await base.admin.select({ id: jobs.id })
        .from(jobs).where(eq(jobs.laneKey, `task:${connected.taskId}`));
      expect(exactRuns).toEqual([{ id: connected.taskRunId }]);
      expect(exactJobs).toEqual([{ id: terminal.job.id }]);
      const [terminalTask] = await base.admin.select({
        status: tasks.status,
        prompt: tasks.prompt,
        expectedOutput: tasks.expectedOutput,
        lastError: tasks.lastError,
      }).from(tasks).where(eq(tasks.id, connected.taskId));
      expect(terminalTask).toEqual({
        status: "completed",
        prompt: "",
        expectedOutput: null,
        lastError: null,
      });
      expect(segmentCalls).toEqual([{
        taskId: connected.taskId,
        taskRunId: connected.taskRunId,
        graphThreadId: connected.graphThreadId,
      }]);
      expect(await objectRowCounts(base, connected.resultObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });
      const sessionRows = await base.admin.select({
        id: sessions.id,
        ownerId: sessions.ownerId,
        agentId: sessions.agentId,
        roomId: sessions.roomId,
      }).from(sessions).where(eq(
        sessions.threadId,
        connected.graphThreadId,
      ));
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0]).toMatchObject({
        ownerId: base.userId,
        agentId: base.productAgentId,
        roomId: base.roomId,
      });
      expect(await base.admin.select({ id: sessionMessages.id })
        .from(sessionMessages).where(eq(
          sessionMessages.sessionId,
          sessionRows[0]!.id,
        ))).toEqual([]);
      expect(recipients.size).toBe(0);
      }
      }
    } catch (error) {
      testError = error;
    }
    if (connected !== null && connectedJobId !== null && jobManager !== null) {
      try {
        await jobManager.abortProtectedTaskRunAndWait({
          taskId: connected.taskId,
          taskRunId: connected.taskRunId,
          jobId: connectedJobId,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      recipients.close();
      await base.cleanup();
    } catch (error) {
      cleanupError ??= error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Connected protected Task test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Connected protected Task test threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error(
          "Connected protected Task cleanup threw a non-Error value",
          { cause: cleanupError },
        );
    }
  }, 60_000);

  test("commits under genuine authority and serializes cancellation and expiry", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      const scopeId = randomUUID();
      const scopeTaskId = randomUUID();
      const scopeTaskObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: scopeTaskId,
        contentRevision: 1,
      });
      const scopeTaskFingerprint = fingerprintRequiredMemoryNamespaces([
        base.namespaceValue,
      ]);
      const seedMemoryId = randomUUID();
      base.scopeIds.add(scopeId);
      base.taskIds.add(scopeTaskId);
      base.objectIds.add(scopeTaskObjectId);
      base.memoryIds.add(seedMemoryId);
      try {
        await base.admin.transaction(async (tx) => {
          await tx.insert(agentScopes).values({
            id: scopeId,
            parentAgentId: base.productAgentId,
            speakerUserId: base.userId,
            name: `task-memory-scope-${scopeId}`,
          });
          await tx.insert(cryptoObjects).values({
            objectId: scopeTaskObjectId,
            payloadHash: digest(`task-scope-payload:${scopeTaskId}`),
            payloadBytes: Uint8Array.of(1),
          });
          await tx.insert(tasks).values({
            id: scopeTaskId,
            ownerId: base.userId,
            requestorId: base.userId,
            agentId: base.productAgentId,
            prompt: "",
            scheduleKind: "now",
            callingRoomId: base.roomId,
            targetRoomId: base.roomId,
            targetUserIds: [base.userId],
            status: "pending",
            useScope: true,
            scopeId,
          });
          await tx.insert(taskDefinitionCryptoRevisions).values({
            taskId: scopeTaskId,
            contentNamespaceId: base.namespaceValue,
            contentRevision: 1,
            operationId: `task-scope-definition:${randomUUID()}`,
            requestDigest: digest(`task-scope-request:${scopeTaskId}`),
            authorityFingerprint: digest(`task-scope-authority:${scopeTaskId}`),
            requesterHumanId: base.humanActorId,
            anchorNamespaceId: base.namespaceValue,
            cryptoObjectId: scopeTaskObjectId,
            representation: "protected",
            requiredNamespaceFingerprint: scopeTaskFingerprint,
            completion: "complete",
            disposition: "mapped",
            cryptoCompletedAt: new Date(NOW),
          });
          await tx.update(tasks).set({
            contentRepresentation: "protected",
            contentNamespaceId: base.namespaceValue,
            contentRevision: 1,
            cryptoObjectId: scopeTaskObjectId,
            cryptoAccessRevision: 0,
            cryptoRequiredNamespaceFingerprint: scopeTaskFingerprint,
            cryptoMappingState: "verified",
          }).where(eq(tasks.id, scopeTaskId));
          await tx.insert(memories).values({
            id: seedMemoryId,
            type: "fact",
            content: "Unattached Scope seed Memory",
            importance: 0.7,
            tier: 1,
            createdAt: new Date(NOW),
          });
          await tx.insert(memoryNamespaces).values({
            memoryId: seedMemoryId,
            namespaceId: base.seedNamespaceValue,
          });
        });
      } finally {
        scopeTaskFingerprint.fill(0);
      }

      const originReadableIds = Object.freeze([base.namespaceValue]);
      const expandedReadableIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const scopeBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.roomId,
        originWritableNamespaceId: base.namespaceValue,
        readableNamespaceIds: originReadableIds,
      }) satisfies TaskScopeMemoryBinding;
      const scopeAuthorityInput = (
        restricted: PostgresJsBridgeConnection,
        runner: ConversationProductCanonicalTransactionRunner,
        scopeMemory: TaskScopeMemoryBinding | undefined,
        namespaceIds: readonly string[],
      ) => ({
        runner,
        restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        taskId: scopeTaskId,
        requesterUserId: base.userId,
        requesterHumanId: base.humanActorId,
        agentId: base.productAgentId,
        contentNamespaceId: base.namespaceValue,
        sourceRoomId: base.roomId,
        targetRoomId: base.roomId,
        namespaceIds,
        ...(scopeMemory === undefined ? {} : { scopeMemory }),
        expectedPolicyRevision: base.policyRevision,
      });
      const initialScopeAuthority = await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          scopeBinding,
          originReadableIds,
        ),
      );
      expect(initialScopeAuthority).toMatchObject({
        sourceRoomId: base.roomId,
        sourceNamespaceId: base.namespaceValue,
        facts: [{
          namespaceId: base.namespaceValue,
          expectedPolicyRevision: base.policyRevision,
        }],
      });
      const contentAuthority = await inspectTaskContentNamespaceAuthority({
        runner: base.product.canonicalRunner,
        restricted: base.restricted,
        crypto: base.crypto,
        serverScope: SERVER_SCOPE,
        taskId: scopeTaskId,
        requesterUserId: base.userId,
        requesterHumanId: base.humanActorId,
        agentId: base.productAgentId,
        contentNamespaceId: base.namespaceValue,
        sourceRoomId: base.roomId,
        expectedPolicyRevision: base.policyRevision,
      });
      expect(contentAuthority?.sourceRoomId).toBe(base.roomId);
      expect(contentAuthority?.sourceNamespaceId).toBe(base.namespaceValue);
      expect(contentAuthority?.facts).toHaveLength(1);
      expect(contentAuthority?.facts[0]).toEqual({
        namespaceId: base.namespaceValue,
        domainId: base.namespace.domainId,
        expectedAccessRevision: base.namespace.accessRevision,
        expectedPolicyRevision: base.policyRevision,
        expectedDomainEpoch: base.namespace.domainKeyGeneration,
        expectedAuthorizationRevision:
          base.namespace.domainAuthorizationRevision,
      });
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          undefined,
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({ ...scopeBinding, scopeId: randomUUID() }),
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({ ...scopeBinding, memoryRoomId: base.seedRoomId }),
          originReadableIds,
        ),
      )).toBeNull();
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          Object.freeze({
            ...scopeBinding,
            readableNamespaceIds: expandedReadableIds,
          }),
          expandedReadableIds,
        ),
      )).toBeNull();

      // This is the canonical Scope mutation lock contract: take Scope UPDATE
      // before inserting a seed edge. The authority reader's Scope SHARE fence
      // must hold the empty inventory stable until its restricted proof ends.
      const scopeGate = gatedRestrictedConnection(base.restricted);
      const observedScopeReader = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      let lockedScopeAuthority: ReturnType<
        typeof inspectInitialTaskRuntimeNamespaceAuthority
      > | null = null;
      let attachSeed: Promise<readonly string[]> | null = null;
      try {
        lockedScopeAuthority = inspectInitialTaskRuntimeNamespaceAuthority(
          scopeAuthorityInput(
            scopeGate.connection,
            observedScopeReader.runner,
            scopeBinding,
            originReadableIds,
          ),
        );
        const admission = await Promise.race([
          scopeGate.entered.then(() => "entered" as const),
          lockedScopeAuthority.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error(
            "Initial Scope authority ended before restricted admission",
          );
        }
        attachSeed = base.agentProduct.canonicalRunner.transaction(
          async (tx) => {
            const currentScopes = await tx.select({
              id: agentScopes.id,
              parentAgentId: agentScopes.parentAgentId,
              speakerUserId: agentScopes.speakerUserId,
              lifecycleState: agentScopes.lifecycleState,
            }).from(agentScopes).where(eq(agentScopes.id, scopeId))
              .limit(2).for("update");
            const currentScope = currentScopes[0];
            if (currentScopes.length !== 1 || currentScope === undefined
              || currentScope.id !== scopeId
              || currentScope.parentAgentId !== base.productAgentId
              || currentScope.speakerUserId !== base.userId
              || currentScope.lifecycleState !== "open") {
              throw new Error("Scope seed attach authority changed");
            }
            const inserted = await tx.insert(memoryScopes).values({
              memoryId: seedMemoryId,
              scopeId,
              origin: "seed",
            }).returning({ memoryId: memoryScopes.memoryId });
            return Object.freeze(inserted.map(row => row.memoryId));
          }, { isolationLevel: "serializable" });
        await waitForBlockedContender(base, await observedScopeReader.pid);
        scopeGate.release();
        const [lockedAuthority, attachedIds] = await Promise.all([
          lockedScopeAuthority,
          attachSeed,
        ]);
        expect(lockedAuthority).toMatchObject({
          facts: [{ namespaceId: base.namespaceValue }],
        });
        expect(attachedIds).toEqual([seedMemoryId]);
      } catch (error) {
        scopeGate.release();
        await Promise.allSettled([
          ...(lockedScopeAuthority === null ? [] : [lockedScopeAuthority]),
          ...(attachSeed === null ? [] : [attachSeed]),
        ]);
        throw error;
      }
      expect(await inspectInitialTaskRuntimeNamespaceAuthority(
        scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          scopeBinding,
          originReadableIds,
        ),
      )).toBeNull();
      const expandedScopeBinding = Object.freeze({
        ...scopeBinding,
        readableNamespaceIds: expandedReadableIds,
      }) satisfies TaskScopeMemoryBinding;
      const expandedScopeAuthority =
        await inspectInitialTaskRuntimeNamespaceAuthority(scopeAuthorityInput(
          base.restricted,
          base.product.canonicalRunner,
          expandedScopeBinding,
          expandedReadableIds,
        ));
      expect(expandedScopeAuthority?.facts.map(fact => fact.namespaceId)).toEqual(
        [...expandedReadableIds],
      );

      const successful = await createScenario(base);
      const successfulStatus = await successful.execute(() => NOW + 5);
      if (successfulStatus !== "created") {
        throw new Error(
          `Task Memory success path returned ${successfulStatus}`,
        );
      }
      expect(await objectRowCounts(base, successful.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      // Full is the first qualified native vertical. Shadow remains NOT
      // QUALIFIED by this integration receipt.
      const nativeMemory = await createScenario(base);
      const nativeContent = `native Task Memory ${randomUUID()}`;
      const nativeResult = await nativeMemory.withPreparedWrite(
        () => NOW + 5,
        async ({ writer }) => withProtectedTaskNativeMemoryRepository({
          authority: Object.freeze({
            mode: "namespace",
            subjectUserId: base.userId,
            agentId: base.productAgentId,
            readableNamespaceIds: Object.freeze([base.namespaceValue]),
            mutableNamespaceIds: Object.freeze([base.namespaceValue]),
            writableNamespaceId: base.namespaceValue,
          }),
          policy: Object.freeze({
            mode: "encrypted_only",
            shadowBehavior: "strict",
            revision: base.policyRevision,
          }),
          current: writer,
          domains: Object.freeze([base.domainSecret]),
          signer: Object.freeze({
            agentAuthorizationRevision: 7,
            runtime: base.runtime.runtime,
            signerPublication: base.runtime.signerPublication,
          }),
          resolveHistoricalSignerPublicationManager: () =>
            base.currentDevice.signingPublicKey,
          product: base.product,
          agentProduct: base.agentProduct,
          owner: bindEncryptionDataOperationOwner({
            policy: {
              resolve: async () => Object.freeze({
                policy: Object.freeze({
                  mode: "encrypted_only" as const,
                  shadowBehavior: "strict" as const,
                }),
                revalidationToken: base.policyRevision,
              }),
              revalidate: async token => {
                if (token !== base.policyRevision) {
                  throw new TypeError("Task Memory policy token changed");
                }
              },
            },
          }),
          embedding: Object.freeze({
            embed: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze({
                vector: Object.freeze(new Array<number>(1536).fill(0.25)),
                provider: "openai",
                canonicalModel: "text-embedding-3-small",
                dimensions: 1536 as const,
                contractVersion: 1,
              }),
            }),
          }),
          execute: async repository => {
            const saved = await repository.save({
              operationId: `native-task-memory-save:${randomUUID()}`,
              authority: Object.freeze({
                mode: "namespace",
                subjectUserId: base.userId,
                agentId: base.productAgentId,
                readableNamespaceIds: Object.freeze([base.namespaceValue]),
                mutableNamespaceIds: Object.freeze([base.namespaceValue]),
                writableNamespaceId: base.namespaceValue,
              }),
              type: "fact",
              content: nativeContent,
              importance: 0.8,
            });
            if (saved.status !== "success") {
              throw new Error(`Native Task Memory save failed: ${saved.reason}`);
            }
            base.memoryIds.add(saved.value.id);
            base.objectIds.add(deriveMemoryCryptoObjectIdV1({
              memoryId: saved.value.id,
              contentRevision: 1,
            }));
            const searched = await repository.search({
              authority: Object.freeze({
                mode: "namespace",
                subjectUserId: base.userId,
                agentId: base.productAgentId,
                readableNamespaceIds: Object.freeze([base.namespaceValue]),
                mutableNamespaceIds: Object.freeze([base.namespaceValue]),
                writableNamespaceId: base.namespaceValue,
              }),
              query: nativeContent,
              limit: 5,
              includeArchive: false,
              mode: "vector",
            });
            return Object.freeze({ saved, searched });
          },
        }),
      );
      expect(nativeResult.saved.value).toMatchObject({ action: "created" });
      const nativeObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: nativeResult.saved.value.id,
        contentRevision: 1,
      });
      const [nativeMemoryAtRest] = await base.admin.select({
        content: memories.content,
        type: memories.type,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(
        memories.id,
        nativeResult.saved.value.id,
      ));
      expect(nativeMemoryAtRest).toEqual({
        content: null,
        type: null,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        cryptoObjectId: nativeObjectId,
        cryptoMappingState: "verified",
      });
      const [nativeCiphertextAtRest] = await base.admin.select({
        objectId: cryptoObjects.objectId,
        payloadBytes: cryptoObjects.payloadBytes,
        payloadHash: cryptoObjects.payloadHash,
      }).from(cryptoObjects).where(eq(
        cryptoObjects.objectId,
        nativeObjectId,
      ));
      expect(nativeCiphertextAtRest?.objectId).toBe(nativeObjectId);
      expect(nativeCiphertextAtRest?.payloadBytes.byteLength).toBeGreaterThan(0);
      expect(nativeCiphertextAtRest?.payloadHash.byteLength).toBe(32);
      expect(nativeResult.searched).toMatchObject({
        status: "success",
        value: [expect.objectContaining({
          id: nativeResult.saved.value.id,
          type: "fact",
          content: nativeContent,
        })],
      });

      const heldSuccess = await createScenario(base);
      const heldSuccessRunner = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      let escapedHeld: HeldProtectedTaskMemoryAuthority | null = null;
      let escapedAssertCurrent: (() => Promise<void>) | null = null;
      let escapedRestricted: PostgresJsBridgeConnection | null = null;
      let escapedRestrictedHandle: CryptoPostgresHandle | null = null;
      let restrictedQueryCalls = 0;
      const observedRestricted = observeRestrictedConnection(
        base.restricted,
        () => {
          restrictedQueryCalls += 1;
        },
      );
      const heldSuccessStatus = await heldSuccess.withPreparedWrite(
        () => NOW + 5,
        async ({ evidence, writer, write }) => {
          const result = await withCurrentProtectedTaskMemoryAuthority(
            writer,
            async held => {
              escapedHeld = held;
              const binding = requireHeldProtectedTaskMemoryWriterAuthority(
                held,
              );
              expect(binding.evidence).toBe(evidence);
              await binding.assertCurrent();
              escapedAssertCurrent = binding.assertCurrent;
              escapedRestricted = binding.restricted;
              escapedRestrictedHandle = binding.restrictedHandle;
              return persistProtectedTaskMemoryObjectUnderHeld(held, write);
            },
          );
          expect(result).toBe("created");
          const closedHeld = escapedHeld;
          const closedAssertCurrent = escapedAssertCurrent as
            (() => Promise<void>) | null;
          if (closedHeld === null || closedAssertCurrent === null) {
            throw new Error("Held Task Memory authority was not observed");
          }
          const closedRestricted = escapedRestricted;
          const closedRestrictedHandle = escapedRestrictedHandle;
          if (closedRestricted === null || closedRestrictedHandle === null) {
            throw new Error("Held Task Memory restricted authority was not observed");
          }
          const queriesBeforeClosedUse = restrictedQueryCalls;
          expect(() => requireHeldProtectedTaskMemoryWriterAuthority(
            closedHeld,
          )).toThrow("Task Memory authority is not active");
          for (const assertCurrent of [
            closedHeld.assertCurrent,
            closedAssertCurrent,
          ]) {
            let rejection: unknown;
            try {
              await assertCurrent();
            } catch (error) {
              rejection = error;
            }
            expect(rejection).toBeInstanceOf(TypeError);
            expect((rejection as Error).message).toBe(
              "Task Memory authority is not active",
            );
          }
          let restrictedRejection: unknown;
          try {
            await closedRestricted.query(
              "SELECT pg_backend_pid()::integer AS pid",
            );
          } catch (error) {
            restrictedRejection = error;
          }
          expect(restrictedRejection).toBeInstanceOf(TypeError);
          expect((restrictedRejection as Error).message).toBe(
            "Task Memory authority is not active",
          );
          let repositoryRejection: unknown;
          try {
            await new PostgresLatticeStorage(closedRestrictedHandle).getGrant(
              "closed-task-memory-held-authority",
            );
          } catch (error) {
            repositoryRejection = error;
          }
          expect(repositoryRejection).toBeInstanceOf(TypeError);
          expect((repositoryRejection as Error).message).toBe(
            "Task Memory authority is not active",
          );
          expect(restrictedQueryCalls).toBe(queriesBeforeClosedUse);
          return result;
        },
        observedRestricted,
        heldSuccessRunner.runner,
      );
      expect(heldSuccessStatus).toBe("created");
      expect(heldSuccessRunner.transactionCalls()).toBe(1);
      expect(await objectRowCounts(base, heldSuccess.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const callbackFailure = await createScenario(base);
      const callbackFailureRunner = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      const intendedFailure = new Error("held callback failed after CAS");
      let observedFailure: unknown;
      try {
        await callbackFailure.withPreparedWrite(
          () => NOW + 5,
          async ({ writer, write }) => {
            await withCurrentProtectedTaskMemoryAuthority(
              writer,
              async held => {
                expect(await persistProtectedTaskMemoryObjectUnderHeld(
                  held,
                  write,
                )).toBe("created");
                throw intendedFailure;
              },
            );
          },
          base.restricted,
          callbackFailureRunner.runner,
        );
      } catch (error) {
        observedFailure = error;
      }
      expect(observedFailure).toBe(intendedFailure);
      expect(callbackFailureRunner.transactionCalls()).toBe(1);
      expect(await objectRowCounts(
        base,
        callbackFailure.memoryObjectId,
      )).toEqual({ payload: 0, head: 0, manifest: 0, envelope: 0 });

      // The writer has already taken policy -> Task -> Run -> Job when the
      // restricted gate opens. A canonical Stop submitted at that point must
      // wait, so the complete payload + access CAS wins before cancellation.
      const writerFirst = await createScenario(base);
      const gate = gatedRestrictedConnection(base.restricted);
      const observedWriter = observeCanonicalRunner(
        base.product.canonicalRunner,
      );
      const writer = writerFirst.execute(
        () => NOW + 5,
        gate.connection,
        observedWriter.runner,
      );
      await gate.entered;
      const cancellation = transitionTaskLifecycleTerminal(base.productDb, {
        taskId: writerFirst.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 6) },
        runId: writerFirst.taskRunId,
        runStatus: "cancelled",
      });
      let writeStatus: Awaited<typeof writer>;
      let cancelled: Awaited<typeof cancellation>;
      try {
        await waitForBlockedContender(base, await observedWriter.pid);
        gate.release();
        [writeStatus, cancelled] = await Promise.all([writer, cancellation]);
      } catch (error) {
        gate.release();
        await Promise.allSettled([writer, cancellation]);
        throw error;
      }
      expect(writeStatus).toBe("created");
      expect(cancelled).toMatchObject({
        transitioned: true,
        outcome: "transitioned",
        task: { status: "cancelled" },
        run: { status: "cancelled" },
      });
      expect(await objectRowCounts(base, writerFirst.memoryObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const cancellationFirst = await createScenario(base);
      expect(await transitionTaskLifecycleTerminal(base.productDb, {
        taskId: cancellationFirst.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 6) },
        runId: cancellationFirst.taskRunId,
        runStatus: "cancelled",
      })).toMatchObject({ transitioned: true, outcome: "transitioned" });
      expect(await cancellationFirst.execute(() => NOW + 5)).toBe("stale");
      expect(await objectRowCounts(
        base,
        cancellationFirst.memoryObjectId,
      )).toEqual({ payload: 0, head: 0, manifest: 0, envelope: 0 });

      const expiry = await createScenario(base);
      let accessHeadCasCompleted = false;
      const expiryRestricted = observeRestrictedConnection(
        base.restricted,
        (statement, parameters) => {
          if (
            /^\s*insert into\s+"object_crypto_access_heads"/i.test(statement)
            && parameters?.includes(expiry.memoryObjectId) === true
          ) {
            accessHeadCasCompleted = true;
          }
        },
      );
      expect(await expiry.execute(
        () => accessHeadCasCompleted ? EXPIRES_AT : NOW + 5,
        expiryRestricted,
      )).toBe("stale");
      expect(accessHeadCasCompleted).toBe(true);
      expect(await objectRowCounts(base, expiry.memoryObjectId)).toEqual({
        payload: 0,
        head: 0,
        manifest: 0,
        envelope: 0,
      });
      const [currentClaim] = await base.admin.select({
        state: backgroundCryptoAuthorizationRequests.state,
        claimId: backgroundCryptoAuthorizationRequests.claimId,
      }).from(backgroundCryptoAuthorizationRequests).where(eq(
        backgroundCryptoAuthorizationRequests.requestId,
        expiry.requestId,
      ));
      expect(currentClaim).toMatchObject({
        state: "running",
      });
      expect(typeof currentClaim?.claimId).toBe("string");
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory writer test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Task Memory writer test threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Task Memory writer cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });

  test("publishes genuine Shadow ordinary fallback with exact Namespace and Scope audiences", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      await base.admin.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        shadowBehavior: "fallback",
        revision: base.policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW + 1),
      }).where(eq(encryptionTransitionPolicy.id, "server"));

      const vector = Object.freeze(new Array<number>(1536).fill(0.35));
      const namespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const namespaceAuthority: ProtectedMemoryAuthority = Object.freeze({
        mode: "namespace",
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        readableNamespaceIds: namespaceIds,
        mutableNamespaceIds: namespaceIds,
        writableNamespaceId: base.namespaceValue,
      });
      const namespaceScenario = await createScenario(base, {
        contentRepresentation: "dual",
        namespaceIds,
      });
      const saveNamespace = (
        content: string,
        onPrepare?: (request: FallbackPrepareRequest) => Promise<void>,
      ) => namespaceScenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withShadowFallbackRepository({
          base,
          scenario: namespaceScenario,
          writer,
          authority: namespaceAuthority,
          vector,
          ...(onPrepare === undefined ? {} : { onPrepare }),
          execute: repository => repository.save({
            operationId: `native-task-memory-fallback:${randomUUID()}`,
            authority: namespaceAuthority,
            type: "fact",
            content,
            importance: 0.8,
          }),
        }),
      );

      const initialContent = `Namespace fallback ${randomUUID()}`;
      const initial = await saveNamespace(initialContent);
      if (initial.status !== "success") {
        throw new Error(`Namespace fallback create failed: ${initial.reason}`);
      }
      base.memoryIds.add(initial.value.id);
      expect(initial).toMatchObject({
        value: { action: "created" },
        fallbackReason: "encryption_pending",
      });
      expect(await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id))).toEqual([{
        content: initialContent,
        contentRevision: 1,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
      }]);
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        initial.value.id,
      )).orderBy(memoryNamespaces.namespaceId)).toEqual([
        { namespaceId: base.namespaceValue },
      ]);

      await base.admin.insert(memoryNamespaces).values({
        memoryId: initial.value.id,
        namespaceId: base.seedNamespaceValue,
      });
      const wideContent = `${initialContent} Wide`;
      const wide = await saveNamespace(wideContent);
      if (wide.status !== "success") {
        throw new Error(`Wide fallback update failed: ${wide.reason}`);
      }
      expect(wide).toMatchObject({
        value: { id: initial.value.id, action: "updated" },
        fallbackReason: "encryption_pending",
      });
      const [wideBeforeRace] = await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id));
      expect(wideBeforeRace).toMatchObject({
        content: wideContent,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        initial.value.id,
      )).orderBy(memoryNamespaces.namespaceId)).toEqual(
        namespaceIds.map(namespaceIdValue => ({
          namespaceId: namespaceIdValue,
        })),
      );

      let raced = false;
      const stale = await saveNamespace(
        `${wideContent} stale`,
        async request => {
          if (raced) return;
          raced = true;
          expect(request.plan.memoryId).toBe(initial.value.id);
          await base.admin.delete(memoryNamespaces).where(and(
            eq(memoryNamespaces.memoryId, initial.value.id),
            eq(memoryNamespaces.namespaceId, base.seedNamespaceValue),
          ));
        },
      );
      expect(raced).toBe(true);
      expect(stale).toEqual({
        status: "unavailable",
        reason: "stale_revision",
      });
      const [wideAfterRace] = await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      }).from(memories).where(eq(memories.id, initial.value.id));
      expect(wideAfterRace).toMatchObject({
        content: wideContent,
        cryptoMappingState: "stale",
      });
      expect(wideAfterRace!.contentRevision).toBeGreaterThan(
        wideBeforeRace!.contentRevision,
      );
      expect(wideAfterRace?.cryptoObjectId).not.toBeNull();
      const activeRepair = await base.admin.select({
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
      }).from(memoryCryptoRevisions).where(and(
        eq(memoryCryptoRevisions.memoryId, initial.value.id),
        eq(memoryCryptoRevisions.disposition, "active"),
      ));
      expect(activeRepair).toContainEqual({
        completion: "pending",
        disposition: "active",
      });

      const scopeId = randomUUID();
      base.scopeIds.add(scopeId);
      await base.admin.insert(agentScopes).values({
        id: scopeId,
        parentAgentId: base.productAgentId,
        speakerUserId: base.userId,
        name: `task-memory-fallback-${scopeId}`,
      });
      const scopeAuthority: ProtectedMemoryAuthority = Object.freeze({
        mode: "scope",
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        scopeId,
        originWritableNamespaceId: base.namespaceValue,
      });
      const scopeScenario = await createScenario(base, {
        contentRepresentation: "dual",
        scopeMemory: {
          binding: Object.freeze({
            scopeId,
            memoryRoomId: base.roomId,
            originWritableNamespaceId: base.namespaceValue,
            readableNamespaceIds: Object.freeze([base.namespaceValue]),
          }),
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      const saveScope = (content: string) => scopeScenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withShadowFallbackRepository({
          base,
          scenario: scopeScenario,
          writer,
          authority: scopeAuthority,
          vector,
          execute: repository => repository.save({
            operationId: `native-task-scope-memory-fallback:${randomUUID()}`,
            authority: scopeAuthority,
            type: "fact",
            content,
            importance: 0.7,
          }),
        }),
      );
      const scopeInitialContent = `Scope fallback ${randomUUID()}`;
      const scopeInitial = await saveScope(scopeInitialContent);
      if (scopeInitial.status !== "success") {
        throw new Error(`Scope fallback create failed: ${scopeInitial.reason}`);
      }
      base.memoryIds.add(scopeInitial.value.id);
      expect(scopeInitial).toMatchObject({
        value: { action: "created" },
        fallbackReason: "encryption_pending",
      });
      const scopeUpdatedContent = `${scopeInitialContent} updated`;
      const scopeUpdated = await saveScope(scopeUpdatedContent);
      if (scopeUpdated.status !== "success") {
        throw new Error(`Scope fallback update failed: ${scopeUpdated.reason}`);
      }
      expect(scopeUpdated).toMatchObject({
        value: { id: scopeInitial.value.id, action: "updated" },
        fallbackReason: "encryption_pending",
      });
      expect(await base.admin.select({
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(
        memories.id,
        scopeInitial.value.id,
      ))).toEqual([{
        content: scopeUpdatedContent,
        contentRevision: 3,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        scopeOriginNamespaceId: base.namespaceValue,
      }]);
      expect(await base.admin.select({
        scopeId: memoryScopes.scopeId,
        origin: memoryScopes.origin,
      }).from(memoryScopes).where(eq(
        memoryScopes.memoryId,
        scopeInitial.value.id,
      ))).toEqual([{ scopeId, origin: "scope" }]);
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        scopeInitial.value.id,
      ))).toEqual([]);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory fallback test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error ? testError : new Error("Task Memory fallback test failed", { cause: testError });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error ? cleanupError : new Error("Task Memory fallback cleanup failed", { cause: cleanupError });
    }
  });

  test("adopts one immutable Scope Memory origin under genuine competing Task authority", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      const scopeId = randomUUID();
      const candidateMemoryId = randomUUID();
      const existingOriginMemoryId = randomUUID();
      const seedMemoryId = randomUUID();
      const mappedMemoryId = randomUUID();
      const targetMismatchMemoryId = randomUUID();
      const identityMismatchMemoryId = randomUUID();
      const expiryMemoryId = randomUUID();
      const plainMemoryId = randomUUID();
      const cancelledMemoryId = randomUUID();
      const mappedObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: mappedMemoryId,
        contentRevision: 1,
      });
      base.scopeIds.add(scopeId);
      base.objectIds.add(mappedObjectId);
      for (const memoryId of [
        candidateMemoryId,
        existingOriginMemoryId,
        seedMemoryId,
        mappedMemoryId,
        targetMismatchMemoryId,
        identityMismatchMemoryId,
        expiryMemoryId,
        plainMemoryId,
        cancelledMemoryId,
      ]) base.memoryIds.add(memoryId);

      const ordinaryMemory = (id: string) => ({
        id,
        type: "fact",
        content: `legacy Scope Memory ${id}`,
        importance: 0.7,
        tier: 1,
        createdAt: new Date(NOW),
      });
      const mappedFingerprint = fingerprintRequiredMemoryNamespaces([
        base.namespaceValue,
      ]);
      try {
        await base.admin.transaction(async (tx) => {
          await tx.insert(agentScopes).values({
            id: scopeId,
            parentAgentId: base.productAgentId,
            speakerUserId: base.userId,
            name: `task-memory-origin-adoption-${scopeId}`,
          });
          await tx.insert(cryptoObjects).values({
            objectId: mappedObjectId,
            payloadHash: digest(`mapped-memory:${mappedMemoryId}`),
            payloadBytes: Uint8Array.of(1),
          });
          await tx.insert(memories).values([
            ordinaryMemory(candidateMemoryId),
            {
              ...ordinaryMemory(existingOriginMemoryId),
              scopeOriginNamespaceId: base.namespaceValue,
            },
            ordinaryMemory(seedMemoryId),
            {
              ...ordinaryMemory(mappedMemoryId),
              cryptoObjectId: mappedObjectId,
              contentRevision: 1,
              cryptoMappingState: "verified",
              cryptoRequiredNamespaceFingerprint: mappedFingerprint,
            },
            ordinaryMemory(targetMismatchMemoryId),
            ordinaryMemory(identityMismatchMemoryId),
            ordinaryMemory(expiryMemoryId),
            ordinaryMemory(plainMemoryId),
            ordinaryMemory(cancelledMemoryId),
          ]);
          await tx.insert(memoryScopes).values([
            { memoryId: candidateMemoryId, scopeId, origin: "scope" },
            { memoryId: existingOriginMemoryId, scopeId, origin: "scope" },
            { memoryId: seedMemoryId, scopeId, origin: "seed" },
            { memoryId: mappedMemoryId, scopeId, origin: "scope" },
            { memoryId: targetMismatchMemoryId, scopeId, origin: "scope" },
            { memoryId: identityMismatchMemoryId, scopeId, origin: "scope" },
            { memoryId: expiryMemoryId, scopeId, origin: "scope" },
            { memoryId: plainMemoryId, scopeId, origin: "scope" },
            { memoryId: cancelledMemoryId, scopeId, origin: "scope" },
          ]);
          await tx.insert(memoryNamespaces).values({
            memoryId: seedMemoryId,
            namespaceId: base.seedNamespaceValue,
          });
        });
      } finally {
        mappedFingerprint.fill(0);
      }

      const readableNamespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const primaryBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.roomId,
        originWritableNamespaceId: base.namespaceValue,
        readableNamespaceIds,
      }) satisfies TaskScopeMemoryBinding;
      const seedBinding = Object.freeze({
        scopeId,
        memoryRoomId: base.seedRoomId,
        originWritableNamespaceId: base.seedNamespaceValue,
        readableNamespaceIds,
      }) satisfies TaskScopeMemoryBinding;
      const primary = await createScenario(base, {
        scopeMemory: {
          binding: primaryBinding,
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      const seed = await createScenario(base, {
        scopeMemory: {
          binding: seedBinding,
          targetRoomId: base.seedRoomId,
          targetNamespace: base.seedNamespace,
        },
      });
      const adopt = (
        scenario: typeof primary,
        memoryId: string,
        runner = base.product.canonicalRunner,
        now: () => number = () => NOW + 5,
      ) => scenario.withAuthority(
        now,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(writer, memoryId),
        base.restricted,
        runner,
      );

      expect(await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => withCurrentProtectedTaskMemoryAuthority(
          writer,
          async () => true,
        ),
      )).toBe(true);
      expect(await seed.withAuthority(
        () => NOW + 5,
        ({ writer }) => withCurrentProtectedTaskMemoryAuthority(
          writer,
          async () => true,
        ),
      )).toBe(true);

      const gate = gateCanonicalRunnerAfterScopeOriginUpdate(
        base.product.canonicalRunner,
      );
      const primaryAdoption = adopt(primary, candidateMemoryId, gate.runner);
      let seedAdoption: ReturnType<typeof adopt> | null = null;
      let primaryRace: Awaited<typeof primaryAdoption>;
      let seedRace: Awaited<ReturnType<typeof adopt>>;
      try {
        const admission = await Promise.race([
          gate.entered.then(() => "entered" as const),
          primaryAdoption.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error("Scope Memory adoption ended before its origin CAS");
        }
        seedAdoption = adopt(seed, candidateMemoryId);
        await waitForBlockedContender(base, await gate.pid);
        gate.release();
        [primaryRace, seedRace] = await Promise.all([
          primaryAdoption,
          seedAdoption,
        ]);
      } catch (error) {
        gate.release();
        await Promise.allSettled([
          primaryAdoption,
          ...(seedAdoption === null ? [] : [seedAdoption]),
        ]);
        throw error;
      }
      expect(primaryRace).toBe("adopted");
      expect(seedRace).toBe("stale");
      const winner = primary;
      const loser = seed;
      const winnerNamespaceId = base.namespaceValue;
      expect(await adopt(winner, candidateMemoryId)).toBe("replayed");
      expect(await adopt(loser, candidateMemoryId)).toBe("stale");

      const [adopted] = await base.admin.select({
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(memories.id, candidateMemoryId));
      expect(adopted).toEqual({
        type: "fact",
        content: `legacy Scope Memory ${candidateMemoryId}`,
        contentRevision: 0,
        cryptoAccessRevision: 0,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        cryptoRequiredNamespaceFingerprint: null,
        scopeOriginNamespaceId: winnerNamespaceId,
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        candidateMemoryId,
      ))).toEqual([]);

      expect(await adopt(primary, existingOriginMemoryId)).toBe("replayed");
      expect(await adopt(seed, existingOriginMemoryId)).toBe("stale");
      expect(await adopt(primary, seedMemoryId)).toBe("stale");
      expect(await adopt(primary, mappedMemoryId)).toBe("stale");

      const mismatchedTarget = await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(Object.freeze({
          ...writer,
          scopeMemory: Object.freeze({
            ...writer.scopeMemory!,
            targetRoomId: base.seedRoomId,
          }),
        }), targetMismatchMemoryId),
      );
      expect(mismatchedTarget).toBe("stale");
      const mismatchedIdentity = await primary.withAuthority(
        () => NOW + 5,
        ({ writer }) => adoptProtectedTaskScopeMemoryOrigin(Object.freeze({
          ...writer,
          scopeMemory: Object.freeze({
            ...writer.scopeMemory!,
            workIdentity: `${writer.scopeMemory!.workIdentity} `,
          }),
        }), identityMismatchMemoryId),
      );
      expect(mismatchedIdentity).toBe("stale");

      const expiryGate = gateCanonicalRunnerAfterScopeOriginUpdate(
        base.product.canonicalRunner,
      );
      let expired = false;
      const expiryAdoption = adopt(
        primary,
        expiryMemoryId,
        expiryGate.runner,
        () => expired ? EXPIRES_AT : NOW + 5,
      );
      try {
        const admission = await Promise.race([
          expiryGate.entered.then(() => "entered" as const),
          expiryAdoption.then(() => "completed" as const),
        ]);
        if (admission !== "entered") {
          throw new Error("Expiring Scope Memory adoption missed its CAS");
        }
        expired = true;
        expiryGate.release();
        expect(await expiryAdoption).toBe("stale");
      } catch (error) {
        expiryGate.release();
        await Promise.allSettled([expiryAdoption]);
        throw error;
      }

      try {
        await base.admin.update(encryptionTransitionPolicy).set({
          mode: "plaintext_only",
          shadowBehavior: "fallback",
          revision: base.policyRevision,
          shadowEncryptionStartedAt: null,
          updatedAt: new Date(NOW + 10),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
        expect(await adopt(primary, plainMemoryId)).toBe("stale");
      } finally {
        await base.admin.update(encryptionTransitionPolicy).set({
          mode: "encrypted_only",
          shadowBehavior: "strict",
          revision: base.policyRevision,
          shadowEncryptionStartedAt: new Date(NOW),
          updatedAt: new Date(NOW + 11),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      }

      expect(await transitionTaskLifecycleTerminal(base.productDb, {
        taskId: seed.taskId,
        taskStatus: "cancelled",
        taskPatch: { cancelledAt: new Date(NOW + 12) },
        runId: seed.taskRunId,
        runStatus: "cancelled",
      })).toMatchObject({ transitioned: true, outcome: "transitioned" });
      expect(await adopt(seed, cancelledMemoryId)).toBe("stale");

      const untouched = await base.admin.select({
        id: memories.id,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        mappedMemoryId,
        targetMismatchMemoryId,
        identityMismatchMemoryId,
        expiryMemoryId,
        plainMemoryId,
        cancelledMemoryId,
      ]));
      expect(untouched).toHaveLength(7);
      expect(untouched.every(memory =>
        memory.scopeOriginNamespaceId === null)).toBe(true);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Task Memory origin adoption test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Task Memory origin adoption threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Task Memory origin adoption cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });

  test("repairs and updates one legacy Scope Memory through a genuine Shadow Task", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
      await base.admin.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: base.policyRevision,
        shadowEncryptionStartedAt: new Date(NOW),
        updatedAt: new Date(NOW + 1),
      }).where(eq(encryptionTransitionPolicy.id, "server"));

      const scopeId = randomUUID();
      const legacyMemoryId = randomUUID();
      const audienceRaceMemoryId = randomUUID();
      const seedMemoryId = randomUUID();
      const foreignOriginMemoryId = randomUUID();
      const legacyContent = `legacy Scope Memory ${legacyMemoryId}`;
      const audienceRaceContent =
        `legacy Scope Memory audience race ${audienceRaceMemoryId}`;
      const savedContent = `${legacyContent} updated`;
      const selectedVector = new Array<number>(1536).fill(0.25);
      const seedVector = Array.from(
        { length: 1536 },
        (_, index) => index % 2 === 0 ? 0.25 : -0.25,
      );
      const foreignVector = new Array<number>(1536).fill(-0.25);
      const repairObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: legacyMemoryId,
        contentRevision: 1,
      });
      const savedObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: legacyMemoryId,
        contentRevision: 2,
      });
      const audienceRaceObjectId = deriveMemoryCryptoObjectIdV1({
        memoryId: audienceRaceMemoryId,
        contentRevision: 1,
      });
      base.scopeIds.add(scopeId);
      base.memoryIds.add(legacyMemoryId);
      base.memoryIds.add(audienceRaceMemoryId);
      base.memoryIds.add(seedMemoryId);
      base.memoryIds.add(foreignOriginMemoryId);
      base.objectIds.add(repairObjectId);
      base.objectIds.add(savedObjectId);
      base.objectIds.add(audienceRaceObjectId);

      const ordinaryMemory = (
        id: string,
        content: string,
        vector: number[],
        scopeOriginNamespaceId: string | null = null,
      ) => ({
        id,
        type: "fact",
        content,
        importance: 0.7,
        tier: 1,
        embedding: vector,
        embeddingRevision: 0,
        embeddingProvider: "openai" as const,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        embeddingContractVersion: 1,
        scopeOriginNamespaceId,
        createdAt: new Date(NOW),
      });
      await base.admin.transaction(async tx => {
        await tx.insert(agentScopes).values({
          id: scopeId,
          parentAgentId: base.productAgentId,
          speakerUserId: base.userId,
          name: `task-memory-shadow-repair-${scopeId}`,
        });
        await tx.insert(memories).values([
          ordinaryMemory(legacyMemoryId, legacyContent, selectedVector),
          ordinaryMemory(
            audienceRaceMemoryId,
            audienceRaceContent,
            foreignVector,
            base.namespaceValue,
          ),
          ordinaryMemory(
            seedMemoryId,
            `unmodified Scope seed ${seedMemoryId}`,
            seedVector,
          ),
          ordinaryMemory(
            foreignOriginMemoryId,
            `unmodified foreign origin ${foreignOriginMemoryId}`,
            foreignVector,
            base.seedNamespaceValue,
          ),
        ]);
        await tx.insert(memoryScopes).values([
          { memoryId: legacyMemoryId, scopeId, origin: "scope" },
          { memoryId: audienceRaceMemoryId, scopeId, origin: "scope" },
          { memoryId: seedMemoryId, scopeId, origin: "seed" },
          { memoryId: foreignOriginMemoryId, scopeId, origin: "scope" },
        ]);
        await tx.insert(memoryNamespaces).values({
          memoryId: seedMemoryId,
          namespaceId: base.seedNamespaceValue,
        });
      });

      const untouchedBefore = await base.admin.select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        foreignOriginMemoryId,
      ]));
      const readableNamespaceIds = Object.freeze([
        base.namespaceValue,
        base.seedNamespaceValue,
      ].sort());
      const authority = Object.freeze({
        mode: "scope" as const,
        subjectUserId: base.userId,
        agentId: base.productAgentId,
        scopeId,
        originWritableNamespaceId: base.namespaceValue,
      });
      const scenario = await createScenario(base, {
        contentRepresentation: "dual",
        scopeMemory: {
          binding: Object.freeze({
            scopeId,
            memoryRoomId: base.roomId,
            originWritableNamespaceId: base.namespaceValue,
            readableNamespaceIds,
          }),
          targetRoomId: base.roomId,
          targetNamespace: base.namespace,
        },
      });
      let fallbackCalls = 0;
      const result = await scenario.withAuthority(
        () => NOW + 5,
        ({ writer }) => withProtectedTaskNativeMemoryRepository({
          authority,
          policy: Object.freeze({
            mode: "shadow_encryption" as const,
            shadowBehavior: "strict" as const,
            revision: base.policyRevision,
          }),
          current: writer,
          domains: Object.freeze([scenario.domainSecret]),
          signer: Object.freeze({
            agentAuthorizationRevision: 7,
            runtime: base.runtime.runtime,
            signerPublication: base.runtime.signerPublication,
          }),
          resolveHistoricalSignerPublicationManager: () =>
            base.currentDevice.signingPublicKey,
          product: base.product,
          agentProduct: base.agentProduct,
          owner: bindEncryptionDataOperationOwner({
            policy: {
              resolve: async () => Object.freeze({
                policy: Object.freeze({
                  mode: "shadow_encryption" as const,
                  shadowBehavior: "strict" as const,
                }),
                revalidationToken: base.policyRevision,
              }),
              revalidate: async token => {
                if (token !== base.policyRevision) {
                  throw new TypeError("Task Memory policy token changed");
                }
              },
            },
          }),
          embedding: Object.freeze({
            embed: async () => Object.freeze({
              status: "success" as const,
              value: Object.freeze({
                vector: Object.freeze([...selectedVector]),
                provider: "openai" as const,
                canonicalModel: "text-embedding-3-small",
                dimensions: 1536 as const,
                contractVersion: 1,
              }),
            }),
          }),
          execute: repository => repository.save({
            operationId: `native-task-memory-shadow-save:${randomUUID()}`,
            authority,
            type: "fact",
            content: savedContent,
            importance: 0.8,
          }),
        }, {
          createFallback: () => {
            fallbackCalls += 1;
            throw new Error("Strict Shadow must not construct ordinary-only fallback");
          },
        }),
      );
      if (result.status !== "success") {
        throw new Error(`Shadow Task Memory save failed: ${result.reason}`);
      }
      expect(result.value).toMatchObject({
        id: legacyMemoryId,
        action: "updated",
      });
      expect(fallbackCalls).toBe(0);

      const [saved] = await base.admin.select({
        type: memories.type,
        content: memories.content,
        importance: memories.importance,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(memories.id, legacyMemoryId));
      expect(saved).toEqual({
        type: "fact",
        content: savedContent,
        importance: 0.8,
        contentRevision: 2,
        embeddingRevision: 2,
        cryptoAccessRevision: 0,
        cryptoObjectId: savedObjectId,
        cryptoMappingState: "verified",
        cryptoRequiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
        scopeOriginNamespaceId: base.namespaceValue,
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        legacyMemoryId,
      ))).toEqual([]);
      expect(await base.admin.select({
        namespaceId: objectCryptoNamespaceEnvelopes.namespaceId,
      }).from(objectCryptoNamespaceEnvelopes).where(inArray(
        objectCryptoNamespaceEnvelopes.objectId,
        [repairObjectId, savedObjectId],
      ))).toEqual([
        { namespaceId: base.namespaceValue },
        { namespaceId: base.namespaceValue },
      ]);

      const revisions = await base.admin.select({
        contentRevision: memoryCryptoRevisions.contentRevision,
        cryptoObjectId: memoryCryptoRevisions.cryptoObjectId,
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
        requiredNamespaceFingerprint:
          memoryCryptoRevisions.requiredNamespaceFingerprint,
      }).from(memoryCryptoRevisions).where(eq(
        memoryCryptoRevisions.memoryId,
        legacyMemoryId,
      ));
      expect(revisions).toHaveLength(2);
      expect(revisions.find(row => row.contentRevision === 1)).toMatchObject({
        cryptoObjectId: repairObjectId,
        completion: "complete",
        disposition: "superseded",
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
      });
      expect(revisions.find(row => row.contentRevision === 2)).toMatchObject({
        cryptoObjectId: savedObjectId,
        completion: "complete",
        disposition: "mapped",
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([base.namespaceValue]),
      });
      expect(await objectRowCounts(base, repairObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });
      expect(await objectRowCounts(base, savedObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const audienceRace = await scenario.withAuthority(
        () => NOW + 5,
        async ({ evidence, writer }) => {
          const source = await reserveProtectedTaskScopeMemoryRepair(writer, {
            memoryId: audienceRaceMemoryId,
            contentRevision: 0,
            score: 1,
            repairRequired: true,
            repair: Object.freeze({
              id: audienceRaceMemoryId,
              type: null,
              importance: 0.7,
              tier: 1,
              createdAt: new Date(NOW),
              score: 1,
              representation: "structural" as const,
            }),
          });
          if (source === null || source.source.plaintextBytes === null) {
            throw new Error("Task Scope Memory repair source was unavailable");
          }
          let edgeInsert: Promise<"inserted"> | null = null;
          let attachment: Promise<
            "attached" | "replayed" | "conflict" | null
          > | null = null;
          const edgeInserted = deferred();
          const releaseEdge = deferred();
          const observedEdge = observeCanonicalRunner(
            base.agentProduct.canonicalRunner,
          );
          try {
            const operationId =
              `task-memory-audience-race:${audienceRaceMemoryId}`;
            const prepared = prepareTaskRuntimeAgentObject({
              crypto: base.crypto,
              evidence,
              objectId: audienceRaceObjectId,
              objectType: MEMORY_OBJECT_TYPE,
              plaintextBytes: source.source.plaintextBytes,
              createdAt: NOW + 5,
              namespaceSet: [base.namespace],
              operationId,
              runtime: base.runtime.runtime,
              signerPublication: base.runtime.signerPublication,
              resolveHistoricalSignerPublicationManager: () =>
                base.currentDevice.signingPublicKey,
              agentAuthorizationRevision: 7,
            });
            expect(await persistProtectedTaskMemoryObject(writer, {
              memoryId: audienceRaceMemoryId,
              contentRevision: 1,
              operationId,
              prepared,
            })).toBe("created");

            edgeInsert = observedEdge.runner.transaction(
              async (tx) => {
                await tx.insert(memoryNamespaces).values({
                  memoryId: audienceRaceMemoryId,
                  namespaceId: base.seedNamespaceValue,
                });
                edgeInserted.resolve();
                await releaseEdge.promise;
                return "inserted" as const;
              },
              { isolationLevel: "read committed" },
            );
            const edgeAdmission = await Promise.race([
              edgeInserted.promise.then(() => "entered" as const),
              edgeInsert.then(() => "completed" as const),
            ]);
            if (edgeAdmission !== "entered") {
              throw new Error("Scope audience edge transaction ended before its gate");
            }
            attachment = attachProtectedTaskScopeMemoryRepair(
              writer,
              source,
              audienceRaceObjectId,
            );
            await waitForBlockedContender(
              base,
              await observedEdge.pid,
              "Task Scope repair attachment did not block behind its audience insert",
            );
            releaseEdge.resolve();
            const [edgeResult, attachmentResult] = await Promise.all([
              edgeInsert,
              attachment,
            ]);
            return Object.freeze({ edgeResult, attachmentResult });
          } catch (error) {
            releaseEdge.resolve();
            await Promise.allSettled([
              ...(edgeInsert === null ? [] : [edgeInsert]),
              ...(attachment === null ? [] : [attachment]),
            ]);
            throw error;
          } finally {
            source.source.plaintextBytes.fill(0);
            source.source.requestCommitment.fill(0);
          }
        },
      );
      expect(audienceRace).toEqual({
        edgeResult: "inserted",
        attachmentResult: "conflict",
      });
      expect(await base.admin.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(
        memoryNamespaces.memoryId,
        audienceRaceMemoryId,
      ))).toEqual([{ namespaceId: base.seedNamespaceValue }]);
      expect(await base.admin.select({
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
      }).from(memories).where(eq(
        memories.id,
        audienceRaceMemoryId,
      ))).toEqual([{
        contentRevision: 0,
        embeddingRevision: 0,
        cryptoObjectId: null,
        cryptoMappingState: "unmapped",
        cryptoRequiredNamespaceFingerprint: null,
      }]);
      expect(await base.admin.select({
        completion: memoryCryptoRevisions.completion,
        disposition: memoryCryptoRevisions.disposition,
      }).from(memoryCryptoRevisions).where(eq(
        memoryCryptoRevisions.memoryId,
        audienceRaceMemoryId,
      ))).toEqual([{
        completion: "pending",
        disposition: "active",
      }]);
      expect(await objectRowCounts(base, audienceRaceObjectId)).toEqual({
        payload: 1,
        head: 1,
        manifest: 1,
        envelope: 1,
      });

      const untouchedAfter = await base.admin.select({
        id: memories.id,
        type: memories.type,
        content: memories.content,
        contentRevision: memories.contentRevision,
        embeddingRevision: memories.embeddingRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
        cryptoRequiredNamespaceFingerprint:
          memories.cryptoRequiredNamespaceFingerprint,
        scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(inArray(memories.id, [
        seedMemoryId,
        foreignOriginMemoryId,
      ]));
      expect(untouchedAfter).toEqual(untouchedBefore);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await base.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (testError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [testError, cleanupError],
        "Shadow Task Memory repair test and cleanup both failed",
      );
    }
    if (testError !== undefined) {
      throw testError instanceof Error
        ? testError
        : new Error("Shadow Task Memory repair threw a non-Error value", {
          cause: testError,
        });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Shadow Task Memory repair cleanup threw a non-Error value", {
          cause: cleanupError,
        });
    }
  });
});
