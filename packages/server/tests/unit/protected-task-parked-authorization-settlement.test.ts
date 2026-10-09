import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  jobs,
  taskRuns,
  tasks,
  type DirectDatabase,
  type ParkedProtectedTaskAdditionalAuthority,
} from "@nautilo/db";
import {
  InMemoryBackgroundAuthorizationRepository,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import {
  createProtectedTaskParkedAuthorizationSettlement,
} from "../../src/routes/protected-task-parked-authorization-settlement";

const START = 1_900_000_000_000;
const PARKED_AT = START + 10;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const JOB = "30000000-0000-4000-8000-000000000003";
const NAMESPACE = "40000000-0000-4000-8000-000000000004";
const USER = "50000000-0000-4000-8000-000000000005";
const AGENT = "60000000-0000-4000-8000-000000000006";
const ROOM = "70000000-0000-4000-8000-000000000007";
const HUMAN = "80000000-0000-4000-8000-000000000008";
const REQUEST = `task-run-authorization:${RUN}`;
const NEXT_REQUEST = `task-run-authorization:v2:${RUN}:2`;
const INPUT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT = `task-run-result:v1:${"b".repeat(64)}`;
const publicKey = Buffer.alloc(65, 7).toString("base64url");

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function runningRecord(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const responseBytes = new Uint8Array([4, 5, 6]);
  const descriptorDigest = digest(descriptorBytes);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: REQUEST,
    workId: RUN,
    namespaceId: NAMESPACE,
    now: START,
  });
  const waiting = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "parked-settlement-recipient",
    recipientPublicKey: publicKey,
    descriptorDigest,
    expiresAt: START + 60_000,
    now: START + 1,
  });
  const ready = markBackgroundAuthorizationGrantReady(waiting, {
    kind: "runtime",
    requestId: REQUEST,
    descriptorDigest,
    recipientKeyId: "parked-settlement-recipient",
    recipientPublicKey: publicKey,
    expiresAt: START + 60_000,
    responseDigest: digest(responseBytes),
    credentialDigest: "cd".repeat(32),
    issuingHumanId: HUMAN,
    issuingDeviceId: "parked-settlement-device",
    recipientGeneration: 0,
    now: START + 2,
  });
  const claimed = claimBackgroundAuthorizationRequest(
    ready,
    "parked-settlement-claim",
    START + 3,
    START + 30_000,
  );
  return {
    snapshot: markBackgroundAuthorizationRunning(claimed, START + 4),
    workIdentityHash: new Uint8Array(32).fill(9),
    idempotencyKey: `task-runtime-stable-v1:${RUN}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "parked-settlement-domain",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes,
    acceptedMaterial: {
      responseBytes,
      credentialId: "parked-settlement-credential",
      issuingDeviceAuthorizationRevision: 7,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(2),
      authorizationExpiresAt: START + 60_000,
    },
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: "parked-settlement-domain",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 5,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "parked-settlement-domain",
        expectedEpoch: 3,
        expectedAuthorizationRevision: 8,
      }],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
}

function candidate(): ParkedProtectedTaskAdditionalAuthority {
  const fingerprint = Buffer.alloc(32, 9).toString("base64url");
  const sealedAt = new Date(PARKED_AT - 1);
  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: TASK,
        ownerId: USER,
        requestorId: USER,
        agentId: AGENT,
        callingRoomId: ROOM,
        scheduleKind: "now",
        status: "awaiting",
        contentRepresentation: "dual",
        contentNamespaceId: NAMESPACE,
        contentRevision: 3,
        cryptoObjectId: INPUT,
        cryptoAccessRevision: 4,
        cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(5),
      }),
      run: Object.freeze({
        id: RUN,
        taskId: TASK,
        jobId: JOB,
        graphThreadId: "parked-settlement-thread",
        status: "awaiting",
        startedAt: new Date(START - 100),
      }),
    }),
    priorJob: Object.freeze({
      id: JOB,
      generation: 0,
      parkedAt: new Date(PARKED_AT),
      interrupts: Object.freeze([Object.freeze({
        id: "interrupt:additional-authority",
        kind: "additional_authority",
        requestId: "request:additional-authority",
      })]),
      reference: Object.freeze({
        kind: "protected_task_run_v1",
        taskId: TASK,
        taskRunId: RUN,
        inputObjectId: INPUT,
        resultObjectId: RESULT,
        authorizationRequestId: REQUEST,
        policyRevision: 5,
        executionSegment: 1,
      }),
    }),
    proof: Object.freeze({
      segment: Object.freeze({
        taskRunId: RUN,
        executionSegment: 1,
        jobId: JOB,
        route: "native_langgraph_v1",
        transcriptContract: "protected_message_associations_v1",
        expectedTranscriptAssociationCount: 1,
        transcriptAssociationDigest: new Uint8Array(32).fill(1),
        checkpointContract: "encrypted_langgraph_v1",
        expectedCheckpointCount: 2,
        checkpointDigest: new Uint8Array(32).fill(2),
        expectedCheckpointBlobCount: 3,
        checkpointBlobDigest: new Uint8Array(32).fill(3),
        expectedPendingWriteCount: 1,
        pendingWriteDigest: new Uint8Array(32).fill(4),
        sealedAt,
      }),
      continuation: Object.freeze({
        taskRunId: RUN,
        executionSegment: 1,
        jobId: JOB,
        kind: "pre_effect_interrupt_v1",
        reason: "additional_authority",
        effectDisposition: "not_started_v1",
        interruptId: "interrupt:additional-authority",
        operationId: "operation:additional-authority",
        requestDigest: new Uint8Array(32).fill(6),
        requiredAuthorityDigest: new Uint8Array(32).fill(7),
        stableRoutingDigest: new Uint8Array(32).fill(8),
        semanticAuthorityRequirements: Object.freeze([Object.freeze({
          namespaceId: NAMESPACE,
          operations: Object.freeze(["decrypt", "encrypt"] as const),
        })]),
        sealedAt,
      }),
    }),
    authorizationRequestId: NEXT_REQUEST,
    continuationFingerprint: fingerprint,
    nextExecutionSegment: 2,
  });
}

function completedRecord(
  running: BackgroundAuthorizationTaskRuntimeRecordV3,
  at = PARKED_AT,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    ...running,
    snapshot: completeBackgroundAuthorizationRequest(
      running.snapshot,
      at,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    finishedAt: at,
  };
}

type FakeDatabase = Readonly<{
  db: DirectDatabase;
  events: string[];
  failAfterOperation: () => void;
}>;

function fakeDatabase(): FakeDatabase {
  const events: string[] = [];
  let fail = false;
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        events.push(table === tasks ? "lock-task"
          : table === taskRuns ? "lock-run"
            : table === jobs ? "lock-job"
              : "lock-unknown");
        return {
          where: () => ({
            limit: () => ({ for: async () => [{}] }),
          }),
        };
      },
    }),
  };
  const db = {
    transaction: async (operation: (value: typeof tx) => Promise<unknown>) => {
      events.push("transaction-start");
      const result = await operation(tx);
      if (fail) {
        fail = false;
        events.push("transaction-rollback");
        throw new Error("product settlement response lost");
      }
      events.push("transaction-commit");
      return result;
    },
  } as unknown as DirectDatabase;
  return Object.freeze({
    db,
    events,
    failAfterOperation: () => { fail = true; },
  });
}

function settlement(input: Readonly<{
  expected: ParkedProtectedTaskAdditionalAuthority;
  database: FakeDatabase;
  repository: InMemoryBackgroundAuthorizationRepository;
  releases: string[];
  discover?: () => Promise<ParkedProtectedTaskAdditionalAuthority | null>;
  read?: () => Promise<ParkedProtectedTaskAdditionalAuthority | null>;
  compareAndSwap?: (
    value: Parameters<
      InMemoryBackgroundAuthorizationRepository["compareAndSwap"]
    >[0],
  ) => ReturnType<InMemoryBackgroundAuthorizationRepository["compareAndSwap"]>;
}>) {
  return createProtectedTaskParkedAuthorizationSettlement({
    db: input.database.db,
    repository: {
      get: id => input.repository.get(id),
      compareAndSwap: value => input.compareAndSwap?.(value)
        ?? input.repository.compareAndSwap(value),
    },
    recipients: {
      delete: (requestId, generation) => {
        input.database.events.push("release");
        input.releases.push(`${requestId}:${generation}`);
        return true;
      },
    },
  }, {
    discover: (input.discover ?? (async () => input.expected)) as never,
    read: (input.read ?? (async () => input.expected)) as never,
  });
}

describe("protected Task parked authorization settlement", () => {
  test("settles the exact prior grant under Task, Run, and Job locks", async () => {
    const expected = candidate();
    const record = runningRecord();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(record);
    const database = fakeDatabase();
    const releases: string[] = [];
    const reconcile = settlement({
      expected,
      database,
      repository,
      releases,
      compareAndSwap: value => {
        database.events.push("grant-cas");
        return repository.compareAndSwap(value);
      },
    });

    expect(await reconcile.settle(expected.occurrence)).toBe("settled");
    expect(await repository.get(REQUEST)).toMatchObject({
      snapshot: { state: "completed", updatedAt: PARKED_AT },
      finishedAt: PARKED_AT,
    });
    expect(database.events).toEqual([
      "transaction-start",
      "lock-task",
      "lock-run",
      "lock-job",
      "grant-cas",
      "transaction-commit",
      "release",
    ]);
    expect(releases).toEqual([`${REQUEST}:0`]);
  });

  test("adopts an exact prior completion without another grant mutation", async () => {
    const expected = candidate();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(completedRecord(runningRecord()));
    const database = fakeDatabase();
    const releases: string[] = [];
    let casCalls = 0;
    const reconcile = settlement({
      expected,
      database,
      repository,
      releases,
      compareAndSwap: value => {
        casCalls += 1;
        return repository.compareAndSwap(value);
      },
    });

    expect(await reconcile.settle(expected.occurrence)).toBe("settled");
    expect(casCalls).toBe(0);
    expect(releases).toEqual([`${REQUEST}:0`]);
  });

  test("adopts a completion whose crypto CAS response was lost", async () => {
    const expected = candidate();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(runningRecord());
    const database = fakeDatabase();
    const releases: string[] = [];
    const reconcile = settlement({
      expected,
      database,
      repository,
      releases,
      compareAndSwap: async value => {
        expect(await repository.compareAndSwap(value))
          .toMatchObject({ status: "updated" });
        throw new Error("grant completion response lost");
      },
    });

    expect(await reconcile.settle(expected.occurrence)).toBe("settled");
    expect((await repository.get(REQUEST))?.snapshot.state).toBe("completed");
    expect(releases).toEqual([`${REQUEST}:0`]);
  });

  test("returns inactive before crypto access when product proof is absent or changed", async () => {
    const expected = candidate();
    for (const scenario of ["absent", "changed"] as const) {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(runningRecord());
      const database = fakeDatabase();
      const releases: string[] = [];
      let reads = 0;
      const reconcile = settlement({
        expected,
        database,
        repository,
        releases,
        discover: async () => {
          reads += 1;
          if (scenario === "absent") return null;
          return {
            ...expected,
            occurrence: {
              ...expected.occurrence,
              run: { ...expected.occurrence.run, jobId:
                "90000000-0000-4000-8000-000000000009" },
            },
          };
        },
      });

      expect(await reconcile.settle(expected.occurrence)).toBe("inactive");
      expect(reads).toBe(1);
      expect(database.events).toEqual([]);
      expect(await repository.get(REQUEST)).toEqual(runningRecord());
      expect(releases).toEqual([]);
    }
  });

  test("keeps custody when the prior grant or locked proof is not exact", async () => {
    for (const scenario of [
      "wrong_policy",
      "wrong_generation",
      "wrong_completion_time",
      "changed_under_lock",
    ] as const) {
      const expected = candidate();
      const base = runningRecord();
      const record: BackgroundAuthorizationRecord =
        scenario === "wrong_completion_time"
          ? completedRecord(base, PARKED_AT + 1)
          : base;
      const selected = scenario === "wrong_policy"
        ? {
            ...expected,
            priorJob: {
              ...expected.priorJob,
              reference: { ...expected.priorJob.reference, policyRevision: 6 },
            },
          }
        : scenario === "wrong_generation"
          ? {
              ...expected,
              priorJob: { ...expected.priorJob, generation: 1 },
            }
        : expected;
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(record);
      const database = fakeDatabase();
      const releases: string[] = [];
      let casCalls = 0;
      const reconcile = settlement({
        expected: selected,
        database,
        repository,
        releases,
        ...(scenario === "changed_under_lock" ? {
          read: async () => ({ ...selected, nextExecutionSegment: 3 }),
        } : {}),
        compareAndSwap: value => {
          casCalls += 1;
          return repository.compareAndSwap(value);
        },
      });

      expect(await reconcile.settle(selected.occurrence)).toBe(
        scenario === "changed_under_lock" ? "inactive" : "pending",
      );
      expect(casCalls).toBe(0);
      expect(releases).toEqual([]);
    }
  });

  test("captures the caller occurrence before discovery awaits", async () => {
    const expected = candidate();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(runningRecord());
    const database = fakeDatabase();
    const releases: string[] = [];
    let releaseDiscovery: (() => void) | undefined;
    const discoveryGate = new Promise<void>(resolve => {
      releaseDiscovery = resolve;
    });
    const reconcile = settlement({
      expected,
      database,
      repository,
      releases,
      discover: async () => {
        await discoveryGate;
        return expected;
      },
    });
    const observed = structuredClone(expected.occurrence) as
      ProtectedTaskOccurrence;

    const result = reconcile.settle(observed);
    (observed.run as { jobId: string | null }).jobId =
      "90000000-0000-4000-8000-000000000009";
    releaseDiscovery?.();
    expect(await result).toBe("settled");
    expect(releases).toEqual([`${REQUEST}:0`]);
  });

  test("releases custody only after product commit and retries a split commit", async () => {
    const expected = candidate();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(runningRecord());
    const database = fakeDatabase();
    const releases: string[] = [];
    const reconcile = settlement({ expected, database, repository, releases });
    database.failAfterOperation();

    expect(await reconcile.settle(expected.occurrence).catch(
      (error: unknown) => error,
    )).toMatchObject({ message: "product settlement response lost" });
    expect((await repository.get(REQUEST))?.snapshot.state).toBe("completed");
    expect(releases).toEqual([]);

    expect(await reconcile.settle(expected.occurrence)).toBe("settled");
    expect(releases).toEqual([`${REQUEST}:0`]);
    expect(database.events.at(-2)).toBe("transaction-commit");
    expect(database.events.at(-1)).toBe("release");
  });
});
