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

      const [task] = await admin.unsafe<{
        content_representation: string;
        content_revision: number;
        prompt: string;
      }[]>(
        `SELECT content_representation, content_revision, prompt
         FROM tasks WHERE id = $1`,
        [taskId],
      );
      expect(task).toEqual({
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
      await Promise.all([app.end(), cryptoDatabase.end()]);
    }
  });
});
