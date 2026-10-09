import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  readProtectedTaskRunTranscriptIndex,
  readTaskRunMessageMappingCounts,
  recordTaskRunMessageAssociationInTx,
  type TaskRunMessageAssociationInput,
} from "../../src/queries/task-run-message-associations";
import {
  taskRunMessageAssociations,
  type TaskRunMessageAssociation,
} from "../../src/schema/task-run-message-associations";
import { taskRuns } from "../../src/schema/task-runs";
import { sessionMessages, sessions } from "../../src/schema/sessions";
import { tasks } from "../../src/schema/tasks";
import { roomMembers, rooms } from "../../src/schema/rooms";
import { protectedTaskRunOutputBindings } from
  "../../src/schema/protected-task-run-output-bindings";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  otherTask: "10000000-0000-4000-8000-000000000002",
  run: "20000000-0000-4000-8000-000000000001",
  otherRun: "20000000-0000-4000-8000-000000000002",
  session: "30000000-0000-4000-8000-000000000001",
  room: "40000000-0000-4000-8000-000000000001",
  otherRoom: "40000000-0000-4000-8000-000000000002",
  namespace: "40000000-0000-4000-8000-000000000003",
  owner: "50000000-0000-4000-8000-000000000001",
  roomOwner: "50000000-0000-4000-8000-000000000002",
  agent: "60000000-0000-4000-8000-000000000001",
  actor: "70000000-0000-4000-8000-000000000001",
};
const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const destinationGraphThreadId = `room:${ids.room}:conversation`;
const createdAt = new Date("2026-10-01T08:00:00.000Z");

function input(
  overrides: Partial<TaskRunMessageAssociationInput> = {},
): TaskRunMessageAssociationInput {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    sessionId: ids.session,
    expectedThreadId: graphThreadId,
    messageId: 41,
    publishedRevision: 0,
    kind: "transcript",
    publicationKey: `task-transcript:${ids.run}:fp:v1:abc`,
    createdAt,
    ...overrides,
  };
}

function association(
  value: TaskRunMessageAssociationInput,
): TaskRunMessageAssociation {
  return {
    taskRunId: value.taskRunId,
    sessionId: value.sessionId,
    messageId: value.messageId,
    publishedRevision: value.publishedRevision,
    kind: value.kind,
    publicationKey: value.publicationKey,
    createdAt: value.createdAt ?? createdAt,
  };
}

function writeHarness(
  initial: readonly TaskRunMessageAssociation[] = [],
  availableRuns: readonly Readonly<{
    id: string;
    taskId: string;
    graphThreadId: string;
  }>[] = [
    { id: ids.run, taskId: ids.task, graphThreadId },
    { id: ids.otherRun, taskId: ids.task, graphThreadId },
  ],
  options: Readonly<{
    sessionRoomId?: string;
    sessionThreadId?: string;
    roomGraphThreadId?: string;
  }> = {},
) {
  const rows = [...initial];
  const availableTasks = [{
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: ids.otherRoom,
    targetRoomId: ids.room,
    targetUserIds: [ids.owner, ids.roomOwner],
  }, {
    id: ids.otherTask,
    ownerId: ids.owner,
    requestorId: ids.owner,
    agentId: ids.agent,
    callingRoomId: ids.room,
    targetRoomId: ids.room,
    targetUserIds: [],
  }];
  const availableSessions = [{
    id: ids.session,
    threadId: options.sessionThreadId ?? graphThreadId,
    ownerId: ids.roomOwner,
    agentId: ids.agent,
    roomId: options.sessionRoomId ?? ids.room,
  }];
  const availableRooms = [{
    id: ids.room,
    ownerId: ids.roomOwner,
    namespaceId: ids.namespace,
    graphThreadId: options.roomGraphThreadId ?? graphThreadId,
    archivedAt: null,
  }];
  const availableMembers = [{
    actorKind: "user",
    actorOwnerId: ids.roomOwner,
    actorAgentId: null,
  }, {
    actorKind: "agent",
    actorOwnerId: ids.roomOwner,
    actorAgentId: ids.agent,
  }];
  const availableMessages = [{
    id: 41,
    sessionId: ids.session,
    editRevision: 0,
    role: "assistant",
  }, {
    id: 42,
    sessionId: ids.session,
    editRevision: 0,
    role: "assistant",
  }];
  const availableOutputBindings = [{
    taskRunId: ids.run,
    deliveryMode: "raw_and_wake",
    destinationRoomId: ids.room,
    destinationNamespaceId: ids.namespace,
    messageOperationId: `task-run-delivery-message:${ids.run}`,
    wakeOperationId: `task-run-delivery-wake:${ids.run}`,
    resultAttachedAt: createdAt,
    completedAt: null,
  }];
  let selectedTable: unknown;
  const tx = {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        selectedTable = table;
        const query = {
          innerJoin: (_joinedTable: unknown, _condition: unknown) => query,
          where: (_condition: unknown) => query,
          limit: (_limit: number): unknown => selectedTable === taskRunMessageAssociations
            ? Promise.resolve(rows) : query,
          for: async (_kind: string) => {
            if (selectedTable === taskRuns) return availableRuns;
            if (selectedTable === tasks) return availableTasks;
            if (selectedTable === sessions) return availableSessions;
            if (selectedTable === sessionMessages) return availableMessages;
            if (selectedTable === rooms) return availableRooms;
            if (selectedTable === roomMembers) return availableMembers;
            if (selectedTable === protectedTaskRunOutputBindings) {
              return availableOutputBindings;
            }
            return rows;
          },
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (value: TaskRunMessageAssociation) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== taskRunMessageAssociations) {
              throw new Error("unexpected insert table");
            }
            if (rows.some((row) => row.messageId === value.messageId
              || row.taskRunId === value.taskRunId
                && row.kind === value.kind
                && row.publicationKey === value.publicationKey)) return [];
            const inserted = {
              ...value,
              createdAt: value.createdAt ?? createdAt,
            } as TaskRunMessageAssociation;
            rows.push(inserted);
            return [inserted];
          },
        }),
      }),
    }),
  } as unknown as Pick<DirectDatabase, "insert" | "select">;
  return { tx, rows };
}

describe("TaskRun Message association receipts", () => {
  test("records once and returns an exact replay", async () => {
    const harness = writeHarness();
    const request = input();
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, request))
      .toMatchObject({ status: "recorded", association: association(request) });
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, request))
      .toMatchObject({ status: "exact_replay", association: association(request) });
    expect(harness.rows).toHaveLength(1);
  });

  test("accepts the exact peer-owned Room without requiring the requester", async () => {
    const exact = writeHarness();
    expect(ids.roomOwner).not.toBe(ids.owner);
    expect(await recordTaskRunMessageAssociationInTx(exact.tx, input()))
      .toMatchObject({ status: "recorded" });

    const substituted = writeHarness([], undefined, {
      sessionRoomId: ids.otherRoom,
    });
    expect(await recordTaskRunMessageAssociationInTx(substituted.tx, input()))
      .toEqual({ status: "rejected", reason: "not_found" });
    expect(substituted.rows).toHaveLength(0);
  });

  test("records raw delivery in the accepted destination, not the calling Room", async () => {
    const harness = writeHarness();
    const request = input({
      kind: "raw_delivery",
      publicationKey: `task-run-delivery-message:${ids.run}`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
    });
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, request))
      .toMatchObject({ status: "recorded", association: association(request) });
    expect(ids.otherRoom).not.toBe(ids.room);
  });

  test("rejects a raw delivery destination substituted by its caller", async () => {
    const harness = writeHarness();
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
      kind: "raw_delivery",
      publicationKey: `task-run-delivery-message:${ids.run}`,
      expectedDestinationRoomId: ids.otherRoom,
      expectedDestinationNamespaceId: ids.namespace,
    }))).toEqual({ status: "rejected", reason: "not_found" });
    expect(harness.rows).toHaveLength(0);
  });

  test("rejects raw delivery from an unrelated destination-Room thread", async () => {
    const harness = writeHarness([], undefined, {
      sessionThreadId: "unrelated-thread",
      roomGraphThreadId: destinationGraphThreadId,
    });
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
      kind: "raw_delivery",
      expectedThreadId: "unrelated-thread",
      publicationKey: `task-run-delivery-message:${ids.run}`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
    }))).toEqual({ status: "rejected", reason: "not_found" });
    expect(harness.rows).toHaveLength(0);
  });

  test("records wake Messages in the distinct accepted destination thread", async () => {
    const harness = writeHarness([], undefined, {
      sessionThreadId: destinationGraphThreadId,
      roomGraphThreadId: destinationGraphThreadId,
    });
    const wakeOperationId = `task-run-delivery-wake:${ids.run}`;
    const request = input({
      expectedThreadId: destinationGraphThreadId,
      publicationKey: `${wakeOperationId}:1`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
      kind: "wake",
      expectedWakeOperationId: wakeOperationId,
      expectedWakeOrdinal: 1,
    });
    expect(graphThreadId).not.toBe(destinationGraphThreadId);
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, request))
      .toMatchObject({ status: "recorded", association: association(request) });
  });

  test("rejects a substituted wake destination, thread, or ordinal key", async () => {
    const wakeOperationId = `task-run-delivery-wake:${ids.run}`;
    for (const request of [
      input({
        expectedThreadId: destinationGraphThreadId,
        publicationKey: `${wakeOperationId}:1`,
        expectedDestinationRoomId: ids.otherRoom,
        expectedDestinationNamespaceId: ids.namespace,
        kind: "wake",
      expectedWakeOperationId: wakeOperationId,
        expectedWakeOrdinal: 1,
      }),
      input({
        expectedThreadId: "room:substituted",
        publicationKey: `${wakeOperationId}:1`,
        expectedDestinationRoomId: ids.room,
        expectedDestinationNamespaceId: ids.namespace,
        kind: "wake",
      expectedWakeOperationId: wakeOperationId,
        expectedWakeOrdinal: 1,
      }),
      input({
        expectedThreadId: destinationGraphThreadId,
        publicationKey: `${wakeOperationId}:2`,
        expectedDestinationRoomId: ids.room,
        expectedDestinationNamespaceId: ids.namespace,
        kind: "wake",
      expectedWakeOperationId: wakeOperationId,
        expectedWakeOrdinal: 1,
      }),
    ]) {
      const harness = writeHarness([], undefined, {
        sessionThreadId: destinationGraphThreadId,
        roomGraphThreadId: destinationGraphThreadId,
      });
      expect(await recordTaskRunMessageAssociationInTx(harness.tx, request))
        .toEqual({ status: "rejected", reason: "not_found" });
      expect(harness.rows).toHaveLength(0);
    }
  });

  test("rejects cross-run Message substitution and publication-key reuse", async () => {
    const original = association(input());
    const crossRun = writeHarness([original]);
    expect(await recordTaskRunMessageAssociationInTx(crossRun.tx, input({
      taskRunId: ids.otherRun,
      publicationKey: `task-transcript:${ids.otherRun}:fp:v1:abc`,
    }))).toEqual({ status: "rejected", reason: "conflict" });

    const changedCoordinate = writeHarness([original]);
    expect(await recordTaskRunMessageAssociationInTx(changedCoordinate.tx, input({
      messageId: 42,
    }))).toEqual({ status: "rejected", reason: "conflict" });
  });

  test("rejects a Task identity that does not own the selected run", async () => {
    const harness = writeHarness([], []);
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
      taskId: ids.otherTask,
    }))).toEqual({ status: "rejected", reason: "not_found" });
    expect(harness.rows).toHaveLength(0);
  });

  test("rejects a Session thread outside the exact TaskRun", async () => {
    const harness = writeHarness();
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
      expectedThreadId: "subagent:unrelated",
    }))).toEqual({ status: "rejected", reason: "not_found" });
    expect(harness.rows).toHaveLength(0);
  });

  test("rejects malformed coordinates before repository access", async () => {
    const harness = writeHarness();
    let error: unknown;
    try {
      await recordTaskRunMessageAssociationInTx(harness.tx, input({
        messageId: 0,
      }));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("association is malformed");
  });
});

function transcriptReadHarness(input: Readonly<{
  member?: boolean;
  roomId?: string | null;
  sessionOwnerId?: string;
  messagePresent?: boolean;
}> = {}) {
  const roomId = input.roomId === undefined ? ids.room : input.roomId;
  const data = (table: unknown) => {
    if (table === tasks) return [{
      ownerId: ids.owner,
      contentRepresentation: "protected",
      cryptoMappingState: "verified",
      targetRoomId: roomId,
      runTaskId: ids.task,
      graphThreadId,
      runStatus: "running",
    }];
    if (table === taskRunMessageAssociations) return [{
      associatedSessionId: ids.session,
      associatedMessageId: 41,
      associatedRevision: 0,
      sessionId: ids.session,
      roomId,
      sessionOwnerId: input.sessionOwnerId ?? ids.roomOwner,
      threadId: graphThreadId,
      messageId: input.messagePresent === false ? null : 41,
      messageSessionId: input.messagePresent === false ? null : ids.session,
      editRevision: input.messagePresent === false ? null : 0,
      role: input.messagePresent === false ? null : "assistant",
      cryptoObjectId: input.messagePresent === false ? null : "message:v2:41",
      createdAt: input.messagePresent === false ? null : createdAt,
    }];
    if (table === roomMembers) {
      return input.member === false ? [] : [{ roomId: ids.room }];
    }
    return [];
  };
  return {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: (_joined: unknown, _condition: unknown) => query,
          leftJoin: (_joined: unknown, _condition: unknown) => query,
          where: (_condition: unknown) => query,
          limit: async (_limit: number) => data(table),
          orderBy: async (_order: unknown) => data(table),
          then: <Value>(
            resolve: (value: unknown[]) => Value | PromiseLike<Value>,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve(data(table)).then(resolve, reject),
        };
        return query;
      },
    }),
  } as unknown as Pick<DirectDatabase, "select">;
}

describe("protected TaskRun transcript index", () => {
  const request = {
    taskId: ids.task,
    taskRunId: ids.run,
    viewerUserId: ids.owner,
    viewerActorId: ids.actor,
  };

  test("returns only content-free coordinates for a current Room member", async () => {
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness(),
      request,
    )).toEqual({
      status: "ready",
      rows: [{
        sessionId: ids.session,
        roomId: ids.room,
        messageId: 41,
        editRevision: 0,
        role: "assistant",
        createdAt,
      }],
    });
  });

  test("Task ownership does not grant a peer-private Room transcript", async () => {
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ member: false }),
      request,
    )).toEqual({
      status: "unavailable",
      reason: "not_in_message_audience",
    });
  });

  test("recognizes owner-private Sessions without inventing a history reader", async () => {
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ roomId: null, sessionOwnerId: ids.owner }),
      request,
    )).toEqual({
      status: "unavailable",
      reason: "message_history_unavailable",
    });
  });
});

describe("TaskRun Message mapping counts", () => {
  test("derives pending/stale and missing counts from exact aggregate rows", async () => {
    const joinConditions: unknown[] = [];
    const aggregateRows = [{
      kind: "transcript" as const,
      associatedCount: 5,
      presentMessageCount: 4,
      verifiedMappedCount: 3,
      verifiedShadowMappedCount: 2,
      verifiedFullMappedCount: 1,
    }, {
      kind: "raw_delivery" as const,
      associatedCount: 1,
      presentMessageCount: 1,
      verifiedMappedCount: 1,
      verifiedShadowMappedCount: 0,
      verifiedFullMappedCount: 1,
    }];
    const query = {
      leftJoin: (_table: unknown, condition: unknown) => {
        joinConditions.push(condition);
        return query;
      },
      where: (_condition: unknown) => query,
      groupBy: async (_column: unknown) => aggregateRows,
    };
    const db = {
      select: (_selection: unknown) => ({
        from: (_table: unknown) => query,
      }),
    } as unknown as Pick<DirectDatabase, "select">;

    expect(await readTaskRunMessageMappingCounts(db, ids.run)).toEqual([{
      kind: "transcript",
      associatedCount: 5,
      presentMessageCount: 4,
      verifiedMappedCount: 3,
      verifiedShadowMappedCount: 2,
      verifiedFullMappedCount: 1,
      pendingOrStaleCount: 1,
      missingMessageCount: 1,
    }, {
      kind: "raw_delivery",
      associatedCount: 1,
      presentMessageCount: 1,
      verifiedMappedCount: 1,
      verifiedShadowMappedCount: 0,
      verifiedFullMappedCount: 1,
      pendingOrStaleCount: 0,
      missingMessageCount: 0,
    }]);

    const fullMappingQuery = new PgDialect().sqlToQuery(
      joinConditions[2] as SQL,
    );
    const fullMappingSql = fullMappingQuery.sql.replaceAll('"', "");
    expect(fullMappingSql).toContain("session_messages.content is null");
    expect(fullMappingSql).toContain("session_messages.tool_calls is null");
    expect(fullMappingSql).toContain("session_messages.tool_name is null");
    expect(fullMappingSql).toContain("session_messages.metadata is null");
    expect(fullMappingSql).toContain("representation_mode = $");
    expect(fullMappingQuery.params).toContain("full_encryption");
    expect(fullMappingSql).toContain("publication_policy_revision is not null");
  });
});
