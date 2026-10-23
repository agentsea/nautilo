import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  assertVerifiedProtectedTaskWakeContinuation,
  parkProtectedTaskWakeContinuation,
  withCurrentProtectedTaskWakeContinuation,
  type ParkProtectedTaskWakeContinuationInput,
  type VerifiedProtectedTaskWakeContinuation,
} from "../../src/queries/protected-task-wake-continuation";
import { protectedTaskSemanticAuthorityRequirementsDigest } from
  "../../src/queries/protected-task-execution-receipts";
import {
  protectedTaskRunOutputBindingId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
} from "../../src/queries/protected-task-output-binding-identities";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import {
  protectedTaskWakeContinuationReceipts,
  type ProtectedTaskWakeContinuationReceipt,
} from "../../src/schema/protected-task-wake-continuation-receipts";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  source: "50000000-0000-4000-8000-000000000005",
  destination: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
};
const jobId = protectedTaskRunWakeJobId(ids.run);
const digest = (seed: number) => Uint8Array.from(
  { length: 32 },
  (_, index) => (seed + index) % 256,
);
const semantic = Object.freeze([
  Object.freeze({ namespaceId: ids.source, operations: Object.freeze(["decrypt"] as const) }),
  Object.freeze({ namespaceId: ids.destination, operations: Object.freeze(["encrypt"] as const) }),
]);

function task(): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    contentRepresentation: "protected",
    contentNamespaceId: ids.source,
    contentRevision: 1,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoMappingState: "verified",
  } as Task;
}

function run(): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    status: "completed",
    completedAt: new Date("2026-10-12T10:00:00.000Z"),
    resultRepresentation: "protected",
    resultRevision: 1,
    resultContentNamespaceId: ids.source,
    resultCryptoObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    resultCryptoMappingState: "verified",
  } as TaskRun;
}

function binding(): ProtectedTaskRunOutputBinding {
  const completed = new Date("2026-10-12T10:00:01.000Z");
  return {
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    deliveryMode: "wake",
    destinationRoomId: ids.room,
    destinationNamespaceId: ids.source,
    resultRevision: 1,
    resultOperationId: `task-run-result:${ids.run}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    messageOperationId: null,
    wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    acceptedPolicyRevision: 7,
    acceptedAt: completed,
    resultTerminalAt: completed,
    resultAttachedAt: completed,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: jobId,
    wakeScheduledAt: completed,
    completedAt: completed,
  };
}

function job(status: "running" | "queued" = "running"): Job {
  return {
    id: jobId,
    ownerId: ids.owner,
    requestorId: ids.owner,
    laneKey: `room:${ids.room}`,
    roomId: ids.room,
    type: "foreground",
    status,
    input: {
      kind: "protected_task_delivery_v1",
      bindingId: protectedTaskRunOutputBindingId(ids.run),
      taskId: ids.task,
      taskRunId: ids.run,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    },
    result: null,
    message: null,
    createdAt: new Date("2026-10-12T10:00:01.000Z"),
    startedAt: status === "running"
      ? new Date("2026-10-12T10:00:02.000Z") : null,
    completedAt: null,
    metadata: {},
  };
}

function input(
  overrides: Partial<ParkProtectedTaskWakeContinuationInput> = {},
): ParkProtectedTaskWakeContinuationInput {
  return {
    wakeJobId: jobId,
    taskId: ids.task,
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    priorRecipientGeneration: 2,
    wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
    additionalAuthorizationRequestId: "task.memory.projection:request-1",
    interruptId: "interrupt:additional:1",
    operationId: "memory:projection:1",
    requestDigest: digest(1),
    requiredAuthorityDigest:
      protectedTaskSemanticAuthorityRequirementsDigest(semantic),
    semanticAuthorityRequirements: semantic,
    retainedSourceNamespaceIds: [ids.source],
    sourceEnvelopeDigest: digest(2),
    initialPolicyRevision: 7,
    initialAgentAuthorizationRevision: 9,
    destinationRoomId: ids.room,
    destinationNamespaceId: ids.destination,
    destinationAuthorityDigest: digest(3),
    checkpointThreadId: `protected-task-wake:${jobId}`,
    checkpoint: {
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: digest(4),
      expectedBlobCount: 2,
      blobOrderedDigest: digest(5),
      expectedPendingWriteCount: 1,
      pendingWriteOrderedDigest: digest(6),
    },
    sealedAt: new Date("2026-10-12T10:00:03.000Z"),
    ...overrides,
  };
}

function harness(options: Readonly<{
  job?: Job;
  receipt?: ProtectedTaskWakeContinuationReceipt;
  receiptReads?: readonly (readonly ProtectedTaskWakeContinuationReceipt[])[];
  loseJobTransition?: boolean;
}> = {}) {
  const rows = new Map<unknown, unknown[]>([
    [tasks, [task()]],
    [taskRuns, [run()]],
    [protectedTaskRunOutputBindings, [binding()]],
    [jobs, [options.job ?? job()]],
    [protectedTaskWakeContinuationReceipts,
      options.receipt === undefined ? [] : [options.receipt]],
  ]);
  const selected: unknown[] = [];
  const locks: unknown[] = [];
  const mutations: Array<{ table: unknown; locks: unknown[] }> = [];
  let receiptRead = 0;
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        selected.push(table);
        const readRows = () => table === protectedTaskWakeContinuationReceipts
            && options.receiptReads !== undefined
          ? [...(options.receiptReads[receiptRead++] ?? [])]
          : rows.get(table) ?? [];
        const query = {
          where: (_condition: unknown) => query,
          orderBy: (_order: unknown) => query,
          limit: (_limit: number) => query,
          for: async (_kind: string) => {
            if (table === protectedTaskWakeContinuationReceipts) {
              throw new Error("append-only receipt role has no UPDATE privilege for row locking");
            }
            locks.push(table);
            return readRows();
          },
          then: (
            resolve: (value: unknown[]) => unknown,
            reject?: (error: unknown) => unknown,
          ) => Promise.resolve(readRows()).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            mutations.push({ table, locks: [...locks] });
            if ((rows.get(table) ?? []).length !== 0) return [];
            rows.set(table, [value]);
            return [value];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table === jobs && options.loseJobTransition === true) return [];
            const current = rows.get(table)?.[0];
            if (typeof current !== "object" || current === null) return [];
            const updated = { ...current, ...patch };
            rows.set(table, [updated]);
            return [updated];
          },
        }),
      }),
    }),
  } as unknown as Parameters<typeof parkProtectedTaskWakeContinuation>[0];
  return { tx, rows, selected, locks, mutations };
}

describe("protected Task wake continuation", () => {
  test("atomically seals the receipt and returns only the wake Job to queued", async () => {
    const h = harness();
    const result = await parkProtectedTaskWakeContinuation(h.tx, input());
    expect(result.status).toBe("parked");
    expect(h.mutations).toEqual([{ table: protectedTaskWakeContinuationReceipts,
      locks: [tasks, taskRuns, protectedTaskRunOutputBindings, jobs] }]);
    expect(h.locks).toEqual([tasks, taskRuns, protectedTaskRunOutputBindings, jobs]);
    expect(result.status === "parked" && result.receipt.segment).toBe(3);
    expect((h.rows.get(jobs)?.[0] as Job).status).toBe("queued");
    expect((h.rows.get(jobs)?.[0] as Job).startedAt).toBeNull();
    expect((h.rows.get(taskRuns)?.[0] as TaskRun).status).toBe("completed");
  });

  test("adopts exact replay and rejects a corrupted immutable digest", async () => {
    const first = harness();
    const created = await parkProtectedTaskWakeContinuation(first.tx, input());
    expect(created.status).toBe("parked");
    if (created.status !== "parked") throw new Error("receipt missing");
    const replay = harness({ job: job("queued"), receipt: created.receipt });
    expect((await parkProtectedTaskWakeContinuation(replay.tx, input())).status)
      .toBe("exact_replay");
    const corrupt = harness({
      job: job("queued"),
      receipt: { ...created.receipt, destinationAuthorityDigest: digest(91) },
    });
    expect((await parkProtectedTaskWakeContinuation(corrupt.tx, input())).status)
      .toBe("stale");
  });

  test("replays and reproves JSONB receipts independently of object key order", async () => {
    const created = await parkProtectedTaskWakeContinuation(harness().tx, input());
    if (created.status !== "parked") throw new Error("receipt missing");
    const stored = {
      ...created.receipt,
      semanticAuthorityRequirements: created.receipt.semanticAuthorityRequirements
        .map(requirement => ({
          operations: requirement.operations,
          namespaceId: requirement.namespaceId,
        })),
    };
    expect(JSON.stringify(stored.semanticAuthorityRequirements))
      .not.toBe(JSON.stringify(created.receipt.semanticAuthorityRequirements));
    expect((await parkProtectedTaskWakeContinuation(harness({
      job: job("queued"), receipt: stored,
    }).tx, input())).status).toBe("exact_replay");
    const coordinates = {
      wakeJobId: jobId,
      segment: 3,
      wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
      priorRecipientGeneration: 2,
      jobState: "queued" as const,
    };
    expect(await withCurrentProtectedTaskWakeContinuation(harness({
      job: job("queued"),
      receiptReads: [[stored], [stored], []],
    }).tx, coordinates, async proof => {
      await proof.assertCurrent();
      return "held";
    })).toBe("held");
    for (const semanticAuthorityRequirements of [
      stored.semanticAuthorityRequirements.map(requirement => ({
        ...requirement, extra: true,
      })),
      stored.semanticAuthorityRequirements.map(requirement => ({
        ...requirement, operations: ["decrypt"] as const,
      })),
      [...stored.semanticAuthorityRequirements].reverse(),
    ]) {
      expect(await withCurrentProtectedTaskWakeContinuation(harness({
        job: job("queued"),
        receiptReads: [[stored], [{ ...stored, semanticAuthorityRequirements }]],
      }).tx, coordinates, async () => "wrong")).toBeNull();
    }
  });

  test("requires decrypt sources to be retained and destination to be encrypt-only", async () => {
    const h = harness();
    expect(() => parkProtectedTaskWakeContinuation(h.tx, input({
      retainedSourceNamespaceIds: [ids.destination],
    }))).toThrow("continuation input is invalid");
    expect(() => parkProtectedTaskWakeContinuation(h.tx, input({
      semanticAuthorityRequirements: Object.freeze([
        semantic[0]!,
        Object.freeze({
          namespaceId: ids.destination,
          operations: Object.freeze(["decrypt", "encrypt"] as const),
        }),
      ]),
    }))).toThrow();
    expect(() => parkProtectedTaskWakeContinuation(h.tx, input({
      destinationNamespaceId: ids.source,
    }))).toThrow("continuation input is invalid");
    expect(() => parkProtectedTaskWakeContinuation(h.tx, input({
      semanticAuthorityRequirements: Object.freeze([
        Object.freeze({
          namespaceId: ids.source,
          operations: Object.freeze(["decrypt", "encrypt"] as const),
        }),
        semantic[1]!,
      ]),
    }))).toThrow("continuation input is invalid");
  });

  test("throws after an inserted receipt if the locked Job transition is lost", async () => {
    const h = harness({ loseJobTransition: true });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(parkProtectedTaskWakeContinuation(h.tx, input()))
      .rejects.toThrow("lost its locked Job transition");
  });

  test("current proof stays inside callback and exact generation", async () => {
    const first = harness();
    const created = await parkProtectedTaskWakeContinuation(first.tx, input());
    if (created.status !== "parked") throw new Error("receipt missing");
    const current = harness({
      job: job("queued"),
      receipt: created.receipt,
      receiptReads: [[created.receipt], [created.receipt], []],
    });
    let escaped: VerifiedProtectedTaskWakeContinuation | undefined;
    const value = await withCurrentProtectedTaskWakeContinuation(
      current.tx,
      {
        wakeJobId: jobId,
        segment: 3,
        wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
        priorRecipientGeneration: 2,
        jobState: "queued",
      },
      async proof => {
        escaped = proof;
        expect(proof.priorReceipt).toBeNull();
        expect(() => assertVerifiedProtectedTaskWakeContinuation(proof))
          .not.toThrow();
        expect(() => assertVerifiedProtectedTaskWakeContinuation({
          receipt: proof.receipt,
          priorReceipt: proof.priorReceipt,
          assertCurrent: proof.assertCurrent,
        })).toThrow("not current");
        expect(() => assertVerifiedProtectedTaskWakeContinuation({ ...proof }))
          .toThrow("not current");
        const first = proof.receipt.requestDigest[0]!;
        proof.receipt.requestDigest[0] = first ^ 0xff;
        expect(() => assertVerifiedProtectedTaskWakeContinuation(proof))
          .toThrow("mutated");
        proof.receipt.requestDigest[0] = first;
        await proof.assertCurrent();
        return "held";
      },
    );
    expect(value).toBe("held");
    expect(current.locks).toEqual([tasks, taskRuns, protectedTaskRunOutputBindings, jobs]);
    expect(escaped).toBeDefined();
    expect(() => assertVerifiedProtectedTaskWakeContinuation(escaped))
      .toThrow("not current");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(escaped!.assertCurrent()).rejects.toThrow("not current");
    expect(await withCurrentProtectedTaskWakeContinuation(
      harness({
        job: job("queued"),
        receipt: created.receipt,
        receiptReads: [[created.receipt]],
      }).tx,
      {
        wakeJobId: jobId,
        segment: 4,
        wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
        priorRecipientGeneration: 3,
        jobState: "queued",
      },
      async () => "wrong",
    )).toBeNull();
    const malformed = harness({
      job: job("queued"),
      receipt: { ...created.receipt, requiredAuthorityDigest: digest(90) },
      receiptReads: [[{
        ...created.receipt,
        requiredAuthorityDigest: digest(90),
      }]],
    });
    expect(await withCurrentProtectedTaskWakeContinuation(
      malformed.tx,
      {
        wakeJobId: jobId,
        segment: 3,
        wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
        priorRecipientGeneration: 2,
        jobState: "queued",
      },
      async () => "malformed",
    )).toBeNull();
  });

  test("binds the newest prior receipt and detects mutable snapshot tampering", async () => {
    const priorStore = harness();
    const prior = await parkProtectedTaskWakeContinuation(priorStore.tx, input({
      priorRecipientGeneration: 0,
      additionalAuthorizationRequestId: "task.memory.projection:request-0",
      interruptId: "interrupt:additional:0",
      operationId: "memory:projection:0",
      requestDigest: digest(11),
      destinationAuthorityDigest: digest(12),
      sealedAt: new Date("2026-10-12T10:00:02.500Z"),
    }));
    const latestStore = harness();
    const latest = await parkProtectedTaskWakeContinuation(latestStore.tx, input());
    if (prior.status !== "parked" || latest.status !== "parked") {
      throw new Error("receipt fixture missing");
    }
    const held = harness({
      job: job("queued"),
      receipt: latest.receipt,
      receiptReads: [[latest.receipt], [latest.receipt], [prior.receipt]],
    });
    let captured: VerifiedProtectedTaskWakeContinuation | undefined;
    expect(await withCurrentProtectedTaskWakeContinuation(
      held.tx,
      {
        wakeJobId: jobId,
        segment: 3,
        wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
        priorRecipientGeneration: 2,
        jobState: "queued",
      },
      async proof => {
        captured = proof;
        expect(proof.priorReceipt?.segment).toBe(1);
        const first = proof.priorReceipt!.sourceEnvelopeDigest[0]!;
        proof.priorReceipt!.sourceEnvelopeDigest[0] = first ^ 0xff;
        expect(() => assertVerifiedProtectedTaskWakeContinuation(proof))
          .toThrow("mutated");
        proof.priorReceipt!.sourceEnvelopeDigest[0] = first;
        assertVerifiedProtectedTaskWakeContinuation(proof);
        return "held";
      },
    )).toBe("held");
    expect(captured).toBeDefined();
    expect(held.selected.slice(-6)).toEqual([
      tasks,
      taskRuns,
      protectedTaskRunOutputBindings,
      jobs,
      protectedTaskWakeContinuationReceipts,
      protectedTaskWakeContinuationReceipts,
    ]);

    const changedPrior = {
      ...prior.receipt,
      sourceEnvelopeDigest: digest(99),
    };
    expect(await withCurrentProtectedTaskWakeContinuation(
      harness({
        job: job("queued"),
        receipt: latest.receipt,
        receiptReads: [[latest.receipt], [latest.receipt], [changedPrior]],
      }).tx,
      {
        wakeJobId: jobId,
        segment: 3,
        wakeAuthorizationRequestId: `task-wake-authorization:${jobId}`,
        priorRecipientGeneration: 2,
        jobState: "queued",
      },
      async () => "wrong",
    )).toBeNull();
  });
});

void ({} as DirectDatabase);


test("latest receipt advancement before canonical locks is rejected after the locked reread", async () => {
  const priorStore = harness();
  const prior = await parkProtectedTaskWakeContinuation(priorStore.tx, input());
  const latestStore = harness();
  const latest = await parkProtectedTaskWakeContinuation(latestStore.tx, input({ priorRecipientGeneration: 3 }));
  if (prior.status !== "parked" || latest.status !== "parked") throw new Error("receipt fixture missing");
  const h = harness({ job: job("queued"), receiptReads: [[prior.receipt], [latest.receipt]] });
  let used = false;
  expect(await withCurrentProtectedTaskWakeContinuation(h.tx, {
    wakeJobId: jobId, segment: prior.receipt.segment,
    wakeAuthorizationRequestId: prior.receipt.wakeAuthorizationRequestId,
    priorRecipientGeneration: prior.receipt.priorRecipientGeneration, jobState: "queued",
  }, async () => { used = true; return true; })).toBeNull();
  expect(used).toBe(false);
  expect(h.locks).toEqual([tasks, taskRuns, protectedTaskRunOutputBindings, jobs]);
  expect(h.mutations).toEqual([]);
});
