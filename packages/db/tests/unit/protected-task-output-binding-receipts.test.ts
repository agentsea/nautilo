import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  createOfflineDirectDb,
  type DirectDatabase,
} from "../../src/config/direct-database";
import {
  listProtectedTaskRunOutputBindingsNeedingDelivery,
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
import {
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunCancelledResultOperationId,
} from "../../src/queries/protected-task-output-binding-identities";
import { PROTECTED_TASK_CANCELLED_RESULT } from
  "../../src/queries/protected-task-cancellation-output";
import { jobs, type Job } from "../../src/schema/jobs";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import { rooms, type Room } from "../../src/schema/rooms";
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
import {
  taskRunMessageAssociations,
  type TaskRunMessageAssociation,
} from "../../src/schema/task-run-message-associations";
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
  destinationOwner: "80000000-0000-4000-8000-000000000008",
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
    fundingMode: "legacy_server",
    contentRepresentation: "protected",
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    status: "completed",
    fundingBinding: null,
    fundingPredecessorRunId: null,
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
    resultRevision: 1,
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
  room?: Room;
  session?: Session;
  message?: SessionMessage;
  revision?: SessionMessageCryptoRevision;
  associations?: readonly TaskRunMessageAssociation[];
  job?: Job;
}>) {
  let bindingRow = rows.binding;
  const writes: Array<Record<string, unknown>> = [];
  const records = (table: unknown): unknown[] => {
    if (table === tasks) return [rows.task];
    if (table === taskRuns) return [rows.run];
    if (table === protectedTaskRunOutputBindings) return [bindingRow];
    if (table === rooms) return rows.room ? [rows.room] : [];
    if (table === sessions) return rows.session ? [rows.session] : [];
    if (table === sessionMessages) return rows.message ? [rows.message] : [];
    if (table === sessionMessageCryptoRevisions) {
      return rows.revision ? [rows.revision] : [];
    }
    if (table === taskRunMessageAssociations) {
      return [...(rows.associations ?? [])];
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
          for: async (_kind: string) => {
            if (table === taskRunMessageAssociations) throw new Error("Append-only receipt cannot be row-locked");
            return records(table);
          },
          then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve(records(table)).then(resolve, reject),
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

function messagePublicationRows(options: Readonly<{
  representation?: "protected" | "dual";
  publicationPolicyRevision?: number | null;
  sessionAgentId?: string;
  associations?: readonly TaskRunMessageAssociation[];
  bindingOverrides?: Partial<ProtectedTaskRunOutputBinding>;
}> = {}) {
  const representation = options.representation ?? "protected";
  const messageOperationId = protectedTaskRunMessageOperationId(ids.run);
  const cryptoObjectId = "message:v2:test";
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
  const association = {
    taskRunId: ids.run,
    sessionId: ids.session,
    messageId: message.id,
    publishedRevision: message.editRevision,
    kind: "raw_delivery",
    publicationKey: messageOperationId,
    createdAt: publishedAt,
  } as TaskRunMessageAssociation;
  return {
    task: task({
      callingRoomId: ids.room,
      resultDelivery: "raw",
      contentRepresentation: representation,
    }),
    run: run({ resultRepresentation: representation }),
    binding: binding({
      deliveryMode: "raw",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      messageOperationId,
      resultAttachedAt: terminalAt,
      ...options.bindingOverrides,
    }),
    room: {
      id: ids.room,
      ownerId: ids.destinationOwner,
      type: "dm",
      namespaceId: ids.namespace,
    } as Room,
    session: {
      id: ids.session,
      ownerId: ids.destinationOwner,
      agentId: options.sessionAgentId ?? ids.agent,
      roomId: ids.room,
    } as Session,
    message,
    revision: {
      sessionId: ids.session,
      messageId: message.id,
      editRevision: message.editRevision,
      roomId: ids.room,
      namespaceIdAtAllocation: ids.namespace,
      cryptoObjectId,
      appendIdempotencyKey: messageOperationId,
      representationMode: representation === "dual"
        ? "shadow_encryption"
        : "full_encryption",
      publicationPolicyRevision: options.publicationPolicyRevision === undefined
        ? representation === "dual" ? null : 9
        : options.publicationPolicyRevision,
      payloadVersion: 2,
      keyClass: "ai",
      authorRole: "assistant",
      completion: "complete",
      disposition: "mapped",
      failureCode: null,
      cryptoCompletedAt: publishedAt,
    } as SessionMessageCryptoRevision,
    associations: options.associations ?? [association],
    association,
  };
}

describe("protected TaskRun output receipts", () => {
  test("uses the caller's restart reconciliation batch and includes terminal unattached work", async () => {
    const pending = binding();
    let limit: number | undefined;
    let predicate: SQL | undefined;
    const offline = createOfflineDirectDb();
    const query = {
      where: (condition: SQL) => {
        predicate = condition;
        return query;
      },
      orderBy: (..._order: unknown[]) => query,
      limit: async (value: number) => {
        limit = value;
        return [pending];
      },
    };
    const db = {
      select: (projection?: Record<string, SQL>) => projection === undefined
        ? { from: () => query }
        : offline.select(projection),
    } as unknown as DirectDatabase;

    expect(await listProtectedTaskRunOutputBindingsNeedingDelivery(db, 1))
      .toEqual([pending]);
    expect(limit).toBe(1);
    expect(await listProtectedTaskRunOutputBindingsNeedingDelivery(db, 33))
      .toEqual([pending]);
    expect(limit).toBe(33);
    const compiled = new PgDialect().sqlToQuery(predicate!);
    expect(compiled.sql).toContain("not exists");
    expect(compiled.sql).toContain('inner join "jobs"');
    expect(compiled.sql).toContain(
      'inner join "task_run_result_crypto_revisions"',
    );
    expect(compiled.sql).not.toContain("jsonb_build_object");
    expect(compiled.sql).toContain('"result_attached_at" is null');
    for (const value of [
      "nautilo.protectedTaskRunTerminal.v1",
      "protected_task_run_v1",
      "failed",
      "quarantined",
      "retry_exhausted",
    ]) expect(compiled.params).toContain(value);
    expect(listProtectedTaskRunOutputBindingsNeedingDelivery(db, -1))
      .rejects.toThrow("recovery batch is malformed");
  });

  test("attaches only the verified mapped result and leaves final settlement discoverable", async () => {
    const fixture = harness({ task: task(), run: run(), binding: binding() });
    const result = await recordProtectedTaskRunResultAttached(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    });
    expect(result.status).toBe("recorded");
    expect(fixture.writes).toEqual([{
      resultAttachedAt: terminalAt,
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

  test("attaches only the exact mapped cancellation result at its Stop timestamp", async () => {
    const cancelledObjectId = protectedTaskRunCancelledResultObjectId(
      ids.task,
      ids.run,
    );
    const fixture = harness({
      task: task({ status: "cancelled", cancelledAt: terminalAt }),
      run: run({
        status: "cancelled",
        completedAt: terminalAt,
        resultText: null,
        lastError: null,
        resultRepresentation: "protected",
        resultRevision: 2,
        resultCryptoObjectId: cancelledObjectId,
      }),
      binding: binding({
        resultRevision: 2,
        resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
        resultObjectId: cancelledObjectId,
      }),
    });
    expect(await recordProtectedTaskRunResultAttached(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    })).toMatchObject({ status: "recorded" });
    expect(fixture.writes).toEqual([{ resultAttachedAt: terminalAt }]);

    const wrongShadow = harness({
      task: task({
        status: "cancelled",
        cancelledAt: terminalAt,
        contentRepresentation: "dual",
      }),
      run: run({
        status: "cancelled",
        completedAt: terminalAt,
        resultText: "different",
        lastError: null,
        resultRepresentation: "dual",
        resultRevision: 2,
        resultCryptoObjectId: cancelledObjectId,
      }),
      binding: binding({
        resultRevision: 2,
        resultOperationId: protectedTaskRunCancelledResultOperationId(ids.run),
        resultObjectId: cancelledObjectId,
      }),
    });
    expect(await recordProtectedTaskRunResultAttached(wrongShadow.db, {
      taskId: ids.task,
      taskRunId: ids.run,
    })).toEqual({ status: "rejected", reason: "not_ready" });
    expect(wrongShadow.writes).toEqual([]);
    expect(PROTECTED_TASK_CANCELLED_RESULT).toBe("Task cancelled");
  });

  test("accepts a peer-owned destination Message independently of the requester", async () => {
    const rows = messagePublicationRows();
    expect(rows.task.ownerId).toBe(rows.task.requestorId);
    expect(rows.task.requestorId).not.toBe(rows.room.ownerId);
    expect(rows.session.ownerId).toBe(rows.room.ownerId);
    const fixture = harness(rows);
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

    const substituted = harness(messagePublicationRows({
      sessionAgentId: ids.room,
    }));
    expect(await recordProtectedTaskRunMessagePublished(substituted.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      messageId: 42,
    })).toEqual({ status: "rejected", reason: "conflict" });
    expect(substituted.writes).toEqual([]);
  });

  test("binds publication policy revision to the representation mode", async () => {
    for (const scenario of [
      {
        name: "Full exact revision",
        rows: messagePublicationRows({ publicationPolicyRevision: 9 }),
        status: "recorded",
      },
      {
        name: "Full later compatible publication",
        rows: messagePublicationRows({ publicationPolicyRevision: 10 }),
        status: "recorded",
      },
      {
        name: "Full older publication revision",
        rows: messagePublicationRows({ publicationPolicyRevision: 8 }),
        status: "rejected",
      },
      {
        name: "Full missing publication revision",
        rows: messagePublicationRows({ publicationPolicyRevision: null }),
        status: "rejected",
      },
      {
        name: "Shadow null revision",
        rows: messagePublicationRows({
          representation: "dual",
          publicationPolicyRevision: null,
        }),
        status: "recorded",
      },
      {
        name: "Shadow populated revision",
        rows: messagePublicationRows({
          representation: "dual",
          publicationPolicyRevision: 9,
        }),
        status: "rejected",
      },
    ] as const) {
      const fixture = harness(scenario.rows);
      const result = await recordProtectedTaskRunMessagePublished(fixture.db, {
        taskId: ids.task,
        taskRunId: ids.run,
        messageId: 42,
      });
      expect(result.status, scenario.name).toBe(scenario.status);
      expect(fixture.writes.length, scenario.name).toBe(
        scenario.status === "recorded" ? 1 : 0,
      );
    }
  });

  test("requires the exact raw-delivery TaskRun Message association", async () => {
    const exact = messagePublicationRows();
    for (const scenario of [
      {
        name: "missing association",
        rows: messagePublicationRows({ associations: [] }),
      },
      {
        name: "wrong association kind",
        rows: messagePublicationRows({
          associations: [{ ...exact.association, kind: "transcript" }],
        }),
      },
      {
        name: "wrong association publication key",
        rows: messagePublicationRows({
          associations: [{
            ...exact.association,
            publicationKey: "wrong-publication",
          }],
        }),
      },
    ]) {
      const fixture = harness(scenario.rows);
      expect(await recordProtectedTaskRunMessagePublished(fixture.db, {
        taskId: ids.task,
        taskRunId: ids.run,
        messageId: 42,
      }), scenario.name).toEqual({ status: "rejected", reason: "conflict" });
      expect(fixture.writes, scenario.name).toEqual([]);
    }
  });

  test("replays the same Message receipt and rejects a conflicting receipt", async () => {
    const replayRows = messagePublicationRows({
      bindingOverrides: {
        messageId: 42,
        messagePublishedAt: publishedAt,
        completedAt: publishedAt,
      },
    });
    const replay = harness(replayRows);
    expect(await recordProtectedTaskRunMessagePublished(replay.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      messageId: 42,
    })).toMatchObject({ status: "exact_replay" });
    expect(replay.writes).toEqual([]);

    const conflict = harness(replayRows);
    expect(await recordProtectedTaskRunMessagePublished(conflict.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      messageId: 43,
    })).toEqual({ status: "rejected", reason: "conflict" });
    expect(conflict.writes).toEqual([]);
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


test("a Full Message receipt preserves retained dual definition and result siblings", async () => {
  const rows = messagePublicationRows({ publicationPolicyRevision: 10 });
  const retained = { ...rows,
    task: { ...rows.task, contentRepresentation: "dual" as const, prompt: "old prompt" },
    run: { ...rows.run, resultRepresentation: "dual" as const, resultText: "old result" },
  };
  const f = harness(retained);
  expect((await recordProtectedTaskRunMessagePublished(f.db, {
    taskId: ids.task, taskRunId: ids.run, messageId: 42,
  })).status).toBe("recorded");
  expect(retained.run.resultText).toBe("old result");
  expect(retained.task.prompt).toBe("old prompt");
  const shadow = messagePublicationRows({ representation: "dual", publicationPolicyRevision: null });
  const downgrade = harness({ ...shadow,
    task: task(), run: run(),
  });
  expect((await recordProtectedTaskRunMessagePublished(downgrade.db, {
    taskId: ids.task, taskRunId: ids.run, messageId: 42,
  })).status).toBe("rejected");
  expect(downgrade.writes).toEqual([]);
});
