import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  prepareProtectedTaskCancellationOutput,
  PROTECTED_TASK_CANCELLED_RESULT,
  publishProtectedTaskCancellationProduct,
  type ProtectedTaskCancellationOutputIntent,
} from "../../src/queries/protected-task-cancellation-output";
import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeOperationId,
} from "../../src/queries/protected-task-output-binding-identities";
import {
  encryptionTransitionPolicy,
  type EncryptionTransitionPolicyRow,
} from "../../src/schema/encryption-transition";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";
import { rooms, type Room } from "../../src/schema/rooms";
import {
  taskDefinitionCryptoRevisions,
  type TaskDefinitionCryptoRevision,
} from "../../src/schema/task-definition-crypto-revisions";
import {
  taskRunResultCryptoRevisions,
  type TaskRunResultCryptoRevision,
} from "../../src/schema/task-run-result-crypto-revisions";
import { actors, type Actor } from "../../src/schema/trust";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
  job: "70000000-0000-4000-8000-000000000007",
  human: "80000000-0000-4000-8000-000000000008",
};
const cancelledAt = new Date("2026-10-09T18:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: ids.room,
    resultDelivery: "raw_and_wake",
    scheduleKind: "one_shot",
    fundingMode: "legacy_server",
    status: "cancelled",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    cryptoMappingState: "verified",
    lastError: null,
    cancelledAt,
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: null,
    graphThreadId: `task-cancellation:${ids.task}`,
    status: "cancelled",
    fundingBinding: null,
    fundingPredecessorRunId: null,
    completedAt: cancelledAt,
    resultText: null,
    lastError: null,
    resultRepresentation: "ordinary",
    resultContentNamespaceId: null,
    resultRevision: 0,
    resultCryptoObjectId: null,
    resultCryptoAccessRevision: 0,
    resultCryptoRequiredNamespaceFingerprint: null,
    resultCryptoMappingState: "unmapped",
    ...overrides,
  } as TaskRun;
}

function policy(
  overrides: Partial<EncryptionTransitionPolicyRow> = {},
): EncryptionTransitionPolicyRow {
  return {
    id: "server",
    mode: "encrypted_only",
    revision: 9,
    ...overrides,
  } as EncryptionTransitionPolicyRow;
}

function binding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    deliveryMode: "raw_and_wake",
    destinationRoomId: ids.room,
    destinationNamespaceId: ids.namespace,
    resultRevision: 1,
    resultOperationId: protectedTaskRunResultOperationId(ids.run),
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    messageOperationId: protectedTaskRunMessageOperationId(ids.run),
    wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    acceptedPolicyRevision: 9,
    acceptedAt: new Date("2026-10-09T17:55:00.000Z"),
    resultTerminalAt: null,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
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
    status: "cancelled",
    input: {
      kind: "protected_task_run_v1",
      taskId: ids.task,
      taskRunId: ids.run,
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
      authorizationRequestId: `task-run-authorization:${ids.run}`,
      policyRevision: 9,
      executionSegment: 1,
    },
    result: null,
    message: null,
    createdAt: new Date("2026-10-09T17:56:00.000Z"),
    startedAt: new Date("2026-10-09T17:57:00.000Z"),
    completedAt: cancelledAt,
    metadata: {},
    ...overrides,
  };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: ids.room,
    namespaceId: ids.namespace,
    archivedAt: null,
    ...overrides,
  } as Room;
}

function harness(options: Readonly<{
  task?: Task | null;
  run?: TaskRun | null;
  policy?: EncryptionTransitionPolicyRow | null;
  binding?: ProtectedTaskRunOutputBinding | null;
  job?: Job | null;
  room?: Room | null;
  ledger?: TaskRunResultCryptoRevision | null;
  loseBindingUpdate?: boolean;
}> = {}) {
  const taskRow = options.task === undefined ? task() : options.task;
  const runRow = options.run === undefined ? run() : options.run;
  const policyRow = options.policy === undefined ? policy() : options.policy;
  let bindingRow = options.binding === undefined ? binding() : options.binding;
  const jobRow = options.job === undefined ? null : options.job;
  const roomRow = options.room === undefined ? room() : options.room;
  const ledgerRow = options.ledger ?? null;
  const locks: Array<{ table: unknown; kind: string }> = [];
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const rows = (table: unknown): unknown[] => {
    if (table === encryptionTransitionPolicy) return policyRow ? [policyRow] : [];
    if (table === tasks) {
      return taskRow
        ? [{
            ...taskRow,
            promptIsEmpty: taskRow.prompt === "",
            expectedOutputIsNull: taskRow.expectedOutput === null,
            lastErrorIsNull: taskRow.lastError === null,
          }]
        : [];
    }
    if (table === taskRuns) {
      return runRow
        ? [{
            ...runRow,
            resultTextIsNull: runRow.resultText === null,
            resultTextIsCancelled:
              runRow.resultText === PROTECTED_TASK_CANCELLED_RESULT,
            lastErrorIsNull: runRow.lastError === null,
          }]
        : [];
    }
    if (table === jobs) {
      if (!jobRow) return [];
      const reference = jobRow.input ?? {};
      const keys = Object.keys(reference);
      const hasAcceptance = Object.hasOwn(reference, "resumeAcceptanceId");
      const hasContinuation = Object.hasOwn(
        reference,
        "resumeContinuationFingerprint",
      );
      const policyRevision = reference["policyRevision"];
      const executionSegment = reference["executionSegment"];
      return [{
        id: jobRow.id,
        ownerId: jobRow.ownerId,
        requestorId: jobRow.requestorId,
        laneKey: jobRow.laneKey,
        type: jobRow.type,
        status: jobRow.status,
        referenceHasClosedKeys: keys.length === 8
            && !hasAcceptance && !hasContinuation
          || keys.length === 9 && hasAcceptance !== hasContinuation,
        referenceKind: reference["kind"] ?? null,
        referenceTaskId: reference["taskId"] ?? null,
        referenceTaskRunId: reference["taskRunId"] ?? null,
        referenceInputObjectId: reference["inputObjectId"] ?? null,
        referenceResultObjectId: reference["resultObjectId"] ?? null,
        referenceAuthorizationRequestId:
          reference["authorizationRequestId"] ?? null,
        referencePolicyRevision:
          typeof policyRevision === "string"
            || typeof policyRevision === "number"
            ? String(policyRevision)
            : null,
        referenceExecutionSegment:
          typeof executionSegment === "string"
            || typeof executionSegment === "number"
            ? String(executionSegment)
            : null,
        referenceResumeAcceptanceId: reference["resumeAcceptanceId"] ?? null,
        referenceResumeContinuationFingerprint:
          reference["resumeContinuationFingerprint"] ?? null,
        startedAt: jobRow.startedAt,
        completedAt: jobRow.completedAt,
        resultIsNull: jobRow.result === null,
        messageIsNull: jobRow.message === null,
      }];
    }
    if (table === rooms) return roomRow ? [roomRow] : [];
    if (table === protectedTaskRunOutputBindings) {
      return bindingRow ? [bindingRow] : [];
    }
    if (table === taskRunResultCryptoRevisions) {
      return ledgerRow ? [ledgerRow] : [];
    }
    throw new Error("unexpected table");
  };
  const tx = {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (kind: string) => {
            locks.push({ table, kind });
            return rows(table);
          },
          then: <TResult1 = unknown[], TResult2 = never>(
            onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(rows(table)).then(onfulfilled, onrejected),
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table !== protectedTaskRunOutputBindings || bindingRow === null) {
              throw new Error("unexpected update table");
            }
            if (options.loseBindingUpdate) return [];
            updates.push(values);
            bindingRow = { ...bindingRow, ...values };
            return [bindingRow];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (table !== protectedTaskRunOutputBindings) {
            throw new Error("unexpected insert table");
          }
          inserts.push(values);
          bindingRow = {
            resultTerminalAt: null,
            resultAttachedAt: null,
            messageId: null,
            messagePublishedAt: null,
            wakeJobId: null,
            wakeScheduledAt: null,
            completedAt: null,
            ...values,
          } as ProtectedTaskRunOutputBinding;
          return [bindingRow];
        },
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, locks, updates, inserts };
}

const input = {
  taskId: ids.task,
  taskRunId: ids.run,
  requiredPolicyRevision: 9,
} as const;

function cancellationBinding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return binding({
    resultRevision: 2,
    resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
    resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
    resultTerminalAt: cancelledAt,
    ...overrides,
  });
}

describe("protected Task cancellation output intent", () => {
  test("retargets the pristine pre-dispatch output after authority settlement", async () => {
    const fixture = harness();
    const settled: unknown[] = [];
    const result = await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      authority => {
        settled.push(authority);
        return Promise.resolve(true);
      },
    );
    expect(result.status).toBe("prepared");
    expect(settled).toEqual([{
      taskId: ids.task,
      taskRunId: ids.run,
      contentNamespaceId: ids.namespace,
      jobAuthorizationRequestId: null,
    }]);
    expect(fixture.updates).toEqual([{
      resultRevision: 2,
      resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
      resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
      acceptedPolicyRevision: 9,
      resultTerminalAt: cancelledAt,
    }]);
    expect(fixture.locks.map(({ table }) => table)).toEqual([
      encryptionTransitionPolicy,
      tasks,
      taskRuns,
      protectedTaskRunOutputBindings,
      rooms,
    ]);
  });

  test("retargets an execution-era binding to the current same-mode policy", async () => {
    const fixture = harness({
      binding: binding({ acceptedPolicyRevision: 8 }),
    });
    expect(await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      () => Promise.resolve(true),
    )).toMatchObject({
      status: "prepared",
      binding: { acceptedPolicyRevision: 9, resultRevision: 2 },
    });
    expect(fixture.updates[0]).toMatchObject({
      acceptedPolicyRevision: 9,
      resultRevision: 2,
    });
  });

  test("accepts stopped running and parked Job identities without replaying them", async () => {
    for (const terminalJob of [
      job(),
      job({ status: "completed", completedAt: cancelledAt }),
    ]) {
      const fixture = harness({
        run: run({ jobId: ids.job }),
        job: terminalJob,
      });
      const result = await prepareProtectedTaskCancellationOutput(
        fixture.db,
        input,
        authority => Promise.resolve(
          authority.jobAuthorizationRequestId
            === `task-run-authorization:${ids.run}`,
        ),
      );
      expect(result.status).toBe("prepared");
      expect(fixture.locks.map(({ table }) => table)).toEqual([
        encryptionTransitionPolicy,
        tasks,
        taskRuns,
        jobs,
        protectedTaskRunOutputBindings,
        rooms,
      ]);
    }
  });

  test("creates the fixed cancellation binding for a synthetic pre-dispatch run", async () => {
    const fixture = harness({ binding: null });
    const result = await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      authority => Promise.resolve(
        authority.jobAuthorizationRequestId === null,
      ),
    );
    expect(result.status).toBe("prepared");
    expect(fixture.inserts).toHaveLength(1);
    expect(fixture.inserts[0]).toMatchObject({
      taskRunId: ids.run,
      resultRevision: 2,
      resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
      resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
      deliveryMode: "raw_and_wake",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      acceptedPolicyRevision: 9,
      acceptedAt: cancelledAt,
      resultTerminalAt: cancelledAt,
    });
    expect(fixture.updates).toEqual([]);
  });

  test("replays only the exact cancellation coordinate", async () => {
    const fixture = harness({ binding: cancellationBinding() });
    const result = await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      () => Promise.resolve(true),
    );
    expect(result.status).toBe("exact_replay");
    expect(fixture.updates).toEqual([]);
  });

  test("refreshes an exact pristine cancellation intent to a newer same-mode policy only with explicit custody proof", async () => {
    const fixture = harness({ binding: cancellationBinding({ acceptedPolicyRevision: 8 }) });
    let previousSettlementCalled = false;
    const contexts: unknown[] = [];
    const result = await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      () => {
        previousSettlementCalled = true;
        return Promise.resolve(true);
      },
      context => {
        contexts.push(context);
        return Promise.resolve(true);
      },
    );
    expect(result).toMatchObject({ status: "prepared",
      binding: { acceptedPolicyRevision: 9 }, intent: { policyRevision: 9 } });
    expect(previousSettlementCalled).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      previousIntent: { policyRevision: 8 },
      nextIntent: { policyRevision: 9 },
    });
    expect((contexts[0] as { transaction: unknown }).transaction).toBeDefined();
    expect(fixture.updates).toEqual([{ acceptedPolicyRevision: 9 }]);
  });

  test("policy refresh defaults closed and rejects custody, ledger, backwards, cross-mode, and CAS races", async () => {
    const old = cancellationBinding({ acceptedPolicyRevision: 8 });
    const noGuard = harness({ binding: old });
    expect(await prepareProtectedTaskCancellationOutput(
      noGuard.db, input, () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "not_ready" });

    const custody = harness({ binding: old });
    expect(await prepareProtectedTaskCancellationOutput(
      custody.db, input, () => Promise.resolve(true), () => Promise.resolve(false),
    )).toEqual({ status: "rejected", reason: "not_ready" });

    const withLedger = harness({ binding: old,
      ledger: resultReservation("protected") });
    let ledgerGuardCalled = false;
    expect(await prepareProtectedTaskCancellationOutput(
      withLedger.db, input, () => Promise.resolve(true), () => {
        ledgerGuardCalled = true;
        return Promise.resolve(true);
      },
    )).toEqual({ status: "rejected", reason: "conflict" });
    expect(ledgerGuardCalled).toBe(false);

    const backwards = harness({ binding: cancellationBinding({ acceptedPolicyRevision: 10 }) });
    expect(await prepareProtectedTaskCancellationOutput(
      backwards.db, input, () => Promise.resolve(true), () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "conflict" });

    const crossMode = harness({ binding: old, policy: policy({ mode: "shadow_encryption" }) });
    expect(await prepareProtectedTaskCancellationOutput(
      crossMode.db, input, () => Promise.resolve(true), () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });

    const lost = harness({ binding: old, loseBindingUpdate: true });
    expect(prepareProtectedTaskCancellationOutput(
      lost.db, input, () => Promise.resolve(true), () => Promise.resolve(true),
    )).rejects.toThrow("lost its locked binding");
  });

  test("keeps the original intent when previous authority is not settled", async () => {
    const fixture = harness();
    expect(await prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      () => Promise.resolve(false),
    )).toEqual({ status: "rejected", reason: "not_ready" });
    expect(fixture.updates).toEqual([]);
  });

  test("propagates settlement failure before any binding mutation", async () => {
    const fixture = harness();
    expect(prepareProtectedTaskCancellationOutput(
      fixture.db,
      input,
      () => Promise.reject(new Error("settlement failed")),
    )).rejects.toThrow("settlement failed");
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  test("rejects Plain, a normal completion winner, and output with receipts", async () => {
    const cases = [
      harness({ task: task({ contentRepresentation: "ordinary" }) }),
      harness({
        task: task({ status: "completed" }),
        run: run({ status: "completed" }),
      }),
      harness({ binding: binding({ resultTerminalAt: cancelledAt }) }),
      harness({
        run: run({ jobId: ids.job }),
        job: job({ input: { ...(job().input ?? {}), unexpected: true } }),
      }),
    ];
    for (const fixture of cases) {
      let callbackCalled = false;
      const result = await prepareProtectedTaskCancellationOutput(
        fixture.db,
        input,
        () => {
          callbackCalled = true;
          return Promise.resolve(true);
        },
      );
      expect(result.status).toBe("rejected");
      expect(callbackCalled).toBe(false);
      expect(fixture.updates).toEqual([]);
    }
  });

  test("rejects missing runs, changed policy, and substituted destinations", async () => {
    const cases = [
      harness({ run: null }),
      harness({ policy: policy({ revision: 10 }) }),
      harness({ task: task({ callingRoomId: null }) }),
      harness({ room: null }),
    ];
    for (const fixture of cases) {
      const result = await prepareProtectedTaskCancellationOutput(
        fixture.db,
        input,
        () => Promise.resolve(true),
      );
      expect(result.status).toBe("rejected");
      expect(fixture.updates).toEqual([]);
    }
  });

  test("rejects malformed coordinates before acquiring locks", async () => {
    const fixture = harness();
    expect(prepareProtectedTaskCancellationOutput(
      fixture.db,
      { ...input, taskRunId: "not-a-uuid" },
      () => Promise.resolve(true),
    )).rejects.toThrow("malformed");
    expect(fixture.locks).toEqual([]);
  });
});

const requestDigest = new Uint8Array(32).fill(7);
const authorityFingerprint = new Uint8Array(32).fill(8);

function definition(
  representation: "protected" | "dual",
): TaskDefinitionCryptoRevision {
  return {
    taskId: ids.task,
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    representation,
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: new Uint8Array(32),
    completion: "complete",
    disposition: "mapped",
    failureCode: null,
  } as TaskDefinitionCryptoRevision;
}

function resultReservation(
  representation: "protected" | "dual",
  overrides: Partial<TaskRunResultCryptoRevision> = {},
): TaskRunResultCryptoRevision {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    contentNamespaceId: ids.namespace,
    anchorNamespaceId: ids.namespace,
    resultRevision: 2,
    operationId: protectedTaskRunCancelledResultOperationId(ids.run),
    requestDigest,
    authorityFingerprint,
    requesterHumanId: ids.human,
    cryptoObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
    representation,
    payloadVersion: 1,
    cryptoAccessRevision: 0,
    requiredNamespaceFingerprint: new Uint8Array(32),
    completion: "pending",
    disposition: "active",
    failureCode: null,
    ...overrides,
  } as TaskRunResultCryptoRevision;
}

function intent(
  representation: "protected" | "dual",
): ProtectedTaskCancellationOutputIntent {
  return Object.freeze({
    taskId: ids.task,
    taskRunId: ids.run,
    requesterUserId: ids.owner,
    agentId: ids.agent,
    contentNamespaceId: ids.namespace,
    representation,
    resultRevision: 2,
    resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
    resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
    policyRevision: 9,
    taskStatus: "cancelled",
    runStatus: "cancelled",
    terminalAt: cancelledAt,
  });
}

function productHarness(options: Readonly<{
  representation: "protected" | "dual";
  run?: TaskRun;
  binding?: ProtectedTaskRunOutputBinding;
  reservation?: TaskRunResultCryptoRevision;
  actor?: Actor | null;
  policyRevision?: number;
  policyMode?: EncryptionTransitionPolicyRow["mode"];
}> ) {
  const representation = options.representation;
  const taskRow = task({
    contentRepresentation: representation,
    prompt: representation === "protected" ? "" : "ordinary shadow",
    expectedOutput: null,
  });
  let runRow = options.run ?? run();
  const bindingRow = options.binding ?? binding({
    resultRevision: 2,
    resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
    resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
    resultTerminalAt: cancelledAt,
  });
  const policyRow = policy({
    mode: options.policyMode ?? (representation === "dual"
      ? "shadow_encryption" : "encrypted_only"),
    revision: options.policyRevision ?? 9,
  });
  const definitionRow = definition(representation);
  const reservationRow = options.reservation
    ?? resultReservation(representation);
  const actorRow = options.actor === undefined
    ? ({ id: ids.human, kind: "user", ownerId: ids.owner } as Actor)
    : options.actor;
  const writes: Record<string, unknown>[] = [];
  const rows = (table: unknown): unknown[] => {
    if (table === encryptionTransitionPolicy) return [policyRow];
    if (table === tasks) {
      return [{
        ...taskRow,
        promptIsEmpty: taskRow.prompt === "",
        expectedOutputIsNull: taskRow.expectedOutput === null,
        lastErrorIsNull: taskRow.lastError === null,
      }];
    }
    if (table === taskRuns) {
      return [{
        ...runRow,
        resultTextIsNull: runRow.resultText === null,
        resultTextIsCancelled:
          runRow.resultText === PROTECTED_TASK_CANCELLED_RESULT,
        lastErrorIsNull: runRow.lastError === null,
      }];
    }
    if (table === protectedTaskRunOutputBindings) return [bindingRow];
    if (table === taskDefinitionCryptoRevisions) return [definitionRow];
    if (table === taskRunResultCryptoRevisions) return [reservationRow];
    if (table === actors) return actorRow ? [actorRow] : [];
    throw new Error("unexpected product table");
  };
  const tx = {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (_kind: string) => rows(table),
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table !== taskRuns) throw new Error("unexpected product update");
            writes.push(patch);
            runRow = { ...runRow, ...patch } as TaskRun;
            return [{ id: runRow.id }];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) => {
      const before = runRow;
      try {
        return await operation(tx);
      } catch (error) {
        runRow = before;
        writes.length = 0;
        throw error;
      }
    },
  } as unknown as DirectDatabase;
  return {
    db,
    writes,
    run: () => runRow,
  };
}

function productInput(representation: "protected" | "dual") {
  return {
    intent: intent(representation),
    prepared: {
      operationId: protectedTaskRunCancelledResultOperationId(ids.run),
      resultRevision: 2 as const,
      resultObjectId: protectedTaskRunCancelledResultObjectId(ids.task, ids.run),
      requesterHumanId: ids.human,
      authorityFingerprint,
    },
    requestDigest,
  } as const;
}

describe("protected Task cancellation product callback", () => {
  test("publishes immutable old-policy intent under an explicit newer same-mode fence", async () => {
    const fixture = productHarness({ representation: "protected", policyRevision: 10 });
    expect(await publishProtectedTaskCancellationProduct(
      fixture.db,
      { ...productInput("protected"), currentPolicyRevision: 10 },
      () => Promise.resolve(true),
    )).toEqual({ status: "exact_replay" });
    expect(fixture.writes).toEqual([]);

    const strict = productHarness({ representation: "protected", policyRevision: 10 });
    expect(await publishProtectedTaskCancellationProduct(
      strict.db,
      productInput("protected"),
      () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });

    const crossMode = productHarness({ representation: "protected", policyRevision: 10,
      policyMode: "shadow_encryption" });
    expect(await publishProtectedTaskCancellationProduct(
      crossMode.db,
      { ...productInput("protected"), currentPolicyRevision: 10 },
      () => Promise.resolve(true),
    )).toEqual({ status: "rejected", reason: "authority_changed" });

    expect(publishProtectedTaskCancellationProduct(
      fixture.db,
      { ...productInput("protected"), currentPolicyRevision: 8 },
      () => Promise.resolve(true),
    )).rejects.toThrow("malformed");
  });

  test("writes only the fixed Shadow ordinary result under current authority", async () => {
    const fixture = productHarness({ representation: "dual" });
    let authorityChecks = 0;
    const result = await publishProtectedTaskCancellationProduct(
      fixture.db,
      productInput("dual"),
      transaction => {
        expect(transaction).toBeDefined();
        authorityChecks += 1;
        return Promise.resolve(true);
      },
    );
    expect(result).toEqual({ status: "written" });
    expect(authorityChecks).toBe(2);
    expect(fixture.writes).toEqual([{
      resultText: PROTECTED_TASK_CANCELLED_RESULT,
      lastError: null,
    }]);
    expect(fixture.run().status).toBe("cancelled");
  });

  test("rolls back the Shadow write when authority changes after it", async () => {
    const fixture = productHarness({ representation: "dual" });
    let authorityChecks = 0;
    expect(await publishProtectedTaskCancellationProduct(
      fixture.db,
      productInput("dual"),
      () => Promise.resolve(++authorityChecks === 1),
    )).toEqual({ status: "rejected", reason: "authority_changed" });
    expect(authorityChecks).toBe(2);
    expect(fixture.writes).toEqual([]);
    expect(fixture.run().resultText).toBeNull();
  });

  test("keeps Full plaintext empty and accepts an exact mapped replay", async () => {
    const resultObjectId = protectedTaskRunCancelledResultObjectId(
      ids.task,
      ids.run,
    );
    for (const runRow of [
      run(),
      run({
        resultRepresentation: "protected",
        resultContentNamespaceId: ids.namespace,
        resultRevision: 2,
        resultCryptoObjectId: resultObjectId,
        resultCryptoAccessRevision: 0,
        resultCryptoRequiredNamespaceFingerprint: new Uint8Array(32),
        resultCryptoMappingState: "verified",
        resultText: null,
        lastError: null,
      }),
    ]) {
      const mapped = runRow.resultRevision === 2;
      const fixture = productHarness({
        representation: "protected",
        run: runRow,
        reservation: resultReservation("protected", mapped ? {
          completion: "complete",
          disposition: "mapped",
        } : {}),
        binding: binding({
          resultRevision: 2,
          resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
          resultObjectId,
          resultTerminalAt: cancelledAt,
          resultAttachedAt: mapped ? cancelledAt : null,
        }),
      });
      expect(await publishProtectedTaskCancellationProduct(
        fixture.db,
        productInput("protected"),
        () => Promise.resolve(true),
      )).toEqual({ status: "exact_replay" });
      expect(fixture.writes).toEqual([]);
      expect(fixture.run().resultText).toBeNull();
    }
  });

  test("rejects substituted digest, reservation owner, and binding", async () => {
    const cases = [
      {
        fixture: productHarness({ representation: "dual" }),
        input: { ...productInput("dual"), requestDigest: new Uint8Array(32) },
      },
      {
        fixture: productHarness({
          representation: "dual",
          actor: null,
        }),
        input: productInput("dual"),
      },
      {
        fixture: productHarness({
          representation: "dual",
          binding: binding({ resultTerminalAt: new Date(0) }),
        }),
        input: productInput("dual"),
      },
    ];
    for (const testCase of cases) {
      let authorityChecks = 0;
      expect(await publishProtectedTaskCancellationProduct(
        testCase.fixture.db,
        testCase.input,
        () => {
          authorityChecks += 1;
          return Promise.resolve(true);
        },
      )).toEqual({ status: "rejected", reason: "conflict" });
      expect(authorityChecks).toBe(0);
      expect(testCase.fixture.writes).toEqual([]);
    }
  });
});
