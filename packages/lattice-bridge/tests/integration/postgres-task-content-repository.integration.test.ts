import { drizzle } from "drizzle-orm/postgres-js";
import {
  agentId as latticeAgentId, cryptoDomainId, createDomainForegroundAuthorizationPlan,
  domainNamespaceRetainedAuthoritySetDigest, mintDomainForegroundAuthorization,
  prepareAgentRuntimeInitialization, prepareDomainNamespaceBundle, TaskRuntimeRecipientRegistry,
  type DomainForegroundSecretEntry, type TaskRuntimeCancellationResultEvidence,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  encodeAgentRuntimeSignerPublicationV1, serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  stageNativeTaskCancellationPublication, inspectStagedTaskCancellationPublication,
  reserveStagedTaskCancellationPublication, hasTaskCancellationCryptoPublication,
  type StageNativeTaskCancellationPublicationInput,
  type VerifyStagedTaskCancellationPublication,
} from "@nautilo/lattice-bridge/server";
import {
  encryptionTransitionPolicy, BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS, cryptoDomains, domainKeyPublicationOperations, domainKeyHeads, namespaceDomainKeyBindings, namespaceDomainKeyHeads,
  humanCryptoCustodies, humanCryptoDevices, agentCryptoRuntimeStates, agentCryptoRuntimeSigners,
  backgroundCryptoAuthorizationRequests, taskCancellationCryptoStagingReceipts, cryptoObjects, objectCryptoAccessHeads, objectCryptoNamespaceEnvelopes, objectCryptoAccessManifests,
  type PostgresJsBridgeConnection, type ProtectedTaskCancellationOutputIntent,
} from "@nautilo/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresTaskContentProductStore,
  createPostgresTaskContentCryptoCompletion,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";
import {
  createDormantTaskContentShadowRepository,
  createPreparedHumanTaskContentCryptoRevisionV1,
  deriveTaskContentCryptoObjectIdV1,
  encodeTaskPayloadV1,
  encodeTaskRunResultPayloadV1,
  taskContentObjectTypeV1,
  type PreparedTaskContentCryptoRevisionV1,
  type TaskContentCoordinateV1,
} from "@nautilo/lattice-bridge";
import {
  classifyProtectedTaskMetadataV1,
} from "@nautilo/types";
import {
  and, eq, inArray, sql, jobs, tasks, taskRuns, taskRunResultCryptoRevisions, protectedTaskRunOutputBindings,
  createDirectDb,
  prepareProtectedTaskCancellationOutput,
  settleProtectedTaskCancellationOutput,
  listProtectedTaskCancellationOutputCandidates,
  type ProtectedTaskCancellationOutputCandidate,
  type ProtectedTaskCancellationOutputDiscoveryCursor,
} from "@nautilo/db";
import { readDisposableCleanupUrls, withDisposableFixtureCleanup } from "../../scripts/disposable-postgres-cleanup";
import { verifyDisposablePostgresAuthority } from "../../scripts/disposable-postgres-reset";
import { readPreparedTaskContentCryptoRevisionSnapshotV1 } from "../../src/task/task-content-prepared-revision.ts";
import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const urls = readDisposableCleanupUrls();
const { admin: adminUrl, crypto: cryptoUrl, app: appUrl } = urls;
const NOW = 1_830_000_000_000;

let admin: SqlClient;

function client(url: string): SqlClient {
  return postgres(url, { max: 2, prepare: false, onnotice: () => undefined });
}

function fixtureDirectDb() {
  // The factory captures its URL synchronously; never resolve a named instance.
  const previous = process.env["DB_DIRECT_CONNECTION"];
  process.env["DB_DIRECT_CONNECTION"] = appUrl;
  try {
    return createDirectDb(1);
  } finally {
    if (previous === undefined) delete process.env["DB_DIRECT_CONNECTION"];
    else process.env["DB_DIRECT_CONNECTION"] = previous;
  }
}

async function deleteFixtureCryptoObjects(connection: SqlClient, objectIds: readonly string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const database = drizzle(connection);
  const [original] = await database.execute<{ parent_owner: string; allowed: boolean; can_select: boolean }>(sql`
    select pg_get_userbyid(relowner) as parent_owner,
      has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
      has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
    from pg_class where oid = 'public.crypto_objects'::regclass
  `);
  if (original?.parent_owner !== "nautilo") throw new Error("Fixture crypto owner is unexpected");
  await withDisposableFixtureCleanup(connection, async transaction => {
    const tx = drizzle(transaction);
    await tx.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
      .where(inArray(cryptoObjects.objectId, [...objectIds])).for("update");
    await tx.delete(objectCryptoAccessHeads).where(inArray(objectCryptoAccessHeads.objectId, [...objectIds]));
    await tx.delete(objectCryptoNamespaceEnvelopes).where(inArray(objectCryptoNamespaceEnvelopes.objectId, [...objectIds]));
    await tx.delete(objectCryptoAccessManifests).where(inArray(objectCryptoAccessManifests.objectId, [...objectIds]));
    await tx.delete(cryptoObjects).where(inArray(cryptoObjects.objectId, [...objectIds]));
    expect(await tx.select({ requestId: taskCancellationCryptoStagingReceipts.requestId })
      .from(taskCancellationCryptoStagingReceipts)
      .where(inArray(taskCancellationCryptoStagingReceipts.cryptoObjectId, [...objectIds]))).toHaveLength(0);
    expect(await tx.select({ objectId: cryptoObjects.objectId }).from(cryptoObjects)
      .where(inArray(cryptoObjects.objectId, [...objectIds]))).toHaveLength(0);
  });
  const [restored] = await database.execute<{ allowed: boolean; can_select: boolean }>(sql`
    select has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'DELETE') as allowed,
      has_table_privilege('nautilo', 'public.task_cancellation_crypto_staging_receipts', 'SELECT') as can_select
  `);
  expect(restored).toEqual({ allowed: original.allowed, can_select: original.can_select });
}

function productExecutor(
  executor: SqlExecutor,
): ConversationProductPostgresExecutor {
  return {
    async query<Row extends ConversationProductDatabaseRow =
      ConversationProductDatabaseRow>(
      statement: string,
      parameters: readonly ConversationProductPostgresScalar[] = [],
    ): Promise<readonly Row[]> {
      return await executor.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      ) as unknown as readonly Row[];
    },
  };
}

function productConnection(
  database: SqlClient,
): ConversationProductPostgresConnection {
  return {
    ...productExecutor(database),
    transaction: <Result>(
      callback: (
        transaction: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ) => database.begin(
      `isolation level ${options.isolationLevel}`,
      (transaction) => callback(productExecutor(transaction)),
    ) as unknown as Promise<Result>,
  };
}

function cryptoExecutor(executor: SqlExecutor): CryptoPostgresExecutor {
  return {
    async query<Row>(statement: string, parameters = []): Promise<readonly Row[]> {
      return await executor.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      ) as unknown as readonly Row[];
    },
  };
}

function cryptoConnection(database: SqlClient): CryptoPostgresConnection {
  return {
    ...cryptoExecutor(database),
    transaction: (callback) => database.begin(
      (transaction) => callback(cryptoExecutor(transaction)),
    ) as unknown as ReturnType<typeof callback>,
  };
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e37_79b9;
  return {
    bytes(length: number): Uint8Array {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        output[index] = state & 0xff;
      }
      return output;
    },
  };
}

function prepareRevision(input: Readonly<{
  crypto: LatticeCrypto;
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>;
  authority: TaskContentAuthorityV1;
  coordinate: TaskContentCoordinateV1;
  canonicalBytes: Uint8Array;
  marker: number;
}>): PreparedTaskContentCryptoRevisionV1 {
  const objectIdentity = deriveTaskContentCryptoObjectIdV1(input.coordinate);
  const encrypted = encryptObjectPayload(input.crypto, {
    objectId: objectId(objectIdentity),
    keyClass: "ai",
    objectType: taskContentObjectTypeV1(input.coordinate),
    createdAt: unixTimestamp(NOW + input.marker),
  }, input.canonicalBytes);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      input.crypto,
      new Uint8Array(32).fill(input.marker),
      {
        objectId: objectId(objectIdentity),
        namespaceId: namespaceId(input.authority.namespaceId),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(1),
        bindingRevisionAtWrap: accessRevision(
          input.authority.expectedAccessRevision,
        ),
      },
      encrypted.dek,
    ),
  );
  encrypted.dek.fill(0);
  const access = prepareHumanObjectAccessManifestGenesisSet(input.crypto, {
    objectId: objectIdentity,
    payloadHash: input.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId(input.authority.requesterHumanId),
    committerDeviceId: cryptoDeviceId("task-integration-device"),
    hostAuthorizationRevision: authorizationRevision(1),
    committerSigningPublicKey: input.signer.publicKey,
    committerSigningPrivateKey: input.signer.privateKey,
  });
  return createPreparedHumanTaskContentCryptoRevisionV1({
    signerKind: "human_device",
    coordinate: input.coordinate,
    authority: input.authority,
    object: encryptedObjectWriteRecord(payloadBytes),
    access,
  });
}

beforeAll(() => {
  verifyDisposablePostgresAuthority(urls);
  admin = client(adminUrl);
});

afterAll(async () => {
  if (admin) await admin.end();
});

describe.serial("Postgres protected Task content repository", () => {
  test("walks create, update, result, replay, and reconciliation through real product and crypto roles", async () => {
    const ownerId = randomUUID();
    const humanActorId = randomUUID();
    const agentId = randomUUID();
    const namespaceValue = randomUUID();
    const domainId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const cancelledRunId = randomUUID();
    const preparedCancellationRunId = randomUUID();
    const preparedCancellationJobId = randomUUID();
    const crypto = new LatticeCrypto(seededRng(71), { now: () => NOW });
    const signer = crypto.generateSigningKeyPair();
    const authority = Object.freeze({
      authorityVersion: 1,
      kind: "requester_private_namespace",
      keyClass: "ai",
      requesterHumanId: humanActorId,
      namespaceId: namespaceValue,
      domainId,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 1,
    } satisfies TaskContentAuthorityV1);
    const classified = classifyProtectedTaskMetadataV1({
      target: "task-integration",
      mode: "update",
      publish: "branch",
    });
    if (classified.status !== "supported") {
      throw new Error("Expected supported Task metadata fixture");
    }
    const app = client(appUrl);
    const cryptoDatabase = client(cryptoUrl);
    const directDb = fixtureDirectDb();
    const objectIds: string[] = [];
    const [originalPolicy] = await admin.unsafe<{
      mode: string;
      revision: number;
      shadow_encryption_started_at: Date | null;
    }[]>(
      `SELECT mode, revision, shadow_encryption_started_at
       FROM encryption_transition_policy WHERE id = 'server'`,
    );
    if (originalPolicy === undefined) {
      throw new Error("Expected the server encryption policy fixture");
    }
    try {
      await admin.unsafe(
        `UPDATE encryption_transition_policy
         SET mode = 'encrypted_only', revision = 1,
             shadow_encryption_started_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 'server'`,
      );
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          "INSERT INTO users (id, name) VALUES ($1, 'Task repository integration')",
          [ownerId],
        );
        await transaction.unsafe(
          `INSERT INTO actors (id, owner_id, display_name, kind)
           VALUES ($1, $2, 'Task repository Human', 'user')`,
          [humanActorId, ownerId],
        );
        await transaction.unsafe(
          "INSERT INTO agents (id, handle) VALUES ($1, $2)",
          [agentId, `task-integration-${agentId}`],
        );
        await transaction.unsafe(
          "INSERT INTO namespaces (id, scope, label) VALUES ($1, 'private', 'Task integration')",
          [namespaceValue],
        );
      });

      const productHandle = await verifyConversationProductPostgresHandle(
        productConnection(app),
      );
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(cryptoDatabase),
      );
      const product = new PostgresTaskContentProductStore(
        productHandle,
        () => authority,
      );
      const completion = createPostgresTaskContentCryptoCompletion({
        handle: cryptoHandle,
        crypto,
        resolveCurrentAuthority: () => Promise.resolve(authority),
        resolveHistoricalAgentSignerAuthority: () => null,
        resolveHistoricalHumanDeviceSigningPublicKey: () =>
          Promise.resolve(signer.publicKey.slice()),
      });
      const repository = createDormantTaskContentShadowRepository({
        product,
        crypto: completion,
      });

      const definition1 = Object.freeze({
        kind: "definition" as const,
        taskId,
        contentRevision: 1,
      });
      const prepared1 = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: definition1,
        canonicalBytes: encodeTaskPayloadV1({
          formatVersion: 1,
          prompt: "protected create",
          expectedOutput: null,
          protectedMetadata: { target: "task-integration" },
        }),
        marker: 0x31,
      });
      objectIds.push(prepared1.objectId);
      expect(await repository.reserveRevision({
        operationId: `task-integration:${taskId}:definition:1`,
        requestDigest: crypto.hash(new TextEncoder().encode("definition-1")),
        representation: "protected",
        authority,
        prepared: prepared1,
        operationalMetadata: classified.operational,
      })).toMatchObject({ status: "reserved" });
      await app.unsafe(
        `INSERT INTO tasks (
           id, owner_id, requestor_id, agent_id, prompt, metadata, status
         ) VALUES ($1, $2, $2, $3, '', $4::jsonb, 'pending')`,
        [taskId, ownerId, agentId, JSON.stringify(classified.operational)],
      );
      expect(await repository.completeRevision({
        coordinate: definition1,
        prepared: prepared1,
      })).toMatchObject({ status: "mapped" });

      const definition2 = Object.freeze({
        ...definition1,
        contentRevision: 2,
      });
      const prepared2 = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: definition2,
        canonicalBytes: encodeTaskPayloadV1({
          formatVersion: 1,
          prompt: "protected update",
          expectedOutput: "protected output",
          protectedMetadata: { target: "task-integration" },
        }),
        marker: 0x32,
      });
      objectIds.push(prepared2.objectId);
      await repository.reserveRevision({
        operationId: `task-integration:${taskId}:definition:2`,
        requestDigest: crypto.hash(new TextEncoder().encode("definition-2")),
        representation: "protected",
        authority,
        prepared: prepared2,
        operationalMetadata: classified.operational,
      });
      // Simulate crypto commit succeeding before its response/receipt is saved.
      expect(await completion.complete(prepared2)).toBe("created");
      expect(await repository.completeRevision({
        coordinate: definition2,
        prepared: prepared2,
      })).toMatchObject({ status: "mapped" });

      await app.unsafe(
        `INSERT INTO task_runs (id, task_id, graph_thread_id, status)
         VALUES ($1, $2, 'task-integration-thread', 'running')`,
        [runId, taskId],
      );
      const result1 = Object.freeze({
        kind: "run_result" as const,
        taskId,
        taskRunId: runId,
        contentRevision: 1,
      });
      const preparedResult = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: result1,
        canonicalBytes: encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "protected result",
          lastError: null,
        }),
        marker: 0x33,
      });
      objectIds.push(preparedResult.objectId);
      await repository.reserveRevision({
        operationId: `task-integration:${taskId}:result:1`,
        requestDigest: crypto.hash(new TextEncoder().encode("result-1")),
        representation: "protected",
        authority,
        prepared: preparedResult,
        operationalMetadata: null,
      });
      await app.unsafe(
        "UPDATE task_runs SET status = 'completed' WHERE id = $1",
        [runId],
      );
      // Simulate a complete crypto object left for bounded reconciliation.
      expect(await completion.complete(preparedResult)).toBe("created");
      const reconciled = await repository.reconcilePending({
        leaseToken: randomUUID(),
        limit: 8,
      });
      expect(reconciled.outcomes).toEqual([
        expect.objectContaining({ coordinate: result1, outcome: "mapped" }),
      ]);
      expect(await repository.completeRevision({
        coordinate: result1,
        prepared: preparedResult,
      })).toMatchObject({ status: "replayed" });

      await app.unsafe(
        `INSERT INTO task_runs (id, task_id, graph_thread_id, status)
         VALUES ($1, $2, 'task-integration-cancelled-thread', 'running')`,
        [cancelledRunId, taskId],
      );
      const abandonedResult = Object.freeze({
        kind: "run_result" as const,
        taskId,
        taskRunId: cancelledRunId,
        contentRevision: 1,
      });
      const preparedAbandonedResult = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: abandonedResult,
        canonicalBytes: encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "must never attach",
          lastError: null,
        }),
        marker: 0x34,
      });
      objectIds.push(preparedAbandonedResult.objectId);
      expect(await repository.reserveRevision({
        operationId: `task-run-result:${cancelledRunId}`,
        requestDigest: crypto.hash(new TextEncoder().encode(
          "abandoned-result-1",
        )),
        representation: "protected",
        authority,
        prepared: preparedAbandonedResult,
        operationalMetadata: null,
      })).toMatchObject({ status: "reserved" });

      const cancelledResult = Object.freeze({
        kind: "run_result" as const,
        taskId,
        taskRunId: cancelledRunId,
        contentRevision: 2,
      });
      const preparedCancelledResult = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: cancelledResult,
        canonicalBytes: encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "Task cancelled",
          lastError: null,
        }),
        marker: 0x35,
      });
      objectIds.push(preparedCancelledResult.objectId);
      const cancellationOperationId =
        `task-run-cancelled-result:${cancelledRunId}`;
      const cancellationDigest = crypto.hash(readPreparedTaskContentCryptoRevisionSnapshotV1(
        preparedCancelledResult,
      ).access.manifestBytes);
      const cancellationReservation = {
        operationId: cancellationOperationId,
        requestDigest: cancellationDigest,
        representation: "protected" as const,
        authority,
        prepared: preparedCancelledResult,
        operationalMetadata: null,
      };
      const stoppedAt = new Date(NOW);
      await app.unsafe(
        `UPDATE tasks
         SET status = 'cancelled', cancelled_at = $2
         WHERE id = $1`,
        [taskId, stoppedAt],
      );
      await app.unsafe(
        `UPDATE task_runs
         SET status = 'cancelled', completed_at = $2
         WHERE id = $1`,
        [cancelledRunId, stoppedAt],
      );

      await exerciseNativeCancellationStaging({ app, cryptoDatabase, taskId, ownerId,
        humanActorId, agentId, namespaceValue, domainId, objectIds, terminalAt: stoppedAt });

      expect(await repository.reserveRevision(cancellationReservation))
        .toEqual({ status: "stale" });
      await app.unsafe(
        `INSERT INTO protected_task_run_output_bindings (
           task_run_id, binding_id, delivery_mode,
           result_revision, result_operation_id, result_object_id,
           accepted_policy_revision, accepted_at, result_terminal_at
         ) VALUES ($1, $2, 'none', 2, $3, $4, 1, $5, $6)`,
        [cancelledRunId, `task-run-output:${cancelledRunId}`,
          cancellationOperationId, preparedCancelledResult.objectId,
          stoppedAt, new Date(NOW + 1)],
      );
      expect(await repository.reserveRevision(cancellationReservation))
        .toEqual({ status: "stale" });
      await app.unsafe(
        `UPDATE protected_task_run_output_bindings
         SET result_terminal_at = $2
         WHERE task_run_id = $1`,
        [cancelledRunId, stoppedAt],
      );
      await app.unsafe(
        `UPDATE protected_task_run_output_bindings
         SET accepted_policy_revision = 2
         WHERE task_run_id = $1`,
        [cancelledRunId],
      );
      expect(await repository.reserveRevision(cancellationReservation))
        .toEqual({ status: "stale" });
      await app.unsafe(
        `UPDATE protected_task_run_output_bindings
         SET accepted_policy_revision = 1
         WHERE task_run_id = $1`,
        [cancelledRunId],
      );
      let signalAuthorityObserved!: () => void;
      let releaseAuthority!: () => void;
      const authorityObserved = new Promise<void>(resolve => { signalAuthorityObserved = resolve; });
      const authorityRelease = new Promise<void>(resolve => { releaseAuthority = resolve; });
      let claimLive = true;
      let reservationAssertions = 0;
      const guardedRepository = createDormantTaskContentShadowRepository({
        product: new PostgresTaskContentProductStore(productHandle, async () => {
          signalAuthorityObserved();
          await authorityRelease;
          return authority;
        }, coordinate => {
          expect(coordinate).toEqual(cancelledResult);
          reservationAssertions += 1;
          if (!claimLive) throw new Error("Cancellation claim expired while waiting for reservation");
        }),
        crypto: completion,
      });
      const delayedReservation = guardedRepository.reserveRevision(cancellationReservation)
        .then(() => null, (error: unknown) => error);
      await authorityObserved;
      claimLive = false;
      releaseAuthority();
      expect(await delayedReservation).toBeInstanceOf(Error);
      expect(reservationAssertions).toBe(1);
      const delayedRows = await directDb.select({ sequence: taskRunResultCryptoRevisions.sequence })
        .from(taskRunResultCryptoRevisions).where(and(
          eq(taskRunResultCryptoRevisions.taskRunId, cancelledRunId),
          eq(taskRunResultCryptoRevisions.resultRevision, 2),
        ));
      expect(delayedRows).toHaveLength(0);
      expect(await repository.reserveRevision(cancellationReservation))
        .toMatchObject({ status: "reserved", coordinate: cancelledResult });
      expect(await repository.reserveRevision(cancellationReservation))
        .toMatchObject({ status: "replayed", coordinate: cancelledResult });
      // Simulate a process exit after crypto commit but before product mapping.
      expect(await completion.complete(preparedCancelledResult)).toBe("created");
      let productReplays = 0;
      const replayFixedProduct = async () => {
        const [unmapped] = await directDb.select({ revision: taskRuns.resultRevision })
          .from(taskRuns).where(eq(taskRuns.id, cancelledRunId));
        expect(unmapped?.revision).toBe(0);
        productReplays += 1;
      };
      expect(await repository.reconcileCoordinate({
        coordinate: cancelledResult,
        operationId: `task-run-result:${cancelledRunId}`,
        leaseToken: randomUUID(),
        publishProduct: replayFixedProduct,
      })).toBe("pending");
      expect(productReplays).toBe(0);
      expect(await repository.reconcileCoordinate({
        coordinate: cancelledResult,
        operationId: cancellationOperationId,
        leaseToken: randomUUID(),
        publishProduct: replayFixedProduct,
      })).toBe("mapped");
      expect(productReplays).toBe(1);
      expect(await repository.reconcileCoordinate({
        coordinate: cancelledResult,
        operationId: cancellationOperationId,
        leaseToken: randomUUID(),
        publishProduct: replayFixedProduct,
      })).toBe("mapped");
      expect(productReplays).toBe(1);
      expect(await repository.completeRevision({
        coordinate: cancelledResult,
        prepared: preparedCancelledResult,
      })).toMatchObject({ status: "replayed", coordinate: cancelledResult });
      expect(await repository.completeRevision({
        coordinate: abandonedResult,
        prepared: preparedAbandonedResult,
      })).toMatchObject({
        status: "orphaned",
        reason: "stale_mapping",
        coordinate: abandonedResult,
      });

      const [cancelledRun] = await admin.unsafe<{
        status: string;
        completed_at: Date | null;
        result_representation: string;
        result_revision: number;
        result_text: string | null;
        last_error: string | null;
        result_crypto_object_id: string | null;
      }[]>(
        `SELECT status, completed_at, result_representation, result_revision,
                result_text, last_error, result_crypto_object_id
         FROM task_runs WHERE id = $1`,
        [cancelledRunId],
      );
      expect(cancelledRun).toEqual({
        status: "cancelled",
        completed_at: stoppedAt,
        result_representation: "protected",
        result_revision: 2,
        result_text: null,
        last_error: null,
        result_crypto_object_id: preparedCancelledResult.objectId,
      });
      const cancelledLedgers = await admin.unsafe<{
        result_revision: number;
        operation_id: string;
        crypto_object_id: string;
        completion: string;
        disposition: string;
      }[]>(
        `SELECT result_revision, operation_id, crypto_object_id,
                completion, disposition
         FROM task_run_result_crypto_revisions
         WHERE task_run_id = $1
         ORDER BY result_revision`,
        [cancelledRunId],
      );
      expect([...cancelledLedgers]).toEqual([
        {
          result_revision: 1,
          operation_id: `task-run-result:${cancelledRunId}`,
          crypto_object_id: preparedAbandonedResult.objectId,
          completion: "complete",
          disposition: "stale_mapping",
        },
        {
          result_revision: 2,
          operation_id: cancellationOperationId,
          crypto_object_id: preparedCancelledResult.objectId,
          completion: "complete",
          disposition: "mapped",
        },
      ]);
      cancellationDigest.fill(0);

      const preparedCancellationJobInput = Object.freeze({
        kind: "protected_task_run_v1",
        taskId,
        taskRunId: preparedCancellationRunId,
        inputObjectId: prepared2.objectId,
        resultObjectId: deriveTaskContentCryptoObjectIdV1({
          kind: "run_result",
          taskId,
          taskRunId: preparedCancellationRunId,
          contentRevision: 1,
        }),
        authorizationRequestId: `task-runtime-stable:${preparedCancellationRunId}`,
        policyRevision: 1,
        executionSegment: 1,
      });
      await admin.unsafe(
        `INSERT INTO jobs (
           id, owner_id, requestor_id, lane_key, type, status, input,
           completed_at
         ) VALUES ($1, $2, $2, $3, 'foreground', 'cancelled', $4::jsonb, $5)`,
        [
          preparedCancellationJobId,
          ownerId,
          `task:${taskId}`,
          preparedCancellationJobInput,
          stoppedAt,
        ],
      );
      await admin.unsafe(
        `INSERT INTO task_runs (
           id, task_id, job_id, graph_thread_id, status, completed_at
         ) VALUES ($1, $2, $3, 'task-integration-prepared-cancel-thread',
                   'cancelled', $4)`,
        [preparedCancellationRunId, taskId, preparedCancellationJobId, stoppedAt],
      );
      for (const malformedInput of [
        { ...preparedCancellationJobInput, executionSegment: 2,
          resumeAcceptanceId: null },
        { ...preparedCancellationJobInput, unexpected: true },
        { ...preparedCancellationJobInput, policyRevision: "1" },
        { ...preparedCancellationJobInput, executionSegment: 2,
          resumeAcceptanceId: "acceptance:1",
          resumeContinuationFingerprint:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      ]) {
        await admin.unsafe(
          "UPDATE jobs SET input = $2::jsonb WHERE id = $1",
          [preparedCancellationJobId, malformedInput],
        );
        expect(await prepareProtectedTaskCancellationOutput(
          directDb,
          {
            taskId,
            taskRunId: preparedCancellationRunId,
            requiredPolicyRevision: 1,
          },
          () => Promise.resolve(false),
        )).toEqual({ status: "rejected", reason: "conflict" });
      }
      await admin.unsafe(
        "UPDATE jobs SET input = $2::jsonb WHERE id = $1",
        [preparedCancellationJobId, preparedCancellationJobInput],
      );
      const discovered: ProtectedTaskCancellationOutputCandidate[] = [];
      let cancellationCursor: ProtectedTaskCancellationOutputDiscoveryCursor | undefined;
      do {
        const page = await listProtectedTaskCancellationOutputCandidates(directDb, {
          limit: 1, throughTime: stoppedAt,
          ...(cancellationCursor === undefined ? {} : { cursor: cancellationCursor }),
        });
        discovered.push(...page.candidates);
        cancellationCursor = page.next ?? undefined;
      } while (cancellationCursor !== undefined);
      expect(discovered.find(candidate => candidate.taskRunId === cancelledRunId))
        .toMatchObject({ taskId, taskRunId: cancelledRunId, jobId: null,
          bindingState: "cancellation", resultState: "mapped" });
      expect(discovered.find(candidate => candidate.taskRunId === preparedCancellationRunId))
        .toMatchObject({ taskId, taskRunId: preparedCancellationRunId,
          jobId: preparedCancellationJobId, bindingState: "missing", resultState: "unmapped" });
      expect(discovered.filter(candidate => candidate.taskRunId === runId)).toEqual([]);
      let settlementProofs = 0;
      expect(await settleProtectedTaskCancellationOutput(directDb,
        { taskId, taskRunId: cancelledRunId }, async proof => {
          settlementProofs += 1;
          expect(proof.intent).toMatchObject({ taskId, taskRunId: cancelledRunId,
            resultRevision: 2, terminalAt: stoppedAt });
          return false;
        })).toMatchObject({ status: "rejected", reason: "not_ready" });
      const [unsettled] = await directDb.select({
        resultAttachedAt: protectedTaskRunOutputBindings.resultAttachedAt,
        completedAt: protectedTaskRunOutputBindings.completedAt,
      }).from(protectedTaskRunOutputBindings)
        .where(eq(protectedTaskRunOutputBindings.taskRunId, cancelledRunId));
      expect(unsettled).toEqual({ resultAttachedAt: null, completedAt: null });
      expect(await settleProtectedTaskCancellationOutput(directDb,
        { taskId, taskRunId: cancelledRunId }, async proof => {
          settlementProofs += 1;
          expect(proof.requesterHumanId).toBe(authority.requesterHumanId);
          return true;
        })).toMatchObject({ status: "completed", binding: {
          resultAttachedAt: stoppedAt, completedAt: stoppedAt,
        } });
      expect(await settleProtectedTaskCancellationOutput(directDb,
        { taskId, taskRunId: cancelledRunId }, async () => true))
        .toMatchObject({ status: "exact_replay" });
      expect(settlementProofs).toBe(2);
      const preparedCancellation = await prepareProtectedTaskCancellationOutput(
        directDb,
        {
          taskId,
          taskRunId: preparedCancellationRunId,
          requiredPolicyRevision: 1,
        },
        (previous) => Promise.resolve(
          previous.taskId === taskId
          && previous.taskRunId === preparedCancellationRunId
          && previous.contentNamespaceId === namespaceValue
          && previous.jobAuthorizationRequestId
            === `task-runtime-stable:${preparedCancellationRunId}`,
        ),
      );
      expect(preparedCancellation).toMatchObject({
        status: "prepared",
        binding: {
          taskRunId: preparedCancellationRunId,
          resultRevision: 2,
          acceptedPolicyRevision: 1,
          resultTerminalAt: stoppedAt,
        },
      });
      if (!("intent" in preparedCancellation)) {
        throw new Error("Expected prepared cancellation output intent");
      }
      const stalePolicyResult = Object.freeze({
        kind: "run_result" as const,
        taskId,
        taskRunId: preparedCancellationRunId,
        contentRevision: 2,
      });
      const preparedStalePolicyResult = prepareRevision({
        crypto,
        signer,
        authority,
        coordinate: stalePolicyResult,
        canonicalBytes: encodeTaskRunResultPayloadV1({
          formatVersion: 1,
          resultText: "Task cancelled",
          lastError: null,
        }),
        marker: 0x36,
      });
      objectIds.push(preparedStalePolicyResult.objectId);
      expect(await repository.reserveRevision({
        operationId: preparedCancellation.intent.resultOperationId,
        requestDigest: crypto.hash(readPreparedTaskContentCryptoRevisionSnapshotV1(
          preparedStalePolicyResult,
        ).access.manifestBytes),
        representation: "protected",
        authority,
        prepared: preparedStalePolicyResult,
        operationalMetadata: null,
      })).toMatchObject({ status: "reserved", coordinate: stalePolicyResult });
      expect(await completion.complete(preparedStalePolicyResult)).toBe("created");
      await app.unsafe(
        `UPDATE protected_task_run_output_bindings
         SET accepted_policy_revision = 2
         WHERE task_run_id = $1`,
        [preparedCancellationRunId],
      );
      expect(await repository.completeRevision({
        coordinate: stalePolicyResult,
        prepared: preparedStalePolicyResult,
      })).toMatchObject({
        status: "orphaned",
        reason: "stale_mapping",
        coordinate: stalePolicyResult,
      });
      const [stalePolicyRun] = await admin.unsafe<{
        result_revision: number;
        result_crypto_object_id: string | null;
      }[]>(
        `SELECT result_revision, result_crypto_object_id
         FROM task_runs WHERE id = $1`,
        [preparedCancellationRunId],
      );
      expect(stalePolicyRun).toEqual({
        result_revision: 0,
        result_crypto_object_id: null,
      });

      const [task] = await admin.unsafe<{
        status: string;
        cancelled_at: Date | null;
        content_representation: string;
        content_revision: number;
        prompt: string;
      }[]>(
        `SELECT status, cancelled_at, content_representation,
                content_revision, prompt
         FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(task).toEqual({
        status: "cancelled",
        cancelled_at: stoppedAt,
        content_representation: "protected",
        content_revision: 2,
        prompt: "",
      });
      const [run] = await admin.unsafe<{
        result_representation: string;
        result_revision: number;
        result_text: string | null;
      }[]>(
        `SELECT result_representation, result_revision, result_text
         FROM task_runs WHERE id = $1`,
        [runId],
      );
      expect(run).toEqual({
        result_representation: "protected",
        result_revision: 1,
        result_text: null,
      });
    } finally {
      try {
        await withDisposableFixtureCleanup(admin, async transaction => {
          const cleanup = drizzle(transaction);
          await cleanup.delete(tasks).where(eq(tasks.id, taskId));
          await cleanup.delete(jobs).where(eq(jobs.id, preparedCancellationJobId));
        });
        await admin.unsafe(
          "DELETE FROM task_run_result_crypto_revisions WHERE task_id = $1",
          [taskId],
        );
        await admin.unsafe(
          "DELETE FROM task_definition_crypto_revisions WHERE task_id = $1",
          [taskId],
        );
        await deleteFixtureCryptoObjects(admin, objectIds);
        await admin.unsafe("DELETE FROM namespaces WHERE id = $1", [namespaceValue]);
        await admin.unsafe("DELETE FROM agents WHERE id = $1", [agentId]);
        await admin.unsafe("DELETE FROM actors WHERE id = $1", [humanActorId]);
        await admin.unsafe("DELETE FROM users WHERE id = $1", [ownerId]);
      } finally {
        try {
          await admin.unsafe(
            `UPDATE encryption_transition_policy
             SET mode = $1, revision = $2, shadow_encryption_started_at = $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = 'server'`,
            [originalPolicy.mode, originalPolicy.revision,
              originalPolicy.shadow_encryption_started_at?.toISOString() ?? null],
          );
        } finally {
          signer.privateKey.fill(0);
          await Promise.all([app.end(), cryptoDatabase.end(), directDb.end()]);
        }
      }
    }
  });
});

async function nativeCancellationFixture(input: { task: string; run: string; human: string;
  namespace: string; domain: string; agent: string; restricted: PostgresJsBridgeConnection }) {
  const { task: TASK, run: RUN, human: HUMAN, namespace: NAMESPACE, domain: DOMAIN, agent: AGENT } = input;
  const NOW = Date.now();
  const DEVICE = `cancellation-stage-device:${RUN}`;
  const SERVER = "https://nautilo.example";
  const bytes = (value: number) => new Uint8Array(32).fill(value);
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0), headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domainRequirement = { domainId: DOMAIN, sourceNamespaceId: NAMESPACE,
    participantDigest: crypto.hash(new TextEncoder().encode(HUMAN)), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: crypto.hash(new TextEncoder().encode(DOMAIN)),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  const current = { serverId: SERVER, cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9), domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedAuthoritySetDigest: retainedDigest };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: `native-task-result-binding:${RUN}`, previousBindingDigest: null,
    bundle: { ...current, formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, retainedGenerationCount: 1, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: `native-result-initialization:${RUN}`, agentId: latticeAgentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "task-native-agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId(DEVICE) },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const restricted = input.restricted;
  const base = { restricted, crypto, serverScope: SERVER, domains: [domain], signal: new AbortController().signal,
    authority: { authorityVersion: 1 as const, kind: "requester_private_namespace" as const, keyClass: "ai" as const,
      requesterHumanId: HUMAN, namespaceId: NAMESPACE, domainId: DOMAIN, expectedAccessRevision: 0, expectedPolicyRevision: 1 },
    createdAt: NOW, agentAuthorizationRevision: 7, runtime: initialized.runtime,
    signerPublication: initialized.signerPublication, resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    assertCurrentTaskAuthority: () => Promise.resolve() };
  const cancellationCoordinate = Object.freeze({
    kind: "run_result" as const,
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 2 as const,
  });
  const cancellationResult = Object.freeze({
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 2 as const,
    objectId: deriveTaskContentCryptoObjectIdV1(cancellationCoordinate),
    signerAgentId: AGENT,
    namespace: Object.freeze({
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 1,
    }),
  });
  const cancellationNow = NOW;
  const withCancellationEvidence = async <Value>(operation: (
    evidence: TaskRuntimeCancellationResultEvidence,
    signal: AbortSignal,
    domains: readonly DomainForegroundSecretEntry[],
    authorizationBytes: Uint8Array,
    recipientPublicKey: Uint8Array,
  ) => Value | PromiseLike<Value>) => {
    const recipients = new TaskRuntimeRecipientRegistry(crypto, {
      now: () => cancellationNow,
    });
    const attempt = await recipients.createAttempt({
      requestId: `task-run-cancellation-result-authorization:${RUN}`,
      workId: RUN,
      recipientGeneration: 1,
      recipientKeyId: `native-cancel-result-recipient:${RUN}`,
      expiresAt: NOW + 60_000,
    });
    if (attempt.status !== "created") throw new Error("cancellation recipient unavailable");
    const plan = createDomainForegroundAuthorizationPlan(crypto, {
      authorizationId: `task-run-cancellation-result-authorization:${RUN}`,
      policyRevision: 1,
      sessionId: "native-cancel-result-episode",
      roomId: "native-cancel-result-room",
      subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(5),
      recipientKind: "runtime",
      recipientPrincipalId: "nautilo_task_runtime",
      recipientAuthorizationRevision: authorizationRevision(6),
      recipientRuntimeGeneration: 1,
      recipientKeyId: `native-cancel-result-recipient:${RUN}`,
      operations: ["encrypt"],
      issuedAt: NOW,
      deadlineAt: NOW + 60_000,
      maximumSecretBytes: 4_096,
      domains: [domainRequirement],
    });
    const authorization = await mintDomainForegroundAuthorization(crypto, {
      plan,
      domains: [domain],
      committerDeviceSigningPrivateKey: issuer.privateKey,
      recipientEncryptionPublicKey: attempt.attempt.recipientPublicKey,
    });
    const authorizationBytes = serializeDomainForegroundAuthorizationV2(
      authorization,
    );
    try {
      return await recipients.withOpenedCancellationResultGrant({
        requestId: `task-run-cancellation-result-authorization:${RUN}`,
        workId: RUN,
        recipientGeneration: 1,
        recipientKeyId: `native-cancel-result-recipient:${RUN}`,
        claimId: `native-cancel-result-claim:${RUN}`,
        claimExpiresAt: NOW + 60_000,
        authorizationBytes,
        current: {
          authorizationId: plan.authorizationId,
          policyRevision: plan.policyRevision,
          sessionId: plan.sessionId,
          roomId: plan.roomId,
          subjectHumanId: plan.subjectHumanId,
          committerDeviceId: plan.committerDeviceId,
          committerDeviceSigningGeneration:
            plan.committerDeviceSigningGeneration,
          committerDeviceSigningPublicKey: issuer.publicKey,
          committerDeviceActive: true,
          hostAuthorizationRevision: plan.hostAuthorizationRevision,
          recipientKind: plan.recipientKind,
          recipientPrincipalId: plan.recipientPrincipalId,
          recipientAuthorizationRevision:
            plan.recipientAuthorizationRevision,
          recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
          recipientKeyId: plan.recipientKeyId,
          recipientAuthorized: true,
          domains: plan.domains,
        },
        currentNamespaceRequirements: [{
          ordinal: 0,
          namespaceId: NAMESPACE,
          domainId: DOMAIN,
          operations: ["encrypt"],
          expectedAccessRevision: 0,
          expectedPolicyRevision: 1,
        }],
        result: cancellationResult,
        operation: (domains, signal, evidence) => operation(
          evidence,
          signal,
          domains,
          authorizationBytes,
          attempt.attempt.recipientPublicKey,
        ),
      });
    } finally {
      authorizationBytes.fill(0);
      recipients.close();
    }
  };
  return {
    crypto,
    cancellationCoordinate,
    cancellationResult,
    base,

    native, initialized, issuer, manager, domainRequirement, retainedDigest, DEVICE, NOW,
    withCancellationEvidence,
  };
}

async function exerciseNativeCancellationStaging(input: {
  app: SqlClient; cryptoDatabase: SqlClient; taskId: string; ownerId: string;
  humanActorId: string; agentId: string; namespaceValue: string; domainId: string;
  objectIds: string[]; terminalAt: Date;
}): Promise<void> {
  const fixtureAdmin = client(adminUrl);
  const fixtureApp = client(appUrl);
  const fixtureCrypto = client(cryptoUrl);
  const database = drizzle(fixtureAdmin);
  const run = randomUUID();
  const restricted = cryptoConnection(input.cryptoDatabase) as PostgresJsBridgeConnection;
  const f = await nativeCancellationFixture({ task: input.taskId, run,
    human: input.humanActorId, agent: input.agentId,
    namespace: input.namespaceValue, domain: input.domainId, restricted });
  const bytes = (value: number) => new Uint8Array(32).fill(value);
  const date = new Date(f.NOW);
  const deadline = new Date(f.NOW + 60_000);
  const requestId = `task-run-cancellation-result-authorization:${run}`;
  const intent: ProtectedTaskCancellationOutputIntent = {
    taskId: input.taskId, taskRunId: run, requesterUserId: input.ownerId,
    agentId: input.agentId, contentNamespaceId: input.namespaceValue,
    representation: "protected", resultRevision: 2,
    resultOperationId: `task-run-cancelled-result:${run}`,
    resultObjectId: f.cancellationResult.objectId, policyRevision: 1,
    taskStatus: "cancelled", runStatus: "cancelled", terminalAt: input.terminalAt,
  };
  input.objectIds.push(intent.resultObjectId);
  const history = {
    resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
    resolveHistoricalAgentSignerAuthority: ((context) => ({ ...context,
      managerSigningPublicKey: f.manager.publicKey.slice() })) satisfies
        StageNativeTaskCancellationPublicationInput["resolveHistoricalAgentSignerAuthority"],
  };
  const handle = await verifyCryptoPostgresHandle(cryptoConnection(input.cryptoDatabase));
  const inspect = (authority: TaskContentAuthorityV1 = f.base.authority) =>
    inspectStagedTaskCancellationPublication({ ...history,
      handle, intent, crypto: f.crypto, authority });
  const failed = async (operation: Promise<unknown>) => {
    expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
  };
  try {
    await database.insert(taskRuns).values({ id: run, taskId: input.taskId,
      graphThreadId: `staged-cancellation:${run}`, status: "cancelled", completedAt: input.terminalAt });
    await database.insert(protectedTaskRunOutputBindings).values({
      taskRunId: run, bindingId: `task-run-output:${run}`, deliveryMode: "none",
      resultRevision: 2, resultOperationId: intent.resultOperationId,
      resultObjectId: intent.resultObjectId, acceptedPolicyRevision: 1,
      acceptedAt: input.terminalAt, resultTerminalAt: input.terminalAt,
    });
    await database.insert(humanCryptoCustodies).values({ humanId: input.humanActorId,
      userId: input.ownerId, humanActorId: input.humanActorId,
      initialInstallationLineageDigest: bytes(0x71), state: "active",
      everInitializedAt: date, firstDeviceId: f.DEVICE, currentRecoveryGeneration: 1,
      currentRecoveryPublicKeyDigest: bytes(0x72), revision: 1, createdAt: date, updatedAt: date });
    await database.insert(humanCryptoDevices).values({ deviceId: f.DEVICE,
      humanId: input.humanActorId, userId: input.ownerId, humanActorId: input.humanActorId,
      clientKind: "browser", installationLineageDigest: bytes(0x73), deviceGeneration: 1,
      signingPublicKey: f.issuer.publicKey, encryptionPublicKey: (await f.crypto.generateEncryptionKeyPair()).publicKey,
      publicFingerprint: f.crypto.hash(f.issuer.publicKey), state: "active",
      authorizationKind: "first_bootstrap", recoveryGeneration: 1,
      authorizationEvidenceDigest: bytes(0x75), keyPackageGeneration: 1,
      keyPackageCount: 0, revision: 1, createdAt: date, activatedAt: date });
    await database.insert(cryptoDomains).values({ id: input.domainId,
      participantDigest: f.domainRequirement.participantDigest, participants: [input.humanActorId],
      epoch: 4, authorizationRevision: 9, rosterBytes: bytes(0x76) });
    await database.insert(domainKeyPublicationOperations).values({ operationId: `stage-domain:${run}`,
      idempotencyKey: `stage-domain:${run}`, domainId: input.domainId, keyClass: "ai",
      participantDigest: f.domainRequirement.participantDigest, participantCount: 1,
      domainKeyGeneration: 4, authorizationRevision: 9, expectedPreviousHeadDigest: bytes(0x60),
      headDigest: f.domainRequirement.headDigest, headBytes: bytes(0x76),
      issuerHumanId: input.humanActorId, issuerDeviceId: f.DEVICE,
      issuerDeviceSigningGeneration: 1, state: "active", createdAt: date, updatedAt: date,
      deadlineAt: deadline, activatedAt: date });
    await database.insert(domainKeyHeads).values({ domainId: input.domainId, keyClass: "ai",
      participantDigest: f.domainRequirement.participantDigest, participantCount: 1,
      domainKeyGeneration: 4, authorizationRevision: 9, headDigest: f.domainRequirement.headDigest,
      headBytes: bytes(0x76), publicationOperationId: `stage-domain:${run}`,
      issuerHumanId: input.humanActorId, issuerDeviceId: f.DEVICE,
      issuerDeviceSigningGeneration: 1, activatedAt: date });
    const binding = { namespaceId: input.namespaceValue, domainId: input.domainId, keyClass: "ai",
      domainKeyGeneration: 4, domainAuthorizationRevision: 9,
      domainHeadDigest: f.domainRequirement.headDigest, namespaceAccessRevision: 0,
      namespaceCurrentGeneration: 0, bundleRevision: 1, retainedGenerationCount: 1,
      retainedAuthoritySetDigest: f.retainedDigest, bindingDigest: f.native.bindingDigest,
      activatedAt: date };
    await database.insert(namespaceDomainKeyBindings).values({ ...binding,
      operationId: f.native.binding.operationId, idempotencyKey: `stage-binding:${run}`,
      plaintextDigest: f.native.plaintextDigest, ciphertextDigest: f.native.binding.ciphertextDigest,
      bindingBytes: f.native.bytes, issuerHumanId: input.humanActorId, issuerDeviceId: f.DEVICE,
      issuerDeviceSigningGeneration: 1, state: "active", createdAt: date, updatedAt: date, deadlineAt: deadline });
    await database.insert(namespaceDomainKeyHeads).values({ ...binding,
      bindingOperationId: f.native.binding.operationId });
    await database.insert(agentCryptoRuntimeStates).values({ agentId: input.agentId,
      authorizationRevision: 7, runtimeGeneration: 0, configObjectCount: 1, configInventoryDigest: bytes(0x77) });
    await database.insert(agentCryptoRuntimeSigners).values({ ...f.initialized.signerPublication,
      publicationBytes: encodeAgentRuntimeSignerPublicationV1(f.initialized.signerPublication) });

    const opened = await f.withCancellationEvidence(async (evidence, signal, domains, authorizationBytes, recipientPublicKey) => {
      const identity = JSON.stringify(["nautilo/task-cancellation-result/v1", input.taskId,
        run, input.ownerId, input.agentId, input.namespaceValue, intent.resultOperationId,
        intent.resultObjectId, intent.terminalAt.getTime()]);
      await database.insert(backgroundCryptoAuthorizationRequests).values({
        requestId, workId: run, workKind: "task.cancel_result", purpose: "task.cancel_result",
        formatVersion: 3, credentialSubjectKind: "runtime", runtimeKind: "task", runtimeVersion: 1,
        workIdentityHash: f.crypto.hash(new TextEncoder().encode(requestId)),
        idempotencyKey: `task-cancellation:${Buffer.from(f.crypto.hash(new TextEncoder().encode(identity))).toString("hex")}`,
        namespaceId: input.namespaceValue, domainId: input.domainId, expectedDomainEpoch: 4,
        expectedNamespaceAccessRevision: 0, expectedPolicyRevision: 1,
        recipientGeneration: evidence.recipientGeneration, descriptorHash: bytes(0x78), descriptorBytes: bytes(0x79),
        recipientKeyId: evidence.recipientKeyId, recipientPublicKey, recipientExpiresAt: deadline,
        acceptedResponseKind: "runtime", acceptedResponseHash: evidence.authorizationDigest,
        acceptedResponseBytes: authorizationBytes, credentialId: requestId,
        credentialHash: evidence.authorizationDigest, issuingHumanId: input.humanActorId,
        issuingDeviceId: f.DEVICE, issuingDeviceAuthorizationRevision: 1,
        issuerSigningPublicKeyHash: f.crypto.hash(f.issuer.publicKey), acceptedAt: date,
        authorizationExpiresAt: deadline, requestRevision: 4, state: "running",
        claimId: evidence.claimId, claimExpiresAt: deadline, retryCount: 0, maximumAttempts: BACKGROUND_AUTHORIZATION_COLLECTION_LIMITS.maximumAttempts,
        createdAt: date, updatedAt: date,
      });
      // Product locks outlive the restricted staging transaction, as in withAccepted.
      const stage = (rollback: boolean) => input.app.begin(async productTx => {
        await productTx.unsafe("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [input.taskId]);
        await productTx.unsafe("SELECT id FROM task_runs WHERE id = $1 FOR UPDATE", [run]);
        return input.cryptoDatabase.begin(async cryptoTx => {
          const executor = cryptoExecutor(cryptoTx) as Pick<PostgresJsBridgeConnection, "query">;
          const borrowed: PostgresJsBridgeConnection = { query: executor.query.bind(executor),
            transaction: use => use(executor), transactionOnce: use => use(executor) };
          const result = await stageNativeTaskCancellationPublication({ ...history, intent,
            preparation: { ...f.base, restricted: borrowed, evidence, signal, domains },
            assertCurrentClaim: () => Promise.resolve() });
          if (rollback) throw new Error("simulated outer transaction rollback");
          return result;
        });
      });
      expect(await stage(true).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error))).toBe("simulated outer transaction rollback");
      expect(await hasTaskCancellationCryptoPublication(handle,
        { requestId, objectId: intent.resultObjectId })).toBe(false);
      expect(await inspect()).toBeNull();
      expect(await stage(false)).toBe("staged");
      const first = await inspect();
      expect(first).not.toBeNull();
      expect(await stage(false)).toBe("already_staged");
      expect((await inspect())!.genesisManifestHash).toEqual(first!.genesisManifestHash);
    });
    expect(opened.status).toBe("opened");
    // Crash after staging: no product ledger, no live grant or request survives.
    expect(await database.select().from(taskRunResultCryptoRevisions)
      .where(eq(taskRunResultCryptoRevisions.taskRunId, run))).toHaveLength(0);
    await database.delete(backgroundCryptoAuthorizationRequests)
      .where(eq(backgroundCryptoAuthorizationRequests.requestId, requestId));
    const staged = await inspect();
    expect(staged).not.toBeNull();
    const productHandle = await verifyConversationProductPostgresHandle(
      productConnection(input.app),
    );
    await database.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption", revision: 2,
      shadowEncryptionStartedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const incompatibleAuthority = Object.freeze({
      ...f.base.authority,
      expectedPolicyRevision: 2,
    });
    const incompatibleStage = await inspect(incompatibleAuthority);
    expect(incompatibleStage).not.toBeNull();
    expect(incompatibleStage!.genesisManifestHash).toEqual(staged!.genesisManifestHash);
    expect(incompatibleStage!.authorityFingerprint).toEqual(staged!.authorityFingerprint);
    const verifyStagedCancellation: VerifyStagedTaskCancellationPublication =
      proof => inspect(proof.currentAuthority);
    const incompatibleProduct = new PostgresTaskContentProductStore(
      productHandle,
      () => incompatibleAuthority,
      undefined,
      verifyStagedCancellation,
    );
    expect(await reserveStagedTaskCancellationPublication({
      staged: incompatibleStage!,
      authority: incompatibleAuthority,
      product: incompatibleProduct,
    })).toEqual({ status: "stale" });
    expect(await database.select().from(taskRunResultCryptoRevisions)
      .where(eq(taskRunResultCryptoRevisions.taskRunId, run))).toHaveLength(0);

    await database.update(encryptionTransitionPolicy).set({
      mode: "encrypted_only", revision: 3,
      updatedAt: new Date(),
    }).where(eq(encryptionTransitionPolicy.id, "server"));
    const currentAuthority = Object.freeze({
      ...f.base.authority,
      expectedPolicyRevision: 3,
    });
    const currentStage = await inspect(currentAuthority);
    expect(currentStage).not.toBeNull();
    expect(currentStage!.genesisManifestHash).toEqual(staged!.genesisManifestHash);
    expect(currentStage!.authorityFingerprint).toEqual(staged!.authorityFingerprint);
    const product = new PostgresTaskContentProductStore(
      productHandle,
      () => currentAuthority,
      undefined,
      verifyStagedCancellation,
    );
    const reserve = await reserveStagedTaskCancellationPublication({
      staged: currentStage!,
      authority: currentAuthority,
      product,
    });
    expect(reserve.status).toBe("reserved");
    const [ledger] = await database.select().from(taskRunResultCryptoRevisions)
      .where(eq(taskRunResultCryptoRevisions.taskRunId, run));
    expect(ledger!.requestDigest).toEqual(staged!.genesisManifestHash);
    expect(ledger!.authorityFingerprint).toEqual(staged!.authorityFingerprint);
    expect(ledger!.cryptoObjectId).toBe(intent.resultObjectId);
    const recovery = createDormantTaskContentShadowRepository({ product,
      crypto: createPostgresTaskContentCryptoCompletion({ ...history, handle, crypto: f.crypto,
        resolveCurrentAuthority: () => Promise.resolve(currentAuthority) }) });
    expect(await recovery.reconcileCoordinate({ coordinate: f.cancellationCoordinate,
      operationId: intent.resultOperationId, leaseToken: randomUUID() })).toBe("mapped");
    const [mapped] = await database.select().from(taskRuns).where(eq(taskRuns.id, run));
    expect(mapped!.resultCryptoObjectId).toBe(intent.resultObjectId);
    expect(mapped!.resultCryptoMappingState).toBe("verified");

    const [security] = await admin.unsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean;
      app_select: boolean; agent_select: boolean; crypto_insert: boolean; crypto_update: boolean; crypto_delete: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity,
        has_table_privilege('nautilo', oid, 'SELECT') AS app_select,
        has_table_privilege('nautilo_agent', oid, 'SELECT') AS agent_select,
        has_table_privilege('nautilo_crypto', oid, 'INSERT') AS crypto_insert,
        has_table_privilege('nautilo_crypto', oid, 'UPDATE') AS crypto_update,
        has_table_privilege('nautilo_crypto', oid, 'DELETE') AS crypto_delete
       FROM pg_class WHERE oid = 'task_cancellation_crypto_staging_receipts'::regclass`);
    expect(security).toEqual({ relrowsecurity: true, relforcerowsecurity: true,
      app_select: false, agent_select: false, crypto_insert: true, crypto_update: false, crypto_delete: false });
    await failed(drizzle(fixtureApp).select().from(taskCancellationCryptoStagingReceipts));
    await failed(fixtureAdmin.begin(async tx => {
      await tx.unsafe("SET LOCAL ROLE nautilo_agent");
      await drizzle(tx).select().from(taskCancellationCryptoStagingReceipts);
    }));
    await failed(drizzle(fixtureCrypto).update(taskCancellationCryptoStagingReceipts)
      .set({ claimId: "forbidden-replacement" }).where(eq(taskCancellationCryptoStagingReceipts.requestId, requestId)));
    await failed(drizzle(fixtureCrypto).delete(taskCancellationCryptoStagingReceipts)
      .where(eq(taskCancellationCryptoStagingReceipts.requestId, requestId)));
    expect((await inspect())!.claimId).toBe(staged!.claimId);
  } finally {
    try {
      await database.delete(backgroundCryptoAuthorizationRequests).where(eq(backgroundCryptoAuthorizationRequests.requestId, requestId));
      await withDisposableFixtureCleanup(fixtureAdmin, async transaction => {
        await drizzle(transaction).delete(taskRuns).where(eq(taskRuns.id, run));
      });
      await database.delete(taskRunResultCryptoRevisions).where(eq(taskRunResultCryptoRevisions.taskRunId, run));
      await deleteFixtureCryptoObjects(fixtureAdmin, [intent.resultObjectId]);
      await database.delete(namespaceDomainKeyHeads).where(eq(namespaceDomainKeyHeads.namespaceId, input.namespaceValue));
      await database.delete(namespaceDomainKeyBindings).where(eq(namespaceDomainKeyBindings.domainId, input.domainId));
      await database.delete(domainKeyHeads).where(eq(domainKeyHeads.domainId, input.domainId));
      await database.delete(domainKeyPublicationOperations).where(eq(domainKeyPublicationOperations.domainId, input.domainId));
      await database.delete(cryptoDomains).where(eq(cryptoDomains.id, input.domainId));
      await database.delete(agentCryptoRuntimeSigners).where(eq(agentCryptoRuntimeSigners.agentId, input.agentId));
      await withDisposableFixtureCleanup(fixtureAdmin, async transaction => {
        await drizzle(transaction).delete(agentCryptoRuntimeStates).where(eq(agentCryptoRuntimeStates.agentId, input.agentId));
      });
      await database.delete(humanCryptoDevices).where(eq(humanCryptoDevices.deviceId, f.DEVICE));
      await database.delete(humanCryptoCustodies).where(eq(humanCryptoCustodies.humanId, input.humanActorId));
    } finally {
      try {
        await database.update(encryptionTransitionPolicy).set({
          mode: "encrypted_only", revision: 1,
          shadowEncryptionStartedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(encryptionTransitionPolicy.id, "server"));
      } finally {
        f.issuer.privateKey.fill(0);
        f.manager.privateKey.fill(0);
        await Promise.all([fixtureAdmin.end(), fixtureApp.end(), fixtureCrypto.end()]);
      }
    }
  }
}
