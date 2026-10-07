import { createHash, randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  mintDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationV2,
  verifyDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";
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
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationRunning,
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
      executionSegment: 1,
      resumeContinuationFingerprint: null,
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

async function seedRunningExecutionClaim(
  repository: PostgresBackgroundAuthorizationRepository,
  requestId: string,
): Promise<BackgroundAuthorizationTaskRuntimeRecordV3> {
  const suffix = randomUUID();
  const initial = taskRecord({
    requestId,
    taskRunId: randomUUID(),
    suffix,
  });
  const crypto = new LatticeCrypto(seededRng(940_001), {
    now: () => START,
  });
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const issuingHumanId = humanId(randomUUID());
  const issuingDeviceId = cryptoDeviceId(`task-device-${suffix}`);
  const issuingDeviceGeneration = 3;
  const issuingDeviceRevision = authorizationRevision(7);
  const domainAuthorities: DomainForegroundAuthorityEntry[] =
    initial.authoritySet.domainRequirements.map((domain, index) => {
      const namespace = initial.authoritySet.namespaceRequirements.find(
        (candidate) => candidate.domainId === domain.domainId,
      );
      if (namespace === undefined) {
        throw new Error("Task execution fixture Domain has no Namespace");
      }
      return Object.freeze({
        domainId: domain.domainId,
        sourceNamespaceId: namespace.namespaceId,
        participantDigest: bytes(`participants:${suffix}:${index}`),
        participantCount: 1,
        keyClass: "ai" as const,
        domainKeyGeneration: domain.expectedEpoch,
        authorizationRevision: authorizationRevision(
          domain.expectedAuthorizationRevision,
        ),
        headDigest: bytes(`head:${suffix}:${index}`),
        activeNamespaceBindingSetDigest: bytes(
          `bindings:${suffix}:${index}`,
        ),
        activeNamespaceBindingCount:
          initial.authoritySet.namespaceRequirements.filter(
            (candidate) => candidate.domainId === domain.domainId,
          ).length,
      });
    });
  const domainSecrets: DomainForegroundSecretEntry[] = domainAuthorities.map(
    (domain, index) => Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      domainKey: bytes(`domain-key:${suffix}:${index}`),
    }),
  );
  const recipientKeyId = `task-recipient-${suffix}`;
  const deadlineAt = START + 60_000;
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: requestId,
    policyRevision: initial.expectedPolicyRevision,
    sessionId: `task-episode-${suffix}`,
    roomId: `room-${suffix}`,
    subjectHumanId: issuingHumanId,
    committerDeviceId: issuingDeviceId,
    committerDeviceSigningGeneration: issuingDeviceGeneration,
    hostAuthorizationRevision: issuingDeviceRevision,
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: initial.snapshot.recipientGeneration,
    recipientKeyId,
    operations: ["decrypt", "encrypt"],
    issuedAt: START,
    deadlineAt,
    maximumSecretBytes: 2_048,
    domains: domainAuthorities,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId,
    workId: initial.snapshot.workId,
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
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  const attached: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      descriptorDigest: hexDigest(descriptorBytes),
      recipientKeyId,
      recipientPublicKey: Buffer.from(recipient.publicKey).toString(
        "base64url",
      ),
      expiresAt: deadlineAt,
      now: START + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes,
  };
  createdRequestIds.add(requestId);
  let authorization: Awaited<ReturnType<
    typeof mintDomainForegroundAuthorization
  >> | null = null;
  let responseBytes: Uint8Array | null = null;
  try {
    expect((await repository.create(initial)).status).toBe("created");
    const attachedResult = await repository.compareAndSwap({
      expectedRequestRevision: initial.snapshot.requestRevision,
      next: attached,
    });
    expect(attachedResult.status).toBe("updated");

    authorization = await mintDomainForegroundAuthorization(crypto, {
      plan,
      domains: domainSecrets,
      committerDeviceSigningPrivateKey: signer.privateKey,
      recipientEncryptionPublicKey: recipient.publicKey,
    });
    responseBytes = serializeDomainForegroundAuthorizationV2(authorization);
    const verified = verifyDomainForegroundAuthorizationV2(crypto, {
      authorizationBytes: responseBytes,
      now: START + 2,
      current: {
        authorizationId: plan.authorizationId,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        subjectHumanId: plan.subjectHumanId,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningGeneration:
          plan.committerDeviceSigningGeneration,
        committerDeviceSigningPublicKey: signer.publicKey,
        committerDeviceActive: true,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        recipientKind: plan.recipientKind,
        recipientPrincipalId: plan.recipientPrincipalId,
        recipientAuthorizationRevision: plan.recipientAuthorizationRevision,
        recipientRuntimeGeneration: plan.recipientRuntimeGeneration,
        recipientKeyId: plan.recipientKeyId,
        recipientAuthorized: true,
        domains: domainAuthorities,
      },
    });
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") {
      throw new Error("Task execution fixture authorization did not verify");
    }
    const descriptorHash = crypto.hash(descriptorBytes);
    const responseHash = crypto.hash(responseBytes);
    const issuerSigningPublicKeyHash = crypto.hash(signer.publicKey);
    try {
      const accepted = await repository.acceptVerifiedResponse({
        response: {
          formatVersion: 3,
          kind: "runtime",
          requestId,
          descriptorHash,
          descriptorBytes: descriptorBytes.slice(),
          recipientGeneration: initial.snapshot.recipientGeneration,
          recipientKeyId,
          recipientPublicKey: recipient.publicKey.slice(),
          workId: initial.snapshot.workId,
          workKind: initial.workKind,
          purpose: initial.purpose,
          authoritySet: initial.authoritySet,
          responseBytes: responseBytes.slice(),
          responseHash,
          authorizationId: plan.authorizationId,
          authorizationHash: responseHash.slice(),
          issuingHumanId,
          issuingDeviceId,
          issuingDeviceAuthorizationRevision: issuingDeviceRevision,
          issuerSigningPublicKeyHash,
          issuedAt: plan.issuedAt,
          expiresAt: plan.deadlineAt,
        },
        acceptedAt: START + 2,
      });
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") {
        throw new Error("Task execution fixture response was not accepted");
      }
      const acceptedRecord = accepted.record as
        BackgroundAuthorizationTaskRuntimeRecordV3;
      const claimed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
        ...acceptedRecord,
        snapshot: claimBackgroundAuthorizationRequest(
          acceptedRecord.snapshot,
          `task-claim-${suffix}`,
          START + 3,
          START + 50_000,
        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      };
      const claimedResult = await repository.compareAndSwap({
        expectedRequestRevision: acceptedRecord.snapshot.requestRevision,
        next: claimed,
      });
      expect(claimedResult.status).toBe("updated");
      if (claimedResult.status !== "updated") {
        throw new Error("Task execution fixture claim lost its CAS");
      }
      const storedClaimed = claimedResult.record as
        BackgroundAuthorizationTaskRuntimeRecordV3;
      const running: BackgroundAuthorizationTaskRuntimeRecordV3 = {
        ...storedClaimed,
        snapshot: markBackgroundAuthorizationRunning(
          storedClaimed.snapshot,
          START + 4,
        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      };
      const runningResult = await repository.compareAndSwap({
        expectedRequestRevision: storedClaimed.snapshot.requestRevision,
        next: running,
      });
      expect(runningResult.status).toBe("updated");
      if (runningResult.status !== "updated") {
        throw new Error("Task execution fixture running CAS lost");
      }
      return runningResult.record as BackgroundAuthorizationTaskRuntimeRecordV3;
    } finally {
      descriptorHash.fill(0);
      responseHash.fill(0);
      issuerSigningPublicKeyHash.fill(0);
    }
  } finally {
    if (authorization !== null) {
      destroyDomainForegroundAuthorizationV2(authorization);
    }
    responseBytes?.fill(0);
    descriptorBytes.fill(0);
    destroyDomainForegroundAuthorizationPlanV2(plan);
    domainSecrets.forEach((domain) => {
      domain.participantDigest.fill(0);
      domain.headDigest.fill(0);
      domain.domainKey.fill(0);
    });
    signer.privateKey.fill(0);
    recipient.privateKey.fill(0);
  }
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

  test("holds a live Task execution claim against concurrent cancellation", async () => {
    const base = createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
    const fixture = await verifiedRepository(base);
    const running = await seedRunningExecutionClaim(
      fixture.repository,
      `task-execution-lock-${randomUUID()}`,
    );
    const release = deferred<void>();
    const callbackReady = deferred<void>();
    const held = fixture.repository.withCurrentTaskRuntimeExecutionClaim({
      expected: running,
      now: () => START + 5,
      use: async (current, handle) => {
        expect(current).toEqual(running);
        expect(await new PostgresBackgroundAuthorizationRepository(handle)
          .get(running.snapshot.requestId)).toEqual(running);
        callbackReady.resolve();
        await release.promise;
        return "held";
      },
    });
    void held.catch(error => callbackReady.reject(error));
    await callbackReady.promise;

    const cancelled: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: cancelBackgroundAuthorizationRequest(
        running.snapshot,
        "cancelled",
        START + 6,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 6,
    };
    const cancellationConnection = observedConnection(base);
    const cancellationHandle = await verifyCryptoPostgresHandle(
      cancellationConnection.connection,
    );
    const cancellation = withVerifiedCryptoPostgresTransaction(
      cancellationHandle,
      handle => new PostgresBackgroundAuthorizationRepository(handle)
        .compareAndSwap({
          expectedRequestRevision: running.snapshot.requestRevision,
          next: cancelled,
        }),
    );
    try {
      await waitForBackendLock(base, await cancellationConnection.pid);
      release.resolve();
      expect(await within(held)).toBe("held");
      expect(await within(cancellation)).toEqual({
        status: "updated",
        record: cancelled,
      });
    } finally {
      release.resolve();
      await within(Promise.allSettled([held, cancellation]));
    }
  });

  test("rolls back callback writes when the held Task claim expires", async () => {
    const fixture = await verifiedRepository();
    const running = await seedRunningExecutionClaim(
      fixture.repository,
      `task-execution-expiry-${randomUUID()}`,
    );
    const cancelled: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: cancelBackgroundAuthorizationRequest(
        running.snapshot,
        "cancelled",
        START + 6,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 6,
    };
    const clock = [START + 5, running.snapshot.claimExpiresAt!];
    let callbackWrites = 0;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(fixture.repository.withCurrentTaskRuntimeExecutionClaim({
      expected: running,
      now: () => clock.shift()!,
      use: async (_current, handle) => {
        const result = await new PostgresBackgroundAuthorizationRepository(
          handle,
        ).compareAndSwap({
          expectedRequestRevision: running.snapshot.requestRevision,
          next: cancelled,
        });
        expect(result).toEqual({ status: "updated", record: cancelled });
        callbackWrites += 1;
        return "must-roll-back";
      },
    })).rejects.toThrow("expired during transaction");
    expect(callbackWrites).toBe(1);
    expect(await fixture.repository.get(running.snapshot.requestId)).toEqual(
      running,
    );
  });
});
