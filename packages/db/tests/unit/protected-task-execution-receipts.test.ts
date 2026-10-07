import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  canonicalProtectedTaskSemanticAuthorityRequirements,
  PROTECTED_TASK_EXECUTION_ROUTES,
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
  readProtectedTaskExecutionContinuationProof,
  sealProtectedTaskContinuationReceipt,
  sealProtectedTaskContinuationReceiptInTx,
  sealProtectedTaskExecutionSegmentReceiptInTx,
  type SealProtectedTaskContinuationReceiptInput,
  type SealProtectedTaskExecutionSegmentReceiptInput,
} from "../../src/queries/protected-task-execution-receipts";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskContinuationReceipts,
  type ProtectedTaskContinuationReceipt,
} from "../../src/schema/protected-task-continuation-receipts";
import {
  protectedTaskExecutionSegmentReceipts,
  type ProtectedTaskExecutionSegmentReceipt,
} from "../../src/schema/protected-task-execution-segment-receipts";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  otherJob: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  agent: "50000000-0000-4000-8000-000000000006",
};
const sealedAt = new Date("2026-10-06T10:00:00.000Z");
const digest = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 32 }, (_, index) => seed + index));
const semanticAuthorityRequirements = Object.freeze([Object.freeze({
  namespaceId: "60000000-0000-4000-8000-000000000007",
  operations: Object.freeze(["decrypt", "encrypt"] as const),
})]);

const authorityFingerprintInput = () => ({
  taskRunId: ids.run,
  executionSegment: 1,
  jobId: ids.job,
  kind: "pre_effect_interrupt_v1" as const,
  reason: "additional_authority" as const,
  effectDisposition: "not_started_v1" as const,
  interruptId: "interrupt:task-effect:1",
  operationId: "task-effect:1",
  requestDigest: digest(5),
  requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
    semanticAuthorityRequirements,
  ),
  stableRoutingDigest: digest(6),
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    status: "running",
    contentRepresentation: "protected",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.job,
    graphThreadId: `subagent:${ids.task}:${ids.run}`,
    status: "running",
    modelId: null,
    fundingBinding: null,
    fundingPredecessorRunId: null,
    resultText: null,
    startedAt: sealedAt,
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
    input: {
      kind: "protected_task_run_v1",
      taskId: ids.task,
      taskRunId: ids.run,
      executionSegment: 1,
    },
    result: null,
    message: null,
    createdAt: sealedAt,
    startedAt: sealedAt,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

function segmentInput(
  overrides: Partial<SealProtectedTaskExecutionSegmentReceiptInput> = {},
): SealProtectedTaskExecutionSegmentReceiptInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    executionSegment: 1,
    route: "native_langgraph_v1",
    transcript: {
      contract: "protected_message_associations_v1",
      expectedAssociationCount: 2,
      orderedDigest: digest(1),
    },
    checkpoint: {
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 3,
      checkpointOrderedDigest: digest(2),
      expectedBlobCount: 4,
      blobOrderedDigest: digest(3),
      expectedPendingWriteCount: 5,
      pendingWriteOrderedDigest: digest(4),
    },
    sealedAt,
    ...overrides,
  };
}

type CheckpointContinuationInput = Extract<
  SealProtectedTaskContinuationReceiptInput,
  { kind: "checkpoint_safe_v1" }
>;
type PreEffectContinuationInput = Extract<
  SealProtectedTaskContinuationReceiptInput,
  { reason: "additional_authority" }
>;

function checkpointContinuation(
  overrides: Partial<CheckpointContinuationInput> = {},
): CheckpointContinuationInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    executionSegment: 1,
    kind: "checkpoint_safe_v1",
    reason: "manual_pause",
    effectDisposition: "none_v1",
    sealedAt,
    ...overrides,
  };
}

function preEffectContinuation(
  overrides: Partial<PreEffectContinuationInput> = {},
): PreEffectContinuationInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    executionSegment: 1,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    interruptId: "interrupt:task-effect:1",
    operationId: "task-effect:1",
    requestDigest: digest(5),
    requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
      semanticAuthorityRequirements,
    ),
    stableRoutingDigest: digest(6),
    semanticAuthorityRequirements,
    sealedAt,
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  job?: Job | undefined;
  segments?: readonly ProtectedTaskExecutionSegmentReceipt[];
  continuations?: readonly ProtectedTaskContinuationReceipt[];
  loseSegmentInsert?: boolean;
  loseContinuationInsert?: boolean;
  readGate?: Promise<void>;
}>;

function harness(options: HarnessOptions = {}) {
  const taskRow = Object.prototype.hasOwnProperty.call(options, "task")
    ? options.task : task();
  const runRow = Object.prototype.hasOwnProperty.call(options, "run")
    ? options.run : run();
  const jobRow = Object.prototype.hasOwnProperty.call(options, "job")
    ? options.job : job();
  const segments = [...(options.segments ?? [])];
  const continuations = [...(options.continuations ?? [])];
  const locks: Array<{ table: unknown; kind: string }> = [];

  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) return jobRow ? [jobRow] : [];
    if (table === protectedTaskExecutionSegmentReceipts) return segments;
    if (table === protectedTaskContinuationReceipts) return continuations;
    throw new Error("unexpected table");
  };
  const queryFor = (table: unknown) => {
    const query = {
      where: (_condition: unknown) => query,
      orderBy: (_order: unknown) => query,
      limit: (_limit: number) => query,
      for: async (kind: string) => {
        locks.push({ table, kind });
        return rows(table);
      },
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve().then(async () => {
        if (table === taskRuns) await options.readGate;
        return rows(table);
      }).then(resolve, reject),
    };
    return query;
  };
  const tx = {
    select: () => ({ from: (table: unknown) => queryFor(table) }),
    insert: (table: unknown) => ({
      values: (value: ProtectedTaskExecutionSegmentReceipt
        | ProtectedTaskContinuationReceipt) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table === protectedTaskExecutionSegmentReceipts) {
              if (options.loseSegmentInsert
                || segments.some(row => row.jobId === value.jobId
                  || row.taskRunId === value.taskRunId
                    && row.executionSegment === value.executionSegment)) return [];
              segments.push(value as ProtectedTaskExecutionSegmentReceipt);
              return [value];
            }
            if (table === protectedTaskContinuationReceipts) {
              if (options.loseContinuationInsert
                || continuations.some(row => row.jobId === value.jobId
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
  } as unknown as Pick<DirectDatabase, "insert" | "select">;
  return { tx, segments, continuations, locks };
}

async function sealSegment(target = harness()) {
  const result = await sealProtectedTaskExecutionSegmentReceiptInTx(
    target.tx,
    segmentInput(),
  );
  expect(result.status).toBe("sealed");
  return target;
}

describe("protected Task execution receipts", () => {
  test("canonicalizes strict dense semantic authority manifests", () => {
    const sparseOperations = new Array<"decrypt" | "encrypt">(3);
    sparseOperations[0] = "decrypt";
    sparseOperations[2] = "encrypt";
    expect(canonicalProtectedTaskSemanticAuthorityRequirements(
      semanticAuthorityRequirements,
    )).toEqual(semanticAuthorityRequirements);
    for (const malformed of [
      Array(1),
      [{
        namespaceId: semanticAuthorityRequirements[0]!.namespaceId,
        operations: Array(1),
      }],
      [{
        namespaceId: semanticAuthorityRequirements[0]!.namespaceId,
        operations: sparseOperations,
      }],
    ]) {
      expect(() => canonicalProtectedTaskSemanticAuthorityRequirements(
        malformed,
      )).toThrow("semantic authority requirements are malformed");
    }
  });
  test("derives one canonical additional-authority continuation identity", () => {
    const value = authorityFingerprintInput();
    expect(protectedTaskAdditionalAuthorityContinuationFingerprint(value))
      .toBe("bAcsSfnB7o0Tzke1EVFdQhgG4fg5ClZVcpke0qEPDZc");
    expect(protectedTaskAdditionalAuthorityContinuationFingerprint({
      ...value,
      requestDigest: value.requestDigest.slice(),
      requiredAuthorityDigest: value.requiredAuthorityDigest.slice(),
      stableRoutingDigest: value.stableRoutingDigest.slice(),
    })).toBe("bAcsSfnB7o0Tzke1EVFdQhgG4fg5ClZVcpke0qEPDZc");
    expect(protectedTaskAdditionalAuthorityContinuationFingerprint({
      ...value,
      requiredAuthorityDigest: digest(7),
    })).not.toBe("bAcsSfnB7o0Tzke1EVFdQhgG4fg5ClZVcpke0qEPDZc");
    expect(protectedTaskAdditionalAuthorityContinuationFingerprint({
      ...value,
      stableRoutingDigest: digest(8),
    })).not.toBe("bAcsSfnB7o0Tzke1EVFdQhgG4fg5ClZVcpke0qEPDZc");
  });

  test("rejects malformed authority continuation identity fields", () => {
    const value = authorityFingerprintInput();
    for (const malformed of [
      { ...value, taskRunId: "not-a-run" },
      { ...value, executionSegment: 0 },
      { ...value, reason: "grant_refresh" },
      { ...value, effectDisposition: "uncertain_v1" },
      { ...value, interruptId: "contains space" },
      { ...value, requestDigest: new Uint8Array(31) },
      { ...value, stableRoutingDigest: new Uint8Array(31) },
    ]) {
      expect(() => protectedTaskAdditionalAuthorityContinuationFingerprint(
        malformed as typeof value,
      )).toThrow("continuation is malformed");
    }
  });

  test("seals one exact writer manifest and replays it immutably", async () => {
    const target = harness();
    const first = await sealProtectedTaskExecutionSegmentReceiptInTx(
      target.tx,
      segmentInput(),
    );
    expect(first).toMatchObject({ status: "sealed" });
    const replay = await sealProtectedTaskExecutionSegmentReceiptInTx(
      target.tx,
      segmentInput({ sealedAt: new Date(sealedAt) }),
    );
    expect(replay).toMatchObject({ status: "exact_replay" });
    expect(target.segments).toHaveLength(1);
    expect(target.segments[0]!.sealedAt).toEqual(sealedAt);
    expect(target.locks.slice(0, 3)).toEqual([
      { table: tasks, kind: "share" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "share" },
    ]);
    expect(target.locks.some(lock =>
      lock.table === protectedTaskExecutionSegmentReceipts
        || lock.table === protectedTaskContinuationReceipts
    )).toBe(false);
  });

  test("rejects conflicting replay and a missing prior segment", async () => {
    const target = await sealSegment();
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      target.tx,
      segmentInput({
        checkpoint: {
          ...segmentInput().checkpoint,
          checkpointOrderedDigest: digest(17),
        },
      }),
    )).toEqual({ status: "rejected", reason: "conflict" });

    const gap = harness({
      job: job({ input: { ...job().input, executionSegment: 2 } }),
    });
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      gap.tx,
      segmentInput({ executionSegment: 2 }),
    )).toEqual({ status: "rejected", reason: "segment_gap" });
  });

  test("rejects a segment replay sealed at a different park time", async () => {
    const target = await sealSegment();
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      target.tx,
      segmentInput({ sealedAt: new Date("2026-10-06T11:00:00.000Z") }),
    )).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("rejects stale, substituted and ordinary execution identities", async () => {
    const stale = harness({ run: run({ jobId: ids.otherJob }) });
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      stale.tx,
      segmentInput(),
    )).toEqual({ status: "rejected", reason: "stale_job" });

    const substituted = harness({
      job: job({
        input: { ...job().input, taskRunId: crypto.randomUUID() },
      }),
    });
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      substituted.tx,
      segmentInput(),
    )).toEqual({ status: "rejected", reason: "stale_job" });

    const ordinary = harness({
      task: task({ contentRepresentation: "ordinary" }),
    });
    expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
      ordinary.tx,
      segmentInput(),
    )).toEqual({ status: "rejected", reason: "not_protected" });
  });

  test("refuses route-manifest mismatch before persistence", async () => {
    const target = harness();
    expect(sealProtectedTaskExecutionSegmentReceiptInTx(
      target.tx,
      segmentInput({ route: "hermes_acp_v1" }),
    )).rejects.toThrow("segment receipt is malformed");
    expect(target.segments).toHaveLength(0);
  });

  test("accepts every canonical native and external protected route", async () => {
    expect(PROTECTED_TASK_EXECUTION_ROUTES).toEqual([
      "native_langgraph_v1",
      "hermes_acp_v1",
      "opencode_acp_v1",
      "codex_acp_v1",
      "claude_code_acp_v1",
    ]);
    for (const route of PROTECTED_TASK_EXECUTION_ROUTES) {
      const target = harness();
      const request = route === "native_langgraph_v1"
        ? segmentInput()
        : segmentInput({
            route,
            transcript: {
              contract: "none_v1",
              expectedAssociationCount: 0,
              orderedDigest: null,
            },
            checkpoint: {
              contract: "none_v1",
              expectedCheckpointCount: 0,
              checkpointOrderedDigest: null,
              expectedBlobCount: 0,
              blobOrderedDigest: null,
              expectedPendingWriteCount: 0,
              pendingWriteOrderedDigest: null,
            },
          });
      expect(await sealProtectedTaskExecutionSegmentReceiptInTx(
        target.tx,
        request,
      )).toMatchObject({ status: "sealed", receipt: { route } });
    }
  });

  test("seals and reads a checkpoint-safe continuation", async () => {
    const target = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation(),
    )).toMatchObject({
      status: "sealed",
      receipt: {
        kind: "checkpoint_safe_v1",
        effectDisposition: "none_v1",
        interruptId: null,
      },
    });
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation({ sealedAt: new Date(sealedAt) }),
    )).toMatchObject({ status: "exact_replay" });
    const proof = await readProtectedTaskExecutionContinuationProof(
      target.tx,
      {
        taskId: ids.task,
        taskRunId: ids.run,
        jobId: ids.job,
        executionSegment: 1,
      },
    );
    expect(proof).toMatchObject({
      segment: { jobId: ids.job },
      continuation: { kind: "checkpoint_safe_v1" },
    });
  });

  test("proof reads pin coordinates before the first await", async () => {
    const sealed = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      sealed.tx,
      checkpointContinuation(),
    )).toMatchObject({ status: "sealed" });
    let release!: () => void;
    const readGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const target = harness({
      segments: sealed.segments,
      continuations: sealed.continuations,
      readGate,
    });
    const coordinates = {
      taskId: ids.task,
      taskRunId: ids.run,
      jobId: ids.job,
      executionSegment: 1,
    };
    const pending = readProtectedTaskExecutionContinuationProof(
      target.tx,
      coordinates,
    );
    coordinates.taskRunId = "20000000-0000-4000-8000-000000000009";
    coordinates.jobId = ids.otherJob;
    coordinates.executionSegment = 2;
    release();
    expect(await pending).toMatchObject({
      segment: { taskRunId: ids.run, jobId: ids.job, executionSegment: 1 },
    });
  });

  test("seals an exact pre-effect interrupt without effect authority", async () => {
    const target = await sealSegment();
    const result = await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation(),
    );
    expect(result).toMatchObject({
      status: "sealed",
      receipt: {
        kind: "pre_effect_interrupt_v1",
        effectDisposition: "not_started_v1",
        interruptId: "interrupt:task-effect:1",
        operationId: "task-effect:1",
      },
    });
    expect(result.status === "sealed"
      && result.receipt.requestDigest === preEffectContinuation().requestDigest)
      .toBe(false);
  });

  test("rejects a semantic manifest digest mismatch before locking", async () => {
    const target = await sealSegment();
    target.locks.length = 0;
    expect(sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation({ requiredAuthorityDigest: digest(17) }),
    )).rejects.toThrow("continuation receipt is malformed");
    expect(target.locks).toEqual([]);
    expect(target.continuations).toEqual([]);
  });

  test("snapshots the semantic manifest before the first await", async () => {
    const target = await sealSegment();
    const mutable = [{
      namespaceId: "60000000-0000-4000-8000-000000000008",
      operations: ["decrypt"],
    }];
    const request = preEffectContinuation({
      semanticAuthorityRequirements: mutable as
        PreEffectContinuationInput["semanticAuthorityRequirements"],
      requiredAuthorityDigest:
        protectedTaskSemanticAuthorityRequirementsDigest(mutable),
    });
    const stableRoutingDigest = request.stableRoutingDigest;
    const expectedStableRoutingDigest = stableRoutingDigest.slice();
    const pending = sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      request,
    );
    mutable[0]!.namespaceId = semanticAuthorityRequirements[0]!.namespaceId;
    mutable[0]!.operations[0] = "encrypt";
    stableRoutingDigest.fill(255);
    expect(await pending).toMatchObject({ status: "sealed" });
    expect(target.continuations[0]?.semanticAuthorityRequirements).toEqual([{
      namespaceId: "60000000-0000-4000-8000-000000000008",
      operations: ["decrypt"],
    }]);
    expect(target.continuations[0]?.stableRoutingDigest)
      .toEqual(expectedStableRoutingDigest);
  });

  test("public sealing snapshots the manifest before transaction acquisition", async () => {
    const target = await sealSegment();
    const mutable = [{
      namespaceId: "60000000-0000-4000-8000-000000000008",
      operations: ["decrypt"],
    }];
    const request = preEffectContinuation({
      semanticAuthorityRequirements: mutable as
        PreEffectContinuationInput["semanticAuthorityRequirements"],
      requiredAuthorityDigest:
        protectedTaskSemanticAuthorityRequirementsDigest(mutable),
    });
    const stableRoutingDigest = request.stableRoutingDigest;
    const expectedStableRoutingDigest = stableRoutingDigest.slice();
    let enter!: () => void;
    const gate = new Promise<void>(resolve => {
      enter = resolve;
    });
    const db = {
      transaction: async <T>(operation: (tx: never) => Promise<T>) => {
        await gate;
        return operation(target.tx as never);
      },
    } as unknown as DirectDatabase;
    const pending = sealProtectedTaskContinuationReceipt(db, request);
    mutable[0]!.operations[0] = "encrypt";
    stableRoutingDigest.fill(255);
    enter();
    expect(await pending).toMatchObject({ status: "sealed" });
    expect(target.continuations[0]?.semanticAuthorityRequirements).toEqual([{
      namespaceId: "60000000-0000-4000-8000-000000000008",
      operations: ["decrypt"],
    }]);
    expect(target.continuations[0]?.stableRoutingDigest)
      .toEqual(expectedStableRoutingDigest);
  });

  test("requires the exact native segment proof and rejects conflicting replay", async () => {
    const missing = harness();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      missing.tx,
      checkpointContinuation(),
    )).toEqual({ status: "rejected", reason: "missing_segment" });

    const target = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation(),
    )).toMatchObject({ status: "sealed" });
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation({ reason: "time_limit" }),
    )).toEqual({ status: "rejected", reason: "conflict" });
    expect(target.continuations).toHaveLength(1);
  });

  test("rejects a continuation replay sealed at a different park time", async () => {
    const target = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation(),
    )).toMatchObject({ status: "sealed" });
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      checkpointContinuation({
        sealedAt: new Date("2026-10-06T12:00:00.000Z"),
      }),
    )).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("treats an altered semantic manifest as conflicting replay", async () => {
    const target = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation(),
    )).toMatchObject({ status: "sealed" });
    const changed = Object.freeze([Object.freeze({
      namespaceId: semanticAuthorityRequirements[0]!.namespaceId,
      operations: Object.freeze(["decrypt"] as const),
    })]);
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation({
        semanticAuthorityRequirements: changed,
        requiredAuthorityDigest:
          protectedTaskSemanticAuthorityRequirementsDigest(changed),
      }),
    )).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("requires and replay-binds the stable routing digest", async () => {
    const malformed = await sealSegment();
    const missing = { ...preEffectContinuation() } as Record<string, unknown>;
    delete missing["stableRoutingDigest"];
    expect(sealProtectedTaskContinuationReceiptInTx(
      malformed.tx,
      missing as unknown as SealProtectedTaskContinuationReceiptInput,
    )).rejects.toThrow("continuation receipt is malformed");
    expect(sealProtectedTaskContinuationReceiptInTx(
      malformed.tx,
      {
        ...preEffectContinuation(),
        stableRoutingDigest: new Uint8Array(31),
      },
    )).rejects.toThrow("continuation receipt is malformed");
    expect(malformed.continuations).toEqual([]);

    const target = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation(),
    )).toMatchObject({ status: "sealed" });
    expect(await sealProtectedTaskContinuationReceiptInTx(
      target.tx,
      preEffectContinuation({ stableRoutingDigest: digest(7) }),
    )).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("reads a legacy additional-authority proof without routing authority", async () => {
    const sealed = await sealSegment();
    expect(await sealProtectedTaskContinuationReceiptInTx(
      sealed.tx,
      preEffectContinuation(),
    )).toMatchObject({ status: "sealed" });
    const legacy = {
      ...sealed.continuations[0]!,
      stableRoutingDigest: null,
    };
    const target = harness({
      segments: sealed.segments,
      continuations: [legacy],
    });
    expect(await readProtectedTaskExecutionContinuationProof(target.tx, {
      taskId: ids.task,
      taskRunId: ids.run,
      jobId: ids.job,
      executionSegment: 1,
    })).toMatchObject({
      continuation: {
        reason: "additional_authority",
        stableRoutingDigest: null,
      },
    });
  });

  test("has no resumable representation for an uncertain effect", async () => {
    const target = await sealSegment();
    const uncertain = {
      ...preEffectContinuation(),
      effectDisposition: "uncertain_v1",
    } as unknown as SealProtectedTaskContinuationReceiptInput;
    expect(sealProtectedTaskContinuationReceiptInTx(target.tx, uncertain))
      .rejects.toThrow("continuation receipt is malformed");
    expect(target.continuations).toHaveLength(0);
  });
});
