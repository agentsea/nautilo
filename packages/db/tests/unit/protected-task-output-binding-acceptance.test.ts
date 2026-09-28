import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  acceptProtectedTaskRunOutputBinding,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
  protectedTaskRunResultObjectId,
  protectedTaskRunWakeOperationId,
} from "../../src/queries/protected-task-output-bindings";
import {
  encryptionTransitionPolicy,
  type EncryptionTransitionPolicyRow,
} from "../../src/schema/encryption-transition";
import {
  protectedTaskRunOutputBindings,
  type ProtectedTaskRunOutputBinding,
} from "../../src/schema/protected-task-run-output-bindings";
import { rooms, type Room } from "../../src/schema/rooms";
import { taskRuns, type TaskRun } from "../../src/schema/task-runs";
import { tasks, type Task } from "../../src/schema/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  owner: "30000000-0000-4000-8000-000000000003",
  agent: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
};
const acceptedAt = new Date("2026-09-29T08:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: null,
    resultDelivery: "wake",
    scheduleKind: "one_shot",
    status: "awaiting",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 1,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 0,
    cryptoRequiredNamespaceFingerprint: new Uint8Array(32),
    cryptoMappingState: "verified",
    lastError: null,
    ...overrides,
  } as Task;
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: null,
    status: "awaiting",
    completedAt: null,
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

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: ids.room,
    namespaceId: ids.namespace,
    ...overrides,
  } as Room;
}

function harness(options: Readonly<{
  task?: Task;
  run?: TaskRun;
  policy?: EncryptionTransitionPolicyRow;
  room?: Room | null;
  binding?: ProtectedTaskRunOutputBinding;
}> = {}) {
  const taskRow = options.task ?? task();
  const runRow = options.run ?? run();
  const policyRow = options.policy ?? policy();
  const roomRow = options.room === undefined ? room() : options.room;
  let bindingRow = options.binding;
  const inserts: Array<Record<string, unknown>> = [];
  const locks: Array<{ table: unknown; kind: string }> = [];
  const rows = (table: unknown): unknown[] => {
    if (table === tasks) return [taskRow];
    if (table === taskRuns) return [runRow];
    if (table === encryptionTransitionPolicy) return [policyRow];
    if (table === rooms) return roomRow === null ? [] : [roomRow];
    if (table === protectedTaskRunOutputBindings) {
      return bindingRow ? [bindingRow] : [];
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
        };
        return query;
      },
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
  return { db, inserts, locks };
}

describe("protected TaskRun output binding acceptance", () => {
  test("accepts and replays a content-free no-delivery binding", async () => {
    const fixture = harness();
    const input = {
      taskId: ids.task,
      taskRunId: ids.run,
      requiredPolicyRevision: 9,
      acceptedAt,
      destination: null,
    } as const;
    const accepted = await acceptProtectedTaskRunOutputBinding(fixture.db, input);
    expect(accepted.status).toBe("accepted");
    expect(fixture.inserts).toHaveLength(1);
    expect(fixture.inserts[0]).toMatchObject({
      taskRunId: ids.run,
      bindingId: protectedTaskRunOutputBindingId(ids.run),
      deliveryMode: "none",
      resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
      messageOperationId: null,
      wakeOperationId: null,
    });
    expect(JSON.stringify(fixture.inserts)).not.toContain("prompt");

    const replay = await acceptProtectedTaskRunOutputBinding(fixture.db, {
      ...input,
      acceptedAt: new Date(acceptedAt.getTime() + 1000),
    });
    expect(replay.status).toBe("exact_replay");
    expect(fixture.inserts).toHaveLength(1);
  });

  test("freezes the exact calling Room output for raw-and-wake", async () => {
    const fixture = harness({
      task: task({
        callingRoomId: ids.room,
        resultDelivery: "raw_and_wake",
      }),
    });
    const result = await acceptProtectedTaskRunOutputBinding(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      requiredPolicyRevision: 9,
      acceptedAt,
      destination: { roomId: ids.room, namespaceId: ids.namespace },
    });
    expect(result.status).toBe("accepted");
    expect(fixture.inserts[0]).toMatchObject({
      deliveryMode: "raw_and_wake",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      messageOperationId: protectedTaskRunMessageOperationId(ids.run),
      wakeOperationId: protectedTaskRunWakeOperationId(ids.run),
    });
  });

  test("rejects Plain, stale, changed-policy and substituted destinations", async () => {
    const cases = [
      harness({ task: task({ contentRepresentation: "ordinary" }) }),
      harness({ run: run({ jobId: "70000000-0000-4000-8000-000000000007" }) }),
      harness({ policy: policy({ revision: 10 }) }),
      harness({ task: task({ callingRoomId: ids.room }) }),
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const fixture = cases[index]!;
      const result = await acceptProtectedTaskRunOutputBinding(fixture.db, {
        taskId: ids.task,
        taskRunId: ids.run,
        requiredPolicyRevision: 9,
        acceptedAt,
        destination: null,
      });
      expect(result.status).toBe("rejected");
      expect(fixture.inserts).toEqual([]);
    }
  });

  test("rejects replay after the Task destination changed", async () => {
    const existing = {
      taskRunId: ids.run,
      bindingId: protectedTaskRunOutputBindingId(ids.run),
      deliveryMode: "raw",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      resultOperationId: `task-run-result:${ids.run}`,
      resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
      messageOperationId: protectedTaskRunMessageOperationId(ids.run),
      wakeOperationId: null,
      acceptedPolicyRevision: 9,
      acceptedAt,
      resultTerminalAt: null,
      resultAttachedAt: null,
      messageId: null,
      messagePublishedAt: null,
      wakeJobId: null,
      wakeScheduledAt: null,
      completedAt: null,
    } as ProtectedTaskRunOutputBinding;
    const fixture = harness({
      task: task({
        callingRoomId: "70000000-0000-4000-8000-000000000007",
        resultDelivery: "raw",
      }),
      binding: existing,
    });
    expect(await acceptProtectedTaskRunOutputBinding(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      requiredPolicyRevision: 9,
      acceptedAt,
      destination: { roomId: ids.room, namespaceId: ids.namespace },
    })).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("rechecks the destination Room even for an accepted replay", async () => {
    const existing = {
      taskRunId: ids.run,
      bindingId: protectedTaskRunOutputBindingId(ids.run),
      deliveryMode: "raw",
      destinationRoomId: ids.room,
      destinationNamespaceId: ids.namespace,
      resultOperationId: `task-run-result:${ids.run}`,
      resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
      messageOperationId: protectedTaskRunMessageOperationId(ids.run),
      wakeOperationId: null,
      acceptedPolicyRevision: 9,
      acceptedAt,
    } as ProtectedTaskRunOutputBinding;
    const fixture = harness({
      task: task({ callingRoomId: ids.room, resultDelivery: "raw" }),
      room: null,
      binding: existing,
    });
    expect(await acceptProtectedTaskRunOutputBinding(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      requiredPolicyRevision: 9,
      acceptedAt,
      destination: { roomId: ids.room, namespaceId: ids.namespace },
    })).toEqual({ status: "rejected", reason: "authority_changed" });
    expect(fixture.locks.some((entry) => entry.table === rooms)).toBe(true);
  });

  test("does not issue a fresh grant from a completed replay", async () => {
    const fixture = harness({
      run: run({ status: "completed", completedAt: acceptedAt }),
      binding: {
        taskRunId: ids.run,
        bindingId: protectedTaskRunOutputBindingId(ids.run),
        deliveryMode: "none",
        destinationRoomId: null,
        destinationNamespaceId: null,
        resultOperationId: `task-run-result:${ids.run}`,
        resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
        messageOperationId: null,
        wakeOperationId: null,
        acceptedPolicyRevision: 9,
      } as ProtectedTaskRunOutputBinding,
    });
    expect(await acceptProtectedTaskRunOutputBinding(fixture.db, {
      taskId: ids.task,
      taskRunId: ids.run,
      requiredPolicyRevision: 9,
      acceptedAt,
      destination: null,
    })).toEqual({ status: "rejected", reason: "stale" });
  });
});
