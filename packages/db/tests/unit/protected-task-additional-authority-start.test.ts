import { assertApprovalSelectionsAreContentFree, projectApprovalRow, compileApprovalSelection } from "../fixtures/protected-approval-projection";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  protectedTaskAdditionalAuthorityContinuationFingerprint,
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "../../src/queries/protected-task-execution-receipts";
import {
  startParkedProtectedTaskRunAdditionalAuthoritySegment,
  startParkedProtectedTaskCheckpointSegment,
  parseParkedProtectedTaskCheckpointContinuation,
  copyParkedProtectedTaskCheckpointContinuation,
  sameParkedProtectedTaskCheckpointContinuation,
  discoverParkedProtectedTaskCheckpointContinuation,
  readParkedProtectedTaskCheckpointContinuation,
  lockParkedProtectedTaskCheckpointContinuation,
  type StartParkedProtectedTaskCheckpointSegmentInput,
  type ParkedProtectedTaskCheckpointContinuation,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "../../src/queries/tasks";
import type { ProtectedTaskExecutionContinuationProof } from "../../src/queries/protected-task-execution-receipts";
import { encryptionTransitionPolicy } from "../../src/schema/encryption-transition";
import { protectedTaskRunOutputBindings } from "../../src/schema/protected-task-run-output-bindings";
import { jobs, type Job } from "../../src/schema/jobs";
import { protectedTaskContinuationReceipts } from
  "../../src/schema/protected-task-continuation-receipts";
import { protectedTaskExecutionSegmentReceipts } from
  "../../src/schema/protected-task-execution-segment-receipts";
import { taskRunMessageAssociations } from
  "../../src/schema/task-run-message-associations";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  priorJob: "30000000-0000-4000-8000-000000000003",
  job: "30000000-0000-4000-8000-000000000004",
  owner: "40000000-0000-4000-8000-000000000005",
  agent: "50000000-0000-4000-8000-000000000006",
  namespace: "60000000-0000-4000-8000-000000000007",
};
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const definitionObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId =
  "task-run-result:v1:c3d2c1c68222360a4404fe37119db6e3e7fcf973c1f1ccf2c4a894683c83705e";
const parkedAt = new Date("2026-10-07T12:34:56.000Z");
const parkReceiptKey = "nautilo.protectedTaskRunPark.v1";
const digest = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 32 }, (_, index) => seed + index));
const definitionFingerprint = digest(1);
const semanticAuthorityRequirements = Object.freeze([Object.freeze({
  namespaceId: ids.namespace,
  operations: Object.freeze(["decrypt", "encrypt"] as const),
})]);
const checkpointManifest = Object.freeze({
  contract: "encrypted_langgraph_v1" as const,
  expectedCheckpointCount: 2,
  checkpointOrderedDigest: digest(2),
  expectedBlobCount: 3,
  blobOrderedDigest: digest(3),
  expectedPendingWriteCount: 0,
  pendingWriteOrderedDigest: digest(4),
});
const continuation = Object.freeze({
  interruptId: "interrupt:additional-authority:1",
  operationId: "tool-call:1",
  requestDigest: digest(5),
  requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(
    semanticAuthorityRequirements,
  ),
  stableRoutingDigest: digest(6),
  semanticAuthorityRequirements,
});
const transcriptDigest = new Uint8Array(createHash("sha256").update(
  JSON.stringify([
    "protected-task-transcript-manifest:v1",
    ids.task,
    ids.run,
    graphThreadId,
    0,
  ]) + "\n",
  "utf8",
).digest());

function priorReference(
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

function continuationFingerprint(): string {
  return protectedTaskAdditionalAuthorityContinuationFingerprint({
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    ...continuation,
  });
}

function nextReference(
  overrides: Partial<ProtectedTaskDurableJobReference> = {},
): ProtectedTaskDurableJobReference {
  return {
    ...priorReference(),
    authorizationRequestId: `task-run-authorization:${ids.run}:segment:2`,
    policyRevision: 10,
    executionSegment: 2,
    resumeContinuationFingerprint: continuationFingerprint(),
    ...overrides,
  };
}

function interrupts() {
  return [{
    id: continuation.interruptId,
    kind: "additional_authority" as const,
    requestId: nextReference().authorizationRequestId,
  }];
}

function parkReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.priorJob,
    graphThreadId,
    generation: 3,
    executionSegment: 1,
    interrupts: interrupts(),
    parkedAt: parkedAt.toISOString(),
    ...overrides,
  };
}

function input(
  overrides: Partial<
    StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput
  > = {},
): StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    graphThreadId,
    priorJobId: ids.priorJob,
    jobId: ids.job,
    generation: 3,
    interrupts: interrupts(),
    parkedAt,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: definitionFingerprint.slice(),
    priorJobReference: priorReference(),
    jobReference: nextReference(),
    checkpointManifest: {
      ...checkpointManifest,
      checkpointOrderedDigest: checkpointManifest.checkpointOrderedDigest.slice(),
      blobOrderedDigest: checkpointManifest.blobOrderedDigest.slice(),
      pendingWriteOrderedDigest: checkpointManifest.pendingWriteOrderedDigest.slice(),
    },
    continuation: {
      ...continuation,
      requestDigest: continuation.requestDigest.slice(),
      requiredAuthorityDigest: continuation.requiredAuthorityDigest.slice(),
      stableRoutingDigest: continuation.stableRoutingDigest.slice(),
      semanticAuthorityRequirements,
    },
    ...overrides,
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
    status: "awaiting",
    targetUserIds: [],
    lastError: null,
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 4,
    cryptoObjectId: definitionObjectId,
    cryptoAccessRevision: 6,
    cryptoRequiredNamespaceFingerprint: definitionFingerprint,
    cryptoMappingState: "verified",
    metadata: {},
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: ids.priorJob,
    graphThreadId,
    status: "awaiting",
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

function priorJob(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.priorJob,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "completed",
    input: priorReference(),
    result: null,
    message: null,
    createdAt: new Date("2026-10-07T12:00:01.000Z"),
    startedAt: new Date("2026-10-07T12:00:02.000Z"),
    completedAt: parkedAt,
    metadata: { [parkReceiptKey]: parkReceipt() },
    ...overrides,
  };
}

function nextJob(overrides: Partial<Job> = {}): Job {
  return {
    id: ids.job,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `task:${ids.task}`,
    roomId: null,
    type: "foreground",
    status: "queued",
    input: nextReference(),
    result: null,
    message: null,
    createdAt: new Date("2026-10-07T12:35:00.000Z"),
    startedAt: null,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

function segmentReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    route: "native_langgraph_v1",
    transcriptContract: "protected_message_associations_v1",
    expectedTranscriptAssociationCount: 0,
    transcriptAssociationDigest: transcriptDigest,
    checkpointContract: checkpointManifest.contract,
    expectedCheckpointCount: checkpointManifest.expectedCheckpointCount,
    checkpointDigest: checkpointManifest.checkpointOrderedDigest,
    expectedCheckpointBlobCount: checkpointManifest.expectedBlobCount,
    checkpointBlobDigest: checkpointManifest.blobOrderedDigest,
    expectedPendingWriteCount: checkpointManifest.expectedPendingWriteCount,
    pendingWriteDigest: checkpointManifest.pendingWriteOrderedDigest,
    sealedAt: parkedAt,
    ...overrides,
  };
}

function continuationReceipt(overrides: Record<string, unknown> = {}) {
  return {
    taskRunId: ids.run,
    executionSegment: 1,
    jobId: ids.priorJob,
    kind: "pre_effect_interrupt_v1",
    reason: "additional_authority",
    effectDisposition: "not_started_v1",
    ...continuation,
    sealedAt: parkedAt,
    ...overrides,
  };
}

type HarnessOptions = Readonly<{
  task?: Task | undefined;
  run?: TaskRun | undefined;
  priorJob?: Job | undefined;
  nextJob?: Job | undefined;
  segment?: ReturnType<typeof segmentReceipt> | undefined;
  continuation?: ReturnType<typeof continuationReceipt> | undefined;
  transcriptRows?: readonly Record<string, unknown>[];
  policy?: { mode: string; revision: number };
  binding?: Record<string, unknown>;
  loseRunUpdate?: boolean;
  loseTaskUpdate?: boolean;
}>;

function harness(options: HarnessOptions = {}) {
  let taskRow = Object.prototype.hasOwnProperty.call(options, "task")
    ? options.task
    : task();
  let runRow = Object.prototype.hasOwnProperty.call(options, "run")
    ? options.run
    : run();
  const priorJobRow = Object.prototype.hasOwnProperty.call(options, "priorJob")
    ? options.priorJob
    : priorJob();
  const nextJobRow = Object.prototype.hasOwnProperty.call(options, "nextJob")
    ? options.nextJob
    : nextJob();
  const segmentRow = Object.prototype.hasOwnProperty.call(options, "segment")
    ? options.segment
    : segmentReceipt();
  const continuationRow = Object.prototype.hasOwnProperty.call(
    options,
    "continuation",
  ) ? options.continuation : continuationReceipt();
  let lockedJobRead = 0;
  const selections: string[] = [];
  const locks: Array<{ table: unknown; kind: string }> = [];
  const writes: Array<{ table: unknown; patch: Record<string, unknown> }> = [];

  const rows = (table: unknown, locked: boolean): unknown[] => {
    if (table === encryptionTransitionPolicy) return [options.policy ?? { mode: "encrypted_only", revision: 10 }];
    if (table === protectedTaskRunOutputBindings) return [options.binding ?? {
      taskRunId: ids.run, bindingId: `task-run-output:${ids.run}`, resultRevision: 1,
      resultObjectId, resultOperationId: `task-run-result:${ids.run}`, acceptedPolicyRevision: 9,
      resultTerminalAt: null, resultAttachedAt: null, messageId: null, messagePublishedAt: null,
      wakeJobId: null, wakeScheduledAt: null, completedAt: null,
    }];
    if (table === tasks) return taskRow ? [taskRow] : [];
    if (table === taskRuns) return runRow ? [runRow] : [];
    if (table === jobs) {
      if (!locked) throw new Error("unexpected unlocked Job read");
      const row = lockedJobRead === 0 ? priorJobRow : nextJobRow;
      lockedJobRead += 1;
      return row ? [row] : [];
    }
    if (table === protectedTaskExecutionSegmentReceipts) {
      return segmentRow ? [segmentRow] : [];
    }
    if (table === protectedTaskContinuationReceipts) {
      return continuationRow ? [continuationRow] : [];
    }
    if (table === taskRunMessageAssociations) {
      return [...(options.transcriptRows ?? [])];
    }
    throw new Error("unexpected table");
  };
  const tx = {
    select: (selection?: unknown) => ({
      from: (table: unknown) => {
        if (selection !== undefined && [tasks, taskRuns, jobs].includes(table as typeof tasks)) selections.push(compileApprovalSelection(table, selection));
        let limitValue: number | undefined;
        const query = {
          where: (_condition: unknown) => query,
          limit: (limit: number) => {
            limitValue = limit;
            return query;
          },
          orderBy: (_order: unknown) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table, true).map(row => projectApprovalRow(table, row, selection));
          },
          then: <TResult1 = unknown[]>(
            resolve: (value: unknown[]) => TResult1 | PromiseLike<TResult1>,
          ) => {
            const selectedRows = rows(table, false);
            return Promise.resolve(limitValue === undefined
              ? selectedRows
              : selectedRows.slice(0, limitValue)).then(resolve);
          },
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            writes.push({ table, patch });
            if (table === taskRuns) {
              if (options.loseRunUpdate || !runRow) return [];
              runRow = { ...runRow, ...patch } as TaskRun;
              return [runRow];
            }
            if (table === tasks) {
              if (options.loseTaskUpdate || !taskRow) return [];
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
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, locks, tx, writes, selections };
}

async function expectMalformed(promise: Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("segment binding is malformed");
}

describe("protected Task additional-authority segment start CAS", () => {
  test("fresh Full policy admits a retained dual pre-effect park, while Plain and revision races wait", async () => {
    const fixture = harness({ task: task({ contentRepresentation: "dual", prompt: "retained sibling" }) });
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(fixture.db,
      input({ contentRepresentation: "dual" }))).toEqual({ status: "started" });
    for (const policy of [{ mode: "plaintext_only", revision: 10 },
      { mode: "shadow_encryption", revision: 10 }, { mode: "encrypted_only", revision: 11 }]) {
      const denied = harness({ policy });
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(denied.db, input()))
        .toEqual({ status: "rejected", reason: "stale" });
      expect(denied.writes).toEqual([]);
    }
  });

  test("locks the aggregate in order and starts the exact proven segment", async () => {
    const fixture = harness();

    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      fixture.db,
      input(),
    )).toEqual({ status: "started" });
    assertApprovalSelectionsAreContentFree(fixture.selections);
    expect(fixture.locks).toEqual([
      { table: encryptionTransitionPolicy, kind: "share" },
      { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" },
      { table: jobs, kind: "update" },
      { table: jobs, kind: "update" },
      { table: protectedTaskRunOutputBindings, kind: "share" },
    ]);
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]).toEqual({
      table: taskRuns,
      patch: { status: "running", jobId: ids.job },
    });
    expect(fixture.writes[1]?.table).toBe(tasks);
    expect(fixture.writes[1]?.patch["status"]).toBe("running");
  });

  test("accepts the exact started segment as replay without a consumed marker", async () => {
    const fixture = harness({
      task: task({ status: "running" }),
      run: run({ status: "running", jobId: ids.job }),
      nextJob: nextJob({
        status: "running",
        startedAt: new Date("2026-10-07T12:35:01.000Z"),
      }),
      transcriptRows: [{
        taskRunId: ids.run,
        sessionId: "70000000-0000-4000-8000-000000000008",
        messageId: 1,
        publishedRevision: 0,
        kind: "transcript",
        publicationKey: "segment-2-publication",
      }],
    });
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      fixture.db,
      input({ checkpointManifest: {
        ...checkpointManifest,
        checkpointOrderedDigest: digest(9),
      } }),
    )).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);
  });

  test("requires both exact receipts and current physical manifests", async () => {
    const cases: Array<{
      options?: HarnessOptions;
      value?: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
    }> = [
      { options: { segment: undefined } },
      { options: { continuation: undefined } },
      { options: { segment: segmentReceipt({ expectedCheckpointCount: 0 }) } },
      { options: { segment: segmentReceipt({ transcriptAssociationDigest: digest(8) }) } },
      { options: { continuation: continuationReceipt({ operationId: "tool-call:other" }) } },
      { options: { continuation: continuationReceipt({ stableRoutingDigest: null }) } },
      { options: { continuation: continuationReceipt({ stableRoutingDigest: digest(8) }) } },
      { value: input({ checkpointManifest: {
        ...checkpointManifest,
        checkpointOrderedDigest: digest(9),
      } }) },
    ];
    for (const candidate of cases) {
      const fixture = harness(candidate.options);
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
        fixture.db,
        candidate.value ?? input(),
      )).toEqual({ status: "rejected", reason: "conflict" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects Plain, cancelled, terminal, and changed Job state", async () => {
    for (const options of [
      { task: task({ contentRepresentation: "ordinary" }) },
      { task: task({ pauseRequestId: ids.task }) },
      { task: task({ status: "cancelled" }) },
      { run: run({ status: "cancelled", completedAt: parkedAt }) },
      { priorJob: priorJob({ status: "cancelled" }) },
      { nextJob: nextJob({ metadata: { hidden: true } }) },
      { nextJob: nextJob({ input: { ...nextReference(), hidden: true } }) },
    ] satisfies HarnessOptions[]) {
      const fixture = harness(options);
      expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
        fixture.db,
        input(),
      )).toEqual({ status: "rejected", reason: "stale" });
      expect(fixture.writes).toEqual([]);
    }
  });

  test("rejects altered authority succession before opening a transaction", async () => {
    let transactions = 0;
    const db = {
      transaction: () => {
        transactions += 1;
        throw new Error("transaction must stay closed");
      },
    } as unknown as DirectDatabase;
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ jobReference: nextReference({
        resumeContinuationFingerprint: "a".repeat(43),
      }) }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ interrupts: [{
        id: continuation.interruptId,
        kind: "additional_authority",
        requestId: "another-request",
      }] }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ jobReference: {
        ...nextReference(),
        resumeAcceptanceId: "human-acceptance",
      } }),
    ));
    await expectMalformed(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      input({ checkpointManifest: {
        ...checkpointManifest,
        expectedCheckpointCount: 0,
      } }),
    ));
    expect(transactions).toBe(0);
  });

  test("copies caller-owned byte inputs before the transaction begins", async () => {
    const value = input();
    const base = harness();
    const db = {
      transaction: async <T>(operation: (tx: never) => Promise<T>) => {
        value.cryptoRequiredNamespaceFingerprint.fill(0xff);
        value.continuation.requestDigest.fill(0xff);
        value.continuation.stableRoutingDigest.fill(0xff);
        value.checkpointManifest.checkpointOrderedDigest?.fill(0xff);
        return operation(base.tx as never);
      },
    } as unknown as DirectDatabase;
    expect(await startParkedProtectedTaskRunAdditionalAuthoritySegment(
      db,
      value,
    )).toEqual({ status: "started" });
  });

  test("throws to roll back if either lifecycle update loses its row", () => {
    expect(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      harness({ loseRunUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its TaskRun");
    expect(startParkedProtectedTaskRunAdditionalAuthoritySegment(
      harness({ loseTaskUpdate: true }).db,
      input(),
    )).rejects.toThrow("lost its Task");
  });
});


function checkpointReceipt() {
  return continuationReceipt({ kind: "checkpoint_safe_v1", reason: "grant_refresh", effectDisposition: "none_v1",
    interruptId: null, operationId: null, requestDigest: null, requiredAuthorityDigest: null,
    stableRoutingDigest: null, semanticAuthorityRequirements: null });
}
function checkpointPark() {
  return parkReceipt({ interrupts: [], stableRoutingDigest: Buffer.from(digest(6)).toString("base64url") });
}
function checkpointProjection() {
  const t = task();
  return {
    task: { ...t, callingRoomId: null, pauseRequestId: null as string | null, contentPristine: true },
    run: { ...run(), pristine: true },
    job: { ...priorJob(), reference: priorReference(), parkReceipt: checkpointPark(), pristine: true },
    proof: { segment: segmentReceipt(), continuation: checkpointReceipt() } as ProtectedTaskExecutionContinuationProof,
  };
}
function checkpointCandidate(): ParkedProtectedTaskCheckpointContinuation {
  const value = parseParkedProtectedTaskCheckpointContinuation(checkpointProjection());
  if (value === null) throw new Error("invalid checkpoint fixture");
  return value;
}
function checkpointInput(): StartParkedProtectedTaskCheckpointSegmentInput {
  const c = checkpointCandidate();
  return { ...input(), interrupts: [], stableRoutingDigest: c.stableRoutingDigest,
    continuationFingerprint: c.continuationFingerprint,
    jobReference: { ...nextReference(), authorizationRequestId: c.authorizationRequestId,
      resumeContinuationFingerprint: c.continuationFingerprint } };
}
function checkpointHarness(options: HarnessOptions = {}) {
  return harness({
    task: task({ callingRoomId: null }),
    priorJob: priorJob({ metadata: { [parkReceiptKey]: checkpointPark() } }),
    nextJob: nextJob({ input: checkpointInput().jobReference }),
    continuation: checkpointReceipt(),
    ...options,
  });
}

describe("checkpoint-safe parked continuation", () => {
  test("retained ciphertext binding is exact copied metadata, not a changed continuation identity", () => {
    const original = checkpointProjection();
    const binding = { version: 1 as const, namespaceId: ids.namespace, domainId: ids.owner,
      namespaceAccessRevision: 2, policyRevision: 9 };
    const withBinding = { ...original, job: { ...original.job,
      parkReceipt: { ...original.job.parkReceipt, checkpointAadBinding: binding } } };
    const c = parseParkedProtectedTaskCheckpointContinuation(withBinding);
    if (c === null) throw new Error("sealed checkpoint metadata rejected");
    expect(c.priorJob.checkpointAadBinding).toEqual(binding);
    expect(Object.isFrozen(c.priorJob.checkpointAadBinding)).toBe(true);
    expect(sameParkedProtectedTaskCheckpointContinuation(c, copyParkedProtectedTaskCheckpointContinuation(c))).toBe(true);
    expect(c.authorizationRequestId).toBe(checkpointCandidate().authorizationRequestId);
    for (const changed of [{ ...binding, namespaceId: ids.owner }, { ...binding, policyRevision: 10 },
      { ...binding, namespaceAccessRevision: -1 }, { ...binding, extra: true }]) {
      expect(parseParkedProtectedTaskCheckpointContinuation({ ...withBinding,
        job: { ...withBinding.job, parkReceipt: { ...withBinding.job.parkReceipt, checkpointAadBinding: changed } } })).toBeNull();
    }
    const mutated = { ...c, priorJob: { ...c.priorJob,
      checkpointAadBinding: { ...binding, namespaceAccessRevision: 3 } } };
    expect(sameParkedProtectedTaskCheckpointContinuation(c, mutated)).toBe(false);
  });

  test("derives a stable closed request from immutable proof and detaches every mutable value", () => {
    const c = checkpointCandidate();
    expect(c.authorizationRequestId).toBe(`task-checkpoint-continuation:${ids.run}:2:${c.continuationFingerprint}`);
    expect(c.authorizationRequestId.length).toBeLessThanOrEqual(128);
    expect(c.priorJob.interrupts).toEqual([]);
    expect(c.proof.continuation.kind).toBe("checkpoint_safe_v1");
    const detached = copyParkedProtectedTaskCheckpointContinuation(c);
    expect(sameParkedProtectedTaskCheckpointContinuation(c, detached)).toBe(true);
    c.proof.segment.checkpointDigest!.fill(99);
    expect(sameParkedProtectedTaskCheckpointContinuation(c, detached)).toBe(false);
    expect(() => copyParkedProtectedTaskCheckpointContinuation(c)).toThrow("invalid");
    const altered = checkpointProjection();
    altered.proof = { ...altered.proof, continuation: { ...altered.proof.continuation, sealedAt: new Date(parkedAt.getTime() + 1) } };
    expect(parseParkedProtectedTaskCheckpointContinuation(altered)).toBeNull();
  });
  test("rejects missing, non-checkpoint, nonempty, paused, switched-Run, and exhausted-segment discovery", () => {
    const mutations: Array<(value: ReturnType<typeof checkpointProjection>) => void> = [
      v => { v.task.pauseRequestId = ids.task; },
      v => { v.task.status = "paused"; },
      v => { v.run.jobId = ids.job; },
      v => { v.job.parkReceipt = parkReceipt(); },
      v => { v.job.reference = { ...v.job.reference, executionSegment: Number.MAX_SAFE_INTEGER }; },
      v => { v.proof = { segment: segmentReceipt(), continuation: continuationReceipt() } as ProtectedTaskExecutionContinuationProof; },
      v => { v.proof.segment.checkpointDigest = new Uint8Array(0); },
      v => { v.job.result = { leaked: true }; v.job.pristine = false; },
    ];
    for (const mutate of mutations) {
      const v = checkpointProjection(); mutate(v);
      expect(parseParkedProtectedTaskCheckpointContinuation(v)).toBeNull();
    }
    expect(parseParkedProtectedTaskCheckpointContinuation({ ...checkpointProjection(), proof: null })).toBeNull();
  });
  test("starts under newer same-mode policy while retaining old acceptance and checkpoint identity", async () => {
    const fixture = checkpointHarness();
    expect(await startParkedProtectedTaskCheckpointSegment(fixture.db, checkpointInput())).toEqual({ status: "started" });
    assertApprovalSelectionsAreContentFree(fixture.selections);
    expect(fixture.locks.slice(0, 5)).toEqual([
      { table: encryptionTransitionPolicy, kind: "share" }, { table: tasks, kind: "update" },
      { table: taskRuns, kind: "update" }, { table: jobs, kind: "update" }, { table: jobs, kind: "update" },
    ]);
    expect(fixture.writes).toEqual([
      { table: taskRuns, patch: { status: "running", jobId: ids.job } },
      { table: tasks, patch: { status: "running", updatedAt: expect.any(Date) } },
    ]);
  });
  test("exact started replay has no second lifecycle mutation", async () => {
    const fixture = checkpointHarness({ task: task({ status: "running", callingRoomId: null }),
      run: run({ status: "running", jobId: ids.job }),
      nextJob: nextJob({ status: "running", startedAt: parkedAt, input: checkpointInput().jobReference }) });
    expect(await startParkedProtectedTaskCheckpointSegment(fixture.db, checkpointInput())).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);
  });
  test("incompatible or changed policy, pause, switched Run, and already-running unlinked Job never start", async () => {
    for (const options of [
      { policy: { mode: "shadow_encryption", revision: 10 } },
      { policy: { mode: "plaintext_only", revision: 10 } },
      { policy: { mode: "encrypted_only", revision: 11 } },
      { task: task({ status: "paused", callingRoomId: null }) },
      { task: task({ pauseRequestId: ids.task, callingRoomId: null }) },
      { run: run({ jobId: ids.owner }) },
      { nextJob: nextJob({ status: "running", startedAt: parkedAt, input: checkpointInput().jobReference }) },
      { segment: undefined }, { continuation: undefined },
    ] satisfies HarnessOptions[]) {
      const f = checkpointHarness(options);
      expect((await startParkedProtectedTaskCheckpointSegment(f.db, checkpointInput())).status).toBe("rejected");
      expect(f.writes).toEqual([]);
    }
  });
  test("current physical checkpoint, routing, transcript, and exact reference are required", async () => {
    for (const change of [
      { stableRoutingDigest: digest(99) },
      { checkpointManifest: { ...checkpointManifest, checkpointOrderedDigest: digest(99) } },
      { graphThreadId: `${graphThreadId}:other` },
    ]) {
      const f = checkpointHarness();
      expect((await startParkedProtectedTaskCheckpointSegment(f.db, { ...checkpointInput(), ...change })).status).toBe("rejected");
      expect(f.writes).toEqual([]);
    }
    const f = checkpointHarness({ transcriptRows: [{ taskRunId: ids.run, sessionId: ids.task, messageId: 1,
      publishedRevision: 1, kind: "transcript", publicationKey: "unexpected" }] });
    expect((await startParkedProtectedTaskCheckpointSegment(f.db, checkpointInput())).status).toBe("rejected");
    expect(f.writes).toEqual([]);
    await expectMalformed(startParkedProtectedTaskCheckpointSegment(checkpointHarness().db, {
      ...checkpointInput(), jobReference: { ...checkpointInput().jobReference, executionSegment: 3 },
    }));
  });
  test("restart discovery reads retained proof and filters exact fresh request without a grant", async () => {
    const v = checkpointProjection();
    const db = { select: () => ({ from: (table: unknown) => {
      let joined = false;
      const q = { innerJoin: (..._: unknown[]) => { joined = true; return q; }, where: (_: unknown) => q, limit: (_: number) => q,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(joined ? [{ task: v.task, run: v.run, job: v.job }]
          : table === taskRuns ? [v.run] : table === protectedTaskExecutionSegmentReceipts ? [v.proof.segment]
          : table === protectedTaskContinuationReceipts ? [v.proof.continuation] : []).then(resolve) };
      return q;
    } }) } as unknown as DirectDatabase;
    expect((await discoverParkedProtectedTaskCheckpointContinuation(db, { taskRunId: ids.run }))?.authorizationRequestId).toBe(checkpointCandidate().authorizationRequestId);
    expect(await readParkedProtectedTaskCheckpointContinuation(db, { taskRunId: ids.run, authorizationRequestId: "wrong" })).toBeNull();
  });
});


test("later checkpoint segment restart derives a new request from exact retained receipt", () => {
  const prior = checkpointCandidate();
  const v = checkpointProjection();
  v.job.reference = { ...v.job.reference, executionSegment: 2,
    authorizationRequestId: prior.authorizationRequestId, resumeContinuationFingerprint: prior.continuationFingerprint };
  v.job.parkReceipt = { ...v.job.parkReceipt, executionSegment: 2, generation: 4 };
  v.proof = { segment: { ...v.proof.segment, executionSegment: 2 }, continuation: { ...v.proof.continuation, executionSegment: 2 } };
  const current = parseParkedProtectedTaskCheckpointContinuation(v);
  expect(current?.nextExecutionSegment).toBe(3);
  expect(current?.authorizationRequestId).toBe(`task-checkpoint-continuation:${ids.run}:3:${current?.continuationFingerprint}`);
  expect(current?.authorizationRequestId).not.toBe(prior.authorizationRequestId);
});

test("locked checkpoint authority rechecks same receipt and pending manual pause", async () => {
  const v = checkpointProjection();
  const locks: unknown[] = [];
  const db = { select: () => ({ from: (table: unknown) => {
    const rows = () => table === tasks ? [v.task] : table === taskRuns ? [v.run] : table === jobs ? [v.job]
      : table === protectedTaskExecutionSegmentReceipts ? [v.proof.segment] : table === protectedTaskContinuationReceipts ? [v.proof.continuation] : [];
    const q = { where: (_: unknown) => q, limit: (_: number) => q,
      for: async () => { locks.push(table); return rows(); },
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
    return q;
  } }) } as unknown as DirectDatabase;
  const expected = checkpointCandidate();
  expect(await lockParkedProtectedTaskCheckpointContinuation(db, expected)).not.toBeNull();
  expect(locks).toEqual([tasks, taskRuns, jobs]);
  v.task.pauseRequestId = ids.task;
  expect(await lockParkedProtectedTaskCheckpointContinuation(db, expected)).toBeNull();
  v.task.pauseRequestId = null;
  v.proof = { ...v.proof, segment: { ...v.proof.segment, checkpointDigest: digest(99) } };
  expect(await lockParkedProtectedTaskCheckpointContinuation(db, expected)).toBeNull();
});


test("checkpoint discovery detaches postgres Buffer metadata before exposing it", () => {
  const v = checkpointProjection();
  const bytes = Buffer.from(digest(8));
  v.task.cryptoRequiredNamespaceFingerprint = bytes;
  v.proof = { ...v.proof, segment: { ...v.proof.segment, checkpointDigest: bytes } };
  const c = parseParkedProtectedTaskCheckpointContinuation(v)!;
  bytes.fill(99);
  expect(c.occurrence.task.cryptoRequiredNamespaceFingerprint).toEqual(digest(8));
  expect(c.proof.segment.checkpointDigest).toEqual(digest(8));
  expect(copyParkedProtectedTaskCheckpointContinuation(c).continuationFingerprint).toBe(c.continuationFingerprint);
});
