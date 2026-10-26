import {
  and,
  eq,
  taskRuns,
  tasks,
  type DirectDatabase,
  type Task,
  type TaskRun,
} from "@nautilo/db";
import {
  createDelegatedLocalExecutionPort,
  isTaskLocalExecutionTargetAvailable,
  type DelegatedTaskIdentity,
  type ProtectedTaskAuthorityOccurrence,
} from "@nautilo/runtime";
import { parseLocalExecutionDelegation } from "@nautilo/types";

import {
  assertCurrentTaskLocalExecutionPublicSource,
  type TaskLocalExecutionSourceAssertionDeps,
} from "../local-execution-task-source";

type LocalTask = Readonly<Pick<Task,
  | "id" | "ownerId" | "requestorId" | "agentId" | "callingRoomId"
  | "parentTaskId" | "targetRoomId" | "scheduleKind" | "status"
  | "localExecutionDelegation" | "contentRepresentation" | "contentNamespaceId"
  | "contentRevision" | "cryptoObjectId" | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint" | "cryptoMappingState">>;
type LocalRun = Readonly<Pick<TaskRun, "id" | "taskId" | "jobId" | "graphThreadId" | "status">>;

export type ProtectedTaskLocalExecutionReadiness =
  | Readonly<{ status: "not_required" }>
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "waiting" }>;

export interface ProtectedTaskLocalExecutionDependencies {
  readTask?(this: void, id: string): Promise<LocalTask | undefined>;
  readRun?(this: void, taskId: string, runId: string): Promise<LocalRun | undefined>;
  assertPublicSource?: typeof assertCurrentTaskLocalExecutionPublicSource;
  publicSource?: Pick<TaskLocalExecutionSourceAssertionDeps,
    "signal" | "assertInvocation" | "getCapabilities" | "findHuman" | "findRoom" | "findRoomByThread">;
  isTargetAvailable?(this: void, delegation: NonNullable<ReturnType<typeof parseLocalExecutionDelegation>>): boolean;
  subscribeChanges?(this: void, check: () => void): () => void;
}

const taskProjection = {
  id: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId,
  agentId: tasks.agentId, callingRoomId: tasks.callingRoomId,
  parentTaskId: tasks.parentTaskId, targetRoomId: tasks.targetRoomId,
  scheduleKind: tasks.scheduleKind, status: tasks.status,
  localExecutionDelegation: tasks.localExecutionDelegation,
  contentRepresentation: tasks.contentRepresentation,
  contentNamespaceId: tasks.contentNamespaceId,
  contentRevision: tasks.contentRevision, cryptoObjectId: tasks.cryptoObjectId,
  cryptoAccessRevision: tasks.cryptoAccessRevision,
  cryptoRequiredNamespaceFingerprint: tasks.cryptoRequiredNamespaceFingerprint,
  cryptoMappingState: tasks.cryptoMappingState,
} as const;

async function readTask(db: DirectDatabase, id: string): Promise<LocalTask | undefined> {
  const [row] = await db.select(taskProjection).from(tasks).where(eq(tasks.id, id)).limit(1);
  return row;
}

async function readRun(db: DirectDatabase, taskId: string, runId: string): Promise<LocalRun | undefined> {
  const [row] = await db.select({ id: taskRuns.id, taskId: taskRuns.taskId,
    jobId: taskRuns.jobId, graphThreadId: taskRuns.graphThreadId, status: taskRuns.status })
    .from(taskRuns).where(and(eq(taskRuns.id, runId), eq(taskRuns.taskId, taskId))).limit(1);
  return row;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactOccurrence(task: LocalTask, run: LocalRun, occurrence: ProtectedTaskAuthorityOccurrence): boolean {
  return task.id === occurrence.task.id && task.ownerId === occurrence.task.ownerId
    && task.requestorId === occurrence.task.requestorId && task.agentId === occurrence.task.agentId
    && task.callingRoomId === occurrence.task.callingRoomId
    && task.scheduleKind === occurrence.task.scheduleKind
    && task.contentRepresentation === occurrence.task.contentRepresentation
    && task.contentNamespaceId === occurrence.task.contentNamespaceId
    && task.contentRevision === occurrence.task.contentRevision
    && task.cryptoObjectId === occurrence.task.cryptoObjectId
    && task.cryptoAccessRevision === occurrence.task.cryptoAccessRevision
    && task.cryptoMappingState === "verified"
    && sameBytes(task.cryptoRequiredNamespaceFingerprint,
      occurrence.task.cryptoRequiredNamespaceFingerprint)
    && run.id === occurrence.run.id && run.taskId === occurrence.run.taskId
    && run.jobId === occurrence.run.jobId && run.graphThreadId === occurrence.run.graphThreadId
    && run.status === occurrence.run.status;
}

function asDelegatedTask(task: LocalTask): DelegatedTaskIdentity {
  return task;
}

async function current(
  db: DirectDatabase,
  occurrence: ProtectedTaskAuthorityOccurrence,
  dependencies: ProtectedTaskLocalExecutionDependencies,
): Promise<{ task: LocalTask; run: LocalRun }> {
  const loadTask = dependencies.readTask ?? (id => readTask(db, id));
  const loadRun = dependencies.readRun ?? ((taskId, runId) => readRun(db, taskId, runId));
  const [task, run] = await Promise.all([
    loadTask(occurrence.task.id), loadRun(occurrence.task.id, occurrence.run.id),
  ]);
  if (!task || !run || !exactOccurrence(task, run, occurrence)) {
    throw new TypeError("Protected Task local execution occurrence changed");
  }
  return { task, run };
}

async function assertPublic(
  task: LocalTask,
  dependencies: ProtectedTaskLocalExecutionDependencies,
  signal?: AbortSignal,
): Promise<NonNullable<ReturnType<typeof parseLocalExecutionDelegation>>> {
  const delegation = parseLocalExecutionDelegation(task.localExecutionDelegation);
  if (!delegation) throw new TypeError("Protected Task local execution delegation is invalid");
  await (dependencies.assertPublicSource ?? assertCurrentTaskLocalExecutionPublicSource)(
    asDelegatedTask(task), delegation, { ...dependencies.publicSource,
      ...(signal === undefined ? {} : { signal }) },
  );
  return delegation;
}

/** Pre-claim gate. Waiting creates no Job, claims no grant, and starts no run. */
export async function inspectProtectedTaskLocalExecutionReadiness(input: Readonly<{
  db: DirectDatabase;
  occurrence: ProtectedTaskAuthorityOccurrence;
  signal?: AbortSignal;
}>, dependencies: ProtectedTaskLocalExecutionDependencies = {}): Promise<ProtectedTaskLocalExecutionReadiness> {
  input.signal?.throwIfAborted();
  const { task } = await current(input.db, input.occurrence, dependencies);
  if (task.localExecutionDelegation === null) return Object.freeze({ status: "not_required" });
  const delegation = await assertPublic(task, dependencies, input.signal);
  input.signal?.throwIfAborted();
  return Object.freeze({ status: (dependencies.isTargetAvailable ?? isTaskLocalExecutionTargetAvailable)(delegation)
    ? "ready" : "waiting" });
}

/** Grant-bound adapter. Every delegated effect is bracketed by both current
 * protected authority and fresh public Task/Room/workstation lineage. */
export async function resolveProtectedTaskLocalExecutionPort(input: Readonly<{
  db: DirectDatabase;
  occurrence: ProtectedTaskAuthorityOccurrence;
  signal: AbortSignal;
  assertCurrentTaskAuthority(): Promise<void>;
}>, dependencies: ProtectedTaskLocalExecutionDependencies = {}) {
  const initial = await current(input.db, input.occurrence, dependencies);
  const delegation = parseLocalExecutionDelegation(initial.task.localExecutionDelegation);
  if (!delegation) return undefined;
  await assertPublic(initial.task, dependencies, input.signal);
  if (!(dependencies.isTargetAvailable ?? isTaskLocalExecutionTargetAvailable)(delegation)) {
    throw new TypeError("Protected Task local execution target is unavailable");
  }
  const loadTask = dependencies.readTask ?? (id => readTask(input.db, id));
  const loadRun = dependencies.readRun ?? ((taskId, runId) => readRun(input.db, taskId, runId));
  const port = createDelegatedLocalExecutionPort({
    taskId: initial.task.id,
    taskRunId: initial.run.id,
    humanUserId: initial.task.requestorId,
    agentId: initial.task.agentId,
    signal: input.signal,
    readTask: async id => {
      const found = await loadTask(id);
      return found === undefined ? undefined : asDelegatedTask(found);
    },
    readRun: async (taskId, runId) => loadRun(taskId, runId),
    assertSource: async task => {
      await input.assertCurrentTaskAuthority();
      const found = await loadTask(task.id);
      if (!found) throw new TypeError("Protected Task local execution source changed");
      const currentDelegation = await assertPublic(found, dependencies, input.signal);
      if (!(dependencies.isTargetAvailable ?? isTaskLocalExecutionTargetAvailable)(currentDelegation)) {
        throw new TypeError("Protected Task local execution target is unavailable");
      }
      await input.assertCurrentTaskAuthority();
    },
    ...(dependencies.subscribeChanges === undefined
      ? {} : { subscribeChanges: (check: () => void) => dependencies.subscribeChanges!(check) }),
  });
  await port.withAdmission("read", () => Promise.resolve(undefined));
  return port;
}
