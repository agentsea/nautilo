import {
  actors,
  agentScopes,
  and,
  eq,
  getTaskById,
  getTaskRunForTask,
  inArray,
  isNull,
  privateNamespaceBoundarySql,
  roomMembers,
  rooms,
  taskRuns,
  tasks,
  updateTask,
  type DirectDatabase,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import {
  planProtectedTaskPredispatch,
  botThreadId,
  resolveTargetRoom,
  resolveTaskMemoryEnvelope,
  type HumanRoomMember,
  type ProtectedTaskOccurrence,
  type ProtectedTaskPredispatchPlan,
  type ResolvedTargetRoom,
} from "@nautilo/runtime";
import {
  assertCanInvokeAgent,
  assertCanUseServerProviderCredentials,
  type PolicyResolver,
} from "@nautilo/trust";

import { prepareProtectedTaskScope } from "./protected-task-scope-creation";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";

type ReadTask = (db: DirectDatabase, taskId: string) => Promise<Task | undefined>;
type ReadTaskRun = (
  db: DirectDatabase,
  taskId: string,
  taskRunId: string,
) => Promise<TaskRun | undefined>;
type ResolveTarget = (
  task: Task,
  dependencies: Readonly<{ db: DirectDatabase }>,
) => Promise<ResolvedTargetRoom>;
type ResolveMemory = typeof resolveTaskMemoryEnvelope;
type ValidateMemoizedNamespaceTarget = (
  task: Task,
  db: DirectDatabase,
) => Promise<boolean>;

export type ProductionProtectedTaskPredispatchDependencies = Readonly<{
  db: DirectDatabase;
  resolver: PolicyResolver;
  /** Must converge every newly-created Room before the plan becomes usable. */
  convergeCreatedRoomCatalog(
    humans: readonly HumanRoomMember[],
  ): Promise<void>;
  getTaskById?: ReadTask;
  getTaskRunForTask?: ReadTaskRun;
  updateTask?: typeof updateTask;
  validateMemoizedNamespaceTarget?: ValidateMemoizedNamespaceTarget;
  resolveTargetRoom?: ResolveTarget;
  resolveTaskMemoryEnvelope?: ResolveMemory;
  findAgentOwnerPrivateRoom?: ProtectedTaskRequesterPrivateRoomResolver;
  assertCanInvokeAgent?: typeof assertCanInvokeAgent;
  assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  ensureInitialScope?: typeof ensureProtectedTaskPredispatchScope;
}>;

/** Create and attach a content-free Scope under the canonical Task→Run lock. */
export async function ensureProtectedTaskPredispatchScope(
  db: DirectDatabase,
  occurrence: ProtectedTaskOccurrence,
): Promise<string> {
  return db.transaction(async transaction => {
    const [task] = await transaction.select({
      id: tasks.id,
      requestorId: tasks.requestorId,
      agentId: tasks.agentId,
      scopeId: tasks.scopeId,
    }).from(tasks).where(and(
      eq(tasks.id, occurrence.task.id),
      eq(tasks.ownerId, occurrence.task.ownerId),
      eq(tasks.requestorId, occurrence.task.requestorId),
      eq(tasks.agentId, occurrence.task.agentId),
      occurrence.task.callingRoomId === null
        ? isNull(tasks.callingRoomId)
        : eq(tasks.callingRoomId, occurrence.task.callingRoomId),
      eq(tasks.scheduleKind, occurrence.task.scheduleKind),
      eq(tasks.contentRepresentation, occurrence.task.contentRepresentation),
      eq(tasks.contentNamespaceId, occurrence.task.contentNamespaceId),
      eq(tasks.contentRevision, occurrence.task.contentRevision),
      eq(tasks.cryptoObjectId, occurrence.task.cryptoObjectId),
      eq(tasks.cryptoAccessRevision, occurrence.task.cryptoAccessRevision),
      eq(
        tasks.cryptoRequiredNamespaceFingerprint,
        occurrence.task.cryptoRequiredNamespaceFingerprint,
      ),
      eq(tasks.cryptoMappingState, "verified"),
      inArray(tasks.status, ["pending", "awaiting", "running"]),
      eq(tasks.useScope, true),
    )).limit(2).for("update");
    const [run] = await transaction.select({ id: taskRuns.id })
      .from(taskRuns).where(and(
        eq(taskRuns.id, occurrence.run.id),
        eq(taskRuns.taskId, occurrence.task.id),
        isNull(taskRuns.jobId),
        eq(taskRuns.graphThreadId, occurrence.run.graphThreadId),
        eq(taskRuns.status, "awaiting"),
        eq(taskRuns.startedAt, occurrence.run.startedAt),
        isNull(taskRuns.modelId),
        isNull(taskRuns.resultText),
        isNull(taskRuns.completedAt),
        isNull(taskRuns.lastError),
        eq(taskRuns.resultRepresentation, "ordinary"),
        isNull(taskRuns.resultContentNamespaceId),
        eq(taskRuns.resultRevision, 0),
        isNull(taskRuns.resultCryptoObjectId),
        eq(taskRuns.resultCryptoAccessRevision, 0),
        isNull(taskRuns.resultCryptoRequiredNamespaceFingerprint),
        eq(taskRuns.resultCryptoMappingState, "unmapped"),
      )).limit(2).for("update");
    if (task === undefined || run === undefined) {
      throw new TypeError("Protected Task Scope creation is no longer current");
    }
    if (task.scopeId !== null) {
      await prepareProtectedTaskScope(transaction, {
        taskId: task.id,
        requesterUserId: task.requestorId,
        agentId: task.agentId,
        scopeId: task.scopeId,
      });
      return task.scopeId;
    }
    const scopeId = await prepareProtectedTaskScope(transaction, {
      taskId: task.id,
      requesterUserId: task.requestorId,
      agentId: task.agentId,
      scopeId: null,
    });
    const [updated] = await transaction.update(tasks).set({ scopeId }).where(and(
      eq(tasks.id, task.id),
      eq(tasks.useScope, true),
      isNull(tasks.scopeId),
    )).returning({ scopeId: tasks.scopeId });
    if (updated === undefined || updated.scopeId !== scopeId) {
      throw new TypeError("Protected Task Scope attachment conflicted");
    }
    // The Scope row is already held by insertion or the exact conflict read.
    // Verify the returned Task references that same still-open owner.
    const [scope] = await transaction.select({ id: agentScopes.id })
      .from(agentScopes).where(and(
        eq(agentScopes.id, scopeId),
        eq(agentScopes.parentAgentId, task.agentId),
        eq(agentScopes.speakerUserId, task.requestorId),
        eq(agentScopes.name, `task:${task.id}`),
        eq(agentScopes.lifecycleState, "open"),
      )).limit(2).for("share");
    if (scope === undefined) {
      throw new TypeError("Protected Task Scope attachment is unavailable");
    }
    return scopeId;
  });
}

async function validateMemoizedNamespaceTarget(
  task: Task,
  db: DirectDatabase,
): Promise<boolean> {
  if (task.targetRoomId === null) return false;
  const members = await db.select({
    roomId: rooms.id,
    humanActorIds: rooms.humanActorIds,
    actorId: actors.id,
    actorKind: actors.kind,
    actorOwnerId: actors.ownerId,
    actorAgentId: actors.agentId,
  }).from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .innerJoin(actors, eq(actors.id, roomMembers.actorId))
    .where(and(
      eq(rooms.id, task.targetRoomId),
      eq(rooms.ownerId, task.ownerId),
      isNull(rooms.archivedAt),
      inArray(rooms.kind, ["private", "group", "multi_agent", "open"]),
      privateNamespaceBoundarySql(rooms.namespaceId),
    ));
  const room = members[0];
  if (room === undefined) return false;
  const humans = members.filter(member => member.actorKind === "user");
  const projectedHumans = [...new Set(room.humanActorIds)].sort();
  const actualHumans = [...new Set(humans.map(member => member.actorId))].sort();
  if (projectedHumans.length !== actualHumans.length
    || projectedHumans.some((actorId, index) => actorId !== actualHumans[index])) {
    return false;
  }
  const expectedUsers = new Set([task.requestorId, ...task.targetUserIds]);
  return [...expectedUsers].every(userId => humans.some(
    member => member.actorOwnerId === userId,
  )) && members.some(member =>
    member.actorKind === "agent" && member.actorAgentId === task.agentId
  );
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isExactAwaitingOccurrence(
  occurrence: ProtectedTaskOccurrence,
  task: Task,
  run: TaskRun,
): boolean {
  return task.id === occurrence.task.id
    && task.ownerId === occurrence.task.ownerId
    && task.requestorId === occurrence.task.requestorId
    && task.agentId === occurrence.task.agentId
    && task.callingRoomId === occurrence.task.callingRoomId
    && task.scheduleKind === occurrence.task.scheduleKind
    && task.contentRepresentation === occurrence.task.contentRepresentation
    && task.contentNamespaceId === occurrence.task.contentNamespaceId
    && task.contentRevision === occurrence.task.contentRevision
    && task.cryptoObjectId === occurrence.task.cryptoObjectId
    && task.cryptoAccessRevision === occurrence.task.cryptoAccessRevision
    && sameBytes(
      task.cryptoRequiredNamespaceFingerprint,
      occurrence.task.cryptoRequiredNamespaceFingerprint,
    )
    && task.cryptoMappingState === "verified"
    && (task.status === "pending"
      || task.status === "awaiting"
      || task.status === "running")
    && run.id === occurrence.run.id
    && run.taskId === task.id
    && run.jobId === null
    && run.graphThreadId === occurrence.run.graphThreadId
    && run.status === "awaiting"
    && run.startedAt.getTime() === occurrence.run.startedAt.getTime()
    && run.modelId === null
    && run.resultText === null
    && run.completedAt === null
    && run.lastError === null
    && run.resultRepresentation === "ordinary"
    && run.resultContentNamespaceId === null
    && run.resultRevision === 0
    && run.resultCryptoObjectId === null
    && run.resultCryptoAccessRevision === 0
    && run.resultCryptoRequiredNamespaceFingerprint === null
    && run.resultCryptoMappingState === "unmapped";
}

function sameTargetAndMemoryInputs(
  before: Task,
  after: Task,
  resolvedRoomId: string,
): boolean {
  const targetUsersWereExtended = before.targetUserIds.every(
    userId => after.targetUserIds.includes(userId),
  ) && new Set(after.targetUserIds).size === after.targetUserIds.length;
  const addedTargetUsers = after.targetUserIds.filter(
    userId => !before.targetUserIds.includes(userId),
  );
  const mayResolveOneDmPeer = before.targetRoomId === null
    && (before.targetChat === "last_dm" || before.targetChat === "new_dm");
  const targetUsersAreExact = targetUsersWereExtended
    && (addedTargetUsers.length === 0
      || mayResolveOneDmPeer && addedTargetUsers.length === 1);
  const persistedTargetIsExact = before.targetChat === "orphan"
      || before.targetChat === "last_dm"
      || before.targetChat === "new_dm"
    ? after.targetRoomId === resolvedRoomId
    : after.targetRoomId === null || after.targetRoomId === resolvedRoomId;
  return after.id === before.id
    && after.ownerId === before.ownerId
    && after.requestorId === before.requestorId
    && after.agentId === before.agentId
    && after.callingRoomId === before.callingRoomId
    && after.scheduleKind === before.scheduleKind
    && after.status === before.status
    && after.preset === before.preset
    && after.targetChat === before.targetChat
    && after.targetChatHandle === before.targetChatHandle
    && after.useScope === before.useScope
    && after.scopeId === before.scopeId
    && after.contentRepresentation === before.contentRepresentation
    && after.contentNamespaceId === before.contentNamespaceId
    && after.contentRevision === before.contentRevision
    && after.cryptoObjectId === before.cryptoObjectId
    && after.cryptoAccessRevision === before.cryptoAccessRevision
    && sameBytes(
      after.cryptoRequiredNamespaceFingerprint,
      before.cryptoRequiredNamespaceFingerprint!,
    )
    && after.cryptoMappingState === before.cryptoMappingState
    && persistedTargetIsExact
    && (before.targetRoomId === null
      || before.targetRoomId === resolvedRoomId
        && after.targetRoomId === before.targetRoomId)
    && targetUsersAreExact;
}

/**
 * Compose the live server predispatch boundary for one closed protected Task
 * occurrence. It reads only operational Task/TaskRun rows and leaves protected
 * definition content to the later grant authority.
 */
export function createProductionProtectedTaskPredispatch(
  dependencies: ProductionProtectedTaskPredispatchDependencies,
): (occurrence: ProtectedTaskOccurrence) => Promise<ProtectedTaskPredispatchPlan> {
  const readTask = dependencies.getTaskById ?? getTaskById;
  const readRun = dependencies.getTaskRunForTask ?? getTaskRunForTask;
  const targetResolver = dependencies.resolveTargetRoom ?? resolveTargetRoom;
  const persistTask = dependencies.updateTask ?? updateTask;
  const validatePinnedNamespace = dependencies.validateMemoizedNamespaceTarget
    ?? validateMemoizedNamespaceTarget;
  const memoryResolver = dependencies.resolveTaskMemoryEnvelope
    ?? resolveTaskMemoryEnvelope;
  const resolveRequesterPrivateRoom = dependencies.findAgentOwnerPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(dependencies.db);
  const assertInvocation = dependencies.assertCanInvokeAgent
    ?? assertCanInvokeAgent;
  const assertFunding = dependencies.assertCanUseServerProviderCredentials
    ?? assertCanUseServerProviderCredentials;
  const ensureInitialScope = dependencies.ensureInitialScope
    ?? ensureProtectedTaskPredispatchScope;
  const assertOperationalAuthority = async (authority: Readonly<{
    taskId: string;
    requestorId: string;
    agentId: string;
    memoizedRoomId: string | null;
  }>): Promise<void> => {
    await assertInvocation({
      humanUserId: authority.requestorId,
      origin: "task_dispatch",
      taskId: authority.taskId,
      agentId: authority.agentId,
      ...(authority.memoizedRoomId
        ? { roomId: authority.memoizedRoomId }
        : {}),
    });
    await assertFunding(authority.requestorId, "task_dispatch");
  };

  return async occurrence => {
    const [loadedTask, run] = await Promise.all([
      readTask(dependencies.db, occurrence.task.id),
      readRun(dependencies.db, occurrence.task.id, occurrence.run.id),
    ]);
    if (loadedTask === undefined || run === undefined
      || !isExactAwaitingOccurrence(occurrence, loadedTask, run)) {
      throw new TypeError("Protected Task occurrence is no longer current");
    }

    let task = loadedTask;
    if (loadedTask.useScope && loadedTask.scopeId === null) {
      await assertOperationalAuthority({
        taskId: loadedTask.id,
        requestorId: loadedTask.requestorId,
        agentId: loadedTask.agentId,
        memoizedRoomId: loadedTask.targetRoomId,
      });
      task = {
        ...loadedTask,
        scopeId: await ensureInitialScope(dependencies.db, occurrence),
      };
    }
    if (!isExactAwaitingOccurrence(occurrence, task, run)
      || task.useScope && task.scopeId === null) {
      throw new TypeError("Protected Task Scope creation changed its occurrence");
    }

    let currentTask = task;
    let targetResolved = false;
    return planProtectedTaskPredispatch({
      task,
      run,
      ports: {
        assertCurrentAuthority: assertOperationalAuthority,
        resolveTargetRoom: async () => {
          if (targetResolved) {
            throw new TypeError("Protected Task target was resolved more than once");
          }
          targetResolved = true;
          const pinnedNamespace = task.targetRoomId !== null
            && (task.targetChat === "last_in_namespace"
              || task.targetChat === "new_in_namespace");
          if (pinnedNamespace
            && !await validatePinnedNamespace(task, dependencies.db)) {
            throw new TypeError("Protected Task memoized target is unavailable");
          }
          // Protected runs already own their closed graphThreadId. The
          // ResolvedTargetRoom thread is therefore only a complete structural
          // value here; harness-specific ordinary Task queues cannot replace
          // the protected occurrence's preallocated execution identity.
          const resolved = pinnedNamespace
            ? {
                roomId: task.targetRoomId!,
                graphThreadId: botThreadId(task.targetRoomId!, task.agentId),
              }
            : await targetResolver(task, { db: dependencies.db });
          const [refreshedTask, refreshedRun] = await Promise.all([
            readTask(dependencies.db, occurrence.task.id),
            readRun(dependencies.db, occurrence.task.id, occurrence.run.id),
          ]);
          if (refreshedTask === undefined || refreshedRun === undefined
            || !isExactAwaitingOccurrence(occurrence, refreshedTask, refreshedRun)
            || !sameTargetAndMemoryInputs(task, refreshedTask, resolved.roomId)) {
            throw new TypeError("Protected Task target resolution drifted");
          }
          let memoizedTask = refreshedTask;
          if (refreshedTask.targetRoomId === null) {
            await persistTask(dependencies.db, refreshedTask.id, {
              targetRoomId: resolved.roomId,
            });
            const [persistedTask, persistedRun] = await Promise.all([
              readTask(dependencies.db, occurrence.task.id),
              readRun(dependencies.db, occurrence.task.id, occurrence.run.id),
            ]);
            if (persistedTask === undefined || persistedRun === undefined
              || !isExactAwaitingOccurrence(
                occurrence,
                persistedTask,
                persistedRun,
              )
              || !sameTargetAndMemoryInputs(
                refreshedTask,
                persistedTask,
                resolved.roomId,
              )
              || persistedTask.targetRoomId !== resolved.roomId) {
              throw new TypeError("Protected Task target memoization drifted");
            }
            memoizedTask = persistedTask;
          }
          if (memoizedTask.targetRoomId !== resolved.roomId) {
            throw new TypeError("Protected Task target is not memoized");
          }
          if (resolved.createdHumanRoomMembers !== undefined
            && resolved.createdHumanRoomMembers.length > 0) {
            await dependencies.convergeCreatedRoomCatalog(
              resolved.createdHumanRoomMembers,
            );
          }
          currentTask = memoizedTask;
          return {
            roomId: resolved.roomId,
            targetUserIds: memoizedTask.targetUserIds,
          };
        },
        resolveMemoryEnvelope: async input => {
          if (!targetResolved) {
            throw new TypeError("Protected Task target is unresolved");
          }
          let sessionRoomId = input.sessionRoomId;
          let scopeOrigin: Readonly<{
            roomId: string;
            namespaceId: string;
          }> | null = null;
          if (currentTask.useScope
            && currentTask.targetChat === "orphan"
            && sessionRoomId.length === 0) {
            if (currentTask.contentNamespaceId === null) {
              throw new TypeError(
                "Protected Task Scope Memory origin is unavailable",
              );
            }
            scopeOrigin = await resolveRequesterPrivateRoom(
              currentTask.requestorId,
              currentTask.agentId,
              currentTask.contentNamespaceId,
            );
            if (scopeOrigin === null
              || scopeOrigin.namespaceId !== currentTask.contentNamespaceId) {
              throw new TypeError(
                "Protected Task Scope Memory origin is unavailable",
              );
            }
            sessionRoomId = scopeOrigin.roomId;
          }
          const resolved = await memoryResolver({
            task: currentTask,
            db: dependencies.db,
            resolver: dependencies.resolver,
            laneKey: input.laneKey,
            sessionRoomId,
            targetUserIds: input.targetUserIds,
          });
          if (scopeOrigin !== null
            && (resolved.envelope.memoryMode !== "scope"
              || resolved.envelope.roomId !== scopeOrigin.roomId
              || !("originWritableNamespaceId" in resolved.envelope)
              || resolved.envelope.originWritableNamespaceId
                !== scopeOrigin.namespaceId)) {
            throw new TypeError(
              "Protected Task Scope Memory origin changed",
            );
          }
          const [refreshedTask, refreshedRun] = await Promise.all([
            readTask(dependencies.db, occurrence.task.id),
            readRun(dependencies.db, occurrence.task.id, occurrence.run.id),
          ]);
          if (refreshedTask === undefined || refreshedRun === undefined
            || !isExactAwaitingOccurrence(
              occurrence,
              refreshedTask,
              refreshedRun,
            )
            || !sameTargetAndMemoryInputs(
              currentTask,
              refreshedTask,
              currentTask.targetRoomId!,
            )) {
            throw new TypeError("Protected Task Memory resolution drifted");
          }
          return resolved;
        },
      },
    });
  };
}
