import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "../../src/queries/protected-task-output-binding-identities";
import {
  claimProtectedTaskWakeJob,
  insertOrAdoptProtectedTaskWakeJob,
  listProtectedTaskWakeExecutionCandidates,
  readProtectedTaskWakeScheduling,
  settleProtectedTaskWakeJob,
} from "../../src/queries/protected-task-output-wake";
import { encryptionTransitionPolicy } from
  "../../src/schema/encryption-transition";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import { roomMembers, rooms } from "../../src/schema/rooms";
import { sessions } from "../../src/schema/sessions";
import { taskRuns } from "../../src/schema/task-runs";
import { tasks } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  requester: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
  session: "70000000-0000-4000-8000-000000000007",
  destinationOwner: "80000000-0000-4000-8000-000000000008",
};
const terminalAt = new Date("2026-10-12T08:00:00.000Z");
const attachedAt = new Date("2026-10-12T08:00:01.000Z");
const createdAt = new Date("2026-10-12T08:00:02.000Z");
const jobId = protectedTaskRunWakeJobId(ids.run);
const resultObjectId = protectedTaskRunResultObjectId(ids.task, ids.run);
const groupThreadId = `room:${ids.room}:bot:${ids.agent}`;

function exactSession(endedAt: Date | null = null) {
  return {
    id: ids.session,
    ownerId: ids.destinationOwner,
    agentId: ids.agent,
    roomId: ids.room,
    threadId: groupThreadId,
    personaId: "owner",
    endedAt,
  };
}

function binding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    deliveryMode: "wake",
    destinationRoomId: ids.room,
    destinationNamespaceId: ids.namespace,
    resultRevision: 1,
    resultOperationId: protectedTaskRunResultOperationId(ids.run),
    resultObjectId,
    messageOperationId: null,
    wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    acceptedPolicyRevision: 9,
    acceptedAt: new Date(terminalAt.getTime() - 1_000),
    resultTerminalAt: terminalAt,
    resultAttachedAt: attachedAt,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
    ...overrides,
  };
}

function exactJob(
  expectedBinding: ProtectedTaskRunOutputBinding,
  overrides: Partial<Job> = {},
): Job {
  return {
    id: jobId,
    ownerId: ids.requester,
    requestorId: ids.requester,
    laneKey: `room:${ids.room}`,
    roomId: ids.room,
    type: "foreground",
    status: "queued",
    input: {
      kind: "protected_task_delivery_v1",
      bindingId: expectedBinding.bindingId,
      taskId: ids.task,
      taskRunId: ids.run,
      resultObjectId: expectedBinding.resultObjectId,
      wakeOperationId: expectedBinding.wakeOperationId,
    },
    result: null,
    message: null,
    createdAt,
    startedAt: null,
    completedAt: null,
    metadata: {},
    ...overrides,
  };
}

type FixtureOverrides = Readonly<{
  binding?: Partial<ProtectedTaskRunOutputBinding>;
  task?: Record<string, unknown>;
  run?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  room?: Record<string, unknown>;
  members?: readonly Record<string, unknown>[];
  session?: Record<string, unknown> | null;
  job?: Job | null;
  loseJobUpdate?: boolean;
}>;

function fixture(overrides: FixtureOverrides = {}) {
  let bindingRow = binding(overrides.binding);
  let jobRow = overrides.job === undefined ? null : overrides.job;
  let insertCount = 0;
  let updateCount = 0;
  let jobUpdateCount = 0;
  const selectedTables: unknown[] = [];
  const taskRow = {
    id: ids.task,
    ownerId: ids.requester,
    requestorId: ids.requester,
    agentId: ids.agent,
    callingRoomId: ids.room,
    resultDelivery: bindingRow.deliveryMode,
    status: "completed",
    cancelledAt: null,
    contentRepresentation: "protected",
    contentNamespaceId: "90000000-0000-4000-8000-000000000009",
    contentRevision: 1,
    cryptoObjectId: "task:v1:test",
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    cryptoMappingState: "verified",
    promptIsEmpty: true,
    expectedOutputIsNull: true,
    lastErrorIsNull: true,
    ...overrides.task,
  };
  const runRow = {
    id: ids.run,
    taskId: ids.task,
    status: "completed",
    completedAt: terminalAt,
    resultRepresentation: "protected",
    resultRevision: 1,
    resultContentNamespaceId: taskRow.contentNamespaceId,
    resultCryptoObjectId: resultObjectId,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    resultCryptoMappingState: "verified",
    resultTextIsNull: true,
    resultTextIsCancelled: false,
    lastErrorIsNull: true,
    ...overrides.run,
  };
  const roomRow = {
    id: ids.room,
    ownerId: ids.destinationOwner,
    namespaceId: ids.namespace,
    graphThreadId: `room:${ids.room}`,
    archivedAt: null,
    ...overrides.room,
  };
  const members = overrides.members ?? [
    { kind: "user", ownerId: ids.destinationOwner, agentId: null },
    { kind: "user", ownerId: ids.requester, agentId: null },
    { kind: "agent", ownerId: ids.destinationOwner, agentId: ids.agent },
  ];
  const sessionRow = overrides.session === undefined
    ? exactSession() : overrides.session;
  const rows = (table: unknown, projection?: Record<string, unknown>): unknown[] => {
    if (table === tasks) return [taskRow];
    if (table === taskRuns) return [runRow];
    if (table === protectedTaskRunOutputBindings) return [bindingRow];
    if (table === encryptionTransitionPolicy) {
      return [{ mode: "encrypted_only", revision: 9, ...overrides.policy }];
    }
    if (table === rooms) return [roomRow];
    if (table === roomMembers) return [...members];
    if (table === sessions) return sessionRow === null ? [] : [sessionRow];
    if (table === jobs) {
      if (jobRow === null) return [];
      return projection && "resultIsNull" in projection
        ? [{
            id: jobRow.id,
            ownerId: jobRow.ownerId,
            requestorId: jobRow.requestorId,
            laneKey: jobRow.laneKey,
            roomId: jobRow.roomId,
            type: jobRow.type,
            status: jobRow.status,
            input: jobRow.input,
            resultIsNull: jobRow.result === null,
            messageIsNull: jobRow.message === null,
            metadataIsEmpty: Object.keys(jobRow.metadata).length === 0,
            createdAt: jobRow.createdAt,
            startedAt: jobRow.startedAt,
            completedAt: jobRow.completedAt,
          }]
        : [jobRow];
    }
    throw new Error("unexpected table");
  };
  const selectBuilder = (table: unknown, projection?: Record<string, unknown>) => {
    const builder = {
      innerJoin: (_table: unknown, _condition: unknown) => builder,
      where: (_condition: unknown) => builder,
      limit: (_limit: number) => builder,
      for: async (_kind: string) => rows(table, projection),
    };
    return builder;
  };
  const tx = {
    select: (projection?: Record<string, unknown>) => ({ from: (table: unknown) => {
      selectedTables.push(table);
      return selectBuilder(table, projection);
    } }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: (_input: unknown) => ({
          returning: async (_projection: unknown) => {
            if (table !== jobs) throw new Error("unexpected insert table");
            insertCount += 1;
            if (jobRow !== null) return [];
            jobRow = exactJob(bindingRow, {
              ...values,
              createdAt,
            } as Partial<Job>);
            return [{ id: jobId }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async (_projection?: Record<string, unknown>) => {
            if (table === protectedTaskRunOutputBindings) {
              updateCount += 1;
              bindingRow = { ...bindingRow, ...patch };
              return [bindingRow];
            }
            if (table !== jobs) throw new Error("unexpected update table");
            jobUpdateCount += 1;
            if (overrides.loseJobUpdate || jobRow === null) return [];
            jobRow = { ...jobRow, ...patch };
            return [jobRow];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(work: (value: typeof tx) => Promise<T>) => work(tx),
  } as unknown as DirectDatabase;
  return { db, binding: () => bindingRow, job: () => jobRow,
    insertCount: () => insertCount, updateCount: () => updateCount,
    jobUpdateCount: () => jobUpdateCount, transaction: tx, selectedTables };
}

describe("protected Task output wake Job", () => {
  test("atomically inserts the stable content-free Job and scheduling receipt for a peer-owned group Room", async () => {
    const f = fixture({ policy: { revision: 10 } });
    const result = await insertOrAdoptProtectedTaskWakeJob(f.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    });
    expect(result.status).toBe("scheduled");
    if (result.status === "scheduled") {
      expect(result.scheduling).toMatchObject({
        jobId,
        ownerId: ids.requester,
        requestorId: ids.requester,
        sessionOwnerId: ids.destinationOwner,
        graphThreadId: groupThreadId,
        jobState: "queued",
      });
      expect(Object.keys(result.scheduling.reference).sort()).toEqual([
        "bindingId", "kind", "resultObjectId", "taskId", "taskRunId",
        "wakeOperationId",
      ]);
    }
    expect(f.job()?.input).toEqual(result.status === "scheduled"
      ? result.scheduling.reference : undefined);
    expect(f.binding()).toMatchObject({
      wakeJobId: jobId,
      wakeScheduledAt: createdAt,
      completedAt: createdAt,
    });
    expect(f.insertCount()).toBe(1);
    expect(f.updateCount()).toBe(1);
    expect(f.selectedTables.slice(0, 3)).toEqual([
      tasks, taskRuns, protectedTaskRunOutputBindings,
    ]);
  });

  test("derives the Room thread for a strict DM and treats Session endedAt as activity", async () => {
    const roomThread = `room:${ids.room}`;
    const f = fixture({
      members: [
        { kind: "user", ownerId: ids.destinationOwner, agentId: null },
        { kind: "agent", ownerId: ids.destinationOwner, agentId: ids.agent },
      ],
      task: { requestorId: ids.destinationOwner, ownerId: ids.destinationOwner },
      session: {
        id: ids.session, ownerId: ids.destinationOwner, agentId: ids.agent,
        roomId: ids.room, threadId: roomThread, personaId: "owner",
        endedAt: attachedAt,
      },
    });
    const result = await insertOrAdoptProtectedTaskWakeJob(f.db, {
      taskId: ids.task, taskRunId: ids.run,
    });
    expect(result.status).toBe("scheduled");
    if (result.status === "scheduled") {
      expect(result.scheduling.graphThreadId).toBe(roomThread);
    }
  });

  test("adopts exact queued, running, and completed Jobs but never revives failed or cancelled rows", async () => {
    const pristine = binding();
    const adopted = fixture({ binding: pristine, job: exactJob(pristine) });
    const scheduled = await insertOrAdoptProtectedTaskWakeJob(adopted.db, {
      taskId: ids.task, taskRunId: ids.run,
    });
    expect(scheduled.status).toBe("scheduled");
    expect(adopted.binding()).toMatchObject({ wakeJobId: jobId,
      wakeScheduledAt: createdAt, completedAt: createdAt });

    for (const [status, startedAt, completedAt] of [
      ["queued", null, null],
      ["running", createdAt, null],
      ["completed", createdAt, new Date(createdAt.getTime() + 1_000)],
    ] as const) {
      const existingBinding = binding({ wakeJobId: jobId,
        wakeScheduledAt: createdAt, completedAt: createdAt });
      const f = fixture({ binding: existingBinding,
        job: exactJob(existingBinding, { status, startedAt, completedAt }) });
      const result = await insertOrAdoptProtectedTaskWakeJob(f.db, {
        taskId: ids.task, taskRunId: ids.run,
      });
      expect(result.status).toBe("exact_replay");
      if (result.status === "exact_replay") {
        expect(result.scheduling.jobState).toBe(status);
      }
      expect(f.updateCount()).toBe(0);
    }
    for (const status of ["failed", "cancelled"] as const) {
      const existingBinding = binding({ wakeJobId: jobId,
        wakeScheduledAt: createdAt, completedAt: createdAt });
      const f = fixture({ binding: existingBinding,
        job: exactJob(existingBinding, { status, completedAt: createdAt }) });
      expect(await insertOrAdoptProtectedTaskWakeJob(f.db, {
        taskId: ids.task, taskRunId: ids.run,
      })).toEqual({ status: "rejected", reason: "conflict" });
    }
  });

  test("rejects incompatible policy, protected plaintext, stale audience, and an unfinished raw delivery", async () => {
    const cases: readonly FixtureOverrides[] = [
      { policy: { mode: "shadow_encryption", revision: 10 } },
      { policy: { mode: "encrypted_only", revision: 8 } },
      { task: { promptIsEmpty: false } },
      { run: { resultTextIsNull: false } },
      { members: [
        { kind: "user", ownerId: ids.destinationOwner, agentId: null },
        { kind: "agent", ownerId: ids.destinationOwner, agentId: ids.agent },
      ] },
      { session: null },
      { session: { id: ids.session, ownerId: ids.requester,
        agentId: ids.agent, roomId: ids.room, threadId: groupThreadId,
        personaId: "owner", endedAt: null } },
      { binding: { deliveryMode: "raw_and_wake",
        messageOperationId: `task-run-delivery-message:${ids.run}` },
        task: { resultDelivery: "raw_and_wake" } },
    ];
    for (const value of cases) {
      const result = await insertOrAdoptProtectedTaskWakeJob(fixture(value).db, {
        taskId: ids.task, taskRunId: ids.run,
      });
      expect(result.status).toBe("rejected");
    }
  });
});

type LifecycleFixtureOverrides = Omit<FixtureOverrides, "binding" | "job"> &
  Readonly<{
    binding?: Partial<ProtectedTaskRunOutputBinding>;
    job?: Partial<Job>;
  }>;

function lifecycleFixture(
  status: Job["status"] = "queued",
  overrides: LifecycleFixtureOverrides = {},
) {
  const scheduledBinding = binding({
    wakeJobId: jobId,
    wakeScheduledAt: createdAt,
    completedAt: createdAt,
    ...overrides.binding,
  });
  const startedAt = status === "queued" ? null
    : new Date(createdAt.getTime() + 1_000);
  const completedAt = status === "completed" || status === "failed"
    ? new Date(createdAt.getTime() + 2_000)
    : null;
  return fixture({
    ...overrides,
    binding: scheduledBinding,
    job: exactJob(scheduledBinding, {
      status,
      startedAt,
      completedAt,
      ...overrides.job,
    }),
  });
}

const wakeCoordinates = Object.freeze({
  taskId: ids.task,
  taskRunId: ids.run,
  jobId,
});

describe("protected Task wake Job lifecycle", () => {
  test("keeps Shadow error siblings readable but rejects plaintext error in Full", async () => {
    const shadow = lifecycleFixture("queued", {
      task: { contentRepresentation: "dual", lastErrorIsNull: false },
      run: { resultRepresentation: "dual" },
      policy: { mode: "shadow_encryption" },
    });
    expect(await readProtectedTaskWakeScheduling(shadow.transaction as unknown as Parameters<typeof readProtectedTaskWakeScheduling>[0], wakeCoordinates)).not.toBeNull();
    expect((await claimProtectedTaskWakeJob(shadow.db, wakeCoordinates, async () => true)).status).toBe("started");
    const full = lifecycleFixture("queued", { task: { lastErrorIsNull: false } });
    expect(await readProtectedTaskWakeScheduling(full.transaction as unknown as Parameters<typeof readProtectedTaskWakeScheduling>[0], wakeCoordinates)).toBeNull();
    expect((await claimProtectedTaskWakeJob(full.db, wakeCoordinates, async () => true)).status).toBe("rejected");
    expect(full.jobUpdateCount()).toBe(0);
  });

  test("reads exact scheduling on the borrowed transaction without starting or settling work", async () => {
    for (const state of ["queued", "running", "completed", "failed"] as const) {
      const f = lifecycleFixture(state);
      expect(await readProtectedTaskWakeScheduling(f.transaction as unknown as Parameters<typeof readProtectedTaskWakeScheduling>[0], wakeCoordinates)).toMatchObject({
        taskId: ids.task, taskRunId: ids.run, jobId, jobState: state,
        sessionOwnerId: ids.destinationOwner,
      });
      expect(f.jobUpdateCount()).toBe(0);
    }
  });

  test("claims one exact queued wake with the held transaction and leaves its content fields empty", async () => {
    const f = lifecycleFixture("queued", { session: exactSession(createdAt) });
    let callbackCount = 0;
    const result = await claimProtectedTaskWakeJob(
      f.db,
      wakeCoordinates,
      async (transaction, scheduling) => {
        callbackCount += 1;
        expect(transaction as unknown).toBe(f.transaction);
        expect(scheduling).toMatchObject({
          taskId: ids.task,
          taskRunId: ids.run,
          jobId,
          jobState: "queued",
          sessionOwnerId: ids.destinationOwner,
        });
        return true;
      },
    );
    expect(result.status).toBe("started");
    if (result.status === "started") {
      expect(result.scheduling.jobState).toBe("running");
    }
    expect(callbackCount).toBe(1);
    expect(f.jobUpdateCount()).toBe(1);
    expect(f.job()).toMatchObject({
      status: "running",
      result: null,
      message: null,
      metadata: {},
      completedAt: null,
    });
    expect(f.job()?.startedAt).toBeInstanceOf(Date);

    const competing = await claimProtectedTaskWakeJob(
      f.db,
      wakeCoordinates,
      async () => { callbackCount += 1; return true; },
    );
    expect(competing).toEqual({
      status: "rejected",
      reason: "uncertain_execution",
    });
    expect(callbackCount).toBe(1);
    expect(f.jobUpdateCount()).toBe(1);
  });

  test("never reclaims a running wake or revives terminal wake work", async () => {
    const running = lifecycleFixture("running");
    let callbackCount = 0;
    expect(await claimProtectedTaskWakeJob(
      running.db,
      wakeCoordinates,
      async () => { callbackCount += 1; return true; },
    )).toEqual({ status: "rejected", reason: "uncertain_execution" });
    expect(callbackCount).toBe(0);
    expect(running.jobUpdateCount()).toBe(0);

    for (const status of ["completed", "failed", "cancelled"] as const) {
      const f = lifecycleFixture(status);
      expect(await claimProtectedTaskWakeJob(
        f.db,
        wakeCoordinates,
        async () => true,
      )).toEqual({ status: "rejected", reason: "conflict" });
      expect(f.jobUpdateCount()).toBe(0);
    }
  });

  test("rejects a denied claim, a lost queue CAS, and tampered content-free coordinates", async () => {
    const denied = lifecycleFixture();
    expect(await claimProtectedTaskWakeJob(
      denied.db,
      wakeCoordinates,
      async () => false,
    )).toEqual({ status: "rejected", reason: "claim_rejected" });
    expect(denied.jobUpdateCount()).toBe(0);

    const lost = lifecycleFixture("queued", { loseJobUpdate: true });
    expect(await claimProtectedTaskWakeJob(
      lost.db,
      wakeCoordinates,
      async () => true,
    )).toEqual({ status: "rejected", reason: "conflict" });

    const tampered = lifecycleFixture("queued", {
      job: { input: { bad: true } },
    });
    let tamperedCallback = 0;
    expect(await claimProtectedTaskWakeJob(
      tampered.db,
      wakeCoordinates,
      async () => { tamperedCallback += 1; return true; },
    )).toEqual({ status: "rejected", reason: "conflict" });
    expect(tamperedCallback).toBe(0);
  });

  test("revalidates current policy, Room audience, archive state, and empty Job content", async () => {
    const cases = [
      { policy: { mode: "shadow_encryption" } },
      { policy: { revision: 8 } },
      { room: { archivedAt: createdAt } },
      { session: null },
      { members: [
        { kind: "user", ownerId: ids.destinationOwner, agentId: null },
        { kind: "agent", ownerId: ids.destinationOwner, agentId: ids.agent },
      ] },
    ] satisfies readonly LifecycleFixtureOverrides[];
    for (const value of cases) {
      const f = lifecycleFixture("queued", value);
      let callbackCount = 0;
      const result = await claimProtectedTaskWakeJob(
        f.db,
        wakeCoordinates,
        async () => { callbackCount += 1; return true; },
      );
      expect(result.status).toBe("rejected");
      expect(callbackCount).toBe(0);
    }
    for (const patch of [
      { result: { leaked: true } },
      { message: "leaked" },
      { metadata: { extra: true } },
    ] satisfies readonly Partial<Job>[]) {
      const f = lifecycleFixture("queued", { job: patch });
      expect(await claimProtectedTaskWakeJob(
        f.db,
        wakeCoordinates,
        async () => true,
      )).toEqual({ status: "rejected", reason: "conflict" });
    }
  });

  test("settles running work and validates exact terminal replay through the claim owner", async () => {
    const f = lifecycleFixture("running");
    let callbackCount = 0;
    const settle = () => settleProtectedTaskWakeJob(f.db, {
      ...wakeCoordinates,
      requestedStatus: "completed",
    }, async (transaction, scheduling) => {
      callbackCount += 1;
      expect(transaction as unknown).toBe(f.transaction);
      expect(scheduling.jobState).toBe(callbackCount === 1
        ? "running"
        : "completed");
      return true;
    });
    const first = await settle();
    expect(first.status).toBe("settled");
    if (first.status === "settled") {
      expect(first.jobStatus).toBe("completed");
      expect(first.scheduling.jobState).toBe("completed");
    }
    expect(f.job()).toMatchObject({
      status: "completed",
      result: null,
      message: null,
      metadata: {},
    });
    expect(f.job()?.completedAt).toBeInstanceOf(Date);

    const replay = await settle();
    expect(replay.status).toBe("exact_replay");
    expect(callbackCount).toBe(2);
    expect(f.jobUpdateCount()).toBe(1);
  });

  test("settlement fails closed for a stale claim, queued work, or a different terminal outcome", async () => {
    const stale = lifecycleFixture("running");
    expect(await settleProtectedTaskWakeJob(stale.db, {
      ...wakeCoordinates,
      requestedStatus: "failed",
    }, async () => false)).toEqual({
      status: "rejected",
      reason: "claim_rejected",
    });
    expect(stale.jobUpdateCount()).toBe(0);

    const terminalFailure = lifecycleFixture("running");
    expect(await settleProtectedTaskWakeJob(terminalFailure.db, {
      ...wakeCoordinates,
      requestedStatus: "failed",
    }, async () => true)).toMatchObject({
      status: "settled",
      jobStatus: "failed",
      scheduling: { jobState: "failed" },
    });
    expect(terminalFailure.job()).toMatchObject({
      status: "failed",
      result: null,
      message: null,
      metadata: {},
    });

    const queued = lifecycleFixture("queued");
    expect(await settleProtectedTaskWakeJob(queued.db, {
      ...wakeCoordinates,
      requestedStatus: "completed",
    }, async () => true)).toEqual({ status: "rejected", reason: "not_ready" });

    const failed = lifecycleFixture("failed");
    expect(await settleProtectedTaskWakeJob(failed.db, {
      ...wakeCoordinates,
      requestedStatus: "completed",
    }, async () => true)).toEqual({ status: "rejected", reason: "conflict" });
    expect(await settleProtectedTaskWakeJob(failed.db, {
      ...wakeCoordinates,
      requestedStatus: "failed",
    }, async () => true)).toMatchObject({
      status: "exact_replay",
      jobStatus: "failed",
    });

    const cancelled = lifecycleFixture("cancelled");
    expect(await settleProtectedTaskWakeJob(cancelled.db, {
      ...wakeCoordinates,
      requestedStatus: "failed",
    }, async () => true)).toEqual({ status: "rejected", reason: "conflict" });
  });
});

function discoveryDb(rows: readonly Record<string, unknown>[]): DirectDatabase {
  const builder = {
    innerJoin: (_table: unknown, _condition: unknown) => builder,
    where: (_condition: unknown) => builder,
    orderBy: (..._order: unknown[]) => builder,
    limit: async (limit: number) => rows.slice(0, limit),
  };
  return {
    select: (_projection: unknown) => ({
      from: (_table: unknown) => builder,
    }),
  } as unknown as DirectDatabase;
}

function discoveryRow(overrides: Record<string, unknown> = {}) {
  const expectedBinding = binding({ wakeJobId: jobId,
    wakeScheduledAt: createdAt, completedAt: createdAt });
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    taskOwnerId: ids.requester,
    taskRequestorId: ids.requester,
    bindingId: expectedBinding.bindingId,
    resultObjectId: expectedBinding.resultObjectId,
    wakeOperationId: expectedBinding.wakeOperationId,
    wakeJobId: jobId,
    wakeScheduledAt: createdAt,
    bindingCompletedAt: createdAt,
    destinationRoomId: ids.room,
    jobId,
    jobOwnerId: ids.requester,
    jobRequestorId: ids.requester,
    jobRoomId: ids.room,
    jobLaneKey: `room:${ids.room}`,
    jobType: "foreground",
    jobStatus: "queued",
    jobInput: exactJob(expectedBinding).input,
    jobResultIsNull: true,
    jobMessageIsNull: true,
    jobCreatedAt: createdAt,
    jobStartedAt: null,
    jobCompletedAt: null,
    ...overrides,
  };
}

test("wake discovery pages past malformed rows and distinguishes crash-uncertain running work", async () => {
  const secondRun = "20000000-0000-4000-8000-000000000003";
  const secondJob = protectedTaskRunWakeJobId(secondRun);
  const thirdRun = "20000000-0000-4000-8000-000000000004";
  const thirdJob = protectedTaskRunWakeJobId(thirdRun);
  const later = new Date(createdAt.getTime() + 1_000);
  const latest = new Date(later.getTime() + 1_000);
  const rows = [
    discoveryRow(),
    discoveryRow({ taskRunId: secondRun, jobId: secondJob, wakeJobId: secondJob,
      bindingId: protectedTaskRunOutputBindingId(secondRun),
      wakeOperationId: protectedTaskRunWakeOperationId(secondRun),
      jobInput: { bad: true }, jobCreatedAt: later,
      wakeScheduledAt: later, bindingCompletedAt: later }),
    discoveryRow({ taskRunId: thirdRun, jobId: thirdJob, wakeJobId: thirdJob,
      bindingId: protectedTaskRunOutputBindingId(thirdRun),
      wakeOperationId: protectedTaskRunWakeOperationId(thirdRun),
      resultObjectId: protectedTaskRunResultObjectId(ids.task, thirdRun),
      jobInput: {
        kind: "protected_task_delivery_v1",
        bindingId: protectedTaskRunOutputBindingId(thirdRun),
        taskId: ids.task,
        taskRunId: thirdRun,
        resultObjectId: protectedTaskRunResultObjectId(ids.task, thirdRun),
        wakeOperationId: protectedTaskRunWakeOperationId(thirdRun),
      },
      jobStatus: "running", jobStartedAt: latest, jobCreatedAt: latest,
      wakeScheduledAt: latest, bindingCompletedAt: latest }),
  ];
  const throughTime = new Date(latest.getTime() + 1_000);
  const page = await listProtectedTaskWakeExecutionCandidates(
    discoveryDb(rows),
    { limit: 2, throughTime },
  );
  expect(page.candidates).toEqual([
    { taskId: ids.task, taskRunId: ids.run, jobId,
      state: "awaiting_authority" },
  ]);
  expect(page.next).toEqual({ throughTime, createdAt: later, jobId: secondJob });
  if (page.next === null) throw new Error("expected a second wake page");

  const secondPage = await listProtectedTaskWakeExecutionCandidates(
    discoveryDb([rows[2]!]),
    { limit: 2, throughTime, cursor: page.next },
  );
  expect(secondPage.candidates).toEqual([
    { taskId: ids.task, taskRunId: thirdRun, jobId: thirdJob,
      state: "uncertain_execution" },
  ]);
  expect(secondPage.next).toBeNull();
});
