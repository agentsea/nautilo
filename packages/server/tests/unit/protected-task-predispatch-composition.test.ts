import { describe, expect, test } from "bun:test";
import { memoizeTaskExecutionCoordinates, type DirectDatabase, type Task, type TaskRun } from "@nautilo/db";
import { rejects } from "node:assert/strict";
import type {
  MemoryAccessEnvelope,
  PolicyResolver,
} from "@nautilo/trust";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";

import { createProductionProtectedTaskPredispatch } from
  "../../src/routes/protected-task-predispatch-composition";

const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  requestor: "22222222-2222-4222-8222-222222222222",
  actor: "33333333-3333-4333-8333-333333333333",
  agent: "44444444-4444-4444-8444-444444444444",
  task: "55555555-5555-4555-8555-555555555555",
  run: "66666666-6666-4666-8666-666666666666",
  room: "77777777-7777-4777-8777-777777777777",
  namespace: "88888888-8888-4888-8888-888888888888",
  memoryNamespace: "99999999-9999-4999-8999-999999999999",
  peer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  peerActor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const startedAt = new Date("2026-09-28T12:00:00.000Z");
const fingerprint = new Uint8Array(32).fill(0x42);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ids.task,
    ownerId: ids.owner,
    requestorId: ids.requestor,
    agentId: ids.agent,
    prompt: "",
    expectedOutput: null,
    preset: "ask_peer",
    scheduleKind: "now",
    runAt: null,
    cron: null,
    timezone: "UTC",
    catchup: "run_once",
    callingRoomId: null,
    targetChat: "new_dm",
    targetChatHandle: "peer",
    targetRoomId: null,
    resultDelivery: "wake",
    targetUserIds: [],
    useScope: false,
    scopeId: null,
    toolsMode: "auto",
    toolsWhitelist: [],
    awaitResponse: false,
    selectionProfile: "balanced",
    selectionSpec: null,
    requestedModelId: null,
    timeLimitSeconds: null,
    parentTaskId: null,
    depth: 0,
    status: "awaiting",
    nextFireAt: null,
    lastFiredAt: null,
    fireLockId: null,
    fireLockedAt: null,
    lastError: null,
    metadata: {},
    localExecutionDelegation: null,
    fundingMode: "legacy_server",
    contentRepresentation: "protected",
    contentNamespaceId: ids.namespace,
    contentRevision: 3,
    cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
    cryptoAccessRevision: 2,
    cryptoRequiredNamespaceFingerprint: fingerprint,
    cryptoMappingState: "verified",
    createdAt: startedAt,
    updatedAt: startedAt,
    cancelledAt: null,
    ...overrides,
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: ids.run,
    taskId: ids.task,
    jobId: null,
    graphThreadId: `subagent:task:${ids.task}:one`,
    status: "awaiting",
    modelId: null,
    resultText: null,
    startedAt,
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
  } as TaskRun;
}

function occurrence(
  taskOverrides: Partial<Task> = {},
): ProtectedTaskOccurrence {
  const currentTask = task(taskOverrides);
  const currentRun = run();
  return {
    task: {
      id: currentTask.id,
      ownerId: currentTask.ownerId,
      requestorId: currentTask.requestorId,
      agentId: currentTask.agentId,
      callingRoomId: currentTask.callingRoomId,
      scheduleKind: currentTask.scheduleKind,
      contentRepresentation: "protected",
      contentNamespaceId: ids.namespace,
      contentRevision: currentTask.contentRevision,
      cryptoObjectId: currentTask.cryptoObjectId!,
      cryptoAccessRevision: currentTask.cryptoAccessRevision,
      cryptoRequiredNamespaceFingerprint: fingerprint,
    },
    run: {
      id: currentRun.id,
      taskId: currentRun.taskId,
      jobId: null,
      graphThreadId: currentRun.graphThreadId,
      status: "awaiting",
      startedAt,
    },
  };
}

function envelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: ids.requestor,
    actorId: ids.actor,
    agentId: ids.agent,
    roomId: ids.room,
    readableNamespaces: [ids.memoryNamespace],
    mutableNamespaces: [ids.memoryNamespace],
    writableNamespaces: [ids.memoryNamespace],
    toolPolicy: {},
  };
}

const db = {} as DirectDatabase;
const resolver = {} as PolicyResolver;

describe("production protected Task predispatch composition", () => {
  test("uses a peer persisted during one target resolution and converges its created Room", async () => {
    const before = task();
    const after = task({
      targetRoomId: ids.room,
      targetUserIds: [ids.peer],
    });
    let taskReads = 0;
    const events: string[] = [];
    const plan = await createProductionProtectedTaskPredispatch({
      db,
      resolver,
      convergeCreatedRoomCatalog: async humans => {
        events.push(`converge:${humans[0]?.userId}`);
      },
      getTaskById: async () => ++taskReads === 1 ? before : after,
      getTaskRunForTask: async () => run(),
      assertCanInvokeAgent: async () => { events.push("invoke"); },
      assertCanUseServerProviderCredentials: async () => {
        events.push("funding");
      },
      resolveTargetRoom: async () => {
        events.push("target");
        return {
          roomId: ids.room,
          graphThreadId: "ignored-target-thread",
          createdHumanRoomMembers: [{
            userId: ids.peer,
            actorId: ids.peerActor,
          }],
        };
      },
      resolveTaskMemoryEnvelope: async input => {
        events.push(`memory:${input.task.targetUserIds.join(",")}`);
        expect(input.targetUserIds).toEqual([ids.requestor, ids.peer]);
        return {
          envelope: envelope(),
          mode: "namespace",
          authorityStatus: "exact",
          provenance: "target_users_namespace",
        };
      },
    })(occurrence());

    expect(events).toEqual([
      "invoke",
      "funding",
      "target",
      `converge:${ids.peer}`,
      `memory:${ids.peer}`,
    ]);
    expect(taskReads).toBe(2);
    expect(plan.target).toEqual({
      roomId: ids.room,
      targetUserIds: [ids.requestor, ids.peer],
    });
  });

  test("rejects revoked and stale occurrences before authority or target work", async () => {
    for (const current of [
      task({ status: "cancelled" }),
      task({ contentRevision: 4 }),
    ]) {
      let sideEffects = 0;
      const predispatch = createProductionProtectedTaskPredispatch({
        db,
        resolver,
        convergeCreatedRoomCatalog: async () => { sideEffects += 1; },
        getTaskById: async () => current,
        getTaskRunForTask: async () => run(),
        assertCanInvokeAgent: async () => { sideEffects += 1; },
        assertCanUseServerProviderCredentials: async () => { sideEffects += 1; },
        resolveTargetRoom: async () => {
          sideEffects += 1;
          return { roomId: ids.room, graphThreadId: "unused" };
        },
        resolveTaskMemoryEnvelope: async () => {
          sideEffects += 1;
          throw new Error("unreachable");
        },
      });

      await Promise.resolve(expect(predispatch(occurrence())).rejects.toThrow(
        "Protected Task occurrence is no longer current",
      ));
      expect(sideEffects).toBe(0);
    }
  });

  test("memoizes both namespace selectors before resolving Memory", async () => {
    for (const targetChat of [
      "last_in_namespace",
      "new_in_namespace",
    ] as const) {
      const before = task({
        preset: "task",
        targetChat,
        targetChatHandle: null,
      });
      const after = task({
        preset: "task",
        targetChat,
        targetChatHandle: null,
        targetRoomId: ids.room,
      });
      let taskReads = 0;
      const writes: string[] = [];
      const plan = await createProductionProtectedTaskPredispatch({
        db,
        resolver,
        convergeCreatedRoomCatalog: async () => {},
        getTaskById: async () => ++taskReads < 3 ? before : after,
        getTaskRunForTask: async () => run(),
        memoizeTaskExecutionCoordinates: async (_db, observed, patch) => {
          expect(observed).toBe(before);
          writes.push(`${observed.id}:${patch.targetRoomId}`);
          return after;
        },
        assertCanInvokeAgent: async () => {},
        assertCanUseServerProviderCredentials: async () => {},
        resolveTargetRoom: async () => ({
          roomId: ids.room,
          graphThreadId: "ignored-target-thread",
        }),
        resolveTaskMemoryEnvelope: async input => {
          expect(input.task.targetRoomId).toBe(ids.room);
          return {
            envelope: envelope(),
            mode: "namespace",
            authorityStatus: "exact",
            provenance: "target_users_namespace",
          };
        },
      })(occurrence());

      expect(taskReads).toBe(3);
      expect(writes).toEqual([`${ids.task}:${ids.room}`]);
      expect(plan.target.roomId).toBe(ids.room);
    }
  });

  test("reuses a currently admissible namespace target on a later cron occurrence", async () => {
    for (const targetChat of [
      "last_in_namespace",
      "new_in_namespace",
    ] as const) {
      const recurring = task({
        scheduleKind: "cron",
        status: "pending",
        preset: "task",
        targetChat,
        targetChatHandle: null,
        targetRoomId: ids.room,
        targetUserIds: [ids.requestor],
      });
      let targetResolutions = 0;
      let targetWrites = 0;
      let validations = 0;
      const plan = await createProductionProtectedTaskPredispatch({
        db,
        resolver,
        convergeCreatedRoomCatalog: async () => {},
        getTaskById: async () => recurring,
        getTaskRunForTask: async () => run(),
        memoizeTaskExecutionCoordinates: async () => {
          targetWrites += 1;
          return recurring;
        },
        validateMemoizedNamespaceTarget: async current => {
          validations += 1;
          expect(current.targetRoomId).toBe(ids.room);
          return true;
        },
        assertCanInvokeAgent: async () => {},
        assertCanUseServerProviderCredentials: async () => {},
        resolveTargetRoom: async () => {
          targetResolutions += 1;
          return { roomId: ids.peer, graphThreadId: "wrong-later-target" };
        },
        resolveTaskMemoryEnvelope: async () => ({
          envelope: envelope(),
          mode: "namespace",
          authorityStatus: "exact",
          provenance: "target_users_namespace",
        }),
      })(occurrence({ scheduleKind: "cron" }));

      expect(plan.target.roomId).toBe(ids.room);
      expect(validations).toBe(1);
      expect(targetResolutions).toBe(0);
      expect(targetWrites).toBe(0);
    }
  });

  test("protected target memoization preserves delegation and passes the canonical row to Scope setup", async () => {
    const delegation = {
      version: 1 as const, humanUserId: ids.requestor, agentId: ids.agent,
      sourceRoomId: ids.room, sourceConversationId: "source-conversation", rootTaskId: ids.task,
      projectGrantId: "project-grant", ceiling: "basic" as const, profile: null,
      target: { instanceId: "", relayId: "selected-relay", pairingGeneration: "pairing-generation",
        serverOrigin: "https://server.example", serverFingerprint: "server-fingerprint" },
    };
    const before = task({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null,
      localExecutionDelegation: delegation });
    let current = before;
    let written: Record<string, unknown> | undefined;
    let canonical: Task | undefined;
    const chain = {
      set(patch: Record<string, unknown>) { written = patch; return chain; },
      where() { return chain; },
      async returning() {
        current = { ...current, ...written };
        canonical = current;
        return [current];
      },
    };
    const queryDb = { update: () => chain } as unknown as DirectDatabase;
    await createProductionProtectedTaskPredispatch({
      db: queryDb, resolver, convergeCreatedRoomCatalog: async () => {},
      getTaskById: async () => current, getTaskRunForTask: async () => run(),
      memoizeTaskExecutionCoordinates,
      assertCanInvokeAgent: async () => {}, assertCanUseServerProviderCredentials: async () => {},
      resolveTargetRoom: async () => ({ roomId: ids.room, graphThreadId: "unused" }),
      resolveTaskMemoryEnvelope: async input => {
        if (canonical === undefined) throw new Error("Target memoization must finish before Scope setup");
        expect(input.task).toBe(canonical);
        expect(input.task.targetRoomId).toBe(ids.room);
        expect(input.task.localExecutionDelegation).toEqual(delegation);
        expect(written).not.toHaveProperty("localExecutionDelegation");
        return { envelope: envelope(), mode: "namespace", authorityStatus: "exact", provenance: "target_users_namespace" };
      },
    })(occurrence({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null }));
  });

  test("a lost protected target definition CAS prevents Scope setup", async () => {
    const current = task({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null });
    let memoryCalls = 0;
    const predispatch = createProductionProtectedTaskPredispatch({
      db, resolver, convergeCreatedRoomCatalog: async () => {},
      getTaskById: async () => current, getTaskRunForTask: async () => run(),
      memoizeTaskExecutionCoordinates: async () => { throw new Error("Task definition changed during execution setup"); },
      assertCanInvokeAgent: async () => {}, assertCanUseServerProviderCredentials: async () => {},
      resolveTargetRoom: async () => ({ roomId: ids.room, graphThreadId: "unused" }),
      resolveTaskMemoryEnvelope: async () => { memoryCalls++; throw new Error("unreachable"); },
    });
    await rejects(predispatch(occurrence({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null })), /definition changed/);
    expect(memoryCalls).toBe(0);
  });

  test("definition consent invalidated after the cache write is not lent to Memory setup", async () => {
    const delegation = {
      version: 1 as const, humanUserId: ids.requestor, agentId: ids.agent,
      sourceRoomId: ids.room, sourceConversationId: "source-conversation", rootTaskId: ids.task,
      projectGrantId: "project-grant", ceiling: "basic" as const, profile: null,
      target: { instanceId: "", relayId: "selected-relay", pairingGeneration: "pairing-generation",
        serverOrigin: "https://server.example", serverFingerprint: "server-fingerprint" },
    };
    let current = task({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null,
      localExecutionDelegation: delegation });
    let memoryCalls = 0;
    const predispatch = createProductionProtectedTaskPredispatch({
      db, resolver, convergeCreatedRoomCatalog: async () => {},
      getTaskById: async () => current, getTaskRunForTask: async () => run(),
      memoizeTaskExecutionCoordinates: async (_db, observed, patch) => {
        const canonical = { ...observed, ...patch };
        current = { ...canonical, localExecutionDelegation: null };
        return canonical;
      },
      assertCanInvokeAgent: async () => {}, assertCanUseServerProviderCredentials: async () => {},
      resolveTargetRoom: async () => ({ roomId: ids.room, graphThreadId: "unused" }),
      resolveTaskMemoryEnvelope: async () => { memoryCalls++; throw new Error("unreachable"); },
    });
    await rejects(predispatch(occurrence({ preset: "task", targetChat: "new_in_namespace", targetChatHandle: null })), /memoization drifted/);
    expect(memoryCalls).toBe(0);
  });

  test("rejects a memoized namespace target that is no longer admissible", async () => {
    const current = task({
      preset: "task",
      targetChat: "last_in_namespace",
      targetChatHandle: null,
      targetRoomId: ids.room,
    });
    let targetResolutions = 0;
    const predispatch = createProductionProtectedTaskPredispatch({
      db,
      resolver,
      convergeCreatedRoomCatalog: async () => {},
      getTaskById: async () => current,
      getTaskRunForTask: async () => run(),
      validateMemoizedNamespaceTarget: async () => false,
      assertCanInvokeAgent: async () => {},
      assertCanUseServerProviderCredentials: async () => {},
      resolveTargetRoom: async () => {
        targetResolutions += 1;
        return { roomId: ids.peer, graphThreadId: "wrong-later-target" };
      },
      resolveTaskMemoryEnvelope: async () => {
        throw new Error("unreachable");
      },
    });

    await Promise.resolve(expect(predispatch(occurrence())).rejects.toThrow(
      "Protected Task memoized target is unavailable",
    ));
    expect(targetResolutions).toBe(0);
  });

  test("rejects a compatibility fallback Memory envelope", async () => {
    const current = task({
      preset: "task",
      targetChat: "last_in_namespace",
      targetChatHandle: null,
      targetRoomId: ids.room,
    });
    const predispatch = createProductionProtectedTaskPredispatch({
      db,
      resolver,
      convergeCreatedRoomCatalog: async () => {},
      getTaskById: async () => current,
      getTaskRunForTask: async () => run(),
      validateMemoizedNamespaceTarget: async () => true,
      assertCanInvokeAgent: async () => {},
      assertCanUseServerProviderCredentials: async () => {},
      resolveTargetRoom: async () => ({
        roomId: ids.room,
        graphThreadId: "ignored-target-thread",
      }),
      resolveTaskMemoryEnvelope: async input => {
        expect(input.task).toEqual(current);
        expect(input.targetUserIds).toEqual([ids.requestor]);
        return {
          envelope: envelope(),
          mode: "namespace",
          authorityStatus: "fallback",
          provenance: "base_namespace_fallback",
        };
      },
    });

    await Promise.resolve(expect(predispatch(occurrence())).rejects.toThrow(
      "Protected Task Memory authority is not exact",
    ));
  });
});
