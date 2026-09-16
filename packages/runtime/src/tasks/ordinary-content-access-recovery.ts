import { desc, eq, getTaskById, getJobById, getSharedDirectDb, taskRuns, transitionTaskApprovalExecution, repairTaskContentAccessRecovery,
  type DirectDatabase, type Task, type TaskRun } from "@nautilo/db";
import { OrdinaryContentAccessRetryRequiredError, readOrdinaryContentAccessRecovery,
  type OrdinaryContentAccessRecoveryCoordinate, type OrdinaryContentAccessRecoveryDeps } from "@nautilo/agent";
import { assertCanInvokeAgent, findActorByOwnerId, type AcceptedInvocationAuthority } from "@nautilo/trust";
import { laneLock } from "../lane-lock";
import type { LaneLock } from "../types";
import { jobManager, type JobManager } from "../job-manager";
import type { MaintenanceAcceptanceAuthority } from "../maintenance-controller";
import { eventBus } from "../event-bus";
import { runTaskApprovalResume } from "./resume-task-approval";

interface TaskContentAccessRecoveryCoordinate {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly checkpointId: string;
  readonly toolCallId: string;
}

interface LocatedTaskRecovery {
  task: Task;
  run: TaskRun;
  checkpoint: OrdinaryContentAccessRecoveryCoordinate;
  coordinate: TaskContentAccessRecoveryCoordinate;
}

interface TaskContentAccessRecoveryDeps {
  readonly graph: OrdinaryContentAccessRecoveryDeps;
  readonly db?: DirectDatabase;
  readonly lock?: LaneLock;
  readonly assertInvocation?: typeof assertCanInvokeAgent;
  readonly actorForOwner?: typeof findActorByOwnerId;
  readonly manager?: Pick<JobManager, "runResumeJobLifecycle" | "hasTaskContentAccessRecoveryWorker">;
  readonly originalJob?: typeof getJobById;
}

async function readPair(taskId: string, sessionUserId: string, deps: TaskContentAccessRecoveryDeps): Promise<{ task: Task; run: TaskRun } | null> {
  const db = deps.db ?? getSharedDirectDb();
  const task = await getTaskById(db, taskId);
  if (!task || task.ownerId !== sessionUserId || !["awaiting", "running"].includes(task.status)) return null;
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.taskId, task.id))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id)).limit(1);
  if (!run || !["awaiting", "running"].includes(run.status) || !run.jobId || !task.targetRoomId) return null;
  return { task, run };
}

async function locate(taskId: string, sessionUserId: string, deps: TaskContentAccessRecoveryDeps): Promise<LocatedTaskRecovery | null> {
  const pair = await readPair(taskId, sessionUserId, deps);
  if (!pair || pair.task.status !== pair.run.status) return null;
  const { task, run } = pair;
  if (task.status === "running") {
    const original = await (deps.originalJob ?? getJobById)(run.jobId!);
    if (!original || !["failed", "completed"].includes(original.status)
      || original.requestorId !== task.requestorId || original.input?.["taskId"] !== task.id
      || original.input["taskRunId"] !== run.id || original.input["graphThreadId"] !== run.graphThreadId
      || original.input["roomId"] !== task.targetRoomId || original.input["agentId"] !== task.agentId
      || original.input["ownerId"] !== task.ownerId
      || (deps.manager ?? jobManager).hasTaskContentAccessRecoveryWorker(run.graphThreadId, `task:${task.id}`)) return null;
  }
  // Preserve both existing Task subjects. The responder is not a substitute
  // for the Human whose invocation created the Task.
  for (const humanUserId of new Set([task.ownerId, task.requestorId])) {
    await (deps.assertInvocation ?? assertCanInvokeAgent)({ humanUserId, agentId: task.agentId,
      roomId: task.targetRoomId!, origin: "foreground_resume" });
  }
  const actor = await (deps.actorForOwner ?? findActorByOwnerId)(task.ownerId);
  if (!actor) return null;
  const checkpoint = await readOrdinaryContentAccessRecovery({
    originalJobId: run.jobId!, graphThreadId: run.graphThreadId, laneKey: `task:${task.id}`,
    roomId: task.targetRoomId!, humanUserId: task.ownerId, humanActorId: actor.id, agentId: task.agentId,
    executionOwner: { kind: "task", taskId: task.id, taskRunId: run.id },
  }, deps.graph);
  return checkpoint === null ? null : { task, run, checkpoint, coordinate: {
    taskId: task.id, taskRunId: run.id, checkpointId: checkpoint.checkpointId, toolCallId: checkpoint.toolCallId,
  } };
}

export async function discoverTaskContentAccessRecovery(taskId: string, sessionUserId: string,
  deps: TaskContentAccessRecoveryDeps): Promise<TaskContentAccessRecoveryCoordinate | null> {
  return (await locate(taskId, sessionUserId, deps))?.coordinate ?? null;
}

/** Only the typed uncertain outcome is parked; no failure report or new Run. */
export async function parkTaskContentAccessRecovery(db: DirectDatabase, input: {
  taskId: string; taskRunId: string; ownerId: string; graphThreadId: string; error: unknown;
}): Promise<{ handled: boolean; parked: boolean }> {
  if (!(input.error instanceof OrdinaryContentAccessRetryRequiredError)) return { handled: false, parked: false };
  const parked = await transitionTaskApprovalExecution(db, { taskId: input.taskId, runId: input.taskRunId,
    graphThreadId: input.graphThreadId, ownerId: input.ownerId, from: "running", to: "awaiting", requireLatestRun: true });
  if (parked) eventBus.emit({ type: "task.status", taskId: input.taskId, ownerId: input.ownerId, status: "awaiting" });
  // Even if Stop/Pause/supersession won, generic terminalization must not
  // overwrite that lifecycle decision or claim this uncertain grant failed.
  return { handled: true, parked };
}

export async function runTaskContentAccessRecovery(expected: TaskContentAccessRecoveryCoordinate,
  sessionUserId: string, authorities: { invocation: AcceptedInvocationAuthority; maintenance: MaintenanceAcceptanceAuthority },
  deps: TaskContentAccessRecoveryDeps): Promise<"completed" | "busy" | "unavailable" | "retry_required"> {
  const found = await readPair(expected.taskId, sessionUserId, deps);
  if (!found || found.run.id !== expected.taskRunId) return "unavailable";
  const lock = await (deps.lock ?? laneLock).tryAcquire(found.run.graphThreadId);
  if (!lock.acquired) return "busy";
  try {
    if ((deps.manager ?? jobManager).hasTaskContentAccessRecoveryWorker(found.run.graphThreadId, `task:${found.task.id}`)) return "busy";
    const current = await locate(expected.taskId, sessionUserId, deps);
    if (!current || current.run.graphThreadId !== found.run.graphThreadId
      || current.coordinate.taskRunId !== expected.taskRunId || current.coordinate.checkpointId !== expected.checkpointId
      || current.coordinate.toolCallId !== expected.toolCallId) return "unavailable";
    if ((deps.manager ?? jobManager).hasTaskContentAccessRecoveryWorker(current.run.graphThreadId, `task:${current.task.id}`)) return "busy";
    if (current.task.status === "running") {
      const repaired = await repairTaskContentAccessRecovery(deps.db ?? getSharedDirectDb(), {
        taskId: current.task.id, runId: current.run.id, graphThreadId: current.run.graphThreadId,
        ownerId: current.task.ownerId, requestorId: current.task.requestorId, agentId: current.task.agentId,
        roomId: current.task.targetRoomId!, originalJobId: current.run.jobId!,
      });
      if (!repaired) return "unavailable";
      eventBus.emit({ type: "task.status", taskId: current.task.id, ownerId: current.task.ownerId, status: "awaiting" });
    }
    const result = await runTaskApprovalResume({ task: current.task, run: current.run,
      invocationAuthority: authorities.invocation, maintenanceAuthority: authorities.maintenance,
      kind: "ordinary_recovery", ordinaryRecovery: { expected: current.checkpoint, deps: deps.graph },
    }, { db: deps.db ?? getSharedDirectDb(), ...(deps.manager ? { jobManager: deps.manager } : {}) });
    return result.recoveryOutcome ?? "unavailable";
  } finally { await lock.release(); }
}
