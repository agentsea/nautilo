import { getRelayRegistry } from "@nautilo/agent";
import { parseRelayLocalExecutionCapability, RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION } from "@nautilo/relay";
import { parseLocalExecutionDelegation, type LocalExecutionDelegation } from "@nautilo/types";
import type { Task, TaskRun } from "@nautilo/db";

export type DelegatedTaskIdentity = Pick<Task, "id" | "ownerId" | "requestorId" | "agentId" | "callingRoomId"
  | "parentTaskId" | "targetRoomId" | "scheduleKind" | "status" | "localExecutionDelegation" | "contentRepresentation" | "contentRevision"> & Partial<Pick<Task, "lastError">>;
export interface TaskLocalExecutionSource {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly humanUserId: string;
  readonly agentId: string;
  readonly signal: AbortSignal;
  readTask(id: string): Promise<DelegatedTaskIdentity | undefined>;
  readRun(taskId: string, runId: string): Promise<Pick<TaskRun, "id" | "taskId" | "status"> | undefined>;
  /** Fresh canonical Room/Agent/use_workstation checks and current content
   * authorization. Protected callers must borrow their live Task owner. */
  assertSource(task: DelegatedTaskIdentity): Promise<void>;
  subscribeChanges?(check: () => void): () => void;
  /** Canonical latest-run marker proof; never permits a new command. */
  readAutomaticOfflineWait?(taskId: string): Promise<{ taskRunId: string } | null>;
}
const identitySnapshot = (task: DelegatedTaskIdentity) => ({
  id: task.id, ownerId: task.ownerId, requestorId: task.requestorId, agentId: task.agentId,
  callingRoomId: task.callingRoomId, targetRoomId: task.targetRoomId, parentTaskId: task.parentTaskId,
  status: task.status, scheduleKind: task.scheduleKind, lastError: task.lastError,
  contentRepresentation: task.contentRepresentation, contentRevision: task.contentRevision,
  localExecutionDelegation: task.localExecutionDelegation,
});
const unavailable = () => new Error("TASK_LOCAL_EXECUTION_AUTHORITY_UNAVAILABLE");
const sameTarget = (left: LocalExecutionDelegation, right: LocalExecutionDelegation) =>
  left.humanUserId === right.humanUserId && left.sourceRoomId === right.sourceRoomId
  && left.sourceConversationId === right.sourceConversationId && left.rootTaskId === right.rootTaskId
  && left.projectGrantId === right.projectGrantId && left.ceiling === right.ceiling
  && JSON.stringify(left.target) === JSON.stringify(right.target) && JSON.stringify(left.profile) === JSON.stringify(right.profile);

/** Canonical lineage, read from Task rows. A supplied parent id is never proof.
 * Completed parents may have intentionally scheduled later work; cancelled or
 * definition-invalidated parents cannot continue to lend their authority. */
export async function readTaskLocalExecutionLineage(source: TaskLocalExecutionSource, requireActiveRun = true) {
  return readLineage(source, requireActiveRun ? "active" : "retained");
}
async function readLineage(source: TaskLocalExecutionSource, mode: "active" | "retained" | "offline_wait") {
  const requireActiveRun = mode === "active";
  source.signal.throwIfAborted();
  const task = await source.readTask(source.taskId);
  const delegation = parseLocalExecutionDelegation(task?.localExecutionDelegation);
  const run = await source.readRun(source.taskId, source.taskRunId);
  const automaticWait = mode === "retained" && (task?.status === "paused" || task?.status === "pending")
    ? await source.readAutomaticOfflineWait?.(task.id) : null;
  if (!task || !delegation || task.requestorId !== source.humanUserId || task.agentId !== source.agentId
    || delegation.humanUserId !== source.humanUserId || delegation.agentId !== source.agentId
    || (task.status !== "running" && !(task.status === "pending" && task.scheduleKind === "cron")
      && !(!requireActiveRun && (task.status === "completed" || task.status === "awaiting"))
      && !(mode === "offline_wait" && (task.status === "paused" || task.status === "pending"))
      && !automaticWait)
    || !run || run.id !== source.taskRunId || run.taskId !== source.taskId
    || (run.status !== "running" && !(!requireActiveRun && (run.status === "completed" || run.status === "awaiting"))
      && !(mode === "offline_wait" && run.status === "paused")
      && !(automaticWait?.taskRunId === run.id && run.status === "paused"))) throw unavailable();
  const lineage: DelegatedTaskIdentity[] = [task];
  const seen = new Set([task.id]);
  let parent = task;
  while (parent.id !== delegation.rootTaskId) {
    if (!parent.parentTaskId || seen.has(parent.parentTaskId)) throw unavailable();
    seen.add(parent.parentTaskId);
    const next = await source.readTask(parent.parentTaskId);
    const authority = parseLocalExecutionDelegation(next?.localExecutionDelegation);
    const ancestorWait = mode === "retained" && next?.status === "paused"
      ? await source.readAutomaticOfflineWait?.(next.id) : null;
    if (!next || !authority || authority.agentId !== next.agentId || authority.humanUserId !== next.requestorId
      || next.ownerId !== task.ownerId || next.requestorId !== task.requestorId
      || (parent.callingRoomId !== next.callingRoomId && parent.callingRoomId !== next.targetRoomId)
      || ["cancelled", "errored"].includes(next.status) || (next.status === "paused" && !ancestorWait)
      || !sameTarget(delegation, authority)) throw unavailable();
    lineage.push(next); parent = next;
  }
  if (parent.parentTaskId !== null || parent.callingRoomId !== delegation.sourceRoomId) throw unavailable();
  for (const member of lineage) await source.assertSource(member);
  // Source checks can await network/crypto work. Close that window with fresh
  // canonical rows before letting the caller dispatch against this definition.
  const refreshed = await Promise.all(lineage.map(member => source.readTask(member.id)));
  const currentRun = await source.readRun(source.taskId, source.taskRunId);
  if (refreshed.some((member, index) => !member || JSON.stringify(identitySnapshot(member)) !== JSON.stringify(identitySnapshot(lineage[index]!)))
    || !currentRun || currentRun.id !== run.id || currentRun.taskId !== run.taskId || currentRun.status !== run.status) throw unavailable();
  if (mode === "retained") {
    for (const member of refreshed) {
      if (member?.status === "paused" && !await source.readAutomaticOfflineWait?.(member.id)) throw unavailable();
    }
  }
  source.signal.throwIfAborted();
  return { task, delegation, lineage };
}

/** One run-local closure, never serialized. Every operation is bracketed by
 * fresh source reads; denial after an effect aborts its owning signal and
 * suppresses bytes, without retrying or inventing a successful outcome. */
export function createTaskLocalExecutionAdmission(source: TaskLocalExecutionSource) {
  const revoked = new AbortController();
  const signal = AbortSignal.any([source.signal, revoked.signal]);
  const currentSource = { ...source, signal };
  const snapshot = (value: Awaited<ReturnType<typeof readTaskLocalExecutionLineage>>) => JSON.stringify({
    delegation: value.delegation,
    lineage: value.lineage.map(task => ({ id: task.id, ownerId: task.ownerId, requestorId: task.requestorId,
      agentId: task.agentId, callingRoomId: task.callingRoomId, parentTaskId: task.parentTaskId,
      contentRepresentation: task.contentRepresentation, contentRevision: task.contentRevision,
      localExecutionDelegation: task.localExecutionDelegation })),
  });
  let references = 0;
  let unsubscribe: (() => void) | undefined;
  let checking: Promise<void> | undefined;
  let again = false;
  const checkCurrent = () => {
    again = true;
    if (checking) return;
    checking = (async () => {
      while (again && !signal.aborted) {
        again = false;
        try { await readTaskLocalExecutionLineage(currentSource, false); }
        catch (error) { revoked.abort(error); }
      }
    })().finally(() => { checking = undefined; if (again && references > 0 && !signal.aborted) checkCurrent(); });
  };
  const retain = () => {
    references++;
    if (references === 1 && !signal.aborted) unsubscribe = source.subscribeChanges?.(checkCurrent);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--references === 0) { unsubscribe?.(); unsubscribe = undefined; }
    };
  };
  signal.addEventListener("abort", () => { unsubscribe?.(); unsubscribe = undefined; }, { once: true });
  return {
    signal,
    retain,
    taskId: source.taskId,
    taskRunId: source.taskRunId,
    async withAdmission<Value>(work: (delegation: LocalExecutionDelegation, signal: AbortSignal) => Promise<Value>, requireActiveRun = true): Promise<Value> {
      const release = retain();
      try {
        let before: Awaited<ReturnType<typeof readTaskLocalExecutionLineage>>;
        try { before = await readTaskLocalExecutionLineage(currentSource, requireActiveRun); }
        catch (error) {
          // A normally completed run cannot submit more input, but that refusal
          // is not revocation of a command it already started.
          try { await readTaskLocalExecutionLineage(currentSource, false); }
          catch (sourceError) { revoked.abort(sourceError); }
          throw error;
        }
        let result: Value;
        try { result = await work(before.delegation, signal); }
        catch (error) {
          // A lost receipt is not a deadline. Independently proven source loss
          // still revokes retained work even when transport also failed.
          try {
            const after = await readTaskLocalExecutionLineage(currentSource, false);
            if (snapshot(before) !== snapshot(after)) revoked.abort(unavailable());
          } catch (sourceError) { revoked.abort(sourceError); }
          throw error;
        }
        try {
          const after = await readTaskLocalExecutionLineage(currentSource, false);
          if (snapshot(before) !== snapshot(after)) throw unavailable();
        } catch (error) { revoked.abort(error); throw error; }
        return result;
      } finally { release(); }
    },
  };
}

/** Adapt the source owner without persisting a callback or pretending that a
 * background invocation has a foreground Electron origin. */
export function createDelegatedLocalExecutionPort(source: TaskLocalExecutionSource): import("@nautilo/agent").DelegatedLocalExecutionPort {
  const admission = createTaskLocalExecutionAdmission(source);
  return {
    taskId: source.taskId,
    taskRunId: source.taskRunId,
    signal: admission.signal,
    retain: admission.retain,
    withAdmission: (operation, work) => admission.withAdmission(
      (delegation, signal) => work({ delegation, signal, taskId: source.taskId, taskRunId: source.taskRunId }),
      operation === "start" || operation === "input",
    ),
  };
}

/** Dependency composition for the existing Task runner. This stores no Task
 * authority: every run receives a new source closure and canonical row reads. */
export interface TaskLocalExecutionSourceComposition {
  assertSource(task: DelegatedTaskIdentity): Promise<void>;
  subscribeChanges(check: () => void): () => void;
}
let sourceComposition: TaskLocalExecutionSourceComposition | undefined;
export function setTaskLocalExecutionSourceComposition(value: TaskLocalExecutionSourceComposition | undefined): void {
  sourceComposition = value;
}
export async function resolveTaskLocalExecutionPort(input: {
  db: import("@nautilo/db").DirectDatabase; taskId: string; taskRunId: string; signal: AbortSignal;
}): Promise<import("@nautilo/agent").DelegatedLocalExecutionPort | undefined> {
  const { getTaskById, getTaskRunForTask, getLatestResumableTaskRun, isTaskLocalExecutionOfflineWait,
    TASK_LOCAL_EXECUTION_OFFLINE_TEXT } = await import("@nautilo/db");
  const task = await getTaskById(input.db, input.taskId);
  if (!task?.localExecutionDelegation) return undefined;
  const composition = sourceComposition;
  if (!composition) throw unavailable();
  const port = createDelegatedLocalExecutionPort({ taskId: task.id, taskRunId: input.taskRunId,
    humanUserId: task.requestorId, agentId: task.agentId, signal: input.signal,
    readTask: id => getTaskById(input.db, id),
    readRun: (taskId, runId) => getTaskRunForTask(input.db, taskId, runId),
    assertSource: async current => {
      if (sourceComposition !== composition) throw unavailable();
      await composition.assertSource(current);
      if (sourceComposition !== composition) throw unavailable();
    },
    subscribeChanges: check => composition.subscribeChanges(check),
    readAutomaticOfflineWait: async taskId => {
      const current = await getTaskById(input.db, taskId);
      const latest = await getLatestResumableTaskRun(input.db, taskId);
      return (current?.status === "paused" || current?.status === "pending") && current.lastError === TASK_LOCAL_EXECUTION_OFFLINE_TEXT
        && latest && isTaskLocalExecutionOfflineWait(current, latest) ? { taskRunId: latest.id } : null;
    },
  });
  await port.withAdmission("read", () => Promise.resolve(undefined));
  return port;
}


/** Discovery can delay an exact target; it never authorizes a command or picks
 * another Mac. The Desktop still resolves the durable grant on every effect. */
export function isTaskLocalExecutionTargetAvailable(delegation: LocalExecutionDelegation): boolean {
  const registry = getRelayRegistry();
  const relayId = delegation.target.relayId;
  const capabilities = registry?.getCapabilities(relayId);
  return registry !== null && registry !== undefined && capabilities?.profile === "desktop-agent"
    && capabilities.canDelegateLocalExecution === true && capabilities.canExecuteLocal === true
    && parseRelayLocalExecutionCapability(capabilities.localExecution) !== null
    && (registry.getProtocolVersion?.(relayId) ?? 0) >= RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION
    && registry.getUserId?.(relayId) === delegation.humanUserId
    && registry.getPairingGeneration?.(relayId) === delegation.target.pairingGeneration
    && registry.isRelayHeartbeatFresh?.(relayId) === true
    && Boolean(registry.getDesktopSessionId?.(relayId)) && Boolean(registry.getLocalExecutionPairingGeneration?.(relayId));
}

/** Read-only recovery of a DB-verified pre-effect wait. This does not return
 * an execution port, and ordinary paused Tasks cannot satisfy its marker. */
export async function isTaskLocalExecutionOfflineSourceReady(input: {
  db: import("@nautilo/db").DirectDatabase; task: Task; run: TaskRun;
}): Promise<boolean> {
  const { getTaskById, getTaskRunForTask, isTaskLocalExecutionOfflineWait } = await import("@nautilo/db");
  const composition = sourceComposition;
  if (!composition || !isTaskLocalExecutionOfflineWait(input.task, input.run)) return false;
  try {
    const source = await readLineage({ taskId: input.task.id, taskRunId: input.run.id,
      humanUserId: input.task.requestorId, agentId: input.task.agentId, signal: new AbortController().signal,
      readTask: id => getTaskById(input.db, id), readRun: (taskId, runId) => getTaskRunForTask(input.db, taskId, runId),
      assertSource: task => composition.assertSource(task),
    }, "offline_wait");
    const run = await getTaskRunForTask(input.db, input.task.id, input.run.id);
    const task = await getTaskById(input.db, input.task.id);
    return sourceComposition === composition && Boolean(task && run && isTaskLocalExecutionOfflineWait(task, run))
      && isTaskLocalExecutionTargetAvailable(source.delegation);
  } catch { return false; }
}
