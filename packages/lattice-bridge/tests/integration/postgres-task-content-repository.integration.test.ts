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
  createDirectDb,
  prepareProtectedTaskCancellationOutput,
} from "@nautilo/db";
import type { TaskContentAuthorityV1 } from "../../src/task/task-content-authority-v1.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const NOW = 1_830_000_000_000;

let admin: SqlClient;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function client(url: string): SqlClient {
  return postgres(url, { max: 2, prepare: false, onnotice: () => undefined });
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
  admin = client(adminUrl);
});

afterAll(async () => {
  await admin.end();
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
    const directDb = createDirectDb(1);
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
      const cancellationDigest = crypto.hash(new TextEncoder().encode(
        "cancelled-result-2",
      ));
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
      expect(await repository.reserveRevision(cancellationReservation))
        .toMatchObject({ status: "reserved", coordinate: cancelledResult });
      expect(await repository.reserveRevision(cancellationReservation))
        .toMatchObject({ status: "replayed", coordinate: cancelledResult });
      expect(await repository.completeRevision({
        coordinate: cancelledResult,
        prepared: preparedCancelledResult,
      })).toMatchObject({ status: "mapped", coordinate: cancelledResult });
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
        requestDigest: crypto.hash(new TextEncoder().encode(
          "stale-policy-cancelled-result-2",
        )),
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
      await admin.unsafe("DELETE FROM tasks WHERE id = $1", [taskId]);
      await admin.unsafe("DELETE FROM jobs WHERE id = $1", [preparedCancellationJobId]);
      await admin.unsafe(
        "DELETE FROM task_run_result_crypto_revisions WHERE task_id = $1",
        [taskId],
      );
      await admin.unsafe(
        "DELETE FROM task_definition_crypto_revisions WHERE task_id = $1",
        [taskId],
      );
      if (objectIds.length > 0) {
        await admin.unsafe(
          "DELETE FROM object_crypto_access_heads WHERE object_id = ANY($1::text[])",
          [objectIds],
        );
        await admin.unsafe(
          "DELETE FROM object_crypto_namespace_envelopes WHERE object_id = ANY($1::text[])",
          [objectIds],
        );
        await admin.unsafe(
          "DELETE FROM object_crypto_access_manifests WHERE object_id = ANY($1::text[])",
          [objectIds],
        );
        await admin.unsafe(
          "DELETE FROM crypto_objects WHERE object_id = ANY($1::text[])",
          [objectIds],
        );
      }
      await admin.unsafe("DELETE FROM namespaces WHERE id = $1", [namespaceValue]);
      await admin.unsafe("DELETE FROM agents WHERE id = $1", [agentId]);
      await admin.unsafe("DELETE FROM actors WHERE id = $1", [humanActorId]);
      await admin.unsafe("DELETE FROM users WHERE id = $1", [ownerId]);
      await admin.unsafe(
        `UPDATE encryption_transition_policy
         SET mode = $1, revision = $2, shadow_encryption_started_at = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = 'server'`,
        [originalPolicy.mode, originalPolicy.revision,
          originalPolicy.shadow_encryption_started_at],
      );
      signer.privateKey.fill(0);
      await Promise.all([app.end(), cryptoDatabase.end(), directDb.end()]);
    }
  });
});
