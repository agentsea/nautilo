import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  listProtectedTaskRunOutputBindingsNeedingDelivery,
  PROTECTED_TASK_OUTPUT_RECOVERY_BATCH_MAX,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunResultOperationId,
  protectedTaskRunWakeJobId,
  protectedTaskRunWakeOperationId,
  recordProtectedTaskRunMessagePublished,
  recordProtectedTaskRunResultAttached,
  recordProtectedTaskRunWakeScheduled,
  type ProtectedTaskRunWakeReferenceV1,
} from "../../src/queries/protected-task-output-bindings";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import {
  sessionMessageCryptoRevisions,
  type SessionMessageCryptoRevision,
} from "../../src/schema/session-message-crypto-revisions";
import {
  sessionMessages,
  sessions,
  type Session,
  type SessionMessage,
} from "../../src/schema/sessions";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
  session: "70000000-0000-4000-8000-000000000007",
};
const terminalAt = new Date("2026-09-29T08:00:00.000Z");
const publishedAt = new Date("2026-09-29T08:00:01.000Z");
const resultObjectId = protectedTaskRunResultObjectId(ids.task, ids.run);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: null,
    resultDelivery: "wake",
    contentRepresentation: "protected",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    status: "completed",
    completedAt: terminalAt,
    resultRepresentation: "protected",
    resultRevision: 1,
    resultCryptoObjectId: resultObjectId,
    resultCryptoMappingState: "verified",
    ...overrides,
  } as TaskRun;
}

function binding(
  overrides: Partial<ProtectedTaskRunOutputBinding> = {},
): ProtectedTaskRunOutputBinding {
  return {
    taskRunId: ids.run,
    bindingId: protectedTaskRunOutputBindingId(ids.run),
    deliveryMode: "none",
    destinationRoomId: null,
    destinationNamespaceId: null,
    resultOperationId: protectedTaskRunResultOperationId(ids.run),
    resultObjectId,
    messageOperationId: null,
    wakeOperationId: null,
    acceptedPolicyRevision: 9,
    acceptedAt: new Date(terminalAt.getTime() - 1000),
    resultTerminalAt: terminalAt,
    resultAttachedAt: null,
    messageId: null,
    messagePublishedAt: null,
    wakeJobId: null,
    wakeScheduledAt: null,
    completedAt: null,
    ...overrides,
  };
}

function harness(rows: Readonly<{
  task: Task;
  run: TaskRun;
  binding: ProtectedTaskRunOutputBinding;
  session?: Session;
  message?: SessionMessage;
  revision?: SessionMessageCryptoRevision;
  job?: Job;
}>) {
  let bindingRow = rows.binding;
  const writes: Array<Record<string, unknown>> = [];
  const records = (table: unknown): unknown[] => {
    if (table === tasks) return [rows.task];
    if (table === taskRuns) return [rows.run];
    if (table === protectedTaskRunOutputBindings) return [bindingRow];
    if (table === sessions) return rows.session ? [rows.session] : [];
    if (table === sessionMessages) return rows.message ? [rows.message] : [];
    if (table === sessionMessageCryptoRevisions) {
      return rows.revision ? [rows.revision] : [];
    }
    if (table === jobs) return rows.job ? [rows.job] : [];
    throw new Error("unexpected table");
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: (_condition: unknown) => query,
          limit: (_limit: number) => query,
          for: async (_kind: string) => records(table),
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_condition: unknown) => ({
          returning: async () => {
            if (table !== protectedTaskRunOutputBindings) {
              throw new Error("unexpected update table");
            }
            writes.push(patch);
            bindingRow = {
              ...bindingRow,
              ...patch,
            } as ProtectedTaskRunOutputBinding;
            return [bindingRow];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async <T>(operation: (value: typeof tx) => Promise<T>) =>
      operation(tx),
  } as unknown as DirectDatabase;
  return { db, writes };
}

describe("protected TaskRun output receipts", () => {
  test("bounds restart reconciliation and includes terminal unattached work", async () => {
    const pending = binding();
    let limit: number | undefined;
    const query = {
      where: (_condition: unknown) => query,
      orderBy: (..._order: unknown[]) => query,
      limit: async (value: number) => {
        limit = value;
        return [pending];
      },
    };
    const db = {
      select: () => ({ from: () => query }),
    } as unknown as DirectDatabase;

    expect(await listProtectedTaskRunOutputBindingsNeedingDelivery(db, 1))
      .toEqual([pending]);
    expect(limit).toBe(1);
    expect(listProtectedTaskRunOutputBindingsNeedingDelivery(
      db,
      PROTECTED_TASK_OUTPUT_RECOVERY_BATCH_MAX + 1,
    )).rejects.toThrow("recovery batch is malformed");
  });

  test("attaches only the verified mapped result and completes no-delivery", async () => {
    const fixture = harness({ task: task(), run: run(), binding: binding() });
    const result = await recordProtectedTaskRunResultAttached(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    });
    expect(result.status).toBe("recorded");
    expect(fixture.writes).toEqual([{
      resultAttachedAt: terminalAt,
      completedAt: terminalAt,
    }]);

    const stale = harness({
      task: task(),
      run: run({ resultCryptoMappingState: "stale" }),
      binding: binding(),
    });
    expect(await recordProtectedTaskRunResultAttached(stale.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    })).toEqual({ status: "rejected", reason: "not_ready" });
    expect(stale.writes).toEqual([]);
  });

  test("accepts only the exact mapped protected Message publication", async () => {
    const messageOperationId = protectedTaskRunMessageOperationId(ids.run);
    const cryptoObjectId = "message:v2:test";
    const taskRow = task({ callingRoomId: ids.room, resultDelivery: "raw" });
    const runRow = run();
    const bindingRow = binding({
      deliveryMode: "raw",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      messageOperationId,
      resultAttachedAt: terminalAt,
    });
    const session = {
        id: ids.session,
        ownerId: ids.owner,
        agentId: ids.agent,
        roomId: ids.room,
      } as Session;
    const message = {
        id: 42,
        sessionId: ids.session,
        role: "assistant",
        content: null,
        toolCalls: null,
        toolName: null,
        cryptoObjectId,
        editRevision: 0,
        createdAt: publishedAt,
      } as SessionMessage;
    const revision = {
        sessionId: ids.session,
        messageId: 42,
        editRevision: 0,
        roomId: ids.room,
        namespaceIdAtAllocation: ids.namespace,
        cryptoObjectId,
        appendIdempotencyKey: messageOperationId,
        representationMode: "full_encryption",
        publicationPolicyRevision: 9,
        payloadVersion: 2,
        keyClass: "ai",
        authorRole: "assistant",
        completion: "complete",
        disposition: "mapped",
        failureCode: null,
        cryptoCompletedAt: publishedAt,
      } as SessionMessageCryptoRevision;
    const fixture = harness({
      task: taskRow,
      run: runRow,
      binding: bindingRow,
      session,
      message,
      revision,
    });
    expect(await recordProtectedTaskRunMessagePublished(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      messageId: 42,
    })).toMatchObject({ status: "recorded" });
    expect(fixture.writes).toEqual([{
      messageId: 42,
      messagePublishedAt: publishedAt,
      completedAt: publishedAt,
    }]);

    for (const substitutedSession of [
      { ...session, ownerId: ids.room },
      { ...session, agentId: ids.room },
    ]) {
      const substituted = harness({
        task: taskRow,
        run: runRow,
        binding: bindingRow,
        session: substitutedSession,
        message,
        revision,
      });
      expect(await recordProtectedTaskRunMessagePublished(substituted.db, {
        taskId: ids.task,
        taskRunId: ids.run,
        messageId: 42,
      })).toEqual({ status: "rejected", reason: "conflict" });
      expect(substituted.writes).toEqual([]);
    }
  });

  test("records only the deterministic content-free wake Job", async () => {
    const wakeJobId = protectedTaskRunWakeJobId(ids.run);
    const wakeOperationId = protectedTaskRunWakeOperationId(ids.run);
    const wakeReference: ProtectedTaskRunWakeReferenceV1 = {
      kind: "protected_task_delivery_v1",
      bindingId: protectedTaskRunOutputBindingId(ids.run),
      taskId: ids.task,
      taskRunId: ids.run,
      resultObjectId,
      wakeOperationId,
    };
    const fixture = harness({
      task: task({ callingRoomId: ids.room, resultDelivery: "wake" }),
      run: run(),
      binding: binding({
        deliveryMode: "wake",
        destinationRoomId: ids.room,
        destinationNamespaceId: ids.namespace,
        wakeOperationId,
        resultAttachedAt: terminalAt,
      }),
      job: {
        id: wakeJobId,
        ownerId: ids.owner,
        requestorId: ids.owner,
        roomId: ids.room,
        laneKey: `room:${ids.room}`,
        type: "foreground",
        status: "queued",
        input: wakeReference,
        result: null,
        message: null,
        metadata: {},
        createdAt: publishedAt,
        startedAt: null,
        completedAt: null,
      } as Job,
    });
    expect(await recordProtectedTaskRunWakeScheduled(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      wakeJobId,
    })).toMatchObject({ status: "recorded" });
    expect(fixture.writes).toEqual([{
      wakeJobId,
      wakeScheduledAt: publishedAt,
      completedAt: publishedAt,
    }]);
  });
});
