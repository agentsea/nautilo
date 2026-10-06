import { createHash, randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  __resetSharedDirectCryptoDbForTests,
  __resetSharedDirectDbForTests,
  actors,
  agentCryptoRuntimeChallenges,
  agentCryptoRuntimeConfigObjects,
  agentCryptoRuntimeDomainEnvelopes,
  agentCryptoRuntimeSigners,
  agentCryptoRuntimeStates,
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
  getSharedDirectCryptoDb,
  getSharedDirectDb,
  humanCryptoCustodies,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceKeyPackages,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
  inArray,
  jobs,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  namespaces,
  objectCryptoAccessHeads,
  objectCryptoAccessManifests,
  objectCryptoNamespaceEnvelopes,
  resolveAppDatabaseConnectionString,
  roomMembers,
  rooms,
  serverAdmission,
  sql,
  taskDefinitionCryptoRevisions,
  taskRuns,
  tasks,
  transitionTaskLifecycleTerminal,
  users,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
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
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  encodeHumanDeviceGroupHead,
  generateDomainKey,
  humanId,
  mintDomainForegroundAuthorization,
  namespaceGeneration,
  namespaceId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  prepareDomainKeyHead,
  prepareDomainKeyRecipientAuthorization,
  prepareDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  type DomainForegroundSecretEntry,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationV2,
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  serializeDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  deriveMemoryCryptoObjectIdV1,
  deriveTaskContentCryptoObjectIdV1,
  encodeMemoryPayloadV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
  prepareTaskRuntimeAgentObject,
} from "@nautilo/lattice-bridge";
import {
  PostgresDeviceAdmissionRepository,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresLatticeStorage,
  PostgresNamespaceProductAuthority,
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskJobReferenceV1,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";
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
  persistProtectedTaskMemoryObject,
  type ProtectedTaskMemoryObjectWriterInput,
} from "../../src/routes/protected-task-memory-object-writer.ts";

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
): Readonly<{
  runner: ConversationProductCanonicalTransactionRunner;
  pid: Promise<number>;
}> {
  const backend = Promise.withResolvers<number>();
  return Object.freeze({
    pid: backend.promise,
    runner: Object.freeze({
      ...base,
      transaction: <Result>(
        callback: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[0],
        options: Parameters<
          ConversationProductCanonicalTransactionRunner["transaction"]
        >[1],
      ): Promise<Result> => base.transaction(async (tx, executor) => {
        try {
          const rows = await executor.query<{ pid: number }>(
            "SELECT pg_backend_pid()::integer AS pid",
          );
          const pid = rows[0]?.pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
            throw new Error("Task Memory writer has no product backend PID");
          }
          backend.resolve(pid);
          return await callback(tx, executor) as Result;
        } catch (error) {
          backend.reject(error);
          throw error;
        }
      }, options),
    }),
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
  throw new Error("Task cancellation did not reach the writer's product lock");
}

async function createBaseFixture() {
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
  const roomId = randomUUID();
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
  let domainKey: Uint8Array | null = null;
  let domainIdValue: string | null = null;
  let runtime: Awaited<ReturnType<typeof prepareAgentRuntimeInitialization>> | null = null;
  const objectIds = new Set<string>();
  const requestIds = new Set<string>();
  const taskIds = new Set<string>();
  const jobIds = new Set<string>();

  const [originalPolicy] = await admin.select().from(encryptionTransitionPolicy)
    .where(eq(encryptionTransitionPolicy.id, "server"));
  if (originalPolicy === undefined) throw new Error("Missing encryption policy");
  const policyRevision = originalPolicy.revision + 1;

  const cleanup = async (): Promise<void> => {
    const writtenObjectIds = [...objectIds];
    const createdTaskIds = [...taskIds];
    const createdJobIds = [...jobIds];
    const createdRequestIds = [...requestIds];
    try {
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
      await admin.delete(namespaceDomainKeyHeads).where(
        eq(namespaceDomainKeyHeads.namespaceId, namespaceValue),
      );
      await admin.delete(namespaceDomainKeyBindings).where(
        eq(namespaceDomainKeyBindings.namespaceId, namespaceValue),
      );
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
        await admin.delete(taskDefinitionCryptoRevisions).where(
          inArray(taskDefinitionCryptoRevisions.taskId, createdTaskIds),
        );
      }
      if (createdJobIds.length > 0) {
        await admin.delete(jobs).where(inArray(jobs.id, createdJobIds));
      }
      if (writtenObjectIds.length > 0) {
        await admin.delete(cryptoObjects).where(
          inArray(cryptoObjects.objectId, writtenObjectIds),
        );
      }
      await admin.delete(roomMembers).where(eq(roomMembers.roomId, roomId));
      await admin.delete(rooms).where(eq(rooms.id, roomId));
      await admin.delete(namespaces).where(eq(namespaces.id, namespaceValue));
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
        domainKey?.fill(0);
        runtime?.runtime.key.fill(0);
        signing.privateKey.fill(0);
        encryption.privateKey.fill(0);
        recovery.privateKey.fill(0);
        managerVault.destroy();
        await admin.end();
        await Promise.all([
          __resetSharedDirectCryptoDbForTests(),
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
      await tx.insert(namespaces).values({
        id: namespaceValue,
        scope: "room",
        label: "Task Memory writer Namespace",
      });
      await tx.insert(rooms).values({
        id: roomId,
        ownerId: userId,
        type: "private",
        label: "Task Memory writer private Room",
        graphThreadId: `task-memory-writer:${roomId}`,
        namespaceId: namespaceValue,
        humanActorIds: [humanActorId],
        kind: "private",
      });
      await tx.insert(roomMembers).values([
        { roomId, actorId: humanActorId, roomRole: "admin" },
        {
          roomId,
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
        mode: "shadow_encryption",
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

    const bundlePlan = await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
      use: (authority) => domainRepository.planNamespaceBundle({
        authority,
        keyClass: "ai",
        clientDeviceId: deviceId,
      }),
    });
    if (bundlePlan?.status !== "create_required") {
      throw new Error("Task Memory Namespace bundle plan was unavailable");
    }
    namespaceKey = crypto.randomBytes(32);
    const namespaceHeadDigest = domainNamespaceGenerationHeadDigest(crypto, {
      serverId: SERVER_SCOPE,
      namespaceId: namespaceId(bundlePlan.namespaceId),
      keyClass: bundlePlan.keyClass,
      accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
      generation: namespaceGeneration(0),
      previousHeadDigest: null,
      generationKey: namespaceKey,
    });
    const retained = [Object.freeze({
      generation: namespaceGeneration(0),
      accessRevision: accessRevision(bundlePlan.namespaceAccessRevision),
      headDigest: namespaceHeadDigest,
      generationKey: namespaceKey,
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
      domainKey,
      issuedAt: NOW + 3,
    });
    expect((await productAuthority.withCurrentPrivateRoom({
      subjectUserId: userId,
      subjectHumanId: humanActorId,
      roomId,
      namespaceId: namespaceValue,
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
      domains: [],
      resolveCurrentDomainCommitterAuthority: () => null,
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
        domains: [],
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
      roomId,
      deviceId,
      signingPrivateKey: signing.privateKey,
      subject,
      currentDevice,
      policyRevision,
      product,
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
        namespaceId: namespaceValue,
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
        key: namespaceKey.slice(),
      }),
      runtime,
      objectIds,
      requestIds,
      taskIds,
      jobIds,
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

async function createScenario(base: BaseFixture) {
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
      targetRoomId: base.roomId,
      targetUserIds: [base.userId],
      status: "running",
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
      representation: "protected",
      requiredNamespaceFingerprint: requiredFingerprint,
      completion: "complete",
      disposition: "mapped",
      cryptoCompletedAt: new Date(NOW),
    });
    await tx.update(tasks).set({
      contentRepresentation: "protected",
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
      roomId: base.roomId,
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

  const occurrence: ProtectedTaskOccurrence = Object.freeze({
    task: Object.freeze({
      id: taskId,
      ownerId: base.userId,
      requestorId: base.userId,
      agentId: base.productAgentId,
      callingRoomId: base.roomId,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: base.namespaceValue,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: requiredFingerprint.slice(),
    }),
    run: Object.freeze({
      id: taskRunId,
      taskId,
      jobId: null,
      graphThreadId: `task:${taskId}:${taskRunId}`,
      status: "awaiting",
      startedAt,
    }),
  });
  const namespaceRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    namespaceId: base.namespaceValue,
    domainId: base.domainSecret.domainId,
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    expectedAccessRevision: base.namespace.accessRevision,
    expectedPolicyRevision: base.policyRevision,
  })]);
  const domainRequirements = Object.freeze([Object.freeze({
    ordinal: 0,
    domainId: base.domainSecret.domainId,
    expectedEpoch: base.domainSecret.domainKeyGeneration,
    expectedAuthorizationRevision: base.domainSecret.authorizationRevision,
  })]);
  const stableIdentity = Object.freeze({
    taskId,
    taskRunId,
    ownerId: base.userId,
    requestorId: base.userId,
    agentId: base.productAgentId,
    callingRoomId: base.roomId,
    scheduleKind: "now" as const,
    graphThreadId: occurrence.run.graphThreadId,
    startedAt: startedAt.getTime(),
    sourceRoomId: base.roomId,
    targetRoomId: base.roomId,
    targetUserIds: [base.userId],
    outputRoomId: base.roomId,
    outputNamespaceId: base.namespaceValue,
    memoryMode: "namespace" as const,
    scopeId: null,
    contentRepresentation: "protected" as const,
    contentNamespaceId: base.namespaceValue,
    contentRevision: 1,
    contentObjectId: inputObjectId,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: Buffer.from(requiredFingerprint).toString(
      "base64url",
    ),
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
    workIdentityHash: base.crypto.hash(new TextEncoder().encode(idempotencyKey)),
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
    domains: base.domainAuthority.domains,
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
    domains: [base.domainSecret],
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
        domains: base.domainAuthority.domains,
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
          namespaceId: base.namespaceValue,
          domainId: base.domainSecret.domainId,
          operations: ["encrypt"],
          expectedAccessRevision: base.namespace.accessRevision,
          expectedPolicyRevision: base.policyRevision,
        },
      },
      domainRequirements: base.domainAuthority.domains,
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
      executionRoomId: base.roomId,
      reference,
      now,
      signal: new AbortController().signal,
    });
    const execute = (
      now: () => number,
      restricted = base.restricted,
      runner = base.product.canonicalRunner,
    ) => withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW + 5,
      execute: async (evidence) => {
        const plaintextBytes = encodeMemoryPayloadV1({
          formatVersion: 1,
          type: "fact",
          content: `sealed Task Memory ${memoryId}`,
        });
        try {
          return await persistProtectedTaskMemoryObject(
            writerInput(evidence, now, restricted, runner),
            {
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
                namespaceSet: [base.namespace],
                operationId: `task-memory-object-write:${memoryId}`,
                runtime: base.runtime.runtime,
                signerPublication: base.runtime.signerPublication,
                resolveHistoricalSignerPublicationManager: () =>
                  base.currentDevice.signingPublicKey,
                agentAuthorizationRevision: 7,
              }),
            },
          );
        } finally {
          plaintextBytes.fill(0);
        }
      },
    });
    return Object.freeze({
      taskId,
      taskRunId,
      memoryObjectId,
      requestId,
      execute,
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

describePostgres("sealed protected Task Memory object writer", () => {
  test("commits under genuine authority and serializes cancellation and expiry", async () => {
    const base = await createBaseFixture();
    let testError: unknown;
    try {
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
});
