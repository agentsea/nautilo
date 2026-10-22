import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import { finalizeProtectedTaskCheckpointPause } from "../../src/queries/protected-task-checkpoint-pause";
import { protectedTaskSemanticAuthorityRequirementsDigest } from
  "../../src/queries/protected-task-execution-receipts";
import {
  parkProtectedTaskRun,
  sealAndParkProtectedTaskCheckpointRun,
  type SealAndParkProtectedTaskCheckpointRunInput,
  sealAndParkProtectedTaskHumanRun,
  sealAndParkProtectedTaskRun,
  type ParkProtectedTaskRunInput,
  type ProtectedTaskDurableJobReference,
  type SealAndParkProtectedTaskRunInput,
  type SealAndParkProtectedTaskHumanRunInput,
} from "../../src/queries/tasks";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskContinuationReceipts,
  type ProtectedTaskContinuationReceipt,
} from "../../src/schema/protected-task-continuation-receipts";
import {
  protectedTaskExecutionSegmentReceipts,
  type ProtectedTaskExecutionSegmentReceipt,
} from "../../src/schema/protected-task-execution-segment-receipts";
import { taskRunMessageAssociations } from
  "../../src/schema/task-run-message-associations";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  agent: "50000000-0000-4000-8000-000000000005",
  namespace: "60000000-0000-4000-8000-000000000006",
  session: "70000000-0000-4000-8000-000000000007",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const parkedAt = new Date("2026-10-07T12:34:56.000Z");
const fingerprint = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const digest = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 32 }, (_, index) => seed + index));
const semanticAuthorityRequirements = Object.freeze([Object.freeze({
  namespaceId: ids.namespace,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
})]);

function reference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 9,
    executionSegment: 1,
    ...overrides,
  };
}

function parkInput(
  overrides: Partial<ParkProtectedTaskRunInput> = {},
): ParkProtectedTaskRunInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    jobId: ids.job,
    generation: 3,
    executionSegment: 1,
    interrupts: [{
      id: "interrupt:authority:1",
      kind: "additional_authority",
      requestId: "authority-request:1",
    }],
    parkedAt,
    jobReference: reference(),
    ...overrides,
  };
}

function input(
  overrides: Partial<SealAndParkProtectedTaskRunInput> = {},
): SealAndParkProtectedTaskRunInput {
  return {
    park: parkInput(),
    segment: {
      route: "native_langgraph_v1",
      checkpoint: {
        contract: "encrypted_langgraph_v1",
        expectedCheckpointCount: 2,
        checkpointOrderedDigest: digest(1),
        expectedBlobCount: 3,
        blobOrderedDigest: digest(2),
        expectedPendingWriteCount: 1,
        pendingWriteOrderedDigest: digest(3),
      },
    },
    continuation: {
      kind: "pre_effect_interrupt_v1",
      reason: "additional_authority",
      effectDisposition: "not_started_v1",
      interruptId: "interrupt:authority:1",
      operationId: "task-effect:1",
      requestDigest: digest(4),
      requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
        semanticAuthorityRequirements,
      ),
      stableRoutingDigest: digest(5),
      semanticAuthorityRequirements,
    },
    ...overrides,
  };
}

function humanInput(): SealAndParkProtectedTaskHumanRunInput {
  const additional = input();
  return {
    park: {
      ...additional.park,
      interrupts: [{
        id: "interrupt:approval:1",
        kind: "approval",
        requestId: "approval:1",
      }],
    },
    segment: additional.segment,
    stableRoutingDigest: digest(9),
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    scheduleKind: "one_shot",
    fundingMode: "legacy_server",
    status: "running",
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    metadata: {},
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId,
    status: "running",
    modelId: "openai:gpt-6-sol",
    fundingBinding: null,
    fundingPredecessorRunId: null,
    resultText: null,
    startedAt: new Date("2026-10-07T12:00:00.000Z"),
    completedAt: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "running",
    input: reference(),
    result: null,
    message: null,
    createdAt: new Date("2026-10-07T12:00:01.000Z"),
    startedAt: new Date("2026-10-07T12:00:02.000Z"),
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: Task;
  run?: TaskRun;
  job?: Job;
}>;

function harness(options: HarnessOptions = {}) {
  let taskRow = options.task ?? task();
  let runRow = options.run ?? run();
  let jobRow = options.job ?? job();
  let segments: ProtectedTaskExecutionSegmentReceipt[] = [];
  let continuations: ProtectedTaskContinuationReceipt[] = [];
  const associations = [{
    taskRunId: ids.run,
    sessionId: ids.session,
    messageId: 17,
    publishedRevision: 2,
    kind: "transcript" as const,
    publicationKey: "transcript:17:2",
  }];
  const locks: Array<{ table: unknown; kind: string }> = [];
  const attemptedInserts: unknown[] = [];

  const rows = (table: unknown, projection?: unknown): unknown[] => {
    if (projection !== null && typeof projection === "object") {
      if (table === taskRuns && "resultTextIsNull" in projection) return [{ ...runRow,
        resultTextIsNull: runRow.resultText === null, lastErrorIsNull: runRow.lastError === null }];
      if (table === jobs && "resultIsNull" in projection) return [{ ...jobRow,
        resultIsNull: jobRow.result === null, messageIsNull: jobRow.message === null }];
    }
    if (table === tasks) return [taskRow];
    if (table === taskRuns) return [runRow];
    if (table === jobs) return [jobRow];
    if (table === taskRunMessageAssociations) return associations;
    if (table === protectedTaskExecutionSegmentReceipts) return segments;
    if (table === protectedTaskContinuationReceipts) return continuations;
    throw new Error("unexpected table");
  };
  const queryFor = (table: unknown, projection?: unknown) => {
    const query = {
      where: (_condition: unknown) => query,
      orderBy: (_order: unknown) => query,
      limit: (_limit: number) => query,
      for: async (kind: string) => {
        locks.push({ table, kind });
        return rows(table, projection);
      },
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(rows(table, projection)).then(resolve, reject),
    };
    return query;
  };
  const tx = {
    select: (projection?: unknown) => ({
      from: (table: unknown) => queryFor(table, projection),
    }),
    insert: (table: unknown) => ({
      values: (value: ProtectedTaskExecutionSegmentReceipt
        | ProtectedTaskContinuationReceipt) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            attemptedInserts.push(table);
            if (table === protectedTaskExecutionSegmentReceipts) {
              if (segments.some(row => row.jobId === value.jobId
                || row.taskRunId === value.taskRunId
                  && row.executionSegment === value.executionSegment)) return [];
              segments.push(value as ProtectedTaskExecutionSegmentReceipt);
              return [value];
            }
            if (table === protectedTaskContinuationReceipts) {
              if (continuations.some(row => row.jobId === value.jobId
                || row.taskRunId === value.taskRunId
                  && row.executionSegment === value.executionSegment)) return [];
              continuations.push(value as ProtectedTaskContinuationReceipt);
              return [value];
            }
            throw new Error("unexpected insert table");
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table === jobs) {
              jobRow = { ...jobRow, ...patch } as Job;
              return [jobRow];
            }
            if (table === taskRuns) {
              runRow = { ...runRow, ...patch } as TaskRun;
              return [runRow];
            }
            if (table === tasks) {
              taskRow = { ...taskRow, ...patch } as Task;
              return [taskRow];
            }
            throw new Error("unexpected update table");
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <Value>(
      operation: (value: typeof tx) => Promise<Value>,
    ): Promise<Value> => {
      const before = {
        taskRow,
        runRow,
        jobRow,
        segments: [...segments],
        continuations: [...continuations],
      };
      try {
        return await operation(tx);
      } catch (error) {
        taskRow = before.taskRow;
        runRow = before.runRow;
        jobRow = before.jobRow;
        segments = before.segments;
        continuations = before.continuations;
        throw error;
      }
    },
  } as unknown as DirectDatabase;
  return {
    db,
    locks,
    attemptedInserts,
    state: () => ({ taskRow, runRow, jobRow, segments, continuations }),
  };
}

describe("protected Task execution seal-and-park owner", () => {
  test("seals a Human segment and park without an authority receipt", async () => {
    const fixture = harness();
    expect(await sealAndParkProtectedTaskHumanRun(
      fixture.db,
      humanInput(),
    )).toEqual({ status: "parked" });
    expect(fixture.state().segments).toHaveLength(1);
    expect(fixture.state().continuations).toEqual([]);
    expect(fixture.state().jobRow.metadata).toEqual({
      "nautilo.protectedTaskRunPark.v1": {
        version: 1,
        taskId: ids.task,
        taskRunId: ids.run,
        jobId: ids.job,
        graphThreadId,
        generation: 3,
        executionSegment: 1,
        interrupts: [{
          id: "interrupt:approval:1",
          kind: "approval",
          requestId: "approval:1",
        }],
        parkedAt: parkedAt.toISOString(),
        stableRoutingDigest: Buffer.from(digest(9)).toString("base64url"),
      },
    });
    expect(await sealAndParkProtectedTaskHumanRun(
      fixture.db,
      humanInput(),
    )).toEqual({ status: "exact_replay" });
  });
  test("locks the exact lifecycle chain before sealing and parks atomically", async () => {
    const fixture = harness();

    expect(await sealAndParkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "parked",
    });
    expect(fixture.locks.slice(0, 3)).toEqual([
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
    ]);
    expect(fixture.state().segments).toHaveLength(1);
    expect(fixture.state().segments[0]).toMatchObject({
      taskRunId: ids.run,
      jobId: ids.job,
      sealedAt: parkedAt,
      expectedTranscriptAssociationCount: 1,
    });
    expect(fixture.state().continuations).toHaveLength(1);
    expect(fixture.state().continuations[0]).toMatchObject({
      interruptId: "interrupt:authority:1",
      reason: "additional_authority",
      sealedAt: parkedAt,
    });
    expect(fixture.state().taskRow.status).toBe("awaiting");
    expect(fixture.state().runRow.status).toBe("awaiting");
    expect(fixture.state().jobRow.status).toBe("completed");
  });

  test("replays only the same complete receipt pair and park", async () => {
    const fixture = harness();
    expect(await sealAndParkProtectedTaskRun(fixture.db, input()))
      .toEqual({ status: "parked" });

    expect(await sealAndParkProtectedTaskRun(fixture.db, input()))
      .toEqual({ status: "exact_replay" });
    expect(fixture.state().segments).toHaveLength(1);
    expect(fixture.state().continuations).toHaveLength(1);
  });

  test("rolls back both immutable receipts when late park validation fails", async () => {
    const fixture = harness({
      task: task({ cryptoMappingState: "unmapped" }),
    });

    expect(await sealAndParkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "rejected",
      stage: "park",
      reason: "stale",
    });
    expect(fixture.attemptedInserts).toEqual([
      protectedTaskExecutionSegmentReceipts,
      protectedTaskContinuationReceipts,
    ]);
    expect(fixture.state().segments).toEqual([]);
    expect(fixture.state().continuations).toEqual([]);
    expect(fixture.state().runRow.status).toBe("running");
    expect(fixture.state().jobRow.status).toBe("running");
  });

  test("does not backfill receipts after a standalone park", async () => {
    const fixture = harness();
    expect(await parkProtectedTaskRun(fixture.db, parkInput()))
      .toEqual({ status: "parked" });

    expect(await sealAndParkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "rejected",
      stage: "park",
      reason: "conflict",
    });
    expect(fixture.state().segments).toEqual([]);
    expect(fixture.state().continuations).toEqual([]);
    expect(fixture.state().runRow.status).toBe("awaiting");
  });

  test("rejects Plain state without persisting evidence or changing lifecycle", async () => {
    const fixture = harness({
      task: task({
        contentRepresentation: "ordinary",
        prompt: "ordinary definition",
      }),
    });

    expect(await sealAndParkProtectedTaskRun(fixture.db, input())).toEqual({
      status: "rejected",
      stage: "segment",
      reason: "not_protected",
    });
    expect(fixture.state().segments).toEqual([]);
    expect(fixture.state().continuations).toEqual([]);
    expect(fixture.state().taskRow.status).toBe("running");
    expect(fixture.state().runRow.status).toBe("running");
  });

  test("binds the continuation to a present interrupt and authority kind", async () => {
    const missing = harness();
    expect(sealAndParkProtectedTaskRun(missing.db, input({
      continuation: {
        ...input().continuation,
        interruptId: "interrupt:missing",
      },
    }))).rejects.toThrow("continuation is malformed");
    expect(missing.locks).toEqual([]);

    const substituted = harness();
    expect(sealAndParkProtectedTaskRun(substituted.db, input({
      park: parkInput({
        interrupts: [{ id: "interrupt:authority:1", kind: "approval" }],
      }),
    }))).rejects.toThrow("continuation is malformed");
    expect(substituted.locks).toEqual([]);

    const unsupportedRefresh = harness();
    expect(sealAndParkProtectedTaskRun(unsupportedRefresh.db, input({
      continuation: {
        ...input().continuation,
        reason: "grant_refresh",
      } as unknown as SealAndParkProtectedTaskRunInput["continuation"],
    }))).rejects.toThrow("continuation is malformed");
    expect(unsupportedRefresh.locks).toEqual([]);

    const missingRouting = harness();
    const missingContinuation = {
      ...input().continuation,
    } as Record<string, unknown>;
    delete missingContinuation["stableRoutingDigest"];
    expect(sealAndParkProtectedTaskRun(missingRouting.db, input({
      continuation: missingContinuation as unknown as
        SealAndParkProtectedTaskRunInput["continuation"],
    }))).rejects.toThrow("continuation is malformed");
    expect(missingRouting.locks).toEqual([]);

    const malformedRouting = harness();
    expect(sealAndParkProtectedTaskRun(malformedRouting.db, input({
      continuation: {
        ...input().continuation,
        stableRoutingDigest: new Uint8Array(31),
      },
    }))).rejects.toThrow("continuation is malformed");
    expect(malformedRouting.locks).toEqual([]);
  });

  test("requires a nonempty native encrypted checkpoint before opening a transaction", async () => {
    const fixture = harness();
    expect(sealAndParkProtectedTaskRun(fixture.db, input({
      segment: {
        ...input().segment,
        checkpoint: {
          ...input().segment.checkpoint,
          expectedCheckpointCount: 0,
          checkpointOrderedDigest: null,
        },
      },
    }))).rejects.toThrow("segment is malformed");
    expect(fixture.locks).toEqual([]);
    expect(fixture.attemptedInserts).toEqual([]);
  });

  test("snapshots checkpoint and continuation digests before lifecycle awaits", async () => {
    const fixture = harness();
    const request = input();
    const checkpointDigest = request.segment.checkpoint.checkpointOrderedDigest!;
    const requestDigest = request.continuation.requestDigest;
    const requiredAuthorityDigest = request.continuation.requiredAuthorityDigest;
    const stableRoutingDigest = request.continuation.stableRoutingDigest;
    const expectedCheckpointDigest = checkpointDigest.slice();
    const expectedRequestDigest = requestDigest.slice();
    const expectedAuthorityDigest = requiredAuthorityDigest.slice();
    const expectedStableRoutingDigest = stableRoutingDigest.slice();

    const pending = sealAndParkProtectedTaskRun(fixture.db, request);
    checkpointDigest.fill(255);
    requestDigest.fill(254);
    requiredAuthorityDigest.fill(253);
    stableRoutingDigest.fill(252);
    expect(await pending).toEqual({ status: "parked" });

    expect(fixture.state().segments[0]?.checkpointDigest)
      .toEqual(expectedCheckpointDigest);
    expect(fixture.state().continuations[0]?.requestDigest)
      .toEqual(expectedRequestDigest);
    expect(fixture.state().continuations[0]?.requiredAuthorityDigest)
      .toEqual(expectedAuthorityDigest);
    expect(fixture.state().continuations[0]?.stableRoutingDigest)
      .toEqual(expectedStableRoutingDigest);
    expect(fixture.state().continuations[0]?.semanticAuthorityRequirements)
      .toEqual(semanticAuthorityRequirements);
  });
});


function checkpointInput(reason: "manual_pause" | "time_limit" | "grant_refresh" = "manual_pause"): SealAndParkProtectedTaskCheckpointRunInput {
  return { park: { ...parkInput(), interrupts: [] }, segment: input().segment,
    continuation: { kind: "checkpoint_safe_v1", reason, effectDisposition: "none_v1" },
    pauseRequestId: reason === "grant_refresh" ? null : ids.session, stableRoutingDigest: digest(9) };
}

describe("cooperative checkpoint seal and park", () => {
  test("seals and replays the original checkpoint AAD without permitting substitution", async () => {
    const fixture = harness();
    const binding = { version: 1 as const, namespaceId: ids.namespace, domainId: ids.owner,
      namespaceAccessRevision: 2, policyRevision: reference().policyRevision };
    const request = checkpointInput("grant_refresh");
    const bound = { ...request, park: { ...request.park, checkpointAadBinding: binding } };
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, bound)).toEqual({ status: "parked" });
    expect(fixture.state().jobRow.metadata["nautilo.protectedTaskRunPark.v1"])
      .toMatchObject({ checkpointAadBinding: binding });
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, bound)).toEqual({ status: "exact_replay" });
    const changed = { ...bound, park: { ...bound.park, checkpointAadBinding: { ...binding, namespaceAccessRevision: 3 } } };
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, changed)).toMatchObject({ status: "rejected" });
    expect(fixture.state().jobRow.metadata["nautilo.protectedTaskRunPark.v1"])
      .toMatchObject({ checkpointAadBinding: binding });
    const wrongNamespace = harness();
    expect(await sealAndParkProtectedTaskCheckpointRun(wrongNamespace.db,
      { ...bound, park: { ...bound.park, checkpointAadBinding: { ...binding, namespaceId: ids.owner } } }))
      .toMatchObject({ status: "rejected" });
    expect(wrongNamespace.state().segments).toEqual([]);
  });

  test("pairs empty park metadata with physical and checkpoint-safe receipts atomically", async () => {
    const fixture = harness({ task: task({ pauseRequestId: ids.session,
      pauseReason: "manual_pause", pauseRequestedAt: new Date(parkedAt.getTime() - 1) }) });
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput())).toEqual({ status: "parked" });
    expect(fixture.state().segments).toHaveLength(1);
    expect(fixture.state().continuations[0]).toMatchObject({ kind: "checkpoint_safe_v1", reason: "manual_pause", effectDisposition: "none_v1", stableRoutingDigest: null });
    expect(fixture.state().jobRow.metadata["nautilo.protectedTaskRunPark.v1"]).toMatchObject({ interrupts: [], stableRoutingDigest: Buffer.from(digest(9)).toString("base64url") });
    expect(fixture.locks.slice(0, 3)).toEqual([{ table: tasks, kind: "update" }, { table: taskRuns, kind: "update" }, { table: jobs, kind: "update" }]);
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput())).toEqual({ status: "exact_replay" });
    expect(await finalizeProtectedTaskCheckpointPause(fixture.db, { taskId: ids.task, pauseRequestId: ids.session })).toBe("paused");
    expect(fixture.state().taskRow.status).toBe("paused");
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput())).toEqual({ status: "exact_replay" });
  });
  test("manual checkpoint requires its exact request and reason", async () => {
    for (const candidate of [checkpointInput("time_limit"), { ...checkpointInput(), pauseRequestId: ids.task }]) {
      const fixture = harness({ task: task({ pauseRequestId: ids.session, pauseReason: "manual_pause", pauseRequestedAt: parkedAt }) });
      expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, candidate)).toEqual({ status: "rejected", stage: "park", reason: "stale" });
      expect(fixture.state().segments).toEqual([]);
      expect(fixture.state().continuations).toEqual([]);
      expect(fixture.state().runRow.status).toBe("running");
    }
  });
  test("grant refresh is allowed without pause and ordinary empty park remains invalid", async () => {
    const fixture = harness();
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput("grant_refresh"))).toEqual({ status: "parked" });
    expect(parkProtectedTaskRun(fixture.db, checkpointInput().park)).rejects.toThrow("malformed");
    expect(sealAndParkProtectedTaskHumanRun(fixture.db, { ...humanInput(), park: checkpointInput().park })).rejects.toThrow("malformed");
  });
  test("late park rejection rolls back both immutable receipts", async () => {
    const fixture = harness({ job: job({ status: "cancelled" }) });
    expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput("grant_refresh"))).toEqual({ status: "rejected", stage: "park", reason: "stale" });
    expect(fixture.state().segments).toEqual([]);
    expect(fixture.state().continuations).toEqual([]);
  });
});


test("existing Human park can settle pause only while its physical proof remains exact", async () => {
  const fixture = harness({ task: task({ pauseRequestId: ids.session, pauseReason: "manual_pause", pauseRequestedAt: parkedAt }) });
  expect(await sealAndParkProtectedTaskHumanRun(fixture.db, humanInput())).toEqual({ status: "parked" });
  expect(await finalizeProtectedTaskCheckpointPause(fixture.db, { taskId: ids.task, pauseRequestId: ids.session })).toBe("paused");
  fixture.state().segments[0]!.expectedCheckpointCount = 0;
  expect(await finalizeProtectedTaskCheckpointPause(fixture.db, { taskId: ids.task, pauseRequestId: ids.session })).toBe("pending");
});


test("manual pause arriving after refresh request preserves a genuine safe park", async () => {
  const fixture = harness({ task: task({ pauseRequestId: ids.session,
    pauseReason: "manual_pause", pauseRequestedAt: parkedAt }) });
  expect(await sealAndParkProtectedTaskCheckpointRun(fixture.db, checkpointInput("grant_refresh"))).toEqual({ status: "parked" });
  expect(fixture.state().taskRow.pauseRequestId).toBe(ids.session);
  expect(fixture.state().continuations[0]?.reason).toBe("grant_refresh");
  expect(await finalizeProtectedTaskCheckpointPause(fixture.db, { taskId: ids.task, pauseRequestId: ids.session })).toBe("paused");
});
