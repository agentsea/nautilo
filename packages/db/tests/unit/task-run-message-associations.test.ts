import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  deriveProtectedTaskDeliveryGraphThreadId,
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
  requester: "50000000-0000-4000-8000-000000000003",
  peer: "50000000-0000-4000-8000-000000000004",
  agent: "60000000-0000-4000-8000-000000000001",
  otherAgent: "60000000-0000-4000-8000-000000000002",
  actor: "70000000-0000-4000-8000-000000000001",
  agentActor: "70000000-0000-4000-8000-000000000002",
  peerActor: "70000000-0000-4000-8000-000000000003",
};
const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const destinationGraphThreadId = `room:${ids.room}:conversation`;
const destinationAgentThreadId = `room:${ids.room}:bot:${ids.agent}`;
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
    sessionOwnerId?: string;
    sessionThreadId?: string;
    roomGraphThreadId?: string;
    task?: Readonly<Record<string, unknown>>;
    rooms?: readonly Readonly<Record<string, unknown>>[];
    members?: readonly Readonly<{
      actorId?: string;
      actorKind: string;
      actorOwnerId: string;
      actorAgentId: string | null;
    }>[];
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
    contentRepresentation: "protected",
    cryptoMappingState: "verified",
    contentNamespaceId: ids.namespace,
    ...options.task,
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
    ownerId: options.sessionOwnerId ?? ids.roomOwner,
    agentId: ids.agent,
    roomId: options.sessionRoomId ?? ids.room,
  }];
  const availableRooms = [{
    id: ids.room,
    ownerId: ids.roomOwner,
    namespaceId: ids.namespace,
    graphThreadId: options.roomGraphThreadId ?? graphThreadId,
    type: "private",
    kind: "private",
    parentRoomId: null,
    humanActorIds: [ids.actor],
    archivedAt: null,
  }];
  const selectedRooms = options.rooms ?? availableRooms;
  const availableMembers = options.members ?? [{
    actorId: ids.actor,
    actorKind: "user",
    actorOwnerId: ids.roomOwner,
    actorAgentId: null,
  }, {
    actorId: ids.agentActor,
    actorKind: "agent",
    actorOwnerId: ids.roomOwner,
    actorAgentId: ids.agent,
  }];
  let roomRead = 0;
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
            if (selectedTable === rooms) {
              const room = selectedRooms[roomRead % selectedRooms.length];
              roomRead += 1;
              return room === undefined ? [] : [room];
            }
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

describe("protected Task delivery Room thread derivation", () => {
  const owner = {
    actorKind: "user",
    actorAgentId: null,
  };
  const peer = {
    actorKind: "user",
    actorAgentId: null,
  };
  const targetAgent = {
    actorKind: "agent",
    actorAgentId: ids.agent,
  };
  const otherAgent = {
    actorKind: "agent",
    actorAgentId: ids.otherAgent,
  };
  const derive = (
    members: readonly Readonly<{
      actorKind: string;
      actorAgentId: string | null;
    }>[],
  ) => deriveProtectedTaskDeliveryGraphThreadId({
    roomId: ids.room,
    roomGraphThreadId: destinationGraphThreadId,
    targetAgentId: ids.agent,
    members,
  });

  test("uses the Room thread only for a strict one-Human/one-Agent DM", () => {
    expect(derive([owner, targetAgent])).toBe(destinationGraphThreadId);
  });

  test("uses the target Agent partition for multi-Human or multi-Agent Rooms", () => {
    expect(derive([owner, peer, targetAgent])).toBe(destinationAgentThreadId);
    expect(derive([owner, targetAgent, otherAgent]))
      .toBe(destinationAgentThreadId);
  });

  test("rejects missing or duplicate target Agents and Rooms without Humans", () => {
    expect(derive([owner, otherAgent])).toBeNull();
    expect(derive([owner, targetAgent, targetAgent])).toBeNull();
    expect(derive([targetAgent])).toBeNull();
  });
});

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

  const hiddenTranscriptHarness = (overrides: Readonly<{
    task?: Readonly<Record<string, unknown>>;
    targetRoom?: Readonly<Record<string, unknown>>;
    sourceRoom?: Readonly<Record<string, unknown>>;
    members?: readonly Readonly<{
      actorId?: string;
      actorKind: string;
      actorOwnerId: string;
      actorAgentId: string | null;
    }>[];
  }> = {}) => writeHarness([], undefined, {
    sessionRoomId: ids.otherRoom,
    sessionOwnerId: ids.owner,
    ...(overrides.task === undefined ? {} : { task: overrides.task }),
    rooms: [{
      id: ids.room,
      ownerId: ids.owner,
      namespaceId: ids.otherRoom,
      graphThreadId,
      type: "private",
      kind: "task",
      parentRoomId: null,
      humanActorIds: [],
      archivedAt: null,
      ...overrides.targetRoom,
    }, {
      id: ids.otherRoom,
      ownerId: ids.owner,
      namespaceId: ids.namespace,
      graphThreadId,
      type: "private",
      kind: "private",
      parentRoomId: null,
      humanActorIds: [ids.actor],
      archivedAt: null,
      ...overrides.sourceRoom,
    }],
    members: overrides.members ?? [{
      actorId: ids.actor,
      actorKind: "user",
      actorOwnerId: ids.owner,
      actorAgentId: null,
    }, {
      actorId: ids.agentActor,
      actorKind: "agent",
      actorOwnerId: ids.owner,
      actorAgentId: ids.agent,
    }],
  });

  test("records a protected hidden-Task transcript in its exact requester-private Room", async () => {
    const harness = hiddenTranscriptHarness();
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input()))
      .toMatchObject({ status: "recorded" });
  });

  test("rejects substituted hidden-Task transcript audiences", async () => {
    const cases = [
      hiddenTranscriptHarness({
        sourceRoom: { humanActorIds: [ids.actor, ids.peerActor] },
        members: [{ actorId: ids.actor, actorKind: "user", actorOwnerId: ids.owner, actorAgentId: null },
          { actorId: ids.peerActor, actorKind: "user", actorOwnerId: ids.peer, actorAgentId: null },
          { actorId: ids.agentActor, actorKind: "agent", actorOwnerId: ids.owner, actorAgentId: ids.agent }],
      }),
      hiddenTranscriptHarness({ sourceRoom: { namespaceId: ids.otherRoom } }),
      hiddenTranscriptHarness({ sourceRoom: { ownerId: ids.peer } }),
      hiddenTranscriptHarness({
        members: [{ actorId: ids.actor, actorKind: "user", actorOwnerId: ids.owner, actorAgentId: null },
          { actorId: ids.agentActor, actorKind: "agent", actorOwnerId: ids.owner, actorAgentId: ids.otherAgent }],
      }),
      hiddenTranscriptHarness({ sourceRoom: { archivedAt: createdAt } }),
      hiddenTranscriptHarness({ sourceRoom: { kind: "group" } }),
      hiddenTranscriptHarness({ task: { cryptoMappingState: "pending" } }),
      hiddenTranscriptHarness({ task: { contentRepresentation: "ordinary" } }),
      hiddenTranscriptHarness({ targetRoom: { kind: "group" } }),
      hiddenTranscriptHarness({ targetRoom: { ownerId: ids.peer } }),
      hiddenTranscriptHarness({ targetRoom: { humanActorIds: [ids.actor] } }),
    ];
    for (const harness of cases) {
      expect(await recordTaskRunMessageAssociationInTx(harness.tx, input()))
        .toEqual({ status: "rejected", reason: "not_found" });
      expect(harness.rows).toHaveLength(0);
    }
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
    expect(ids.roomOwner).not.toBe(ids.owner);
  });

  test("rejects the target Agent partition in a strict DM", async () => {
    const harness = writeHarness([], undefined, {
      sessionThreadId: destinationAgentThreadId,
      roomGraphThreadId: destinationGraphThreadId,
    });
    expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
      kind: "raw_delivery",
      expectedThreadId: destinationAgentThreadId,
      publicationKey: `task-run-delivery-message:${ids.run}`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
    }))).toEqual({ status: "rejected", reason: "not_found" });
    expect(harness.rows).toHaveLength(0);
  });

  test("records group delivery only in the target Agent partition", async () => {
    const members = [{
      actorKind: "user",
      actorOwnerId: ids.roomOwner,
      actorAgentId: null,
    }, {
      actorKind: "user",
      actorOwnerId: ids.peer,
      actorAgentId: null,
    }, {
      actorKind: "agent",
      actorOwnerId: ids.roomOwner,
      actorAgentId: ids.agent,
    }];
    const exact = writeHarness([], undefined, {
      sessionThreadId: destinationAgentThreadId,
      roomGraphThreadId: destinationGraphThreadId,
      members,
    });
    const request = input({
      kind: "raw_delivery",
      expectedThreadId: destinationAgentThreadId,
      publicationKey: `task-run-delivery-message:${ids.run}`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
    });
    expect(await recordTaskRunMessageAssociationInTx(exact.tx, request))
      .toMatchObject({ status: "recorded" });

    const wrongThread = writeHarness([], undefined, {
      sessionThreadId: destinationGraphThreadId,
      roomGraphThreadId: destinationGraphThreadId,
      members,
    });
    expect(await recordTaskRunMessageAssociationInTx(wrongThread.tx, {
      ...request,
      expectedThreadId: destinationGraphThreadId,
    })).toEqual({ status: "rejected", reason: "not_found" });

    const otherAgentThreadId = `room:${ids.room}:bot:${ids.otherAgent}`;
    const otherAgentThread = writeHarness([], undefined, {
      sessionThreadId: otherAgentThreadId,
      roomGraphThreadId: destinationGraphThreadId,
      members,
    });
    expect(await recordTaskRunMessageAssociationInTx(otherAgentThread.tx, {
      ...request,
      expectedThreadId: otherAgentThreadId,
    })).toEqual({ status: "rejected", reason: "not_found" });
    expect(otherAgentThread.rows).toHaveLength(0);
  });

  test("records multi-Agent wake only in the target Agent partition", async () => {
    const members = [{
      actorKind: "user",
      actorOwnerId: ids.roomOwner,
      actorAgentId: null,
    }, {
      actorKind: "agent",
      actorOwnerId: ids.roomOwner,
      actorAgentId: ids.agent,
    }, {
      actorKind: "agent",
      actorOwnerId: ids.roomOwner,
      actorAgentId: ids.otherAgent,
    }];
    const wakeOperationId = `task-run-delivery-wake:${ids.run}`;
    const request = input({
      kind: "wake",
      expectedThreadId: destinationAgentThreadId,
      publicationKey: `${wakeOperationId}:1`,
      expectedDestinationRoomId: ids.room,
      expectedDestinationNamespaceId: ids.namespace,
      expectedWakeOperationId: wakeOperationId,
      expectedWakeOrdinal: 1,
    });
    const exact = writeHarness([], undefined, {
      sessionThreadId: destinationAgentThreadId,
      roomGraphThreadId: destinationGraphThreadId,
      members,
    });
    expect(await recordTaskRunMessageAssociationInTx(exact.tx, request))
      .toMatchObject({ status: "recorded" });

    const wrongThread = writeHarness([], undefined, {
      sessionThreadId: destinationGraphThreadId,
      roomGraphThreadId: destinationGraphThreadId,
      members,
    });
    expect(await recordTaskRunMessageAssociationInTx(wrongThread.tx, {
      ...request,
      expectedThreadId: destinationGraphThreadId,
    })).toEqual({ status: "rejected", reason: "not_found" });
    expect(wrongThread.rows).toHaveLength(0);
  });

  test("rejects protected delivery with invalid target membership", async () => {
    const invalidMemberships = [
      [{
        actorKind: "user",
        actorOwnerId: ids.roomOwner,
        actorAgentId: null,
      }, {
        actorKind: "agent",
        actorOwnerId: ids.roomOwner,
        actorAgentId: ids.otherAgent,
      }],
      [{
        actorKind: "user",
        actorOwnerId: ids.roomOwner,
        actorAgentId: null,
      }, {
        actorKind: "agent",
        actorOwnerId: ids.roomOwner,
        actorAgentId: ids.agent,
      }, {
        actorKind: "agent",
        actorOwnerId: ids.roomOwner,
        actorAgentId: ids.agent,
      }],
      [{
        actorKind: "agent",
        actorOwnerId: ids.roomOwner,
        actorAgentId: ids.agent,
      }],
    ];
    for (const members of invalidMemberships) {
      const harness = writeHarness([], undefined, { members });
      expect(await recordTaskRunMessageAssociationInTx(harness.tx, input({
        kind: "raw_delivery",
        publicationKey: `task-run-delivery-message:${ids.run}`,
        expectedDestinationRoomId: ids.room,
        expectedDestinationNamespaceId: ids.namespace,
      }))).toEqual({ status: "rejected", reason: "not_found" });
      expect(harness.rows).toHaveLength(0);
    }
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
  targetRoomId?: string | null;
  sessionOwnerId?: string;
  taskRequestorId?: string;
  taskAgentId?: string;
  sessionAgentId?: string | null;
  taskOwnerId?: string;
  contentRepresentation?: string;
  cryptoMappingState?: string;
  contentNamespaceId?: string;
  rooms?: readonly Readonly<Record<string, unknown>>[];
  members?: readonly Readonly<Record<string, unknown>>[];
  messagePresent?: boolean;
  messageIds?: readonly number[];
  observations?: { where: SQL[]; limits: number[] };
}> = {}) {
  const roomId = input.roomId === undefined ? ids.room : input.roomId;
  const targetRoomId = input.targetRoomId === undefined
    ? ids.room
    : input.targetRoomId;
  const data = (table: unknown) => {
    if (table === tasks) return [{
      ownerId: input.taskOwnerId ?? ids.owner,
      requestorId: input.taskRequestorId ?? ids.owner,
      agentId: input.taskAgentId ?? ids.agent,
      contentRepresentation: input.contentRepresentation ?? "protected",
      cryptoMappingState: input.cryptoMappingState ?? "verified",
      contentNamespaceId: input.contentNamespaceId ?? ids.namespace,
      targetRoomId,
      runTaskId: ids.task,
      graphThreadId,
      runStatus: "running",
    }];
    if (table === taskRunMessageAssociations) return (
      input.messageIds ?? [41]
    ).map((messageId) => ({
      associatedSessionId: ids.session,
      associatedMessageId: messageId,
      associatedRevision: 0,
      sessionId: ids.session,
      roomId,
      sessionOwnerId: input.sessionOwnerId ?? ids.roomOwner,
      sessionAgentId: input.sessionAgentId === undefined
        ? ids.agent
        : input.sessionAgentId,
      threadId: graphThreadId,
      messageId: input.messagePresent === false ? null : messageId,
      messageSessionId: input.messagePresent === false ? null : ids.session,
      editRevision: input.messagePresent === false ? null : 0,
      role: input.messagePresent === false ? null : "assistant",
      cryptoObjectId: input.messagePresent === false
        ? null
        : `message:v2:${messageId}`,
      createdAt: input.messagePresent === false ? null : createdAt,
    }));
    if (table === roomMembers) {
      return input.member === false || roomId === null ? []
        : input.members ?? [{
          roomId,
          actorId: ids.actor,
          actorKind: "user",
          actorOwnerId: input.taskRequestorId ?? ids.owner,
          actorAgentId: null,
        }];
    }
    if (table === rooms) return input.rooms ?? [];
    return [];
  };
  return {
    select: (_selection?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: (_joined: unknown, _condition: unknown) => query,
          leftJoin: (_joined: unknown, _condition: unknown) => query,
          where: (condition: SQL) => {
            input.observations?.where.push(condition);
            return query;
          },
          limit: async (limit: number) => {
            input.observations?.limits.push(limit);
            return data(table).slice(0, limit);
          },
          orderBy: (_order: unknown) => query,
          then: <Value>(
            resolve: (value: readonly unknown[]) => Value | PromiseLike<Value>,
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
    agentId: ids.agent,
    viewerUserId: ids.owner,
    viewerActorId: ids.actor,
    limit: 50,
  };

  test("returns only content-free coordinates for a current Room member", async () => {
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness(),
      request,
    )).toEqual({
      status: "ready",
      source: { kind: "task_target", roomId: ids.room },
      rows: [{
        sessionId: ids.session,
        roomId: ids.room,
        messageId: 41,
        editRevision: 0,
        role: "assistant",
        createdAt,
      }],
      nextAfterMessageId: null,
    });
  });

  test("bounds the canonical query and emits a stable exclusive continuation", async () => {
    const observations = { where: [] as SQL[], limits: [] as number[] };
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ messageIds: [41, 42, 43], observations }),
      { ...request, limit: 2 },
    )).toMatchObject({
      status: "ready",
      rows: [{ messageId: 41 }, { messageId: 42 }],
      nextAfterMessageId: 42,
    });
    expect(observations.limits).toEqual([2, 3]);

    const dialect = new PgDialect();
    const after = { ...request, afterMessageId: 42, limit: 2 };
    await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ observations }),
      after,
    );
    const transcriptWhere = dialect.sqlToQuery(observations.where.at(-2)!);
    expect(transcriptWhere.sql).toContain('"task_run_message_associations"."message_id" >');
    expect(transcriptWhere.params).toContain(42);
  });

  test("binds the exact Task Agent and canonical requester private Room source", async () => {
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({
        targetRoomId: null,
        roomId: ids.room,
        taskRequestorId: ids.requester,
        sessionOwnerId: ids.requester,
      }),
      request,
    )).toMatchObject({
      status: "ready",
      source: {
        kind: "requester_private",
        requesterUserId: ids.requester,
        roomId: ids.room,
        namespaceId: ids.namespace,
      },
    });
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ taskAgentId: ids.otherTask }),
      request,
    )).toEqual({ status: "not_found" });
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ sessionAgentId: ids.otherTask }),
      request,
    )).toEqual({ status: "unavailable", reason: "integrity_failure" });
  });

  test("reads a hidden Task transcript from the exact requester-private audience", async () => {
    const hidden = {
      roomId: ids.otherRoom,
      targetRoomId: ids.room,
      sessionOwnerId: ids.owner,
      rooms: [{
        id: ids.room,
        ownerId: ids.owner,
        namespaceId: ids.otherRoom,
        type: "private",
        kind: "task",
        parentRoomId: null,
        humanActorIds: [],
        archivedAt: null,
      }, {
        id: ids.otherRoom,
        ownerId: ids.owner,
        namespaceId: ids.namespace,
        type: "private",
        kind: "private",
        parentRoomId: null,
        humanActorIds: [ids.actor],
        archivedAt: null,
      }],
      members: [{
        roomId: ids.otherRoom,
        actorId: ids.actor,
        actorKind: "user",
        actorOwnerId: ids.owner,
        actorAgentId: null,
      }, {
        roomId: ids.otherRoom,
        actorId: ids.agentActor,
        actorKind: "agent",
        actorOwnerId: ids.owner,
        actorAgentId: ids.agent,
      }],
    } as const;
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness(hidden),
      request,
    )).toMatchObject({
      status: "ready",
      source: {
        kind: "requester_private",
        requesterUserId: ids.owner,
        roomId: ids.otherRoom,
        namespaceId: ids.namespace,
      },
    });
    expect(await readProtectedTaskRunTranscriptIndex(
      transcriptReadHarness({ ...hidden, cryptoMappingState: "pending" }),
      request,
    )).toEqual({ status: "unavailable", reason: "transcript_not_protected" });
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
      transcriptReadHarness({
        targetRoomId: null,
        roomId: null,
        sessionOwnerId: ids.owner,
      }),
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
