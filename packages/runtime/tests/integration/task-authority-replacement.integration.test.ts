import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "bun:test";
import {
  __resetSharedDirectCryptoDbForTests,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  createPostgresJsBridgeConnection,
  eq,
  getSharedDirectCryptoDb,
  inArray,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import {
  attachBackgroundAuthorizationRecipient,
  cancelBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
} from "../../src/protected-execution/background-authorization/lifecycle";
import {
  PostgresBackgroundAuthorizationRepository,
} from "../../src/protected-execution/background-authorization/postgres-repository";
import {
  buildUnclaimedTaskRuntimeAuthorityReplacement,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "../../src/protected-execution/background-authorization/repository";
import {
  taskRuntimeStableIdempotencyKey,
} from "../../src/protected-execution/background-authorization/task-runtime-grant-claim";

const EXPECTED_INSTANCE_ID = "qa-task-completion-e7ada3c6";
const EXPECTED_POSTGRES_PORT = "6234";
const ENABLE_ENV = "NAUTILO_TASK_AUTHORITY_REPLACEMENT_INTEGRATION";
const START = Date.parse("2042-06-04T10:00:00.000Z");
const createdRequestIds = new Set<string>();

function assertExactTarget(): void {
  if (process.env[ENABLE_ENV] !== "1") return;
  if (process.env["NAUTILO_INSTANCE_ID"] !== EXPECTED_INSTANCE_ID) {
    throw new Error(
      `${ENABLE_ENV}=1 requires NAUTILO_INSTANCE_ID=${EXPECTED_INSTANCE_ID}`,
    );
  }
  const raw = process.env["DB_CRYPTO_CONNECTION_STRING"];
  if (!raw) throw new Error("DB_CRYPTO_CONNECTION_STRING is required");
  const url = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== EXPECTED_POSTGRES_PORT
    || url.username !== "nautilo_crypto"
    || url.password.length === 0
    || url.pathname !== "/nautilo"
  ) {
    throw new Error(
      "Task authority replacement integration requires the exact local QA crypto database",
    );
  }
}

assertExactTarget();
const describePostgres = process.env[ENABLE_ENV] === "1"
  ? describe.serial
  : describe.skip;

function bytes(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function hexDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function taskRecord(input: Readonly<{
  requestId: string;
  taskRunId: string;
  suffix: string;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const namespaceA = `namespace-a-${input.suffix}`;
  const namespaceB = `namespace-b-${input.suffix}`;
  const domainA = `domain-a-${input.suffix}`;
  const domainB = `domain-b-${input.suffix}`;
  return {
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: input.requestId,
      workId: input.taskRunId,
      namespaceId: namespaceA,
      now: START,
    }),
    workIdentityHash: bytes(`work:${input.requestId}:initial`),
    idempotencyKey: taskRuntimeStableIdempotencyKey({
      taskId: `task-${input.suffix}`,
      taskRunId: input.taskRunId,
      ownerId: `owner-${input.suffix}`,
      requestorId: `requestor-${input.suffix}`,
      agentId: `agent-${input.suffix}`,
      callingRoomId: `room-${input.suffix}`,
      scheduleKind: "now",
      graphThreadId: `subagent:${input.suffix}`,
      startedAt: START,
      sourceRoomId: `room-${input.suffix}`,
      targetRoomId: `room-${input.suffix}`,
      targetUserIds: [`requestor-${input.suffix}`],
      outputRoomId: `room-${input.suffix}`,
      outputNamespaceId: namespaceA,
      memoryMode: "namespace",
      scopeId: null,
      contentRepresentation: "protected",
      contentNamespaceId: namespaceA,
      contentRevision: 1,
      contentObjectId: `task-content-${input.suffix}`,
      contentAccessRevision: 2,
      requiredNamespaceFingerprint: Buffer.from(
        bytes(`fingerprint:${input.suffix}`),
      ).toString("base64url"),
    }),
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: domainA,
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [
        {
          ordinal: 0,
          namespaceId: namespaceA,
          domainId: domainA,
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 4,
          expectedPolicyRevision: 5,
        },
        {
          ordinal: 1,
          namespaceId: namespaceB,
          domainId: domainB,
          operations: ["decrypt"],
          expectedAccessRevision: 6,
          expectedPolicyRevision: 5,
        },
      ],
      domainRequirements: [
        {
          ordinal: 0,
          domainId: domainA,
          expectedEpoch: 3,
          expectedAuthorizationRevision: 7,
        },
        {
          ordinal: 1,
          domainId: domainB,
          expectedEpoch: 8,
          expectedAuthorizationRevision: 9,
        },
      ],
    },
  };
}

function replacementPlan(
  current: BackgroundAuthorizationTaskRuntimeRecordV3,
  suffix: string,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const namespaceA = current.snapshot.namespaceId;
  const namespaceB = `namespace-b-${suffix}`;
  const namespaceC = `namespace-c-${suffix}`;
  const domainA = current.domainId;
  const domainB = `domain-b-${suffix}`;
  return {
    ...current,
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: current.snapshot.requestId,
      workId: current.snapshot.workId,
      namespaceId: namespaceA,
      now: START + 2,
    }),
    workIdentityHash: bytes(`work:${current.snapshot.requestId}:replacement`),
    expectedDomainEpoch: 13,
    expectedNamespaceAccessRevision: 14,
    expectedPolicyRevision: 15,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [
        {
          ordinal: 0,
          namespaceId: namespaceA,
          domainId: domainA,
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 14,
          expectedPolicyRevision: 15,
        },
        {
          ordinal: 1,
          namespaceId: namespaceB,
          domainId: domainB,
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 16,
          expectedPolicyRevision: 15,
        },
        {
          ordinal: 2,
          namespaceId: namespaceC,
          domainId: domainA,
          operations: ["decrypt"],
          expectedAccessRevision: 17,
          expectedPolicyRevision: 15,
        },
      ],
      domainRequirements: [
        {
          ordinal: 0,
          domainId: domainA,
          expectedEpoch: 13,
          expectedAuthorizationRevision: 18,
        },
        {
          ordinal: 1,
          domainId: domainB,
          expectedEpoch: 19,
          expectedAuthorizationRevision: 20,
        },
      ],
    },
  };
}

async function verifiedRepository(
  connection = createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
): Promise<Readonly<{
  handle: CryptoPostgresHandle;
  repository: PostgresBackgroundAuthorizationRepository;
}>> {
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    handle,
    repository: new PostgresBackgroundAuthorizationRepository(handle),
  };
}

async function seedAwaitingDevice(
  repository: PostgresBackgroundAuthorizationRepository,
  requestId: string,
): Promise<BackgroundAuthorizationTaskRuntimeRecordV3> {
  const suffix = randomUUID();
  const initial = taskRecord({ requestId, taskRunId: randomUUID(), suffix });
  createdRequestIds.add(requestId);
  expect((await repository.create(initial)).status).toBe("created");

  const descriptorBytes = Uint8Array.of(1, 3, 3, 7);
  const awaitingDevice: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: hexDigest(descriptorBytes),
      recipientKeyId: `recipient-${suffix}`,
      recipientPublicKey: Buffer.from(new Uint8Array(65).fill(0x42))
        .toString("base64url"),
      expiresAt: START + 60_000,
      now: START + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes,
  };
  const attached = await repository.compareAndSwap({
    expectedRequestRevision: initial.snapshot.requestRevision,
    next: awaitingDevice,
  });
  expect(attached.status).toBe("updated");
  if (attached.status !== "updated") {
    throw new Error("Task authority fixture recipient attachment lost its CAS");
  }
  return attached.record as BackgroundAuthorizationTaskRuntimeRecordV3;
}

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}>;

function deferred<Value>(): Deferred<Value> {
  const result = Promise.withResolvers<Value>();
  return {
    promise: result.promise,
    resolve: result.resolve,
    reject: result.reject,
  };
}

function observedConnection(
  base: PostgresJsBridgeConnection,
): Readonly<{ connection: CryptoPostgresConnection; pid: Promise<number> }> {
  const backend = deferred<number>();
  return {
    pid: backend.promise,
    connection: {
      query: (statement, parameters) => base.query(statement, parameters),
      transaction: <Result>(
        callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      ) => base.transaction(async transaction => {
        try {
          const rows = await transaction.query<{ pid: number }>(
            "SELECT pg_backend_pid()::integer AS pid",
          );
          const pid = rows[0]?.pid;
          if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
            throw new Error("Task authority contender has no backend PID");
          }
          backend.resolve(pid);
          return await callback(transaction);
        } catch (error) {
          backend.reject(error);
          throw error;
        }
      }),
    },
  };
}

async function waitForBackendLock(
  observer: PostgresJsBridgeConnection,
  pid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer.query<{
      state: string | null;
      wait_event_type: string | null;
      blocked: boolean;
    }>(
      `SELECT state::text,
              wait_event_type::text,
              cardinality(pg_blocking_pids(pid)) > 0 AS blocked
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );
    if (
      rows[0]?.state === "active"
      && rows[0].wait_event_type === "Lock"
      && rows[0].blocked === true
    ) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not reach the expected row-lock wait`);
}

async function within<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Task authority replacement race timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function deleteExactFixtures(): Promise<void> {
  if (createdRequestIds.size === 0) return;
  const connection = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
  const requestIds = [...createdRequestIds];
  const handle = await verifyCryptoPostgresHandle(connection);
  await withVerifiedCryptoPostgresTransaction(handle, async transaction => {
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(
        backgroundCryptoAuthorizationNamespaceRequirements,
      ).where(inArray(
        backgroundCryptoAuthorizationNamespaceRequirements.requestId,
        requestIds,
      )),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(
        backgroundCryptoAuthorizationDomainRequirements,
      ).where(inArray(
        backgroundCryptoAuthorizationDomainRequirements.requestId,
        requestIds,
      )),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(backgroundCryptoAuthorizationRequests).where(
        inArray(backgroundCryptoAuthorizationRequests.requestId, requestIds),
      ),
    );
    const [requests, namespaces, domains] = await Promise.all([
      executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          requestId: backgroundCryptoAuthorizationRequests.requestId,
        }).from(backgroundCryptoAuthorizationRequests).where(inArray(
          backgroundCryptoAuthorizationRequests.requestId,
          requestIds,
        )),
      ),
      executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          requestId:
            backgroundCryptoAuthorizationNamespaceRequirements.requestId,
        }).from(backgroundCryptoAuthorizationNamespaceRequirements).where(
          inArray(
            backgroundCryptoAuthorizationNamespaceRequirements.requestId,
            requestIds,
          ),
        ),
      ),
      executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          requestId: backgroundCryptoAuthorizationDomainRequirements.requestId,
        }).from(backgroundCryptoAuthorizationDomainRequirements).where(inArray(
          backgroundCryptoAuthorizationDomainRequirements.requestId,
          requestIds,
        )),
      ),
    ]);
    expect({ requests, namespaces, domains }).toEqual({
      requests: [],
      namespaces: [],
      domains: [],
    });
  });
  createdRequestIds.clear();
}

afterAll(async () => {
  if (process.env[ENABLE_ENV] !== "1") return;
  try {
    await deleteExactFixtures();
  } finally {
    await __resetSharedDirectCryptoDbForTests();
  }
});

describePostgres("Task Runtime pre-claim authority replacement", () => {
  test("persists the complete replacement audience and fences old recipient material across a fresh pool", async () => {
    const first = await verifiedRepository();
    const expected = await seedAwaitingDevice(
      first.repository,
      `task-authority-replacement-${randomUUID()}`,
    );
    const suffix = expected.snapshot.namespaceId.slice("namespace-a-".length);
    const replacement = replacementPlan(expected, suffix);
    const successor = buildUnclaimedTaskRuntimeAuthorityReplacement({
      expected,
      replacement,
      now: START + 2,
    });

    const replaced = await first.repository.replaceUnclaimedTaskRuntimeAuthority({
      expected,
      replacement,
      now: START + 2,
    });
    expect(replaced).toEqual({ status: "replaced", record: successor });
    expect(replaced.status).toBe("replaced");
    if (replaced.status !== "replaced") {
      throw new Error("Task authority fixture replacement unexpectedly lost");
    }
    expect(replaced.record.snapshot).toMatchObject({
      state: "awaiting_recipient",
      requestRevision: expected.snapshot.requestRevision + 1,
      recipientGeneration: expected.snapshot.recipientGeneration + 1,
      descriptorDigest: null,
      recipient: null,
      acceptedResponse: null,
    });
    expect(replaced.record).toMatchObject({
      descriptorBytes: null,
      acceptedMaterial: null,
    });

    await __resetSharedDirectCryptoDbForTests();
    const second = await verifiedRepository();
    expect(await second.repository.get(expected.snapshot.requestId)).toEqual(
      successor,
    );
    expect(successor.authoritySet).toEqual(replacement.authoritySet);
  });

  for (const firstWinner of ["replacement", "cancellation"] as const) {
    test(`serializes replacement against generic CAS with ${firstWinner} queued first`, async () => {
      const base = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
      const fixture = await verifiedRepository(base);
      const expected = await seedAwaitingDevice(
        fixture.repository,
        `task-authority-race-${randomUUID()}`,
      );
      const suffix = expected.snapshot.namespaceId.slice("namespace-a-".length);
      const replacement = replacementPlan(expected, suffix);
      const replacementSuccessor = buildUnclaimedTaskRuntimeAuthorityReplacement({
        expected,
        replacement,
        now: START + 2,
      });
      const cancelled: BackgroundAuthorizationTaskRuntimeRecordV3 = {
        ...expected,
        snapshot: cancelBackgroundAuthorizationRequest(
          expected.snapshot,
          "cancelled",
          START + 3,
        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
        finishedAt: START + 3,
      };
      const release = deferred<void>();
      const blockerReady = deferred<void>();
      const blocker = withVerifiedCryptoPostgresTransaction(
        fixture.handle,
        async transaction => {
          await executeTypedCryptoQuery(
            transaction,
            cryptoTypedDb.select({
              requestId: backgroundCryptoAuthorizationRequests.requestId,
            }).from(backgroundCryptoAuthorizationRequests).where(eq(
              backgroundCryptoAuthorizationRequests.requestId,
              expected.snapshot.requestId,
            )).for("update"),
          );
          blockerReady.resolve();
          await release.promise;
        },
      );
      void blocker.catch(error => blockerReady.reject(error));
      await blockerReady.promise;

      const replacementConnection = observedConnection(base);
      const cancellationConnection = observedConnection(base);
      const replacementHandle = await verifyCryptoPostgresHandle(
        replacementConnection.connection,
      );
      const cancellationHandle = await verifyCryptoPostgresHandle(
        cancellationConnection.connection,
      );
      const runReplacement = () => withVerifiedCryptoPostgresTransaction(
        replacementHandle,
        handle => new PostgresBackgroundAuthorizationRepository(handle)
          .replaceUnclaimedTaskRuntimeAuthority({
            expected,
            replacement,
            now: START + 2,
          }),
      );
      const runCancellation = () => withVerifiedCryptoPostgresTransaction(
        cancellationHandle,
        handle => new PostgresBackgroundAuthorizationRepository(handle)
          .compareAndSwap({
            expectedRequestRevision: expected.snapshot.requestRevision,
            next: cancelled,
          }),
      );

      let replacementResult: Awaited<ReturnType<typeof runReplacement>>;
      let cancellationResult: Awaited<ReturnType<typeof runCancellation>>;
      let replacementPromise: ReturnType<typeof runReplacement> | undefined;
      let cancellationPromise: ReturnType<typeof runCancellation> | undefined;
      try {
        if (firstWinner === "replacement") {
          replacementPromise = runReplacement();
          await waitForBackendLock(base, await replacementConnection.pid);
          cancellationPromise = runCancellation();
          await waitForBackendLock(base, await cancellationConnection.pid);
          release.resolve();
          [replacementResult, cancellationResult] = await within(Promise.all([
            replacementPromise,
            cancellationPromise,
          ]));
        } else {
          cancellationPromise = runCancellation();
          await waitForBackendLock(base, await cancellationConnection.pid);
          replacementPromise = runReplacement();
          await waitForBackendLock(base, await replacementConnection.pid);
          release.resolve();
          [replacementResult, cancellationResult] = await within(Promise.all([
            replacementPromise,
            cancellationPromise,
          ]));
        }
      } finally {
        release.resolve();
        await within(Promise.allSettled([
          blocker,
          ...(replacementPromise === undefined ? [] : [replacementPromise]),
          ...(cancellationPromise === undefined ? [] : [cancellationPromise]),
        ]));
      }

      if (firstWinner === "replacement") {
        expect(replacementResult).toEqual({
          status: "replaced",
          record: replacementSuccessor,
        });
        expect(cancellationResult).toEqual({
          status: "stale",
          current: replacementSuccessor,
        });
      } else {
        expect(cancellationResult).toEqual({
          status: "updated",
          record: cancelled,
        });
        expect(replacementResult).toEqual({
          status: "stale",
          current: cancelled,
        });
      }
    });
  }
});
